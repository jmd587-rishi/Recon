import pkg from "node-sql-parser";
import type { ConnectionConfig, LineageEdge, NotebookCell, ParsedNotebook, Table } from "../types/index.js";
import { exportNotebookSource, listNotebooksRecursive } from "./databricksClient.js";
import { parseNotebookSource } from "./notebookParser.js";
import { snippet } from "./reconciliationEngine.js";
import { extractJoinKeyHint } from "./whereClauseAnalyzer.js";

const { Parser } = pkg;
const parser = new Parser();
const SQL_DIALECTS = ["hive", "transactsql", "postgresql", "mysql"] as const;
const WRITE_OPS = new Set(["insert", "create", "update", "replace"]);

export interface LineageFact {
  notebookPath: string;
  cellIndex: number;
  sourceTables: string[];
  targetTable: string | null;
  rawSql: string;
}

export interface LineageTransformation {
  targetTable: string;
  notebookPath: string;
  cellIndex: number;
  sourceTables: string[];
  snippet: string;
}

interface TableOpSplit {
  sourceTables: string[];
  targetTable: string | null;
}

function cleanIdentifier(ref: string): string {
  return ref.replace(/`/g, "").toLowerCase();
}

function cleanTaggedRef(ref: string): { op: string; table: string } {
  const parts = ref.split("::").map((p) => p.replace(/`/g, ""));
  const op = parts[0] ?? "";
  const table = parts[parts.length - 1] ?? ref;
  const db = parts.length >= 3 ? parts[parts.length - 2] : "";
  const qualified = db && db !== "null" ? `${db}.${table}` : table;
  return { op, table: qualified.toLowerCase() };
}

function splitTablesByOp(sql: string): TableOpSplit | null {
  for (const database of SQL_DIALECTS) {
    try {
      const refs = parser.tableList(sql, { database }).map(cleanTaggedRef);
      const sourceTables = Array.from(new Set(refs.filter((r) => !WRITE_OPS.has(r.op)).map((r) => r.table)));
      const targetTable = refs.find((r) => WRITE_OPS.has(r.op))?.table ?? null;
      return { sourceTables, targetTable };
    } catch {
      // try next dialect
    }
  }
  return null;
}

const CREATE_TABLE_AS_RE =
  /create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z0-9_.`]+)\s+as\s+select/i;
const INSERT_INTO_RE = /insert\s+(?:overwrite\s+)?(?:into\s+)?(?:table\s+)?([a-zA-Z0-9_.`]+)/i;
const MERGE_INTO_RE = /merge\s+into\s+([a-zA-Z0-9_.`]+)/i;
const FROM_JOIN_RE = /\b(?:from|join|using)\s+([a-zA-Z0-9_.`]+)/gi;

/**
 * Used when node-sql-parser rejects the statement for every dialect it knows (e.g. Databricks-only
 * syntax like `CREATE OR REPLACE TABLE ... AS SELECT`, or `MERGE INTO`, which none of the four
 * dialects parse at all). Regex-only, so it can't tell a subquery alias from a real table, but it's
 * enough to recover target/source table names for lineage.
 */
function fallbackSplitTablesByOp(sql: string): TableOpSplit {
  const stripped = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  const mergeMatch = stripped.match(MERGE_INTO_RE);
  const createMatch = mergeMatch ? null : stripped.match(CREATE_TABLE_AS_RE);
  const insertMatch = mergeMatch || createMatch ? null : stripped.match(INSERT_INTO_RE);
  const targetTable = mergeMatch
    ? cleanIdentifier(mergeMatch[1])
    : createMatch
      ? cleanIdentifier(createMatch[1])
      : insertMatch
        ? cleanIdentifier(insertMatch[1])
        : null;

  const sourceTables = new Set<string>();
  let m: RegExpExecArray | null;
  FROM_JOIN_RE.lastIndex = 0;
  while ((m = FROM_JOIN_RE.exec(stripped))) {
    sourceTables.add(cleanIdentifier(m[1]));
  }
  if (targetTable) sourceTables.delete(targetTable);

  return { sourceTables: Array.from(sourceTables), targetTable };
}

