/**
 * Splits standalone `.sql` files into statements while remembering exactly where each statement sat
 * in the original text.
 *
 * `notebookParser.ts` handles the Databricks *notebook export* format (`# COMMAND ----------` cells)
 * and is the right primitive when the code came out of a workspace. A plain SQL file uploaded from
 * disk has no cells — its natural unit is the statement — and offsets matter here in a way they
 * don't for notebooks: a corrected statement is spliced back into the original file text, so
 * comments, blank lines and formatting outside the changed statement survive untouched.
 */

const SQL_EXTENSIONS = [".sql"];

/** Which files in an uploaded folder count as SQL. Extend here rather than at the call sites. */
export function isSqlFile(path: string): boolean {
  const lower = path.toLowerCase();
  return SQL_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface SqlStatement {
  /** Ordinal of this statement within its file, counting only non-empty statements. */
  index: number;
  /** The statement text with surrounding whitespace and the trailing `;` removed. */
  sql: string;
  /** Offset of `sql` within the file content. */
  start: number;
  /** Offset just past `sql` (before any trailing whitespace or `;`). */
  end: number;
}

type ScanState = "code" | "line-comment" | "block-comment" | "single" | "double" | "backtick";

/**
 * A `GO` alone on its line, optionally with a repeat count (`GO 5`) or a trailing comment. Not SQL
 * at all — it's the batch separator SQL Server's tooling puts between statements, so a `.sql` file
 * from a SQL Server / SSDT project is delimited by `GO` at least as much as by `;`, and a splitter
 * that only knows `;` glues the `GO` onto the front of the next statement and leaves it unparseable.
 */
const GO_LINE_RE = /^[ \t]*go(?:[ \t]+\d+)?[ \t]*(?:--.*)?$/i;

/**
 * The Databricks cell separator, for the same reason `GO` is handled: a `.sql` file exported from a
 * workspace is a *notebook* (`-- Databricks notebook source` on line 1) whose statements are delimited
 * by `-- COMMAND ----------` and, very often, by nothing else — Databricks does not require a trailing
 * `;` on a cell, so a file of a dozen `CREATE OR REPLACE TABLE ... AS SELECT` cells can contain no
 * semicolon at all. Splitting such a file on `;` alone glues every one of those statements into a
 * single span, and `splitSqlTablesByOp` then reports the first CREATE target as reading every table
 * mentioned anywhere in the blob.
 *
 * `notebookParser.ts` is still the right primitive for a notebook *export fetched from a workspace* —
 * it resolves per-cell languages and `%magic`. This is the narrower case of the same format arriving
 * as a file on disk, where byte spans have to survive so a corrected statement can be spliced back.
 * A `-- MAGIC %python` cell is all comment text and so is dropped by `push`, exactly as intended.
 */
const COMMAND_LINE_RE = /^[ \t]*--[ \t]*COMMAND[ \t]+-+[ \t]*$/i;

/**
 * Statements that stay whole no matter how many semicolons they contain: the `;`s inside a procedure
 * or function body separate statements *within* the routine, and splitting there hands out fragments
 * — a bare `END`, a dangling `SET NOCOUNT ON` — while tearing the routine's real
 * `WITH ... SELECT ... INTO` away from the `CREATE PROCEDURE` line that names what it builds. `GO`
 * (or the end of the file) still ends it.
 */
const BLOCK_STATEMENT_RE = /^create\s+(?:or\s+(?:alter|replace)\s+)?(?:proc(?:edure)?|function|trigger|view)\b/i;

/** How far past a statement's start to look for its opening keyword, skipping comments and blanks. */
const KEYWORD_LOOKAHEAD = 400;

/**
 * Whether the statement starting at `from` is one whose body must not be split on `;`. Only the
 * first keyword matters, so the scan is bounded rather than reading the rest of the file.
 */
function startsBlockStatement(content: string, from: number): boolean {
  const to = Math.min(from + KEYWORD_LOOKAHEAD, content.length);
  let i = from;
  for (;;) {
    while (i < to && /\s/.test(content[i])) i++;
    if (content.startsWith("--", i)) {
      const nl = content.indexOf("\n", i);
      i = nl < 0 || nl > to ? to : nl + 1;
    } else if (content.startsWith("/*", i)) {
      const close = content.indexOf("*/", i);
      i = close < 0 || close + 2 > to ? to : close + 2;
    } else {
      return BLOCK_STATEMENT_RE.test(content.slice(i, to));
    }
    if (i >= to) return false;
  }
}

const CLOSING_QUOTE: Partial<Record<ScanState, string>> = {
  single: "'",
  double: '"',
  backtick: "`"
};

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Statement-splits a SQL file on `;` and on `GO` batch separators, ignoring semicolons inside string
 * literals, quoted identifiers, `--` line comments and `/* *\/` block comments — a naive
 * `content.split(";")` breaks on any of those, and on any SQL Server script, which may not use `;`
 * at all. A statement that opens a routine body (`CREATE PROCEDURE` and friends) is kept whole until
 * its `GO`, since the semicolons inside it are internal punctuation rather than boundaries.
 *
 * A comment sitting between two statements belongs to the one that *follows* it, and is inside that
 * statement's span: comments in ETL SQL almost always state the intent of the statement under them,
 * which is exactly what a governance review needs to see. The cost is that a correction to a
 * statement also rewrites its leading comment, so the model is asked to preserve formatting and the
 * UI shows original-vs-corrected side by side. A span holding *only* comments and whitespace (a
 * trailing note after the last statement, or the gap around a `GO`) is dropped rather than emitted as
 * an empty statement; the text stays in the file regardless, since nothing outside the recorded
 * spans is ever rewritten.
 */
export function splitSqlStatements(content: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let state: ScanState = "code";
  let spanStart = 0;
  let inBlockStatement = startsBlockStatement(content, 0);
  let i = 0;

  const push = (spanEnd: number) => {
    const raw = content.slice(spanStart, spanEnd);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const sql = raw.slice(leading, raw.length - trailing);
    if (sql.length === 0 || stripComments(sql).trim().length === 0) return;
    statements.push({ index: statements.length, sql, start: spanStart + leading, end: spanEnd - trailing });
  };

  /** Closes the span at `spanEnd` and opens the next one at `nextStart`. */
  const breakAt = (spanEnd: number, nextStart: number) => {
    push(spanEnd);
    spanStart = nextStart;
    inBlockStatement = startsBlockStatement(content, nextStart);
  };

  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];

    if (state === "code") {
      if (i === 0 || content[i - 1] === "\n") {
        const nl = content.indexOf("\n", i);
        const lineEnd = nl < 0 ? content.length : nl;
        const line = content.slice(i, lineEnd).replace(/\r$/, "");
        if (GO_LINE_RE.test(line) || COMMAND_LINE_RE.test(line)) {
          // The separator line itself belongs to no statement — the next span starts after it.
          breakAt(i, nl < 0 ? content.length : nl + 1);
          i = spanStart;
          continue;
        }
      }

      if (ch === "-" && next === "-") state = "line-comment";
      else if (ch === "/" && next === "*") state = "block-comment";
      else if (ch === "'") state = "single";
      else if (ch === '"') state = "double";
      else if (ch === "`") state = "backtick";
      else if (ch === ";" && !inBlockStatement) {
        breakAt(i, i + 1);
      }
      i += state === "line-comment" || state === "block-comment" ? 2 : 1;
      continue;
    }

    if (state === "line-comment") {
      if (ch === "\n") state = "code";
      i += 1;
      continue;
    }

    if (state === "block-comment") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    const quote = CLOSING_QUOTE[state]!;
    if (ch === "\\") {
      i += 2; // backslash escape, e.g. \' inside a string literal
    } else if (ch === quote && next === quote) {
      i += 2; // doubled quote escapes itself, e.g. '' inside a string literal
    } else if (ch === quote) {
      state = "code";
      i += 1;
    } else {
      i += 1;
    }
  }

  push(content.length);
  return statements;
}

/**
 * Rebuilds a SQL file with corrected statement bodies spliced in at the spans they came from,
 * leaving every other byte — including comments between statements — exactly as uploaded. Replaced
 * back-to-front so that earlier statements' offsets stay valid as later ones change length.
 */
export function applySqlCorrections(
  content: string,
  statements: SqlStatement[],
  correctionsByIndex: Map<number, string>
): string {
  const targets = statements
    .filter((s) => correctionsByIndex.has(s.index))
    .sort((a, b) => b.start - a.start);

  let out = content;
  for (const stmt of targets) {
    const corrected = correctionsByIndex.get(stmt.index)!.trim();
    out = `${out.slice(0, stmt.start)}${corrected}${out.slice(stmt.end)}`;
  }
  return out;
}

/** `etl/silver/load_orders.sql` -> `load_orders.corrected.sql`. */
export function correctedSqlFilename(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() || "query.sql";
  const stem = base.toLowerCase().endsWith(".sql") ? base.slice(0, -4) : base;
  return `${stem || "query"}.corrected.sql`;
}
