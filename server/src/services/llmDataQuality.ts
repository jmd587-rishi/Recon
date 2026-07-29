import type { Table, LayerRef, DataQualityRule, DataQualityJudgment, DataQualityDiagnosis } from "../types/index.js";
import type { CodeCandidate } from "../types/index.js";
import { callAzureOpenAi } from "./llmClient.js";

export interface DataQualityHypothesis {
  ruleId: string;
  ruleType: string;
  column?: string;
  ruleExpr: string;
  description: string;
}

export interface DataQualityJudgmentInput {
  table: Table;
  layer: LayerRef;
  rule: DataQualityRule;
  totalRows: number;
}

export interface DataQualityFailureDiagnosisInput {
  table: Table;
  layer: LayerRef;
  rule: DataQualityRule;
  totalRows: number;
  transformationSnippets: CodeCandidate[];
}

function cleanJson(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
}

function truncate(s: string | undefined, max = 8000) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "\n...<truncated>" : s;
}

function notebookSourceBlock(s: CodeCandidate, max = 120000): string {
  const source = s.notebookSource ?? s.snippet;
  return truncate(source, max);
}

export function buildHypothesisMessages(
  table: Table,
  layer: LayerRef,
  snippets: CodeCandidate[]
): { messages: { role: string; content: string }[]; sampleText: string } {
  const snippetBlock = snippets.length
      ? snippets
          .map((s, i) => {
            const fullSource = notebookSourceBlock(s, 120000);
            let block = `[${i}] ${s.notebookPath} (cell ${s.cellIndex}):\n[Full notebook source]\n\`\`\`\n${fullSource}\n\`\`\``;
            if (s.snippet && s.snippet !== s.notebookSource) {
              block += `\n\n[Matched excerpt]\n\`\`\`\n${s.snippet}\n\`\`\``;
            }
            return block;
          })
          .join("\n\n")
    : "(no transformation snippets available)";

  return {
    messages: [
      {
        role: "system",
        content:
          "You are a data engineering assistant that generates data quality hypotheses for a table in a Databricks medallion layer. " +
          "You are given the table schema and any notebook transformation snippets that write to this table. " +
          "Your job is to propose a small number of high-value rules that are likely to be meaningful based on the column names, types, and transformation intent. " +
          "Do not invent arbitrary checks; prefer rules that are directly suggested by the table schema or transformation logic. " +
          'Respond with ONLY compact JSON: {"hypotheses": [{"ruleId": "<id>", "ruleType": "<type>", "column": "<column or null>", "ruleExpr": "<SQL predicate for rows that should be valid>", "description": "<why this is a useful check>"}, ...]}. '
      },
      {
        role: "user",
        content:
          `Table: ${table.name}\n` +
          `Schema: ${table.columns?.map((c) => `${c.name}:${c.typeName}`).join(", ") ?? "unknown"}\n` +
          `Layer: ${layer.label} (${layer.schema})\n\n` +
          `Transformation snippets:\n${snippetBlock}`
      }
    ],
    sampleText: snippetBlock
  };
}

export async function generateDataQualityHypotheses(
  table: Table,
  layer: LayerRef,
  snippets: CodeCandidate[]
): Promise<DataQualityHypothesis[]> {
  const { messages } = buildHypothesisMessages(table, layer, snippets);
  const raw = await callAzureOpenAi(messages as any);
  const cleaned = cleanJson(raw);

  try {
    const parsed = JSON.parse(cleaned) as { hypotheses?: unknown };
    if (!Array.isArray(parsed.hypotheses)) return [];
    return parsed.hypotheses
      .filter((h): h is Record<string, unknown> => typeof h === "object" && h !== null)
      .map((h) => ({
        ruleId: typeof h.ruleId === "string" ? h.ruleId : `rule-${Math.random().toString(36).slice(2, 8)}`,
        ruleType: typeof h.ruleType === "string" ? h.ruleType : "unknown",
        column: typeof h.column === "string" ? h.column : undefined,
        ruleExpr: typeof h.ruleExpr === "string" ? h.ruleExpr : "",
        description: typeof h.description === "string" ? h.description : ""
      }))
      .filter((h) => h.ruleExpr.trim().length > 0);
  } catch {
    return [];
  }
}

