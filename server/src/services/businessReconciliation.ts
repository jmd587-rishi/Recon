import { mapWithConcurrency } from "./concurrency.js";
import {
  type BusinessFacts,
  gatherBusinessFacts,
  hasBusinessChecks,
  type MeasureTrace,
  type MeasureWalk,
  type StatedIdentity
} from "./businessMeasures.js";
import {
  type BusinessCommentInput,
  envInt,
  explainBusinessChecks,
  LlmConfigError
} from "./llmClient.js";
import type { LocalProject } from "./localProject.js";
import {
  accuracyExpr,
  FAIL_BELOW_PERCENT,
  gradeExpr,
  percentText,
  RULE,
  VALUE_TYPE,
  wrap
} from "./reconciliationBundle.js";
import {
  gatherLayerFacts,
  lineageStatements,
  measureExpr,
  type ReconLayerFacts
} from "./reconciliationScripts.js";
import { platformNote, type SqlPlatform } from "./sqlPlatform.js";
import type { LayerRef } from "../types/index.js";

/**
 * One SQL script per **reporting** table: the checks that only make sense once a pipeline has stopped
 * moving data and started reporting on it.
 *
 * The other three writers all reconcile a target against the tables that built it, and on the last
 * table of a data mart that runs out of things to compare. `rpt_snowball`'s `bop_arr`,
 * `customer_churn`, `product_churn`, `downsell`, `upsell`, `cross_sell` and `eop_arr` exist in no
 * source table — they are eight readings of one upstream column, `fact_arr.arr` — so a column-against-
 * source report has nothing to pair them with and says nothing about the table the business actually
 * looks at. Everything that would catch a broken snowball is either *internal* to the report or
 * *end to end* across the whole pipeline, and this file writes both.
 *
 * Four checks, in the order they are worth reading:
 *
 * - **roll-forward** — opening balance plus every movement equals the closing balance, per period.
 *   The one rule a snowball, waterfall or bridge exists to satisfy, and the one nobody writes down.
 * - **stated identity** — a column the SQL declares to be the sum of other columns (`bop_arr +
 *   customer_churn + product_churn + downsell AS grr`) still equals them once the table is built.
 *   This is not a reading of the code, it is the code, restated as a check.
 * - **period continuity** — the closing balance of one period is the opening balance of the next, so
 *   the report's history joins up rather than being a series of unrelated snapshots.
 * - **measure trace** — one business term totalled at every table it passes through, from the raw feed
 *   to the report, so the hop where a total stopped agreeing is named rather than searched for.
 *
 * Every check is cut by the report's own **slice** — the column its SQL writes two or three literal
 * values into (`'LM'`, `'LTM'`) — and grouped by its reporting period. A report that unions its period
 * windows into one table holds each entity more than once, and a total taken across the whole of it
 * adds two different questions together.
 *
 * The columns are:
 *
 *     check_seq | check_name | business_term | source_table | target_table | period_slice | period
 *     source_value | target_value | difference | accuracy | status | comments
 *
 * `source_value` is what the report *should* show and `target_value` is what it does, so `difference`
 * is `target - source` — the same sign an analyst writes by hand as `reconciliation_difference`.
 * `accuracy`, `status` and the floor under the percentage are `reconciliationBundle`'s, shared rather
 * than restated, so a row here grades exactly as the same numbers would in a hop bundle.
 *
 * `comments` is the reviewer model's, for the same reason it is in `layerReconciliation.ts`: Recon
 * reads code and never reads data, so nothing static can say why a walk did not balance — but the code
 * can say what would unbalance it, and that is a reading job. With no Azure OpenAI configured the
 * column is emitted empty and the header says why.
 */

/** Checks commented on per model call — one report's, since they share one transformation. */
const MAX_CHECKS_PER_CALL = envInt("RECON_BUSINESS_ROWS_PER_CALL", 24, 4, 100);
/** Reports commented on at once. */
const COMMENT_CONCURRENCY = envInt("RECON_BUSINESS_CONCURRENCY", 4, 1, 8);
const COMMENT_TIMEOUT_MS = envInt("RECON_BUSINESS_TIMEOUT_MS", 240_000, 10_000, 900_000);
const COMMENT_TOKENS_PER_ROW = envInt("RECON_BUSINESS_TOKENS_PER_ROW", 320, 60, 2000);
const MIN_COMMENT_TOKENS = envInt("RECON_BUSINESS_MIN_TOKENS", 3000, 500, 32_000);
const COMMENT_RETRIES = envInt("RECON_BUSINESS_RETRIES", 2, 0, 10);
const RETRY_BACKOFF_MS = envInt("RECON_BUSINESS_RETRY_BACKOFF_MS", 2000, 0, 60_000);
/** Characters of any one statement shown to the model. */
const MAX_SQL_CHARS = envInt("RECON_BUSINESS_SQL_CHARS", 20_000, 500, 200_000);
/** Total code budget per call. */
const MAX_SQL_CHARS_PER_CALL = envInt("RECON_BUSINESS_SQL_BUDGET", 60_000, 1000, 400_000);
/** How far up the lineage the model is shown the code — a report is built out of a long chain. */
const UPSTREAM_HOPS = envInt("RECON_BUSINESS_UPSTREAM_HOPS", 2, 0, 8);
/** Longest comment written into the SQL before it is cut back to its last whole sentence. */
const MAX_COMMENT_CHARS = 1000;

