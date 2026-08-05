import type { LayerRef, LocalReconciliationSuite, ReconCheck, ReconCheckKind, ReconScript } from "../types/index.js";
import type { LocalProject } from "./localProject.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  envInt,
  LlmConfigError,
  LlmTimeoutError,
  MAX_CUSTOM_CHECKS_PER_TARGET,
  type ReconLlmScript,
  type ReconTargetPrompt,
  writeReconciliationScripts
} from "./llmClient.js";
import {
  assembleHop,
  assembleScript,
  gatherReconciliationFacts,
  lineageStatements,
  type ReconHopFacts,
  type ReconTargetFacts,
  summarizeSuite,
  templateChecks
} from "./reconciliationScripts.js";
import {
  collectCteBodies,
  type ColumnFacts,
  type ColumnKind,
  columnKindOf,
  columnKnowledge,
  declaredKind,
  inferExpressionKind,
  isEmittableIdentifier,
  parenDepths,
  resolveTableRef,
  stripStringLiterals,
  tableBindings
} from "./sqlColumns.js";
import { type LineageFact, stripSqlComments } from "./tableLineage.js";

/**
 * Adds the checks only a reader of the transformation could write, on top of the ones Recon derives.
 *
 * The division of labour is the point. The six standard checks — row counts, measure totals, missing
 * and orphan keys, duplicates, nulls — are already known exactly from the declared columns, so
 * `reconciliationScripts.templateChecks` writes them: instantly, for free, and with no way to name a
 * column the table hasn't got. What a template cannot know is what *this* pipeline can get wrong — a
 * monthly grain that must not fan out, a `LAG` that needs its partition complete, an
 * `ISNULL(revenue, 0)` that moves a total — so that, and only that, is what the model is asked for.
 *
 * Asking for less is also what makes this finish. The earlier version asked one call to author six
 * tables' worth of complete scripts and routinely ran past the 120s ceiling with nothing at all to
 * show for it; here each call covers two tables and writes at most a handful of short queries, the
 * calls run concurrently, and a call that still fails costs only its own tables' extra checks — the
 * script itself is already written and runnable before the model is consulted.
 */

/**
 * Target tables per call. One by default: a prompt then holds exactly one table's lineage
 * neighbourhood, and two unrelated tables never share the context — or the budget — merely because
 * they were adjacent in a list. The calls still run concurrently, so this costs little wall-clock.
 */
const MAX_TARGETS_PER_CALL = envInt("RECON_TARGETS_PER_CALL", 1, 1, 6);
/** Calls in flight at once. The whole suite should cost roughly one call's wall-clock, not N. */
const RECON_CONCURRENCY = envInt("RECON_CONCURRENCY", 4, 1, 8);
/** Per-call ceiling. Generous, because the prompts are large and a retry costs another one of these. */
const RECON_TIMEOUT_MS = envInt("RECON_LLM_TIMEOUT_MS", 240_000, 10_000, 900_000);
/** Output budget per target. Enough for several checks written out in full rather than cut short. */
const MAX_OUTPUT_TOKENS_PER_TARGET = envInt("RECON_MAX_OUTPUT_TOKENS", 6000, 400, 32_000);
/**
 * How much code the model is shown. The defaults are set so that a real warehouse's largest
 * transformation goes in *whole* — a check written against the first half of a procedure is a guess
 * about the half it could not see, and a wrong check costs far more than a slow one. Measured against
 * a production SSDT project: largest single statement 13 KB, largest target 25 KB of its own code
 * with 37 KB of upstream chain behind it. Everything here is env-tunable; raise it further rather
 * than let a transformation be truncated.
 */
const MAX_SQL_CHARS = envInt("RECON_SQL_CHARS_PER_STATEMENT", 20_000, 1000, 200_000);
/** Budget for the statements that build the target itself — the code the checks are about. */
const MAX_SQL_CHARS_PER_TARGET = envInt("RECON_SQL_CHARS_PER_TARGET", 40_000, 1000, 400_000);
/**
 * Separate budget for the upstream chain, so context can never crowd out the target's own code —
 * which it would, given one procedure upstream can be longer than everything downstream of it.
 */
const MAX_UPSTREAM_CHARS = envInt("RECON_UPSTREAM_CHARS", 50_000, 0, 400_000);
/** How far up the lineage the context reaches. Three spans raw -> stage -> transformation -> mart. */
const UPSTREAM_HOPS = envInt("RECON_UPSTREAM_HOPS", 3, 0, 8);
/**
 * Attempts after the first for a call that fails. A timeout, a rate limit or a truncated answer is a
 * transient condition, and letting it silently cost a table its checks is the difference between a
 * suite you can trust and one you have to spot-check.
 */
const RECON_RETRIES = envInt("RECON_RETRIES", 3, 0, 10);
/** Backoff before the first retry, doubling each time. */
const RETRY_BACKOFF_MS = envInt("RECON_RETRY_BACKOFF_MS", 2000, 0, 60_000);
/**
 * Columns listed per table before the list is cut. High enough that a real report table goes in
 * whole: a truncated list is what makes the model reach for a name it was never shown.
 */
const MAX_COLUMNS_LISTED = envInt("RECON_MAX_COLUMNS_LISTED", 400, 20, 2000);

/**
 * One table's columns as the prompt states them, from everything the folder says about it.
 *
 * A table the project only reads — the first layer, landed by something outside the folder — has no
 * DDL and no select list building it, and used to reach the model as "unknown", which is the input
 * that gets a column invented. The columns other statements are seen selecting off it are named here
 * instead, marked as the partial list they are.
 */
