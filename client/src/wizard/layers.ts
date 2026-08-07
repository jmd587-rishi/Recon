import type { LayerRef, LayerRole } from "../types";

/**
 * The role a layer plays in a pipeline, ordered from most-raw to most-refined. These are *roles*,
 * not names: a project may call its serving layer "gold", "datamart", or "presentation" and all
 * three infer the same role. `rank` orders detected layers into pipeline order regardless of how
 * Unity Catalog happened to return the schemas.
 *
 * A pipeline does not need one layer per role, nor at most one — a raw -> staged -> transformation
 * -> datamart stack fills all four, a plain bronze/silver/gold stack fills three, and a project with
 * two separate landing schemas gets two `ingest` layers.
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
  /** Length of the keyword that matched — longer keywords are more specific, so they win. */
  strength: number;
}

/**
 * Infers a schema's pipeline role from its name. When several keywords match, the *longest* one
 * wins: `source_transform` is a transformation layer (9 chars) rather than an ingest layer (6),
 * and `datamart` resolves on the full word rather than on the "mart" substring it contains.
 */
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
 * Orders the schemas that look like pipeline layers into a proposed pipeline, most-raw first.
 *
 * This is a *starting point* the user edits, not a verdict — the label keeps the schema's own name
 * so the rest of the app talks about the project in the vocabulary the project already uses, and
 * schemas that match nothing are left out for `unassignedSchemas` to surface rather than dropped
 * silently.
 *
 * Takes plain schema *names* rather than `Schema` objects because the same inference runs over
 * schemas Unity Catalog listed and over schemas parsed out of uploaded SQL, where nothing else about
 * the schema is known.
 */
export function detectLayers(schemaNames: string[]): LayerRef[] {
  return schemaNames
    .map((name, order) => ({ name, order, hit: inferRole(name) }))
    .filter((entry): entry is { name: string; order: number; hit: RoleHit } => entry.hit !== null)
    .sort((a, b) => a.hit.rank - b.hit.rank || a.order - b.order)
    .map(({ name, hit }) => ({ label: name, schema: name, role: hit.role }));
}

/** Schemas that aren't part of the pipeline yet, so the UI can offer to add them. */
export function unassignedSchemas(schemaNames: string[], layers: LayerRef[]): string[] {
  const used = new Set(layers.map((l) => l.schema));
  return schemaNames.filter((name) => !used.has(name));
}

/** Best-guess role for a schema the user added by hand, so heuristics downstream still have a hint. */
export function roleForSchema(schemaName: string): LayerRole | undefined {
  return inferRole(schemaName)?.role;
}
