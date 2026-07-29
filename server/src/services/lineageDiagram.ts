import type { LayerRef, LineageEdge, LineageEdgeNotes, LocalTableRef } from "../types/index.js";
import { splitQualifiedTable } from "./localProject.js";
import { edgeKey } from "./lineageOverrides.js";

/**
 * Renders the extracted lineage as a page the user can actually reason about before approving it.
 *
 * Pure — it takes the graph and returns strings, writing nothing. The CLI owns where it lands.
 *
 * Two decisions shape this file:
 *
 * 1. **Layout is by dependency depth, not by schema.** Grouping columns by layer looks tidier but
 *    breaks the moment a layer feeds itself — `datamart.fact_arr -> datamart.rpt_snowball` is a real
 *    edge in a real project, and a schema-column layout has to draw it sideways through its own
 *    box. Longest-path layering puts every table exactly one column right of its deepest input, so
 *    every arrow points the same way and the graph reads left to right. Schema decides colour only.
 *
 * 2. **The SVG is hand-built with no charting library.** A CDN import means the page is blank
 *    without network access, which is the wrong failure mode for something whose entire job is to be
 *    looked at once, quickly, before a prompt is answered. Everything here is inline, so the file
 *    works offline, forever, and can be mailed to someone as a single artifact.
 *
 * The interactivity is what makes a 22-edge graph legible: clicking a table dims everything that is
 * not upstream or downstream of it, which turns "what feeds this?" from a tracing exercise into one
 * click.
 */

/** Above this, per-table layout stops being useful and the graph is drawn one node per schema. */
const COLLAPSE_ABOVE = 250;

const NODE_W = 190;
const NODE_H = 38;
const COL_GAP = 110;
const ROW_GAP = 16;
const PAD = 32;
const LABEL_MAX = 24;

export interface LineageDiagramInput {
  projectName: string;
  edges: LineageEdge[];
  layers: LayerRef[];
  tables: LocalTableRef[];
  /** Reviewer-model output, all optional — the diagram is fully useful without any of it. */
  narrative?: string;
  concerns?: string[];
  notes?: LineageEdgeNotes;
}

export interface LineageDiagram {
  html: string;
  /** True when the graph was drawn schema-by-schema rather than table-by-table. */
  collapsed: boolean;
}

interface DagNode {
  id: string;
  qualified: string;
  label: string;
  schema: string;
  col: number;
  row: number;
  x: number;
  y: number;
}