/** What a period is rendered as. Wide enough for an ISO timestamp, which is the longest it gets. */
const PERIOD_TEXT_TYPE = "VARCHAR(32)";

/** What `period_slice` says on a report that has no slice column, and on an upstream-only trace row. */
const WHOLE_TABLE = "(all rows)";

const NEWLINE = "\n";

/** The file written when a project reports from nothing this can check. */
const NO_BUSINESS_CHECKS = "_NO_BUSINESS_CHECKS.sql";

// ---- small SQL helpers ----

/**
 * A SQL string literal, escaped the way `layerReconciliation.quoted` escapes one and for the same
 * reasons: the doubled quote makes it a literal, the stripped backslash stops Spark reading a `\'` as
 * an escape where SQL Server does not, and the semicolon would split a single-statement file in two
 * for anything that splits on the character rather than parsing.
 */
function quoted(text: string): string {
  return `'${text.replace(/\\/g, "").replace(/'/g, "''").replace(/\s*;\s*/g, " — ")}'`;
}

function cast(expr: string): string {
  return `CAST(${expr} AS ${VALUE_TYPE})`;
}

/** `bop_arr` -> `m_bop_arr`, safe as a CTE column name whatever the identifier looked like. */
function totalAlias(column: string): string {
  return `m_${column.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/**
 * A signed sum of already-totalled columns, as it is written into the query.
 *
 * The first term carries no `+`, and a leading `-` is written as `0 - x` rather than as unary minus:
 * `-x + y` parses on every engine, but reading it back inside a wrapped expression is where a sign gets
 * lost, and this expression is the one thing standing between a passing walk and a wrong one.
 */
function signedSum(terms: { column: string; sign: 1 | -1 }[], prefix: string): string {
  return terms
    .map((term, i) => {
      const ref = `${prefix}${totalAlias(term.column)}`;
      if (i === 0) return term.sign < 0 ? `0 - ${ref}` : ref;
      return `${term.sign < 0 ? "- " : "+ "}${ref}`;
    })
    .join(" ");
}

/** A comment trimmed to fit, cut back to its last whole sentence rather than mid-word. */
function tidy(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_COMMENT_CHARS) return collapsed;
  const cut = collapsed.slice(0, MAX_COMMENT_CHARS);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return stop > MAX_COMMENT_CHARS / 2 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

// ---- one row of the report ----

/**
 * One check: what it is, which two tables it spans, and the SQL that produces its rows.
 *
 * `body` is a `FROM` clause and everything after it, producing exactly four columns —
 * `period_slice`, `period`, `source_value`, `target_value`. Everything above it (the sequence number,
 * the labels, the difference, the accuracy, the verdict) is written once by `renderCheck`, so no check
 * can grade itself differently from its neighbours.
 */
interface BusinessCheck {
  name: string;
  term: string;
  sourceTable: string;
  targetTable: string;
  /** What the model is told this row compares — not shown to the reader. */
  comparison: string;
  /** What the check asserts, in words, for the header and the prompt. */
  claim: string;
  /** This check reads `ordered_periods`, so the file has to define it. */
  usesOrdered: boolean;
  body: string;
  comment: string;
}

const COLUMNS = [
  "check_seq",
  "check_name",
  "business_term",
  "source_table",
  "target_table",
  "period_slice",
  "period",
  "source_value",
  "target_value",
  "difference",
  "accuracy",
  "status",
  "comments"
];

/** When a row reconciles, in terms of the two numbers it prints — one condition for the whole file. */
const AGREE = "v.target_value = v.source_value";

const ACCURACY = accuracyExpr(
  AGREE.replace(/\bv\./g, "m."),
  "ABS(m.target_value - m.source_value)",
  "ABS(m.source_value)"
);

/**
 * The two values, then the percentage over them, then the row — nothing measured twice.
 *
 * The same two-level derived table `layerReconciliation.measured` builds, widened by the two columns
 * that make a business check readable: which slice of the report the numbers came from, and which
 * period. `difference` joins them in the inner layer rather than being recomputed above, so the number
 * the reader sees and the number the verdict is graded from are one subtraction.
 */
function measured(body: string): string {
  return (
    `FROM (SELECT m.period_slice,${NEWLINE}` +
    `             m.period,${NEWLINE}` +
    `             m.source_value,${NEWLINE}` +
    `             m.target_value,${NEWLINE}` +
    `             ${cast("m.target_value - m.source_value")} AS difference,${NEWLINE}` +
    `             ${ACCURACY} AS accuracy_pct${NEWLINE}` +
    `      ${body}) v`
  );
}

/**
 * The four columns every check's `body` has to produce, laid out so the generated file lines up.
 *
 * `measured` indents the body's first line by six and leaves the rest alone, so a body carries its own
 * indent from the second line on — `INNER` is what makes that visible, since it is the one keyword that
 * has to sit under the `FROM` it belongs to rather than under the select list.
 */
const INNER = " ".repeat(6);
const INNER_LIST = " ".repeat(19);

function innerSelect(sourceValue: string, targetValue: string, from: string[], slice = "period_slice", period = "period"): string {
  return [
    `FROM (SELECT ${slice},`,
    `${INNER_LIST}${period},`,
    `${INNER_LIST}${sourceValue} AS source_value,`,
    `${INNER_LIST}${targetValue} AS target_value`,
    ...from.map((line) => `${INNER}${INNER}${line}`)
  ].join(NEWLINE);
}

function renderCheck(check: BusinessCheck, seq: number, first: boolean): string {
  const values = [
    String(seq),
    quoted(check.name),
    quoted(check.term),
    quoted(check.sourceTable),
    quoted(check.targetTable),
    "v.period_slice",
    "v.period",
    // Named, not measured: all of them were worked out once by `measured`.
    "v.source_value",
    "v.target_value",
    "v.difference",
    percentText("v.accuracy_pct"),
    gradeExpr(AGREE, "v.accuracy_pct"),
    // Same condition, opposite sense: a check that balanced has nothing to explain.
    check.comment === "" ? "''" : `CASE WHEN ${AGREE} THEN '' ELSE ${quoted(tidy(check.comment))} END`
  ];

  const select = values
    .map((value, i) => `${i === 0 ? "SELECT " : "       "}${value}${first ? ` AS ${COLUMNS[i]}` : ""}`)
    .join(`,${NEWLINE}`);

  return `${select}${NEWLINE}${measured(check.body)}`;
}

// ---- the CTEs every per-period check reads from ----

/** Column names of the report the per-period checks total, in the order they are first needed. */
function totalledColumns(facts: BusinessFacts): string[] {
  const wanted: string[] = [];
  const add = (name: string) => {
    if (!wanted.includes(name)) wanted.push(name);
  };

  for (const walk of facts.walks) {
    add(walk.opening);
    for (const movement of walk.movements) add(movement.column);
    add(walk.closing);
  }
  for (const identity of facts.identities) {
    add(identity.column);
    for (const term of identity.terms) add(term.column);
  }
  return wanted;
}

/**
 * `slice_totals`: the report totalled once, per slice and per period, and every per-period check reads
 * from it.
 *
 * One scan of the report for the whole file. The alternative — a subquery per check — reads the same
 * table nine times to answer nine questions about the same nine numbers, and lets two checks disagree
 * about a total because one of them cast it and the other did not.
 *
 * `period` is kept twice on purpose: as text, which is what the report prints and what unions cleanly
 * with the trace rows that have no period at all, and in its own type as `period_sort`, which is what
 * `ROW_NUMBER` has to order by. Ranking a date by its string form is how a continuity check pairs
 * December with January.
 */
function sliceTotalsCte(facts: BusinessFacts, platform: SqlPlatform): string | null {
  const columns = totalledColumns(facts);
  if (columns.length === 0) return null;

  // Declared numeric on the report itself. A column whose type nothing states is totalled through a
  // try-conversion instead, which yields NULL rather than taking the whole file down with a hard error.
  const declared = new Set(
    facts.columns.filter((column) => column.kind === "numeric").map((column) => column.name)
  );

  const selected = [
    facts.slice ? `${facts.slice.column} AS period_slice` : `${quoted(WHOLE_TABLE)} AS period_slice`,
    ...(facts.periodColumn
      ? [
          `CAST(${facts.periodColumn} AS ${PERIOD_TEXT_TYPE}) AS period`,
          `${facts.periodColumn} AS period_sort`
        ]
      : [`CAST(NULL AS ${PERIOD_TEXT_TYPE}) AS period`]),
    ...columns.map(
      (column) =>
        `COALESCE(SUM(${measureExpr(column, declared.has(column), platform)}), 0) AS ${totalAlias(column)}`
    )
  ];

  const grouped = [
    ...(facts.slice ? [facts.slice.column] : []),
    ...(facts.periodColumn ? [facts.periodColumn] : [])
  ];

  return (
    `slice_totals AS (${NEWLINE}` +
    selected.map((item, i) => `    ${i === 0 ? "SELECT " : "     , "}${item}`).join(NEWLINE) +
    `${NEWLINE}    FROM ${facts.table}` +
    (grouped.length > 0 ? `${NEWLINE}    GROUP BY ${grouped.join(", ")}` : "") +
    `${NEWLINE})`
  );
}

/** `ordered_periods`: the same totals with each period numbered inside its slice, for continuity. */
function orderedCte(facts: BusinessFacts): string | null {
  if (!facts.periodColumn) return null;
  const columns = totalledColumns(facts);

  return (
    `ordered_periods AS (${NEWLINE}` +
    `    SELECT period_slice${NEWLINE}` +
    `         , period${NEWLINE}` +
    columns.map((column) => `         , ${totalAlias(column)}`).join(NEWLINE) +
    `${NEWLINE}         , ROW_NUMBER() OVER (PARTITION BY period_slice ORDER BY period_sort) AS period_no${NEWLINE}` +
    `    FROM slice_totals${NEWLINE})`
  );
}

// ---- the four checks ----

function walkCheck(facts: BusinessFacts, walk: MeasureWalk): BusinessCheck {
  const expected = signedSum(
    [{ column: walk.opening, sign: 1 as const }, ...walk.movements],
    "t."
  );

  return {
    name: "roll-forward",
    term: walk.term,
    sourceTable: facts.table,
    targetTable: facts.table,
    comparison: `${walk.opening} plus ${walk.movements.map((m) => m.column).join(", ")} against ${walk.closing}`,
    claim:
      `${walk.opening} plus every movement equals ${walk.closing}, one period at a time` +
      (walk.signedBy ? ` (signs taken from the code's own ${walk.signedBy})` : ""),
    usesOrdered: false,
    body: `${innerSelect(cast(expected), cast(`t.${totalAlias(walk.closing)}`), ["FROM slice_totals t) m"], "t.period_slice", "t.period")}`,
    comment: ""
  };
}

function identityCheck(facts: BusinessFacts, identity: StatedIdentity): BusinessCheck {
  return {
    name: "stated identity",
    term: identity.column,
    sourceTable: facts.table,
    targetTable: facts.table,
    comparison: `SUM(${identity.column}) against SUM of ${identity.expression}`,
    claim: `${identity.column} still equals ${identity.expression}, which is what the code declares it to be`,
    usesOrdered: false,
    body: innerSelect(
      cast(signedSum(identity.terms, "t.")),
      cast(`t.${totalAlias(identity.column)}`),
      ["FROM slice_totals t) m"],
      "t.period_slice",
      "t.period"
    ),
    comment: ""
  };
}

/**
 * The closing balance of one period is the opening balance of a later one, `lag` periods on.
 *
 * `lag` is the length of the slice's own window, so a monthly slice compares consecutive periods and a
 * rolling twelve-month slice compares a period with the one a year before it — which is the
 * `DATEADD(MONTH, -12, ...)` an analyst writes by hand. A slice whose length nothing could establish
 * gets no such check rather than a wrong one; `businessMeasures` says which in the notes.
 *
 * The join is on the *rank* of the period within its slice rather than on date arithmetic, which keeps
 * the file portable — `DATEADD`, `ADD_MONTHS` and `DATE_ADD` are three engines' three spellings — and
 * means a report missing a month pairs with the month actually before it rather than with nothing.
 * `INNER JOIN` drops the first `lag` periods of each slice, which is right: they have no earlier close.
 */
function continuityCheck(facts: BusinessFacts, walk: MeasureWalk, slice: string, lag: number): BusinessCheck {
  return {
    name: `period continuity (${lag} period${lag === 1 ? "" : "s"})`,
    term: walk.term,
    sourceTable: facts.table,
    targetTable: facts.table,
    comparison: `${walk.closing} ${lag} period(s) earlier against ${walk.opening} now, within ${slice}`,
    claim:
      `${walk.opening} for a ${slice} period equals ${walk.closing} ${lag} period` +
      `${lag === 1 ? "" : "s"} earlier, so the report's history joins up`,
    usesOrdered: true,
    body: innerSelect(
      cast(`prior.${totalAlias(walk.closing)}`),
      cast(`curr.${totalAlias(walk.opening)}`),
      [
        "FROM ordered_periods curr",
        "INNER JOIN ordered_periods prior",
        "        ON prior.period_slice = curr.period_slice",
        `       AND prior.period_no = curr.period_no - ${lag}`,
        `WHERE curr.period_slice = ${quoted(slice)}) m`
      ],
      "curr.period_slice",
      "curr.period"
    ),
    comment: ""
  };
}

/**
 * One hop of a measure's history: its total where it came from, against its total where it arrived.
 *
 * Consecutive pairs rather than every step against the report, because the question a trace answers is
 * *which hop lost it* — and a column of eight rows all differing from the report by the same amount
 * says only that something, somewhere, did.
 *
 * The slice filter is applied where the report is one of the two tables and nowhere else, and
 * `period_slice` says which of the two happened, because a filter silently applied to one side of a
 * comparison is how a trace comes to disagree with itself.
 */
function traceCheck(
  facts: BusinessFacts,
  trace: MeasureTrace,
  from: MeasureTrace["steps"][number],
  to: MeasureTrace["steps"][number],
  slice: string | null,
  platform: SqlPlatform
): BusinessCheck {
  const filterFor = (table: string) =>
    slice !== null && facts.slice && table === facts.table
      ? ` WHERE ${facts.slice.column} = ${quoted(slice)}`
      : "";

  const total = (step: MeasureTrace["steps"][number]) =>
    `COALESCE((SELECT SUM(${measureExpr(step.column, !step.untyped, platform)}) ` +
    `FROM ${step.table}${filterFor(step.table)}), 0)`;

  const sliced = facts.slice && (from.table === facts.table || to.table === facts.table);

  return {
    name: "measure trace",
    term: trace.term,
    sourceTable: from.table,
    targetTable: to.table,
    comparison: `SUM(${from.table}.${from.column}) against SUM(${to.table}.${to.column})`,
    claim:
      `every ${trace.term} that reached ${from.table} as ${from.column} is still there in ${to.table} ` +
      `as ${to.column}`,
    usesOrdered: false,
    body: innerSelect(
      cast(total(from)),
      cast(total(to)),
      [],
      `${sliced ? quoted(slice ?? WHOLE_TABLE) : quoted(WHOLE_TABLE)} AS period_slice`,
      `CAST(NULL AS ${PERIOD_TEXT_TYPE}) AS period`
    ) + ") m",
    comment: ""
  };
}

/**
 * Every check one report admits, in the order they are worth reading.
 *
 * The trace runs over the slice whose periods do not overlap — a rolling window re-counts each period
 * as many times as the window is long, so its total is a multiple of the pipeline's and comparing it
 * with an upstream table could only ever fail. `SLICE_LAG` already knows which slices those are:
 * length 1 means each row is counted once.
 */
function checksFor(facts: BusinessFacts, platform: SqlPlatform): BusinessCheck[] {
  const checks: BusinessCheck[] = [];

  for (const walk of facts.walks) checks.push(walkCheck(facts, walk));
  for (const identity of facts.identities) checks.push(identityCheck(facts, identity));

  if (facts.periodColumn) {
    for (const walk of facts.walks) {
      if (!facts.slice) {
        checks.push(continuityCheck(facts, walk, WHOLE_TABLE, 1));
        continue;
      }
      for (const [value, lag] of Object.entries(facts.slice.lags)) {
        if (lag !== null) checks.push(continuityCheck(facts, walk, value, lag));
      }
    }
  }

  const traceSlice =
    facts.slice === null
      ? null
      : (Object.entries(facts.slice.lags).find(([, lag]) => lag === 1)?.[0] ?? null);

  for (const trace of facts.traces) {
    // A trace of a sliced report with no non-overlapping slice has no total to compare against.
    if (facts.slice !== null && traceSlice === null) break;
    for (let i = 1; i < trace.steps.length; i++) {
      checks.push(traceCheck(facts, trace, trace.steps[i - 1], trace.steps[i], traceSlice, platform));
    }
  }

  return checks;
}

/**
 * What the checks on one report assert, without writing any SQL.
 *
 * Exported so the generated document describes this artifact in the *same sentences* its own header
 * carries, rather than in a second description of it that can drift — the same reason `joinLabel` is
 * exported from `layerReconciliation.ts`.
 */
export function describeBusinessChecks(
  facts: BusinessFacts,
  platform: SqlPlatform = "portable"
): { name: string; term: string; claim: string }[] {
  return checksFor(facts, platform).map(({ name, term, claim }) => ({ name, term, claim }));
}

// ---- the file ----

export interface BusinessReportScript {
  /** The report this file checks, as the project's SQL names it. */
  table: string;
  /** The layer it reports from. */
  layer: string;
  filename: string;
  sql: string;
  walkCount: number;
  identityCount: number;
  traceCount: number;
  checkCount: number;
  /** Of those checks, how many carry a model-written comment. */
  commentedCount: number;
}

export interface BusinessReconciliationSuite {
  folderName: string;
  scripts: BusinessReportScript[];
  /**
   * Tables the pipeline ends at that this could find no business check for, with the reason.
   *
   * Reported rather than given an empty file each: a dimension is a perfectly good terminal table with
   * no roll-forward in it, and a folder of files saying so would bury the reports that have one.
   */
  skipped: { table: string; layer: string; reasons: string[] }[];
  /** Why the comments column is empty, when it is. Null when the model wrote them. */
  notice: string | null;
  stats: { reportCount: number; checkCount: number; commentedCount: number };
}

function header(facts: BusinessFacts, checks: BusinessCheck[], notice: string | null, platform: SqlPlatform): string {
  const kinds = new Map<string, number>();
  for (const check of checks) {
    const key = check.name.startsWith("period continuity") ? "period continuity" : check.name;
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
  }

  const lines = [
    `/* ${RULE}`,
    `   Business reconciliation — ${facts.table}   (${facts.layer} layer)`,
    "",
    ...wrap(
      `One query, ${checks.length} check${checks.length === 1 ? "" : "s"} — ` +
        `${Array.from(kinds, ([name, count]) => `${count} ${name}`).join(", ")} — over the columns this ` +
        "report is read for. Each returns one row per period it covers:",
      "   "
    ),
    "",
    "     check_seq | check_name | business_term | source_table | target_table |",
    "     period_slice | period | source_value | target_value | difference |",
    "     accuracy | status | comments",
    "",
    ...wrap(
      "`source_value` is what the report should show and `target_value` is what it does, so " +
        "`difference` is target minus source. `accuracy` is how much of the expected value the report " +
        "still carries and `status` is graded from it: 100.00% passes, below " +
        `${FAIL_BELOW_PERCENT}% fails, anything between reviews. The percentage is floored, so a walk ` +
        "a few pounds out of four million reads 99.99% and reviews rather than passing.",
      "   "
    ),
    "",
    "   What each check asserts:",
    ""
  ];

  const claims = new Set<string>();
  for (const check of checks) {
    if (claims.has(check.claim)) continue;
    claims.add(check.claim);
    lines.push(...wrap(`- ${check.claim}.`, "     "));
  }

  if (facts.slice) {
    lines.push(
      "",
      ...wrap(
        `Every check is cut by ${facts.slice.column}, which this project's SQL writes as ` +
          `${facts.slice.values.map((value) => `'${value}'`).join(" and ")}. A report holding more than ` +
          "one kind of period row holds each entity more than once, so a total across the whole table " +
          "is two questions added together.",
        "   "
      )
    );
    const rolling = Object.entries(facts.slice.lags).filter(([, lag]) => lag !== null && lag > 1);
    if (rolling.length > 0) {
      lines.push(
        "",
        ...wrap(
          `${rolling.map(([value, lag]) => `'${value}' is read as a rolling window ${lag} periods long`).join(", ")}` +
            `${
              facts.windowWidths.length > 0
                ? `, which the SQL behind this table corroborates — it uses a ${facts.windowWidths.join(
                    " and a "
                  )} row window`
                : ""
            }. That is where its opening balance is compared from, and it is why the measure trace is ` +
            "not run over it: a rolling window counts each period as many times as the window is long, " +
            "so its total is a multiple of what the pipeline actually holds.",
          "   "
        )
      );
    }
  }

  if (facts.periodColumn) {
    lines.push(
      "",
      ...wrap(
        `Periods come from ${facts.periodColumn}, and the continuity check pairs them by their rank ` +
          "inside the slice rather than by date arithmetic — so the file stays portable, and a report " +
          "missing a month pairs with the month really before it rather than with nothing.",
        "   "
      )
    );
  }

  lines.push(
    "",
    ...wrap(
      "`comments` is the reviewer model reading your transformation SQL for what would make a check " +
        "not balance. It is a reading of code rather than a measurement, so it is a first place to " +
        "look and not a verdict, and it is empty on every row that balanced.",
      "   "
    )
  );

  if (notice) {
    lines.push("", ...wrap(`comments is empty throughout: ${notice}`, "   "));
  }

  if (facts.notes.length > 0) {
    lines.push("", "   What is not checked here, and why:", "");
    for (const note of facts.notes) lines.push(...wrap(`- ${note}`, "     "));
  }

  lines.push("", ...wrap(platformNote(platform), "   "), `   ${RULE} */`, "");
  return lines.join(NEWLINE);
}

function assemble(
  facts: BusinessFacts,
  checks: BusinessCheck[],
  notice: string | null,
  platform: SqlPlatform
): BusinessReportScript {
  const ctes = [
    sliceTotalsCte(facts, platform),
    checks.some((check) => check.usesOrdered) ? orderedCte(facts) : null
  ].filter((cte): cte is string => cte !== null);

  const body =
    (ctes.length > 0 ? `WITH ${ctes.join(`,${NEWLINE}`)}${NEWLINE}` : "") +
    checks.map((check, i) => renderCheck(check, i + 1, i === 0)).join(`${NEWLINE}UNION ALL${NEWLINE}`) +
    `${NEWLINE}ORDER BY check_seq, period_slice, period;${NEWLINE}`;

  return {
    table: facts.table,
    layer: facts.layer,
    filename: facts.filename,
    sql: `${header(facts, checks, notice, platform)}${body}`,
    walkCount: facts.walks.length,
    identityCount: facts.identities.length,
    traceCount: facts.traces.length,
    checkCount: checks.length,
    commentedCount: checks.filter((check) => check.comment !== "").length
  };
}

// ---- asking the model why a check might not balance ----

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The code the model is shown for one report: the statements that build it, then what built those. */
function codeFor(facts: BusinessFacts, layers: ReconLayerFacts[]): { path: string; builds: string; sql: string }[] {
  const target = layers.flatMap((layer) => layer.targets).find((entry) => entry.target === facts.table);
  if (!target) return [];

  const out: { path: string; builds: string; sql: string }[] = [];
  let budget = MAX_SQL_CHARS_PER_CALL;

  for (const { fact, builds } of lineageStatements(target.facts, facts.table, UPSTREAM_HOPS)) {
    if (budget <= 0) break;
    const sql = fact.rawSql.slice(0, Math.min(MAX_SQL_CHARS, budget));
    budget -= sql.length;
    out.push({ path: fact.notebookPath, builds, sql });
  }
  return out;
}

async function commentOn(
  facts: BusinessFacts,
  checks: BusinessCheck[],
  layers: ReconLayerFacts[]
): Promise<void> {
  const code = codeFor(facts, layers);

  for (let start = 0; start < checks.length; start += MAX_CHECKS_PER_CALL) {
    const batch = checks.slice(start, start + MAX_CHECKS_PER_CALL);
    const inputs: BusinessCommentInput[] = batch.map((check) => ({
      reportTable: facts.table,
      checkName: check.name,
      businessTerm: check.term,
      sourceTable: check.sourceTable,
      targetTable: check.targetTable,
      claim: check.claim,
      comparison: check.comparison
    }));

    for (let attempt = 0; attempt <= COMMENT_RETRIES; attempt++) {
      if (attempt > 0) await wait(RETRY_BACKOFF_MS * 2 ** (attempt - 1));
      try {
        const answers = await explainBusinessChecks(facts.table, inputs, code, {
          timeoutMs: COMMENT_TIMEOUT_MS,
          maxOutputTokens: Math.max(MIN_COMMENT_TOKENS, inputs.length * COMMENT_TOKENS_PER_ROW)
        });
        answers.forEach((comment: string, i: number) => {
          batch[i].comment = comment;
        });
        break;
      } catch (err) {
        // Configuration is not transient — there is no key to retry with, and the caller has something
        // different to say about it. A timeout or a rate limit is, and costs this report its comments
        // rather than the run: every check in the file is still derived and still runnable.
        if (err instanceof LlmConfigError) throw err;
        if (attempt === COMMENT_RETRIES) {
          console.warn(
            `[recon] no business comments for ${facts.table}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }
}

// ---- the suite ----

/**
 * The business reconciliation for a whole project: one file per reporting table that has something to
 * check, and a list of the ones that had not.
 *
 * `useAi` false, or Azure OpenAI unconfigured, still produces every file — the checks are derived from
 * the project's own arithmetic and its lineage, and need no model at all. Only the explanation is lost,
 * and the header says so where the explanation would have been.
 */
export async function buildBusinessReconciliation(
  project: LocalProject,
  layers: LayerRef[],
  useAi: boolean,
  platform: SqlPlatform = "portable"
): Promise<BusinessReconciliationSuite> {
  const grounding = gatherLayerFacts(project, layers);
  const reports = gatherBusinessFacts(grounding.layers);

  const checkable = reports
    .map((facts) => ({ facts, checks: checksFor(facts, platform) }))
    .filter((entry) => hasBusinessChecks(entry.facts) && entry.checks.length > 0);
  const skipped = reports
    .filter((facts) => !checkable.some((entry) => entry.facts.table === facts.table))
    .map((facts) => ({ table: facts.table, layer: facts.layer, reasons: facts.notes }));

  let notice: string | null = useAi
    ? null
    : "run with --no-ai, so the reviewer model was not asked why any check might not balance.";

  if (useAi && checkable.length > 0) {
    try {
      await mapWithConcurrency(checkable, COMMENT_CONCURRENCY, (entry) =>
        commentOn(entry.facts, entry.checks, grounding.layers)
      );
      const wrote = checkable.some((entry) => entry.checks.some((check) => check.comment !== ""));
      if (!wrote) {
        notice =
          "the reviewer model did not return an explanation for any check. Check the AZURE_OPENAI_* " +
          "settings and the console for the reason, then re-run.";
      }
    } catch (err) {
      if (!(err instanceof LlmConfigError)) throw err;
      notice =
        "Azure OpenAI is not configured, so nothing read the transformation code to explain a " +
        "difference. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT in a " +
        ".env file and re-run to fill this column in.";
    }
  }

  const scripts = checkable.map((entry) => assemble(entry.facts, entry.checks, notice, platform));

  return {
    folderName: project.folderName,
    scripts,
    skipped,
    notice,
    stats: {
      reportCount: scripts.length,
      checkCount: scripts.reduce((n, script) => n + script.checkCount, 0),
      commentedCount: scripts.reduce((n, script) => n + script.commentedCount, 0)
    }
  };
}

/**
 * The file a project with no checkable report gets, so the folder is never empty.
 *
 * An absent folder is indistinguishable from a run that never got this far, which is the same reason
 * `layerReconciliation` writes `_LAYER_NOT_RECONCILED.sql`.
 */
export function noBusinessChecksFile(suite: BusinessReconciliationSuite, platform: SqlPlatform): {
  filename: string;
  sql: string;
} {
  const lines = [
    `/* ${RULE}`,
    `   Business reconciliation — ${suite.folderName}`,
    "",
    ...wrap(
      "No table this pipeline ends at carries a business check that could be derived from its SQL. " +
        "That needs one of: a roll-forward (an opening and a closing balance of the same measure with " +
        "movements between them), a column the code declares to be the sum of other columns, or a " +
        "measure that can be followed back through more than one table.",
      "   "
    ),
    ""
  ];

  for (const entry of suite.skipped) {
    lines.push(`   ${entry.table}  (${entry.layer} layer)`);
    for (const reason of entry.reasons) lines.push(...wrap(`- ${reason}`, "     "));
    lines.push("");
  }

  lines.push(...wrap(platformNote(platform), "   "), `   ${RULE} */`, "");
  return { filename: NO_BUSINESS_CHECKS, sql: `${lines.join(NEWLINE)}${NEWLINE}SELECT 1 AS nothing_to_check;${NEWLINE}` };
}

/** The plain-text summary written beside the scripts, so the folder explains itself. */
export function summarizeBusinessReconciliation(suite: BusinessReconciliationSuite, generatedAt: Date): string {
  const lines = [
    `Business reconciliation for ${suite.folderName}`,
    `Generated: ${generatedAt.toISOString()}`,
    "",
    `${suite.stats.reportCount} reporting table(s), ${suite.stats.checkCount} check(s), ` +
      `${suite.stats.commentedCount} with a reviewer-model comment.`,
    "",
    "One .sql per reporting table — the tables this pipeline ends at, which are the ones the business",
    "reads. Each returns thirteen columns:",
    "  check_seq, check_name, business_term, source_table, target_table,",
    "  period_slice, period, source_value, target_value, difference, accuracy, status, comments",
    "",
    "Four kinds of check, none of which the per-hop or per-layer files can express:",
    "  roll-forward      opening balance + every movement = closing balance, per period",
    "  stated identity   a column the SQL declares to be the sum of other columns still is",
    "  period continuity one period's closing balance is a later period's opening balance",
    "  measure trace     one business term totalled at every table it passes through",
    "",
    "source_value is what the report should show and target_value is what it does, so difference is",
    "target minus source. accuracy is how much of the expected value the report still carries and",
    "status is graded from it: 100.00% passes, below 75% fails, anything between reviews.",
    ...(suite.notice ? ["", `Note: comments is empty — ${suite.notice}`] : []),
    ""
  ];

  for (const script of suite.scripts) {
    lines.push(
      `${script.filename} (${script.table}, ${script.layer} layer): ${script.checkCount} check(s) — ` +
        `${script.walkCount} roll-forward(s), ${script.identityCount} stated identit` +
        `${script.identityCount === 1 ? "y" : "ies"}, ${script.traceCount} measure trace(s)` +
        `${script.commentedCount > 0 ? `, ${script.commentedCount} explained` : ""}`
    );
  }

  if (suite.skipped.length > 0) {
    lines.push(
      "",
      "Tables this pipeline ends at with no business check derivable from their SQL:",
      ...suite.skipped.map((entry) => `  ${entry.table} (${entry.layer} layer)`)
    );
  }

  return `${lines.join("\n")}\n`;
}
