import type { ReconCheckKind } from "../types/index.js";
import { isEmittableIdentifier } from "./sqlColumns.js";
import { distinctGrainCount, measureExpr, type ReconSource, type ReconTargetFacts } from "./reconciliationScripts.js";

/**
 * What to do when a check comes back REVIEW or FAIL — the step after the status table.
 *
 * The reconciliation scripts say *whether* a hop ties out. They deliberately don't say what to do
 * about it, because a file that tried to would be mostly prose and would get skimmed. So the next
 * step lives here and is written into the document instead, which is the thing people actually read
 * before they open a terminal.
 *
 * **The two halves come from different places, and keeping them apart is the whole design.**
 *
 * The *interpretation* is canned. What a duplicate-key failure means — the grain isn't what the key
 * says it is, something fanned out — is a property of the check kind, not of anyone's pipeline. There
 * are seven kinds, `ReconCheckKind` is closed, so seven entries cover every project Recon will ever
 * scan. Writing them once is right; asking a model to re-derive the same seven paragraphs per run
 * would cost a call per project to produce worse and less consistent text.
 *
 * The *query* is generated, and has to be: a drill-down naming `<source>` and `<join key>` is worth
 * running and one naming a column the table hasn't got is worth less than nothing. Every query below
 * is built from the same `ReconTargetFacts` the checks themselves are built from, so it can only name
 * columns the project defines, and it is filtered through `isEmittableIdentifier` for the same reason
 * `targetFacts` filters — `SUM(year over year (%))` is a syntax error that stops the file, not a
 * wrong answer.
 *
 * Note this is *not* the same judgement as `layerReconciliation.ts`'s `comments` column, which is left
 * blank rather than canned. That column answers "why did these two specific numbers differ", which
 * cannot be known without reading this pipeline's code. This answers "what does this kind of failure
 * mean and what should I run next", which genuinely does not vary by project.
 *
 * The SQL stays portable — no `TOP`/`LIMIT`, no vendor functions, `FULL OUTER JOIN` rather than
 * anything dialect-specific — so it runs on SQL Server and Databricks SQL alike, like everything else
 * Recon emits.
 */

/** Enough drill-downs to cover the pipeline's shapes without turning the document into a query dump. */
const MAX_QUERIES = 18;
/**
 * And a per-table share of that budget, so the first two tables can't spend it all.
 *
 * `drillDownsFor` returns its queries most-diagnostic first, so a table's first three are the fan-out
 * probe, the null-key probe and the one drift or grain check that applies — which is the order someone
 * works in anyway. The fourth onwards repeat a shape already shown for a different source.
 */
const MAX_PER_TARGET = 3;

/** What to suspect first when a check of each kind fails, and where to look. Canned by design. */
export const FAILURE_GUIDE: Record<ReconCheckKind, { suspect: string; nextStep: string }> = {
  row_count: {
    suspect:
      "A filter the transformation applies, or a join that dropped rows (INNER against a source with " +
      "gaps) or multiplied them (a source holding more than one row per join key).",
    nextStep:
      "Check the hop's listed filters first — those differences are expected. If they don't account " +
      "for it, run the fan-out probe for each source: a source with duplicate join keys inflates every " +
      "count and every total downstream of it."
  },
  measure_totals: {
    suspect:
      "Rows survived but values changed: a cast that truncated, an ISNULL that moved a total, or a " +
      "join fan-out counting the same amount more than once.",
    nextStep:
      "If the row count for the same pair passed, the rows are intact and the arithmetic is not — " +
      "run the per-key total comparison to find which keys drifted. If the row count also failed, " +
      "fix that first; the totals are almost certainly downstream of the same cause."
  },
  category_values: {
    suspect:
      "A value appeared or vanished — a CASE with an unhandled branch, a mapping table missing a row, " +
      "or a default like 'TBC' standing in for an unmapped input.",
    nextStep:
      "Compare the two value sets directly with the query below. A value only on the target side is " +
      "usually a literal or a default the transformation introduced."
  },
  missing_keys: {
    suspect:
      "Records were dropped: an INNER JOIN to a lookup that has no matching row, a WHERE that excludes " +
      "them, or a source row whose join key is NULL and so matches nothing.",
    nextStep:
      "The script's appendix already lists which keys went missing. Run the NULL join-key probe on the " +
      "source as well — those rows never reach the target under any inner join, and they never show up " +
      "as a mismatched key because they have no key to mismatch on."
  },
  orphan_keys: {
    suspect:
      "Rows in the target that no source accounts for: a second writer this document's lineage doesn't " +
      "record, a left join manufacturing rows, or a reload that didn't clear the table first.",
    nextStep:
      "Take the keys from the appendix query and search the project for other statements writing this " +
      "table. More than one writer is the common cause and the lineage section lists what Recon found."
  },
  duplicate_keys: {
    suspect:
      "The grain isn't what the key says it is — nearly always a join that fanned out, occasionally a " +
      "key inferred from column naming that was never really unique.",
    nextStep:
      "Check the key's confidence in the hop table first: an inferred key that duplicates may simply be " +
      "the wrong key. If it is declared, run the fan-out probe on each source to find which join " +
      "multiplied the rows."
  },
  null_keys: {
    suspect:
      "Rows whose key columns are NULL — an outer join that found no match, or a source column that was " +
      "never populated.",
    nextStep:
      "These rows can't be joined to or reconciled anywhere downstream. Find which source they came " +
      "from with the NULL join-key probe, then decide whether they should be filtered out at the source " +
      "or defaulted."
  },
  custom: {
    suspect:
      "This check was written by the reviewer model for this specific transformation, so what it proves " +
      "is stated in its own description in the script.",
    nextStep:
      "Read the check's comment in the script — it names the part of the transformation it is testing. " +
      "These are the checks worth reading before running, since they were written from the code rather " +
      "than derived from the schema."
  }
};

