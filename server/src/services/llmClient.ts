import axios from "axios";
import type {
  CellEvidence,
  CodeCandidate,
  CodeFixSeverity,
  HopBusinessContext,
  LayerGroupingKind,
  LayerRef,
  LayerRole,
  LevelFinding,
  LevelReport,
  LevelSeverity,
  LineageEdge,
  LineageOverride,
  LineageReview,
  LocalTableRef,
  LogicValidationResult,
  ProjectDocumentationProse,
  ProjectLayerSummary,
  ProjectNarrative,
  ProjectStats,
  ReconCheckKind
} from "../types/index.js";

import { platformRule, type SqlPlatform } from "./sqlPlatform.js";

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
/**
 * A tuning value from the environment, clamped to its allowed range.
 *
 * Only an unset or unparsable variable takes the fallback. Zero is a real setting wherever `min` is
 * zero — no retry backoff, no upstream context — and treating it as "unset" would silently ignore
 * the one value a user setting it to 0 is explicitly asking for.
 */
export function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
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
  /**
   * What the transformation does with each table it reads — supplies the rows, is joined in for its
   * columns, or is read without its rows reaching the target. Stated because it decides which
   * comparisons can mean anything: a lookup's row count has no relationship to the target's.
   */
  sourceUsage: string[];
  /** `name type` per column, per table — the only names the model is allowed to use. */
  columns: { table: string; columns: string; note: string }[];
  /** Key columns the static analysis found, and how sure it is. */
  keyHint: string;
  /** Per-source join columns, when the two sides share any. */
  joinHints: { source: string; columns: string[] }[];
  measureHint: string;
  /** Label columns — compared by their values, never summed. Stated so the model doesn't sum them. */
  categoryHint: string;
  filterHint: string[];
  /** Titles of the checks Recon has already written for this table — not to be repeated. */
  existingChecks: string[];
  /**
   * The code itself, trimmed: the statements that build this table, followed by the ones that build
   * what it reads. Following the lineage is what lets a column be traced to where it was actually
   * derived, and what keeps the rest of the layer — which is not context, only noise — out.
   */
  transformationSql: { path: string; statementIndex: number; builds: string; upstream: boolean; sql: string }[];
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
  "category_values",
  "missing_keys",
  "orphan_keys",
  "duplicate_keys",
  "null_keys",
  "custom"
];

/** Upper bound on the pipeline-specific checks asked for per table, named in the prompt. */
export const MAX_CUSTOM_CHECKS_PER_TARGET = envInt("RECON_CHECKS_PER_TARGET", 6, 1, 20);

