import type { LayerRef } from "../types/index.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  envInt,
  explainReconciliationChecks,
  LlmConfigError,
  type ReconCommentInput
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
import { platformNote, type SqlPlatform } from "./sqlPlatform.js";
import {
  gatherLayerFacts,
  lineageStatements,
  measureExpr,
  type ReconField,
  type ReconLayerFacts,
  type ReconSource,
  type ReconTargetFacts
} from "./reconciliationScripts.js";
import type { LineageFact } from "./tableLineage.js";

/**
 * One SQL script per pipeline layer, answering the question a data engineer reconciles by hand:
 * *for every table in this layer, does each column still agree with the table it came from?*
 *
 * The script returns ten columns and nothing else, because ten is what the question needs:
 *
 *     source_table | target_table | source_column | target_column | type
 *     source_value | target_value | accuracy | result | comments
 *
 * The first five are read out of the project's lineage rather than chosen. `source_table` and
 * `target_table` are a pair the code actually relates; `source_column` and `target_column` are the two
 * ends of one column's lineage — the column the target took *from that source*, followed through
 * `kindRef`, so a renamed column is reconciled against the column it was really built from and not
 * against whatever happens to share its name.
 *
 * They are **two columns rather than one** because a rename is the thing on the row a reader most needs
 * to act on, and the single `target <- source` cell that used to carry it hid exactly that: it reads as
 * one name until you look twice, and a reader who wants the column in the source's own DDL has to take
 * the cell apart by hand before they can search for it. Split, either side can be searched, sorted or
 * joined against a schema on its own. Where the transformation renamed nothing the two hold the same
 * name — so the pair is read the same way on every row, and a difference between them *is* the rename.
 * They are listed in the order the target declares them, which is the order the transformation's own
 * select list writes them. `type` is how the code reaches the source: `FROM` for the driving read,
 * `LEFT JOIN`, `INNER JOIN` and the rest for everything else, which is what makes a difference
 * interpretable.
 *
 * `source_value` and `target_value` are the two numbers the row is about — a measure's total, or a
 * distinct-value count for everything else. Each is measured once, in a derived table the row selects
 * from, and everything that depends on them reads them from there by name.
 *
 * `accuracy` is how much of the source's own value the target still carries, as a percentage, and it
 * is what `result` is graded from: `100.00%` and PASS, below 75% and FAIL, anything between and
 * REVIEW. A yes/no verdict was not enough on its own, because the rows under it are not alike — a
 * column two values short of its source's four hundred and a column built from the wrong table were
 * both REVIEW, and only one of them is a morning's work.
 *
 * PASS means the two numbers are equal and nothing looser. The percentage is floored rather than
 * rounded for exactly that reason: a column three values short of four million works out at 99.9999%,
 * and a row that did not tie out must not print as one that did.
 *
 * `comments` is the reason, and it is **written by the reviewer model**, not by this file. Recon reads
 * code and never reads data, so no amount of static analysis can say why two numbers differ — but the
 * code *can* say what would make them differ, and that is a reading job. The model is given the
 * transformation SQL that builds the table, told exactly what the row compares, and asked to name and
 * quote the fragment responsible: the WHERE, the join, the GROUP BY, the CASE, the cast, the default.
 * The answer is a first place to look rather than a verdict — it is a reading of code, so it can be
 * wrong — and the file says so at the top rather than letting confident prose imply otherwise.
 *
 * Without Azure OpenAI configured there is no comment. The column is emitted empty and the header
 * says why, because a hand-written stand-in would be exactly the hardcoded generic advice this is
 * meant to replace — the same sentence for every project, which is worse than an honest blank.
 */

/** Rows compared per model call. One target's columns against one source, so the code shown fits. */
const MAX_ROWS_PER_CALL = envInt("RECON_COMMENT_ROWS_PER_CALL", 40, 5, 200);
/** Calls in flight at once. */
const COMMENT_CONCURRENCY = envInt("RECON_COMMENT_CONCURRENCY", 4, 1, 8);
/** Per-call ceiling — generous, since the prompt carries a whole transformation. */
const COMMENT_TIMEOUT_MS = envInt("RECON_COMMENT_TIMEOUT_MS", 240_000, 10_000, 900_000);
/**
 * Output budget per row, and a floor under the whole call.
 *
 * The floor matters more than the rate: a batch of six rows against a long procedure is exactly where
 * the model has most to say, and a budget scaled only by row count cuts it off mid-sentence — which
 * costs a retry and, if the retry also truncates, the table its comments.
 */