/**
 * Why a row of the *per-layer column report* can come back REVIEW — the same canned/generated split
 * as above, applied to `layerReconciliation.ts`'s ten columns.
 *
 * That report is read a row at a time — `source_table | target_table | source_column | target_column |
 * type | source_value | target_value | accuracy | result | comments` — and every row is the same three
 * questions: what is being compared, how the code reaches the source, and how far apart the two sides
 * are. All three are printed on the row itself, so what a REVIEW *could* mean is decidable from the row
 * without knowing the project, which is what makes it worth writing once here.
 *
 * What this cannot say is which of those causes applies to a given row: that needs the transformation
 * SQL, and it is exactly what the report's own `comments` column carries, written by the reviewer model
 * against the code. This table sends a reader to the right suspect; that column names it.
 */
export interface LayerReviewCause {
  /** What the reader is looking at on the row — quoted from the report's own columns. */
  signal: string;
  /** What a REVIEW on such a row usually comes from, likeliest first. */
  meaning: string;
}

/**
 * The same idea again, applied to `businessReconciliation.ts`'s four checks.
 *
 * Keyed on the check rather than on what a row shows, because unlike the other two reports this one's
 * rows are not alike: a roll-forward that does not balance and a measure trace that does not are two
 * different investigations, and which one the reader is looking at is printed in `check_name`.
 *
 * The causes here are properties of the *kind* of report — every snowball that stops balancing stops
 * for one of a short list of reasons, and that list is the same for every project — which is why they
 * are written once here rather than asked of a model. What needs a model is which of them applies to
 * this project's SQL, and that is what the file's own `comments` column carries.
 */
export interface BusinessCheckCause {
  /** As `check_name` prints it. */
  check: string;
  /** What the check asserts, in one clause, so the table reads without the script beside it. */
  asserts: string;
  /** What a difference usually comes from, likeliest first. */
  meaning: string;
}