export function buildReconciliationMessages(
  hopLabel: string,
  targets: ReconTargetPrompt[],
  platform: SqlPlatform = "portable"
): ChatMessage[] {
  const block = targets
    .map((t) => {
      const lines = [
        `### ${t.targetTable}`,
        `sources (in the order the statement reads them): ${t.sourceTables.join(", ") || "(none)"}`,
        ...t.sourceUsage.map((line) => `how this transformation uses ${line}`),
        ...t.columns.map((c) => `columns of ${c.table}${c.note ? ` [${c.note}]` : ""}: ${c.columns}`),
        `key columns found: ${t.keyHint}`,
        ...t.joinHints.map((j) => `shares with ${j.source}: ${j.columns.join(", ")}`),
        `measure columns found (safe to total): ${t.measureHint}`,
        `label columns found (compare their values, never total them): ${t.categoryHint}`,
        ...t.filterHint.map((f) => `filter the transformation applies: ${f}`),
        `checks ALREADY WRITTEN for this table (do not repeat these): ${
          t.existingChecks.length > 0 ? t.existingChecks.join("; ") : "(none — the schema grounded none of them)"
        }`
      ];
      for (const stmt of t.transformationSql) {
        lines.push(
          stmt.upstream
            ? `upstream context — how ${stmt.builds} was built, in ${stmt.path} (statement ${stmt.statementIndex}). ` +
                "Read it to understand where this table's columns came from; do not write checks about it:"
            : `transformation code that builds ${stmt.builds} — ${stmt.path} (statement ${stmt.statementIndex}):`,
          "```sql",
          stmt.sql,
          "```"
        );
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
        "money/quantity columns, the value sets of the shared label columns, source keys missing from " +
        "the target, target keys with no source row, duplicate keys, null keys — HAVE ALREADY BEEN " +
        "WRITTEN and are listed under `checks ALREADY WRITTEN` for each table. Do not write them again. " +
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
        "HARD RULES, they matter more than completeness. The scripts are handed to an engineer to run " +
        "as they are, and one statement that will not compile stops the whole file, so a check you are " +
        "not certain runs is worse than no check: " +
        "(1) Use ONLY the table and column names given to you above. Never invent, guess, pluralise or " +
        "abbreviate a column name. If a check would need a column that is not listed, do not write that " +
        "check — say so in `notes` instead. A column list marked PARTIAL is still the complete set of " +
        "names you may use; a table whose columns are unknown may be counted but none of its columns " +
        "may be named. " +
        "(1a) Qualify EVERY column reference with the alias of the table it comes from as soon as a " +
        "query names more than one table — `i.invoice_date`, never `invoice_date`. Give every table in " +
        "a join an alias. An unqualified column that two of the joined tables both have is an ambiguous " +
        "column name and the check will not run. " +
        `(2) ${platformRule(platform)} ` +
        // Kept whatever the platform: it is the rule most often broken, it costs nothing on the
        // engines that do have booleans, and a check written this way runs everywhere.
        "(2a) A condition may never be an operand — SQL Server has no boolean type, so " +
        "`(a IS NULL) <> (b IS NULL)` and `(x = y) = (p = q)` do not parse there however well they read. " +
        "Wrap each side instead — `CASE WHEN a IS NULL THEN 1 ELSE 0 END <> CASE WHEN b IS NULL THEN 1 " +
        "ELSE 0 END` — or write the condition out with AND/OR. " +
        "(3) Every check is ONE self-contained statement ending in a semicolon. " +
        "(3a) An aggregate (SUM, COUNT, MIN, MAX, AVG) may not appear in a WHERE or a JOIN ON clause, " +
        "and a window function (anything with OVER) may appear only in a SELECT list or an ORDER BY. " +
        "To compare totals, aggregate in a subquery or a CTE and compare the results; to compare " +
        "against a maximum, put it in a scalar subquery. `WHERE SUM(a) <> SUM(b)` and " +
        "`WHERE d >= MAX(d) OVER ()` are both errors that stop the whole file. " +
        "(4) A check must return NO rows when the data is correct, and one row PER OFFENDING ROW OR " +
        "GROUP otherwise. Never `SELECT COUNT(*)` as the whole check: the tool counts the rows your " +
        "check returns, so a count comes back as though that many rows were wrong. Return the rows. " +
        "(4a) Never write a check that passes when something suspicious is true. If a column is " +
        "hardcoded to a literal, `WHERE col <> 'literal'` returns nothing and reads as healthy — the " +
        "tool already reports hardcoded columns by itself, so do not write that check. Every check you " +
        "write must be one that CAN fail on this pipeline; if you cannot construct a failing case for " +
        "it, it is not a check, and it belongs in `notes` instead. " +
        "(5) `title` states the condition the SQL actually tests, so a reader scanning a result table " +
        "knows what a non-zero row means without opening the query — not the mechanism that motivated " +
        "it. `description` then states in one or two sentences what a non-empty result means for this " +
        "pipeline, and names the part of the transformation that motivated the check — not what the SQL " +
        "syntactically does. " +
        "(6) Never SUM, AVG or otherwise total a label column — a status, type, code, flag, region or " +
        "period. Only the columns listed as measures are safe to total; compare a label by its distinct " +
        "values, its row count per value, or a rule its values must obey. " +
        'Respond with ONLY compact JSON: {"scripts": [{"targetTable": "<exact name from the input>", ' +
        '"summary": "<1-2 sentences: what this transformation does to the data and what to watch>", ' +
        '"checks": [{"kind": "measure_totals|category_values|missing_keys|orphan_keys|duplicate_keys|null_keys|custom", ' +
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
  platform: SqlPlatform = "portable",
  options: LlmCallOptions = {}
): Promise<ReconLlmScript[]> {
  if (targets.length === 0) return [];
  const content = await callAzureOpenAi(buildReconciliationMessages(hopLabel, targets, platform), {
    label: `recon ${hopLabel} [${targets.map((t) => t.targetTable).join(", ")}]`,
    ...options
  });
  return parseReconciliationResponse(content);
}

// ---- Lineage review: narrate the extracted graph, and turn corrections into structured edits ----

/**
 * How many edges the prompt carries. Past this the narrative stops improving and the call starts
 * risking the output budget, so the rest are summarised as a count instead.
 */
const MAX_REVIEW_EDGES = 400;

export interface LineageReviewInput {
  projectName: string;
  layers: LayerRef[];
  edges: LineageEdge[];
  tables: LocalTableRef[];
  /**
   * What the user typed after rejecting the lineage. Absent on the first pass — and that difference
   * is load-bearing: without an instruction the model may only describe what was extracted, never
   * propose changes to it. See `reviewLineage`.
   */
  userInstruction?: string;
  /** Corrections already applied in earlier rounds, so the model doesn't re-propose them. */
  priorOverrides?: LineageOverride[];
}

function reviewSystemPrompt(correcting: boolean): string {
  const base =
    "You are a senior data engineer reviewing the table-to-table lineage that a static SQL parser " +
    "extracted from a data project. You are given the project's pipeline layers, its tables, and the " +
    "extracted edges (source table -> target table), each with the file and statement it came from. " +
    "Ground everything ONLY in what you are given — never mention a table that is not in the list. ";

  const output = correcting
    ? 'Respond with ONLY compact JSON: {"narrative": "<2-4 sentences describing the pipeline as it now stands>", ' +
      '"concerns": ["<something in the lineage worth a second look>", ...], ' +
      '"notes": {"<from>-><to>": "<short note about that edge>", ...}, ' +
      '"proposed": [{"kind": "add"|"remove", "from": "<source table>", "to": "<target table>", "reason": "<why>"}, ...]}. ' +
      "The user has told you what is wrong with the lineage. Translate their correction into the " +
      "smallest set of `proposed` edits that satisfies it. Every `from` and `to` MUST be a table from " +
      "the supplied list, written exactly as it appears there. Propose nothing the user did not ask for."
    : 'Respond with ONLY compact JSON: {"narrative": "<2-4 sentences: what this pipeline does, in terms of its real layers and tables>", ' +
      '"concerns": ["<something in the lineage worth a second look>", ...], ' +
      '"notes": {"<from>-><to>": "<short note about that edge>", ...}, "proposed": []}. ' +
      "Describe and question the lineage; do NOT propose edits to it — `proposed` must be an empty " +
      "array. If an edge looks wrong, say so in `concerns` and let the user decide. " +
      "Good concerns: a table nothing writes, a layer that is skipped entirely, one target with a " +
      "suspicious number of sources, a fan-out that looks like a join gone wrong.";

  return `${base}${output} No markdown, no text outside the JSON object.`;
}

export function buildLineageReviewMessages(input: LineageReviewInput): ChatMessage[] {
  const correcting = typeof input.userInstruction === "string" && input.userInstruction.trim().length > 0;

  const layerBlock = input.layers.length
    ? input.layers.map((l, i) => `  ${i + 1}. ${l.label} (schema ${l.schema})`).join("\n")
    : "  (none detected — every table is being treated as one scope)";

  const tableBlock = input.tables.length
    ? input.tables
        .map((t) => `  ${t.qualified}${t.written && t.read ? " [written, read]" : t.written ? " [written]" : " [read]"}`)
        .join("\n")
    : "  (none)";

  const shown = input.edges.slice(0, MAX_REVIEW_EDGES);
  const edgeBlock = shown.length
    ? shown.map((e) => `  ${e.from} -> ${e.to}   (${e.notebookPath} #${e.cellIndex})`).join("\n") +
      (input.edges.length > shown.length ? `\n  ... and ${input.edges.length - shown.length} more edges` : "")
    : "  (no lineage edges were extracted)";

  const priorBlock = input.priorOverrides?.length
    ? `\n\nCorrections already applied in earlier rounds (do not repeat these):\n` +
      input.priorOverrides.map((o) => `  ${o.kind} ${o.from} -> ${o.to} (${o.reason})`).join("\n")
    : "";

  const instructionBlock = correcting
    ? `\n\nThe user reviewed this lineage and says it is wrong:\n"""\n${input.userInstruction!.trim()}\n"""\n` +
      "Turn that into `proposed` edits."
    : "";

  return [
    { role: "system", content: reviewSystemPrompt(correcting) },
    {
      role: "user",
      content:
        `Project: ${input.projectName}\n\n` +
        `Pipeline layers, most-raw first:\n${layerBlock}\n\n` +
        `Tables (${input.tables.length}):\n${tableBlock}\n\n` +
        `Extracted lineage (${input.edges.length} edges):\n${edgeBlock}` +
        priorBlock +
        instructionBlock
    }
  ];
}

export function parseLineageReviewResponse(raw: string): LineageReview {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  const empty: LineageReview = { narrative: "", notes: {}, concerns: [], proposed: [] };

  try {
    const parsed = JSON.parse(cleaned) as {
      narrative?: unknown;
      concerns?: unknown;
      notes?: unknown;
      proposed?: unknown;
    };

    const notes: LineageReview["notes"] = {};
    if (parsed.notes && typeof parsed.notes === "object" && !Array.isArray(parsed.notes)) {
      for (const [key, value] of Object.entries(parsed.notes as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) notes[key.trim().toLowerCase()] = value;
      }
    }

    const proposed: LineageOverride[] = Array.isArray(parsed.proposed)
      ? parsed.proposed.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const rec = item as Record<string, unknown>;
          const kind = rec.kind === "add" || rec.kind === "remove" ? rec.kind : null;
          const from = typeof rec.from === "string" ? rec.from.trim() : "";
          const to = typeof rec.to === "string" ? rec.to.trim() : "";
          if (!kind || !from || !to) return [];
          return [
            {
              kind,
              from,
              to,
              reason: typeof rec.reason === "string" && rec.reason.trim() ? rec.reason.trim() : "requested by the user"
            }
          ];
        })
      : [];

    return {
      narrative: typeof parsed.narrative === "string" ? parsed.narrative : "",
      concerns: Array.isArray(parsed.concerns)
        ? parsed.concerns.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
        : [],
      notes,
      proposed
    };
  } catch {
    // An unparsable answer costs the narrative, not the run — the graph itself came from the parser.
    return { ...empty, narrative: cleaned.slice(0, 600) };
  }
}

/**
 * Reviews the extracted lineage, and — only when the user has said what is wrong with it — turns
 * that instruction into structured edits.
 *
 * The asymmetry is deliberate. The lineage itself is extracted deterministically by
 * `tableLineage.ts`; the model's job is to explain it and to interpret corrections, never to invent
 * edges of its own accord. So `proposed` is discarded outright unless the caller passed a
 * `userInstruction` — the same instinct behind `aiReconciliation.ts` refusing to let a model name a
 * column it wasn't given. Callers must still run the result through
 * `lineageOverrides.validateOverrides` before applying it, which drops any edit naming a table the
 * project never mentions.
 */
export async function reviewLineage(input: LineageReviewInput, options: LlmCallOptions = {}): Promise<LineageReview> {
  const correcting = typeof input.userInstruction === "string" && input.userInstruction.trim().length > 0;
  const content = await callAzureOpenAi(buildLineageReviewMessages(input), {
    label: `lineage review ${input.projectName}${correcting ? " (correction)" : ""}`,
    ...options
  });
  const review = parseLineageReviewResponse(content);
  return correcting ? review : { ...review, proposed: [] };
}

// ---- Documentation: the prose half of `reconcile document` ----
//
// Two calls, split the way the document is: one for the whole project (introduction, layering,
// lineage) and one per hop (what that transformation means in business terms). The split is what keeps
// each prompt grounded in something it can actually see — the project call gets the shape of the
// pipeline, the hop calls get the SQL — and it means a hop whose call fails costs that hop's context
// rather than the whole document.

/** Same grounding discipline as every other prompt here, in the words this pair of calls needs. */
const DOC_GROUNDING =
  "Ground every sentence in the data you are given and nothing else. Never name a table, column, " +
  "file or metric that does not appear in the input, and never state a row count, a schedule, an " +
  "owner or a tool that was not given to you. Where the code does not reveal a business purpose, say " +
  "what the transformation does mechanically rather than inventing a purpose for it. Use the " +
  "project's own layer names; do not relabel them as bronze/silver/gold unless those are the names " +
  "you were given. Write plainly, for an engineer or analyst who has never seen this project. Plain " +
  "prose only — no markdown, no bullet characters, no headings inside the strings.";

/** Trims and drops the blanks from a JSON string array, keeping at most `max` entries. */
function textList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, max);
}