function columnList(facts: ColumnFacts, table: string): { table: string; columns: string; note: string } | null {
  const key = table.toLowerCase();
  const entry = facts.index.get(key);
  // A name no portable script can write is a name the model must not be offered — see
  // `isEmittableIdentifier`. It is still counted as a gap, so the list reads as partial.
  const declared = (entry?.columns ?? []).filter((c) => isEmittableIdentifier(c.name));
  const withheld = (entry?.columns.length ?? 0) - declared.length;
  const declaredNames = new Set(declared.map((c) => c.name));
  const observed = Array.from(facts.usage.get(key) ?? [])
    .filter((name) => !declaredNames.has(name) && isEmittableIdentifier(name))
    .sort();
  if (declared.length === 0 && observed.length === 0) return null;

  const all = [
    // The inferred kind matters as much as a declared type: a `date_key` that is really a hashed
    // string must not be joined to a `date_key` that is really a date.
    ...declared.map((c) => (c.dataType ? `${c.name} ${c.dataType}` : c.kind !== "other" ? `${c.name} (${c.kind})` : c.name)),
    ...observed.map((name) => `${name} (seen used, type unknown)`)
  ];
  const shown = all.slice(0, MAX_COLUMNS_LISTED);
  const partial = declared.length === 0 || (entry?.incomplete ?? false) || observed.length > 0 || withheld > 0;

  const note = [
    declared.length === 0
      ? "no DDL in this folder defines it — these are the columns other statements read off it"
      : entry!.origin === "ddl"
        ? "from CREATE TABLE"
        : "inferred from the select list that builds it",
    partial ? "PARTIAL: there may be more columns, but use no name that is not on this list" : "complete",
    withheld > 0 ? `${withheld} column${withheld === 1 ? "" : "s"} withheld — the name needs quoting` : "",
    shown.length < all.length ? `${all.length - shown.length} more not shown` : ""
  ]
    .filter(Boolean)
    .join(", ");

  return { table, columns: shown.join(", "), note };
}

/**
 * Renders one target's grounding for the prompt.
 *
 * `baseChecks` are the checks already written for this table, listed by title so the model doesn't
 * spend its answer — and the caller's wall-clock — reproducing them.
 */
function promptFor(
  facts: ReconTargetFacts,
  columns: ColumnFacts,
  baseChecks: ReconCheck[],
  allFacts: LineageFact[]
): ReconTargetPrompt {
  // The target's own code first and on its own budget, then the chain it was built from — nearest
  // first, so what runs out is the most distant context rather than the code under review.
  const transformationSql: ReconTargetPrompt["transformationSql"] = [];
  const chain = lineageStatements(allFacts, facts.target, UPSTREAM_HOPS);
  let ownBudget = MAX_SQL_CHARS_PER_TARGET;
  let upstreamBudget = MAX_UPSTREAM_CHARS;

  for (const { fact, distance, builds } of chain) {
    const own = distance === 0;
    const budget = own ? ownBudget : upstreamBudget;
    if (budget <= 0) continue;

    const sql = fact.rawSql.slice(0, Math.min(MAX_SQL_CHARS, budget));
    if (own) ownBudget -= sql.length;
    else upstreamBudget -= sql.length;

    transformationSql.push({
      path: fact.notebookPath,
      statementIndex: fact.cellIndex,
      builds,
      upstream: !own,
      sql
    });
  }

  return {
    targetTable: facts.target,
    sourceTables: facts.sources,
    sourceUsage: [
      ...facts.perSource.map((entry) =>
        entry.role === "driver"
          ? `${entry.source}: it supplies the target's rows` +
            (entry.grainColumns.length > 0
              ? `, grouped by ${entry.grainColumns.join(", ")} — so the target should have one row per distinct combination of those`
              : entry.grainChanged
                ? ", and the transformation groups them, so the target has fewer rows by design"
                : ", one for one")
          : `${entry.source}: it is joined in for its columns only — its own row count has no relationship to the target's, so do not compare them`
      ),
      ...facts.incidentalSources.map(
        (source) =>
          `${source}: it is read, but its rows never reach the target (a lookup of a single value, or a separate statement) — write no check comparing it with the target`
      )
    ],
    columns: [facts.target, ...facts.sources].flatMap((table) => {
      const list = columnList(columns, table);
      return list
        ? [list]
        : [
            {
              table,
              columns: "(unknown — nothing in the folder describes this table or reads a column off it)",
              note: "write NO check that names a column of this table"
            }
          ];
    }),
    keyHint:
      facts.key.columns.length > 0
        ? `${facts.key.columns.join(", ")} (${facts.key.confidence === "declared" ? "declared PRIMARY KEY" : "inferred from naming, treat as a hypothesis"})`
        : "none found — say so rather than inventing one",
    joinHints: facts.perSource
      .filter((p) => p.join.columns.length > 0)
      .map((p) => ({ source: p.source, columns: p.join.columns })),
    measureHint: facts.measureColumns.length > 0 ? facts.measureColumns.join(", ") : "none found on both sides",
    categoryHint: facts.categoryColumns.length > 0 ? facts.categoryColumns.join(", ") : "none found on both sides",
    filterHint: facts.knownFilters,
    existingChecks: baseChecks.map((c) => c.title),
    transformationSql
  };
}

// ---- checking what the model wrote against what the project actually has ----

const TABLE_TOKEN_RE = /[A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)*/g;

/**
 * Whether a check names at least one table it was given.
 *
 * A cheap, low-false-positive guard against a check written for a table that isn't in this project
 * at all: real reconciliation SQL for `silver.orders` mentions `silver.orders`.
 */
function referencesKnownTable(sql: string, tables: string[]): boolean {
  const lower = sql.toLowerCase();
  const wanted = new Set(tables.map((t) => t.toLowerCase()));
  const bare = new Set(tables.map((t) => t.toLowerCase().split(".").pop()!));

  for (const token of lower.match(TABLE_TOKEN_RE) ?? []) {
    if (wanted.has(token) || bare.has(token)) return true;
  }
  return false;
}

/**
 * Words that are SQL rather than column names. Over-listing is safe: every word here is one the
 * scanner below declines to judge, so the cost is a check that goes out unverified, never a good
 * check dropped.
 */