export const BUSINESS_CHECK_GUIDE: BusinessCheckCause[] = [
  {
    check: "roll-forward",
    asserts: "the opening balance plus every movement equals the closing balance, within one period",
    meaning:
      "The movement buckets do not partition the change: two CASE branches that can both be true for " +
      "one row count it twice, and a set of branches with a gap between them loses it entirely — the " +
      "classic pair being a customer-churn and a product-churn rule that overlap on the month a " +
      "customer's last product ends. After that: a movement stored with the opposite sign to the one " +
      "the walk adds it with, a scaffold or calendar join that invents rows the movements were never " +
      "computed for, and an ISNULL(x, 0) that turns a missing prior balance into zero rather than " +
      "carrying it forward."
  },
  {
    check: "stated identity",
    asserts: "a column the SQL declares to be the sum of other columns still equals them",
    meaning:
      "This one is arithmetic the code itself wrote, so a difference is rarely the logic: it is the " +
      "table not being what the code produces. A partial or incremental load that refreshed some " +
      "columns and not others, a second script building the same table with a different definition, or " +
      "a manual correction applied to the total and not to its parts. Check when the table was last " +
      "rebuilt whole before reading the transformation."
  },
  {
    check: "period continuity",
    asserts: "one period's closing balance is a later period's opening balance",
    meaning:
      "The opening balance is computed over the wrong window or the wrong partition: a LAG partitioned " +
      "by a key the report is not grouped by, an ORDER BY that is not the period column, or a rolling " +
      "frame whose length does not match the slice it is written for. A gap in the calendar also shows " +
      "up here — the check pairs each period with the one really before it, so a missing month makes " +
      "two real periods adjacent."
  },
  {
    check: "measure trace",
    asserts: "a business measure's total is the same at both ends of one hop of the pipeline",
    meaning:
      "The hop it names is where the measure changed, which narrows it to one statement. A WHERE that " +
      "drops rows, a join that multiplies them, a TRY_CAST that nulls values the column's type could " +
      "not hold — that last one is the usual answer at the raw-to-stage hop, where amounts arrive as " +
      "text. A trace whose first hops pass and whose last one does not is a report-level filter, not a " +
      "pipeline problem."
  }
];

export const LAYER_REVIEW_GUIDE: LayerReviewCause[] = [
  {
    signal: "A measure column — the row totals both sides",
    meaning:
      "Rows survived but the amounts did not: a WHERE that excluded some of them, a join that " +
      "multiplied them, a CAST or TRY_CONVERT that truncated or nulled non-numeric values, or an " +
      "ISNULL/COALESCE default that moved the total."
  },
  {
    signal: "Any other column — the row counts distinct values on both sides",
    meaning:
      "Values were added or lost rather than rows: a CASE or a mapping collapsing several source " +
      "values into one, a default literal the source never held, or a filter that removed the only " +
      "rows carrying a value. Unmatched rows arriving as NULL also count as a value lost, since no " +
      "distinct count counts NULL."
  },
  {
    signal: "REVIEW with `accuracy` near 100 — the two numbers are close",
    meaning:
      "A handful of rows or values rather than a structural difference: a filter with a narrow effect, " +
      "a few unmatched keys arriving as NULL, or a cast that lost the odd non-numeric value. Read it " +
      "beside the filters listed for that table — a small gap the transformation explains is the " +
      "transformation working. Note that the percentage is floored, so 99.99% can be one row in a " +
      "million rather than one in ten thousand."
  },
  {
    signal: "FAIL — under 75%, so a quarter or more of the source's value never arrived",
    meaning:
      "Something structural: the wrong source, a join matching nothing, a predicate that excluded " +
      "nearly every row, or a column that is not what its name says it is. Take these before the " +
      "reviews — they are usually one cause showing up on every column of the same pair at once."
  },
  {
    signal: "`source_column` and `target_column` holding different names",
    meaning:
      "The column was renamed or derived on the way in, so the comparison runs against the expression " +
      "that builds it. Read that expression before suspecting the data."
  },
  {
    signal: "`type` FROM",
    meaning:
      "This source drives the target's rows, so a difference is the transformation's own doing — its " +
      "WHERE, its GROUP BY, or a dedupe. Check it against the filters listed for that table first."
  },
  {
    signal: "`type` LEFT JOIN",
    meaning:
      "Source rows with no match are kept as NULL rather than dropped, so the target can hold fewer " +
      "distinct values while holding the same rows. A duplicate key on this source instead multiplies " +
      "every row and every total."
  },
  {
    signal: "`type` INNER JOIN",
    meaning:
      "Rows with no match are dropped, so a count and a total can move together. Suspect this first " +
      "when several columns of the same pair review at once."
  },
  {
    signal: "`type` READ SEPARATELY",
    meaning:
      "The source is read by the transformation but its rows never reach the target — typically a " +
      "lookup of a single value — so the two sides are not the same population and the row is context " +
      "rather than a finding."
  }
];