function splitStatements(source: string): string[] {
  return source
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const SPARK_SQL_RE =
  /(?:(\w+)\s*=\s*)?spark\.sql\(\s*f?"""([\s\S]*?)"""\s*\)|(?:(\w+)\s*=\s*)?spark\.sql\(\s*f?"([^"]*)"\s*\)|(?:(\w+)\s*=\s*)?spark\.sql\(\s*f?'([^']*)'\s*\)/g;
const WRITE_TARGET_RE = /\.(?:saveAsTable|insertInto)\(\s*["']([\w.`]+)["']/;
const READ_TABLE_RE = /spark\.(?:read\.)?table\(\s*["']([\w.`]+)["']\s*\)/g;

/**
 * Best-effort fallback for pure DataFrame-API notebooks (no spark.sql() at all): pairs a
 * `.saveAsTable(...)`/`.insertInto(...)` write with any `spark.table(...)` / `spark.read.table(...)`
 * reads in the same cell. Skipped if the cell already yielded a spark.sql-based fact for the same
 * target, since that fact carries the actual query rather than just the cell text.
 */
function extractPysparkDataframeLineage(cell: NotebookCell, targetsAlreadyFound: Set<string>): LineageFact | null {
  const writeMatch = cell.source.match(WRITE_TARGET_RE);
  if (!writeMatch) return null;
  const targetTable = cleanIdentifier(writeMatch[1]);
  if (targetsAlreadyFound.has(targetTable)) return null;

  const sourceTables = new Set<string>();
  let m: RegExpExecArray | null;
  READ_TABLE_RE.lastIndex = 0;
  while ((m = READ_TABLE_RE.exec(cell.source))) {
    sourceTables.add(cleanIdentifier(m[1]));
  }
  if (sourceTables.size === 0) return null;

  return {
    notebookPath: "",
    cellIndex: cell.index,
    sourceTables: Array.from(sourceTables),
    targetTable,
    rawSql: cell.source
  };
}

export function extractLineageFacts(parsed: ParsedNotebook): LineageFact[] {
  const facts: LineageFact[] = [];

  for (const cell of parsed.cells) {
    const targetsInCell = new Set<string>();

    if (cell.language === "sql") {
      for (const stmt of splitStatements(cell.source)) {
        const split = splitTablesByOp(stmt) ?? fallbackSplitTablesByOp(stmt);
        if (split.targetTable) targetsInCell.add(split.targetTable);
        facts.push({
          notebookPath: parsed.path,
          cellIndex: cell.index,
          sourceTables: split.sourceTables,
          targetTable: split.targetTable,
          rawSql: stmt
        });
      }
    } else if (cell.language === "python") {
      let match: RegExpExecArray | null;
      SPARK_SQL_RE.lastIndex = 0;
      while ((match = SPARK_SQL_RE.exec(cell.source))) {
        const sql = match[2] ?? match[4] ?? match[6] ?? "";
        if (!sql.trim()) continue;
        const split = splitTablesByOp(sql) ?? fallbackSplitTablesByOp(sql);
        if (split.targetTable) targetsInCell.add(split.targetTable);
        facts.push({
          notebookPath: parsed.path,
          cellIndex: cell.index,
          sourceTables: split.sourceTables,
          targetTable: split.targetTable,
          rawSql: sql
        });
      }

      const dfFact = extractPysparkDataframeLineage(cell, targetsInCell);
      if (dfFact) facts.push({ ...dfFact, notebookPath: parsed.path });
    }
  }

  return facts;
}

function referencesTable(tables: string[], tableName: string): boolean {
  const needle = tableName.split(".").pop()!.toLowerCase();
  return tables.some((ref) => (ref.split(".").pop() ?? ref) === needle);
}

/**
 * Scans notebooks under `notebookRoot` for queries/DataFrame writes that read from `sourceTable`
 * and write out to some other table (e.g. a silver table fanning out into several gold tables),
 * without paying the AST-parse cost for notebooks that never mention the source table.
 */
export async function findTransformationsFromTable(
  connection: ConnectionConfig,
  notebookRoot: string,
  sourceTable: string,
  targetSchema?: string
): Promise<LineageTransformation[]> {
  const notebooks = await listNotebooksRecursive(connection, notebookRoot);
  const needle = sourceTable.split(".").pop()!.toLowerCase();
  const targetSchemaNeedle = targetSchema?.toLowerCase();
  const results: LineageTransformation[] = [];

  for (const notebook of notebooks) {
    let source: string;
    try {
      source = await exportNotebookSource(connection, notebook.path);
    } catch {
      continue;
    }
    if (!source.toLowerCase().includes(needle)) continue;

    const parsed = parseNotebookSource(notebook.path, source, notebook.language);
    const facts = extractLineageFacts(parsed);

    for (const fact of facts) {
      if (!fact.targetTable) continue;
      if (!referencesTable(fact.sourceTables, sourceTable)) continue;

      if (targetSchemaNeedle) {
        const schemaSegment = fact.targetTable.split(".").slice(0, -1).pop();
        if (schemaSegment !== targetSchemaNeedle) continue;
      }

      results.push({
        targetTable: fact.targetTable,
        notebookPath: fact.notebookPath,
        cellIndex: fact.cellIndex,
        sourceTables: fact.sourceTables,
        snippet: snippet(fact.rawSql)
      });
    }
  }

  return results;
}

/**
 * Scans every notebook under `notebookRoot` and extracts lineage facts for all of them, unfiltered
 * by any particular table — unlike `findTransformationsFromTable`, which only fetches notebooks
 * whose source text mentions one specific table name. Used to build the whole-pipeline lineage
 * graph (Problem 1 section 3) and to drive per-layer exclusion analysis, both of which need facts
 * for every table at once rather than one at a time.
 */
export async function scanAllLineageFacts(connection: ConnectionConfig, notebookRoot: string): Promise<LineageFact[]> {
  const notebooks = await listNotebooksRecursive(connection, notebookRoot);
  const facts: LineageFact[] = [];

  for (const notebook of notebooks) {
    let source: string;
    try {
      source = await exportNotebookSource(connection, notebook.path);
    } catch {
      continue;
    }
    const parsed = parseNotebookSource(notebook.path, source, notebook.language);
    facts.push(...extractLineageFacts(parsed));
  }

  return facts;
}

/**
 * Builds display-ready lineage edges from `facts`, scoped to tables known to the pipeline.
 * `tableIndex` maps a bare (unqualified, lowercased) table name to its Unity Catalog `Table` —
 * matching against known table names rather than parsing a schema qualifier out of the SQL text,
 * since notebooks frequently reference tables unqualified within their own schema context and
 * `extractLineageFacts` can't recover a schema node-sql-parser never saw. Also used by
 * `exclusionAnalyzer.ts` to resolve which schema a bare source-table name actually lives in.
 */
export function buildLineageGraph(facts: LineageFact[], tableIndex: Map<string, Table>): LineageEdge[] {
  const edges = new Map<string, LineageEdge>();

  for (const fact of facts) {
    if (!fact.targetTable) continue;
    const targetBareName = fact.targetTable.split(".").pop()!;
    if (!tableIndex.has(targetBareName)) continue;

    const joinKeyHint = extractJoinKeyHint(fact.rawSql);
    for (const source of fact.sourceTables) {
      const key = `${source}->${fact.targetTable}`;
      if (edges.has(key)) continue;
      edges.set(key, {
        from: source,
        to: fact.targetTable,
        joinKeyHint,
        notebookPath: fact.notebookPath,
        cellIndex: fact.cellIndex
      });
    }
  }

  return Array.from(edges.values());
}