interface DagEdge {
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Safe to sit inside a <script> block: closes no tag and starts no comment. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function schemaOf(ref: string): string {
  return splitQualifiedTable(ref).schema ?? "(unqualified)";
}

function truncate(text: string): string {
  return text.length <= LABEL_MAX ? text : `${text.slice(0, LABEL_MAX - 1)}…`;
}

/**
 * Orders schemas by the pipeline where the layers say so, then appends anything left over, so colour
 * assignment follows the pipeline and unassigned schemas stay visible rather than being dropped.
 */
export function orderedSchemas(input: Pick<LineageDiagramInput, "layers" | "tables" | "edges">): string[] {
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
  for (const table of input.tables) rest.add(table.schema ?? "(unqualified)");
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
      nodes.push({
        id,
        qualified: id,
        label: truncate(splitQualifiedTable(id).name),
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

/** Cubic bezier between two node boxes; a backward edge bows outward so it doesn't hide behind boxes. */
function edgePath(from: DagNode, to: DagNode): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;

  if (x2 >= x1) {
    const dx = Math.max(40, (x2 - x1) * 0.5);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }
  const bow = 60 + Math.abs(y2 - y1) * 0.2;
  return `M${x1},${y1} C${x1 + bow},${y1 - bow} ${x2 - bow},${y2 - bow} ${x2},${y2}`;
}

function renderSvg(layout: DagLayout, schemas: string[]): string {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const colourOf = (schema: string) => `layer${Math.max(0, schemas.indexOf(schema)) % 6}`;

  const paths = layout.edges
    .map((edge, i) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return "";
      return `<path class="edge" id="e${i}" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(
        edge.to
      )}" d="${edgePath(from, to)}" marker-end="url(#arrow)"/>`;
    })
    .join("\n");

  const nodes = layout.nodes
    .map(
      (node) =>
        `<g class="node ${colourOf(node.schema)}" data-id="${escapeHtml(node.qualified)}" transform="translate(${
          node.x
        },${node.y})">` +
        `<rect width="${NODE_W}" height="${NODE_H}" rx="7"/>` +
        `<text x="11" y="16" class="nlabel">${escapeHtml(node.label)}</text>` +
        `<text x="11" y="29" class="nschema">${escapeHtml(node.schema)}</text>` +
        `<title>${escapeHtml(node.qualified)}</title>` +
        `</g>`
    )
    .join("\n");

  return `<svg id="dag" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z"/>
    </marker>
  </defs>
  <g id="viewport">
    <g id="edges">
${paths}
    </g>
    <g id="nodes">
${nodes}
    </g>
  </g>
</svg>`;
}

function edgeRows(input: LineageDiagramInput): string {
  if (input.edges.length === 0) {
    return '<tr><td colspan="4" class="empty">No lineage edges were extracted from this project\'s SQL.</td></tr>';
  }
  return input.edges
    .slice()
    .sort((a, b) => a.to.localeCompare(b.to) || a.from.localeCompare(b.from))
    .map((edge) => {
      const note = input.notes?.[edgeKey(edge.from, edge.to)] ?? "";
      return (
        `<tr data-from="${escapeHtml(edge.from.toLowerCase())}" data-to="${escapeHtml(edge.to.toLowerCase())}">` +
        `<td><code>${escapeHtml(edge.from)}</code></td>` +
        `<td><code>${escapeHtml(edge.to)}</code></td>` +
        `<td class="src">${escapeHtml(edge.notebookPath)}<span class="dim"> #${edge.cellIndex}</span></td>` +
        `<td>${escapeHtml(note)}</td>` +
        "</tr>"
      );
    })
    .join("\n");
}

export function buildLineageDiagram(input: LineageDiagramInput): LineageDiagram {
  const schemas = orderedSchemas(input);
  const collapsed = input.tables.length > COLLAPSE_ABOVE;

  // Collapsed mode reuses the same layout engine on a smaller graph: one node per schema.
  const names = collapsed ? schemas : input.tables.map((t) => t.qualified);
  const graphEdges: DagEdge[] = collapsed
    ? input.edges.map((e) => ({ from: schemaOf(e.from), to: schemaOf(e.to) }))
    : input.edges.map((e) => ({ from: e.from, to: e.to }));

  const layout = layoutDag(names, graphEdges);

  const adjacency: Record<string, { up: string[]; down: string[] }> = {};
  for (const node of layout.nodes) adjacency[node.id] = { up: [], down: [] };
  for (const edge of layout.edges) {
    adjacency[edge.to]?.up.push(edge.from);
    adjacency[edge.from]?.down.push(edge.to);
  }

  const details: Record<string, { schema: string; files: string[] }> = {};
  for (const node of layout.nodes) details[node.id] = { schema: node.schema, files: [] };
  for (const edge of input.edges) {
    const key = (collapsed ? schemaOf(edge.to) : edge.to).toLowerCase();
    const entry = details[key];
    if (entry && !entry.files.includes(edge.notebookPath)) entry.files.push(edge.notebookPath);
  }

  const orphans = input.tables.filter(
    (t) => !input.edges.some((e) => e.from.toLowerCase() === t.qualified || e.to.toLowerCase() === t.qualified)
  );
  const concerns = (input.concerns ?? []).filter((c) => c.trim().length > 0);

  const legend = schemas
    .map((s, i) => `<span class="key layer${i % 6}"><i></i>${escapeHtml(s)}</span>`)
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lineage — ${escapeHtml(input.projectName)}</title>
<style>
  :root { color-scheme: light dark;
    --bg:#fff; --fg:#1a1a1a; --dim:#6b6b6b; --line:#e2e2e2; --card:#fafafa; --warn:#8a6d1f;
    --edge:#b9bec6; --edge-hl:#3b7dd8; --node-bg:#fff; --sel:#3b7dd8; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181c; --fg:#e6e6e6; --dim:#9a9a9a; --line:#2e3238; --card:#1d2025; --warn:#d9b45b;
      --edge:#4a5058; --edge-hl:#6aa9ff; --node-bg:#22262c; --sel:#6aa9ff; }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:1.5rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:1400px; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .2rem; }
  h2 { font-size:1rem; margin:2rem 0 .7rem; }
  .sub { color:var(--dim); margin:0 0 1.2rem; }
  .stats { display:flex; flex-wrap:wrap; gap:.4rem 1.4rem; padding:.7rem .9rem; background:var(--card);
           border:1px solid var(--line); border-radius:8px; margin-bottom:1rem; }
  .stats b { font-variant-numeric:tabular-nums; }
  .card { padding:.9rem 1rem; background:var(--card); border:1px solid var(--line); border-radius:8px; }
  .concerns { border-left:3px solid var(--warn); }
  .concerns ul { margin:.3rem 0 0; padding-left:1.15rem; }

  .toolbar { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; margin-bottom:.6rem; }
  .toolbar input { flex:1 1 220px; min-width:180px; padding:.4rem .6rem; border-radius:6px;
                   border:1px solid var(--line); background:var(--bg); color:var(--fg); font:inherit; font-size:13.5px; }
  .toolbar button { padding:.4rem .7rem; border-radius:6px; border:1px solid var(--line);
                    background:var(--card); color:var(--fg); font:inherit; font-size:13px; cursor:pointer; }
  .toolbar button:hover { border-color:var(--sel); }
  .hint { color:var(--dim); font-size:12.5px; margin:.1rem 0 .6rem; }

  .stage { position:relative; border:1px solid var(--line); border-radius:8px; background:var(--card);
           height:min(70vh,640px); overflow:hidden; cursor:grab; }
  .stage.grabbing { cursor:grabbing; }
  svg#dag { width:100%; height:100%; display:block; touch-action:none; }
  #arrow path { fill:var(--edge); }

  .edge { fill:none; stroke:var(--edge); stroke-width:1.5; }
  .node rect { fill:var(--node-bg); stroke:var(--nc,#888); stroke-width:1.5; }
  .node { cursor:pointer; }
  .nlabel { font:600 12.5px ui-sans-serif,system-ui,sans-serif; fill:var(--fg); }
  .nschema { font:11px ui-monospace,Menlo,Consolas,monospace; fill:var(--dim); }

  .layer0 { --nc:#b8863f; } .layer1 { --nc:#3f7db8; } .layer2 { --nc:#3fb887; }
  .layer3 { --nc:#8b5fc7; } .layer4 { --nc:#c75f88; } .layer5 { --nc:#7d9b3f; }
  .node rect { fill:color-mix(in srgb, var(--nc) 10%, var(--node-bg)); }

  /* Focus mode: everything not on the selected table's path recedes. */
  svg.focusing .edge { opacity:.07; }
  svg.focusing .node { opacity:.16; }
  svg.focusing .edge.on { opacity:1; stroke:var(--edge-hl); stroke-width:2.4; }
  svg.focusing .node.on { opacity:1; }
  .node.root rect { stroke:var(--sel); stroke-width:3; }

  .panel { margin-top:.7rem; }
  .panel .empty { color:var(--dim); font-style:italic; }
  .panel h3 { margin:0 0 .3rem; font-size:.95rem; }
  .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:.9rem; }
  .cols ul { margin:.2rem 0 0; padding-left:1.1rem; }
  .cols li { font:12.5px ui-monospace,Menlo,Consolas,monospace; }

  .legend { display:flex; flex-wrap:wrap; gap:.9rem; margin:.6rem 0 0; font-size:12.5px; color:var(--dim); }
  .key { display:inline-flex; align-items:center; gap:.35rem; }
  .key i { width:11px; height:11px; border-radius:3px; border:1.5px solid var(--nc);
           background:color-mix(in srgb, var(--nc) 25%, transparent); }

  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th, td { text-align:left; padding:.4rem .55rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:600; }
  tr.match { background:color-mix(in srgb, var(--sel) 12%, transparent); }
  code { font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .src { color:var(--dim); font-size:12.5px; }
  .dim { color:var(--dim); }
  .empty { color:var(--dim); font-style:italic; }
  .tablewrap { overflow-x:auto; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(input.projectName)}</h1>
  <p class="sub">Lineage extracted from this project's SQL — review it, then approve in the terminal.</p>

  <div class="stats">
    <span><b>${input.tables.length}</b> tables</span>
    <span><b>${input.edges.length}</b> edges</span>
    <span><b>${input.layers.length}</b> layers</span>
    ${orphans.length > 0 ? `<span><b>${orphans.length}</b> unconnected</span>` : ""}
  </div>

  ${input.narrative ? `<div class="card"><strong>What this project does</strong><p style="margin:.45rem 0 0">${escapeHtml(input.narrative)}</p></div>` : ""}

  ${
    concerns.length > 0
      ? `<h2>Worth a look</h2><div class="card concerns"><ul>${concerns
          .map((c) => `<li>${escapeHtml(c)}</li>`)
          .join("")}</ul></div>`
      : ""
  }

  <h2>Pipeline${collapsed ? " (grouped by schema — too many tables to draw individually)" : ""}</h2>
  <div class="toolbar">
    <input id="search" type="search" placeholder="Find a table…" autocomplete="off">
    <button id="fit">Fit</button>
    <button id="zin">+</button>
    <button id="zout">−</button>
    <button id="clear">Clear selection</button>
  </div>
  <p class="hint">Click a table to see only what feeds it and what it feeds. Drag to pan, scroll to zoom, Esc to clear.</p>
  <div class="stage" id="stage">
${renderSvg(layout, schemas)}
  </div>
  <div class="legend">${legend}</div>

  <div class="panel card" id="panel"><span class="empty">No table selected — click one in the diagram.</span></div>

  <h2>Every edge (${input.edges.length})</h2>
  <div class="tablewrap">
    <table id="edgetable">
      <thead><tr><th>From</th><th>To</th><th>Defined in</th><th>Note</th></tr></thead>
      <tbody>
${edgeRows(input)}
      </tbody>
    </table>
  </div>

  ${
    orphans.length > 0
      ? `<h2>Not connected to anything (${orphans.length})</h2><div class="tablewrap"><table><tbody>${orphans
          .map(
            (t) =>
              `<tr><td><code>${escapeHtml(t.qualified)}</code></td><td class="dim">${
                t.written ? "written" : ""
              }${t.written && t.read ? ", " : ""}${t.read ? "read" : ""}</td></tr>`
          )
          .join("")}</tbody></table></div>`
      : ""
  }
</main>
<script>
(function () {
  var ADJ = ${embedJson(adjacency)};
  var DETAIL = ${embedJson(details)};

  var svg = document.getElementById("dag");
  var stage = document.getElementById("stage");
  var viewport = document.getElementById("viewport");
  var panel = document.getElementById("panel");
  var nodes = Array.prototype.slice.call(svg.querySelectorAll(".node"));
  var edges = Array.prototype.slice.call(svg.querySelectorAll(".edge"));
  var rows = Array.prototype.slice.call(document.querySelectorAll("#edgetable tbody tr"));

  // ---- pan / zoom -------------------------------------------------------
  var view = { x: 0, y: 0, k: 1 };
  function apply() {
    viewport.setAttribute("transform", "translate(" + view.x + "," + view.y + ") scale(" + view.k + ")");
  }
  function fit() {
    var box = svg.viewBox.baseVal;
    var w = stage.clientWidth || box.width;
    var h = stage.clientHeight || box.height;
    view.k = Math.min(w / box.width, h / box.height, 1.4) * 0.94;
    view.x = (w - box.width * view.k) / 2;
    view.y = (h - box.height * view.k) / 2;
    apply();
  }
  function zoom(factor, cx, cy) {
    var k = Math.max(0.15, Math.min(3, view.k * factor));
    var px = (cx - view.x) / view.k;
    var py = (cy - view.y) / view.k;
    view.k = k;
    view.x = cx - px * k;
    view.y = cy - py * k;
    apply();
  }

  svg.setAttribute("viewBox", svg.getAttribute("viewBox"));
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  window.addEventListener("resize", fit);

  var dragging = false, moved = false, sx = 0, sy = 0;
  stage.addEventListener("pointerdown", function (e) {
    dragging = true; moved = false; sx = e.clientX - view.x; sy = e.clientY - view.y;
    stage.classList.add("grabbing"); stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    if (Math.abs(e.clientX - view.x - sx) > 3 || Math.abs(e.clientY - view.y - sy) > 3) moved = true;
    view.x = e.clientX - sx; view.y = e.clientY - sy; apply();
  });
  stage.addEventListener("pointerup", function (e) {
    dragging = false; stage.classList.remove("grabbing");
    try { stage.releasePointerCapture(e.pointerId); } catch (err) {}
  });
  stage.addEventListener("wheel", function (e) {
    e.preventDefault();
    var r = stage.getBoundingClientRect();
    zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  document.getElementById("fit").onclick = fit;
  document.getElementById("zin").onclick = function () { zoom(1.2, stage.clientWidth / 2, stage.clientHeight / 2); };
  document.getElementById("zout").onclick = function () { zoom(1 / 1.2, stage.clientWidth / 2, stage.clientHeight / 2); };

  // ---- focus ------------------------------------------------------------
  function reach(id, dir) {
    var seen = {}, stack = [id];
    while (stack.length) {
      var cur = stack.pop();
      var next = (ADJ[cur] || { up: [], down: [] })[dir] || [];
      for (var i = 0; i < next.length; i++) {
        if (!seen[next[i]]) { seen[next[i]] = true; stack.push(next[i]); }
      }
    }
    return seen;
  }

  var selected = null;

  function clearFocus() {
    selected = null;
    svg.classList.remove("focusing");
    nodes.forEach(function (n) { n.classList.remove("on", "root"); });
    edges.forEach(function (e) { e.classList.remove("on"); });
    rows.forEach(function (r) { r.classList.remove("match"); });
    panel.innerHTML = '<span class="empty">No table selected — click one in the diagram.</span>';
  }

  function focus(id) {
    if (!ADJ[id]) return;
    selected = id;
    var up = reach(id, "up"), down = reach(id, "down");
    var live = {}; live[id] = true;
    Object.keys(up).forEach(function (k) { live[k] = true; });
    Object.keys(down).forEach(function (k) { live[k] = true; });

    svg.classList.add("focusing");
    nodes.forEach(function (n) {
      var nid = n.getAttribute("data-id");
      n.classList.toggle("on", !!live[nid]);
      n.classList.toggle("root", nid === id);
    });
    edges.forEach(function (e) {
      var f = e.getAttribute("data-from"), t = e.getAttribute("data-to");
      e.classList.toggle("on", !!live[f] && !!live[t]);
    });
    rows.forEach(function (r) {
      var f = r.getAttribute("data-from"), t = r.getAttribute("data-to");
      r.classList.toggle("match", !!live[f] && !!live[t]);
    });

    var d = DETAIL[id] || { schema: "", files: [] };
    var ups = (ADJ[id].up || []).slice().sort();
    var downs = (ADJ[id].down || []).slice().sort();
    function list(items, empty) {
      return items.length ? "<ul>" + items.map(function (x) { return "<li>" + x + "</li>"; }).join("") + "</ul>"
                          : '<span class="empty">' + empty + "</span>";
    }
    panel.innerHTML =
      "<h3>" + id + "</h3>" +
      '<div class="cols">' +
        "<div><strong>Feeds from (" + ups.length + ")</strong>" + list(ups, "nothing — this is a source") + "</div>" +
        "<div><strong>Feeds into (" + downs.length + ")</strong>" + list(downs, "nothing — this is an endpoint") + "</div>" +
        "<div><strong>All upstream</strong> " + Object.keys(up).length +
          "<br><strong>All downstream</strong> " + Object.keys(down).length +
          "<br><strong>Schema</strong> " + d.schema + "</div>" +
        "<div><strong>Built in</strong>" + list(d.files, "no writing statement found") + "</div>" +
      "</div>";
  }

  nodes.forEach(function (n) {
    n.addEventListener("click", function (e) {
      e.stopPropagation();
      if (moved) return;
      var id = n.getAttribute("data-id");
      if (id === selected) clearFocus(); else focus(id);
    });
  });
  stage.addEventListener("click", function () { if (!moved) clearFocus(); });
  document.getElementById("clear").onclick = clearFocus;
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") clearFocus(); });

  // ---- search -----------------------------------------------------------
  document.getElementById("search").addEventListener("input", function (e) {
    var q = e.target.value.trim().toLowerCase();
    if (!q) { nodes.forEach(function (n) { n.style.opacity = ""; }); return; }
    var hit = null;
    nodes.forEach(function (n) {
      var id = n.getAttribute("data-id");
      var match = id.indexOf(q) !== -1;
      n.style.opacity = match ? "1" : ".18";
      if (match && !hit) hit = id;
    });
    if (hit && q.length > 2) focus(hit);
  });

  fit();
})();
</script>
</body>
</html>
`;

  return { html, collapsed };
}
