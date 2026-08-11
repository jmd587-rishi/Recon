import type { ReconCheck, ReconCheckKind, ReconScript } from "../types/index.js";
import {
  countableAs,
  distinctGrainCount,
  measureExpr,
  type ReconHopFacts,
  type ReconTargetFacts
} from "./reconciliationScripts.js";
import { platformNote, type SqlPlatform } from "./sqlPlatform.js";
import { splitSqlTablesByOp, stripSqlComments } from "./tableLineage.js";

/**
 * One hop, one file, one query.
 *
 * `reconciliationScripts.ts` writes the checks a table at a time, each as its own statement — the
 * shape you want when you are investigating a single table. This writes the same checks the other way
 * round: every table of the hop folded into a single `WITH … SELECT … UNION ALL …` that returns one
 * row per check, so running one query gives the whole hop as a status table you can eyeball, save with
 * `CREATE TABLE … AS`, or schedule.
 *
 * The folding is what makes it one query. Each table and each pair contributes a one-row aggregate CTE
 * (`COUNT(*)`, `SUM(measure)`, `COUNT(DISTINCT label)`, an anti-join count), and the final SELECT
 * cross-joins those single rows into comparisons. Nothing is scanned twice for two different checks,
 * unlike the per-table scripts, where every `(SELECT COUNT(*) FROM t)` is its own scan.
 *
 * Two things do not survive the fold, and both are kept rather than dropped:
 *   - A check that lists rows (*which* keys went missing) cannot be a row of a status table, so it
 *     becomes a count here and its full query is written into the appendix at the foot of the file.
 *   - A model-written check is arbitrary SQL. It is rewritten to `SELECT COUNT(*) FROM (<its FROM
 *     onwards>)` when that provably preserves its meaning (`foldToCount`), and skipped into the
 *     appendix when it doesn't.
 *
 * The SQL stays portable — no TOP/LIMIT, no vendor functions — like everything else this folder emits.
 */

/** Every value column is cast to this, so a COUNT branch and a SUM branch can share a UNION column. */
const VALUE_TYPE = "DECIMAL(38, 6)";
/** Filter text quoted in the per-table header before it is cut. */
const MAX_FILTER_CHARS = 160;

// ---- small SQL helpers ----

/**
 * A SQL string literal, with the two characters that could escape it neutralised.
 *
 * Doubling the quote is what makes it a literal. Dropping the semicolon is what keeps the file usable:
 * the whole bundle is a single statement, so one `;` inside a literal would turn it into two for
 * everything that splits on the character rather than parsing — plenty of runners, migration tools and
 * `sqlcmd` wrappers do, and so does the obvious way to check "is this one statement".
 */
function quoted(text: string): string {
  return `'${text.replace(/'/g, "''").replace(/;/g, ",")}'`;
}

function cast(expr: string): string {
  return `CAST(${expr} AS ${VALUE_TYPE})`;
}

const NO_VALUE = `CAST(NULL AS ${VALUE_TYPE})`;

