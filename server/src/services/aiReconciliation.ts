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
import type { ColumnIndex } from "./sqlColumns.js";
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

function columnList(index: ColumnIndex, table: string): { table: string; columns: string; note: string } | null {
  const entry = index.get(table);
  if (!entry || entry.columns.length === 0) return null;

  const shown = entry.columns.slice(0, MAX_COLUMNS_LISTED);
  const note = [
    entry.origin === "ddl" ? "from CREATE TABLE" : "inferred from the select list that builds it",
    entry.incomplete ? "possibly incomplete" : "",
    shown.length < entry.columns.length ? `${entry.columns.length - shown.length} more not shown` : ""
  ]
    .filter(Boolean)
    .join(", ");

  return {
    table,
    columns: shown.map((c) => (c.dataType ? `${c.name} ${c.dataType}` : c.name)).join(", "),
    note
  };
}

/**
 * Renders one target's grounding for the prompt.
 *
 * `baseChecks` are the checks already written for this table, listed by title so the model doesn't
 * spend its answer — and the caller's wall-clock — reproducing them.
 */
function promptFor(facts: ReconTargetFacts, columns: ColumnIndex, baseChecks: ReconCheck[]): ReconTargetPrompt {
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
    columns: [facts.target, ...facts.sources].flatMap((table) => {
      const list = columnList(columns, table);
      return list ? [list] : [{ table, columns: "(unknown — nothing in the folder describes this table)", note: "" }];
    }),
    keyHint:
      facts.key.columns.length > 0
        ? `${facts.key.columns.join(", ")} (${facts.key.confidence === "declared" ? "declared PRIMARY KEY" : "inferred from naming, treat as a hypothesis"})`
        : "none found — say so rather than inventing one",
    joinHints: facts.perSource
      .filter((p) => p.join.columns.length > 0)
      .map((p) => ({ source: p.source, columns: p.join.columns })),
    measureHint: facts.measureColumns.length > 0 ? facts.measureColumns.join(", ") : "none found on both sides",
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

/** Blanks out string literals, so `'silver.orders -> gold.arr'` isn't read as SQL. */
function stripLiterals(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "''");
}

/** Words that can follow a table name without being an alias for it. */
const NOT_AN_ALIAS = new Set([
  "on", "where", "group", "order", "having", "union", "inner", "left", "right", "full", "outer",
  "cross", "join", "select", "set", "using", "and", "or", "when", "then", "else", "end", "as",
  "with", "from", "into", "values", "limit", "except", "intersect", "qualify", "window"
]);

const ALIAS_RE = /\b(?:from|join)\s+([A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)*)\s+(?:as\s+)?([A-Za-z_]\w*)/gi;

/** Every `FROM|JOIN <table> [AS] <alias>` binding in the statement, alias -> table, lowercased. */
function aliasBindings(sql: string): Map<string, string> {
  const bindings = new Map<string, string>();
  let match: RegExpExecArray | null;
  ALIAS_RE.lastIndex = 0;
  while ((match = ALIAS_RE.exec(sql))) {
    const alias = match[2].toLowerCase();
    if (NOT_AN_ALIAS.has(alias)) continue;
    bindings.set(alias, match[1].toLowerCase());
  }
  return bindings;
}

/**
 * Columns the check reads as `<alias>.<column>` where the alias is bound to a table whose complete
 * column list is known — and that the table doesn't have.
 *
 * Deliberately narrow. Validating every bare identifier would need a parser per dialect and would
 * throw away good checks over a result alias like `row_diff`; an alias bound to a real table in the
 * same statement is unambiguous, which is exactly the case a hallucinated column shows up in. A
 * table whose list came from an unexpandable `SELECT *` is skipped: a name missing from a list that
 * is *known* to be partial proves nothing.
 */
export function unknownColumns(sql: string, columns: ColumnIndex, tables: string[]): string[] {
  const cleaned = stripLiterals(stripSqlComments(sql));
  const inScope = new Set(tables.map((t) => t.toLowerCase()));
  const found = new Set<string>();

  for (const [alias, table] of aliasBindings(cleaned)) {
    if (!inScope.has(table)) continue;
    const entry = columns.get(table);
    if (!entry || entry.columns.length === 0 || entry.incomplete) continue;

    const known = new Set(entry.columns.map((c) => c.name.toLowerCase()));
    const useRe = new RegExp(`\\b${alias}\\.([A-Za-z_]\\w*)`, "gi");
    let use: RegExpExecArray | null;
    while ((use = useRe.exec(cleaned))) {
      const column = use[1].toLowerCase();
      if (!known.has(column)) found.add(`${table}.${column}`);
    }
  }

  return Array.from(found);
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
function mergeChecks(facts: ReconTargetFacts, base: ReconCheck[], written: ReconLlmScript | null, columns: ColumnIndex): MergedChecks {
  if (!written) return { checks: base, notes: [], aiCount: 0 };

  const tables = [facts.target, ...facts.sources];
  const covered = new Set<ReconCheckKind>(base.map((c) => c.kind));
  const kept: ReconCheck[] = [];
  const dropped = { unknownTable: 0, duplicate: 0, badColumns: [] as string[] };

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
    const bad = unknownColumns(check.sql, columns, tables);
    if (bad.length > 0) {
      dropped.badColumns.push(...bad);
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
  if (dropped.badColumns.length > 0) {
    notes.push(
      `A suggested check referenced ${Array.from(new Set(dropped.badColumns)).join(", ")}, which ` +
        "this project's DDL does not declare, and was dropped before you saw it."
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
  const { hops, columns } = gatherReconciliationFacts(project, layers);

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
          .map((facts) => promptFor(facts, columns, baseChecks.get(facts)!))
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
      const merged = mergeChecks(facts, base, written, columns);

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