export interface DocumentationLlmInput {
  projectName: string;
  /** Ordered most-raw first, each with the tables that live in it. */
  layers: {
    label: string;
    schema: string;
    role?: string;
    tables: { name: string; kind: string; written: boolean }[];
  }[];
  stats: {
    fileCount: number;
    statementCount: number;
    tableCount: number;
    schemaCount: number;
    edgeCount: number;
    layerCount: number;
  };
  edges: { from: string; to: string }[];
  /** Schemas the SQL uses that aren't part of the pipeline — a documented gap, not an omission. */
  unassignedSchemas?: string[];
  /** The narrative and concerns the user already approved in `reconcile run`, when there are any. */
  priorNarrative?: string;
  priorConcerns?: string[];
}

export function buildDocumentationMessages(input: DocumentationLlmInput): ChatMessage[] {
  const layerBlock = input.layers.length
    ? input.layers
        .map((layer, i) => {
          const tables = layer.tables.length
            ? layer.tables
                .map((t) => `      - ${t.name} [${t.kind}${t.written ? ", built here" : ", read only"}]`)
                .join("\n")
            : "      (no tables)";
          return `  ${i + 1}. "${layer.label}" (schema ${layer.schema}${layer.role ? `, looks like a ${layer.role} layer` : ""}), ${layer.tables.length} table(s):\n${tables}`;
        })
        .join("\n")
    : "  (no layers were detected — the project's SQL never qualifies its tables with a schema)";

  const edgeBlock = input.edges.length
    ? input.edges.map((e) => `  ${e.from} -> ${e.to}`).join("\n")
    : "  (no lineage edges were extracted)";

  const priorBlock = input.priorNarrative?.trim()
    ? `\n\nThe engineer reviewed and approved this lineage, and it was described then as:\n"""\n${input.priorNarrative.trim()}\n"""`
    : "";
  const concernBlock = input.priorConcerns?.length
    ? `\n\nOpen concerns already raised about the lineage:\n${input.priorConcerns.map((c) => `  - ${c}`).join("\n")}`
    : "";
  const unassignedBlock = input.unassignedSchemas?.length
    ? `\n\nSchemas the SQL uses that are not part of the pipeline: ${input.unassignedSchemas.join(", ")}`
    : "";

  return [
    {
      role: "system",
      content:
        "You are a senior data engineer writing the reference documentation for a data pipeline, from " +
        "an automated scan of the project's SQL. You are given the pipeline's layers with their tables, " +
        "the table-to-table lineage extracted from the transformation code, and headline counts. " +
        `${DOC_GROUNDING} ` +
        'Respond with ONLY compact JSON: {"introduction": ["<paragraph>", ...], ' +
        '"architecture": ["<paragraph>", ...], ' +
        '"layers": [{"layer": "<the layer label, exactly as given>", "purpose": "<2-3 sentences on what this layer is for and what state the data is in by the time it sits here>", "contents": "<1-2 sentences on what actually sits in it, citing real tables>", ' +
        '"tables": [{"name": "<table name, exactly as given>", "use": "<one sentence: what this table holds and what it is used for>"}, ...]}, ...], ' +
        '"lineage": ["<paragraph>", ...], "risks": ["<something a reader should be sceptical about>", ...]}. ' +
        "Two or three paragraphs each for introduction, architecture and lineage; one entry in `layers` " +
        "for every layer you were given, in the same order, and inside it one `tables` entry for every " +
        "table of that layer, in the order given. Write the table `use` at the level a business reader " +
        "needs — what it is for, not a restatement of its column list — in one sentence. Where a table's " +
        "purpose is not evident from its name and its lineage, say what it holds rather than inventing a " +
        "use for it. At most four `risks`, one sentence each. No text outside the JSON object."
    },
    {
      role: "user",
      content:
        `Project: ${input.projectName}\n\n` +
        `Scanned: ${input.stats.fileCount} file(s), ${input.stats.statementCount} SQL statement(s), ` +
        `${input.stats.tableCount} table(s) across ${input.stats.schemaCount} schema(s), ` +
        `${input.stats.edgeCount} lineage edge(s), ${input.stats.layerCount} pipeline layer(s).\n\n` +
        `Pipeline layers, most-raw first:\n${layerBlock}\n\n` +
        `Table lineage (source -> target):\n${edgeBlock}` +
        unassignedBlock +
        priorBlock +
        concernBlock
    }
  ];
}

