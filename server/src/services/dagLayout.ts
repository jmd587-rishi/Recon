import { splitQualifiedTable } from "./localProject.js";
import type { LayerRef, LineageEdge, LocalTableRef } from "../types/index.js";

/**
 * Where a lineage graph's boxes go, and what colour they are — with nothing about *how* they are drawn.
 *
 * Extracted from `lineageDiagram.ts` once there was more than one renderer. Three now read this: the
 * interactive HTML page (`lineageDiagram.ts`), the Office-importable SVG (`officeSvg.ts`) and the
 * PowerPoint writer (`pptxWriter.ts`). They must agree on the picture — a diagram reviewed in the
 * browser and the same diagram pasted into a deck should have the boxes in the same places — so the
 * layout is computed once here and each renderer only decides how to draw the result.
 *
 * The colour palette moved here for the same reason. It used to live in the page's CSS as
 * `--nc:#b8863f`, which is unreachable from a .pptx: OOXML wants a literal `srgbClr val="B8863F"` and
 * an Office-safe SVG wants `stroke="#b8863f"` on the element. So the palette is data, and the CSS is
 * generated from it rather than being its source.
 *
 * Layout is **by dependency depth, not by schema.** Grouping columns by layer looks tidier but breaks
 * the moment a layer feeds itself — `datamart.fact_arr -> datamart.rpt_snowball` is a real edge in a
 * real project, and a schema-column layout has to draw it sideways through its own box. Longest-path
 * layering puts every table exactly one column right of its deepest input, so every arrow points the
 * same way and the graph reads left to right. Schema decides colour only.
 */

/** Above this, per-table layout stops being useful and the graph is drawn one node per schema. */
export const COLLAPSE_ABOVE = 250;

export const NODE_W = 190;
export const NODE_H = 38;
export const COL_GAP = 110;
export const ROW_GAP = 16;
export const PAD = 32;
export const LABEL_MAX = 24;

/**
 * One entry per schema, cycling after six.
 *
 * `stroke` is the palette; `fill` is that stroke at ~10% over white, precomputed because the two
 * renderers that need a literal cannot compute it. The HTML page keeps its own `color-mix()` so the
 * fill still adapts to dark mode, and takes `stroke` from here — the numbers below stay authoritative
 * for the hue either way.
 */
export const SCHEMA_COLOURS: { stroke: string; fill: string }[] = [
  { stroke: "#b8863f", fill: "#f9f4ec" },
  { stroke: "#3f7db8", fill: "#eef4fa" },
  { stroke: "#3fb887", fill: "#eef9f5" },
  { stroke: "#8b5fc7", fill: "#f4effa" },
  { stroke: "#c75f88", fill: "#faeff3" },
  { stroke: "#7d9b3f", fill: "#f5f8ec" }
];

/** Edge and text colours, shared so a pasted diagram matches the reviewed one. */
export const EDGE_COLOUR = "#b9bec6";
export const LABEL_COLOUR = "#1a1a1a";
export const SCHEMA_LABEL_COLOUR = "#6b6b6b";

export const UNQUALIFIED = "(unqualified)";

export interface DagNode {
  id: string;
  qualified: string;
  /** The bare table name in full — what a shape with room for it should show. */
  name: string;
  /** The bare table name, cut to `LABEL_MAX` for renderers with a fixed-width box. */
  label: string;
  schema: string;
  col: number;
  row: number;
  x: number;
  y: number;
}

export interface DagEdge {
  from: string;
  to: string;
}

export interface DagLayout {
  nodes: DagNode[];
  edges: DagEdge[];
  width: number;
  height: number;
  columnCount: number;
}

export function schemaOf(ref: string): string {
  return splitQualifiedTable(ref).schema ?? UNQUALIFIED;
}

export function truncate(text: string, max = LABEL_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The palette entry a schema takes, by its position in `orderedSchemas`. */
export function schemaColour(schemas: string[], schema: string): { stroke: string; fill: string } {
  const index = schemas.indexOf(schema);
  return SCHEMA_COLOURS[(index < 0 ? 0 : index) % SCHEMA_COLOURS.length];
}

/** The palette *index* a schema takes — what the HTML page's `layerN` class names are built from. */
export function schemaColourIndex(schemas: string[], schema: string): number {
  const index = schemas.indexOf(schema);
  return (index < 0 ? 0 : index) % SCHEMA_COLOURS.length;
}

/**
 * Orders schemas by the pipeline where the layers say so, then appends anything left over, so colour
 * assignment follows the pipeline and unassigned schemas stay visible rather than being dropped.
 */
export function orderedSchemas(input: {
  layers: LayerRef[];
  tables: LocalTableRef[];
  edges: LineageEdge[];
}): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const layer of input.layers) {
    const key = layer.schema.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  const rest = new Set<string>();
  for (const table of input.tables) rest.add(table.schema ?? UNQUALIFIED);
  for (const edge of input.edges) {
    rest.add(schemaOf(edge.from));
    rest.add(schemaOf(edge.to));
  }
  for (const schema of Array.from(rest).sort()) {
    if (!seen.has(schema)) {
      seen.add(schema);
      ordered.push(schema);
    }
  }
  return ordered;
}

