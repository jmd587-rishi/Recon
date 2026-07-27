import pkg from "node-sql-parser";

const { Parser } = pkg;
const parser = new Parser();
const SQL_DIALECTS = ["hive", "transactsql", "postgresql", "mysql"] as const;

const WHERE_TEXT_RE = /\bwhere\b([\s\S]*?)(?:\bgroup\s+by\b|\border\s+by\b|\bqualify\b|\blimit\b|$)/i;
const ON_EQUALITY_RE = /\bon\s+([\w.`]+)\s*=\s*([\w.`]+)/i;
const WHERE_EQUALITY_RE = /\bwhere\b[\s\S]*?\b(\w+\.\w+)\s*=\s*(\w+\.\w+)/i;

function cleanIdentifier(ref: string): string {
  return ref.replace(/`/g, "");
}

/**
 * `CREATE TABLE ... AS SELECT ...` / `INSERT INTO ... SELECT ...` aren't parseable as a whole by
 * node-sql-parser in any dialect (same limitation `tableLineage.ts` works around for table
 * extraction), but the inner `SELECT ... WHERE ...` on its own usually is. Isolating it from the
 * first `SELECT` keyword lets the AST path handle CTAS/INSERT-SELECT the same as a bare SELECT.
 */
function innerSelect(sql: string): string | null {
  const idx = sql.search(/\bselect\b/i);
  return idx >= 0 ? sql.slice(idx) : null;
}

function astWherePredicate(sql: string): string | null {
  for (const database of SQL_DIALECTS) {
    try {
      const ast = parser.astify(sql, { database });
      const node = Array.isArray(ast) ? ast[0] : ast;
      const where = (node as { where?: unknown })?.where;
      if (!where) return null;
      return parser.exprToSQL(where as never, { database });
    } catch {
      // try next dialect
    }
  }
  return null;
}

/**
 * Best-effort extraction of the WHERE predicate from a statement that writes a table, so it can be
 * shown to the user and re-run as `WHERE NOT (<predicate>)` to count excluded rows. Tries the AST
 * (on the statement directly, then on just its inner SELECT for CTAS/INSERT-SELECT), then falls
 * back to a plain-text regex span consistent with the rest of the codebase's AST-then-regex style.
 */
export function extractWherePredicate(rawSql: string): string | null {
  const direct = astWherePredicate(rawSql);
  if (direct) return direct;

  const inner = innerSelect(rawSql);
  if (inner) {
    const nested = astWherePredicate(inner);
    if (nested) return nested;
  }

  const match = rawSql.match(WHERE_TEXT_RE);
  if (!match) return null;
  const text = match[1].trim().replace(/;\s*$/, "");
  return text.length > 0 ? text : null;
}

/** Best-effort hint of the column pair a join is keyed on, for display only — not authoritative. */
export function extractJoinKeyHint(rawSql: string): string | null {
  const onMatch = rawSql.match(ON_EQUALITY_RE);
  if (onMatch) return `${cleanIdentifier(onMatch[1])} = ${cleanIdentifier(onMatch[2])}`;

  const whereEq = rawSql.match(WHERE_EQUALITY_RE);
  if (whereEq) return `${cleanIdentifier(whereEq[1])} = ${cleanIdentifier(whereEq[2])}`;

  return null;
}
