import axios from "axios";
import type {
  CellEvidence,
  CodeCandidate,
  CodeFixSeverity,
  LevelFinding,
  LevelReport,
  LevelSeverity,
  LogicValidationResult,
  ProjectLayerSummary,
  ProjectNarrative,
  ProjectStats,
  ReconCheckKind
} from "../types/index.js";

export class LlmConfigError extends Error {}

/**
 * The deployment didn't answer inside the caller's budget, or answered but was cut off mid-JSON.
 *
 * Distinguished from a generic failure because it is the one error a fan-out can *degrade* around:
 * a batch that timed out can be retried smaller, or its tables handed to the template writer, while
 * the rest of the run keeps whatever it already produced. See `aiReconciliation.ts`.
 */
export class LlmTimeoutError extends Error {}

/**
 * Default ceiling for one call. Prompts here carry several SQL statements and the deployment is
 * typically a reasoning model, so the 30s used for Databricks REST is far too tight. Callers that
 * fan out many small calls pass their own, shorter, budget rather than inheriting this one — a
 * single 120s call is exactly the failure mode this default exists to *avoid*.
 */
const LLM_TIMEOUT_MS = envInt("AZURE_OPENAI_TIMEOUT_MS", 120_000, 5_000, 600_000);

/**
 * `reasoning.effort` for reasoning deployments (`low` | `medium` | `high`).
 *
 * Left unset by default because sending `reasoning` to a non-reasoning deployment is rejected
 * outright. On a reasoning deployment, setting it to `low` is the single biggest latency win
 * available here: the reconciliation prompt is grounded extraction, not open-ended problem solving.
 */
const REASONING_EFFORT = process.env.AZURE_OPENAI_REASONING_EFFORT?.trim().toLowerCase();

/** Reads a positive integer from the environment, clamped, falling back on anything unparsable. */
export function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

export interface LlmCallOptions {
  /** Per-call timeout. A fan-out sets this well below `LLM_TIMEOUT_MS` so one slow call can't stall it. */
  timeoutMs?: number;
  /** Ceiling on generated tokens. Keeps one oversized answer from running past the timeout. */
  maxOutputTokens?: number;
  /** Names the call in the log line, so a fan-out's calls can be told apart. */
  label?: string;
}

