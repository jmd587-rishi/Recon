import pkg from "node-sql-parser";
import type { CellLanguage, CodeFix, CodeFixSeverity, ConnectionConfig, FixVerification } from "../types/index.js";
import { runCountStatement } from "./databricksClient.js";
import { extractLineageFacts } from "./tableLineage.js";
import { innerSelect } from "./whereClauseAnalyzer.js";

const { Parser } = pkg;
const parser = new Parser();
const SQL_DIALECTS = ["hive", "transactsql", "postgresql", "mysql"] as const;

/**
 * Anything that could write, drop, or grant. Tested against the text that survives `innerSelect`,
 * so `INSERT INTO t SELECT ...` passes (only the SELECT half remains) while `MERGE INTO ... WHEN
 * MATCHED THEN UPDATE ...` is rejected (the UPDATE trails the SELECT and survives isolation).
 * False positives — a string literal containing one of these words — cost a skipped verification,
 * which is the safe direction to fail.
 */
const WRITE_KEYWORD_RE = /\b(?:insert|update|delete|merge|drop|truncate|create|alter|grant|revoke)\b/i;

/**
 * The only statement shapes isolation is allowed to unwrap. `innerSelect` slices from the first
 * `SELECT`, which *removes* whatever preceded it — so a statement like
 * `DELETE FROM t WHERE id IN (SELECT ...)` would have its destructive verb stripped away before
 * `WRITE_KEYWORD_RE` could ever see it. Whitelisting the leading keyword closes that hole: only
 * shapes whose prefix is safe to discard (a bare read, or the `INSERT INTO ... SELECT` / CTAS
 * wrappers whose prefix is exactly the write being skipped) are unwrapped at all.
 */