/** `amount` -> `sum_amount`, safe as a CTE column name whatever the source identifier looked like. */
function sumAlias(column: string): string {
  return `sum_${column.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** `status` -> `distinct_status`, the same way. */
function distinctAlias(column: string): string {
  return `distinct_${column.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function padded(index: number): string {
  return String(index).padStart(2, "0");
}

// ---- the pieces a bundle is assembled from ----

interface Cte {
  name: string;
  /** Everything between the parentheses, already indented four spaces. */
  body: string;
  /** Comment line written above the definition — used to head each table's block. */
  comment?: string;
}

interface BundleRow {
  checkName: string;
  target: string;
  /**
   * Null for a check that looks at the target alone: duplicates, null keys, a model-written check
   * whose SQL names no source. Those rows are dropped before rendering — every row of this table
   * compares two tables — and `targetOnlyNote` says which were left out.
   */
  source: string | null;
  /** What the numbers on this row are measuring, e.g. `rows` or `SUM(amount)`. */
  metric: string;
  sourceValue: string;
  targetValue: string;
  /** Reads 0 when the check passes — every row obeys this, which is what makes the table scannable. */
  difference: string;
  /**
   * The boolean condition under which this check passes — the one place a row says what "right" is.
   *
   * Kept as the condition rather than as a rendered `CASE` so a caller adding a column that depends on
   * the same verdict — an explanation, a severity — writes it from this and cannot drift out of step.
   */
  passWhen: string;
  /** What the row reads when `passWhen` doesn't hold: `'REVIEW'` or `'FAIL'`. */
  failStatus: string;
  /** The FROM clause tying the row to its CTEs. */
  from: string;
}

/** Derived checks that list rows: the fold turns each into a count, so its query goes to the appendix. */
const LISTING_KINDS = new Set<ReconCheckKind>(["missing_keys", "orphan_keys", "duplicate_keys", "category_values"]);

/** A query that could not become a status row, kept in the appendix so the detail is still to hand. */
interface Appendix {
  title: string;
  description: string;
  sql: string;
}

const COLUMNS = [
  "check_seq",
  "scope",
  "target_table",
  "source_table",
  "check_name",
  "metric",
  "source_value",
  "target_value",
  "difference",
  "status"
];

function renderRow(row: BundleRow, seq: number, scope: string, first: boolean): string {
  const values = [
    String(seq),
    quoted(scope),
    quoted(row.target),
    row.source === null ? "NULL" : quoted(row.source),
    quoted(row.checkName),
    quoted(row.metric),
    row.sourceValue,
    row.targetValue,
    row.difference,
    `CASE WHEN ${row.passWhen} THEN 'PASS' ELSE ${row.failStatus} END`
  ];

  const select = values
    .map((value, i) => `${i === 0 ? "SELECT " : "       "}${value}${first ? ` AS ${COLUMNS[i]}` : ""}`)
    .join(",\n");

  return `${select}\n${row.from}`;
}

function renderCte(cte: Cte): string {
  return `${cte.comment ? `${cte.comment}\n` : ""}${cte.name} AS (\n${cte.body}\n)`;
}

function statsCte(name: string, table: string, expressions: string[], comment?: string): Cte {
  return {
    name,
    comment,
    body: `    SELECT ${expressions.join(",\n           ")}\n    FROM ${table}`
  };
}

// ---- folding a model-written check into a countable subquery ----

/**
 * The offset of the statement's own `FROM`, ignoring any inside parentheses or string literals.
 */
function topLevelFrom(sql: string): number | null {
  let depth = 0;
  let closing: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (closing !== null) {
      if (ch === closing) closing = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      closing = ch;
      continue;
    }
    if (ch === "[") {
      closing = "]";
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && (ch === "f" || ch === "F") && /^from\b/i.test(sql.slice(i, i + 5)) && /[\s)]/.test(sql[i - 1] ?? " ")) {
      return i;
    }
  }

  return null;
}

/**
 * Rewrites a check's select list to a constant, so wrapping it in `SELECT COUNT(*) FROM (…)` counts
 * the rows it returns whatever it selected — including through a `GROUP BY … HAVING`, and without
 * tripping over an unaliased expression, which a derived table is not allowed to have.
 *
 * Returns null when that rewrite could change what the check means, which is every case the scan
 * can't be sure about: more than one statement, a leading CTE (a derived table may not contain one on
 * SQL Server), `SELECT DISTINCT` (whose row count depends on the list being replaced), a set operator
 * or `ORDER BY` (which the other branches or the derived table would reject), or no `FROM` of its own.
 * Callers put those in the appendix instead — a check that runs separately beats one folded wrongly.
 */
export function foldToCount(rawSql: string): string | null {
  const sql = stripSqlComments(rawSql).trim().replace(/;+\s*$/, "").trim();

  if (sql.length === 0 || sql.includes(";")) return null;
  if (!/^select\b/i.test(sql)) return null;
  if (/^select\s+distinct\b/i.test(sql)) return null;
  if (/\b(?:union|except|intersect)\b/i.test(sql)) return null;
  if (/\border\s+by\b/i.test(sql)) return null;

  const from = topLevelFrom(sql);
  if (from === null) return null;

  return `SELECT 1 AS flag\n${sql.slice(from).trim()}`;
}

// ---- one target table's contribution ----

interface TargetBundle {
  ctes: Cte[];
  rows: BundleRow[];
  /** Header lines describing this table's key, measures and filters. */
  header: string[];
  appendix: Appendix[];
  /** Checks left out because they compare the target with nothing — see `withSource`. */
  targetOnly: string[];
}

function tidyFilter(filter: string): string {
  const flat = filter.replace(/\s+/g, " ").trim();
  return flat.length > MAX_FILTER_CHARS ? `${flat.slice(0, MAX_FILTER_CHARS)}…` : flat;
}

