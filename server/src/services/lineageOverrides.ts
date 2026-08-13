import type { LineageEdge, LineageOverride, LocalTableRef } from "../types/index.js";
import { buildScanResult, splitQualifiedTable, type LocalProject, type ParsedLocalFile } from "./localProject.js";
import type { LineageFact } from "./tableLineage.js";

/**
 * Applies the user's corrections to the extracted lineage — the step that makes approving a diagram
 * mean something.
 *
 * The diagram is drawn from `LocalScanResult.lineage` (`LineageEdge[]`), but the reconciliation
 * scripts are built from `LocalProject.facts` (`LineageFact[]`) — `gatherReconciliationFacts` groups
 * over the facts and never looks at the graph. So a correction written onto the graph alone would
 * change the picture and nothing else: the user would approve a lineage the generated SQL doesn't
 * follow. Every override here is therefore applied to the *facts*, and the graph is rebuilt from
 * them afterwards, so the two cannot disagree.
 *
 * `(notebookPath, cellIndex)` is the join between an edge and the statement that produced it, which
 * is why an override carries that provenance where it has it.
 */

export interface DiscardedOverride {
  override: LineageOverride;
  /** Why it couldn't be applied — surfaced to the user so a rejected correction isn't silent. */
  why: string;
}

export interface OverrideOutcome {
  project: LocalProject;
  applied: LineageOverride[];
  discarded: DiscardedOverride[];
}

/** Stable identity for an edge, used as the key of the reviewer model's per-edge notes. */
export function edgeKey(from: string, to: string): string {
  return `${normalize(from)}->${normalize(to)}`;
}

function normalize(ref: string): string {
  return ref.trim().toLowerCase();
}

/**
 * Whether two table references name the same table.
 *
 * Exact match is the normal case. The fallback exists because the SQL routinely leaves a table
 * unqualified while the extracted fact carries a schema (or the reverse), and a user typing a
 * correction says "orders", not "silver.orders". Bare names are only compared when at least one side
 * has no schema at all — otherwise `bronze.orders` and `silver.orders` would collapse into one.
 */
function sameTable(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return true;
  const sx = splitQualifiedTable(x);
  const sy = splitQualifiedTable(y);
  if (sx.schema !== null && sy.schema !== null) return false;
  return sx.name === sy.name;
}

/** Facts that write `to`, preferring an exact provenance match when the override carries one. */
function factsWriting(facts: LineageFact[], override: LineageOverride): LineageFact[] {
  const writing = facts.filter((f) => f.targetTable !== null && sameTable(f.targetTable, override.to));
  if (override.notebookPath === undefined || override.cellIndex === undefined) return writing;
  const exact = writing.filter(
    (f) => f.notebookPath === override.notebookPath && f.cellIndex === override.cellIndex
  );
  // A stale or invented provenance shouldn't sink an otherwise valid correction — fall back to
  // every statement writing the table rather than discarding it.
  return exact.length > 0 ? exact : writing;
}

export interface OverridePreview {
  /** Statements that write the override's target table — where the edge lives, or would. */
  statements: LineageFact[];
  /** Those of them that already read `override.from`: the edge as the code has it today. */
  withSource: LineageFact[];
  /** What applying it would change; "none" when the code already says what the correction asks. */
  effect: "add" | "remove" | "none";
  /** Set when `effect` is "none": why there is nothing to do. */
  why: string | null;
}

/**
 * What one correction would do to the code as it stands, worked out without changing anything.
 *
 * Split out because the CLI shows the user what the SQL currently says and asks them to confirm
 * before a correction is applied. A preview derived separately from the application is a preview
 * that can disagree with it, so `applyOne` decides through this too: what the question describes is
 * exactly what answering yes does.
 */
export function previewOverride(facts: LineageFact[], override: LineageOverride): OverridePreview {
  const statements = factsWriting(facts, override);
  const withSource = statements.filter((fact) => fact.sourceTables.some((src) => sameTable(src, override.from)));
  const base = { statements, withSource };

  if (statements.length === 0) {
    return {
      ...base,
      effect: "none",
      why: `no statement in this project writes ${override.to}, so there is nothing to attach "${override.from}" to`
    };
  }

  if (override.kind === "remove") {
    if (withSource.length === 0) {
      return {
        ...base,
        effect: "none",
        why: `${override.from} -> ${override.to} was not in the extracted lineage, so there was nothing to remove`
      };
    }
    return { ...base, effect: "remove", why: null };
  }

  if (withSource.length === statements.length) {
    return { ...base, effect: "none", why: `${override.from} -> ${override.to} is already in the extracted lineage` };
  }
  return { ...base, effect: "add", why: null };
}

