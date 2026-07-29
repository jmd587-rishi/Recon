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
/**
 * Ops that touch a table without moving any data through it. The `IF OBJECT_ID(...) DROP TABLE x`
 * guard at the top of a rebuild script is the commonest statement in a T-SQL warehouse project, and
 * counting its table as a read makes every rebuilt table look like an input to itself.
 */
const NON_LINEAGE_OPS = new Set(["drop", "truncate"]);

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

export interface TableOpSplit {
  sourceTables: string[];
  targetTable: string | null;
}

/**
 * Strips the quoting a dialect puts around an identifier: MySQL/Hive backticks and T-SQL square
 * brackets, so `[datamart].[fact_arr]` and `datamart.fact_arr` are the same table. Bracket-quoted
 * names are the norm in SQL Server / SSDT projects, where every generated script emits them.
 */
function cleanIdentifier(ref: string): string {
  return ref.replace(/[`[\]]/g, "").toLowerCase();
}

/**
 * Splits one of node-sql-parser's `op::db::table` tags. The op is lowercased because the library is
 * not consistent about it — DML comes back as `select`/`insert`/`create`, DDL as `DROP`/`TRUNCATE` —
 * and every op set here is written in lower case.
 */
function cleanTaggedRef(ref: string): { op: string; table: string } {
  const parts = ref.split("::").map((p) => p.replace(/[`[\]]/g, ""));
  const op = (parts[0] ?? "").toLowerCase();
  const table = parts[parts.length - 1] ?? ref;
  const db = parts.length >= 3 ? parts[parts.length - 2] : "";
  const qualified = db && db !== "null" ? `${db}.${table}` : table;
  return { op, table: qualified.toLowerCase() };
}

function splitTablesByOp(sql: string): TableOpSplit | null {
  for (const database of SQL_DIALECTS) {
    try {
      const refs = parser
        .tableList(sql, { database })
        .map(cleanTaggedRef)
        .filter((r) => !NON_LINEAGE_OPS.has(r.op));
      const sourceTables = Array.from(new Set(refs.filter((r) => !WRITE_OPS.has(r.op)).map((r) => r.table)));
      const targetTable = refs.find((r) => WRITE_OPS.has(r.op))?.table ?? null;
      return { sourceTables, targetTable };
    } catch {
      // try next dialect
    }
  }
  return null;
}

// `#` (T-SQL temp tables) and `[]` (bracket-quoted identifiers) belong in every identifier class
// here — a SQL Server project writes `INTO #stage_rows` and `FROM [raw].[sales_report]` constantly.
const IDENT = "[a-zA-Z0-9_.#`[\\]]+";
const CREATE_TABLE_RE = new RegExp(
  `create\\s+(?:or\\s+(?:replace|alter)\\s+)?(?:temp(?:orary)?\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?(${IDENT})`,
  "i"
);
const INSERT_INTO_RE = new RegExp(`insert\\s+(?:overwrite\\s+)?(?:into\\s+)?(?:table\\s+)?(${IDENT})`, "i");
const MERGE_INTO_RE = new RegExp(`merge\\s+into\\s+(${IDENT})`, "i");
const FROM_JOIN_RE = new RegExp(`\\b(?:from|join|using)\\s+(${IDENT})`, "gi");
const INTO_RE = new RegExp(`\\binto\\s+(${IDENT})`, "gi");

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** T-SQL local/global temp tables — real targets within a script, but never pipeline tables. */
export function isTempTable(table: string): boolean {
  return table.startsWith("#");
}

/**
 * Finds the target of T-SQL's `SELECT ... INTO <target> FROM ...`, the CTAS spelling SQL Server uses
 * and the one an SSDT project's build scripts are written in.
 *
 * This needs its own pass because node-sql-parser *accepts* the statement rather than rejecting it —
 * it just reports the `INTO` target as one more table the query mentions, so the write looks like a
 * read and the fallback regexes below never get a chance to run. `INSERT INTO` / `MERGE INTO` are
 * skipped because those are already recognised as writes with their own precedence.
 *
 * A whole stored procedure arrives here as one statement and typically stages through several temp
 * tables before its one real write, so the *last* persistent target wins; when every target is a
 * temp table (an ordinary staging statement in a script that isn't a procedure) the first is
 * returned, which is the one that statement actually creates.
 */
function findSelectIntoTarget(stripped: string): string | null {
  const targets: string[] = [];
  INTO_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INTO_RE.exec(stripped))) {
    const before = stripped.slice(0, m.index).trimEnd();
    if (/\b(?:insert|merge|bulk)$/i.test(before)) continue;
    if (!/\bselect\b/i.test(before)) continue;
    targets.push(cleanIdentifier(m[1]));
  }
  const persistent = targets.filter((t) => !isTempTable(t));
  return persistent[persistent.length - 1] ?? targets[0] ?? null;
}