/** Duplicate and null keys are a defect when the key is declared, and evidence the guess was wrong when it isn't. */
function keyFailStatus(facts: ReconTargetFacts): string {
  return facts.key.confidence === "declared" ? "'FAIL'" : "'REVIEW'";
}

function targetBundle(
  facts: ReconTargetFacts,
  script: ReconScript | undefined,
  index: number,
  platform: SqlPlatform
): TargetBundle {
  const prefix = `t${padded(index)}`;
  const ctes: Cte[] = [];
  const rows: BundleRow[] = [];
  const appendix: Appendix[] = [];

  const keyColumns = facts.key.columns;
  // A measure whose type nothing declares is converted before it is totalled — see `measureExpr`.
  const untyped = new Set(facts.untypedMeasures);
  const total = (measure: string) => `SUM(${measureExpr(measure, !untyped.has(measure), platform)})`;

  const targetExpressions = [
    "COUNT(*) AS row_count",
    ...(keyColumns.length > 0
      ? [`SUM(CASE WHEN ${keyColumns.map((c) => `${c} IS NULL`).join(" OR ")} THEN 1 ELSE 0 END) AS null_key_rows`]
      : []),
    ...facts.measureColumns.map((measure) => `${total(measure)} AS ${sumAlias(measure)}`),
    // A label is counted, never summed: how many distinct values it holds is the comparable number.
    ...facts.categoryColumns.map((column) => `COUNT(DISTINCT ${column}) AS ${distinctAlias(column)}`)
  ];

  const drivers = facts.perSource.filter((entry) => entry.role === "driver");
  const lookups = facts.perSource.filter((entry) => entry.role === "lookup");

  const header = [
    `${facts.target}  <-  ${facts.sources.join(", ") || "(no source supplies its rows)"}`,
    // What each source is *for* is the difference between a check and a distraction, so it is stated
    // here rather than left for the reader to work out from which rows appeared.
    `  rows come from: ${
      drivers
        .map((entry) => `${entry.source}${entry.grainColumns.length > 0 ? ` grouped by ${entry.grainColumns.join(" + ")}` : ""}`)
        .join(", ") || "nothing in this hop — the rows are generated, not read"
    }`,
    ...(lookups.length > 0 ? [`  joined for columns only (not row-counted): ${lookups.map((e) => e.source).join(", ")}`] : []),
    ...(facts.incidentalSources.length > 0
      ? [`  read but not reconciled (rows do not reach the target): ${facts.incidentalSources.join(", ")}`]
      : []),
    `  key: ${keyColumns.length > 0 ? `${keyColumns.join(", ")} (${facts.key.reason})` : "none found"}`,
    `  measures (totalled): ${facts.measureColumns.length > 0 ? facts.measureColumns.join(", ") : "none on both sides"}`,
    `  labels (values compared): ${facts.categoryColumns.length > 0 ? facts.categoryColumns.join(", ") : "none on both sides"}`,
    ...facts.knownFilters.map((filter) => `  filter the transformation applies: ${tidyFilter(filter)}`)
  ];

  ctes.push(
    statsCte(prefix, facts.target, targetExpressions, `-- ${padded(index)}. ${facts.target}  <-  ${facts.sources.join(", ")}`)
  );

  facts.perSource.forEach((entry, i) => {
    const { source, measures, categories } = entry;
    const name = `${prefix}_s${i + 1}`;
    const countable = countableAs(entry);
    ctes.push(
      statsCte(name, source, [
        // A source whose count means nothing against the target still needs the CTE for its measures
        // and labels; the count is simply not put on a row.
        "COUNT(*) AS row_count",
        ...(countable && entry.grainColumns.length > 0
          ? [`${distinctGrainCount(source, entry.grainColumns)} AS grain_count`]
          : []),
        // The column read is the source's own; the alias is keyed on the *target's* name so the row
        // below can compare `t.<alias>` with `s.<alias>` even where the two columns are named
        // differently — which they are whenever the transformation renames one.
        ...measures.map((measure) => `${total(measure.source)} AS ${sumAlias(measure.target)}`),
        ...categories.map((column) => `COUNT(DISTINCT ${column.source}) AS ${distinctAlias(column.target)}`)
      ])
    );
  });

  // One row per pair per label: how many values each side is missing that the other has. Equi-join
  // with the NULLs already excluded, because Spark rejects a full outer join on anything else — so
  // `IS NULL` below can only mean "no match", never "the value itself was null".
  facts.perSource.forEach(({ source, categories }, i) => {
    categories.forEach((column, j) => {
      ctes.push({
        name: `${prefix}_s${i + 1}_v${j + 1}`,
        // Each side reads its own column name and both are projected as `value`, so the join is
        // written once whether or not the transformation renamed the column.
        body:
          `    SELECT COALESCE(SUM(CASE WHEN s.value IS NULL THEN 1 ELSE 0 END), 0) AS values_added,\n` +
          `           COALESCE(SUM(CASE WHEN t.value IS NULL THEN 1 ELSE 0 END), 0) AS values_dropped\n` +
          `    FROM (SELECT DISTINCT ${column.target} AS value FROM ${facts.target}\n` +
          `          WHERE ${column.target} IS NOT NULL) t\n` +
          `    FULL OUTER JOIN (SELECT DISTINCT ${column.source} AS value FROM ${source}\n` +
          `                     WHERE ${column.source} IS NOT NULL) s\n` +
          `      ON t.value = s.value`
      });
    });
  });

  if (keyColumns.length > 0) {
    const list = keyColumns.join(", ");
    ctes.push({
      name: `${prefix}_dup`,
      body:
        `    SELECT COALESCE(SUM(key_rows), 0) AS dup_rows\n` +
        `    FROM (SELECT ${list}, COUNT(*) AS key_rows\n` +
        `          FROM ${facts.target}\n` +
        `          GROUP BY ${list}\n` +
        `          HAVING COUNT(*) > 1) g`
    });
  }

  facts.perSource.forEach(({ source, join }, i) => {
    if (join.columns.length === 0) return;
    const on = join.columns.map((column) => `t.${column} = s.${column}`).join(" AND ");
    ctes.push({
      name: `${prefix}_s${i + 1}_missing`,
      body:
        `    SELECT COUNT(*) AS rows_missing\n` +
        `    FROM ${source} s\n` +
        `    LEFT JOIN ${facts.target} t ON ${on}\n` +
        `    WHERE t.${join.columns[0]} IS NULL`
    });
    ctes.push({
      name: `${prefix}_s${i + 1}_orphan`,
      body:
        `    SELECT COUNT(*) AS rows_orphaned\n` +
        `    FROM ${facts.target} t\n` +
        `    LEFT JOIN ${source} s ON ${on}\n` +
        `    WHERE s.${join.columns[0]} IS NULL`
    });
  });

  // ---- the rows those CTEs feed ----

  facts.perSource.forEach((entry, i) => {
    const countable = countableAs(entry);
    // No row for a source the target's count is not a function of. A lookup joined in for its columns
    // has its own population, and a row comparing the two can only ever read REVIEW.
    if (!countable) return;
    const s = `${prefix}_s${i + 1}`;
    const value = entry.grainColumns.length > 0 ? "s.grain_count" : "s.row_count";
    rows.push({
      checkName: "Row count",
      target: facts.target,
      source: entry.source,
      metric: countable.metric,
      sourceValue: cast(value),
      targetValue: cast("t.row_count"),
      difference: cast(`t.row_count - ${value}`),
      // Grouping can only collapse rows, so under `at_most` fewer is the transformation working and
      // more is rows appearing from nowhere — which is a defect on its own terms, not a REVIEW.
      passWhen: countable.comparison === "equal" ? `t.row_count = ${value}` : `t.row_count <= ${value}`,
      failStatus: countable.comparison === "equal" ? "'REVIEW'" : "'FAIL'",
      from: `FROM ${prefix} t CROSS JOIN ${s} s`
    });
  });

  facts.perSource.forEach((entry, i) => {
    const s = `${prefix}_s${i + 1}`;
    for (const measure of entry.measures) {
      const column = sumAlias(measure.target);
      rows.push({
        checkName: "Measure total",
        target: facts.target,
        source: entry.source,
        metric:
          measure.target === measure.source
            ? `SUM(${measure.target})`
            : `SUM(${measure.target}) against SUM(${measure.source})`,
        sourceValue: cast(`s.${column}`),
        targetValue: cast(`t.${column}`),
        difference: cast(`COALESCE(t.${column}, 0) - COALESCE(s.${column}, 0)`),
        passWhen: `COALESCE(t.${column}, 0) = COALESCE(s.${column}, 0)`,
        failStatus: "'REVIEW'",
        from: `FROM ${prefix} t CROSS JOIN ${s} s`
      });
    }
  });

  facts.perSource.forEach((entry, i) => {
    entry.categories.forEach((column, j) => {
      const alias = distinctAlias(column.target);
      const label =
        column.target === column.source ? column.target : `${column.target} against ${column.source}`;
      rows.push({
        checkName: "Label values",
        target: facts.target,
        source: entry.source,
        metric: `COUNT(DISTINCT ${label})`,
        sourceValue: cast(`s.${alias}`),
        targetValue: cast(`t.${alias}`),
        difference: cast(`COALESCE(t.${alias}, 0) - COALESCE(s.${alias}, 0)`),
        passWhen: `COALESCE(t.${alias}, 0) = COALESCE(s.${alias}, 0)`,
        failStatus: "'REVIEW'",
        from: `FROM ${prefix} t CROSS JOIN ${prefix}_s${i + 1} s`
      });

      rows.push({
        checkName: "Label values on one side only",
        target: facts.target,
        source: entry.source,
        metric: `unmatched values of ${label}`,
        // Equal distinct counts still hide a value swapped for another, which is what this row is
        // for. Never FAIL, whichever direction it goes: a value dropped may be the filter doing its
        // job, and a value added may be the transformation remapping codes on purpose. The two
        // numbers sit side by side so the reader can tell which of the two happened.
        sourceValue: cast("v.values_dropped"),
        targetValue: cast("v.values_added"),
        difference: cast("v.values_added + v.values_dropped"),
        passWhen: "v.values_added + v.values_dropped = 0",
        failStatus: "'REVIEW'",
        from: `FROM ${prefix}_s${i + 1}_v${j + 1} v`
      });
    });
  });

  facts.perSource.forEach((entry, i) => {
    const join = entry.join;
    if (join.columns.length === 0) return;
    const key = join.columns.join(", ");

    rows.push({
      checkName: "Keys missing from target",
      target: facts.target,
      source: entry.source,
      metric: `unmatched source rows on (${key})`,
      sourceValue: cast("m.rows_missing"),
      targetValue: NO_VALUE,
      difference: cast("m.rows_missing"),
      passWhen: "m.rows_missing = 0",
      failStatus: "'REVIEW'",
      from: `FROM ${prefix}_s${i + 1}_missing m`
    });

    rows.push({
      checkName: "Target keys with no source row",
      target: facts.target,
      source: entry.source,
      metric: `unmatched target rows on (${key})`,
      sourceValue: NO_VALUE,
      targetValue: cast("o.rows_orphaned"),
      difference: cast("o.rows_orphaned"),
      // With more than one source, rows this source cannot account for may simply have come from
      // another of them — a fact worth reading, not a defect on its own.
      passWhen: "o.rows_orphaned = 0",
      failStatus: facts.sources.length > 1 ? "'REVIEW'" : "'FAIL'",
      from: `FROM ${prefix}_s${i + 1}_orphan o`
    });
  });

  if (keyColumns.length > 0) {
    const key = keyColumns.join(", ");
    rows.push({
      checkName: "Duplicate keys in target",
      target: facts.target,
      source: null,
      metric: `rows sharing a key on (${key})`,
      sourceValue: NO_VALUE,
      targetValue: cast("d.dup_rows"),
      difference: cast("d.dup_rows"),
      passWhen: "d.dup_rows = 0",
      failStatus: keyFailStatus(facts),
      from: `FROM ${prefix}_dup d`
    });

    rows.push({
      checkName: "Null keys in target",
      target: facts.target,
      source: null,
      metric: `rows with a null key on (${key})`,
      sourceValue: NO_VALUE,
      targetValue: cast("t.null_key_rows"),
      difference: cast("t.null_key_rows"),
      passWhen: "t.null_key_rows = 0",
      failStatus: keyFailStatus(facts),
      from: `FROM ${prefix} t`
    });
  }

  // ---- the model's own checks, folded where that is safe ----

  const aiChecks = (script?.checks ?? []).filter((check) => check.source === "ai");
  aiChecks.forEach((check, i) => {
    const flagged = foldToCount(check.sql);
    if (flagged === null) {
      appendix.push({
        title: `${check.title} [ai]`,
        description: `${check.description} Could not be folded into the query above — run it on its own.`,
        sql: check.sql
      });
      return;
    }

    const name = `${prefix}_c${i + 1}`;
    ctes.push({
      name,
      body: `    SELECT COUNT(*) AS rows_flagged\n    FROM (\n${indent(flagged, 8)}\n    ) x`
    });

    rows.push({
      checkName: `${check.title} [ai]`,
      target: facts.target,
      source: sourceOfCheck(check.sql, facts.sources),
      metric: "rows returned by the check",
      sourceValue: NO_VALUE,
      targetValue: cast("c.rows_flagged"),
      difference: cast("c.rows_flagged"),
      passWhen: "c.rows_flagged = 0",
      failStatus: "'REVIEW'",
      from: `FROM ${name} c`
    });

    appendix.push({
      title: `${check.title} [ai]`,
      description: `${check.description} Counted in the query above; this is the query itself, if you want the rows.`,
      sql: check.sql
    });
  });

  // ---- the row-level detail the fold turned into counts ----

  for (const check of script?.checks ?? []) {
    if (check.source !== "recon" || !LISTING_KINDS.has(check.kind)) continue;
    appendix.push({ title: check.title, description: check.description, sql: check.sql });
  }

  const paired = rows.filter((row) => row.source !== null);
  return {
    ctes,
    rows: paired,
    header,
    appendix,
    targetOnly: rows.filter((row) => row.source === null).map((row) => row.checkName)
  };
}