async function callAzureOpenAi(messages: ChatMessage[], options: LlmCallOptions = {}): Promise<string> {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

  if (!endpoint || !apiKey || !deployment) {
    throw new LlmConfigError(
      "Azure OpenAI is not configured. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT in server/.env."
    );
  }

  // The configured endpoint already points at Azure's v1 "Responses API"
  // (https://<resource>.openai.azure.com/openai/v1/responses), so POST straight to it
  // rather than building a classic /openai/deployments/{name}/chat/completions URL.
  const url = endpoint.replace(/\/+$/, "");
  const body: Record<string, unknown> = { model: deployment, input: messages };
  if (options.maxOutputTokens) body.max_output_tokens = options.maxOutputTokens;
  if (REASONING_EFFORT) body.reasoning = { effort: REASONING_EFFORT };

  const timeout = options.timeoutMs ?? LLM_TIMEOUT_MS;
  const label = options.label ?? "call";

  console.log("[llmClient] sending request", { label, url, model: deployment, messageCount: messages.length, timeout });
  const startedAt = Date.now();

  try {
    const res = await axios.post(url, body, {
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      timeout,
    });

    console.log("[llmClient] received response", { label, status: res.status, elapsedMs: Date.now() - startedAt });

    const content =
      res.data?.output_text ??
      res.data?.output
        ?.flatMap((item: any) => item?.content ?? [])
        ?.find((c: any) => c?.type === "output_text" || c?.type === "text")?.text;

    // A response cut off at `max_output_tokens` comes back 200 with truncated (so unparsable) text.
    // That is a "ask for less" failure, not a broken deployment, so it takes the retryable path.
    if (res.data?.status === "incomplete") {
      const reason = res.data?.incomplete_details?.reason ?? "unknown";
      console.warn("[llmClient] response was truncated", { label, reason });
      if (reason === "max_output_tokens") {
        throw new LlmTimeoutError(`Azure OpenAI ran out of output budget for ${label} before finishing its answer.`);
      }
    }

    if (!content) {
      throw new Error("Azure OpenAI response did not include any message content.");
    }
    return content;
  } catch (err) {
    if (err instanceof LlmTimeoutError) throw err;
    if (axios.isAxiosError(err)) {
      const elapsedMs = Date.now() - startedAt;
      if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
        console.error("[llmClient] request timed out", { label, elapsedMs, timeout });
        throw new LlmTimeoutError(`Azure OpenAI did not answer ${label} within ${timeout}ms.`);
      }
      const detail = err.response?.data && typeof err.response.data === "object"
        ? JSON.stringify(err.response.data)
        : err.message;
      console.error("[llmClient] request failed", { label, elapsedMs, detail });
      throw new Error(`Azure OpenAI request failed: ${detail}`);
    }
    console.error("[llmClient] unexpected error", { label, elapsedMs: Date.now() - startedAt, err });
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export interface MismatchLlmInput {
  tableName: string;
  fromStage: string;
  toStage: string;
  fromCount: number;
  toCount: number;
  difference: number;
  candidates: CodeCandidate[];
}

export interface LlmAnalysisResult {
  responsibleIndex: number | null;
  explanation: string;
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export function buildAnalysisMessages(input: MismatchLlmInput): ChatMessage[] {
  const candidateBlock = input.candidates.length
    ? input.candidates
        .map(
          (c, i) =>
            `[${i}] ${c.notebookPath} (cell ${c.cellIndex}):\n\`\`\`\n${c.snippet}\n\`\`\``
        )
        .join("\n\n")
    : "(no notebook code referencing this table was found)";

  return [
    {
      role: "system",
      content:
        "You are a data engineering assistant reviewing Databricks notebook code to explain row-count " +
        "mismatches between two adjacent stages of a layered data pipeline. The stage names are given to " +
        "you below — use them as-is and do not assume a particular layering convention. " +
        "You are given candidate SQL snippets pulled from notebooks that reference the table. " +
        "Pick the single snippet most likely responsible for the mismatch (filters, joins that drop rows, " +
        "dedup/DISTINCT logic, incorrect date windows, aggregations that change grain, etc.), or none if the " +
        "snippets don't explain it. " +
        'Respond with ONLY compact JSON: {"responsibleIndex": <int index from the list, or null>, "explanation": "<2-4 sentence explanation citing the specific code>"}. ' +
        "No markdown, no extra text outside the JSON object."
    },
    {
      role: "user",
      content:
        `Table: ${input.tableName}\n` +
        `${input.fromStage} row count: ${input.fromCount}\n` +
        `${input.toStage} row count: ${input.toCount}\n` +
        `Difference (${input.toStage} - ${input.fromStage}): ${input.difference}\n\n` +
        `Candidate code:\n${candidateBlock}`
    }
  ];
}

export function parseAnalysisResponse(raw: string, candidateCount: number): LlmAnalysisResult {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned) as { responsibleIndex?: unknown; explanation?: unknown };
    const idx = typeof parsed.responsibleIndex === "number" ? Math.trunc(parsed.responsibleIndex) : null;
    const responsibleIndex = idx !== null && idx >= 0 && idx < candidateCount ? idx : null;
    const explanation = typeof parsed.explanation === "string" ? parsed.explanation : cleaned;
    return { responsibleIndex, explanation };
  } catch {
    return { responsibleIndex: null, explanation: cleaned };
  }
}

export async function analyzeMismatchWithLlm(input: MismatchLlmInput): Promise<LlmAnalysisResult> {
  const content = await callAzureOpenAi(buildAnalysisMessages(input));
  return parseAnalysisResponse(content, input.candidates.length);
}

export interface LineageCandidate {
  targetTable: string;
  sourceTables: string[];
  notebookPath: string;
  cellIndex: number;
  snippet: string;
}

export interface LineageExplanation {
  targetTable: string;
  explanation: string;
}

export function buildLineageMessages(sourceTable: string, candidates: LineageCandidate[]): ChatMessage[] {
  const candidateBlock = candidates
    .map(
      (c, i) =>
        `[${i}] target table: ${c.targetTable} | source table(s): ${c.sourceTables.join(", ")} | ` +
        `${c.notebookPath} (cell ${c.cellIndex}):\n\`\`\`\n${c.snippet}\n\`\`\``
    )
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        "You are a data engineering assistant explaining how a single source table is transformed into " +
        "several downstream tables in a Databricks pipeline — one upstream table fanning out into multiple " +
        "downstream ones. You are given one candidate query/snippet per downstream table. " +
        "For each candidate, in 1-3 sentences explain what the transformation does in plain English: " +
        "aggregations, filters, joins, dedup, grain changes, and renamed/derived columns. " +
        'Respond with ONLY compact JSON: {"explanations": [{"targetTable": "<exact target table from input>", "explanation": "<1-3 sentences>"}, ...]}, ' +
        "one entry per candidate, in the same order. No markdown, no extra text outside the JSON object."
    },
    {
      role: "user",
      content: `Source table: ${sourceTable}\n\nCandidates:\n${candidateBlock}`
    }
  ];
}

export function parseLineageResponse(raw: string, candidates: LineageCandidate[]): LineageExplanation[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned) as { explanations?: unknown };
    const entries = Array.isArray(parsed.explanations) ? parsed.explanations : [];
    const byTarget = new Map<string, string>();
    for (const entry of entries) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).targetTable === "string" &&
        typeof (entry as Record<string, unknown>).explanation === "string"
      ) {
        byTarget.set((entry as { targetTable: string }).targetTable, (entry as { explanation: string }).explanation);
      }
    }
    return candidates.map((c) => ({
      targetTable: c.targetTable,
      explanation: byTarget.get(c.targetTable) ?? "The model did not return an explanation for this target table."
    }));
  } catch {
    return candidates.map((c) => ({ targetTable: c.targetTable, explanation: cleaned }));
  }
}