/** One line per table on what it is for. Entries with no name or no text are dropped, not defaulted. */
function parseTableUses(value: unknown): { name: string; use: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const rec = item as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name.trim() : "";
      const use = typeof rec.use === "string" ? rec.use.trim() : "";
      return name && use ? [{ name, use }] : [];
    })
    .slice(0, 80);
}

export function parseDocumentationResponse(raw: string): ProjectDocumentationProse {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      introduction: textList(parsed.introduction, 6),
      architecture: textList(parsed.architecture, 6),
      layers: Array.isArray(parsed.layers)
        ? parsed.layers.flatMap((item) => {
            if (!item || typeof item !== "object") return [];
            const rec = item as Record<string, unknown>;
            const layer = typeof rec.layer === "string" ? rec.layer.trim() : "";
            if (!layer) return [];
            return [
              {
                layer,
                purpose: typeof rec.purpose === "string" ? rec.purpose.trim() : "",
                contents: typeof rec.contents === "string" ? rec.contents.trim() : "",
                tables: parseTableUses(rec.tables)
              }
            ];
          })
        : [],
      lineage: textList(parsed.lineage, 6),
      risks: textList(parsed.risks, 12)
    };
  } catch {
    // An unparsable answer costs the prose, not the document — every other section is derived.
    return { introduction: [], architecture: [], layers: [], lineage: [], risks: [] };
  }
}

export async function writeProjectDocumentation(
  input: DocumentationLlmInput,
  options: LlmCallOptions = {}
): Promise<ProjectDocumentationProse> {
  const content = await callAzureOpenAi(buildDocumentationMessages(input), {
    label: `documentation ${input.projectName}`,
    ...options
  });
  return parseDocumentationResponse(content);
}

export interface HopContextLlmInput {
  hopLabel: string;
  /** Null when the project had no inferable layers and its whole lineage is one scope. */
  fromLayer: string | null;
  toLayer: string | null;
  targets: {
    target: string;
    sources: string[];
    keyColumns: string[];
    /** `declared`, `inferred` or `none` — whether the join key came from DDL or from column naming. */
    keyConfidence: string;
    measureColumns: string[];
    /** WHERE predicates the building statements apply. */
    knownFilters: string[];
    /** The transformation SQL itself, already capped by the caller. */
    snippet: string;
  }[];
}

