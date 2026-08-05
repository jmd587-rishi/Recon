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
  type ReconHopFacts,
  type ReconTargetFacts,
  summarizeSuite,
  templateChecks
} from "./reconciliationScripts.js";
import {
  collectCteBodies,
  type ColumnFacts,
  columnKnowledge,
  declaredKind,
  isEmittableIdentifier,
  parenDepths,
  resolveTableRef,
  stripStringLiterals,
  tableBindings
} from "./sqlColumns.js";
import { stripSqlComments } from "./tableLineage.js";

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

/** Target tables per call. Small enough that one answer is short, so it comes back quickly. */
const MAX_TARGETS_PER_CALL = envInt("RECON_TARGETS_PER_CALL", 2, 1, 6);
/** Calls in flight at once. The whole suite should cost roughly one call's wall-clock, not N. */
const RECON_CONCURRENCY = envInt("RECON_CONCURRENCY", 4, 1, 8);
/** Per-call ceiling. Deliberately well under the client's patience: a stall degrades, not hangs. */
const RECON_TIMEOUT_MS = envInt("RECON_LLM_TIMEOUT_MS", 75_000, 10_000, 300_000);
/** Output budget per target. Four short checks and a summary fit easily; a runaway answer doesn't. */
const MAX_OUTPUT_TOKENS_PER_TARGET = envInt("RECON_MAX_OUTPUT_TOKENS", 1600, 400, 8000);
/** Per-statement cap on the transformation SQL quoted into the prompt. */
const MAX_SQL_CHARS = 4500;
/** Per-target SQL budget, so a batch of stored procedures can't blow the context window. */
const MAX_SQL_CHARS_PER_TARGET = 6000;
/** Columns listed per table before the list is cut — a 200-column report table helps nobody. */
const MAX_COLUMNS_LISTED = 80;

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
function promptFor(facts: ReconTargetFacts, columns: ColumnFacts, baseChecks: ReconCheck[]): ReconTargetPrompt {
  const transformationSql: ReconTargetPrompt["transformationSql"] = [];
  let budget = MAX_SQL_CHARS_PER_TARGET;
  for (const fact of facts.facts) {
    if (budget <= 0) break;
    const sql = fact.rawSql.slice(0, Math.min(MAX_SQL_CHARS, budget));
    budget -= sql.length;
    transformationSql.push({ path: fact.notebookPath, statementIndex: fact.cellIndex, sql });
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
  | "misplaced_function";

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
  const cleaned = stripStringLiterals(stripSqlComments(sql));
  // Quoting characters carry no meaning to the scanner, and dropping them keeps `t.[month]` a
  // qualified reference rather than a bare word preceded by a bracket.
  const scan = cleaned.replace(/[`[\]"]/g, "");

  const depths = parenDepths(scan);
  const problems = new Map<string, CheckProblem>();
  const report = (kind: CheckProblemKind, detail: string) => problems.set(`${kind}:${detail}`, { kind, detail });

  // Independent of what the tables are: this is about where the functions sit in the statement.
  for (const problem of misplacedFunctions(scan, depths)) report(problem.kind, problem.detail);

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
    misplaced: [] as string[]
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

/**
 * One call, with one narrowing retry.
 *
 * A batch that times out is retried as single-target calls rather than abandoned: a two-table call
 * is usually slow because one of the two has a large transformation, and splitting it lets the other
 * one through. The split runs in parallel, so the retry costs one more call's latency, not two.
 * `LlmConfigError` is rethrown untouched — retrying an unconfigured endpoint is pointless, and the
 * route turns it into the fully template-written suite.
 */
async function runBatch(batch: ReconBatch, canSplit: boolean): Promise<BatchResult> {
  try {
    const scripts = await writeReconciliationScripts(batch.hopLabel, batch.prompts, {
      timeoutMs: RECON_TIMEOUT_MS,
      maxOutputTokens: MAX_OUTPUT_TOKENS_PER_TARGET * batch.prompts.length
    });
    return { scripts, failure: null };
  } catch (err) {
    if (err instanceof LlmConfigError) throw err;

    if (canSplit && err instanceof LlmTimeoutError && batch.prompts.length > 1) {
      const halves = await Promise.all(
        batch.prompts.map((prompt) => runBatch({ ...batch, prompts: [prompt] }, false))
      );
      return {
        scripts: halves.flatMap((h) => h.scripts),
        failure: halves.every((h) => h.failure) ? (halves[0].failure ?? null) : null
      };
    }

    return { scripts: [], failure: err instanceof Error ? err.message : String(err) };
  }
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
          .map((facts) => promptFor(facts, columnFacts, baseChecks.get(facts)!))
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
      `${failures.length} of the reviewer model's calls did not come back (${distinct[0]}), so the tables ` +
        "they covered carry Recon's derived checks only. Regenerate to retry just those."
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