const COMMENT_TOKENS_PER_ROW = envInt("RECON_COMMENT_TOKENS_PER_ROW", 320, 60, 2000);
const MIN_COMMENT_TOKENS = envInt("RECON_COMMENT_MIN_TOKENS", 3000, 500, 32_000);
/** Attempts after the first. A timeout or a rate limit is transient and costs a table its comments. */
const COMMENT_RETRIES = envInt("RECON_COMMENT_RETRIES", 2, 0, 10);
/** Backoff before the first retry, doubling each time. */
const RETRY_BACKOFF_MS = envInt("RECON_COMMENT_RETRY_BACKOFF_MS", 2000, 0, 60_000);
/** Characters of any one statement shown to the model. */
const MAX_SQL_CHARS = envInt("RECON_COMMENT_SQL_CHARS", 20_000, 500, 200_000);
/** Total code budget per call, so one enormous procedure can't crowd out the rest of the chain. */
const MAX_SQL_CHARS_PER_CALL = envInt("RECON_COMMENT_SQL_BUDGET", 60_000, 1000, 400_000);
/** How far up the lineage the context reaches — enough to see where a column was derived. */
const UPSTREAM_HOPS = envInt("RECON_COMMENT_UPSTREAM_HOPS", 2, 0, 8);
/** Longest comment written into the SQL before it is cut back to its last whole sentence. */
const MAX_COMMENT_CHARS = 1000;

/** Line break in generated SQL, named so template literals that build SQL stay readable. */
const NEWLINE = "\n";

/**
 * The file a layer with no tables of its own gets, in place of the per-table ones it has none of.
 *
 * Uppercase and prefixed, so it can never collide with a real table's file and sorts away from them.
 */
const LAYER_NOT_RECONCILED = "_LAYER_NOT_RECONCILED.sql";

// ---- small SQL helpers ----

/**
 * A SQL string literal, with the three characters that could break out of it neutralised.
 *
 * Doubling the quote is what makes it a literal at all.
 *
 * The **backslash** is the one that matters and the one that is easy to miss. Model-written prose
 * quoting a SQL fragment comes back carrying the model's own escaping — `customer_name <> \'\'` — and
 * a backslash means two different things on the two engines these scripts promise to run on: SQL
 * Server treats it as an ordinary character, while Spark reads it as an escape, so `\''` closes the
 * literal a character early and the rest of the query becomes garbage. Stripping it loses nothing —
 * it is punctuation the model added, not something a reader needs.
 *
 * The **semicolon** is dropped because each script is a single statement, so one `;` in a sentence
 * turns it into two for everything that splits on the character rather than parsing. An em dash rather
 * than a comma: the model uses semicolons where a clause ends, and a comma there produces a run-on
 * that reads like a different sentence than the one it wrote. The prompt asks it not to use them at
 * all, so this is the safety net rather than the mechanism.
 */
function quoted(text: string): string {
  return `'${text.replace(/\\/g, "").replace(/'/g, "''").replace(/\s*;\s*/g, " — ")}'`;
}

function cast(expr: string): string {
  return `CAST(${expr} AS ${VALUE_TYPE})`;
}

/**
 * A comment trimmed to fit, cut back to its last whole sentence rather than mid-word.
 *
 * The last sentence is the one that says what to do about it, so a hard character cut throws away the
 * most useful part and leaves the reader with a dangling clause.
 */
function tidy(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_COMMENT_CHARS) return flat;

  const cut = flat.slice(0, MAX_COMMENT_CHARS);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastStop > MAX_COMMENT_CHARS / 2 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}


// ---- one row of the six-column table ----

/**
 * A single reconciliation: one column of one target, against the source it came from.
 *
 * There is no condition on the row saying when it passes: every row passes when its two numbers are
 * equal, and both are named by `AGREE` once for the whole file. `result`, `accuracy` and `comments`
 * are all written from that one condition and so cannot disagree with each other.
 */
interface ReconRow {
  sourceTable: string;
  targetTable: string;
  /**
   * The two ends of one column's lineage, kept apart rather than folded into one cell. Equal wherever
   * the transformation renamed nothing, which is what lets both be read the same way on every row.
   */
  sourceColumn: string;
  targetColumn: string;
  joinType: string;
  /** What is actually compared, e.g. `SUM(revenue)` — shown to the model, not to the reader. */
  comparison: string;
  /**
   * The two numbers the row is about, as SQL. Measured once each in the row's own derived table and
   * read from there by every column that depends on them, so what the reader sees and what decides
   * PASS can never be two different measurements.
   */
  sourceValue: string;
  targetValue: string;
  /** Model-written, or empty when no model was available. */
  comment: string;
}

