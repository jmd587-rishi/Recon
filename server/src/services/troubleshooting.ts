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
const MAX_QUERIES = 24;

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

export interface TargetDrillDowns {
  target: string;
  hopLabel: string;
  queries: DrillDown[];
}

export interface TroubleshootingPlan {
  /** Per target, in hop order — already capped. */
  targets: TargetDrillDowns[];
  /** Queries that fit within the cap. */
  shown: number;
  /** Queries left out by it, so the document can say so rather than quietly truncating. */
  omitted: number;
  /** Targets for which nothing could be built, and why — usually no recoverable join key. */
  withoutQueries: string[];
}

/**
 * The drill-downs for a whole project, capped.
 *
 * Capped rather than complete because the document is read start to finish and a warehouse with forty
 * targets would bury every other section under generated SQL. What is cut is said out loud, and the
 * patterns are identical across targets, so a reader who needs one that isn't here can copy the
 * nearest and change the table name.
 */
export function buildTroubleshootingPlan(
  hops: { label: string; targets: ReconTargetFacts[] }[],
  maxQueries = MAX_QUERIES
): TroubleshootingPlan {
  const targets: TargetDrillDowns[] = [];
  const withoutQueries: string[] = [];
  let shown = 0;
  let omitted = 0;

  for (const hop of hops) {
    for (const facts of hop.targets) {
      const queries = drillDownsFor(facts);
      if (queries.length === 0) {
        withoutQueries.push(facts.target);
        continue;
      }

      const room = Math.max(0, maxQueries - shown);
      if (room === 0) {
        omitted += queries.length;
        continue;
      }

      const kept = queries.slice(0, room);
      omitted += queries.length - kept.length;
      shown += kept.length;
      targets.push({ target: facts.target, hopLabel: hop.label, queries: kept });
    }
  }

  return { targets, shown, omitted, withoutQueries };
}