/** Human labels for the kinds, matching the titles the scripts use. */
export const KIND_LABELS: Record<ReconCheckKind, string> = {
  row_count: "Row count",
  measure_totals: "Measure totals",
  category_values: "Category values",
  missing_keys: "Missing keys",
  orphan_keys: "Orphan keys",
  duplicate_keys: "Duplicate keys",
  null_keys: "Null keys",
  custom: "Model-written checks"
};

/** One ready-made query, with the sentence that says when to reach for it. */
export interface DrillDown {
  /** What it diagnoses, used as the heading. */
  title: string;
  /** Which check failing should send you here. */
  triggeredBy: ReconCheckKind[];
  target: string;
  source: string | null;
  /** One line on what a returned row means — the reason to run it rather than what it does. */
  reading: string;
  sql: string;
}

function emittable(columns: string[]): string[] {
  return columns.filter((column) => isEmittableIdentifier(column));
}

/**
 * Does this source hold more than one row per join key?
 *
 * The single highest-value drill-down in the set, because a lookup joined in for its columns is
 * assumed one-row-per-key by whoever wrote the join and nothing enforces it. When that assumption is
 * wrong every row count and every measure total downstream inflates together, which reads as "the
 * transformation is wrong" when the defect is one duplicated reference row.
 */
function fanOutProbe(entry: ReconSource, target: string): DrillDown | null {
  const columns = emittable(entry.join.columns);
  if (columns.length === 0) return null;

  const list = columns.join(", ");
  return {
    title: `Does ${entry.source} fan out?`,
    triggeredBy: ["row_count", "measure_totals", "duplicate_keys"],
    target,
    source: entry.source,
    reading:
      entry.role === "lookup"
        ? `${entry.source} is joined in for its columns${
            entry.joinKind === "from" ? "" : ` (${entry.joinKind.toUpperCase()} JOIN)`
          }, so it is assumed to hold one row per key. Any row this returns breaks that assumption and ` +
          `multiplies the rows and totals of ${target}.`
        : `Any row returned means ${entry.source} holds the same key more than once, which multiplies ` +
          `every row it joins to in ${target}.`,
    sql: [
      `-- ${entry.source}: keys appearing more than once.`,
      "-- Rows returned = this source multiplies its join. Empty = the join is safe.",
      `SELECT ${list}, COUNT(*) AS rows_per_key`,
      `FROM ${entry.source}`,
      `GROUP BY ${list}`,
      "HAVING COUNT(*) > 1;"
    ].join("\n")
  };
}

/**
 * Source rows whose join key is NULL.
 *
 * These are invisible to every other check in the suite: they never appear as a missing key, because
 * they have no key to miss with, and they silently vanish under any inner join. A row-count gap that
 * no filter explains is very often this.
 */
function nullJoinKeyProbe(entry: ReconSource, target: string): DrillDown | null {
  const columns = emittable(entry.join.columns);
  if (columns.length === 0) return null;

  const predicate = columns.map((column) => `${column} IS NULL`).join("\n    OR ");
  return {
    title: `Rows in ${entry.source} that can never join`,
    triggeredBy: ["missing_keys", "row_count", "null_keys"],
    target,
    source: entry.source,
    reading:
      `A NULL join key matches nothing, so these rows never reach ${target} and never show up as a ` +
      "mismatched key either. They are the usual explanation for a row-count gap no filter accounts for.",
    sql: [
      `-- ${entry.source}: rows whose join key is NULL and so match nothing.`,
      `SELECT COUNT(*) AS rows_with_null_join_key`,
      `FROM ${entry.source}`,
      `WHERE ${predicate};`
    ].join("\n")
  };
}

/**
 * Which keys the totals drifted on, source against target.
 *
 * Only written where it is actually answerable: the source has to drive the rows and keep the grain,
 * or the two sides aren't the same population and every key would report a difference. Both sides are
 * aggregated before the join so a duplicate on either one can't double-count into the comparison —
 * which is also what makes this safe to run *before* the fan-out probe has been cleared.
 */