export function buildHopContextMessages(input: HopContextLlmInput): ChatMessage[] {
  const targetBlock = input.targets
    .map((t) => {
      const lines = [
        `Table built: ${t.target}`,
        `  built from: ${t.sources.join(", ") || "(nothing in this hop)"}`,
        `  key columns: ${t.keyColumns.join(", ") || "(none identified)"} (${t.keyConfidence})`,
        `  measures on both sides: ${t.measureColumns.join(", ") || "(none)"}`,
        `  filters found in the transformation: ${t.knownFilters.length ? t.knownFilters.map((f) => `\`${f}\``).join("; ") : "(none)"}`,
        `  transformation SQL:\n\`\`\`\n${t.snippet}\n\`\`\``
      ];
      return lines.join("\n");
    })
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        "You are a senior data engineer documenting one stage of a data pipeline for a reader who has " +
        "to trust its numbers. For each table the stage builds you are given its source tables, the key " +
        "columns a reconciliation would join on, the measures both sides share, the filters found in " +
        "the transformation, and the transformation SQL itself. Explain what this stage does and what " +
        "it means for the data: which records it keeps and drops, what grain the output is at, which " +
        "rules are being applied. " +
        `${DOC_GROUNDING} ` +
        'Respond with ONLY compact JSON: {"context": ["<paragraph>", ...], ' +
        '"rules": [{"rule": "<a rule this stage applies, in business terms>", "evidence": "<the predicate, join or column from the SQL above that shows it>"}, ...], ' +
        '"expectedDifferences": ["<why the source and target row counts can legitimately differ here>", ...], ' +
        '"watchOuts": ["<how this stage could go wrong without anyone noticing>", ...]}. ' +
        "Two or three paragraphs in `context`, of three or four sentences each, pitched at a reader who " +
        "needs to know what this stage means for the data rather than how every column is computed. " +
        "The three lists go into a report that is read, not into a specification: give at most four " +
        "`rules`, at most three `expectedDifferences` and at most three `watchOuts`, each one sentence, " +
        "and only the ones that would change what a reader does. Pick the rules that decide which rows " +
        "or which values survive; leave out anything that merely restates a column list or renames a " +
        "column. Every `evidence` must quote the SQL you were given, and must be the fragment itself — a " +
        "predicate, a join condition, a GROUP BY, a CASE — never a whole statement. " +
        "No text outside the JSON object."
    },
    {
      role: "user",
      content:
        `Pipeline stage: ${input.hopLabel}\n` +
        (input.fromLayer && input.toLayer
          ? `Data moves from the ${input.fromLayer} layer to the ${input.toLayer} layer.\n`
          : "This project has no distinct layers, so this is its whole lineage as one stage.\n") +
        `\n${input.targets.length} table(s) are built here.\n\n${targetBlock}`
    }
  ];
}

export function parseHopContextResponse(raw: string): HopBusinessContext {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      context: textList(parsed.context, 6),
      rules: Array.isArray(parsed.rules)
        ? parsed.rules.flatMap((item) => {
            if (!item || typeof item !== "object") return [];
            const rec = item as Record<string, unknown>;
            const rule = typeof rec.rule === "string" ? rec.rule.trim() : "";
            if (!rule) return [];
            return [{ rule, evidence: typeof rec.evidence === "string" ? rec.evidence.trim() : "" }];
          })
        : [],
      expectedDifferences: textList(parsed.expectedDifferences, 10),
      watchOuts: textList(parsed.watchOuts, 10)
    };
  } catch {
    return { context: [], rules: [], expectedDifferences: [], watchOuts: [] };
  }
}

export async function describeHopContext(
  input: HopContextLlmInput,
  options: LlmCallOptions = {}
): Promise<HopBusinessContext> {
  const content = await callAzureOpenAi(buildHopContextMessages(input), {
    label: `documentation hop ${input.hopLabel}`,
    ...options
  });
  return parseHopContextResponse(content);
}

// ---- Why a reconciliation check would not tie out (the `comments` column) ----

/**
 * One generated check, described to the model in the terms the reader will see it in.
 *
 * Deliberately the *whole* row of the emitted table rather than a summary of it: the model is being
 * asked to explain a specific line of output to the person reading that line, so it should be looking
 * at the same facts they are — which two tables, which column at each end, how the code relates them.
 */
export interface ReconCommentInput {
  sourceTable: string;
  targetTable: string;
  /**
   * The column being reconciled, at each end of its lineage, or null for a check on whole rows. Two
   * fields rather than one because the report prints two, and because a rename is often itself the
   * answer — the model can only quote the expression behind it if it is told both names.
   */
  sourceColumn: string | null;
  targetColumn: string | null;
  /** How the transformation reaches the source: `FROM`, `LEFT JOIN`, `INNER JOIN`, … */
  joinType: string;
  /** Exactly what the generated SQL compares, e.g. `SUM(revenue)` or `COUNT(DISTINCT status)`. */
  comparison: string;
}

/**
 * The prompt behind the `comments` column: what, in this project's own SQL, would stop these two
 * numbers agreeing.
 *
 * The framing matters more than the wording. Recon reads code and never reads data, so the honest
 * question is not "why did this fail" — nothing has run yet — but "what in what you wrote could make
 * this differ". Asking for that, and requiring the answer to quote the fragment responsible, is what
 * keeps the column from filling up with generic reconciliation advice that would read the same for
 * any pipeline. It is also why the answer may be wrong: it is a reading of the code, offered as a
 * first place to look, and the prompt says so rather than letting confident prose imply otherwise.
 */
/**
 * The column a row is about, in one line: the target's own name, and the source name it was built from
 * where the transformation renamed it. Said this way rather than as two labels because a rename is a
 * fact about one column, and it is the fact most likely to be the reason the two sides differ.
 */
function commentColumnLine(input: ReconCommentInput): string {
  const target = input.targetColumn ?? input.sourceColumn;
  const source = input.sourceColumn ?? input.targetColumn;
  if (target === null || source === null) return "(whole rows — no single column)";
  return source === target ? target : `${target}, renamed from ${source}`;
}