/**
 * Which of the target's sources a model-written check is about, when the check's own SQL says.
 *
 * Every other row of the bundle names two tables, and a check that names one is the odd row out — it
 * compares the target with nothing, so its `source_value` is blank and its `difference` is really a
 * count. Rather than let those rows sit in the table unattributed, the check's SQL is read for the
 * sources it actually touches: one match is an answer, several is not, and guessing between them
 * would put a table name on a row that is not about that table.
 */
function sourceOfCheck(sql: string, sources: string[]): string | null {
  const read = new Set(splitSqlTablesByOp(sql).sourceTables.map((table) => table.toLowerCase()));
  const hits = sources.filter((source) => read.has(source.toLowerCase()));
  return hits.length === 1 ? hits[0] : null;
}

export function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.trim().length > 0 ? `${pad}${line}` : line))
    .join("\n");
}

// ---- the file ----

/**
 * Exported so every generated file looks the same: `layerScripts.ts` writes a different query over the
 * same facts, and a second copy of these would drift into a second house style.
 */
export function wrap(text: string, indentText: string, width = 76): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line.length + word.length + 1 > width) {
      lines.push(`${indentText}${line}`);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(`${indentText}${line}`);
  return lines;
}

export const RULE = "=".repeat(76);

function fileHeader(
  hopLabel: string,
  folderName: string,
  targets: TargetBundle[],
  checkCount: number,
  platform: SqlPlatform
): string {
  const lines = [
    `/* ${RULE}`,
    `   Reconciliation — ${hopLabel}`,
    "",
    ...wrap(
      `One query. It returns ${checkCount} row${checkCount === 1 ? "" : "s"} — one per check — covering ` +
        `${targets.length} table${targets.length === 1 ? "" : "s"} this hop builds:`,
      "   "
    ),
    "",
    "     check_seq | scope | target_table | source_table | check_name | metric |",
    "     source_value | target_value | difference | status",
    "",
    ...wrap("`difference` is 0 and `status` is PASS on every row when the hop ties out. Otherwise:", "   "),
    "",
    "     REVIEW  the numbers differ, and something has to explain it — a filter or an",
    "             aggregation in the transformation (the ones found are listed per table",
    "             below), or a reconciliation break.",
    "     FAIL    wrong on its own terms: target rows the only source cannot account for.",
    "",
    ...targetOnlyNote(targets),
    ...wrap(
      "Keep the result by wrapping it: `CREATE TABLE recon_results AS <query>` on Databricks SQL, " +
        "or `SELECT … INTO recon_results FROM (<query>) r` on SQL Server.",
      "   "
    ),
    "",
    ...wrap(
      `Generated by Recon from the SQL in \`${folderName}\`. Every table and column name came from ` +
        `that SQL — nothing was measured and nothing was invented. ${platformNote(platform)}`,
      "   "
    ),
    ""
  ];

  for (const target of targets) {
    lines.push(...target.header.map((line) => `   ${line}`));
  }

  lines.push(`   ${RULE} */`, "");
  return lines.join("\n");
}

