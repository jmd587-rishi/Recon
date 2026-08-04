import type {
  LayerRef,
  LocalReconciliationSuite,
  ReconCheck,
  ReconColumnSource,
  ReconHopScripts,
  ReconKeyConfidence,
  ReconScript
} from "../types/index.js";
import { type LocalProject, splitQualifiedTable } from "./localProject.js";
import { buildHopBundle, buildProjectBundle } from "./reconciliationBundle.js";
import { type ColumnIndex, type ColumnInfo, buildColumnIndex, type TableColumns } from "./sqlColumns.js";
import { isTempTable, type LineageFact } from "./tableLineage.js";
import { extractWherePredicate } from "./whereClauseAnalyzer.js";

/**
 * Writes the reconciliation SQL a data engineer would hand-write for each pipeline hop.
 *
 * The checks are the standard ones — row counts, measure totals, category values that appeared or
 * vanished, keys that vanished, keys that appeared from nowhere, duplicates and null keys — but the
 * tables, columns and filters in them come from this project's own SQL: lineage says which source
 * feeds which target (`tableLineage.ts`), `sqlColumns.ts` says what columns each side has, and
 * `whereClauseAnalyzer.ts` says which filter the transformation applies, which is the difference a
 * count check is *expected* to show.
 *
 * Nothing here calls an LLM. A reconciliation script that references a column the table doesn't have
 * is worse than no script, and the column list is already known exactly; guessing adds nothing but
 * risk. It also means this endpoint works with no Azure OpenAI configuration, like `/local/scan` and
 * unlike `/local/governance`.
 *
 * The SQL is deliberately portable: no `TOP`/`LIMIT`, no dialect-specific functions, so the same
 * script runs on SQL Server and on Databricks SQL. Add a row limit yourself if a check returns more
 * rows than you want to look at.
 *
 * Each hop also carries a `bundle` — the same checks folded into one query returning one status row
 * apiece, written by `reconciliationBundle.ts`. That is the file to run; these per-table scripts are
 * the detail behind it.
 */

/** Cap per script, so a wide fact table doesn't produce an unreadable measure block. */
const MAX_MEASURES = 6;
/** Cap per script on the labels compared as value sets — a wide table is mostly labels. */
const MAX_CATEGORIES = 3;
/** Cap on an inferred composite key — past this it's guessing at the grain, not identifying a row. */
const MAX_KEY_COLUMNS = 4;
/** Longest filter text quoted in a script header before it's cut. */
const MAX_FILTER_CHARS = 240;
/** Declared text length that reads as a code rather than as free text. */
const MAX_CATEGORY_TEXT_CHARS = 24;

/**
 * What a column is *for*, which is what decides the only check on it that can mean anything.
 *
 * Summing a label is the mistake this exists to prevent. `SUM(status)` errors or coerces, and
 * `SUM(fiscal_year)` succeeds and returns a number that reconciles to nothing — worse, because it
 * looks like a check. Labels are compared as *sets of values* instead, which is the reconciliation
 * question actually being asked of them: does the target still carry the same categories?
 */
export type ColumnRole = "key" | "measure" | "categorical" | "temporal" | "other";

/** Head words for something whose total means something. */
const MEASURE_WORDS = new Set([
  "amount", "amt", "revenue", "arr", "mrr", "acv", "tcv", "qty", "quantity", "count", "total",
  "sum", "price", "cost", "value", "balance", "sales", "spend", "fee", "fees", "tax", "discount",
  "margin", "profit", "net", "gross", "volume", "units", "hours", "days", "weight", "delta",
  "grr", "nrr"
]);

/**
 * Head words for a label: few distinct values, a set to compare rather than a column to total.
 * Date *parts* belong here rather than with the timestamps — `SUM(fiscal_year)` is the bug, while
 * "does the target still cover every month the source has" is a real check.
 */
const CATEGORY_WORDS = new Set([
  "type", "status", "state", "category", "class", "classification", "group", "grouping", "segment",
  "tier", "band", "bucket", "level", "grade", "priority", "region", "country", "market", "territory",
  "channel", "source", "system", "method", "mode", "reason", "currency", "flag", "indicator", "ind",
  "code", "center", "centre", "department", "division", "brand", "product", "line", "lob", "owner",
  "frequency", "period", "year", "quarter", "month", "week", "day", "version", "stage", "step"
]);

/** Head words for a point in time: nothing to total, and far too many values to enumerate. */
const TEMPORAL_WORDS = new Set([
  "date", "datetime", "time", "timestamp", "ts", "at", "dt", "dttm", "created", "updated", "modified"
]);

/** Head words for free text: as many distinct values as there are rows, so neither check applies. */
const LABEL_WORDS = new Set([
  "name", "names", "desc", "description", "comment", "comments", "note", "notes", "text", "address",
  "email", "phone", "url", "guid", "uuid", "hash", "path", "file", "filename", "message", "json", "xml"
]);