export function buildReconCommentMessages(
  scope: string,
  inputs: ReconCommentInput[],
  transformationSql: { path: string; builds: string; sql: string }[]
): ChatMessage[] {
  const checks = inputs
    .map(
      (input, i) =>
        `[${i}] compare ${input.comparison}\n` +
        `     target: ${input.targetTable}\n` +
        `     source: ${input.sourceTable}  (reached by ${input.joinType})\n` +
        `     column: ${commentColumnLine(input)}`
    )
    .join("\n\n");

  const code = transformationSql
    .map((entry) => `--- ${entry.path} — builds ${entry.builds} ---\n${entry.sql}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        "You are a senior data engineer reviewing a SQL pipeline for a colleague who is about to run a " +
        "reconciliation over it. Each numbered item is one row of a reconciliation report: two tables, the " +
        "column being reconciled, how the code relates them, and exactly what the SQL compares. You are " +
        "also given the transformation SQL that builds these tables.\n\n" +
        "For each item, write the comment that row should carry if it does NOT tie out. Rules:\n" +
        "1. Open with the cause, in the form \"Because <what the code does> ...\". Name and quote the " +
        "actual fragment responsible — the WHERE predicate, the join and its type, the GROUP BY, the CASE, " +
        "the CAST/TRY_CONVERT, the ISNULL/COALESCE default, the window function. Quote it exactly as written.\n" +
        "2. Then one clause on what that does to this particular comparison.\n" +
        "3. Then what the engineer should check or change first.\n" +
        "4. Two or three sentences, under 120 words. Plain prose. No markdown, no bullets, no preamble. " +
        "Do not use semicolons — the answer is embedded in a SQL string literal and a semicolon breaks it.\n" +
        "5. You are reading code only and cannot see any data, so write what WOULD explain a difference. " +
        "Never state that a difference exists, and never quote a row count or a total.\n" +
        "6. If nothing in the code would make these two sides differ, write one sentence that starts " +
        "\"Nothing between these two tables changes\" and names the columns or statements you checked. Do " +
        "not restate this instruction.\n" +
        "7. Never name a table, column or predicate that is not in the SQL you were given. If the SQL " +
        "shown does not build one of the tables, say the code for it is not in this project.\n\n" +
        'Respond with ONLY compact JSON: {"comments": [{"index": <int from the list>, "comment": "<2-3 ' +
        'sentences>"}, ...]}, exactly one entry per item. No text outside the JSON object.'
    },
    {
      role: "user",
      content:
        `Pipeline layer: ${scope}\n\nReconciliation rows to comment on:\n\n${checks}\n\n` +
        `Transformation SQL:\n\n${code || "(no SQL in this project builds these tables)"}`
    }
  ];
}

export function parseReconCommentResponse(raw: string, count: number): string[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  const byIndex = new Map<number, string>();
  try {
    const parsed = JSON.parse(cleaned) as { comments?: unknown };
    for (const entry of Array.isArray(parsed.comments) ? parsed.comments : []) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.index !== "number" || typeof rec.comment !== "string") continue;
      const comment = rec.comment.trim();
      if (comment.length > 0) byIndex.set(Math.trunc(rec.index), comment);
    }
  } catch {
    // A malformed answer leaves every comment empty rather than putting the raw text — possibly a
    // refusal, possibly half a JSON document — into a column people are meant to trust.
    return Array.from({ length: count }, () => "");
  }

  return Array.from({ length: count }, (_, index) => byIndex.get(index) ?? "");
}

/**
 * One comment per input, in the same order. An entry the model skipped comes back as an empty string
 * rather than as a stand-in: a row with no explanation is honest, and an invented one is not.
 */
export async function explainReconciliationChecks(
  scope: string,
  inputs: ReconCommentInput[],
  transformationSql: { path: string; builds: string; sql: string }[],
  options: LlmCallOptions = {}
): Promise<string[]> {
  if (inputs.length === 0) return [];
  const content = await callAzureOpenAi(buildReconCommentMessages(scope, inputs, transformationSql), {
    label: `reconciliation comments ${scope}`,
    ...options
  });
  return parseReconCommentResponse(content, inputs.length);
}

// ---- Business reconciliation comments (the report layer's own checks) ----

/** One business check the model is asked to explain — see `businessReconciliation.ts`. */
export interface BusinessCommentInput {
  reportTable: string;
  /** `roll-forward`, `stated identity`, `period continuity (12 periods)`, `measure trace`. */
  checkName: string;
  /** The measure or subtotal the check is about — `arr`, `nrr`. */
  businessTerm: string;
  sourceTable: string;
  targetTable: string;
  /** What the check asserts, in words. */
  claim: string;
  /** Exactly what the generated SQL compares. */
  comparison: string;
}

/**
 * The prompt behind a business check's `comments` column.
 *
 * Same framing as `buildReconCommentMessages` and a different question. There the two numbers come from
 * two tables and the answer is usually a filter or a join; here they usually come from the *same* table
 * and the answer is arithmetic — a movement bucket that double-counts, a `CASE` whose branches do not
 * partition, a `LAG` over the wrong partition, a rolling window frame that includes a row it should
 * not, a scaffold row that fills a gap with zero rather than carrying the balance forward. Being
 * explicit about that is the difference between a comment that names the `CASE` and one that says
 * "check the transformation logic".
 *
 * The instruction not to claim a difference exists matters more here than anywhere else: a
 * roll-forward that does not balance is a famous problem, and a model asked about one will happily
 * describe the failure it imagines rather than the code it was given.
 */
export function buildBusinessCommentMessages(
  reportTable: string,
  inputs: BusinessCommentInput[],
  transformationSql: { path: string; builds: string; sql: string }[]
): ChatMessage[] {
  const checks = inputs
    .map(
      (input, i) =>
        `[${i}] ${input.checkName} on ${input.businessTerm}\n` +
        `     asserts: ${input.claim}\n` +
        `     compares: ${input.comparison}\n` +
        `     tables: ${input.sourceTable}${
          input.targetTable === input.sourceTable ? " (both sides)" : ` -> ${input.targetTable}`
        }`
    )
    .join("\n\n");

  const code = transformationSql
    .map((entry) => `--- ${entry.path} — builds ${entry.builds} ---\n${entry.sql}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        "You are a senior analytics engineer reviewing the SQL behind a reporting table — a snowball, " +
        "waterfall, bridge or movement report — for a colleague about to reconcile it. Each numbered " +
        "item is one check that will run against the finished table: what it asserts, exactly what SQL " +
        "it compares, and which tables it spans. You are also given the transformation SQL that builds " +
        "them.\n\n" +
        "For each item, write the comment that check should carry if it does NOT balance. Rules:\n" +
        '1. Open with the cause, in the form "Because <what the code does> ...". Name and quote the ' +
        "actual fragment responsible. On a reporting table that is usually arithmetic rather than a " +
        "filter: the CASE branches that classify a movement and whether they can overlap or leave a " +
        "gap, the LAG/LEAD and what it partitions and orders by, the window frame (ROWS BETWEEN ...), " +
        "the scaffold or calendar join that invents rows, the ISNULL/COALESCE that turns a missing " +
        "balance into zero, the sign a movement is stored with, the GROUP BY that sets the grain. " +
        "Quote it exactly as written.\n" +
        "2. Then one clause on what that does to this particular check.\n" +
        "3. Then what the engineer should check or change first.\n" +
        "4. Two or three sentences, under 120 words. Plain prose. No markdown, no bullets, no preamble. " +
        "Do not use semicolons — the answer is embedded in a SQL string literal and a semicolon breaks " +
        "it.\n" +
        "5. You are reading code only and cannot see any data, so write what WOULD explain a " +
        "difference. Never state that a difference exists, never say the report is wrong, and never " +
        "quote a number.\n" +
        "6. If nothing in the code would stop this check balancing, write one sentence that starts " +
        '"Nothing in this transformation would unbalance this" and names the expressions you checked.\n' +
        "7. Never name a table, column or expression that is not in the SQL you were given.\n\n" +
        'Respond with ONLY compact JSON: {"comments": [{"index": <int from the list>, "comment": "<2-3 ' +
        'sentences>"}, ...]}, exactly one entry per item. No text outside the JSON object.'
    },
    {
      role: "user",
      content:
        `Reporting table: ${reportTable}\n\nChecks to comment on:\n\n${checks}\n\n` +
        `Transformation SQL:\n\n${code || "(no SQL in this project builds this table)"}`
    }
  ];
}