function applyOne(facts: LineageFact[], override: LineageOverride): { changed: LineageFact[]; why: string | null } {
  const preview = previewOverride(facts, override);
  if (preview.effect === "none") return { changed: facts, why: preview.why };

  const targeted = new Set(preview.statements);

  const changed = facts.map((fact) => {
    if (!targeted.has(fact)) return fact;

    if (override.kind === "remove") {
      const kept = fact.sourceTables.filter((src) => !sameTable(src, override.from));
      return kept.length === fact.sourceTables.length ? fact : { ...fact, sourceTables: kept };
    }

    if (fact.sourceTables.some((src) => sameTable(src, override.from))) return fact;
    return { ...fact, sourceTables: [...fact.sourceTables, normalize(override.from)] };
  });

  return { changed, why: null };
}

/**
 * Rewrites the project's facts per the overrides and rebuilds the scan (tables, schemas, graph,
 * stats) from the result. The input project is left untouched, so a caller can diff before against
 * after to show the user what their instruction actually did.
 */
export function applyLineageOverrides(project: LocalProject, overrides: LineageOverride[]): OverrideOutcome {
  const applied: LineageOverride[] = [];
  const discarded: DiscardedOverride[] = [];

  // Facts are rewritten per file so `ParsedLocalFile.facts` and `LocalProject.facts` stay the same
  // objects — `buildScanResult` derives everything from the files.
  let files: ParsedLocalFile[] = project.files.map((file) => ({ ...file, facts: [...file.facts] }));

  for (const override of overrides) {
    // An override names one target table, so only the file(s) writing it can be affected; applying
    // across the flattened list keeps that logic in one place.
    const flat = files.flatMap((f) => f.facts);
    const { changed, why } = applyOne(flat, override);

    if (why !== null) {
      discarded.push({ override, why });
      continue;
    }

    // Rebuild the per-file arrays from the rewritten flat list, preserving file boundaries.
    let cursor = 0;
    files = files.map((file) => {
      const slice = changed.slice(cursor, cursor + file.facts.length);
      cursor += file.facts.length;
      return { ...file, facts: slice };
    });
    applied.push(override);
  }

  const scan = buildScanResult(project.folderName, files, project.scan.skipped);
  return {
    project: {
      folderName: project.folderName,
      files,
      facts: files.flatMap((f) => f.facts),
      scan,
      fileLineage: project.fileLineage
    },
    applied,
    discarded
  };
}

/**
 * Drops corrections that name a table this project's SQL never mentions.
 *
 * Same guard `aiReconciliation.ts` puts on generated checks, for the same reason: a plausible-looking
 * edge onto a table that doesn't exist is worse than no edge, because it silently produces
 * reconciliation SQL against nothing. Applied to model output, not to what the user typed.
 */
export function validateOverrides(
  overrides: LineageOverride[],
  tables: LocalTableRef[]
): { kept: LineageOverride[]; dropped: DiscardedOverride[] } {
  const kept: LineageOverride[] = [];
  const dropped: DiscardedOverride[] = [];

  const known = (ref: string) => tables.some((t) => sameTable(t.qualified, ref));

  for (const override of overrides) {
    const unknown = [override.from, override.to].filter((ref) => !known(ref));
    if (unknown.length > 0) {
      dropped.push({ override, why: `names ${unknown.join(" and ")}, which no SQL in this project references` });
      continue;
    }
    kept.push(override);
  }

  return { kept, dropped };
}

export interface EdgeDiff {
  added: LineageEdge[];
  removed: LineageEdge[];
}

/** What changed between two lineage graphs, so each feedback round can show its own effect. */
export function diffEdges(before: LineageEdge[], after: LineageEdge[]): EdgeDiff {
  const keys = (edges: LineageEdge[]) => new Set(edges.map((e) => edgeKey(e.from, e.to)));
  const beforeKeys = keys(before);
  const afterKeys = keys(after);
  return {
    added: after.filter((e) => !beforeKeys.has(edgeKey(e.from, e.to))),
    removed: before.filter((e) => !afterKeys.has(edgeKey(e.from, e.to)))
  };
}