function measureDriftProbe(entry: ReconSource, facts: ReconTargetFacts): DrillDown | null {
  if (entry.role !== "driver" || entry.grainChanged) return null;

  const keys = emittable(entry.join.columns);
  if (keys.length === 0) return null;

  const untyped = new Set(facts.untypedMeasures);
  const pair = entry.measures.find(
    (measure) => isEmittableIdentifier(measure.target) && isEmittableIdentifier(measure.source)
  );
  if (!pair) return null;

  const keyList = keys.join(", ");
  const sourceTotal = `SUM(${measureExpr(pair.source, !untyped.has(pair.target))})`;
  const targetTotal = `SUM(${measureExpr(pair.target, !untyped.has(pair.target))})`;
  const on = keys.map((column, i) => `${i === 0 ? "  ON " : " AND "}s.${column} = t.${column}`).join("\n");

  return {
    title: `Which keys ${pair.target} drifted on`,
    triggeredBy: ["measure_totals"],
    target: facts.target,
    source: entry.source,
    reading:
      `Each row is one key where the totals disagree, with the size and direction of the gap. A handful ` +
      "of keys points at specific data; every key drifting by the same ratio points at a cast or a " +
      "fan-out.",
    sql: [
      `-- ${pair.target}: per-key totals, ${entry.source} against ${facts.target}.`,
      "-- Both sides are aggregated before the join, so a duplicate on either can't double-count here.",
      "SELECT",
      `  COALESCE(${keys.map((c) => `s.${c}`).join(", ")}, ${keys.map((c) => `t.${c}`).join(", ")}) AS ${keys[0]},`,
      "  s.source_total,",
      "  t.target_total,",
      "  COALESCE(t.target_total, 0) - COALESCE(s.source_total, 0) AS difference",
      "FROM (",
      `  SELECT ${keyList}, ${sourceTotal} AS source_total`,
      `  FROM ${entry.source}`,
      `  GROUP BY ${keyList}`,
      ") s",
      "FULL OUTER JOIN (",
      `  SELECT ${keyList}, ${targetTotal} AS target_total`,
      `  FROM ${facts.target}`,
      `  GROUP BY ${keyList}`,
      ") t",
      on,
      "WHERE COALESCE(s.source_total, 0) <> COALESCE(t.target_total, 0);"
    ].join("\n")
  };
}

/**
 * What a grouped hop's row counts are *supposed* to be, so an expected difference isn't chased.
 *
 * A transformation that aggregates must produce fewer rows than it reads. Recon's row-count check
 * already knows that and compares distinct group keys instead, but the reader looking at a REVIEW
 * still needs to see the arithmetic to believe it.
 */
function grainProbe(entry: ReconSource, target: string): DrillDown | null {
  if (!entry.grainChanged) return null;
  const columns = emittable(entry.grainColumns);
  if (columns.length === 0) return null;

  return {
    title: `Expected row loss from grouping ${entry.source}`,
    triggeredBy: ["row_count"],
    target,
    source: entry.source,
    reading:
      `The transformation groups ${entry.source} by (${columns.join(", ")}), so ${target} is expected to ` +
      "have fewer rows. These two numbers should be equal — if they are, the row-count difference is " +
      "the grouping and nothing else.",
    sql: [
      `-- ${entry.source} grouped to ${target}'s grain, against ${target}'s own rows.`,
      "SELECT",
      `  ${distinctGrainCount(entry.source, columns)} AS expected_rows,`,
      `  (SELECT COUNT(*) FROM ${target}) AS actual_rows;`
    ].join("\n")
  };
}

/** Every value of a label column on each side, so an appeared/vanished value can be named. */
function categoryProbe(entry: ReconSource, target: string): DrillDown | null {
  const pair = entry.categories.find(
    (category) => isEmittableIdentifier(category.target) && isEmittableIdentifier(category.source)
  );
  if (!pair) return null;

  return {
    title: `Values of ${pair.target} on each side`,
    triggeredBy: ["category_values"],
    target,
    source: entry.source,
    reading:
      "A value present on only one side is the finding. On the target side only, it was introduced by " +
      "the transformation — usually a CASE default or a literal standing in for an unmapped input.",
    sql: [
      `-- ${pair.target}: which values exist where.`,
      `SELECT ${pair.source} AS value, 'source' AS side, COUNT(*) AS rows`,
      `FROM ${entry.source}`,
      `GROUP BY ${pair.source}`,
      "UNION ALL",
      `SELECT ${pair.target} AS value, 'target' AS side, COUNT(*) AS rows`,
      `FROM ${target}`,
      `GROUP BY ${pair.target};`
    ].join("\n")
  };
}

