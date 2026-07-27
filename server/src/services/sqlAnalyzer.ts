import pkg from "node-sql-parser";
import type { NotebookCell, ParsedNotebook, SqlLogicFact } from "../types/index.js";

const { Parser } = pkg;
const parser = new Parser();
const SQL_DIALECTS = ["hive", "transactsql", "postgresql", "mysql"] as const;

const CREATE_VIEW_RE = /create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?view\s+([a-zA-Z0-9_.`]+)/i;
const SPARK_SQL_RE =
  /(?:(\w+)\s*=\s*)?spark\.sql\(\s*f?"""([\s\S]*?)"""\s*\)|(?:(\w+)\s*=\s*)?spark\.sql\(\s*f?"([^"]*)"\s*\)|(?:(\w+)\s*=\s*)?spark\.sql\(\s*f?'([^']*)'\s*\)/g;

function lastSegment(ref: string): string {
  const parts = ref.split("::");
  return parts[parts.length - 1] ?? ref;
}

function cleanIdentifier(ref: string): string {
  return lastSegment(ref).replace(/`/g, "").toLowerCase();
}

function cleanTableRef(ref: string): string {
  const parts = ref.split("::").map((p) => p.replace(/`/g, ""));
  const table = parts[parts.length - 1] ?? ref;
  const db = parts.length >= 3 ? parts[parts.length - 2] : "";
  const qualified = db && db !== "null" ? `${db}.${table}` : table;
  return qualified.toLowerCase();
}

interface ParsedSql {
  tables: string[];
  columns: string[];
  normalized: string;
}

function fallbackParse(sql: string): ParsedSql {
  const stripped = sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/;\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  const tables = new Set<string>();
  const tableRefRe = /\b(?:from|join)\s+([a-zA-Z0-9_.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = tableRefRe.exec(stripped))) {
    tables.add(m[1]);
  }

  return { tables: Array.from(tables), columns: [], normalized: stripped };
}

function parseSql(sql: string): ParsedSql {
  for (const database of SQL_DIALECTS) {
    try {
      const ast = parser.astify(sql, { database });
      const tables = parser.tableList(sql, { database }).map(cleanTableRef);
      const columns = parser.columnList(sql, { database }).map(cleanIdentifier);
      const normalized = parser
        .sqlify(ast, { database })
        .toLowerCase()
        .replace(/`/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return {
        tables: Array.from(new Set(tables)),
        columns: Array.from(new Set(columns)),
        normalized
      };
    } catch {
      // try next dialect
    }
  }
  return fallbackParse(sql);
}

function findMarkdownHeading(cells: NotebookCell[], beforeIndex: number): string | null {
  for (let i = cells.length - 1; i >= 0; i--) {
    const cell = cells[i];
    if (cell.index >= beforeIndex) continue;
    if (cell.language !== "md") continue;
    const headingLine = cell.source.split("\n").find((line) => /^\s*#+\s*\S/.test(line));
    if (headingLine) {
      return headingLine
        .replace(/^\s*#+\s*/, "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    }
  }
  return null;
}

function splitStatements(source: string): string[] {
  return source
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function extractSqlFacts(parsed: ParsedNotebook): SqlLogicFact[] {
  const facts: SqlLogicFact[] = [];

  for (const cell of parsed.cells) {
    if (cell.language === "sql") {
      const statements = splitStatements(cell.source);
      statements.forEach((stmt, stmtIdx) => {
        const parsedSql = parseSql(stmt);
        const viewMatch = stmt.match(CREATE_VIEW_RE);
        const metricName =
          (viewMatch ? cleanIdentifier(viewMatch[1]) : null) ??
          findMarkdownHeading(parsed.cells, cell.index) ??
          `cell_${cell.index}${statements.length > 1 ? `_${stmtIdx}` : ""}`;

        facts.push({
          metricName,
          notebookPath: parsed.path,
          cellIndex: cell.index,
          tables: parsedSql.tables,
          columns: parsedSql.columns,
          normalizedStructure: parsedSql.normalized,
          rawSql: stmt
        });
      });
    } else if (cell.language === "python") {
      let match: RegExpExecArray | null;
      SPARK_SQL_RE.lastIndex = 0;
      while ((match = SPARK_SQL_RE.exec(cell.source))) {
        const varName = match[1] ?? match[3] ?? match[5];
        const sql = match[2] ?? match[4] ?? match[6] ?? "";
        if (!sql.trim()) continue;
        const parsedSql = parseSql(sql);
        const metricName = varName ?? findMarkdownHeading(parsed.cells, cell.index) ?? `cell_${cell.index}`;

        facts.push({
          metricName,
          notebookPath: parsed.path,
          cellIndex: cell.index,
          tables: parsedSql.tables,
          columns: parsedSql.columns,
          normalizedStructure: parsedSql.normalized,
          rawSql: sql
        });
      }
    }
  }

  return facts;
}
