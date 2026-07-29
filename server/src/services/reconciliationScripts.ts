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
import { type ColumnIndex, type ColumnInfo, buildColumnIndex, type TableColumns } from "./sqlColumns.js";
import { isTempTable, type LineageFact } from "./tableLineage.js";
import { extractWherePredicate } from "./whereClauseAnalyzer.js";

/**
 * Writes the reconciliation SQL a data engineer would hand-write for each pipeline hop.
 *
 * The checks are the standard ones — row counts, measure totals, keys that vanished, keys that
 * appeared from nowhere, duplicates and null keys — but the tables, columns and filters in them come
 * from this project's own SQL: lineage says which source feeds which target (`tableLineage.ts`),
 * `sqlColumns.ts` says what columns each side has, and `whereClauseAnalyzer.ts` says which filter the
 * transformation applies, which is the difference a count check is *expected* to show.
 *
 * Nothing here calls an LLM. A reconciliation script that references a column the table doesn't have
 * is worse than no script, and the column list is already known exactly; guessing adds nothing but
 * risk. It also means this endpoint works with no Azure OpenAI configuration, like `/local/scan` and
 * unlike `/local/governance`.
 *
 * The SQL is deliberately portable: no `TOP`/`LIMIT`, no dialect-specific functions, so the same
 * script runs on SQL Server and on Databricks SQL. Add a row limit yourself if a check returns more
 * rows than you want to look at.
 */

/** Cap per script, so a wide fact table doesn't produce an unreadable measure block. */
const MAX_MEASURES = 6;
/** Cap on an inferred composite key — past this it's guessing at the grain, not identifying a row. */
const MAX_KEY_COLUMNS = 4;
/** Longest filter text quoted in a script header before it's cut. */
const MAX_FILTER_CHARS = 240;

/** Column-name segments that read as a measure when no DDL declared a type. */
const MEASURE_WORDS = new Set([
  "amount", "amt", "revenue", "arr", "mrr", "acv", "tcv", "qty", "quantity", "count", "total",
  "sum", "price", "cost", "value", "balance", "sales", "spend", "fee", "fees", "tax", "discount",
  "margin", "profit", "net", "gross", "volume", "units", "hours", "weight", "delta", "grr", "nrr"
]);

/** Suffixes that mark a column as an identifier, a timestamp or a flag rather than a measure. */
const NON_MEASURE_SUFFIX = /_(?:key|id|code|flag|type|status|name|date|at|ts|month|year|day|time)$/;
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

// ---- picking the columns a total is taken over ----

function isMeasure(column: ColumnInfo): boolean {
  if (NON_MEASURE_SUFFIX.test(column.name) || /^(?:is|has)_/.test(column.name) || column.name.startsWith("__")) {
    return false;
  }
  if (column.kind === "numeric") return true;
  // A column the DDL typed as text or a date is not a measure whatever it's called; a column no DDL
  // described at all (built by `SELECT ... INTO`, so its type is whatever the expression returned)
  // is judged on its name, which is all there is.
  if (column.kind !== "other") return false;
  return column.name.split("_").some((segment) => MEASURE_WORDS.has(segment));
}

/** Measures worth totalling on both sides: present in both, and not typed as something unsummable. */
function sharedMeasures(target: TableColumns | undefined, source: TableColumns | undefined): string[] {
  if (!target || !source) return [];
  const sourceByName = new Map(source.columns.map((c) => [c.name, c]));
  return target.columns
    .filter((column) => {
      const counterpart = sourceByName.get(column.name);
      if (!counterpart || !isMeasure(column)) return false;
      return counterpart.kind === "numeric" || counterpart.kind === "other";
    })
    .map((c) => c.name)
    .slice(0, MAX_MEASURES);
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
        `       ${sumOf(target, measure)} - ${sumOf(source, measure)} AS total_diff`
    )
  );
  if (blocks.length === 0) return null;

  return {
    kind: "measure_totals",
    source: "recon",
    title: "Measure totals",
    description:
      "The money/quantity columns both sides carry, summed. Equal row counts with unequal totals is " +
      "the classic silent break: a join fanned out and then a filter put the count back.",
    sql: `${blocks.join("\nUNION ALL\n")};`
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
    ...wrapNote(`Measures: ${script.measureColumns.length > 0 ? script.measureColumns.join(", ") : "none found"}`, "   ")
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
  perSource: { source: string; join: KeyChoice; measures: string[] }[];
  measureColumns: string[];
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

  const perSource = group.sources.map((source) => {
    const sourceColumns = columns.get(source);
    return {
      source,
      join: joinKey(key, targetColumns, sourceColumns),
      measures: sharedMeasures(targetColumns, sourceColumns)
    };
  });

  const measureColumns = unique(perSource.flatMap((p) => p.measures));
  if (measureColumns.length === 0) {
    notes.push("No measure column is present on both sides, so there are no totals to compare.");
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
    knownFilters: unique(
      group.facts.flatMap((fact) => {
        const predicate = extractWherePredicate(fact.rawSql);
        const tidy = predicate ? tidyFilter(predicate) : "";
        return tidy ? [tidy] : [];
      })
    ),
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

/** The one query an engineer runs first: every pair in the hop, counted side by side. */
function controlTotalsSql(hopLabel: string, folderName: string, scripts: ReconScript[]): string {
  const rows = scripts.flatMap((script) =>
    script.sourceTables.map(
      (source) =>
        `SELECT ${quoted(source)} AS source_table,\n` +
        `       ${quoted(script.targetTable)} AS target_table,\n` +
        `       ${countOf(source)} AS source_rows,\n` +
        `       ${countOf(script.targetTable)} AS target_rows,\n` +
        `       ${countOf(script.targetTable)} - ${countOf(source)} AS row_diff`
    )
  );

  const rule = "=".repeat(76);
  const header = [
    `/* ${rule}`,
    `   Control totals — ${hopLabel}`,
    "",
    `   Every source/target pair this hop moves data through, counted in one result set.`,
    `   Generated by Recon from the SQL in \`${folderName}\`. Run this first; open the`,
    `   per-table script for any pair whose row_diff you cannot explain.`,
    `   ${rule} */`,
    ""
  ].join("\n");

  if (rows.length === 0) {
    return `${header}-- No source/target pair was found for this hop.\n`;
  }
  return `${header}${rows.join("\nUNION ALL\n")}\nORDER BY source_table, target_table;\n`;
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

/** Packs one hop's finished scripts, with the control-totals query that fronts them. */
export function assembleHop(hop: ReconHopFacts, scripts: ReconScript[], folderName: string): ReconHopScripts {
  return {
    fromLayer: hop.from,
    toLayer: hop.to,
    folder: hop.folder,
    scripts,
    controlTotals: {
      filename: "00_control_totals.sql",
      sql: controlTotalsSql(hop.label, folderName, scripts)
    },
    notes: hop.notes
  };
}

/** Counts up a finished suite and records how its scripts were written. */
export function summarizeSuite(params: {
  folderName: string;
  hops: ReconHopScripts[];
  columns: ColumnIndex;
  generatedBy: LocalReconciliationSuite["generatedBy"];
  notice: string | null;
}): LocalReconciliationSuite {
  const { folderName, hops, columns, generatedBy, notice } = params;
  const tablesInScope = unique(hops.flatMap((hop) => hop.scripts.flatMap((s) => [s.targetTable, ...s.sourceTables])));

  return {
    folderName,
    generatedBy,
    notice,
    hops,
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
    columns,
    generatedBy: "rules",
    notice
  });
}
