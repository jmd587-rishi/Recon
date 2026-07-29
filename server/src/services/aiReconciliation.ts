import type { LayerRef, LocalReconciliationSuite, ReconCheck, ReconScript } from "../types/index.js";
import type { LocalProject } from "./localProject.js";
import { type ReconLlmScript, type ReconTargetPrompt, writeReconciliationScripts } from "./llmClient.js";
import {
  assembleHop,
  assembleScript,
  gatherReconciliationFacts,
  type ReconTargetFacts,
  summarizeSuite,
  templateChecks
} from "./reconciliationScripts.js";
import type { ColumnIndex } from "./sqlColumns.js";

/**
 * Writes the reconciliation scripts with the model rather than from templates.
 *
 * The value of asking a model at all is that it can read the transformation and check what *this*
 * pipeline can get wrong — a monthly grain that must not fan out, a `LAG` that needs its partition
 * complete, an `ISNULL(revenue, 0)` that moves a total — which no template knows about. The cost is
 * that a model will happily write `SELECT SUM(total_amount)` for a table with no such column, so
 * everything it is allowed to name is handed to it first (`reconciliationScripts.gatherReconciliation
 * Facts`) and everything it writes is checked back against that list before it reaches the user.
 *
 * Requests are batched per hop rather than per table: one call for six target tables is far cheaper
 * than six, and the tables of a hop share the sources and conventions that make the checks coherent.
 */

/** Target tables per LLM call. Small enough that each script gets real attention in the response. */
const MAX_TARGETS_PER_CALL = 6;
/** Per-statement cap on the transformation SQL quoted into the prompt. */
const MAX_SQL_CHARS = 4500;
/** Cap across one call, so a hop of six stored procedures can't blow the context window. */
const MAX_CALL_SQL_CHARS = 24000;
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

/** Renders one target's grounding for the prompt, within the call's remaining SQL budget. */
function promptFor(facts: ReconTargetFacts, columns: ColumnIndex, budget: { left: number }): ReconTargetPrompt {
  const transformationSql: ReconTargetPrompt["transformationSql"] = [];
  for (const fact of facts.facts) {
    if (budget.left <= 0) break;
    const sql = fact.rawSql.slice(0, Math.min(MAX_SQL_CHARS, budget.left));
    budget.left -= sql.length;
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
    transformationSql
  };
}

const TABLE_TOKEN_RE = /[A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)*/g;

/**
 * Whether a check names at least one table it was given.
 *
 * A cheap, low-false-positive guard against a check written for a table that isn't in this project
 * at all: real reconciliation SQL for `silver.orders` mentions `silver.orders`. It deliberately does
 * not try to validate every column — that needs a parser per dialect and would throw away good
 * checks — the column lists in the prompt are what keep those honest.
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

/** Ends every check with exactly one `;`, so the file can be run straight through. */
function terminate(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  return `${trimmed};`;
}

interface VerifiedChecks {
  checks: ReconCheck[];
  notes: string[];
}

/** Drops anything the model wrote about tables this project doesn't have, and says that it did. */
function verifyChecks(script: ReconLlmScript, facts: ReconTargetFacts): VerifiedChecks {
  const tables = [facts.target, ...facts.sources];
  const kept: ReconCheck[] = [];
  let dropped = 0;

  for (const check of script.checks) {
    if (!referencesKnownTable(check.sql, tables)) {
      dropped++;
      continue;
    }
    kept.push({ kind: check.kind, title: check.title, description: check.description, sql: terminate(check.sql) });
  }

  const notes = [...script.notes];
  if (dropped > 0) {
    notes.push(
      `${dropped} suggested check${dropped === 1 ? "" : "s"} named no table from this hop and ${dropped === 1 ? "was" : "were"} dropped before you saw ${dropped === 1 ? "it" : "them"}.`
    );
  }
  return { checks: kept, notes };
}

/**
 * Builds the AI-written suite, hop by hop.
 *
 * A hop the model returns nothing usable for falls back to that hop's template checks rather than
 * shipping an empty script — a reconciliation file with no queries in it is worse than a mechanical
 * one — and the script says which happened.
 */
export async function buildAiReconciliationSuite(
  project: LocalProject,
  layers: LayerRef[]
): Promise<LocalReconciliationSuite> {
  const { hops, columns } = gatherReconciliationFacts(project, layers);
  const built = [];
  let fellBack = 0;

  for (const hop of hops) {
    const byTarget = new Map<string, ReconLlmScript>();

    for (let i = 0; i < hop.targets.length; i += MAX_TARGETS_PER_CALL) {
      const batch = hop.targets.slice(i, i + MAX_TARGETS_PER_CALL);
      const budget = { left: MAX_CALL_SQL_CHARS };
      const written = await writeReconciliationScripts(
        hop.label,
        batch.map((facts) => promptFor(facts, columns, budget))
      );
      for (const script of written) byTarget.set(script.targetTable, script);
    }

    const scripts: ReconScript[] = hop.targets.map((facts) => {
      const written = byTarget.get(facts.target.toLowerCase());
      const verified = written ? verifyChecks(written, facts) : null;

      if (!verified || verified.checks.length === 0) {
        fellBack++;
        return assembleScript({
          facts,
          checks: templateChecks(facts),
          summary: "",
          hopLabel: hop.label,
          folderName: project.folderName,
          writtenBy: "rules",
          extraNotes: [
            "The model returned no usable check for this table, so these are Recon's standard " +
              "schema-derived checks instead."
          ]
        });
      }

      return assembleScript({
        facts,
        checks: verified.checks,
        summary: written!.summary,
        hopLabel: hop.label,
        folderName: project.folderName,
        writtenBy: "ai",
        extraNotes: verified.notes
      });
    });

    built.push(assembleHop(hop, scripts, project.folderName));
  }

  return summarizeSuite({
    folderName: project.folderName,
    hops: built,
    columns,
    generatedBy: "ai",
    notice:
      fellBack > 0
        ? `${fellBack} table${fellBack === 1 ? "" : "s"} fell back to Recon's standard checks because the model returned nothing usable for ${fellBack === 1 ? "it" : "them"}.`
        : null
  });
}