export async function explainLineageWithLlm(
  sourceTable: string,
  candidates: LineageCandidate[]
): Promise<LineageExplanation[]> {
  if (candidates.length === 0) return [];
  const content = await callAzureOpenAi(buildLineageMessages(sourceTable, candidates));
  return parseLineageResponse(content, candidates);
}

export function buildValidationMessages(
  tableName: string,
  businessLogic: string,
  candidates: CodeCandidate[]
): ChatMessage[] {
  const codeBlock = candidates.length
    ? candidates
        .map((c, i) => `[${i}] ${c.notebookPath} (cell ${c.cellIndex}):\n\`\`\`\n${c.snippet}\n\`\`\``)
        .join("\n\n")
    : "(no notebook code writing to this table was found)";

  return [
    {
      role: "system",
      content:
        "You are a Data Engineering QA agent. You are given a natural-language business rule and the " +
        "notebook code that actually populates a table, and must decide whether the code correctly " +
        "implements the rule. Look specifically for missing or wrong filters, incorrect join conditions " +
        "(wrong keys, wrong join type causing row loss/duplication), aggregations at the wrong grain, " +
        "and any other logical mismatch between the stated rule and the SQL/code. If no code was found, " +
        "that itself is a mismatch. " +
        'Respond with ONLY compact JSON: {"isCorrect": <boolean>, "alerts": ["<short specific alert>", ...], ' +
        '"explanation": "<2-5 sentence explanation of your reasoning, citing the specific code>"}. ' +
        '"alerts" should be empty when isCorrect is true. No markdown, no extra text outside the JSON object.'
    },
    {
      role: "user",
      content:
        `Target table: ${tableName}\n\n` +
        `Business rule (as stated by the user):\n${businessLogic}\n\n` +
        `Notebook code that writes to this table:\n${codeBlock}`
    }
  ];
}

export function parseValidationResponse(raw: string): LogicValidationResult {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned) as { isCorrect?: unknown; alerts?: unknown; explanation?: unknown };
    const isCorrect = typeof parsed.isCorrect === "boolean" ? parsed.isCorrect : false;
    const alerts = Array.isArray(parsed.alerts) ? parsed.alerts.filter((a): a is string => typeof a === "string") : [];
    const explanation = typeof parsed.explanation === "string" ? parsed.explanation : cleaned;
    return { isCorrect, alerts, explanation };
  } catch {
    return { isCorrect: false, alerts: [], explanation: cleaned };
  }
}

export async function validateBusinessLogic(
  tableName: string,
  businessLogic: string,
  candidates: CodeCandidate[]
): Promise<LogicValidationResult> {
  const content = await callAzureOpenAi(buildValidationMessages(tableName, businessLogic, candidates));
  return parseValidationResponse(content);
}

// ---- Level-by-level reconciliation review ----

export interface LevelLlmInput {
  fromLayer: string;
  toLayer: string;
  sourceTables: string[];
  targetTables: string[];
  businessContext: string;
  candidates: CodeCandidate[];
}

export type LevelReportBody = Omit<LevelReport, "fromLayer" | "toLayer">;

const SEVERITIES: readonly LevelSeverity[] = ["info", "warning", "error"];
const STATUSES: readonly LevelReport["status"][] = ["ok", "warning", "error"];

export function buildLevelMessages(input: LevelLlmInput): ChatMessage[] {
  const codeBlock = input.candidates.length
    ? input.candidates
        .map((c, i) => `[${i}] ${c.notebookPath} (cell ${c.cellIndex}):\n\`\`\`\n${c.snippet}\n\`\`\``)
        .join("\n\n")
    : "(no transformation notebook code was provided)";

  const tableList = (tables: string[]) => (tables.length ? tables.join(", ") : "(none selected)");

  return [
    {
      role: "system",
      content:
        "You are a senior data engineering reconciliation reviewer. You are given one 'level' of a layered data " +
        "pipeline — a source layer feeding an adjacent target layer — the layer names as this project actually " +
        "uses them, the tables selected at each layer, the notebook code that moves data between them, and " +
        "business context supplied by the user. Assess two things: (1) code quality of the transformation, and " +
        "(2) whether the transformation risks a RECONCILIATION error between source and target — dropped or " +
        "duplicated rows, wrong join keys or join types, missing/incorrect filters or dedup, grain changes, null " +
        "handling, unsafe type casts, incremental-load gaps, or hardcoded logic that contradicts the business " +
        "context. Be specific and cite the code. Set status to 'ok' when nothing concerning is found, 'warning' " +
        "for minor or possible issues, and 'error' when there is a likely reconciliation-breaking problem. " +
        'Respond with ONLY compact JSON: {"status": "ok|warning|error", "summary": "<2-4 sentence overview>", ' +
        '"reconciliationAlerts": ["<short specific reconciliation risk>", ...], ' +
        '"findings": [{"severity": "info|warning|error", "table": "<related table or omit>", "message": "<specific finding>"}]}. ' +
        '"reconciliationAlerts" must be empty when status is "ok". No markdown, no text outside the JSON object.'
    },
    {
      role: "user",
      content:
        `Pipeline level: ${input.fromLayer} -> ${input.toLayer}\n\n` +
        `Source (${input.fromLayer}) tables: ${tableList(input.sourceTables)}\n` +
        `Target (${input.toLayer}) tables: ${tableList(input.targetTables)}\n\n` +
        `Business context (from the user):\n${input.businessContext}\n\n` +
        `Transformation notebook code:\n${codeBlock}`
    }
  ];
}