/**
 * One comment per check, in the same order. A check the model skipped comes back as an empty string
 * rather than as a stand-in, exactly as `explainReconciliationChecks` does.
 */
export async function explainBusinessChecks(
  reportTable: string,
  inputs: BusinessCommentInput[],
  transformationSql: { path: string; builds: string; sql: string }[],
  options: LlmCallOptions = {}
): Promise<string[]> {
  if (inputs.length === 0) return [];
  const content = await callAzureOpenAi(buildBusinessCommentMessages(reportTable, inputs, transformationSql), {
    label: `business reconciliation comments ${reportTable}`,
    ...options
  });
  return parseReconCommentResponse(content, inputs.length);
}

// ---- Pipeline layer detection (reading the code, not the schema names) ----

/**
 * One candidate way of grouping the project into layers, with everything derived about it.
 *
 * Two are offered when the project supports both: its schema qualifiers, and its source folders.
 * Which one is the pipeline is the first thing the model is asked, because on a project that writes
 * every stage into one schema the schema grouping is a partition that separates nothing — and
 * `concentration` is the number that says so.
 */
export interface LayerGroupingEvidence {
  kind: LayerGroupingKind;
  groups: {
    name: string;
    tableCount: number;
    /** Table names, capped. The names carry most of the signal about what the group holds. */
    tables: string[];
    /** Tables read here that no statement in the project writes — inputs arriving from outside. */
    externalTableCount: number;
    readsFrom: { name: string; edges: number }[];
    feeds: { name: string; edges: number }[];
    /** Longest path from a group nothing feeds. 0 means this group is fed by nothing. */
    depth: number;
  }[];
  /** The grouping's own ordering, most-raw first. */
  derivedOrder: string[];
  /** Lineage edges that cross groups, and those a layering at this grouping could not see. */
  crossEdges: number;
  innerEdges: number;
  /** The largest group's share of the tables, 0..1. Near 1 means the grouping separates nothing. */
  concentration: number;
  /**
   * The share of the project's tables this grouping places at all, 0..1. Low means it is a grouping
   * of something other than the pipeline — the inputs, say — however evenly it splits what it sees.
   */
  coverage: number;
}

export interface LayerDetectionInput {
  projectName: string;
  groupings: LayerGroupingEvidence[];
  /** What the derived rules prefer, offered as the default rather than as the answer. */
  preferred: LayerGroupingKind | null;
  /** A statement or two per group, tagged with both groupings so they can be compared. */
  samples: { schema: string; folder: string; path: string; builds: string; sql: string }[];
}

export interface DetectedLayer {
  /** The group's name, exactly as it was given — a schema, or a folder. */
  name: string;
  role: LayerRole | null;
  /** One line on why this group is that stage, in this project's own terms. */
  reason: string;
}

export interface LayerDetectionAnswer {
  /** Which candidate grouping the pipeline is staged by. */
  grouping: LayerGroupingKind | null;
  layers: DetectedLayer[];
  /** Groups deliberately left out of the pipeline, each with the reason to print beside it. */
  excluded: { name: string; reason: string }[];
}

const LAYER_ROLES: readonly LayerRole[] = ["ingest", "clean", "transform", "serve"];
const GROUPING_KINDS: readonly LayerGroupingKind[] = ["schema", "folder"];

/**
 * The prompt behind AI layer detection: how is this project staged, and in what order.
 *
 * Two questions, and the first one is the one that used to be assumed. A pipeline is not always
 * staged by schema — a project can write every derived table into a single `refined` schema and
 * separate its stages by source folder — and assuming schemas there collapses six dependency levels
 * into one hop. So both candidate groupings are shown with their own dependency graph, and the model
 * picks before it orders.
 *
 * The model is *not* asked to invent an ordering from nothing: each grouping's derived order comes
 * with it, and the rule is that the answer has to respect the direction data actually flows. What the
 * model adds is the reading — that `prep` holds cleaned copies rather than reports, that `security`
 * is not a stage at all, that fourteen tables in one schema are really three stages of work — which
 * is a judgement about meaning rather than a fact the SQL states.
 */
