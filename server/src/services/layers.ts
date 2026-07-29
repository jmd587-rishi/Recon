import type { LayerRef, LayerRole } from "../types/index.js";

/**
 * Schema-name -> pipeline-role heuristic, ported from `client/src/wizard/layers.ts` so the CLI
 * (`cli/reconcile.ts`) can auto-detect layers without a browser. Kept as a deliberate duplicate
 * rather than a shared package, matching this project's existing client/server type mirroring — see
 * CLAUDE.md. If the heuristic changes, update both.
 *
 * These are *roles*, not names: a project may call its serving layer "gold", "datamart", or
 * "presentation" and all three infer the same role. `rank` orders detected layers into pipeline
 * order regardless of how the folder happened to list its schemas.
 */
const ROLE_DEFS: { role: LayerRole; rank: number; keys: string[] }[] = [
  { role: "ingest", rank: 0, keys: ["bronze", "raw", "landing", "land", "ingest", "ingestion", "source", "src", "lake"] },
  { role: "clean", rank: 1, keys: ["silver", "staged", "staging", "stage", "stg", "clean", "cleansed", "conformed", "refined", "standardized"] },
  {
    role: "transform",
    rank: 2,
    keys: ["transform", "transformation", "transformed", "enrich", "enriched", "integration", "integrated", "core", "business", "edw", "warehouse"]
  },
  {
    role: "serve",
    rank: 3,
    keys: ["gold", "datamart", "mart", "curated", "presentation", "serving", "serve", "reporting", "analytics", "consumption", "semantic"]
  }
];

interface RoleHit {
  role: LayerRole;
  rank: number;
  strength: number;
}

/** Longest matching keyword wins: `datamart` resolves on the full word, not the "mart" substring. */
function inferRole(schemaName: string): RoleHit | null {
  const name = schemaName.toLowerCase();
  let best: RoleHit | null = null;

  for (const def of ROLE_DEFS) {
    for (const key of def.keys) {
      if (!name.includes(key)) continue;
      if (best === null || key.length > best.strength) {
        best = { role: def.role, rank: def.rank, strength: key.length };
      }
    }
  }

  return best;
}

/**
 * Orders the schemas that look like pipeline layers into a proposed pipeline, most-raw first. A
 * starting point to confirm or override with `--layers`, not a verdict — schemas matching nothing
 * are left out rather than dropped silently (`unassignedSchemas` surfaces them).
 */
export function detectLayers(schemaNames: string[]): LayerRef[] {
  return schemaNames
    .map((name, order) => ({ name, order, hit: inferRole(name) }))
    .filter((entry): entry is { name: string; order: number; hit: RoleHit } => entry.hit !== null)
    .sort((a, b) => a.hit.rank - b.hit.rank || a.order - b.order)
    .map(({ name, hit }) => ({ label: name, schema: name, role: hit.role }));
}

/** Schemas that aren't part of the detected pipeline, so the CLI can say what it left out. */
export function unassignedSchemas(schemaNames: string[], layers: LayerRef[]): string[] {
  const used = new Set(layers.map((l) => l.schema));
  return schemaNames.filter((name) => !used.has(name));
}