export function parseLevelResponse(raw: string): LevelReportBody {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned) as {
      status?: unknown;
      summary?: unknown;
      reconciliationAlerts?: unknown;
      findings?: unknown;
    };

    const status = STATUSES.includes(parsed.status as LevelReport["status"])
      ? (parsed.status as LevelReport["status"])
      : "warning";
    const summary = typeof parsed.summary === "string" ? parsed.summary : cleaned;
    const reconciliationAlerts = Array.isArray(parsed.reconciliationAlerts)
      ? parsed.reconciliationAlerts.filter((a): a is string => typeof a === "string")
      : [];
    const findings: LevelFinding[] = Array.isArray(parsed.findings)
      ? parsed.findings.flatMap((f) => {
          if (typeof f !== "object" || f === null) return [];
          const rec = f as Record<string, unknown>;
          if (typeof rec.message !== "string") return [];
          const severity = SEVERITIES.includes(rec.severity as LevelSeverity)
            ? (rec.severity as LevelSeverity)
            : "info";
          const finding: LevelFinding = { severity, message: rec.message };
          if (typeof rec.table === "string" && rec.table.trim()) finding.table = rec.table;
          return [finding];
        })
      : [];

    return { status, summary, reconciliationAlerts, findings };
  } catch {
    return { status: "warning", summary: cleaned, reconciliationAlerts: [], findings: [] };
  }
}

export async function analyzeLevelReconciliation(input: LevelLlmInput): Promise<LevelReportBody> {
  const content = await callAzureOpenAi(buildLevelMessages(input));
  return parseLevelResponse(content);
}

// ---- Problem 1: layer exclusion rule explanations ----

export interface ExclusionRuleLlmInput {
  label: string;
  predicateSql: string;
  sourceTable: string;
  excludedCount: number | null;
}

export interface ExclusionRuleExplanation {
  index: number;
  explanation: string;
  severity: "ok" | "warning";
}

export function buildExclusionMessages(rules: ExclusionRuleLlmInput[]): ChatMessage[] {
  const ruleBlock = rules
    .map(
      (r, i) =>
        `[${i}] ${r.label}\nSource table: ${r.sourceTable}\nPredicate: ${r.predicateSql}\n` +
        `Excluded rows: ${r.excludedCount === null ? "unknown (could not be computed)" : r.excludedCount}`
    )
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        "You are a data engineering assistant explaining exclusion rules found in Databricks " +
        "pipeline notebooks — WHERE predicates on the SQL statement that writes each table, which determine " +
        "which source rows get dropped as data moves from one layer of the pipeline to the next. " +
        "For each rule, in 1-3 sentences explain in plain business English what kind of rows " +
        "it excludes and why that's plausible (test/internal data, drafts, intercompany elimination, zero-value " +
        "records, etc.), and flag it as 'warning' rather than 'ok' if the predicate looks like it could be " +
        "unintentionally dropping legitimate rows (e.g. an overly broad filter, a sign/inequality that looks " +
        "backwards, or excluding rows that a reasonable business process would still want to count). " +
        'Respond with ONLY compact JSON: {"explanations": [{"index": <int index from the list>, ' +
        '"explanation": "<1-3 sentences>", "severity": "ok"|"warning"}, ...]}, one entry per rule. ' +
        "No markdown, no extra text outside the JSON object."
    },
    {
      role: "user",
      content: `Exclusion rules:\n\n${ruleBlock}`
    }
  ];
}

export function parseExclusionResponse(raw: string, ruleCount: number): ExclusionRuleExplanation[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  const fallback = (): ExclusionRuleExplanation[] =>
    Array.from({ length: ruleCount }, (_, index) => ({ index, explanation: cleaned, severity: "warning" as const }));

  try {
    const parsed = JSON.parse(cleaned) as { explanations?: unknown };
    const entries = Array.isArray(parsed.explanations) ? parsed.explanations : [];
    const byIndex = new Map<number, { explanation: string; severity: "ok" | "warning" }>();
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.index !== "number" || typeof rec.explanation !== "string") continue;
      const severity = rec.severity === "warning" ? "warning" : "ok";
      byIndex.set(Math.trunc(rec.index), { explanation: rec.explanation, severity });
    }
    if (byIndex.size === 0) return fallback();
    return Array.from({ length: ruleCount }, (_, index) => ({
      index,
      explanation: byIndex.get(index)?.explanation ?? "The model did not return an explanation for this rule.",
      severity: byIndex.get(index)?.severity ?? "warning"
    }));
  } catch {
    return fallback();
  }
}