const SQL_WORDS = new Set([
  "select", "distinct", "all", "from", "where", "group", "by", "order", "having", "join", "inner",
  "left", "right", "full", "outer", "cross", "lateral", "natural", "semi", "anti", "apply", "on",
  "using", "and", "or", "not", "in", "exists", "between", "like", "ilike", "rlike", "is", "null",
  "case", "when", "then", "else", "end", "as", "union", "except", "intersect", "asc", "desc",
  "with", "over", "partition", "rows", "range", "unbounded", "preceding", "following", "current",
  "row", "values", "into", "insert", "update", "delete", "set", "matched", "merge", "top", "limit",
  "offset", "fetch", "next", "first", "only", "true", "false", "unknown", "escape", "collate",
  "interval", "qualify", "window", "pivot", "unpivot", "for", "default", "primary", "key", "table",
  "view", "create", "drop", "alter", "cast", "convert", "nulls", "last", "within", "filter",
  // type names, which appear bare inside CAST/CONVERT
  "varchar", "nvarchar", "char", "nchar", "text", "int", "integer", "bigint", "smallint", "tinyint",
  "decimal", "numeric", "float", "real", "double", "precision", "money", "bit", "boolean", "date",
  "datetime", "datetime2", "timestamp", "time", "string", "long"
]);

/** What is wrong with a check, in the terms the note shown to the user is written in. */
export type CheckProblemKind =
  | "unknown_column"
  | "unverifiable_column"
  | "ambiguous_column"
  | "non_numeric_total"
  | "misplaced_function"
  | "predicate_as_value"
  | "unbalanced_sql"
  | "type_clash"
  | "returns_a_count"
  | "vacuous_check";

export interface CheckProblem {
  kind: CheckProblemKind;
  /** `silver.orders.total_amount`, or the bare column for an ambiguous one. */
  detail: string;
}

/** Clause keywords that own everything written after them, until the next one at their own depth. */
const CLAUSE_RE = /\b(?:select|from|where|group|having|order|on|qualify|set)\b/gi;

/**
 * Which clause the text at `at` sits in.
 *
 * Scanning left while tracking the shallowest depth reached is what makes a nested query answer for
 * itself: `WHERE x > (SELECT SUM(y) FROM t)` puts the `SUM` inside the subquery's SELECT, where it is
 * legal, while `WHERE SUM(x) > 0` leaves it in the WHERE, where it is not. Depth alone can't tell
 * those apart — the `SUM` in `WHERE DATEFROMPARTS(YEAR(MAX(z) OVER ()), 12, 1)` is three parens deep
 * and still belongs to the WHERE.
 */
function enclosingClause(sql: string, depths: number[], at: number): string | null {
  const clauses: { word: string; at: number }[] = [];
  CLAUSE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLAUSE_RE.exec(sql)) && match.index < at) {
    clauses.push({ word: match[0].toLowerCase(), at: match.index });
  }

  let shallowest = depths[at] ?? 0;
  for (let i = clauses.length - 1; i >= 0; i--) {
    const clause = clauses[i];
    // Everything between the keyword and `at` has to stay inside the keyword's own parenthesis.
    for (let j = clause.at; j < at; j++) shallowest = Math.min(shallowest, depths[j]);
    if (depths[clause.at] === shallowest) return clause.word;
  }
  return null;
}

/** Aggregates, whose clause placement T-SQL is strict about. */
const AGGREGATE_RE = /\b(sum|avg|min|max|count|stdev|stdevp|var|varp)\s*\(/gi;
/** A window function, legal only in a SELECT list or an ORDER BY. */
const WINDOW_RE = /\bover\s*\(/gi;

/**
 * Placements of an aggregate or a window function that no engine will run.
 *
 * Both are ordinary mistakes to make when writing a check from the outside — "flag the rows where the
 * total differs" reads naturally as `WHERE SUM(a) <> SUM(b)`, and it is `Msg 147`; "compare against
 * the latest month" reads as `WHERE d >= MAX(d) OVER ()`, and it is `Msg 4108`. Neither is a wrong
 * answer, and neither is caught by checking column names, so they are checked for here.
 */
function misplacedFunctions(sql: string, depths: number[]): CheckProblem[] {
  const problems: CheckProblem[] = [];

  WINDOW_RE.lastIndex = 0;
  let window: RegExpExecArray | null;
  while ((window = WINDOW_RE.exec(sql))) {
    const clause = enclosingClause(sql, depths, window.index);
    if (clause !== null && clause !== "select" && clause !== "order") {
      problems.push({ kind: "misplaced_function", detail: `a window function (OVER) in the ${clause.toUpperCase()} clause` });
    }
  }

  AGGREGATE_RE.lastIndex = 0;
  let aggregate: RegExpExecArray | null;
  while ((aggregate = AGGREGATE_RE.exec(sql))) {
    const clause = enclosingClause(sql, depths, aggregate.index);
    if (clause === "where" || clause === "on") {
      problems.push({
        kind: "misplaced_function",
        detail: `${aggregate[1].toUpperCase()}(…) in the ${clause.toUpperCase()} clause`
      });
    }
  }

  return problems;
}

/**
 * What is left open at the end of a statement — a quote, a bracket, a comment, a parenthesis.
 *
 * This is the cheapest and most important guard of the lot, because a single stray `'` does not
 * break one check, it breaks *everything after it in the file*: the lexer flips, every later string
 * literal is read as code and every keyword as a string, and the errors surface hundreds of lines
 * away with no relation to the cause. One character can cost a 2,500-line script. Nothing that does
 * not lex may be written out, whatever else is right about it.
 */
export function unbalancedSql(sql: string): string | null {
  let parens = 0;
  let comment = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (comment > 0) {
      // T-SQL nests block comments, so the depth has to be counted rather than the first `*/` taken.
      if (ch === "/" && sql[i + 1] === "*") comment++;
      else if (ch === "*" && sql[i + 1] === "/") comment--;
      else {
        i++;
        continue;
      }
      i += 2;
      continue;
    }

    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      comment = 1;
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === ch) {
          // A doubled quote escapes itself: `'it''s'` is one literal.
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (!closed) return ch === "'" ? "an unclosed string literal" : "an unclosed quoted identifier";
      i = j;
      continue;
    }

    if (ch === "[") {
      const close = sql.indexOf("]", i + 1);
      if (close < 0) return "an unclosed [ identifier";
      i = close + 1;
      continue;
    }

    if (ch === "(") parens++;
    else if (ch === ")" && --parens < 0) return "a closing parenthesis with nothing to close";
    i++;
  }

  if (comment > 0) return "an unclosed /* comment";
  if (parens > 0) return `${parens} unclosed parenthes${parens === 1 ? "is" : "es"}`;
  return null;
}