/**
 * How the transformation reaches a source, in the words the `type` column uses.
 *
 * Exported because the generated document describes this report table by table, and a document that
 * called the same thing a "left join" where the script says `LEFT JOIN` would be describing a
 * different file. One function, one vocabulary.
 */
export function joinLabel(entry: ReconSource): string {
  if (entry.role === "incidental") return "READ SEPARATELY";
  return entry.joinKind === "from" ? "FROM" : `${entry.joinKind.toUpperCase()} JOIN`;
}

function scalar(table: string, expression: string): string {
  return `(SELECT ${expression} FROM ${table})`;
}

/**
 * What comparing this column could mean, decided by `columnRole` upstream.
 *
 * A measure is totalled, because a total is the number that has to survive a transformation. Anything
 * else is compared by how many distinct values it holds — which is the question that still means
 * something for a key, a label, a date or a name, and the one that survives the grouping and the
 * fan-out that make a row count differ for reasons that are not defects. `SUM(status)` is the mistake
 * this avoids: it either errors or returns a number that reconciles to nothing.
 */
function comparisonFor(
  field: ReconField,
  target: string,
  source: string,
  platform: SqlPlatform
): { comparison: string; sourceValue: string; targetValue: string } {
  if (field.role === "measure") {
    const typed = !field.untyped;
    // An empty table sums to NULL, and NULL = NULL is unknown rather than true, so both sides are
    // defaulted — two empty tables do agree. The defaulting happens here, on the one expression the
    // row measures with, so the printed value, the verdict and the percentage all see the same 0.
    const targetValue = `COALESCE(${scalar(target, `SUM(${measureExpr(field.target, typed, platform)})`)}, 0)`;
    const sourceValue = `COALESCE(${scalar(source, `SUM(${measureExpr(field.source, typed, platform)})`)}, 0)`;
    return {
      comparison: `SUM(${field.target}) against SUM(${field.source})`,
      sourceValue,
      targetValue
    };
  }

  return {
    comparison: `COUNT(DISTINCT ${field.target}) against COUNT(DISTINCT ${field.source})`,
    sourceValue: scalar(source, `COUNT(DISTINCT ${field.source})`),
    targetValue: scalar(target, `COUNT(DISTINCT ${field.target})`)
  };
}

/**
 * Every reconciliation this layer admits, in lineage order.
 *
 * Targets come in the order `gatherLayerFacts` found them, sources in the order the transformation
 * reads them — the driving `FROM` first, then each join as written — and columns in the order the
 * target declares them. Nothing here is sorted by how interesting it looks.
 */
function layerRows(facts: ReconLayerFacts, platform: SqlPlatform): ReconRow[] {
  const rows: ReconRow[] = [];

  for (const target of facts.targets) {
    for (const entry of target.perSource) {
      for (const field of entry.fields) {
        const { comparison, sourceValue, targetValue } = comparisonFor(
          field,
          target.target,
          entry.source,
          platform
        );
        rows.push({
          sourceTable: entry.source,
          targetTable: target.target,
          sourceColumn: field.source,
          targetColumn: field.target,
          joinType: joinLabel(entry),
          comparison,
          sourceValue,
          targetValue,
          comment: ""
        });
      }
    }
  }

  return rows;
}

// ---- asking the model why a row might not tie out ----

/** The code the model is shown for one target: the statements that build it, then what built those. */
function codeFor(target: ReconTargetFacts, allFacts: LineageFact[]): { path: string; builds: string; sql: string }[] {
  const out: { path: string; builds: string; sql: string }[] = [];
  let budget = MAX_SQL_CHARS_PER_CALL;

  for (const { fact, builds } of lineageStatements(allFacts, target.target, UPSTREAM_HOPS)) {
    if (budget <= 0) break;
    const sql = fact.rawSql.slice(0, Math.min(MAX_SQL_CHARS, budget));
    budget -= sql.length;
    out.push({ path: fact.notebookPath, builds, sql });
  }

  return out;
}

interface CommentBatch {
  scope: string;
  target: ReconTargetFacts;
  /** Indices into the layer's row list, so answers land back on the rows that asked. */
  rowIndices: number[];
  inputs: ReconCommentInput[];
}