/**
 * Says what was left out, so the omission is a decision the reader can see rather than a gap.
 *
 * Every row of this table compares two tables, which is the property that makes the `source_table`
 * column worth reading and the file worth scanning. A check that looks at the target alone — its
 * duplicate keys, its null keys, a model-written check whose SQL names no source — has nothing to put
 * in half the columns, so it is not a row here. The model's ones are still in the appendix as SQL.
 */
function targetOnlyNote(targets: TargetBundle[]): string[] {
  const left = Array.from(new Set(targets.flatMap((target) => target.targetOnly)));
  if (left.length === 0) return [];
  return [
    ...wrap(
      `Every row compares a source with a target, so ${left.length} check${left.length === 1 ? "" : "s"} that ` +
        `look at the target alone ${left.length === 1 ? "is" : "are"} not in this table: ` +
        `${left.slice(0, 6).join(", ")}${left.length > 6 ? ", ..." : ""}. Any of them written by the reviewer ` +
        "model are in the appendix below as runnable SQL.",
      "   "
    ),
    ""
  ];
}

function appendixText(entries: { target: string; entries: Appendix[] }[]): string {
  const lines = [
    "",
    `/* ${RULE}`,
    "   Detail queries",
    "",
    ...wrap(
      "The query above counts; these list. Each one is the same check written to return the rows " +
        "behind a number that isn't zero. Delete the two comment lines around a block to run it.",
      "   "
    ),
    `   ${RULE} */`
  ];

  for (const group of entries) {
    if (group.entries.length === 0) continue;
    lines.push("", `-- ${group.target} ${"-".repeat(Math.max(4, 76 - group.target.length))}`);
    for (const entry of group.entries) {
      lines.push("", `/* ${entry.title}`, ...wrap(entry.description, "   "), "", indent(safeInBlockComment(entry.sql), 3), "*/");
    }
  }

  return lines.join("\n");
}