export function buildLayerDetectionMessages(input: LayerDetectionInput): ChatMessage[] {
  const groupingBlock = input.groupings
    .map((grouping) => {
      const groups = grouping.groups
        .map((g) => {
          const reads = g.readsFrom.length
            ? g.readsFrom.map((r) => `${r.name} (${r.edges})`).join(", ")
            : "nothing in this project";
          const feeds = g.feeds.length ? g.feeds.map((f) => `${f.name} (${f.edges})`).join(", ") : "nothing in this project";
          return (
            `    ${g.name}: ${g.tableCount} table(s), dependency depth ${g.depth}\n` +
            `      tables: ${g.tables.join(", ") || "(none named)"}\n` +
            `      reads from: ${reads}\n` +
            `      feeds: ${feeds}\n` +
            `      tables arriving from outside this project (never written here): ${g.externalTableCount}`
          );
        })
        .join("\n");
      return (
        `  GROUPING "${grouping.kind}" — ${grouping.groups.length} group(s)\n` +
        `    derived order, most-raw first: ${grouping.derivedOrder.join(" -> ")}\n` +
        `    lineage edges between groups: ${grouping.crossEdges}; edges hidden inside a group: ${grouping.innerEdges}\n` +
        `    largest group holds ${Math.round(grouping.concentration * 100)}% of the tables\n` +
        `${groups}`
      );
    })
    .join("\n\n");

  const sampleBlock = input.samples
    .map((s) => `--- schema ${s.schema} | folder ${s.folder} | ${s.path} — builds ${s.builds} ---\n${s.sql}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        "You are a senior data engineer being shown a SQL project you have never seen, and asked to " +
        "work out its pipeline layers. You are given one or more candidate ways of GROUPING the " +
        "project — by the schema its tables are qualified with, and by the source folder the file " +
        "that builds them lives in — each with its tables, its group-to-group dependency graph, and a " +
        "sample of the SQL that builds them.\n\n" +
        "Answer three things:\n" +
        "1. Which GROUPING the pipeline is actually staged by.\n" +
        "2. Within it, which groups are stages of ONE data pipeline, ordered from most-raw to " +
        "most-refined.\n" +
        "3. Which groups are not pipeline stages at all - security, configuration, logging, audit, " +
        "metadata, a scratch area - and should be left out.\n\n" +
        "Rules:\n" +
        "a. Prefer the schema grouping. It is the convention and the one a reader expects. Choose the " +
        "folder grouping only when the schemas do not separate the pipeline — the clearest sign is one " +
        "schema holding most of the tables while the SQL inside it is a chain many levels deep, which " +
        "shows up as a high largest-group percentage and a high hidden-edges count. In that case the " +
        "folders are carrying the staging the schemas do not.\n" +
        "b. Use ONLY the group names from the grouping you chose, spelled exactly as given. Never " +
        "invent one, never merge two, never rename one, and never mix names from both groupings.\n" +
        "c. The order must agree with that grouping's dependency graph: if A's tables are built by " +
        "reading B, then B comes before A. The derived order already satisfies this - depart from it " +
        "only when the code gives you a reason, and say what that reason was.\n" +
        "d. Judge each group by what its tables ARE, not by whether its name resembles a convention. A " +
        "group called arr or optum holding wide reporting tables built by joining and aggregating " +
        "others is a serving layer. A group called prep holding one cleaned copy per input table is a " +
        "cleaning layer. Say so in the project's own words.\n" +
        "e. role is the stage the group plays, one of: ingest (data lands as it arrived), clean " +
        "(typed, deduplicated, conformed copies), transform (joined, enriched, business logic " +
        "applied), serve (facts, dimensions, marts, reports read by people or tools). Use null only if " +
        "the code genuinely does not say.\n" +
        "f. Several groups may share a role, and a role may be missing entirely. Do not force one " +
        "group per role, and do not pad the pipeline out to four stages.\n" +
        "g. reason is one sentence naming the actual evidence - a table, a group it reads, or what the " +
        "SQL does to it. Under 25 words. No markdown.\n\n" +
        'Respond with ONLY compact JSON: {"grouping": "schema" | "folder", "layers": [{"name": ' +
        '"<exact group name>", "role": "ingest" | "clean" | "transform" | "serve" | null, "reason": ' +
        '"<one sentence>"}, ...], "excluded": [{"name": "<exact group name>", "reason": "<why it is ' +
        'not a pipeline stage>"}, ...]}. "layers" is in pipeline order, most-raw first. Every group of ' +
        "the grouping you chose must appear in exactly one of the two lists. No text outside the JSON " +
        "object."
    },
    {
      role: "user",
      content:
        `Project folder: ${input.projectName}\n\n` +
        `Candidate groupings:\n\n${groupingBlock}\n\n` +
        `Grouping the derived rules prefer: ${input.preferred ?? "(none)"}\n\n` +
        `Sample transformation SQL:\n\n${sampleBlock || "(no statements available)"}`
    }
  ];
}

/**
 * Parses the answer into a grouping, its layers and its exclusions, keeping only what is
 * structurally valid.
 *
 * Group names are *not* checked against the project here — this function doesn't know what the
 * project's groups are. `layerDetection.ts` does that, because a hallucinated name has to be dropped
 * against the real list rather than against the prompt.
 */
export function parseLayerDetectionResponse(raw: string): LayerDetectionAnswer {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  let parsed: { grouping?: unknown; layers?: unknown; excluded?: unknown };
  try {
    parsed = JSON.parse(cleaned) as { grouping?: unknown; layers?: unknown; excluded?: unknown };
  } catch {
    // Half a JSON document says nothing reliable about the pipeline's shape, and half an ordering is
    // worse than none — the caller falls back to the derived grouping instead of guessing.
    return { grouping: null, layers: [], excluded: [] };
  }

  const layers: DetectedLayer[] = [];
  for (const entry of Array.isArray(parsed.layers) ? parsed.layers : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name) continue;
    layers.push({
      name,
      role: LAYER_ROLES.find((r) => r === rec.role) ?? null,
      reason: typeof rec.reason === "string" ? rec.reason.trim() : ""
    });
  }

  const excluded: { name: string; reason: string }[] = [];
  for (const entry of Array.isArray(parsed.excluded) ? parsed.excluded : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name) continue;
    excluded.push({ name, reason: typeof rec.reason === "string" ? rec.reason.trim() : "" });
  }

  return { grouping: GROUPING_KINDS.find((k) => k === parsed.grouping) ?? null, layers, excluded };
}

export async function detectPipelineLayers(
  input: LayerDetectionInput,
  options: LlmCallOptions = {}
): Promise<LayerDetectionAnswer> {
  const content = await callAzureOpenAi(buildLayerDetectionMessages(input), {
    label: `layer detection ${input.projectName}`,
    ...options
  });
  return parseLayerDetectionResponse(content);
}