/** Matching parenthesis offsets, both ways round. */
function parenPairs(sql: string): { open: Map<number, number>; close: Map<number, number> } {
  const stack: number[] = [];
  const open = new Map<number, number>();
  const close = new Map<number, number>();

  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "(") stack.push(i);
    else if (sql[i] === ")") {
      const at = stack.pop();
      if (at !== undefined) {
        open.set(i, at);
        close.set(at, i);
      }
    }
  }

  return { open, close };
}

/**
 * Whether a parenthesised group holds a condition rather than a value.
 *
 * A scalar subquery and a `CASE` both *are* values however they are written inside, so they are
 * excluded; what is left is a bare condition, which only an engine with a boolean type can use as an
 * operand.
 */
function looksLikePredicate(text: string): boolean {
  const inner = text.trim();
  if (/^(?:select|case)\b/i.test(inner)) return false;
  return /\bis\s+(?:not\s+)?null\b/i.test(inner) || /(?:<=|>=|<>|!=|=|<|>)/.test(inner);
}

const COMPARISON_RE = /<=|>=|<>|!=|=|<|>/g;

/**
 * Comparisons whose operand is a condition — `(a IS NULL) <> (b IS NULL)`.
 *
 * Natural to write, and a neat way to say "these two disagree", but SQL Server has no boolean data
 * type: a predicate cannot be an operand, and this is `Incorrect syntax near '<'` before a single row
 * is read. Spark SQL accepts it, which is exactly why it needs catching here — the scripts have to run
 * on both. The portable form is `CASE WHEN a IS NULL THEN 1 ELSE 0 END <> CASE WHEN b IS NULL THEN 1
 * ELSE 0 END`.
 */
function predicateOperands(sql: string): CheckProblem[] {
  const { open, close } = parenPairs(sql);
  const problems: CheckProblem[] = [];
  const seen = new Set<string>();

  COMPARISON_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMPARISON_RE.exec(sql))) {
    for (const side of ["left", "right"] as const) {
      let group: string | null = null;

      if (side === "left") {
        let i = match.index - 1;
        while (i >= 0 && /\s/.test(sql[i])) i--;
        const at = sql[i] === ")" ? open.get(i) : undefined;
        if (at !== undefined) group = sql.slice(at + 1, i);
      } else {
        let j = match.index + match[0].length;
        while (j < sql.length && /\s/.test(sql[j])) j++;
        const at = sql[j] === "(" ? close.get(j) : undefined;
        if (at !== undefined) group = sql.slice(j + 1, at);
      }

      if (group === null || !looksLikePredicate(group)) continue;
      const detail = `(${group.trim().slice(0, 60)}) used as a value in a comparison`;
      if (seen.has(detail)) continue;
      seen.add(detail);
      problems.push({ kind: "predicate_as_value", detail });
    }
  }

  return problems;
}

/**
 * A check whose outermost select list is nothing but aggregates, with no `GROUP BY`.
 *
 * Such a statement returns exactly one row holding a number, and the bundle counts the rows a check
 * returns — so it reports `1`, meaning "this situation exists", in the same column where every other
 * check reports how many rows are affected. Two different meanings in one column is worse than a
 * missing check: `1` reads as one bad row. Counting is Recon's job; a check returns the rows.
 */
function returnsACount(sql: string, depths: number[]): boolean {
  const select = /\bselect\b/i.exec(sql);
  if (!select) return false;
  const from = /\bfrom\b/i.exec(sql);
  if (!from || from.index < select.index) return false;

  // Only the outer list and the outer GROUP BY: a subquery's own aggregates and grouping sit deeper
  // and say nothing about the shape of what this statement returns.
  const base = depths[select.index] ?? 0;
  const groupBy = /\bgroup\s+by\b/gi;
  let group: RegExpExecArray | null;
  while ((group = groupBy.exec(sql))) {
    if ((depths[group.index] ?? base) === base) return false;
  }

  const list = sql.slice(select.index + select[0].length, from.index);
  const outer = [...list]
    .map((ch, i) => ((depths[select.index + select[0].length + i] ?? base) === base ? ch : " "))
    .join("");

  const items = outer.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) return false;
  return items.every((item) => /^(?:sum|count|count_big|avg|min|max)\s*\(/i.test(item.replace(/^distinct\s+/i, "")));
}

/** Words that end an operand, so a comparison's right-hand side stops where the expression does. */
const OPERAND_BOUNDARY = new Set([
  "and", "or", "then", "when", "else", "end", "group", "order", "having", "union", "except",
  "intersect", "from", "where", "on", "as", "is", "not", "in", "like", "between", "qualify"
]);

/** The expression to the right of a comparison, up to the next boundary at its own depth. */
function rightOperand(sql: string, from: number): string {
  let depth = 0;
  let word = "";
  let out = "";

  for (let i = from; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (ch === "," || ch === ";")) break;

    if (depth === 0 && /[A-Za-z_]/.test(ch)) word += ch;
    else if (word.length > 0) {
      if (OPERAND_BOUNDARY.has(word.toLowerCase())) return out.slice(0, out.length - word.length).trim();
      word = "";
    }
    out += ch;
  }

  return OPERAND_BOUNDARY.has(word.toLowerCase()) ? out.slice(0, out.length - word.length).trim() : out.trim();
}

