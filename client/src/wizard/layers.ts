import type { LayerRef, Schema } from "../types";

/**
 * Known medallion layer names, ordered from most-raw to most-refined. A schema is classified into
 * the first layer whose keywords its name contains. `rank` drives ordering so detected layers come
 * out in pipeline order regardless of how the schemas were returned.
 */
const LAYER_DEFS: { label: string; rank: number; keys: string[] }[] = [
  { label: "bronze", rank: 0, keys: ["bronze", "raw", "landing", "ingest", "source"] },
  { label: "silver", rank: 1, keys: ["silver", "staging", "stage", "clean", "refined", "conformed"] },
  { label: "gold", rank: 2, keys: ["gold", "curated", "mart", "presentation", "serving", "reporting", "analytics"] }
];

/** Classify schemas into ordered medallion layers by name. One schema per detected layer (first match wins). */
export function detectLayers(schemas: Schema[]): LayerRef[] {
  const byRank = new Map<number, LayerRef>();

  for (const schema of schemas) {
    const name = schema.name.toLowerCase();
    for (const def of LAYER_DEFS) {
      if (def.keys.some((k) => name.includes(k))) {
        // Keep the first schema matched for a given layer.
        if (!byRank.has(def.rank)) {
          byRank.set(def.rank, { label: def.label, schema: schema.name });
        }
        break;
      }
    }
  }

  return LAYER_DEFS.map((d) => byRank.get(d.rank)).filter((l): l is LayerRef => l !== undefined);
}