/**
 * Every drill-down worth offering for one target, most-diagnostic first.
 *
 * The order is the order someone should actually work in: prove the joins are clean before believing
 * anything the totals say, because a fan-out makes every other check fail at once and fixing it fixes
 * them together.
 */
export function drillDownsFor(facts: ReconTargetFacts): DrillDown[] {
  const reconciled = facts.perSource.filter((entry) => entry.role !== "incidental");

  return [
    // Lookups first: a lookup fan-out is the failure that looks like everything else being broken.
    ...reconciled.filter((e) => e.role === "lookup").flatMap((e) => fanOutProbe(e, facts.target) ?? []),
    ...reconciled.filter((e) => e.role !== "lookup").flatMap((e) => fanOutProbe(e, facts.target) ?? []),
    ...reconciled.flatMap((e) => nullJoinKeyProbe(e, facts.target) ?? []),
    ...reconciled.flatMap((e) => grainProbe(e, facts.target) ?? []),
    ...reconciled.flatMap((e) => measureDriftProbe(e, facts) ?? []),
    ...reconciled.flatMap((e) => categoryProbe(e, facts.target) ?? [])
  ];
}

/** The five things a reconciliation can rest on that the project does not state outright. */
export type ConcernKind = "no_key" | "no_columns" | "inferred_key" | "lookup" | "incidental";

/**
 * Something a table's reconciliation *rests on* rather than proves, and what to do about it.
 *
 * This is the gate on the drill-down queries. A document that prints six queries for every table is a
 * query dump whatever it is titled, and a reader stops distinguishing the table with a guessed key
 * from the one with a declared one. So the queries follow the concerns: a target with nothing to flag
 * is counted and not written about, and a target with something gets the concern, the suggestion, and
 * only then the SQL that would settle it.
 *
 * Decided from the same `ReconTargetFacts` the checks are — a declared key, a recoverable column list,
 * a source's role in the join — so a concern is raised by what the code says, never by a judgement
 * about the *data*, which Recon never sees.
 */
export interface TargetConcern {
  kind: ConcernKind;
  /** Lower sorts first: what a reader should look at before anything else. */
  rank: number;
  /** What is unproven, in one sentence. */
  issue: string;
  /** What settles it. */
  suggestion: string;
}

/**
 * The five things that can be assumed, written once each.
 *
 * Deliberately not parameterised by table. Fourteen tables reconciled on a guessed key is *one* fact
 * about the project, and a findings table that states it fourteen times in fourteen near-identical
 * sentences is one nobody reads to the bottom of — while the table-specific half (which columns the
 * guessed key is, which source is the lookup) is already printed against each table in the hop and
 * pair tables. So the text is per kind and the tables are listed beside it by `groupConcerns`.
 */
const CONCERNS: Record<ConcernKind, { rank: number; issue: string; suggestion: string }> = {
  no_key: {
    rank: 1,
    issue:
      "No join key could be found between the table and its sources, so the two sides are compared only " +
      "in bulk — row counts and totals, never row by row.",
    suggestion:
      "Add the table's CREATE TABLE so its key is declared, or reconcile it on a key you know by hand."
  },
  no_columns: {
    rank: 2,
    issue:
      "A table on one side has no recoverable column list — nothing in the project defines it with " +
      "CREATE TABLE or builds it with a named select list — so its columns are not compared at all.",
    suggestion: "Add that table's DDL to the folder and re-run; the column-level checks appear on their own."
  },
  inferred_key: {
    rank: 3,
    issue:
      "The join key was inferred from column naming rather than declared by a primary key, so the " +
      "row-level checks rest on a guess about the grain. Each table's inferred key is named in its stage " +
      "section above.",
    suggestion:
      "Confirm the key is unique — the duplicate-key check in the same script proves or disproves it, " +
      "and an inferred key that duplicates is usually the wrong key."
  },
  lookup: {
    rank: 4,
    issue:
      "A source is joined in for its columns rather than its rows, so it is assumed to hold one row per " +
      "key — nothing in the project enforces that, and a duplicate there inflates every count and total.",
    suggestion:
      "Run the fan-out probe for each of these before believing any count or total: one duplicated " +
      "reference row fails every other check at once."
  },
  incidental: {
    rank: 5,
    issue:
      "A table is read by the transformation without its rows reaching the target — typically a lookup " +
      "of a single value — so nothing reconciles it.",
    suggestion:
      "Check it is the single-value read it appears to be, rather than a source the lineage failed to connect."
  }
};

