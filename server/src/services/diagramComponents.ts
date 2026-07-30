import {
  COLLAPSE_ABOVE,
  layoutDag,
  orderedSchemas,
  schemaOf,
  type DagEdge,
  type DagLayout
} from "./dagLayout.js";
import { reconFolderName } from "./reconciliationScripts.js";
import type { LayerRef, LineageEdge, LocalTableRef } from "../types/index.js";

/**
 * Cuts the lineage graph into the pieces someone would actually paste into a document.
 *
 * One whole-pipeline overview, then one component per hop — the same adjacent-layer pairs
 * `gatherReconciliationFacts` groups its checks into, named with the same `reconFolderName`, so
 * `bronze_to_silver.sql` in the governance folder and `bronze_to_silver.svg` beside it are the same
 * hop. That correspondence is the point: a slide and the reconciliation script behind it should be
 * findable from each other without a mapping table.
 *
 * The hop rule is `groupByTarget`'s rule, deliberately: an edge belongs to the hop whose *target*
 * layer it writes, and its source may come from the feeding layer **or from the target layer itself**.
 * A report built from a fact table alongside it is still work the engineer has to reconcile, and it
 * belongs to the hop that produces that layer rather than to no hop at all. Dropping the second half
 * of that rule here would make the diagram disagree with the scripts about what a hop contains.
 *
 * Each component gets its own layout rather than a window onto the whole one. A hop laid out alone is
 * two or three columns wide and fits a slide; the same hop cropped out of the full graph inherits the
 * whole pipeline's column positions and arrives mostly empty.
 */

export interface DiagramGraph {
  projectName: string;
  edges: LineageEdge[];
  layers: LayerRef[];
  tables: LocalTableRef[];
}

export interface DiagramComponent {
  /** Stable, filename-safe, and shared with the governance folder for the same hop. */
  id: string;
  kind: "overview" | "hop";
  title: string;
  /** One line of context: the layer pair, or the project's totals for the overview. */
  subtitle: string;
  from: LayerRef | null;
  to: LayerRef | null;
  layout: DagLayout;
  /**
   * The `LineageEdge`s this component covers, keeping the provenance `layout.edges` drops.
   *
   * `layout.edges` is lowercased ids and nothing else, which is all a picture needs. A table listing
   * the hop has to say *where each edge came from* — the file and cell — so both are carried.
   */
  sourceEdges: LineageEdge[];
  /** Schemas present in *this* component, in pipeline order — its legend. */
  schemas: string[];
  /** The whole project's schema order, which is what colours are assigned from. */
  palette: string[];
  /** True when the overview was drawn one node per schema because there were too many tables. */
  collapsed: boolean;
  /** Set when the hop has no edges — kept so the gap is visible rather than the hop vanishing. */
  emptyReason: string | null;
}

function inSchema(table: string, schema: string | null): boolean {
  if (schema === null) return true;
  return schemaOf(table).toLowerCase() === schema.toLowerCase();
}

/** The adjacent pairs of `layers`, matching `gatherReconciliationFacts`'s `hopSpecs` exactly. */
export function hopPairs(layers: LayerRef[]): { from: LayerRef; to: LayerRef }[] {
  return layers.length >= 2 ? layers.slice(0, -1).map((from, i) => ({ from, to: layers[i + 1] })) : [];
}

function edgesForHop(edges: LineageEdge[], from: LayerRef, to: LayerRef): LineageEdge[] {
  return edges.filter(
    (edge) =>
      inSchema(edge.to, to.schema) &&
      (inSchema(edge.from, from.schema) || inSchema(edge.from, to.schema)) &&
      edge.from.toLowerCase() !== edge.to.toLowerCase()
  );
}

/** Schemas this component's own nodes use, ordered by the project-wide palette order. */
function componentSchemas(layout: DagLayout, palette: string[]): string[] {
  const present = new Set(layout.nodes.map((n) => n.schema));
  return palette.filter((schema) => present.has(schema));
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

function overviewComponent(graph: DiagramGraph, palette: string[]): DiagramComponent {
  const collapsed = graph.tables.length > COLLAPSE_ABOVE;

  // Collapsed mode reuses the same layout engine on a smaller graph: one node per schema.
  const names = collapsed ? palette : graph.tables.map((t) => t.qualified);
  const edges: DagEdge[] = collapsed
    ? graph.edges.map((e) => ({ from: schemaOf(e.from), to: schemaOf(e.to) }))
    : graph.edges.map((e) => ({ from: e.from, to: e.to }));

  const layout = layoutDag(names, edges);

  return {
    id: "00_pipeline_overview",
    kind: "overview",
    title: `${graph.projectName} — pipeline overview`,
    subtitle: collapsed
      ? `${plural(graph.tables.length, "table")} grouped into ${plural(palette.length, "schema")} — too many to draw individually`
      : `${plural(graph.tables.length, "table")}, ${plural(graph.edges.length, "lineage edge")}, ${plural(graph.layers.length, "layer")}`,
    from: null,
    to: null,
    layout,
    sourceEdges: graph.edges,
    schemas: componentSchemas(layout, palette),
    palette,
    collapsed,
    emptyReason: layout.nodes.length === 0 ? "No tables were extracted from this project's SQL." : null
  };
}

function hopComponent(
  graph: DiagramGraph,
  palette: string[],
  from: LayerRef,
  to: LayerRef,
  index: number,
  takenIds: Set<string>
): DiagramComponent {
  const hopEdges = edgesForHop(graph.edges, from, to);
  const names = Array.from(new Set(hopEdges.flatMap((e) => [e.from.toLowerCase(), e.to.toLowerCase()])));
  const layout = layoutDag(
    names,
    hopEdges.map((e) => ({ from: e.from, to: e.to }))
  );

  const base = reconFolderName(from, to);
  let folder = base;
  for (let n = 2; takenIds.has(folder); n++) folder = `${base}_${n}`;
  takenIds.add(folder);

  return {
    id: `${String(index + 1).padStart(2, "0")}_${folder}`,
    kind: "hop",
    title: `${from.label} → ${to.label}`,
    subtitle: `${plural(new Set(hopEdges.map((e) => e.to.toLowerCase())).size, "table")} built in ${
      to.schema
    } from ${from.schema}, across ${plural(hopEdges.length, "edge")}`,
    from,
    to,
    layout,
    sourceEdges: hopEdges,
    schemas: componentSchemas(layout, palette),
    palette,
    collapsed: false,
    emptyReason:
      hopEdges.length === 0
        ? `No statement builds a ${to.schema} table from a ${from.schema} one, so this hop has no lineage to draw. ` +
          "Check that the layers match the schema names the SQL uses."
        : null
  };
}

/**
 * The overview first, then a component per hop.
 *
 * With fewer than two layers there are no hops — the SQL never qualifies its tables, so none could be
 * inferred — and the overview is the whole answer, exactly as the reconciliation scripts fall back to a
 * single `all_tables` scope.
 */
export function buildDiagramComponents(graph: DiagramGraph): DiagramComponent[] {
  const palette = orderedSchemas(graph);
  const takenIds = new Set<string>();
  return [
    overviewComponent(graph, palette),
    ...hopPairs(graph.layers).map((pair, i) => hopComponent(graph, palette, pair.from, pair.to, i, takenIds))
  ];
}