function batchesFor(facts: ReconLayerFacts, rows: ReconRow[]): CommentBatch[] {
  const batches: CommentBatch[] = [];

  for (const target of facts.targets) {
    const mine = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.targetTable === target.target);

    for (let at = 0; at < mine.length; at += MAX_ROWS_PER_CALL) {
      const slice = mine.slice(at, at + MAX_ROWS_PER_CALL);
      batches.push({
        scope: `${facts.label} — ${target.target}`,
        target,
        rowIndices: slice.map(({ index }) => index),
        inputs: slice.map(({ row }) => ({
          sourceTable: row.sourceTable,
          targetTable: row.targetTable,
          sourceColumn: row.sourceColumn,
          targetColumn: row.targetColumn,
          joinType: row.joinType,
          comparison: row.comparison
        }))
      });
    }
  }

  return batches;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runBatch(
  batch: CommentBatch,
  allFacts: LineageFact[]
): Promise<{ index: number; comment: string }[] | null> {
  const code = codeFor(batch.target, allFacts);

  for (let attempt = 0; attempt <= COMMENT_RETRIES; attempt++) {
    if (attempt > 0) await wait(RETRY_BACKOFF_MS * 2 ** (attempt - 1));
    try {
      const comments = await explainReconciliationChecks(batch.scope, batch.inputs, code, {
        timeoutMs: COMMENT_TIMEOUT_MS,
        maxOutputTokens: Math.max(MIN_COMMENT_TOKENS, batch.inputs.length * COMMENT_TOKENS_PER_ROW)
      });
      return batch.rowIndices.map((index, i) => ({ index, comment: comments[i] ?? "" }));
    } catch (err) {
      // Configuration is not transient — there is no key to retry with, and the caller has a
      // different thing to say about it than about a timeout.
      if (err instanceof LlmConfigError) throw err;
      if (attempt === COMMENT_RETRIES) {
        console.warn(`[recon] no comments for ${batch.scope}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }
  }

  return null;
}

// ---- the file ----

/**
 * One table of a layer, as the file that reconciles it.
 *
 * A file per table rather than one per layer because that is the unit the work is picked up in: a
 * layer report for a fourteen-table stage is a query nobody runs whole, and the row that matters is
 * found by scrolling. Split, the file *is* the answer to "does this table still agree with what built
 * it", and it can be handed to whoever owns that table on its own.
 */
export interface LayerTableScript {
  /** The table this file reconciles, as the project's SQL names it. */
  table: string;
  /** `customer.sql` — inside the layer's folder, so the layer is not repeated in every name. */
  filename: string;
  sql: string;
  /** Distinct sources this table is reconciled against. */
  pairCount: number;
  rowCount: number;
  /** Of those rows, how many carry a model-written comment. */
  commentedCount: number;
}

export interface LayerReconciliationScript {
  /** Null only when no layers could be inferred and the whole project is one scope. */
  layer: LayerRef | null;
  label: string;
  /** `03_transformation` — the folder these files go in, position first so layers list in order. */
  folder: string;
  /** One per table in the layer, including any that reconciles nothing and says why. */
  tables: LayerTableScript[];
  /** Distinct source/target pairs the layer reconciles, across every table. */
  pairCount: number;
  rowCount: number;
  commentedCount: number;
  notes: string[];
}

export interface LayerReconciliationSuite {
  folderName: string;
  scripts: LayerReconciliationScript[];
  /** Why the comments column is empty, when it is. Null when the model wrote them. */
  notice: string | null;
  stats: { layerCount: number; rowCount: number; commentedCount: number };
}

const COLUMNS = [
  "source_table",
  "target_table",
  "source_column",
  "target_column",
  "type",
  "source_value",
  "target_value",
  "accuracy",
  "result",
  "comments"
];

/**
 * When a row reconciles, in terms of the two numbers it prints.
 *
 * One condition for the whole file, because there is only one question: are these two numbers the
 * same? `result`, `accuracy` and `comments` are each written from it, so a PASS can never appear
 * beside two numbers that differ, and a REVIEW never beside `100.00%` or an empty comment.
 */
const AGREE = "v.target_value = v.source_value";

/**
 * `accuracy`: 100 where the two sides agree, and otherwise how much of the source's own value the
 * target still carries — `100 * (|source| - |target - source|) / |source|`.
 *
 * The middle branch is the floor under the answer. A target holding three times its source's total is
 * not -200% accurate, it is 0, and a source of 0 against a target that has rows would otherwise divide
 * by zero; both are caught by the same test, since a gap can only reach the whole it is measured
 * against when that whole is small enough for the answer to be nothing.
 *
 * `FLOOR(… * 10000) / 100` rather than `ROUND(…, 2)` because the percentage decides the verdict: a
 * column three values short of four million rounds to 100.00 and must not, since `result` reads PASS
 * only on `100.00%`. Rounding down is also the honest direction for an accuracy figure — it never
 * claims more agreement than there is.
 *
 * The formula itself is `reconciliationBundle.accuracyExpr`, shared with the hop bundles exactly as
 * `gradeExpr` is: a percentage graded one way in one generated file and another way in the next is two
 * tools. What is local is the rest of the row — `AGREE` restated against the inner derived table's
 * alias, since that is where the two values are named.
 */
const ACCURACY = accuracyExpr(
  AGREE.replace(/\bv\./g, "m."),
  "ABS(m.target_value - m.source_value)",
  "ABS(m.source_value)"
);

/**
 * Where the row's numbers are worked out: the two values in the inner derived table, the percentage
 * over them in the outer one, and nothing computed twice.
 *
 * Each side is scanned once per row rather than once per column that mentions it — the row prints two
 * values, grades a result from the percentage and works the percentage out from those same two values,
 * and every reference above is to a name rather than to a repeated expression. It is also the only way
 * the printed percentage and the verdict beside it can be guaranteed to be the same measurement.
 *
 * The cast belongs in the inner table, before any arithmetic sees the numbers, for two reasons: the
 * column carries both a measure's total, which has a scale, and a distinct count, which has not — and
 * on SQL Server a percentage worked out from two integers is integer division, which returns 0 or 1
 * and never a percentage.
 */
function measured(row: ReconRow): string {
  return (
    `FROM (SELECT m.source_value,\n` +
    `             m.target_value,\n` +
    `             ${ACCURACY} AS accuracy_pct\n` +
    `      FROM (SELECT ${cast(row.sourceValue)} AS source_value,\n` +
    `                   ${cast(row.targetValue)} AS target_value) m) v`
  );
}

function renderRow(row: ReconRow, first: boolean): string {
  const values = [
    quoted(row.sourceTable),
    quoted(row.targetTable),
    // Two columns, not one. Identical on a row the transformation did not rename, so a reader never
    // has to work out which of two forms a cell is in before they can use it.
    quoted(row.sourceColumn),
    quoted(row.targetColumn),
    quoted(row.joinType),
    // Named, not measured: all three were worked out once by `measured` below.
    "v.source_value",
    "v.target_value",
    percentText("v.accuracy_pct"),
    gradeExpr(AGREE, "v.accuracy_pct"),
    // Same condition, opposite sense: a row that reconciles has nothing to explain.
    row.comment === "" ? "''" : `CASE WHEN ${AGREE} THEN '' ELSE ${quoted(tidy(row.comment))} END`
  ];

  const select = values
    .map((value, i) => `${i === 0 ? "SELECT " : "       "}${value}${first ? ` AS ${COLUMNS[i]}` : ""}`)
    .join(",\n");

  return `${select}\n${measured(row)}`;
}

/**
 * The preamble on one table's file.
 *
 * Repeated in full on every file rather than written once per layer, because a file opened on its own
 * — which is the point of splitting them — has to explain its own columns and its own grading. What is
 * *scoped* to the table is the top and the tail: what this file covers, and what it is built from.
 */
function header(
  facts: ReconLayerFacts,
  target: ReconTargetFacts,
  rows: ReconRow[],
  commented: number,
  folderName: string,
  notice: string | null,
  platform: SqlPlatform
): string {
  const pairs = new Set(rows.map((row) => `${row.sourceTable} -> ${row.targetTable}`));

  const lines = [
    `/* ${RULE}`,
    `   Reconciliation — ${target.target}   (${facts.label} layer)`,
    "",
    ...wrap(
      `One query. It returns ${rows.length} row${rows.length === 1 ? "" : "s"} — one per column of ` +
        `${target.target} reconciled — across the ${pairs.size} source${pairs.size === 1 ? "" : "s"} it ` +
        "is built from:",
      "   "
    ),
    "",
    "     source_table | target_table | source_column | target_column | type |",
    "     source_value | target_value | accuracy | result | comments",
    "",
    ...wrap(
      "The first five columns come from this project's lineage, not from a guess. `source_column` and " +
        "`target_column` are the two ends of one column's lineage: the column the target took from that " +
        "source, followed through the transformation, so a renamed column is reconciled against the column " +
        "it was really built from. They hold the same name wherever nothing was renamed, so where they " +
        "differ, that difference is the rename. The rows are in the order the target declares its columns, " +
        "and `type` is how the code reaches the source.",
      "   "
    ),
    "",
    ...wrap(
      "A measure is compared by its total, everything else by how many distinct values it holds — the " +
        "comparison that still means something once the transformation has grouped, joined or " +
        "filtered. `accuracy` is how much of the source's own value the target still carries, and " +
        "`result` is graded from it:",
      "   "
    ),
    "",
    "     PASS    100.00% — the two numbers are equal. Nothing looser: the percentage",
    "             is floored, so a column three values short of four million reads",
    "             99.99% and reviews.",
    `     REVIEW  ${FAIL_BELOW_PERCENT}% or more, but not all of it. Something in the transformation`,
    "             has to explain the gap — a filter, a join, a CASE, a cast.",
    `     FAIL    below ${FAIL_BELOW_PERCENT}%: a quarter or more of the source's value never reached the`,
    "             target. That is structural rather than incidental — the wrong source,",
    "             a join matching nothing, or a column that is not what its name says.",
    "",
    ...(notice
      ? wrap(`\`comments\` is empty on every row: ${notice}`, "   ")
      : wrap(
          "`comments` is written by the reviewer model, which was given the transformation SQL behind each " +
            "table and asked what in that code would stop the two sides agreeing. It names and quotes the " +
            "fragment responsible. It is a reading of the code and not a measurement, so treat it as the " +
            "first place to look rather than as a verdict — it can be wrong, and it is blank on any row " +
            "that passes.",
          "   "
        )),
    "",
    ...wrap(
      `Generated by Recon from the SQL in \`${folderName}\`. Every table and column named here came from ` +
        `that SQL. ${platformNote(platform)}`,
      "   "
    ),
    ""
  ];

  lines.push(`   ${target.target}  <-  ${target.perSource.map((e) => `${e.source} [${joinLabel(e)}]`).join(", ")}`);
  lines.push(
    `     ${rows.length} column${rows.length === 1 ? "" : "s"} reconciled${
      commented > 0 ? `, ${rows.filter((row) => row.comment !== "").length} commented` : ""
    }`
  );

  // The rest of the layer is named rather than left to the folder listing. A reader who opened one
  // file needs to know how much of the stage it is, and a table that reconciles nothing — no lineage,
  // or sources this project never declares — is where an unnoticed gap lives, so it is listed here
  // exactly like the others and its own file says why.
  const others = facts.targets.filter((other) => other.target !== target.target);
  if (others.length > 0) {
    lines.push("", `   The rest of the ${facts.label} layer, one file each in this folder:`);
    for (const other of others) lines.push(`     ${other.filename}   ${other.target}`);
  }

  lines.push("", `   ${RULE} */`, "");
  return lines.join("\n");
}

/**
 * Why a layer produced no rows — three different answers, and saying the wrong one sends the reader
 * looking in the wrong place.
 *
 * The one that used to be given for all three cases, "nothing here is built from another table", is
 * plainly false for a layer whose tables *are* built from something whose columns this project never
 * declares. That is the common case for a pipeline whose first stage reads a feed defined elsewhere,
 * and the fix for it — get the source's DDL into the folder — is nothing like the fix for a layer
 * that genuinely has no lineage.
 */
function emptyReason(facts: ReconLayerFacts): string {
  if (facts.notes.length > 0) return facts.notes.join(" ");
  if (facts.targets.length === 0) {
    return `No table in this project belongs to the ${facts.label} layer, so there is nothing to reconcile across it.`;
  }

  // A source is paired with the target whether or not anything is known about its columns, so what
  // says "nothing to line up" is an empty `fields`, not an empty `perSource`.
  const unknown = Array.from(
    new Set(
      facts.targets.flatMap((target) =>
        target.perSource.length === 0
          ? target.sources
          : target.perSource.filter((entry) => entry.fields.length === 0).map((entry) => entry.source)
      )
    )
  );
  if (unknown.length > 0) {
    return (
      `Every table in the ${facts.label} layer is built from tables whose columns this project never ` +
      `declares (${unknown.slice(0, 6).join(", ")}${unknown.length > 6 ? ", ..." : ""}), so there is no ` +
      "column on both sides to line up. Add their CREATE TABLE statements to this folder and re-run to " +
      "reconcile this layer."
    );
  }

  return (
    `No table in the ${facts.label} layer is built from another table this project can see, so there is ` +
    "nothing to reconcile across it."
  );
}

/**
 * Why one table of a layer produced no row. Three answers, and they call for three different things:
 * a table with no lineage may be an entry point or may be a gap in what was uploaded, while a table
 * whose sources have no declared columns needs their DDL adding to the folder.
 */
function noRowReason(target: ReconTargetFacts): string {
  if (target.sources.length === 0) {
    return "nothing in this project builds it, so there is no source to reconcile it against";
  }
  const unknown = target.perSource.filter((entry) => entry.fields.length === 0).map((entry) => entry.source);
  const named = unknown.length > 0 ? unknown : target.sources;
  return (
    `no column is known on both sides — this project never declares the columns of ` +
    `${named.slice(0, 4).join(", ")}${named.length > 4 ? ", ..." : ""}`
  );
}

/** A `SELECT` that returns the reason instead of a reconciliation, so an empty file is never silent. */
function noScopeSql(title: string, note: string): string {
  return [
    `/* ${RULE}`,
    `   Reconciliation — ${title}`,
    "",
    ...wrap(note, "   "),
    `   ${RULE} */`,
    "",
    "SELECT 'NO SCOPE' AS result,",
    `       ${quoted(note)} AS comments;`,
    ""
  ].join(NEWLINE);
}

/**
 * The file written for a table that reconciles nothing — and the one written for a whole layer that
 * has no table at all.
 *
 * A table with no row still gets its own file, for the same reason it used to get its own line in the
 * layer report: three of a layer's five tables silently reconciled reads as five that passed, and the
 * two that were dropped are the ones worth knowing about. A folder with three files where the layer
 * has five tables says nothing at all about the other two.
 */
function noScopeTable(target: ReconTargetFacts, facts: ReconLayerFacts): LayerTableScript {
  return {
    table: target.target,
    filename: target.filename,
    pairCount: 0,
    rowCount: 0,
    commentedCount: 0,
    sql: noScopeSql(
      `${target.target}   (${facts.label} layer)`,
      `${target.target} is not reconciled here: ${noRowReason(target)}.`
    )
  };
}

function emptyScript(facts: ReconLayerFacts, folderName: string): LayerReconciliationScript {
  const note = emptyReason(facts);

  return {
    layer: facts.layer,
    label: facts.label,
    folder: facts.folder,
    pairCount: 0,
    rowCount: 0,
    commentedCount: 0,
    notes: facts.notes,
    // A folder holding one file that says why, rather than an absent folder: a layer that is missing
    // from the listing is indistinguishable from one the run never got to.
    tables: [
      {
        table: "",
        filename: LAYER_NOT_RECONCILED,
        pairCount: 0,
        rowCount: 0,
        commentedCount: 0,
        sql: noScopeSql(`${facts.label} layer`, note)
      }
    ]
  };
}

/**
 * One layer, as a folder of one file per table.
 *
 * The rows are the layer's, so the split happens here rather than upstream: the reviewer model is
 * asked about a whole layer at a time (`batchesFor` batches per target within it) and every table's
 * comments come back together. Splitting after that means the files are exactly the layer report the
 * model was asked about, cut along the line a reader picks the work up on.
 */
function assemble(
  facts: ReconLayerFacts,
  rows: ReconRow[],
  folderName: string,
  notice: string | null,
  platform: SqlPlatform
): LayerReconciliationScript {
  if (facts.targets.length === 0) return emptyScript(facts, folderName);

  const tables = facts.targets.map((target) => {
    const mine = rows.filter((row) => row.targetTable === target.target);
    if (mine.length === 0) return noScopeTable(target, facts);

    const commented = mine.filter((row) => row.comment !== "").length;
    const body =
      `${mine.map((row, i) => renderRow(row, i === 0)).join(`${NEWLINE}UNION ALL${NEWLINE}`)}${NEWLINE}` +
      // Grouped the way it is read: everything about one source together, columns in lineage order.
      `ORDER BY source_table;${NEWLINE}`;

    return {
      table: target.target,
      filename: target.filename,
      pairCount: new Set(mine.map((row) => row.sourceTable)).size,
      rowCount: mine.length,
      commentedCount: commented,
      sql: `${header(facts, target, mine, commented, folderName, notice, platform)}${body}`
    };
  });

  return {
    layer: facts.layer,
    label: facts.label,
    folder: facts.folder,
    tables,
    pairCount: new Set(rows.map((row) => `${row.sourceTable} -> ${row.targetTable}`)).size,
    rowCount: rows.length,
    commentedCount: rows.filter((row) => row.comment !== "").length,
    notes: facts.notes
  };
}

/**
 * The per-layer reconciliation for a whole project, with the reviewer model's comments where it could
 * be reached.
 *
 * `useAi` false, or Azure OpenAI unconfigured, still produces every script — the five lineage columns
 * and the PASS/REVIEW comparison need no model at all. Only the explanation is lost, and the file says
 * so where the explanation would have been.
 */
export async function buildLayerReconciliation(
  project: LocalProject,
  layers: LayerRef[],
  useAi: boolean,
  platform: SqlPlatform = "portable"
): Promise<LayerReconciliationSuite> {
  const grounding = gatherLayerFacts(project, layers);
  const perLayer = grounding.layers.map((facts) => ({ facts, rows: layerRows(facts, platform) }));

  let notice: string | null = useAi
    ? null
    : "run with --no-ai, so the reviewer model was not asked why any row might not tie out.";

  if (useAi) {
    const batches = perLayer.flatMap(({ facts, rows }) =>
      batchesFor(facts, rows).map((batch) => ({ batch, rows }))
    );

    if (batches.length > 0) {
      try {
        const answers = await mapWithConcurrency(batches, COMMENT_CONCURRENCY, ({ batch, rows }) =>
          runBatch(batch, project.facts).then((result) => ({ rows, result }))
        );
        for (const { rows, result } of answers) {
          for (const { index, comment } of result ?? []) rows[index].comment = comment;
        }
        const wrote = perLayer.some(({ rows }) => rows.some((row) => row.comment !== ""));
        if (!wrote) {
          notice =
            "the reviewer model did not return an explanation for any row. Check the AZURE_OPENAI_* " +
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
  }

  const scripts = perLayer.map(({ facts, rows }) => assemble(facts, rows, project.folderName, notice, platform));

  return {
    folderName: project.folderName,
    scripts,
    notice,
    stats: {
      layerCount: scripts.length,
      rowCount: scripts.reduce((n, script) => n + script.rowCount, 0),
      commentedCount: scripts.reduce((n, script) => n + script.commentedCount, 0)
    }
  };
}

/** The plain-text summary written beside the scripts, so the folder explains itself. */
export function summarizeLayerReconciliation(suite: LayerReconciliationSuite, generatedAt: Date): string {
  const lines = [
    `Per-layer reconciliation for ${suite.folderName}`,
    `Generated: ${generatedAt.toISOString()}`,
    "",
    `${suite.stats.layerCount} layer(s), ${suite.stats.rowCount} column reconciliation(s), ` +
      `${suite.stats.commentedCount} with a reviewer-model comment.`,
    "",
    "One folder per layer, in pipeline order, and inside it one .sql per table of that layer.",
    "Each returns ten columns:",
    "  source_table, target_table, source_column, target_column, type,",
    "  source_value, target_value, accuracy, result, comments",
    "",
    "source_value and target_value are rounded to two decimal places before they are compared, so a",
    "difference under half a cent reads as agreement rather than printing two identical numbers next",
    "to a REVIEW.",
    "",
    "source_column and target_column are the same column at both ends of its lineage — the same name",
    "wherever the transformation renamed nothing, and where they differ, that difference is the rename.",
    "",
    "source_value and target_value are the two numbers compared. accuracy is how much of the source's",
    "value the target still carries, and result is graded from it: 100.00% passes, below 75% fails,",
    "anything between reviews. On anything but a PASS,",
    "comments says what in your own transformation SQL would",
    "explain it — the filter, the join, the CASE, the cast. It is a reading of the code rather than a",
    "measurement, so it is a first place to look rather than a verdict.",
    ...(suite.notice ? ["", `Note: ${suite.notice}`] : []),
    ""
  ];

  for (const script of suite.scripts) {
    lines.push(
      "",
      `${script.folder}/ (${script.label}): ${script.tables.length} table(s), ${script.pairCount} pair(s), ` +
        `${script.rowCount} column(s)${script.rowCount === 0 ? " — nothing to reconcile in this layer" : ""}`
    );
    for (const table of script.tables) {
      lines.push(
        `  ${script.folder}/${table.filename}: ` +
          (table.rowCount === 0
            ? "nothing to reconcile — the file says why"
            : `${table.pairCount} source(s), ${table.rowCount} column(s)` +
              `${table.commentedCount > 0 ? `, ${table.commentedCount} commented` : ""}`)
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