export async function explainExclusionRules(rules: ExclusionRuleLlmInput[]): Promise<ExclusionRuleExplanation[]> {
  if (rules.length === 0) return [];
  const content = await callAzureOpenAi(buildExclusionMessages(rules));
  return parseExclusionResponse(content, rules.length);
}

// ---- Project summary narrative (onboarding overview) ----

export interface ProjectSummaryLlmInput {
  catalog: string;
  notebookRoot: string;
  layers: ProjectLayerSummary[];
  stats: ProjectStats;
  lineage: { from: string; to: string }[];
}

export function buildProjectSummaryMessages(input: ProjectSummaryLlmInput): ChatMessage[] {
  const layerBlock = input.layers
    .map((l) => {
      const tables = l.tables.length
        ? l.tables
            .map((t) => `    - ${t.name} [${t.kind}]${t.rowCount !== null ? ` — ${t.rowCount} rows` : ""}${t.comment ? ` — ${t.comment}` : ""}`)
            .join("\n")
        : "    (no tables)";
      return `  Layer "${l.layer.label}" (schema ${l.layer.schema}):\n${tables}`;
    })
    .join("\n");

  const lineageBlock = input.lineage.length
    ? input.lineage.map((e) => `  ${e.from} -> ${e.to}`).join("\n")
    : "  (no lineage edges discovered)";

  return [
    {
      role: "system",
      content:
        "You are a senior data engineer writing an onboarding brief for someone who has just joined a " +
        "Databricks data project and has never seen it before. You are given the catalog, the project's " +
        "ordered pipeline layers with their tables (each tagged fact/dimension/bridge/staging/other and, " +
        "where known, row counts), aggregate stats, and the table-to-table lineage edges extracted from the " +
        "transformation notebooks. Explain the project clearly and concretely, grounded ONLY in the data " +
        "provided — never invent table names, counts, or business domains you weren't given. Describe the " +
        "layering using the project's own layer names; do not relabel it as bronze/silver/gold unless those " +
        "are the names you were actually given. " +
        "Write for a smart engineer who is new to THIS project, not new to data engineering. " +
        'Respond with ONLY compact JSON: {"overview": "<2-4 sentences: what this data project is and what it produces>", ' +
        '"architecture": "<2-4 sentences: how it is set up — the layers, what role each plays, how many fact vs dimension tables>", ' +
        '"howItWorks": "<3-5 sentences: how data actually flows end to end through the layers, citing real lineage/tables>", ' +
        '"onboardingTips": ["<short, concrete pointer for the new engineer>", ...]}. ' +
        "No markdown, no text outside the JSON object."
    },
    {
      role: "user",
      content:
        `Catalog: ${input.catalog}\n` +
        `Notebook root scanned: ${input.notebookRoot}\n\n` +
        `Headline stats: ${input.stats.layerCount} layers, ${input.stats.tableCount} tables ` +
        `(${input.stats.factTableCount} fact, ${input.stats.dimensionTableCount} dimension, ${input.stats.otherTableCount} other), ` +
        `${input.stats.lineageEdgeCount} lineage edges across ${input.stats.notebookCount} notebooks` +
        `${input.stats.totalRows !== null ? `, ${input.stats.totalRows} total rows` : ""}.\n\n` +
        `Layers and tables:\n${layerBlock}\n\n` +
        `Table lineage (source -> target):\n${lineageBlock}`
    }
  ];
}

export function parseProjectSummaryResponse(raw: string): ProjectNarrative {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned) as {
      overview?: unknown;
      architecture?: unknown;
      howItWorks?: unknown;
      onboardingTips?: unknown;
    };
    return {
      overview: typeof parsed.overview === "string" ? parsed.overview : cleaned,
      architecture: typeof parsed.architecture === "string" ? parsed.architecture : "",
      howItWorks: typeof parsed.howItWorks === "string" ? parsed.howItWorks : "",
      onboardingTips: Array.isArray(parsed.onboardingTips)
        ? parsed.onboardingTips.filter((t): t is string => typeof t === "string")
        : []
    };
  } catch {
    return { overview: cleaned, architecture: "", howItWorks: "", onboardingTips: [] };
  }
}

export async function summarizeProject(input: ProjectSummaryLlmInput): Promise<ProjectNarrative> {
  const content = await callAzureOpenAi(buildProjectSummaryMessages(input));
  return parseProjectSummaryResponse(content);
}

// ---- Governance: per-level code-fix suggestions ----