/** Head words for an identifier — checked by the key checks, never totalled. */
const KEY_WORDS = new Set(["key", "id", "sk", "pk", "identifier"]);

const KEY_SUFFIX = /_(?:key|id)$/;
/** Prefixes SSDT/warehouse projects put on table names, dropped when guessing the key column. */
const TABLE_PREFIX = /^(?:fact|dim|rpt|stg|trn|tbl|vw|agg|src)_/;

function slug(label: string): string {
  const cleaned = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "layer";
}

/** `bronze` -> `silver` becomes `bronze_to_silver`, matching the corrections bundle's convention. */
export function reconFolderName(from: LayerRef | null, to: LayerRef | null): string {
  if (!from || !to) return "all_tables";
  return `${slug(from.label)}_to_${slug(to.label)}`;
}

function bareName(table: string): string {
  return splitQualifiedTable(table).name;
}

function schemaOf(table: string): string | null {
  return splitQualifiedTable(table).schema;
}

function inSchema(table: string, schema: string | null): boolean {
  if (schema === null) return true;
  const own = schemaOf(table);
  return own !== null && own.toLowerCase() === schema.toLowerCase();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

// ---- picking the columns a check keys on ----

/** The columns a table's DDL declares as its primary key. */
function declaredKeyColumns(columns: TableColumns | undefined): string[] {
  return columns?.columns.filter((c) => c.isDeclaredKey).map((c) => c.name) ?? [];
}

/**
 * The columns that identify a row of `table` when nothing declared a primary key.
 *
 * A surrogate key named after the table (`fact_arr` -> `arr_key`, `dim_customer` -> `customer_key`)
 * identifies a row on its own and is taken alone. Failing that, every `_key`/`_id` column together
 * is a much better guess at a fact table's grain than any single one of them — a fact keyed on
 * (date, product, customer) has three such columns and no one of them is unique.
 */
function inferKeyColumns(table: string, columns: ColumnInfo[]): string[] {
  const names = columns.map((c) => c.name);
  const entity = bareName(table).replace(TABLE_PREFIX, "");

  const surrogate = names.find((name) => name === `${entity}_key` || name === `${entity}_id`);
  if (surrogate) return [surrogate];
  if (names.includes("id")) return ["id"];

  const keyish = names.filter((name) => KEY_SUFFIX.test(name));
  return keyish.slice(0, MAX_KEY_COLUMNS);
}

interface KeyChoice {
  columns: string[];
  confidence: ReconKeyConfidence;
  /** How the columns were chosen, quoted in the script header. */
  reason: string;
}

function targetKey(table: string, columns: TableColumns | undefined): KeyChoice {
  const declared = declaredKeyColumns(columns);
  if (declared.length > 0) {
    return { columns: declared, confidence: "declared", reason: `declared PRIMARY KEY on ${table}` };
  }
  const inferred = columns ? inferKeyColumns(table, columns.columns) : [];
  if (inferred.length > 0) {
    return {
      columns: inferred,
      confidence: "inferred",
      reason: "inferred from column naming — the duplicate-key check below proves whether it is unique"
    };
  }
  return { columns: [], confidence: "none", reason: "no key column could be identified" };
}

/**
 * The columns to join a source and target on: the target's own key when the source also has it,
 * otherwise whatever `_key`/`_id` columns the two share. Returning [] means the pair has no column
 * in common that could identify a row, so the key-level checks are skipped rather than invented.
 */
function joinKey(key: KeyChoice, target: TableColumns | undefined, source: TableColumns | undefined): KeyChoice {
  const sourceNames = new Set(source?.columns.map((c) => c.name) ?? []);
  if (sourceNames.size === 0) {
    return { columns: [], confidence: "none", reason: "no columns could be read for the source table" };
  }
  if (key.columns.length > 0 && key.columns.every((column) => sourceNames.has(column))) return key;

  const shared = (target?.columns ?? [])
    .map((c) => c.name)
    .filter((name) => sourceNames.has(name) && KEY_SUFFIX.test(name))
    .slice(0, MAX_KEY_COLUMNS);

  return shared.length > 0
    ? { columns: shared, confidence: "inferred", reason: "the key columns both tables share" }
    : { columns: [], confidence: "none", reason: "source and target share no key column" };
}

// ---- deciding what a column can be checked with ----

/** `fiscal_year` -> `year`: the head noun, which is what the column *is*. */
function headWord(name: string): string {
  const segments = name.split("_").filter(Boolean);
  return segments[segments.length - 1] ?? name;
}

/** A declared length short enough that the column holds a code rather than a sentence. */
function isShortText(column: ColumnInfo): boolean {
  const length = /\(\s*(\d+)\s*\)\s*$/.exec(column.dataType ?? "");
  return length !== null && Number(length[1]) <= MAX_CATEGORY_TEXT_CHARS;
}

/**
 * What kind of column this is, and so which check on it could mean anything.
 *
 * The head noun decides — `sales_region` is a region, `region_sales` is sales — and only when the
 * head says nothing does any other segment get a vote, categories ahead of measures. That asymmetry
 * is deliberate: not totalling a measure costs one check, while totalling a label produces a number
 * that can never tie out and teaches the reader to ignore the whole script.
 *
 * The declared type is the tie-breaker rather than the first word. `[fiscal_year] [int]` is numeric
 * and is still not a measure; `[status] [varchar](20)` is text and is still not free text.
 */
export function columnRole(column: ColumnInfo): ColumnRole {
  const name = column.name;
  // Bookkeeping columns a load added (`__loaded_at`) belong to neither side of a comparison.
  if (name.startsWith("__")) return "other";
  if (column.isDeclaredKey) return "key";

  const head = headWord(name);
  const segments = name.split("_").filter(Boolean);
  // A column no DDL described was built by an expression, so its type is whatever that returned;
  // only a type that is declared and unsummable can veto a measure.
  const summable = column.kind === "numeric" || column.kind === "other";

  if (name === "id" || KEY_WORDS.has(head)) return "key";
  if (column.kind === "boolean" || /^(?:is|has)_/.test(name)) return "categorical";
  if (column.kind === "date" || TEMPORAL_WORDS.has(head)) return "temporal";
  if (CATEGORY_WORDS.has(head)) return "categorical";
  if (MEASURE_WORDS.has(head)) return summable ? "measure" : "other";
  if (LABEL_WORDS.has(head)) return "other";
  if (segments.some((segment) => CATEGORY_WORDS.has(segment))) return "categorical";
  if (segments.some((segment) => MEASURE_WORDS.has(segment))) return summable ? "measure" : "other";
  if (column.kind === "numeric") return "measure";
  if (column.kind === "text") return isShortText(column) ? "categorical" : "other";
  return "other";
}

/**
 * The role of a column both sides carry. The names are equal by construction, so the two readings
 * can only disagree about the declared type — one side `decimal` and the other `varchar` is a column
 * nobody should sum, so the reading that checks less wins.
 */
function sharedRole(target: ColumnInfo, source: ColumnInfo): ColumnRole {
  const inTarget = columnRole(target);
  const inSource = columnRole(source);
  if (inTarget === inSource) return inTarget;
  return inTarget === "categorical" || inSource === "categorical" ? "categorical" : "other";
}

/** Whether the column's *name* says label, as opposed to a short declared length implying it. */
function isNamedLabel(column: ColumnInfo): boolean {
  return (
    column.kind === "boolean" ||
    /^(?:is|has)_/.test(column.name) ||
    column.name.split("_").some((segment) => CATEGORY_WORDS.has(segment))
  );
}

/**
 * Ranks the labels so the cap keeps the ones worth the space.
 *
 * A label the transformation filters on comes first: its value set is precisely what the filter was
 * supposed to change, so the check reads as a confirmation of the stated intent rather than as an
 * unexplained difference. After that a name that says label outright beats one that is only short
 * enough to look like a code. Ties keep the order the table declares them in.
 */
function rankedCategories(candidates: ColumnInfo[], filters: string[]): string[] {
  const filterText = filters.join(" ").toLowerCase().replace(/[`[\]"]/g, "");
  const mentioned = (name: string) => new RegExp(`\\b${name.replace(/[^\w]/g, "\\$&")}\\b`).test(filterText);
  const rank = (column: ColumnInfo) => (mentioned(column.name) ? 0 : isNamedLabel(column) ? 1 : 2);

  return candidates
    .map((column, i) => ({ column, i }))
    .sort((a, b) => rank(a.column) - rank(b.column) || a.i - b.i)
    .map((entry) => entry.column.name);
}

interface SharedColumns {
  /** Totalled on both sides. */
  measures: string[];
  /** Compared as sets of values on both sides, most worth checking first. */
  categories: string[];
}

/**
 * The columns both sides carry, split by what comparing them could mean. Everything else — keys,
 * timestamps, free text — is left to the row-count and key checks, which already cover it.
 */
function sharedColumns(
  target: TableColumns | undefined,
  source: TableColumns | undefined,
  filters: string[]
): SharedColumns {
  if (!target || !source) return { measures: [], categories: [] };
  const sourceByName = new Map(source.columns.map((c) => [c.name, c]));

  const measures: string[] = [];
  const categories: ColumnInfo[] = [];
  for (const column of target.columns) {
    const counterpart = sourceByName.get(column.name);
    if (!counterpart) continue;
    const role = sharedRole(column, counterpart);
    if (role === "measure") measures.push(column.name);
    else if (role === "categorical") categories.push(column);
  }

  return { measures, categories: rankedCategories(categories, filters) };
}

// ---- SQL fragments ----

function countOf(table: string): string {
  return `(SELECT COUNT(*) FROM ${table})`;
}

function sumOf(table: string, column: string): string {
  return `(SELECT SUM(${column}) FROM ${table})`;
}

function quoted(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function onClause(keyColumns: string[]): string {
  return keyColumns.map((column, i) => `${i === 0 ? "       ON " : "      AND "}t.${column} = s.${column}`).join("\n");
}

function rowCountCheck(target: string, sources: string[]): ReconCheck {
  const sql = sources
    .map(
      (source) =>
        `SELECT ${quoted(`${source} -> ${target}`)} AS check_name,\n` +
        `       ${countOf(source)} AS source_rows,\n` +
        `       ${countOf(target)} AS target_rows,\n` +
        `       ${countOf(target)} - ${countOf(source)} AS row_diff`
    )
    .join("\nUNION ALL\n");

  return {
    kind: "row_count",
    source: "recon",
    title: "Row counts",
    description:
      "One row per source table. `row_diff` is target minus source — a non-zero value needs a line " +
      "of transformation logic you can point at, or it is a reconciliation break.",
    sql: `${sql};`
  };
}

function measureCheck(target: string, perSource: { source: string; measures: string[] }[]): ReconCheck | null {
  const blocks = perSource.flatMap(({ source, measures }) =>
    measures.map(
      (measure) =>
        `SELECT ${quoted(measure)} AS measure,\n` +
        `       ${quoted(source)} AS source_table,\n` +
        `       ${sumOf(source, measure)} AS source_total,\n` +
        `       ${sumOf(target, measure)} AS target_total,\n` +
        // An empty table sums to NULL, and `NULL - NULL` would read as "no difference" at a glance.
        `       COALESCE(${sumOf(target, measure)}, 0) - COALESCE(${sumOf(source, measure)}, 0) AS total_diff`
    )
  );
  if (blocks.length === 0) return null;

  return {
    kind: "measure_totals",
    source: "recon",
    title: "Measure totals",
    description:
      "The money/quantity columns both sides carry, summed. Only these — a label like a status or a " +
      "period is compared by its values further down, because its total means nothing. Equal row " +
      "counts with unequal totals is the classic silent break: a join fanned out and then a filter " +
      "put the count back.",
    sql: `${blocks.join("\nUNION ALL\n")};`
  };
}

/**
 * The check a label gets instead of a total: are the two sides carrying the same set of values?
 *
 * A `FULL OUTER JOIN` on an equi-key, with NULLs excluded on both sides beforehand, is the one shape
 * that runs on SQL Server and Databricks SQL alike — Spark refuses a full outer join whose condition
 * isn't an equality, which rules out the usual `OR (a IS NULL AND b IS NULL)` null-matching. Nothing
 * is lost by it: a category going wholly NULL in the target shows up as its values disappearing.
 */
function categoryValuesCheck(target: string, source: string, column: string): ReconCheck {
  return {
    kind: "category_values",
    source: "recon",
    title: `Values of ${column} against ${source}`,
    description:
      `${column} is a label rather than a quantity, so the two sides are compared as sets of values ` +
      "instead of being summed. A value the source has and the target hasn't was filtered or remapped " +
      "away; a value the target has and the source hasn't was invented somewhere in the " +
      "transformation. Returns nothing when both sides carry the same values — drop the WHERE clause " +
      "to see every value with its row count on each side.",
    sql:
      `SELECT COALESCE(t.${column}, s.${column}) AS ${column},\n` +
      `       s.source_rows,\n` +
      `       t.target_rows\n` +
      `FROM (SELECT ${column}, COUNT(*) AS target_rows\n` +
      `      FROM ${target}\n` +
      `      WHERE ${column} IS NOT NULL\n` +
      `      GROUP BY ${column}) t\n` +
      `FULL OUTER JOIN (SELECT ${column}, COUNT(*) AS source_rows\n` +
      `                 FROM ${source}\n` +
      `                 WHERE ${column} IS NOT NULL\n` +
      `                 GROUP BY ${column}) s\n` +
      `       ON t.${column} = s.${column}\n` +
      `WHERE t.${column} IS NULL\n` +
      `   OR s.${column} IS NULL;`
  };
}

function missingKeysCheck(target: string, source: string, keyColumns: string[]): ReconCheck {
  const selected = keyColumns.map((c) => `s.${c}`).join(", ");
  return {
    kind: "missing_keys",
    source: "recon",
    title: `Keys in ${source} with no row in ${target}`,
    description: "Rows the source has that the transformation dropped. Returns nothing when none were lost.",
    sql:
      `SELECT ${selected}\n` +
      `FROM ${source} s\n` +
      `LEFT JOIN ${target} t\n${onClause(keyColumns)}\n` +
      `WHERE t.${keyColumns[0]} IS NULL;`
  };
}

function orphanKeysCheck(target: string, source: string, keyColumns: string[]): ReconCheck {
  const selected = keyColumns.map((c) => `t.${c}`).join(", ");
  return {
    kind: "orphan_keys",
    source: "recon",
    title: `Keys in ${target} with no row in ${source}`,
    description:
      "Rows the target has that this source cannot account for — a duplicate load, a stale rebuild, " +
      "or rows that legitimately came from one of the other sources.",
    sql:
      `SELECT ${selected}\n` +
      `FROM ${target} t\n` +
      `LEFT JOIN ${source} s\n${onClause(keyColumns)}\n` +
      `WHERE s.${keyColumns[0]} IS NULL;`
  };
}

function duplicateKeysCheck(target: string, keyColumns: string[]): ReconCheck {
  const list = keyColumns.join(", ");
  return {
    kind: "duplicate_keys",
    source: "recon",
    title: "Duplicate keys in the target",
    description:
      "Returns nothing when the key is unique. Any row here means the key does not identify a row, so " +
      "the join checks above are measuring the wrong thing — settle this one first.",
    sql: `SELECT ${list}, COUNT(*) AS row_count\nFROM ${target}\nGROUP BY ${list}\nHAVING COUNT(*) > 1;`
  };
}

function nullKeysCheck(target: string, keyColumns: string[]): ReconCheck {
  return {
    kind: "null_keys",
    source: "recon",
    title: "Null keys in the target",
    description: "A null key never joins, so these rows are invisible to every other check.",
    sql:
      `SELECT COUNT(*) AS rows_with_null_key\n` +
      `FROM ${target}\n` +
      `WHERE ${keyColumns.map((c) => `${c} IS NULL`).join("\n   OR ")};`
  };
}

// ---- assembling one script ----

/**
 * Tidies a recovered WHERE predicate for quoting in a comment. `extractWherePredicate` falls back to
 * a text span when no dialect parses the statement, and that span runs to the end of the match — for
 * a stored procedure that means the `; END` closing the routine comes back with the predicate.
 */
function tidyFilter(predicate: string): string {
  const flat = predicate.replace(/\s+/g, " ").trim().split(";")[0];
  const cut = flat.replace(/\s*\b(?:end|go|begin)\b\s*$/i, "").trim();
  return cut.length > MAX_FILTER_CHARS ? `${cut.slice(0, MAX_FILTER_CHARS)}…` : cut;
}

function wrapNote(text: string, indent: string): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > 76) {
      lines.push(`${indent}${line}`);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(`${indent}${line}`);
  return lines;
}

function scriptText(params: {
  script: Omit<ReconScript, "sql" | "filename">;
  hopLabel: string;
  folderName: string;
  writtenBy: LocalReconciliationSuite["generatedBy"];
}): string {
  const { script, hopLabel, folderName } = params;
  const rule = "=".repeat(76);
  const lines: string[] = [`/* ${rule}`, `   Reconciliation — ${script.targetTable}`, `   Hop: ${hopLabel}`];

  lines.push(...wrapNote(`Sources: ${script.sourceTables.join(", ")}`, "   "));
  lines.push(
    ...wrapNote(
      `Built by: ${script.builtBy.map((b) => `${b.path} (statement ${b.statementIndex})`).join(", ")}`,
      "   "
    )
  );
  lines.push("");
  const aiCount = script.checks.filter((c) => c.source === "ai").length;
  lines.push(
    ...wrapNote(
      params.writtenBy === "ai" && aiCount > 0
        ? `Generated by Recon from the SQL in \`${folderName}\`. The checks marked [ai] were written by ` +
            `Recon's reviewer model after reading this transformation's SQL; the rest are derived from the ` +
            `declared columns. Every table and column name in either half came from your SQL, not invented.`
        : `Generated by Recon from the SQL in \`${folderName}\` — derived from the declared columns.`,
      "   "
    )
  );
  lines.push("   Portable SQL — no TOP/LIMIT — so it runs unchanged on SQL Server and Databricks SQL.");
  if (script.summary) {
    lines.push("");
    lines.push(...wrapNote(script.summary, "   "));
  }
  lines.push("");
  const key = script.keyColumns.length > 0 ? `${script.keyColumns.join(", ")} (${script.keyReason})` : "none found";
  lines.push(...wrapNote(`Key: ${key}`, "   "));
  lines.push(
    ...wrapNote(
      `Measures (totalled): ${script.measureColumns.length > 0 ? script.measureColumns.join(", ") : "none found"}`,
      "   "
    )
  );
  lines.push(
    ...wrapNote(
      `Labels (values compared, not totalled): ${
        script.categoryColumns.length > 0 ? script.categoryColumns.join(", ") : "none found"
      }`,
      "   "
    )
  );

  if (script.knownFilters.length > 0) {
    lines.push("");
    lines.push("   Filters the transformation applies:");
    for (const filter of script.knownFilters) lines.push(`     WHERE ${filter}`);
    lines.push(...wrapNote("Rows removed by these are an EXPECTED difference — apply the same predicate to the source before calling a gap a break.", "     "));
  }

  if (script.notes.length > 0) {
    lines.push("");
    for (const note of script.notes) lines.push(...wrapNote(`- ${note}`, "   "));
  }

  lines.push(`   ${rule} */`, "");

  script.checks.forEach((check, i) => {
    const heading = `-- ${i + 1}. ${check.title}${check.source === "ai" ? " [ai]" : ""} `;
    lines.push(`${heading}${"-".repeat(Math.max(4, 79 - heading.length))}`);
    lines.push(...wrapNote(check.description, "-- "));
    lines.push(check.sql, "");
  });

  return `${lines.join("\n").trimEnd()}\n`;
}

interface TargetGroup {
  target: string;
  sources: string[];
  facts: LineageFact[];
}

/**
 * Everything read out of the project about one target table, before a single line of SQL is written.
 *
 * This is the grounding both writers work from: the template writer below turns it straight into
 * checks, and `aiReconciliation.ts` puts it in the prompt so the model has the exact column lists
 * and never has to guess a name. Keeping it separate is what makes the two paths comparable.
 */
export interface ReconTargetFacts {
  target: string;
  sources: string[];
  facts: LineageFact[];
  key: KeyChoice;
  perSource: { source: string; join: KeyChoice; measures: string[]; categories: string[] }[];
  measureColumns: string[];
  /** Labels compared as value sets rather than totalled — see `columnRole`. */
  categoryColumns: string[];
  knownFilters: string[];
  columnSources: ReconColumnSource[];
  /** Gaps in the grounding worth saying out loud — no columns, no key, lookup-shaped sources. */
  notes: string[];
  /** Filename this target's script takes inside the hop folder. */
  filename: string;
}

export interface ReconHopFacts {
  from: LayerRef | null;
  to: LayerRef | null;
  /** `bronze -> silver`, or `whole project` when no layers were given. */
  label: string;
  folder: string;
  targets: ReconTargetFacts[];
  notes: string[];
}

export interface ReconGrounding {
  hops: ReconHopFacts[];
  columns: ColumnIndex;
}

/** Groups the statements of a hop by the table they build, keeping only sources inside the hop. */
function groupByTarget(facts: LineageFact[], fromSchema: string | null, toSchema: string | null): TargetGroup[] {
  const groups = new Map<string, TargetGroup>();

  for (const fact of facts) {
    const target = fact.targetTable;
    if (!target || isTempTable(target) || !inSchema(target, toSchema)) continue;

    // Sources from the layer feeding this hop, plus the target's own layer: a report built from a
    // fact table next to it is still a reconciliation the engineer has to do, and it belongs to the
    // hop that produces that layer rather than to no hop at all.
    const sources = fact.sourceTables.filter(
      (source) =>
        !isTempTable(source) &&
        source !== target &&
        (inSchema(source, fromSchema) || (toSchema !== null && inSchema(source, toSchema)))
    );
    if (sources.length === 0) continue;

    const group = groups.get(target) ?? { target, sources: [], facts: [] };
    group.sources = unique([...group.sources, ...sources]);
    group.facts.push(fact);
    groups.set(target, group);
  }

  return Array.from(groups.values()).sort((a, b) => a.target.localeCompare(b.target));
}

function targetFacts(group: TargetGroup, columns: ColumnIndex, filename: string): ReconTargetFacts {
  const targetColumns = columns.get(group.target);
  const key = targetKey(group.target, targetColumns);
  const notes: string[] = [];

  // Read before the columns are split: a label the transformation filters on is the one whose values
  // are worth comparing first, so the caps keep it.
  const knownFilters = unique(
    group.facts.flatMap((fact) => {
      const predicate = extractWherePredicate(fact.rawSql);
      const tidy = predicate ? tidyFilter(predicate) : "";
      return tidy ? [tidy] : [];
    })
  );

  const overflow: string[] = [];
  const perSource = group.sources.map((source) => {
    const sourceColumns = columns.get(source);
    const shared = sharedColumns(targetColumns, sourceColumns, knownFilters);
    overflow.push(...shared.measures.slice(MAX_MEASURES), ...shared.categories.slice(MAX_CATEGORIES));
    return {
      source,
      join: joinKey(key, targetColumns, sourceColumns),
      measures: shared.measures.slice(0, MAX_MEASURES),
      categories: shared.categories.slice(0, MAX_CATEGORIES)
    };
  });

  const measureColumns = unique(perSource.flatMap((p) => p.measures));
  const categoryColumns = unique(perSource.flatMap((p) => p.categories));
  if (measureColumns.length === 0) {
    notes.push("No measure column is present on both sides, so there are no totals to compare.");
  }
  if (categoryColumns.length === 0) {
    notes.push(
      "No label column — a status, type, code or period — is present on both sides, so there are no " +
        "value sets to compare."
    );
  }

  // A column capped out against one source may still be checked against another, and only the ones
  // checked against none of them are missing from the script.
  const left = unique(overflow).filter((name) => !measureColumns.includes(name) && !categoryColumns.includes(name));
  if (left.length > 0) {
    notes.push(
      `${left.join(", ")} ${left.length === 1 ? "is" : "are"} left out to keep the script readable — at most ` +
        `${MAX_MEASURES} measures and ${MAX_CATEGORIES} labels are checked per source, the ones the ` +
        "transformation filters on first. Copy a check and change the column name to add one back."
    );
  }

  for (const { source, join } of perSource) {
    if (join.columns.length === 0) {
      notes.push(`No key column is shared with ${source} (${join.reason}), so it cannot be joined row by row.`);
    }
  }

  if (key.columns.length === 0) {
    notes.push(
      `No key column could be identified for ${group.target}, so the duplicate and null-key checks were ` +
        "skipped. Add the real key by hand and the join checks become meaningful."
    );
  }

  if (!targetColumns || targetColumns.columns.length === 0) {
    notes.push(
      `No column list could be recovered for ${group.target} — nothing in this folder defines it with ` +
        "CREATE TABLE or builds it with a named select list, so only the row count is checked."
    );
  } else if (targetColumns.incomplete) {
    notes.push(
      `The column list for ${group.target} came from a \`SELECT *\` that could not be expanded, so it may ` +
        "be missing columns."
    );
  }

  if (group.sources.length > 1) {
    notes.push(
      "Sources are listed in the order the statement reads them: the first is usually the table that " +
        "drives the row count and the rest are joined in as lookups, where a count difference is normal."
    );
  }

  return {
    target: group.target,
    sources: group.sources,
    facts: group.facts,
    key,
    perSource,
    measureColumns,
    categoryColumns,
    knownFilters,
    columnSources: [group.target, ...group.sources].map((table) => {
      const entry = columns.get(table);
      const known = entry && entry.columns.length > 0;
      return {
        table,
        origin: known ? (entry.incomplete ? `${entry.origin} (partial)` : entry.origin) : "unknown",
        columnCount: entry?.columns.length ?? 0
      };
    }),
    notes,
    filename
  };
}

/**
 * The checks the templates write: the six an engineer produces from the schema alone, and nothing
 * that needs judgement about what the transformation is *for*.
 *
 * This is the fallback path — `aiReconciliation.ts` is what normally writes the checks — so it stays
 * deliberately mechanical. Whatever it can't ground it skips and says so in `facts.notes`.
 */
export function templateChecks(facts: ReconTargetFacts): ReconCheck[] {
  const checks: ReconCheck[] = [rowCountCheck(facts.target, facts.sources)];

  const measures = measureCheck(
    facts.target,
    facts.perSource.map(({ source, measures: shared }) => ({ source, measures: shared }))
  );
  if (measures) checks.push(measures);

  for (const { source, categories } of facts.perSource) {
    for (const column of categories) checks.push(categoryValuesCheck(facts.target, source, column));
  }

  for (const { source, join } of facts.perSource) {
    if (join.columns.length === 0) continue;
    checks.push(missingKeysCheck(facts.target, source, join.columns));
    checks.push(orphanKeysCheck(facts.target, source, join.columns));
  }

  if (facts.key.columns.length > 0) {
    checks.push(duplicateKeysCheck(facts.target, facts.key.columns));
    checks.push(nullKeysCheck(facts.target, facts.key.columns));
  }

  return checks;
}

/** Turns one target's facts plus a set of checks into the finished, downloadable script. */
export function assembleScript(params: {
  facts: ReconTargetFacts;
  checks: ReconCheck[];
  summary: string;
  hopLabel: string;
  folderName: string;
  writtenBy?: LocalReconciliationSuite["generatedBy"];
  extraNotes?: string[];
}): ReconScript {
  const { facts, checks, summary, hopLabel, folderName } = params;
  const body: Omit<ReconScript, "sql" | "filename"> = {
    targetTable: facts.target,
    sourceTables: facts.sources,
    summary,
    keyColumns: facts.key.columns,
    keyConfidence: facts.key.confidence,
    keyReason: facts.key.reason,
    measureColumns: facts.measureColumns,
    categoryColumns: facts.categoryColumns,
    knownFilters: facts.knownFilters,
    builtBy: facts.facts.map((fact) => ({ path: fact.notebookPath, statementIndex: fact.cellIndex })),
    columnSources: facts.columnSources,
    checks,
    notes: [...facts.notes, ...(params.extraNotes ?? [])]
  };

  return {
    ...body,
    filename: facts.filename,
    sql: scriptText({ script: body, hopLabel, folderName, writtenBy: params.writtenBy ?? "rules" })
  };
}

/**
 * Reads the project into one set of grounded facts per target table, grouped into the pipeline hop
 * that produces it. Nothing is written here — this is the input both script writers share.
 *
 * `layers` are the confirmed pipeline layers, most-raw first; adjacent pairs become hops. With fewer
 * than two layers — the SQL never qualifies its tables, so none could be inferred — every lineage
 * pair in the project is grouped into a single scope instead, exactly as the governance review does.
 */
export function gatherReconciliationFacts(project: LocalProject, layers: LayerRef[]): ReconGrounding {
  const columns = buildColumnIndex(
    project.facts
      .filter((fact) => fact.targetTable !== null && !isTempTable(fact.targetTable))
      .map((fact) => ({ table: fact.targetTable!, sql: fact.rawSql }))
  );

  const hopSpecs: { from: LayerRef | null; to: LayerRef | null }[] =
    layers.length >= 2 ? layers.slice(0, -1).map((from, i) => ({ from, to: layers[i + 1] })) : [{ from: null, to: null }];

  const takenFolders = new Set<string>();
  const hops: ReconHopFacts[] = hopSpecs.map(({ from, to }) => {
    const groups = groupByTarget(project.facts, from?.schema ?? null, to?.schema ?? null);

    let folder = reconFolderName(from, to);
    for (let n = 2; takenFolders.has(folder); n++) folder = `${reconFolderName(from, to)}_${n}`;
    takenFolders.add(folder);

    const takenNames = new Set<string>();
    const targets = groups.map((group, i) => {
      const stem = `${String(i + 1).padStart(2, "0")}_${slug(bareName(group.target))}`;
      let filename = `${stem}.sql`;
      for (let n = 2; takenNames.has(filename); n++) filename = `${stem}_${n}.sql`;
      takenNames.add(filename);
      return targetFacts(group, columns, filename);
    });

    const notes: string[] = [];
    if (targets.length === 0) {
      notes.push(
        from && to
          ? `No statement in this folder builds a ${to.schema} table from a ${from.schema} one, so there is nothing to reconcile across this hop. Check that the layers match the schema names the SQL uses.`
          : "No statement in this folder both reads one table and writes another, so there is no lineage to reconcile."
      );
    }

    return { from, to, label: from && to ? `${from.label} -> ${to.label}` : "whole project", folder, targets, notes };
  });

  return { hops, columns };
}

/** Packs one hop's finished scripts, with the single query that covers all of them at once. */
export function assembleHop(hop: ReconHopFacts, scripts: ReconScript[], folderName: string): ReconHopScripts {
  return {
    fromLayer: hop.from,
    toLayer: hop.to,
    folder: hop.folder,
    scripts,
    bundle: buildHopBundle(hop, scripts, folderName),
    notes: hop.notes
  };
}

/** Counts up a finished suite and records how its scripts were written. */
export function summarizeSuite(params: {
  folderName: string;
  hops: ReconHopScripts[];
  /** The facts behind `hops`, in the same order — needed to fold them into one query. */
  hopFacts: ReconHopFacts[];
  columns: ColumnIndex;
  generatedBy: LocalReconciliationSuite["generatedBy"];
  notice: string | null;
}): LocalReconciliationSuite {
  const { folderName, hops, hopFacts, columns, generatedBy, notice } = params;
  const tablesInScope = unique(hops.flatMap((hop) => hop.scripts.flatMap((s) => [s.targetTable, ...s.sourceTables])));

  const byFolder = new Map(hops.map((hop) => [hop.folder, hop.scripts]));
  const projectBundle = buildProjectBundle(
    hopFacts.map((hop) => ({ hop, scripts: byFolder.get(hop.folder) ?? [] })),
    folderName
  );

  return {
    folderName,
    generatedBy,
    notice,
    hops,
    projectBundle,
    stats: {
      hopCount: hops.length,
      scriptCount: hops.reduce((n, hop) => n + hop.scripts.length, 0),
      checkCount: hops.reduce((n, hop) => n + hop.scripts.reduce((m, s) => m + s.checks.length, 0), 0),
      tablesWithColumns: tablesInScope.filter((t) => (columns.get(t)?.columns.length ?? 0) > 0).length,
      tablesWithoutColumns: tablesInScope.filter((t) => (columns.get(t)?.columns.length ?? 0) === 0).length
    }
  };
}

/**
 * The template-written suite: every check derivable from the schema, no model involved.
 *
 * `aiReconciliation.ts` is the normal path — the scripts are meant to be written by the model, which
 * can see what a transformation is actually *doing* — and this is what runs when Azure OpenAI isn't
 * configured, so an offline folder still gets the mechanical checks rather than an error page.
 */
export function buildReconciliationSuite(
  project: LocalProject,
  layers: LayerRef[],
  notice: string | null = null
): LocalReconciliationSuite {
  const { hops, columns } = gatherReconciliationFacts(project, layers);

  const built = hops.map((hop) =>
    assembleHop(
      hop,
      hop.targets.map((facts) =>
        assembleScript({
          facts,
          checks: templateChecks(facts),
          summary: "",
          hopLabel: hop.label,
          folderName: project.folderName
        })
      ),
      project.folderName
    )
  );

  return summarizeSuite({
    folderName: project.folderName,
    hops: built,
    hopFacts: hops,
    columns,
    generatedBy: "rules",
    notice
  });
}