const UNWRAPPABLE_LEAD_RE = /^\s*(?:\(|select|with|insert\s+into|insert\s+overwrite|create|replace)\b/i;

/** Alias for the wrapping subquery; namespaced so it can't collide with a table in the statement. */
const WRAPPER_ALIAS = "recon_verify_src";

export interface IsolatedSelect {
  /** The read-only SELECT to count, or null when nothing safe could be isolated. */
  sql: string | null;
  /** Why isolation failed — surfaced to the user verbatim. */
  reason: string;
}

/** True if any supported dialect can build an AST for this statement. */
export function parsesInAnyDialect(sql: string): boolean {
  for (const database of SQL_DIALECTS) {
    try {
      parser.astify(sql, { database });
      return true;
    } catch {
      // try next dialect
    }
  }
  return false;
}

/**
 * Pulls the primary SQL statement out of a cell body. Reuses `extractLineageFacts` (via a synthetic
 * one-cell notebook) rather than re-implementing statement splitting and `spark.sql(...)` scraping,
 * so a corrected cell is read exactly the way the rest of the pipeline reads notebook cells. Prefers
 * the statement that writes a table — that's the one whose row count is the thing being reconciled.
 */
export function primaryStatement(code: string, language: CellLanguage): string | null {
  const facts = extractLineageFacts({ path: "", cells: [{ index: 0, language, source: code }] });
  if (facts.length === 0) return null;
  const writing = facts.find((f) => f.targetTable !== null);
  return (writing ?? facts[0]).rawSql.trim() || null;
}

/**
 * Reduces a cell to a SELECT that can be safely counted. The raw statement is NEVER sent to the
 * warehouse — only the isolated SELECT is, and only after it clears `WRITE_KEYWORD_RE`. That makes
 * verification strictly read-only even though the input is model-authored code.
 */
export function isolateCountableSelect(code: string, language: CellLanguage): IsolatedSelect {
  const statement = primaryStatement(code, language);
  if (!statement) {
    return { sql: null, reason: "no SQL statement found in the cell (DataFrame-only or non-SQL code)" };
  }

  if (!UNWRAPPABLE_LEAD_RE.test(statement)) {
    return { sql: null, reason: "statement is not a read or an INSERT/CREATE-AS-SELECT — not executed" };
  }

  const isolated = innerSelect(statement);
  if (!isolated) return { sql: null, reason: "statement has no SELECT to count" };

  const trimmed = isolated.trim().replace(/;\s*$/, "");
  if (!trimmed) return { sql: null, reason: "statement has no SELECT to count" };

  if (WRITE_KEYWORD_RE.test(trimmed)) {
    return { sql: null, reason: "statement still contains write keywords after isolation — not executed" };
  }

  return { sql: trimmed, reason: "" };
}

/** `SELECT COUNT(*) FROM (<select>) recon_verify_src` — the only shape this module ever executes. */
export function buildCountWrapper(select: string): string {
  return `SELECT COUNT(*) AS cnt FROM (${select}) ${WRAPPER_ALIAS}`;
}

async function countSelect(
  connection: ConnectionConfig,
  warehouseId: string,
  catalog: string,
  schema: string,
  select: string
): Promise<number | null> {
  try {
    return await runCountStatement(connection, warehouseId, buildCountWrapper(select), { catalog, schema });
  } catch {
    return null;
  }
}

/**
 * Re-checks a suggested fix before it is presented as ready to paste. Two read-only checks:
 *
 * 1. **Comparative parse.** Whether the corrected SQL parses is judged *against the original*, not
 *    absolutely — plenty of valid Databricks syntax (`CREATE OR REPLACE TABLE`, `MERGE INTO`,
 *    3-part names) fails every dialect node-sql-parser supports, which is why the rest of the
 *    codebase carries regex fallbacks. Only a regression counts: the original parsed, the corrected
 *    doesn't.
 * 2. **Count.** Both statements are reduced to their SELECT half and run wrapped in `COUNT(*)`, so
 *    the fix's effect on row count is measured rather than assumed.
 *
 * A `failed` verdict never drops the fix — it demotes and flags it, because the model's reasoning
 * may still be sound even when the rewrite isn't runnable here.
 */
export async function verifyFix(params: {
  connection: ConnectionConfig;
  warehouseId: string;
  catalog: string;
  /** Default schema for resolving unqualified table names — the hop's source layer. */
  schema: string;
  language: CellLanguage;
  originalCode: string;
  correctedCode: string;
}): Promise<FixVerification> {
  const { connection, warehouseId, catalog, schema, language, originalCode, correctedCode } = params;

  const originalStatement = primaryStatement(originalCode, language);
  const correctedStatement = primaryStatement(correctedCode, language);

  if (originalStatement && correctedStatement) {
    const originalParses = parsesInAnyDialect(originalStatement);
    const correctedParses = parsesInAnyDialect(correctedStatement);
    if (originalParses && !correctedParses) {
      return {
        status: "failed",
        reason: "the corrected SQL no longer parses in any supported dialect, but the original did",
        originalRows: null,
        correctedRows: null,
        delta: null
      };
    }
  }

  const correctedSelect = isolateCountableSelect(correctedCode, language);
  if (!correctedSelect.sql) {
    return {
      status: "unverified",
      reason: `row counts not run — ${correctedSelect.reason}`,
      originalRows: null,
      correctedRows: null,
      delta: null
    };
  }

  const originalSelect = isolateCountableSelect(originalCode, language);
  const [originalRows, correctedRows] = await Promise.all([
    originalSelect.sql ? countSelect(connection, warehouseId, catalog, schema, originalSelect.sql) : Promise.resolve(null),
    countSelect(connection, warehouseId, catalog, schema, correctedSelect.sql)
  ]);

  if (originalRows !== null && correctedRows === null) {
    return {
      status: "failed",
      reason: "the corrected query failed to run against the warehouse, but the original ran",
      originalRows,
      correctedRows: null,
      delta: null
    };
  }

  if (correctedRows === null) {
    return {
      status: "unverified",
      reason: "neither query could be counted — table names may be unqualified or the warehouse rejected them",
      originalRows: null,
      correctedRows: null,
      delta: null
    };
  }

  if (originalRows === null) {
    return {
      status: "unverified",
      reason: "the corrected query ran, but the original couldn't be counted for comparison",
      originalRows: null,
      correctedRows,
      delta: null
    };
  }

  const delta = correctedRows - originalRows;
  return {
    status: "verified",
    reason:
      delta === 0
        ? "the fix returns the same number of rows as the original"
        : `the fix ${delta > 0 ? "adds" : "removes"} ${Math.abs(delta).toLocaleString("en-US")} rows vs the original`,
    originalRows,
    correctedRows,
    delta
  };
}

const STATUS_RANK: Record<FixVerification["status"], number> = { verified: 0, unverified: 1, failed: 2 };
const SEVERITY_RANK: Record<CodeFixSeverity, number> = { error: 0, warning: 1, info: 2 };

/** The largest row movement measured for a fix, from its verification or its evidence. */
function measuredImpact(fix: CodeFix): number {
  if (fix.verification?.delta != null) return Math.abs(fix.verification.delta);
  const deltas = [
    ...(fix.evidence?.rowCounts ?? []).map((r) => r.delta),
    ...(fix.evidence?.filters ?? []).map((f) => f.excludedRows)
  ].filter((d): d is number => d !== null);
  return deltas.length ? Math.max(...deltas.map(Math.abs)) : 0;
}

/**
 * Orders fixes by how much they can be trusted and how much they move: verified first, then by the
 * largest measured row impact, then by severity. Without a warehouse every fix has a null
 * verification and zero measured impact, so this degrades to severity order rather than the model's
 * arbitrary emission order.
 */
export function rankFixes(fixes: CodeFix[]): CodeFix[] {
  return [...fixes].sort((a, b) => {
    const status = STATUS_RANK[a.verification?.status ?? "unverified"] - STATUS_RANK[b.verification?.status ?? "unverified"];
    if (status !== 0) return status;
    const impact = measuredImpact(b) - measuredImpact(a);
    if (impact !== 0) return impact;
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  });
}