/** Keeps a quoted query from closing the comment it sits in. */
function safeInBlockComment(sql: string): string {
  return sql.replace(/\*\//g, "* /").trimEnd();
}

export interface ReconBundle {
  filename: string;
  sql: string;
}

/** One hop's facts paired with the scripts written for it. */
export interface ProjectBundleEntry {
  hop: ReconHopFacts;
  scripts: ReconScript[];
}

function projectHeader(
  folderName: string,
  hopLabels: string[],
  targetCount: number,
  checkCount: number,
  platform: SqlPlatform
): string {
  const lines = [
    `/* ${RULE}`,
    `   Reconciliation — ${folderName}`,
    "",
    ...wrap(
      `One query for the whole pipeline. It returns ${checkCount} row${checkCount === 1 ? "" : "s"} — one per ` +
        `check — covering ${targetCount} table${targetCount === 1 ? "" : "s"} across ${hopLabels.length} ` +
        `hop${hopLabels.length === 1 ? "" : "s"}:`,
      "   "
    ),
    "",
    ...hopLabels.map((label) => `     ${label}`),
    "",
    "     check_seq | scope | target_table | source_table | check_name | metric |",
    "     source_value | target_value | difference | status",
    "",
    ...wrap(
      "`scope` names the hop each row belongs to, so one result set covers the whole pipeline — " +
        "`WHERE scope = '…'` narrows it to a single hop, `WHERE status <> 'PASS'` to just the breaks.",
      "   "
    ),
    "",
    ...wrap("`difference` is 0 and `status` is PASS on every row when the pipeline ties out. Otherwise:", "   "),
    "",
    "     REVIEW  the numbers differ, and something has to explain it — a filter or an",
    "             aggregation in the transformation (the ones found are listed per table",
    "             below), or a reconciliation break.",
    "     FAIL    wrong on its own terms: target rows the only source cannot account for.",
    "",
    ...wrap(
      "Keep the result by wrapping it: `CREATE TABLE recon_results AS <query>` on Databricks SQL, " +
        "or `SELECT … INTO recon_results FROM (<query>) r` on SQL Server.",
      "   "
    ),
    "",
    ...wrap(
      `Generated by Recon from the SQL in \`${folderName}\`. Every table and column name came from ` +
        `that SQL — nothing was measured and nothing was invented. ${platformNote(platform)}`,
      "   "
    ),
    ""
  ];
  return lines.join("\n");
}

/**
 * The whole pipeline as one query, rather than one file per hop.
 *
 * Every check across every hop becomes a row in a single result set, told apart by the `scope`
 * column that `renderRow` already writes. Running reconciliation should be one action producing one
 * table you can scan for anything that isn't PASS — chasing the same answer through four files, in
 * an order you have to know, is work the tool should be absorbing.
 *
 * Target indices run globally rather than restarting per hop, because every CTE name is derived from
 * that index (`t01`, `t01_s1`, `t01_dup`); restarting would collide the moment two hops were folded
 * into one `WITH` clause.
 */
export function buildProjectBundle(
  entries: ProjectBundleEntry[],
  folderName: string,
  platform: SqlPlatform = "portable"
): ReconBundle {
  const filename = "reconciliation.sql";

  const ctes: Cte[] = [];
  const scoped: { row: BundleRow; scope: string }[] = [];
  const appendix: { target: string; entries: Appendix[] }[] = [];
  const headerBlocks: string[] = [];
  const hopLabels: string[] = [];
  const notes: string[] = [];

  let index = 0;
  let targetCount = 0;

  for (const entry of entries) {
    const byTarget = new Map(entry.scripts.map((script) => [script.targetTable, script]));
    const targets = entry.hop.targets.map((facts) => targetBundle(facts, byTarget.get(facts.target), ++index, platform));

    notes.push(...entry.hop.notes);
    if (targets.length === 0) continue;

    hopLabels.push(`${entry.hop.label}  (${entry.hop.targets.length} table${entry.hop.targets.length === 1 ? "" : "s"})`);
    headerBlocks.push("", `   ${entry.hop.label}`, `   ${"-".repeat(Math.max(4, entry.hop.label.length))}`);

    targets.forEach((target, i) => {
      ctes.push(...target.ctes);
      for (const row of target.rows) scoped.push({ row, scope: entry.hop.label });
      appendix.push({ target: entry.hop.targets[i].target, entries: target.appendix });
      headerBlocks.push(...target.header.map((line) => `   ${line}`));
      targetCount++;
    });
  }

  if (scoped.length === 0) {
    const note =
      notes.join(" ") || "No source/target pair was found in this project, so there is nothing to reconcile.";
    return {
      filename,
      sql: [
        `/* ${RULE}`,
        `   Reconciliation — ${folderName}`,
        "",
        ...wrap(note, "   "),
        `   ${RULE} */`,
        "",
        "SELECT 'NO SCOPE' AS status,",
        `       ${quoted(note)} AS detail;`,
        ""
      ].join("\n")
    };
  }

  const header =
    projectHeader(folderName, hopLabels, targetCount, scoped.length, platform).replace(/\n$/, "") +
    headerBlocks.join("\n") +
    `\n   ${RULE} */\n\n`;

  const body =
    `WITH\n${ctes.map(renderCte).join(",\n")}\n` +
    `${scoped.map((entry, i) => renderRow(entry.row, i + 1, entry.scope, i === 0)).join("\nUNION ALL\n")}\n` +
    "ORDER BY check_seq;\n";

  const hasAppendix = appendix.some((group) => group.entries.length > 0);
  return { filename, sql: `${header}${body}${hasAppendix ? appendixText(appendix) : ""}` };
}

/**
 * Builds the hop's single-query file. `scripts` are the per-table scripts already assembled for the
 * same hop — the source of the model's checks and of the row-level detail queries.
 */
export function buildHopBundle(
  hop: ReconHopFacts,
  scripts: ReconScript[],
  folderName: string,
  platform: SqlPlatform = "portable"
): ReconBundle {
  const filename = "00_reconciliation.sql";
  const byTarget = new Map(scripts.map((script) => [script.targetTable, script]));

  const targets = hop.targets.map((facts, i) => targetBundle(facts, byTarget.get(facts.target), i + 1, platform));
  const rows = targets.flatMap((target) => target.rows);

  if (rows.length === 0) {
    const note =
      hop.notes.join(" ") ||
      "No source/target pair was found for this hop, so there is nothing to reconcile across it.";
    const sql = [
      `/* ${RULE}`,
      `   Reconciliation — ${hop.label}`,
      "",
      ...wrap(note, "   "),
      `   ${RULE} */`,
      "",
      `SELECT 'NO SCOPE' AS status,`,
      `       ${quoted(note)} AS detail;`,
      ""
    ].join("\n");
    return { filename, sql };
  }

  const ctes = targets.flatMap((target) => target.ctes);
  const body =
    `WITH\n${ctes.map(renderCte).join(",\n")}\n` +
    `${rows.map((row, i) => renderRow(row, i + 1, hop.label, i === 0)).join("\nUNION ALL\n")}\n` +
    "ORDER BY check_seq;\n";

  const appendix = targets.map((target, i) => ({ target: hop.targets[i].target, entries: target.appendix }));
  const hasAppendix = appendix.some((group) => group.entries.length > 0);

  return {
    filename,
    sql: `${fileHeader(hop.label, folderName, targets, rows.length, platform)}${body}${hasAppendix ? appendixText(appendix) : ""}`
  };
}