/** Index just past the `)` closing the parenthesis opened at `open`, or -1 if it never closes. */
function skipBalancedParens(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Names bound by a `WITH a AS (...), b AS (...)` clause — CTE aliases, not tables.
 *
 * `FROM_JOIN_RE` cannot tell a CTE from a real table, and ETL SQL written as one long CTE chain (the
 * house style of every T-SQL warehouse script here) would otherwise report a dozen phantom source
 * tables per statement and draw lineage edges out of them. Every `WITH` in the text is scanned, not
 * just one at the start, because after `sqlFileParser` keeps a stored procedure whole its CTEs sit
 * in the middle of the statement. The shape required — identifier, optional column list, `AS`, then
 * a balanced `(` — is strict enough that non-CTE uses of the keyword (`WITH (NOLOCK)` table hints,
 * `WITH CUBE`, `WITH TIES`) match nothing and contribute no names.
 */
function collectCteNames(stripped: string): Set<string> {
  const names = new Set<string>();
  const withRe = /\bwith\b/gi;
  let match: RegExpExecArray | null;

  while ((match = withRe.exec(stripped))) {
    let i = match.index + match[0].length;

    for (;;) {
      while (i < stripped.length && /\s/.test(stripped[i])) i++;
      const name = new RegExp(`^${IDENT}`).exec(stripped.slice(i));
      if (!name) break;
      i += name[0].length;

      while (i < stripped.length && /\s/.test(stripped[i])) i++;
      if (stripped[i] === "(") {
        // optional explicit column list, e.g. `WITH totals (customer, amount) AS (...)`
        const afterColumns = skipBalancedParens(stripped, i);
        if (afterColumns < 0) break;
        i = afterColumns;
        while (i < stripped.length && /\s/.test(stripped[i])) i++;
      }

      if (!/^as\b/i.test(stripped.slice(i))) break;
      i += 2;
      while (i < stripped.length && /\s/.test(stripped[i])) i++;
      if (stripped[i] !== "(") break;

      const afterBody = skipBalancedParens(stripped, i);
      if (afterBody < 0) break;
      names.add(cleanIdentifier(name[0]));
      i = afterBody;

      while (i < stripped.length && /\s/.test(stripped[i])) i++;
      if (stripped[i] !== ",") break;
      i++;
    }
  }

  return names;
}

/**
 * Used when node-sql-parser rejects the statement for every dialect it knows (e.g. Databricks-only
 * syntax like `CREATE OR REPLACE TABLE ... AS SELECT`, or `MERGE INTO`, which none of the four
 * dialects parse at all). Regex-only, so it can't tell a subquery alias from a real table, but it's
 * enough to recover target/source table names for lineage.
 */
function fallbackSplitTablesByOp(stripped: string): TableOpSplit {
  const mergeMatch = stripped.match(MERGE_INTO_RE);
  const createMatch = mergeMatch ? null : stripped.match(CREATE_TABLE_RE);
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

/**
 * Source/target split for a single SQL statement: the AST parser when any dialect accepts it, the
 * regex fallback when none do. Exported so callers working with raw SQL (a `.sql` file uploaded from
 * disk, say) get exactly the same table-extraction behaviour as notebook cells do.
 *
 * Both paths are then corrected the same way, because both get the same two things wrong on T-SQL:
 * a `SELECT ... INTO` write read as a read, and CTE aliases counted as tables.
 */
export function splitSqlTablesByOp(sql: string): TableOpSplit {
  const stripped = stripSqlComments(sql);
  const split = splitTablesByOp(sql) ?? fallbackSplitTablesByOp(stripped);

  // A temp target found by the regexes is only provisional: in a batch that stages through `#tmp`
  // before writing a real table, the real write is the one lineage cares about.
  const targetTable =
    split.targetTable && !isTempTable(split.targetTable)
      ? split.targetTable
      : (findSelectIntoTarget(stripped) ?? split.targetTable);
  const ctes = collectCteNames(stripped);
  const sourceTables = split.sourceTables.filter((t) => !ctes.has(t) && t !== targetTable);

  return { sourceTables, targetTable };
}

/**
 * Rewrites each fact's sources so that lineage drawn through T-SQL temp tables survives.
 *
 * A script that stages into `#base` and later selects from it has real lineage — `raw.x -> #base`
 * then `#base -> datamart.y` — but `#base` exists only inside that one script, so neither edge is
 * meaningful on its own and the graph would show two orphans instead of `raw.x -> datamart.y`.
 * Substituting each temp source with the real tables that fed it stitches the chain back together.
 * Facts are walked in order and only earlier writes are consulted, which is exactly how the script
 * runs; `seen` stops a temp table rebuilt from itself (`SELECT ... INTO #t FROM #t`) from recursing.
 *
 * Callers pass facts from a single script — temp tables are scoped to the session that made them, so
 * facts from different files must not resolve against each other.
 */
export function resolveTempTableSources(facts: LineageFact[]): LineageFact[] {
  const feeders = new Map<string, string[]>();

  const expand = (table: string, seen: Set<string>): string[] => {
    if (!isTempTable(table)) return [table];
    if (seen.has(table)) return [];
    seen.add(table);
    return (feeders.get(table) ?? []).flatMap((source) => expand(source, seen));
  };

  return facts.map((fact) => {
    const sourceTables = Array.from(new Set(fact.sourceTables.flatMap((s) => expand(s, new Set()))));
    if (fact.targetTable && isTempTable(fact.targetTable)) feeders.set(fact.targetTable, sourceTables);
    return { ...fact, sourceTables };
  });
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
        const split = splitSqlTablesByOp(stmt);
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
        const split = splitSqlTablesByOp(sql);
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