function concern(kind: ConcernKind): TargetConcern {
  return { kind, ...CONCERNS[kind] };
}

/** Everything worth flagging about one target, worst first. Empty means nothing is assumed here. */
export function concernsFor(facts: ReconTargetFacts): TargetConcern[] {
  const kinds: ConcernKind[] = [];

  if (facts.key.columns.length === 0) kinds.push("no_key");
  if (facts.columnSources.some((source) => source.columnCount === 0)) kinds.push("no_columns");
  if (facts.key.confidence === "inferred") kinds.push("inferred_key");
  if (facts.perSource.some((entry) => entry.role === "lookup")) kinds.push("lookup");
  if (facts.incidentalSources.length > 0) kinds.push("incidental");

  return kinds.map(concern).sort((a, b) => a.rank - b.rank);
}

/** One row per kind, with the tables it applies to — the shape the findings table is read in. */
export interface ConcernGroup {
  kind: ConcernKind;
  issue: string;
  suggestion: string;
  /** In the order the plan visits them, which is pipeline order. */
  tables: string[];
}

export function groupConcerns(targets: TargetDrillDowns[]): ConcernGroup[] {
  const byKind = new Map<ConcernKind, string[]>();
  for (const entry of targets) {
    for (const item of entry.concerns) {
      byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), entry.target]);
    }
  }

  return Array.from(byKind.entries())
    .map(([kind, tables]) => ({ kind, issue: CONCERNS[kind].issue, suggestion: CONCERNS[kind].suggestion, tables }))
    .sort((a, b) => CONCERNS[a.kind].rank - CONCERNS[b.kind].rank);
}

export interface TargetDrillDowns {
  target: string;
  hopLabel: string;
  /** Why this target is in the plan at all. Never empty — an empty one keeps the target out. */
  concerns: TargetConcern[];
  /** May be empty: a target with no recoverable join key has concerns but nothing to run. */
  queries: DrillDown[];
}

export interface TroubleshootingPlan {
  /** Per target, in hop order — only the ones with something flagged, already capped. */
  targets: TargetDrillDowns[];
  /** Queries that fit within the cap. */
  shown: number;
  /** Queries left out by it, so the document can say so rather than quietly truncating. */
  omitted: number;
  /** Flagged targets with no query to offer, and no way to build one — usually no join key. */
  withoutQueries: string[];
  /** Targets nothing was flagged for. Counted rather than listed: this is the good news line. */
  clean: number;
  /**
   * Whether this project has a business reconciliation file at all.
   *
   * The guide for those checks is printed only when there is one to read it against — a project with no
   * reporting table would otherwise get a page of advice about a report it has not got.
   */
  hasBusinessChecks: boolean;
}

/**
 * The issues in a project and the queries that settle them, capped.
 *
 * Capped rather than complete because the document is read start to finish and a warehouse with forty
 * targets would bury every other section under generated SQL. What is cut is said out loud, and the
 * patterns are identical across targets, so a reader who needs one that isn't here can copy the
 * nearest and change the table name.
 */
export function buildTroubleshootingPlan(
  hops: { label: string; targets: ReconTargetFacts[] }[],
  maxQueries = MAX_QUERIES,
  maxPerTarget = MAX_PER_TARGET,
  hasBusinessChecks = false
): TroubleshootingPlan {
  const targets: TargetDrillDowns[] = [];
  const withoutQueries: string[] = [];
  let shown = 0;
  let omitted = 0;
  let clean = 0;

  for (const hop of hops) {
    for (const facts of hop.targets) {
      const concerns = concernsFor(facts);
      if (concerns.length === 0) {
        clean++;
        continue;
      }

      const queries = drillDownsFor(facts);
      const room = Math.min(Math.max(0, maxQueries - shown), maxPerTarget);
      const kept = queries.slice(0, room);
      omitted += queries.length - kept.length;
      shown += kept.length;
      if (queries.length === 0) withoutQueries.push(facts.target);

      targets.push({ target: facts.target, hopLabel: hop.label, concerns, queries: kept });
    }
  }

  return { targets, shown, omitted, withoutQueries, clean, hasBusinessChecks };
}