export interface CodeFixCandidate {
  /** Stable index the model refers back to so we can map the fix onto the exact cell. */
  index: number;
  notebookPath: string;
  cellIndex: number;
  language: string;
  code: string;
  /** Row counts measured for this cell, when a warehouse was available. */
  evidence?: CellEvidence | null;
  /** What `cellIndex` counts — "cell" for notebooks, "statement" for standalone SQL files. */
  unit?: string;
}

/** The pipeline hop under review, or null when the whole project is reviewed as one scope. */
export interface CodeFixHop {
  from: string;
  to: string;
}

function formatCount(value: number | null): string {
  return value === null ? "unavailable" : value.toLocaleString("en-US");
}

/** Renders a cell's measured counts as prompt lines, or "" when nothing was measured. */
export function formatCellEvidence(evidence: CellEvidence | null | undefined): string {
  if (!evidence) return "";
  const lines: string[] = [];

  for (const rc of evidence.rowCounts) {
    const delta =
      rc.delta === null ? "" : ` (${rc.delta > 0 ? "+" : ""}${rc.delta.toLocaleString("en-US")} rows at the target)`;
    lines.push(`source ${rc.sourceTable} = ${formatCount(rc.sourceRows)} rows -> target ${rc.targetTable} = ${formatCount(rc.targetRows)}${delta}`);
  }

  for (const f of evidence.filters) {
    lines.push(`filter \`${f.predicateSql}\` excludes ${formatCount(f.excludedRows)} rows from ${f.sourceTable}`);
  }

  if (lines.length === 0) return "";
  return `measured: ${lines.join("\n              ")}`;
}

export interface CodeFixLlmResult {
  status: "ok" | "warning" | "error";
  summary: string;
  fixes: { index: number; title: string; severity: CodeFixSeverity; rationale: string; correctedCode: string }[];
}

const FIX_SEVERITIES: readonly CodeFixSeverity[] = ["info", "warning", "error"];

export function buildCodeFixMessages(hop: CodeFixHop | null, candidates: CodeFixCandidate[]): ChatMessage[] {
  const unit = candidates[0]?.unit ?? "cell";
  const codeBlock = candidates.length
    ? candidates
        .map((c) => {
          const evidence = formatCellEvidence(c.evidence);
          const header = `[${c.index}] ${c.notebookPath} (${c.unit ?? "cell"} ${c.cellIndex}, ${c.language}):`;
          return `${header}${evidence ? `\n    ${evidence}` : ""}\n\`\`\`\n${c.code}\n\`\`\``;
        })
        .join("\n\n")
    : `(no transformation code was found for ${hop ? "this hop" : "this project"})`;

  const hasEvidence = candidates.some((c) => formatCellEvidence(c.evidence));

  return [
    {
      role: "system",
      content:
        "You are a data engineering governance gatekeeper reviewing " +
        (hop
          ? `the Databricks transformation code that moves data from the ${hop.from} layer to the ${hop.to} layer ` +
            "of a layered data pipeline. Your job is to prevent RECONCILIATION errors between the two layers: "
          : "the SQL transformation code of a data pipeline project. Your job is to prevent RECONCILIATION errors " +
            "between what each statement reads and what it writes: ") +
        "silently dropped rows, duplicated rows from bad joins (wrong " +
        "keys or join type / fan-out), missing or wrong filters, dedup at the wrong grain, aggregation grain changes, " +
        "unsafe null handling, unsafe casts that null out values, and incremental-load gaps. " +
        `For EACH provided ${unit} that needs changes, rewrite it into a corrected, copy-paste-ready version that keeps ` +
        `the original intent but is reconciliation-safe, and preserve the ${unit}'s language and formatting. Only include ` +
        `${unit}s that genuinely need changes — omit ${unit}s that are already fine. Set status to 'ok' when no ${unit} needs ` +
        "changes, 'warning' for minor risks, and 'error' when a change is needed to avoid a likely reconciliation break. " +
        (hasEvidence
          ? `Some ${unit}s carry a 'measured:' line with real row counts taken from the warehouse. Treat those numbers as ` +
            "ground truth: cite them in the rationale when they explain a gap, and when the code looks risky but the " +
            "counts show no gap, say so explicitly instead of raising the severity. "
          : "") +
        'Respond with ONLY compact JSON: {"status": "ok|warning|error", "summary": "<2-4 sentence overview>", ' +
        '"fixes": [{"index": <int index from the list>, "title": "<short label of the fix>", "severity": "info|warning|error", ' +
        '"rationale": "<1-3 sentences: which reconciliation error this prevents, citing the code>", ' +
        `"correctedCode": "<the full corrected ${unit} body>"}]}. ` +
        "No markdown, no text outside the JSON object."
    },
    {
      role: "user",
      content:
        (hop ? `Hop: ${hop.from} -> ${hop.to}` : "Scope: every SQL statement found in the uploaded project folder") +
        `\n\nTransformation ${unit}s:\n${codeBlock}`
    }
  ];
}