/** The expression to the left of a comparison: a column, or a call with its name. */
function leftOperand(sql: string, to: number): string {
  let i = to - 1;
  while (i >= 0 && /\s/.test(sql[i])) i--;

  if (sql[i] === ")") {
    let depth = 0;
    let j = i;
    for (; j >= 0; j--) {
      if (sql[j] === ")") depth++;
      else if (sql[j] === "(" && --depth === 0) break;
    }
    let k = j - 1;
    while (k >= 0 && /\s/.test(sql[k])) k--;
    while (k >= 0 && /[\w$#]/.test(sql[k])) k--;
    return sql.slice(k + 1, i + 1);
  }

  const end = i + 1;
  while (i >= 0 && /[\w.$#]/.test(sql[i])) i--;
  return sql.slice(i + 1, end);
}

/**
 * Comparisons between a date and a number.
 *
 * `WHERE d.month <> YEAR(s.month) * 100 + MONTH(s.month)` is the shape: written by someone assuming
 * `month` holds `202401`, against a table where it holds a date. SQL Server refuses outright —
 * *"Operand type clash: date is incompatible with int"* — and the column types Recon inferred from the
 * code are exactly what says so in advance.
 *
 * Only this pair is judged, and deliberately: SQL Server converts a string to a date implicitly, so
 * `d.month = '2024-01-01'` is legal and must not be dropped. Date against number is the comparison it
 * will not make.
 */
function typeClashes(
  sql: string,
  facts: ColumnFacts,
  bound: { alias: string | null; table: string }[]
): CheckProblem[] {
  const problems: CheckProblem[] = [];
  const seen = new Set<string>();

  const kindOfOperand = (text: string): ColumnKind => {
    const trimmed = text.trim();
    const qualified = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(trimmed);
    if (qualified) {
      const name = qualified[1].toLowerCase();
      const owner = bound.find((b) => (b.alias ?? b.table) === name || b.table.endsWith(`.${name}`));
      return owner ? columnKindOf(facts.index, owner.table, qualified[2].toLowerCase()) : "other";
    }
    if (/^[A-Za-z_]\w*$/.test(trimmed) && bound.length === 1) {
      return columnKindOf(facts.index, bound[0].table, trimmed.toLowerCase());
    }
    return inferExpressionKind(trimmed).kind;
  };

  COMPARISON_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMPARISON_RE.exec(sql))) {
    const left = kindOfOperand(leftOperand(sql, match.index));
    const right = kindOfOperand(rightOperand(sql, match.index + match[0].length));

    const clash =
      (left === "date" && (right === "numeric" || right === "boolean")) ||
      (right === "date" && (left === "numeric" || left === "boolean"));
    if (!clash) continue;

    const detail = `a ${left} compared with a ${right}: ${sql.slice(Math.max(0, match.index - 30), match.index + 40).trim()}`;
    if (seen.has(detail)) continue;
    seen.add(detail);
    problems.push({ kind: "type_clash", detail });
  }

  return problems;
}

/**
 * Checks that test a column against the very constant the code assigns it.
 *
 * `WHERE t.customer_region <> 'TBC'` against a transformation whose select list reads
 * `'TBC' AS customer_region` can only ever return nothing. It passes, and its passing is read as
 * health — when what it has actually confirmed is that a placeholder is universally applied. A check
 * that cannot fail is worse than no check, because it is counted among the ones that did.
 *
 * The hardcoding itself is worth reporting, and `targetFacts` reports it as a note, deterministically
 * and without needing anyone to think of writing a check for it.
 */
function vacuousOnConstant(
  sql: string,
  facts: ColumnFacts,
  bound: { alias: string | null; table: string }[]
): CheckProblem[] {
  const problems: CheckProblem[] = [];

  for (const entry of bound) {
    for (const column of facts.index.get(entry.table)?.columns ?? []) {
      if (!column.constant) continue;
      const name = entry.alias ?? entry.table.split(".").pop()!;
      const literal = column.constant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const test = new RegExp(`\\b${name}\\s*\\.\\s*${column.name}\\s*(?:=|<>|!=)\\s*${literal}`, "i");
      if (!test.test(sql)) continue;
      problems.push({
        kind: "vacuous_check",
        detail: `${entry.table}.${column.name} is set to ${column.constant} by the code, so testing it against ${column.constant} can never fail`
      });
    }
  }

  return problems;
}

/** A total taken over one plain column — the only shape whose operand type can be checked. */
const TOTAL_RE = /\b(?:sum|avg)\s*\(\s*(?:distinct\s+)?([A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)*)\s*\)/gi;

/** Identifiers the statement defines itself, so they name no table column and can't be judged. */
function definedNames(sql: string, bindings: { alias: string | null }[]): Set<string> {
  const defined = new Set<string>(Array.from(collectCteBodies(sql).keys()));

  for (const binding of bindings) {
    if (binding.alias) defined.add(binding.alias);
  }
  // Result aliases and CTE names (`... AS total`, `WITH totals AS (`), plus derived-table aliases
  // written without AS (`) x`). Over-collecting here only means judging less.
  for (const re of [/\bas\s+([A-Za-z_]\w*)/gi, /\)\s*(?:as\s+)?([A-Za-z_]\w*)/gi]) {
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(sql))) defined.add(match[1].toLowerCase());
  }

  return defined;
}

/**
 * Every bare word in the statement's own scope that could be an unqualified column reference.
 *
 * Only paren-depth 0 is judged. A name inside a subquery resolves against that subquery's tables,
 * which this scanner has no way to know, and reading it against the outer query's would call a
 * perfectly good `(SELECT AVG(amount) FROM silver.orders)` ambiguous.
 */
function bareColumnRefs(sql: string, defined: Set<string>, depths: number[]): string[] {
  const found: string[] = [];
  const wordRe = /[A-Za-z_]\w*/g;
  let match: RegExpExecArray | null;

  while ((match = wordRe.exec(sql))) {
    const word = match[0].toLowerCase();
    if (SQL_WORDS.has(word) || defined.has(word) || depths[match.index] > 0) continue;

    let before = match.index - 1;
    while (before >= 0 && /\s/.test(sql[before])) before--;
    // `t.month` is qualified, and `month.x` is a qualifier rather than a column.
    if (sql[before] === ".") continue;

    let after = wordRe.lastIndex;
    while (after < sql.length && /\s/.test(sql[after])) after++;
    if (sql[after] === "(" || sql[after] === ".") continue;

    found.push(word);
  }

  return found;
}

/**
 * Everything about a model-written check that the project's own SQL proves wrong, in the two ways a
 * generated check actually fails when you run it.
 *
 * **Invalid column** — the check names a column of a table that hasn't got it. Judged only where the
 * project describes the table completely, from DDL or a select list with no unexpanded `*`; where it
 * only knows *some* of a table's columns, a name missing from that list proves nothing and is left
 * alone. The third case is a table the project describes not at all: a qualified reference to one is
 * neither provable nor disprovable, and is dropped rather than shipped — an unverifiable column is
 * exactly what a hallucination looks like, and one of them fails the whole file it lands in.
 *
 * **Ambiguous column** — a column named with no table alias in a statement where two of the joined
 * tables both have it. Perfectly plausible SQL to read and a hard error to run, and the derived
 * checks never produce one because they qualify everything, so this is a check on the model's SQL
 * specifically. Positive evidence is enough to judge it: the column list needn't be complete for two
 * tables demonstrably having the same column to make an unqualified use of it ambiguous.
 */