export async function judgeDataQualityRule(
  input: DataQualityJudgmentInput
): Promise<DataQualityJudgment> {
  const content = [
    {
      role: "system",
      content:
        "You are a data engineering QA agent. A data quality rule was generated for a table, and its raw failure count is available. Decide whether the result represents a real data issue or a likely false positive. " +
        'Respond with ONLY compact JSON: {"isIssue": <true|false>, "explanation": "<2-4 sentences>"}. '
    },
    {
      role: "user",
      content:
        `Table: ${input.table.name}\n` +
        `Layer: ${input.layer.label} (${input.layer.schema})\n` +
        `Rule: ${input.rule.ruleExpr}\n` +
        `Description: ${input.rule.description}\n` +
        `Total rows: ${input.totalRows}\n` +
        `Failed rows: ${input.rule.failedCount ?? 0}`
    }
  ];
  const raw = await callAzureOpenAi(content as any);
  const cleaned = cleanJson(raw);

  try {
    const parsed = JSON.parse(cleaned) as { isIssue?: unknown; explanation?: unknown };
    return {
      isIssue: typeof parsed.isIssue === "boolean" ? parsed.isIssue : false,
      explanation: typeof parsed.explanation === "string" ? parsed.explanation : cleaned
    };
  } catch {
    return { isIssue: false, explanation: cleaned };
  }
}

export async function diagnoseDataQualityFailure(
  input: DataQualityFailureDiagnosisInput
): Promise<DataQualityDiagnosis> {
  const snippetBlock = input.transformationSnippets.length
      ? input.transformationSnippets
          .map((s, i) => {
            const fullSource = notebookSourceBlock(s, 120000);
            let block = `[${i}] ${s.notebookPath} (cell ${s.cellIndex}):\n[Full notebook source]\n\`\`\`\n${fullSource}\n\`\`\``;
            if (s.snippet && s.snippet !== s.notebookSource) {
              block += `\n\n[Matched excerpt]\n\`\`\`\n${s.snippet}\n\`\`\``;
            }
            return block;
          })
          .join("\n\n")
    : "(no transformation snippets available)";

  const content = [
    {
      role: "system",
      content:
        "You are a data engineering diagnostic assistant. A data quality rule failed on a table, and you must localize the likely cause in source code. " +
        "Use the supplied transformation snippets and the rule predicate to identify the notebook cell most likely responsible. " +
        'Respond with ONLY compact JSON: {"explanation": "<2-4 sentences>", "suggestedFix": "<short fix>", "notebookPath": "<path or empty>", "cell": "<cell identifier or empty>", "codeSnippet": "<source code snippet from the notebook cell or empty>"}. '
    },
    {
      role: "user",
      content:
        `Table: ${input.table.name}\n` +
        `Layer: ${input.layer.label} (${input.layer.schema})\n` +
        `Rule: ${input.rule.ruleExpr}\n` +
        `Description: ${input.rule.description}\n` +
        `Total rows: ${input.totalRows}\n` +
        `Failed rows: ${input.rule.failedCount ?? 0}\n\n` +
        `Transformation snippets:\n${snippetBlock}`
    }
  ];

  console.log("LLM diagnoseDataQualityFailure request:", content);
  const raw = await callAzureOpenAi(content as any);
  console.log("LLM diagnoseDataQualityFailure response:", raw);
  const cleaned = cleanJson(raw);

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      explanation: typeof parsed.explanation === "string" ? parsed.explanation : cleaned,
      suggestedFix: typeof parsed.suggestedFix === "string" ? parsed.suggestedFix : "No suggested fix available.",
      notebookPath: typeof parsed.notebookPath === "string" ? parsed.notebookPath : undefined,
      cell: typeof parsed.cell === "string" ? parsed.cell : undefined,
      codeSnippet: typeof parsed.codeSnippet === "string" ? parsed.codeSnippet : undefined
    };
  } catch {
    return {
      explanation: cleaned,
      suggestedFix: "No suggested fix available."
    };
  }
}
