import type { LayerRef } from "../types/index.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  envInt,
  explainReconciliationChecks,
  LlmConfigError,
  type ReconCommentInput
} from "./llmClient.js";
import type { LocalProject } from "./localProject.js";
import { RULE, wrap } from "./reconciliationBundle.js";
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
 * The script returns six columns and nothing else, because six is what the question needs:
 *
 *     source_table | target_table | reconciled_column | join_type | result | comments
 *
 * The first four are read out of the project's lineage rather than chosen. `source_table` and
 * `target_table` are a pair the code actually relates; `reconciled_column` is the column the target
 * took *from that source* — followed through `kindRef`, so a renamed column is reconciled against the
 * column it was really built from and not against whatever happens to share its name — listed in the
 * order the target declares them, which is the order the transformation's own select list writes
 * them. `join_type` is how the code reaches the source: `FROM` for the driving read, `LEFT JOIN`,
 * `INNER JOIN` and the rest for everything else, which is what makes a difference interpretable.
 *
 * `result` is computed when the script runs: PASS when the two sides agree, REVIEW when they don't.
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

const VALUE_TYPE = "DECIMAL(38, 6)";

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
 * `compare` is a boolean SQL expression that is true when the two sides agree — the one place the row
 * says what "right" means, so `result` and `comments` are both written from it and cannot disagree.
 */
interface ReconRow {
  sourceTable: string;
  targetTable: string;
  column: string;
  joinType: string;
  /** What is actually compared, e.g. `SUM(revenue)` — shown to the model, not to the reader. */
  comparison: string;
  compare: string;
  /** Model-written, or empty when no model was available. */
  comment: string;
}

