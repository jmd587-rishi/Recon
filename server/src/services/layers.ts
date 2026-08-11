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
    keys: [
      "gold", "datamart", "mart", "curated", "presentation", "serving", "serve", "reporting",
      // "analytical" is not a substring of "analytics", so a schema named `analytical` matched
      // nothing until it was listed in its own right.
      "analytics", "analytical", "analytic", "consumption", "semantic"
    ]
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

/**
 * Whether `table` belongs to `layer` — the single place that question is answered for a local
 * project, so the scripts, the layer reports, the diagrams and the document can never disagree about
 * which hop a table sits in.
 *
 * A null layer means "no layer was detected", which every caller treats as one scope over the whole
 * project rather than as an empty one. A layer with `tables` is exactly those tables; a layer without
 * is its schema, matched case-insensitively because a project may qualify the same schema either way.
 */
export function layerHasTable(layer: LayerRef | null, table: string): boolean {
  if (layer === null) return true;
  const name = table.toLowerCase();
  if (layer.tables) return layer.tables.some((t) => t.toLowerCase() === name);
  const schema = name.split(".").filter((p) => p.length > 0).slice(-2, -1)[0];
  return schema !== undefined && schema === layer.schema.toLowerCase();
}

/**
 * Schemas no layer claims, so a run can say what it passed over.
 *
 * Takes the project's tables rather than its schema names because a layer is not always a schema: on
 * a project staged by source folder, comparing layer names to schema names would report every schema
 * as unclaimed while every table in them is in fact covered. A schema is unclaimed only when nothing
 * in it belongs to any layer.
 */
export function unclaimedSchemas(
  tables: { qualified: string; schema: string | null }[],
  layers: LayerRef[]
): string[] {
  const claimed = new Set<string>();
  const seen = new Set<string>();
  for (const table of tables) {
    if (!table.schema) continue;
    seen.add(table.schema);
    if (layers.some((layer) => layerHasTable(layer, table.qualified))) claimed.add(table.schema);
  }
  return Array.from(seen).filter((schema) => !claimed.has(schema));
}
