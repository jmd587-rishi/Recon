import axios from "axios";
import type { CodeCandidate, LevelFinding, LevelReport, LevelSeverity, LogicValidationResult } from "../types/index.js";

export class LlmConfigError extends Error {}

// Reconciliation prompts can carry several notebook code snippets, and this deployment is a
// reasoning model, so 30s (axios's default-ish ceiling used elsewhere) is too tight — bump it up.
const LLM_TIMEOUT_MS = 120_000;

async function callAzureOpenAi(messages: ChatMessage[]): Promise<string> {
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
  const body = { model: deployment, input: messages };

  console.log("[llmClient] sending request", { url, model: deployment, messageCount: messages.length });
  const startedAt = Date.now();

  try {
    const res = await axios.post(url, body, {
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      timeout: LLM_TIMEOUT_MS,
    });

    console.log("[llmClient] received response", { status: res.status, elapsedMs: Date.now() - startedAt });

    const content =
      res.data?.output_text ??
      res.data?.output
        ?.flatMap((item: any) => item?.content ?? [])
        ?.find((c: any) => c?.type === "output_text" || c?.type === "text")?.text;

    if (!content) {
      throw new Error("Azure OpenAI response did not include any message content.");
    }
    return content;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const detail = err.response?.data && typeof err.response.data === "object"
        ? JSON.stringify(err.response.data)
        : err.message;
      console.error("[llmClient] request failed", { elapsedMs: Date.now() - startedAt, detail });
      throw new Error(`Azure OpenAI request failed: ${detail}`);
    }
    console.error("[llmClient] unexpected error", { elapsedMs: Date.now() - startedAt, err });
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
        "mismatches between two adjacent stages of a medallion pipeline (e.g. bronze -> silver -> gold). " +
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
        "several downstream tables in a Databricks medallion pipeline (e.g. one silver table feeding " +
        "multiple gold tables). You are given one candidate query/snippet per downstream table. " +
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
        "You are a senior data engineering reconciliation reviewer. You are given one 'level' of a medallion " +
        "pipeline — a source layer feeding an adjacent target layer (e.g. bronze -> silver, or silver -> gold) — " +
        "the tables selected at each layer, the notebook transformation code that moves data between them, and " +
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
        "You are a data engineering assistant explaining exclusion rules found in Databricks medallion " +
        "pipeline notebooks — WHERE predicates on the SQL statement that writes each table, which determine " +
        "which source rows get dropped as data moves between layers (e.g. raw -> staging -> transform -> " +
        "dim -> fact). For each rule, in 1-3 sentences explain in plain business English what kind of rows " +
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