/**
 * Longest-path layering: a node sits one column right of its deepest input.
 *
 * Kahn's algorithm does the ordering; anything left over is in a cycle, which real SQL projects do
 * contain (a table rebuilt from itself, two procedures that reference each other). Those are placed
 * after everything that could be ordered rather than being dropped or looping forever.
 */
function assignColumns(ids: string[], edges: DagEdge[]): Map<string, number> {
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));

  for (const edge of edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to) || edge.from === edge.to) continue;
    outgoing.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to)! + 1);
  }

  const depth = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const settled = new Set<string>(queue);

  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const next of outgoing.get(id)!) {
      depth.set(next, Math.max(depth.get(next)!, depth.get(id)! + 1));
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) {
        settled.add(next);
        queue.push(next);
      }
    }
  }

  // Whatever a cycle left unsettled still needs a column; put it past its deepest settled input.
  const maxSettled = Math.max(0, ...Array.from(settled, (id) => depth.get(id)!));
  for (const id of ids) {
    if (!settled.has(id)) depth.set(id, maxSettled + 1);
  }

  return depth;
}

/**
 * Orders nodes within each column by the average position of their neighbours, sweeping forwards
 * then backwards a few times. Standard barycentre heuristic — it doesn't minimise crossings, it just
 * removes enough of them that following one line by eye stops being work.
 */
function orderRows(columns: string[][], edges: DagEdge[]): void {
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (!parents.has(edge.to)) parents.set(edge.to, []);
    if (!children.has(edge.from)) children.set(edge.from, []);
    parents.get(edge.to)!.push(edge.from);
    children.get(edge.from)!.push(edge.to);
  }

  const rowOf = new Map<string, number>();
  for (const column of columns) column.forEach((id, i) => rowOf.set(id, i));

  const sweep = (column: string[], related: Map<string, string[]>) => {
    const score = new Map<string, number>();
    column.forEach((id, i) => {
      const neighbours = (related.get(id) ?? []).filter((n) => rowOf.has(n));
      score.set(id, neighbours.length === 0 ? i : neighbours.reduce((s, n) => s + rowOf.get(n)!, 0) / neighbours.length);
    });
    column.sort((a, b) => score.get(a)! - score.get(b)! || a.localeCompare(b));
    column.forEach((id, i) => rowOf.set(id, i));
  };

  for (let pass = 0; pass < 4; pass++) {
    for (let c = 1; c < columns.length; c++) sweep(columns[c], parents);
    for (let c = columns.length - 2; c >= 0; c--) sweep(columns[c], children);
  }
}

export function layoutDag(qualifiedNames: string[], rawEdges: DagEdge[]): DagLayout {
  const ids = Array.from(new Set(qualifiedNames.map((n) => n.toLowerCase()))).sort();
  const known = new Set(ids);
  const edges = rawEdges
    .map((e) => ({ from: e.from.toLowerCase(), to: e.to.toLowerCase() }))
    .filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);

  const depth = assignColumns(ids, edges);
  const columnCount = Math.max(1, ...Array.from(depth.values()).map((d) => d + 1));
  const columns: string[][] = Array.from({ length: columnCount }, () => []);
  for (const id of ids) columns[depth.get(id)!].push(id);

  orderRows(columns, edges);

  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * ROW_GAP;
  const width = PAD * 2 + columnCount * NODE_W + (columnCount - 1) * COL_GAP;

  const nodes: DagNode[] = [];
  columns.forEach((column, col) => {
    const columnHeight = column.length * NODE_H + (column.length - 1) * ROW_GAP;
    const top = (height - columnHeight) / 2;
    column.forEach((id, row) => {
      const name = splitQualifiedTable(id).name;
      nodes.push({
        id,
        qualified: id,
        name,
        label: truncate(name),
        schema: schemaOf(id),
        col,
        row,
        x: PAD + col * (NODE_W + COL_GAP),
        y: top + row * (NODE_H + ROW_GAP)
      });
    });
  });

  return { nodes, edges, width, height, columnCount };
}

export interface EdgeCurve {
  x1: number;
  y1: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  x2: number;
  y2: number;
  /** True when the edge runs right-to-left and had to bow out to stay clear of the boxes. */
  backward: boolean;
}

/**
 * The cubic bezier between two node boxes; a backward edge bows outward so it doesn't hide behind
 * boxes.
 *
 * Returned as points rather than a path string because a renderer that has to draw its own arrowhead
 * needs the second control point to know which way the line arrives. `edgePath` formats the same
 * numbers for the renderers that don't.
 */
export function edgeCurve(from: DagNode, to: DagNode): EdgeCurve {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;

  if (x2 >= x1) {
    const dx = Math.max(40, (x2 - x1) * 0.5);
    return { x1, y1, c1x: x1 + dx, c1y: y1, c2x: x2 - dx, c2y: y2, x2, y2, backward: false };
  }
  const bow = 60 + Math.abs(y2 - y1) * 0.2;
  return { x1, y1, c1x: x1 + bow, c1y: y1 - bow, c2x: x2 - bow, c2y: y2 - bow, x2, y2, backward: true };
}

export function edgePath(from: DagNode, to: DagNode): string {
  const c = edgeCurve(from, to);
  return `M${c.x1},${c.y1} C${c.c1x},${c.c1y} ${c.c2x},${c.c2y} ${c.x2},${c.y2}`;
}