export function parseCodeFixResponse(raw: string, candidateCount: number): CodeFixLlmResult {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned) as { status?: unknown; summary?: unknown; fixes?: unknown };
    const status = STATUSES.includes(parsed.status as LevelReport["status"])
      ? (parsed.status as CodeFixLlmResult["status"])
      : "warning";
    const summary = typeof parsed.summary === "string" ? parsed.summary : cleaned;
    const fixes = Array.isArray(parsed.fixes)
      ? parsed.fixes.flatMap((f): CodeFixLlmResult["fixes"] => {
          if (typeof f !== "object" || f === null) return [];
          const rec = f as Record<string, unknown>;
          const index = typeof rec.index === "number" ? Math.trunc(rec.index) : -1;
          if (index < 0 || index >= candidateCount) return [];
          if (typeof rec.correctedCode !== "string") return [];
          const severity = FIX_SEVERITIES.includes(rec.severity as CodeFixSeverity)
            ? (rec.severity as CodeFixSeverity)
            : "warning";
          return [
            {
              index,
              title: typeof rec.title === "string" && rec.title.trim() ? rec.title : "Suggested fix",
              severity,
              rationale: typeof rec.rationale === "string" ? rec.rationale : "",
              correctedCode: rec.correctedCode
            }
          ];
        })
      : [];

    return { status, summary, fixes };
  } catch {
    return { status: "warning", summary: cleaned, fixes: [] };
  }
}

export async function suggestLevelCodeFixes(
  hop: CodeFixHop | null,
  candidates: CodeFixCandidate[]
): Promise<CodeFixLlmResult> {
  const content = await callAzureOpenAi(buildCodeFixMessages(hop, candidates));
  return parseCodeFixResponse(content, candidates.length);
}

// ---- Reconciliation scripts for an uploaded SQL folder ----

/**
 * One target table's grounding, rendered for the prompt by `aiReconciliation.ts`.
 *
 * The model is *not* asked for the six schema-derived checks — `reconciliationScripts.templateChecks`
 * already writes those from the exact column lists, faster and with no chance of a hallucinated name.
 * It is asked only for what it alone can contribute: the checks this particular transformation calls
 * for, which need the SQL to be read. `existingChecks` is what it has already been saved from writing.
 */
export interface ReconTargetPrompt {
  targetTable: string;
  sourceTables: string[];
  /** `name type` per column, per table — the only names the model is allowed to use. */
  columns: { table: string; columns: string; note: string }[];
  /** Key columns the static analysis found, and how sure it is. */
  keyHint: string;
  /** Per-source join columns, when the two sides share any. */
  joinHints: { source: string; columns: string[] }[];
  measureHint: string;
  filterHint: string[];
  /** Titles of the checks Recon has already written for this table — not to be repeated. */
  existingChecks: string[];
  /** The transformation SQL itself, trimmed — what lets the model see the actual grain and joins. */
  transformationSql: { path: string; statementIndex: number; sql: string }[];
}

export interface ReconLlmCheck {
  kind: ReconCheckKind;
  title: string;
  description: string;
  sql: string;
}

export interface ReconLlmScript {
  targetTable: string;
  summary: string;
  checks: ReconLlmCheck[];
  notes: string[];
}

const RECON_KINDS: readonly ReconCheckKind[] = [
  "row_count",
  "measure_totals",
  "missing_keys",
  "orphan_keys",
  "duplicate_keys",
  "null_keys",
  "custom"
];

/** Upper bound on the pipeline-specific checks asked for per table, named in the prompt. */
export const MAX_CUSTOM_CHECKS_PER_TARGET = 4;

