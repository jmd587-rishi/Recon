import type { ConnectionConfig, LayerRef, Table } from "../types/index.js";
import { listTables, runCountStatement, exportNotebookSource } from "./databricksClient.js";
import { findCodeForTable, findNotebookSourcesForTable } from "./codeResponsibility.js";
import { scanAllLineageFacts, type LineageFact } from "./tableLineage.js";
import {
  diagnoseDataQualityFailure,
  generateDataQualityHypotheses,
  judgeDataQualityRule
} from "./llmDataQuality.js";

export interface DataQualityRule {
  ruleId: string;
  tableName: string;
  column?: string;
  ruleType: string;
  ruleExpr: string;
  description: string;
  status: "PASS" | "FAIL" | "ERROR";
  totalRows?: number;
  failedCount?: number;
  judgment?: {
    isIssue: boolean;
    explanation: string;
  };
  diagnosis?: {
    explanation: string;
    suggestedFix: string;
    notebookPath?: string;
    cell?: string;
  };
}

export interface DataQualityTable {
  tableName: string;
  checks: DataQualityRule[];
}

export interface DataQualityResult {
  layer: LayerRef;
  tables: DataQualityTable[];
  runAt: string;
}

export interface DataQualityRunOptions {
  preferredNotebookPaths?: string[];
}

interface TransformationSnippet {
  notebookPath: string;
  cellIndex: number;
  snippet: string;
  notebookSource?: string;
}

function bareName(ref: string): string {
  return ref
    .replace(/`/g, "")
    .split(".")
    .filter(Boolean)
    .pop()
    ?.toLowerCase() ?? "";
}

function quoteIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "")}\``;
}

function qualifiedTable(catalog: string, schema: string, table: string): string {
  return `${quoteIdentifier(catalog)}.${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function tableQualifies(fact: LineageFact, tableName: string): boolean {
  return !!fact.targetTable && bareName(fact.targetTable) === tableName.toLowerCase();
}

async function countRows(
  connection: ConnectionConfig,
  warehouseId: string,
  catalog: string,
  schema: string,
  tableName: string,
  predicate?: string
): Promise<number> {
  const qualified = qualifiedTable(catalog, schema, tableName);
  const whereClause = predicate ? `WHERE ${predicate}` : "";
  const statement = `SELECT COUNT(*) AS cnt FROM ${qualified} ${whereClause}`;
  console.log("Executing warehouse query", { warehouseId, catalog, schema, tableName, predicate, statement });
  return await runCountStatement(connection, warehouseId, statement);
}

export async function runDataQualityChecks(
  connection: ConnectionConfig,
  warehouseId: string,
  catalog: string,
  notebookRoot: string,
  layer: LayerRef,
  options: DataQualityRunOptions = {}
): Promise<DataQualityResult> {
  const tables = await listTables(connection, catalog, layer.schema);
  const allFacts = await scanAllLineageFacts(connection, notebookRoot);
  const preferredNotebookPaths = options.preferredNotebookPaths?.filter((path) => path.trim().length > 0) ?? [];
  const facts = preferredNotebookPaths.length > 0
    ? allFacts.filter((fact) => preferredNotebookPaths.includes(fact.notebookPath))
    : allFacts;

  const results: DataQualityTable[] = [];

  for (const table of tables) {
    let snippets: TransformationSnippet[] = facts
      .filter((fact) => tableQualifies(fact, table.name))
      .map((fact) => ({ notebookPath: fact.notebookPath, cellIndex: fact.cellIndex, snippet: fact.rawSql }));

    if (snippets.length === 0) {
      const fallbackCandidates = await findCodeForTable(connection, notebookRoot, catalog, layer.schema, table.name);
      snippets = fallbackCandidates.map((candidate) => ({
        notebookPath: candidate.notebookPath,
        cellIndex: candidate.cellIndex,
        snippet: candidate.snippet
      }));

      if (snippets.length > 0) {
        console.log("[dataQuality] fallback notebook candidates used", {
          tableName: table.name,
          notebookCount: snippets.length
        });
      }
    }

    if (snippets.length === 0) {
      const sourceFiles = await findNotebookSourcesForTable(connection, notebookRoot, catalog, layer.schema, table.name);
      snippets = sourceFiles.map((candidate) => ({
        notebookPath: candidate.notebookPath,
        cellIndex: candidate.cellIndex,
        snippet: candidate.snippet,
        notebookSource: candidate.notebookSource
      }));

      if (snippets.length > 0) {
        console.log("[dataQuality] notebook source fallback used", {
          tableName: table.name,
          notebookCount: snippets.length
        });
      }
    }

    // Attach full notebook source where available to give the LLM more context when diagnosing
    const notebookPaths = Array.from(new Set(snippets.map((s) => s.notebookPath).filter(Boolean)));
    for (const path of notebookPaths) {
      try {
        const source = await exportNotebookSource(connection, path);
        // attach truncated source to matching snippets
        const truncated = typeof source === "string" ? source.slice(0, 50_000) : source;
        snippets = snippets.map((s) => (s.notebookPath === path ? { ...s, notebookSource: truncated } : s));
      } catch {
        // ignore failures to export source for a notebook
      }
    }

    const hypotheses = await generateDataQualityHypotheses(table, layer, snippets);
    const totalRows = await countRows(connection, warehouseId, catalog, layer.schema, table.name);

    const checks: DataQualityRule[] = [];
    for (const hypothesis of hypotheses) {
      const check: DataQualityRule = {
        ruleId: hypothesis.ruleId ?? `${table.name}-${checks.length + 1}`,
        tableName: table.name,
        column: hypothesis.column,
        ruleType: hypothesis.ruleType,
        ruleExpr: hypothesis.ruleExpr,
        description: hypothesis.description,
        status: "PASS",
        totalRows
      };

      if (!check.ruleExpr || !check.ruleExpr.trim()) {
        check.status = "ERROR";
        check.judgment = {
          isIssue: false,
          explanation: "The generated rule does not contain a valid SQL predicate."
        };
        checks.push(check);
        continue;
      }

      try {
        const failedCount = await countRows(
          connection,
          warehouseId,
          catalog,
          layer.schema,
          table.name,
          `NOT (${check.ruleExpr})`
        );
        check.failedCount = failedCount;
        check.status = failedCount > 0 ? "FAIL" : "PASS";

        if (check.status === "FAIL") {
          check.judgment = await judgeDataQualityRule({ table, layer, rule: check, totalRows });
          check.diagnosis = await diagnoseDataQualityFailure({
            table,
            layer,
            rule: check,
            totalRows,
            transformationSnippets: snippets
          });
        }
      } catch (err) {
        check.status = "ERROR";
        check.judgment = {
          isIssue: false,
          explanation: err instanceof Error ? err.message : String(err)
        };
      }

      checks.push(check);
    }

    results.push({ tableName: table.name, checks });
  }

  return {
    layer,
    tables: results,
    runAt: new Date().toISOString()
  };
}
