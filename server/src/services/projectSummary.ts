import type { LayerRef, LineageEdge, ProjectLayerSummary, ProjectStats, TableKind } from "../types/index.js";

/** Roles whose tables are pre-modeling by definition, whatever the project calls those layers. */
const PRE_MODELING_ROLES = new Set(["ingest", "clean"]);

/**
 * Classifies a table into a warehouse-modeling role from its name (and, as a weak hint, the layer it
 * lives in). Purely heuristic — Unity Catalog doesn't record whether a table is a fact or a
 * dimension — matching the common `fact_*`/`dim_*` (and short `f_*`/`d_*`) naming conventions, plus
 * bridge/mapping tables and staging tables. Everything else falls through to "other" (landing
 * tables, lookups that don't follow a convention, etc.).
 *
 * The layer hint reads the inferred `role` rather than the label, so a project whose layers are
 * named `raw`/`staged`/`transformation`/`datamart` classifies the same as a bronze/silver/gold one.
 * It falls back to matching the label directly for layers the user named something unrecognizable.
 */
export function classifyTable(tableName: string, layer?: LayerRef): TableKind {
  const name = tableName.toLowerCase();

  if (/^(fact|fct|f)[_]/.test(name) || name.includes("_fact") || name.endsWith("_facts")) return "fact";
  if (/^(dim|dm|d)[_]/.test(name) || name.includes("_dim") || name.endsWith("_dimension")) return "dimension";
  if (/^(bridge|br|map|xref|link)[_]/.test(name) || name.includes("bridge") || name.includes("_map")) return "bridge";

  const preModelingLayer = layer?.role
    ? PRE_MODELING_ROLES.has(layer.role)
    : /\b(raw|bronze|land|ingest|stag|stg)/.test((layer?.label ?? "").toLowerCase());

  if (/^(stg|stage|staging|tmp|temp|wrk|work)[_]/.test(name) || name.startsWith("stg") || preModelingLayer) {
    return "staging";
  }
  return "other";
}

/** Rolls per-layer table inventory + the lineage graph into the headline KPI numbers. */
export function buildProjectStats(layers: ProjectLayerSummary[], lineage: LineageEdge[]): ProjectStats {
  let factTableCount = 0;
  let dimensionTableCount = 0;
  let otherTableCount = 0;
  let tableCount = 0;
  let totalRows: number | null = null;

  for (const { tables } of layers) {
    for (const t of tables) {
      tableCount++;
      if (t.kind === "fact") factTableCount++;
      else if (t.kind === "dimension") dimensionTableCount++;
      else otherTableCount++;
      if (t.rowCount !== null) totalRows = (totalRows ?? 0) + t.rowCount;
    }
  }

  const notebooks = new Set(lineage.map((e) => e.notebookPath).filter((p) => p.length > 0));

  return {
    layerCount: layers.length,
    tableCount,
    factTableCount,
    dimensionTableCount,
    otherTableCount,
    totalRows,
    lineageEdgeCount: lineage.length,
    notebookCount: notebooks.size
  };
}