export function buildReconciliationMessages(hopLabel: string, targets: ReconTargetPrompt[]): ChatMessage[] {
  const block = targets
    .map((t) => {
      const lines = [
        `### ${t.targetTable}`,
        `sources (in the order the statement reads them): ${t.sourceTables.join(", ") || "(none)"}`,
        ...t.columns.map((c) => `columns of ${c.table}${c.note ? ` [${c.note}]` : ""}: ${c.columns}`),
        `key columns found: ${t.keyHint}`,
        ...t.joinHints.map((j) => `shares with ${j.source}: ${j.columns.join(", ")}`),
        `measure columns found: ${t.measureHint}`,
        ...t.filterHint.map((f) => `filter the transformation applies: ${f}`),
        `checks ALREADY WRITTEN for this table (do not repeat these): ${
          t.existingChecks.length > 0 ? t.existingChecks.join("; ") : "(none — the schema grounded none of them)"
        }`
      ];
      for (const stmt of t.transformationSql) {
        lines.push(`transformation SQL — ${stmt.path} (statement ${stmt.statementIndex}):`, "```sql", stmt.sql, "```");
      }
      return lines.join("\n");
    })
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        "You are a senior data engineer reviewing one hop of a data pipeline. For each target table you " +
        "are given its sources, the exact column list of every table involved, the key and measure " +
        "columns a static analysis found, the filters the transformation applies, and the transformation " +
        "SQL itself. " +
        "The standard reconciliation checks — row counts against each source, totals for the shared " +
        "money/quantity columns, source keys missing from the target, target keys with no source row, " +
        "duplicate keys, null keys — HAVE ALREADY BEEN WRITTEN and are listed under `checks ALREADY " +
        "WRITTEN` for each table. Do not write them again. " +
        "Your job is only the checks those standard ones miss, which you can know only by reading this " +
        "transformation's SQL. Look specifically for: an aggregation that changes grain (so a row count " +
        "is expected to differ and something else must tie out), dedup or DISTINCT that can silently " +
        "drop rows, a join that can fan out, a window function that needs its partition to be complete, " +
        "ISNULL/COALESCE that moves a total, a date window or incremental predicate that can leave a " +
        "gap, a hardcoded value, and a CAST that can null a value out or truncate it. " +
        `Write at most ${MAX_CUSTOM_CHECKS_PER_TARGET} such checks per table. Fewer is better than ` +
        "padding: only write a check when you can point at the line of transformation SQL that makes it " +
        "necessary. If the transformation is a plain column-for-column copy, return no checks for it and " +
        "say so in `notes` — that is a correct and useful answer. " +
        "HARD RULES, they matter more than completeness: " +
        "(1) Use ONLY the table and column names given to you above. Never invent, guess, pluralise or " +
        "abbreviate a column name. If a check would need a column that is not listed, do not write that " +
        "check — say so in `notes` instead. " +
        "(2) Portable SQL only: no TOP, no LIMIT, no temp tables, no vendor-specific functions, nothing " +
        "that runs on only one engine. It must run unchanged on SQL Server and on Databricks SQL. " +
        "(3) Every check is ONE self-contained statement ending in a semicolon. " +
        "(4) A check must return NO rows when the data is correct, except count/total comparisons, which " +
        "return one row per pair being compared. " +
        "(5) `description` states in one or two sentences what a non-empty result means for this " +
        "pipeline, and names the part of the transformation that motivated the check — not what the SQL " +
        "syntactically does. " +
        'Respond with ONLY compact JSON: {"scripts": [{"targetTable": "<exact name from the input>", ' +
        '"summary": "<1-2 sentences: what this transformation does to the data and what to watch>", ' +
        '"checks": [{"kind": "measure_totals|missing_keys|orphan_keys|duplicate_keys|null_keys|custom", ' +
        '"title": "<short label>", "description": "<what a non-empty result means>", "sql": "<the statement>"}], ' +
        '"notes": ["<a check you could not write, and why>"]}]}, one entry per target table. ' +
        "No markdown, no text outside the JSON object."
    },
    {
      role: "user",
      content: `Pipeline hop: ${hopLabel}\n\nTarget tables to reconcile:\n\n${block}`
    }
  ];
}

export function parseReconciliationResponse(raw: string): ReconLlmScript[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned) as { scripts?: unknown };
    const scripts = Array.isArray(parsed.scripts) ? parsed.scripts : [];

    return scripts.flatMap((entry): ReconLlmScript[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const rec = entry as Record<string, unknown>;
      if (typeof rec.targetTable !== "string" || !rec.targetTable.trim()) return [];

      const checks: ReconLlmCheck[] = Array.isArray(rec.checks)
        ? rec.checks.flatMap((c): ReconLlmCheck[] => {
            if (typeof c !== "object" || c === null) return [];
            const check = c as Record<string, unknown>;
            // A check with no SQL is not a check — there is nothing to run and nothing to fix.
            if (typeof check.sql !== "string" || !check.sql.trim()) return [];
            return [
              {
                kind: RECON_KINDS.includes(check.kind as ReconCheckKind) ? (check.kind as ReconCheckKind) : "custom",
                title: typeof check.title === "string" && check.title.trim() ? check.title.trim() : "Check",
                description: typeof check.description === "string" ? check.description : "",
                sql: check.sql.trim()
              }
            ];
          })
        : [];

      return [
        {
          targetTable: rec.targetTable.trim().toLowerCase(),
          summary: typeof rec.summary === "string" ? rec.summary : "",
          checks,
          notes: Array.isArray(rec.notes) ? rec.notes.filter((n): n is string => typeof n === "string") : []
        }
      ];
    });
  } catch {
    return [];
  }
}

export async function writeReconciliationScripts(
  hopLabel: string,
  targets: ReconTargetPrompt[],
  options: LlmCallOptions = {}
): Promise<ReconLlmScript[]> {
  if (targets.length === 0) return [];
  const content = await callAzureOpenAi(buildReconciliationMessages(hopLabel, targets), {
    label: `recon ${hopLabel} [${targets.map((t) => t.targetTable).join(", ")}]`,
    ...options
  });
  return parseReconciliationResponse(content);
}