/** How the transformation reaches a source, in the words the `join_type` column uses. */
function joinLabel(entry: ReconSource): string {
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
function comparisonFor(field: ReconField, target: string, source: string): { comparison: string; compare: string } {
  if (field.role === "measure") {
    const typed = !field.untyped;
    const targetSide = scalar(target, `SUM(${measureExpr(field.target, typed)})`);
    const sourceSide = scalar(source, `SUM(${measureExpr(field.source, typed)})`);
    return {
      comparison: `SUM(${field.target}) against SUM(${field.source})`,
      // An empty table sums to NULL, and NULL = NULL is unknown rather than true, so both sides are
      // defaulted — two empty tables do agree.
      compare: `COALESCE(${targetSide}, 0) = COALESCE(${sourceSide}, 0)`
    };
  }

  const targetSide = scalar(target, `COUNT(DISTINCT ${field.target})`);
  const sourceSide = scalar(source, `COUNT(DISTINCT ${field.source})`);
  return {
    comparison: `COUNT(DISTINCT ${field.target}) against COUNT(DISTINCT ${field.source})`,
    compare: `${targetSide} = ${sourceSide}`
  };
}

/**
 * Every reconciliation this layer admits, in lineage order.
 *
 * Targets come in the order `gatherLayerFacts` found them, sources in the order the transformation
 * reads them — the driving `FROM` first, then each join as written — and columns in the order the
 * target declares them. Nothing here is sorted by how interesting it looks.
 */
function layerRows(facts: ReconLayerFacts): ReconRow[] {
  const rows: ReconRow[] = [];

  for (const target of facts.targets) {
    for (const entry of target.perSource) {
      for (const field of entry.fields) {
        const { comparison, compare } = comparisonFor(field, target.target, entry.source);
        rows.push({
          sourceTable: entry.source,
          targetTable: target.target,
          // `a <- b` where the transformation renamed it, so the row says which column on each side.
          column: field.target === field.source ? field.target : `${field.target} <- ${field.source}`,
          joinType: joinLabel(entry),
          comparison,
          compare,
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
          column: row.column,
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

export interface LayerReconciliationScript {
  /** Null only when no layers could be inferred and the whole project is one scope. */
  layer: LayerRef | null;
  label: string;
  filename: string;
  sql: string;
  /** Distinct source/target pairs the script reconciles. */
  pairCount: number;
  rowCount: number;
  /** Of those rows, how many carry a model-written comment. */
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

const COLUMNS = ["source_table", "target_table", "reconciled_column", "join_type", "result", "comments"];

function renderRow(row: ReconRow, first: boolean): string {
  const values = [
    quoted(row.sourceTable),
    quoted(row.targetTable),
    quoted(row.column),
    quoted(row.joinType),
    `CASE WHEN ${row.compare} THEN 'PASS' ELSE 'REVIEW' END`,
    // Same condition, opposite sense: a row that reconciles has nothing to explain. Written from the
    // one comparison rather than from a second copy of it, so the two columns cannot disagree.
    row.comment === "" ? "''" : `CASE WHEN ${row.compare} THEN '' ELSE ${quoted(tidy(row.comment))} END`
  ];

  return values
    .map((value, i) => `${i === 0 ? "SELECT " : "       "}${value}${first ? ` AS ${COLUMNS[i]}` : ""}`)
    .join(",\n");
}

function header(facts: ReconLayerFacts, rows: ReconRow[], commented: number, folderName: string, notice: string | null): string {
  const pairs = new Set(rows.map((row) => `${row.sourceTable} -> ${row.targetTable}`));

  const lines = [
    `/* ${RULE}`,
    `   Reconciliation — ${facts.label} layer`,
    "",
    ...wrap(
      `One query. It returns ${rows.length} row${rows.length === 1 ? "" : "s"} — one per column reconciled — ` +
        `across ${pairs.size} source/target pair${pairs.size === 1 ? "" : "s"} in this layer:`,
      "   "
    ),
    "",
    "     source_table | target_table | reconciled_column | join_type | result | comments",
    "",
    ...wrap(
      "The first four columns come from this project's lineage, not from a guess. `reconciled_column` is " +
        "the column the target took from that source — followed through the transformation, so a renamed " +
        "column is reconciled against the column it was really built from — and the rows are in the order " +
        "the target declares its columns. `join_type` is how the code reaches the source.",
      "   "
    ),
    "",
    ...wrap(
      "`result` is PASS when the two sides agree and REVIEW when they do not. A measure is compared by its " +
        "total, everything else by how many distinct values it holds — the comparison that still means " +
        "something once the transformation has grouped, joined or filtered.",
      "   "
    ),
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
        "that SQL. Portable: no TOP/LIMIT, so it runs unchanged on SQL Server and Databricks SQL.",
      "   "
    ),
    ""
  ];

  for (const target of facts.targets) {
    const mine = rows.filter((row) => row.targetTable === target.target);
    if (mine.length === 0) continue;
    lines.push(`   ${target.target}  <-  ${target.perSource.map((e) => `${e.source} [${joinLabel(e)}]`).join(", ")}`);
    lines.push(`     ${mine.length} column${mine.length === 1 ? "" : "s"} reconciled${
      commented > 0 ? `, ${mine.filter((row) => row.comment !== "").length} commented` : ""
    }`);
  }

  lines.push("", `   ${RULE} */`, "");
  return lines.join("\n");
}

function emptyScript(facts: ReconLayerFacts, folderName: string): LayerReconciliationScript {
  const note =
    facts.notes.join(" ") ||
    `No table in the ${facts.label} layer is built from another table this project can see, so there is ` +
      "nothing to reconcile across it.";

  return {
    layer: facts.layer,
    label: facts.label,
    filename: facts.filename,
    pairCount: 0,
    rowCount: 0,
    commentedCount: 0,
    notes: facts.notes,
    sql: [
      `/* ${RULE}`,
      `   Reconciliation — ${facts.label} layer`,
      "",
      ...wrap(note, "   "),
      `   ${RULE} */`,
      "",
      "SELECT 'NO SCOPE' AS result,",
      `       ${quoted(note)} AS comments;`,
      ""
    ].join("\n")
  };
}

function assemble(
  facts: ReconLayerFacts,
  rows: ReconRow[],
  folderName: string,
  notice: string | null
): LayerReconciliationScript {
  if (rows.length === 0) return emptyScript(facts, folderName);

  const commented = rows.filter((row) => row.comment !== "").length;
  const body =
    `${rows.map((row, i) => renderRow(row, i === 0)).join("\nUNION ALL\n")}\n` +
    // Grouped the way it is read: everything about one pair together, columns in lineage order.
    "ORDER BY target_table, source_table;\n";

  return {
    layer: facts.layer,
    label: facts.label,
    filename: facts.filename,
    pairCount: new Set(rows.map((row) => `${row.sourceTable} -> ${row.targetTable}`)).size,
    rowCount: rows.length,
    commentedCount: commented,
    notes: facts.notes,
    sql: `${header(facts, rows, commented, folderName, notice)}${body}`
  };
}

/**
 * The per-layer reconciliation for a whole project, with the reviewer model's comments where it could
 * be reached.
 *
 * `useAi` false, or Azure OpenAI unconfigured, still produces every script — the four lineage columns
 * and the PASS/REVIEW comparison need no model at all. Only the explanation is lost, and the file says
 * so where the explanation would have been.
 */
export async function buildLayerReconciliation(
  project: LocalProject,
  layers: LayerRef[],
  useAi: boolean
): Promise<LayerReconciliationSuite> {
  const grounding = gatherLayerFacts(project, layers);
  const perLayer = grounding.layers.map((facts) => ({ facts, rows: layerRows(facts) }));

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

  const scripts = perLayer.map(({ facts, rows }) => assemble(facts, rows, project.folderName, notice));

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
    "One .sql per layer. Each returns six columns:",
    "  source_table, target_table, reconciled_column, join_type, result, comments",
    "",
    "result is PASS or REVIEW. On REVIEW, comments says what in your own transformation SQL would",
    "explain it — the filter, the join, the CASE, the cast. It is a reading of the code rather than a",
    "measurement, so it is a first place to look rather than a verdict.",
    ...(suite.notice ? ["", `Note: ${suite.notice}`] : []),
    ""
  ];

  for (const script of suite.scripts) {
    lines.push(
      `${script.filename} (${script.label}): ${script.pairCount} pair(s), ${script.rowCount} column(s)` +
        `${script.rowCount === 0 ? " — nothing to reconcile in this layer" : ""}`
    );
  }

  return `${lines.join("\n")}\n`;
}