export function checkProblems(sql: string, facts: ColumnFacts, tables: string[]): CheckProblem[] {
  // First and on the raw text: stripping literals and comments from SQL that does not lex would hide
  // the very thing being looked for, and nothing else below means anything if the quotes are wrong.
  const unbalanced = unbalancedSql(sql);
  if (unbalanced) return [{ kind: "unbalanced_sql", detail: unbalanced }];

  const cleaned = stripStringLiterals(stripSqlComments(sql));
  // Quoting characters carry no meaning to the scanner, and dropping them keeps `t.[month]` a
  // qualified reference rather than a bare word preceded by a bracket.
  const scan = cleaned.replace(/[`[\]"]/g, "");

  const depths = parenDepths(scan);
  const problems = new Map<string, CheckProblem>();
  const report = (kind: CheckProblemKind, detail: string) => problems.set(`${kind}:${detail}`, { kind, detail });

  // Independent of what the tables are: these are about the shape of the statement itself.
  for (const problem of misplacedFunctions(scan, depths)) report(problem.kind, problem.detail);
  for (const problem of predicateOperands(scan)) report(problem.kind, problem.detail);
  if (returnsACount(scan, depths)) {
    report("returns_a_count", "its select list is only aggregates, so it returns one row holding a number");
  }

  const bindings = tableBindings(scan);
  const bound = bindings.flatMap((binding) => {
    const table = resolveTableRef(binding.ref, tables);
    if (!table) return [];
    return [{ ...binding, table, knowledge: columnKnowledge(facts, table) }];
  });
  if (bound.length === 0) return Array.from(problems.values());

  for (const entry of bound) {
    const names = entry.alias ? [entry.alias] : [entry.table, entry.table.split(".").pop()!];
    for (const name of names) {
      const useRe = new RegExp(`\\b${name.replace(/[.$#]/g, "\\$&")}\\s*\\.\\s*([A-Za-z_]\\w*)`, "gi");
      let use: RegExpExecArray | null;
      while ((use = useRe.exec(scan))) {
        const column = use[1].toLowerCase();
        if (entry.knowledge.names.has(column)) continue;
        if (entry.knowledge.complete) report("unknown_column", `${entry.table}.${column}`);
        else if (entry.knowledge.names.size === 0) report("unverifiable_column", `${entry.table}.${column}`);
      }
    }
  }

  // `SUM(o.status)` is not a wrong number, it is `Msg 8117` and the end of the file. Only a declared
  // type can rule a column out — a select-list column states none, and is left to `measureExpr`.
  TOTAL_RE.lastIndex = 0;
  let total: RegExpExecArray | null;
  while ((total = TOTAL_RE.exec(scan))) {
    const [qualifier, column] = total[1].includes(".")
      ? [total[1].slice(0, total[1].lastIndexOf(".")).toLowerCase(), total[1].slice(total[1].lastIndexOf(".") + 1)]
      : [null, total[1]];
    const owner = qualifier
      ? bound.find((entry) => (entry.alias ?? entry.table) === qualifier || entry.table.endsWith(`.${qualifier}`))
      : bound.length === 1
        ? bound[0]
        : undefined;
    if (!owner) continue;

    const kind = declaredKind(facts, owner.table, column);
    if (kind !== null && kind !== "numeric") {
      report("non_numeric_total", `${owner.table}.${column.toLowerCase()} (${kind})`);
    }
  }

  // Need the resolved tables, so they run here rather than with the shape checks above. The constant
  // test reads the statement with its literals intact, which `scan` has blanked out.
  for (const problem of typeClashes(scan, facts, bound)) report(problem.kind, problem.detail);
  const withLiterals = stripSqlComments(sql).replace(/[`[\]"]/g, "");
  for (const problem of vacuousOnConstant(withLiterals, facts, bound)) report(problem.kind, problem.detail);

  const defined = definedNames(scan, bindings);
  const bare = bareColumnRefs(scan, defined, depths);
  // Only the statement's own scope: a bare name is resolved against the tables the outer query joins.
  const outer = bound.filter((entry) => depths[entry.at] === 0 && entry.knowledge.names.size > 0);

  for (const column of bare) {
    const owners = outer.filter((entry) => entry.knowledge.names.has(column));
    if (owners.length > 1) {
      report("ambiguous_column", column);
      continue;
    }
    // A statement reading one table and nothing else has nowhere else a bare name could come from,
    // so — and only then — a name that table hasn't got is a name nothing has.
    const single = owners.length === 0 && bindings.length === 1 && outer.length === 1;
    if (single && outer[0].knowledge.complete && !/\bwith\b/i.test(scan)) {
      report("unknown_column", `${outer[0].table}.${column}`);
    }
  }

  return Array.from(problems.values());
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

/** Ends every check with exactly one `;`, so the file can be run straight through. */
function terminate(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  return `${trimmed};`;
}

interface MergedChecks {
  checks: ReconCheck[];
  notes: string[];
  /** How many of the model's checks survived — what decides whether this script counts as AI-written. */
  aiCount: number;
}

/**
 * Puts the model's extra checks after the derived ones, dropping any it can't stand behind.
 *
 * Three things get dropped, each with a note saying so: a check naming no table from this hop, a
 * check naming a column its table demonstrably lacks, and a check duplicating one of the standard
 * ones — the model was told not to write those, and the derived version is the one that is certainly
 * correct. Whatever happens the base checks remain, so the script is runnable either way.
 */
function mergeChecks(facts: ReconTargetFacts, base: ReconCheck[], written: ReconLlmScript | null, columns: ColumnFacts): MergedChecks {
  if (!written) return { checks: base, notes: [], aiCount: 0 };

  const tables = [facts.target, ...facts.sources];
  const covered = new Set<ReconCheckKind>(base.map((c) => c.kind));
  const kept: ReconCheck[] = [];
  const dropped = {
    unknownTable: 0,
    duplicate: 0,
    unknownColumns: [] as string[],
    unverifiable: [] as string[],
    ambiguous: [] as string[],
    nonNumeric: [] as string[],
    misplaced: [] as string[],
    predicates: [] as string[],
    unbalanced: [] as string[],
    clashes: [] as string[],
    counts: 0,
    vacuous: [] as string[]
  };

  for (const check of written.checks) {
    if (kept.length >= MAX_CUSTOM_CHECKS_PER_TARGET) break;
    if (!referencesKnownTable(check.sql, tables)) {
      dropped.unknownTable++;
      continue;
    }
    if (check.kind !== "custom" && covered.has(check.kind)) {
      dropped.duplicate++;
      continue;
    }
    const problems = checkProblems(check.sql, columns, tables);
    if (problems.length > 0) {
      for (const problem of problems) {
        if (problem.kind === "unknown_column") dropped.unknownColumns.push(problem.detail);
        else if (problem.kind === "unverifiable_column") dropped.unverifiable.push(problem.detail);
        else if (problem.kind === "non_numeric_total") dropped.nonNumeric.push(problem.detail);
        else if (problem.kind === "misplaced_function") dropped.misplaced.push(problem.detail);
        else if (problem.kind === "predicate_as_value") dropped.predicates.push(problem.detail);
        else if (problem.kind === "unbalanced_sql") dropped.unbalanced.push(problem.detail);
        else if (problem.kind === "type_clash") dropped.clashes.push(problem.detail);
        else if (problem.kind === "returns_a_count") dropped.counts++;
        else if (problem.kind === "vacuous_check") dropped.vacuous.push(problem.detail);
        else dropped.ambiguous.push(problem.detail);
      }
      continue;
    }
    kept.push({
      kind: check.kind,
      title: check.title,
      description: check.description,
      sql: terminate(check.sql),
      source: "ai"
    });
  }

  const notes = [...written.notes];
  if (dropped.unknownTable > 0) {
    notes.push(
      `${dropped.unknownTable} suggested check${dropped.unknownTable === 1 ? "" : "s"} named no table from this hop and ${dropped.unknownTable === 1 ? "was" : "were"} dropped before you saw ${dropped.unknownTable === 1 ? "it" : "them"}.`
    );
  }
  if (dropped.unknownColumns.length > 0) {
    notes.push(
      `A suggested check referenced ${unique(dropped.unknownColumns).join(", ")}, which this project's ` +
        "SQL does not declare, and was dropped before you saw it — it would have failed with an invalid " +
        "column name."
    );
  }
  if (dropped.ambiguous.length > 0) {
    notes.push(
      `A suggested check named ${unique(dropped.ambiguous).join(", ")} without saying which table it ` +
        "came from, in a query where more than one of them has that column, and was dropped — it would " +
        "have failed with an ambiguous column name."
    );
  }
  if (dropped.misplaced.length > 0) {
    notes.push(
      `A suggested check put ${unique(dropped.misplaced).join(", ")}, which no engine will run, and was ` +
        "dropped. The comparison it was reaching for belongs in a HAVING clause or a subquery."
    );
  }
  if (dropped.unbalanced.length > 0) {
    notes.push(
      `A suggested check did not parse — it left ${unique(dropped.unbalanced).join(", ")} — and was ` +
        "dropped. One stray quote does not break a single check, it breaks every statement after it in " +
        "the file, so nothing that fails to lex is written out."
    );
  }
  if (dropped.vacuous.length > 0) {
    notes.push(
      `A suggested check could never fail — ${unique(dropped.vacuous).join("; ")} — and was dropped. A ` +
        "check that always passes is worse than no check, because it is counted among the ones that " +
        "did. The hardcoded column is reported above in its own right."
    );
  }
  if (dropped.counts > 0) {
    notes.push(
      `${dropped.counts} suggested check${dropped.counts === 1 ? "" : "s"} returned a count rather than ` +
        "the offending rows, which would have read as that many bad rows in the result. Recon counts " +
        "what a check returns, so a check must return the rows themselves."
    );
  }
  if (dropped.clashes.length > 0) {
    notes.push(
      `A suggested check compared incompatible types — ${unique(dropped.clashes).join("; ")} — and was ` +
        "dropped. It reads as though that column held a number like 202401, where this project's code " +
        "builds it as a date."
    );
  }
  if (dropped.predicates.length > 0) {
    notes.push(
      `A suggested check compared conditions as if they were values — ${unique(dropped.predicates).join("; ")} — ` +
        "and was dropped. SQL Server has no boolean type, so that does not parse there even though it " +
        "runs on Databricks; the portable form wraps each side in CASE WHEN … THEN 1 ELSE 0 END."
    );
  }
  if (dropped.nonNumeric.length > 0) {
    notes.push(
      `A suggested check totalled ${unique(dropped.nonNumeric).join(", ")} — a column this project ` +
        "declares as text or a date — and was dropped; summing it is an invalid-operand error, not a " +
        "wrong number."
    );
  }
  if (dropped.unverifiable.length > 0) {
    notes.push(
      `A suggested check referenced ${unique(dropped.unverifiable).join(", ")} on a table nothing in this ` +
        "folder describes, so the column could not be confirmed to exist, and it was dropped rather than " +
        "risk breaking the script. Add that table's CREATE TABLE to the folder to get checks on it."
    );
  }
  if (dropped.duplicate > 0) {
    notes.push(
      `${dropped.duplicate} suggested check${dropped.duplicate === 1 ? "" : "s"} repeated a standard check above; the derived version was kept.`
    );
  }

  return { checks: [...base, ...kept], notes, aiCount: kept.length };
}

// ---- running the calls ----

interface ReconBatch {
  hopIndex: number;
  hopLabel: string;
  prompts: ReconTargetPrompt[];
}

interface BatchResult {
  scripts: ReconLlmScript[];
  /** Set when the batch produced nothing — its tables keep their derived checks and say why. */
  failure: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One call, retried until it comes back or the attempts run out.
 *
 * A timeout, a rate limit and a truncated answer are all transient — the same call a minute later
 * usually succeeds — and the cost of giving up is invisible: that table quietly ships with the
 * derived checks alone and nothing says the model was ever meant to add to them. Retrying with
 * backoff is what makes a run repeatable rather than a coin toss on how busy the endpoint was.
 *
 * A batch of more than one target additionally splits on timeout, which both narrows the prompt and
 * lets the other targets through. `LlmConfigError` is rethrown untouched — retrying an unconfigured
 * endpoint is pointless, and the route turns it into the fully template-written suite.
 */
async function runBatch(batch: ReconBatch, canSplit: boolean): Promise<BatchResult> {
  let lastFailure = "";

  for (let attempt = 0; attempt <= RECON_RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = RETRY_BACKOFF_MS * 2 ** (attempt - 1);
      console.warn(`[recon] retrying ${batch.hopLabel} attempt ${attempt + 1}/${RECON_RETRIES + 1} in ${wait}ms`);
      await sleep(wait);
    }

    try {
      const scripts = await writeReconciliationScripts(batch.hopLabel, batch.prompts, {
        timeoutMs: RECON_TIMEOUT_MS,
        maxOutputTokens: MAX_OUTPUT_TOKENS_PER_TARGET * batch.prompts.length
      });
      return { scripts, failure: null };
    } catch (err) {
      if (err instanceof LlmConfigError) throw err;
      lastFailure = err instanceof Error ? err.message : String(err);

      // Splitting is tried once, on the first timeout: it narrows the prompt as well as retrying it.
      if (canSplit && err instanceof LlmTimeoutError && batch.prompts.length > 1) {
        const halves = await Promise.all(
          batch.prompts.map((prompt) => runBatch({ ...batch, prompts: [prompt] }, false))
        );
        return {
          scripts: halves.flatMap((h) => h.scripts),
          failure: halves.every((h) => h.failure) ? (halves[0].failure ?? null) : null
        };
      }
    }
  }

  return { scripts: [], failure: lastFailure };
}

/**
 * Builds the suite: derived checks for every table always, model-written extras where they arrived.
 *
 * Every call across every hop is queued up front and run with a bounded fan-out, so a folder with
 * four hops costs about as long as its slowest single call rather than the sum of all of them.
 */
export async function buildAiReconciliationSuite(
  project: LocalProject,
  layers: LayerRef[]
): Promise<LocalReconciliationSuite> {
  const { hops, columns, columnFacts } = gatherReconciliationFacts(project, layers);

  // The derived checks are written first and unconditionally: they are the script, and what the
  // model returns is an addition to them. They also tell the model what not to write again.
  const baseChecks = new Map<ReconTargetFacts, ReconCheck[]>();
  for (const hop of hops) {
    for (const facts of hop.targets) baseChecks.set(facts, templateChecks(facts));
  }

  const batches: ReconBatch[] = [];
  hops.forEach((hop, hopIndex) => {
    for (let i = 0; i < hop.targets.length; i += MAX_TARGETS_PER_CALL) {
      batches.push({
        hopIndex,
        hopLabel: hop.label,
        prompts: hop.targets
          .slice(i, i + MAX_TARGETS_PER_CALL)
          .map((facts) => promptFor(facts, columnFacts, baseChecks.get(facts)!, project.facts))
      });
    }
  });

  const results = await mapWithConcurrency(batches, RECON_CONCURRENCY, (batch) => runBatch(batch, true));

  // Model output, keyed per hop: two hops can build tables of the same name, and a script must not
  // pick up the checks written for the other one's.
  const byHop = hops.map(() => new Map<string, ReconLlmScript>());
  const failures: string[] = [];
  results.forEach((result, i) => {
    for (const script of result.scripts) byHop[batches[i].hopIndex].set(script.targetTable, script);
    if (result.failure) failures.push(result.failure);
  });

  let aiTables = 0;
  let plainTables = 0;

  const built = hops.map((hop, hopIndex) => {
    const scripts: ReconScript[] = hop.targets.map((facts) => {
      const base = baseChecks.get(facts)!;
      const written = byHop[hopIndex].get(facts.target.toLowerCase()) ?? null;
      const merged = mergeChecks(facts, base, written, columnFacts);

      if (merged.aiCount > 0) aiTables++;
      else plainTables++;

      return assembleScript({
        facts,
        checks: merged.checks,
        summary: written?.summary ?? "",
        hopLabel: hop.label,
        folderName: project.folderName,
        writtenBy: merged.aiCount > 0 ? "ai" : "rules",
        extraNotes: [
          ...merged.notes,
          ...(written === null && base.length > 0
            ? ["The reviewer model added nothing for this table, so these are Recon's derived checks alone."]
            : [])
        ]
      });
    });

    return assembleHop(hop, scripts, project.folderName);
  });

  return summarizeSuite({
    folderName: project.folderName,
    hops: built,
    hopFacts: hops,
    columns,
    generatedBy: aiTables > 0 ? "ai" : "rules",
    notice: buildNotice(aiTables, plainTables, failures, hops)
  });
}

/** Says plainly which half of each script arrived, so a thin result isn't mistaken for a full one. */
function buildNotice(aiTables: number, plainTables: number, failures: string[], hops: ReconHopFacts[]): string | null {
  const parts: string[] = [];

  if (failures.length > 0) {
    const distinct = Array.from(new Set(failures));
    parts.push(
      `${failures.length} of the reviewer model's calls did not come back after ${RECON_RETRIES + 1} ` +
        `attempts (${distinct[0]}), so the tables they covered carry Recon's derived checks only — those ` +
        "are complete and runnable, they simply have no transformation-specific extras. Regenerate to " +
        "try those tables again, or raise RECON_LLM_TIMEOUT_MS / RECON_RETRIES if it keeps happening."
    );
  } else if (plainTables > 0 && aiTables > 0) {
    parts.push(
      `${plainTables} table${plainTables === 1 ? "" : "s"} got no extra check from the reviewer model — ` +
        `usually because the transformation is a straight copy with nothing beyond the standard checks to test.`
    );
  } else if (aiTables === 0 && hops.some((h) => h.targets.length > 0)) {
    parts.push(
      "The reviewer model added no pipeline-specific checks, so these are Recon's derived checks — " +
        "still the reconciliation you would hand-write, just without the transformation-specific extras."
    );
  }

  return parts.length > 0 ? parts.join(" ") : null;
}
