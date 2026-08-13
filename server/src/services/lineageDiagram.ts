import {
  EDGE_COLOUR,
  NODE_H,
  NODE_W,
  SCHEMA_COLOURS,
  edgePath,
  orderedSchemas,
  schemaColourIndex,
  schemaOf,
  type DagLayout
} from "./dagLayout.js";
import { buildDiagramComponents, type DiagramComponent, type DiagramGraph } from "./diagramComponents.js";
import { layerHasTable } from "./layers.js";
import { edgeKey } from "./lineageOverrides.js";
import type {
  LayerRef,
  LineageEdge,
  LineageEdgeNotes,
  LocalFileSummary,
  LocalTableRef
} from "../types/index.js";

/**
 * Renders the extracted lineage as a page the user can actually reason about before approving it.
 *
 * Pure — it takes the graph and returns strings, writing nothing. The CLI owns where it lands.
 *
 * Layout and colour now come from `dagLayout.ts`, shared with the two Office renderers, so the picture
 * reviewed here and the picture pasted into a document are the same picture. What is left in this file
 * is the *page*: the interactivity that makes a 22-edge graph legible, and the clipboard blocks below.
 *
 * **The SVG is hand-built with no charting library.** A CDN import means the page is blank without
 * network access, which is the wrong failure mode for something whose entire job is to be looked at
 * once, quickly, before a prompt is answered. Everything here is inline, so the file works offline,
 * forever, and can be mailed to someone as a single artifact.
 *
 * The interactivity is what makes a 22-edge graph legible: clicking a table lights its flow and dims
 * everything not on it, which turns "what feeds this?" from a tracing exercise into one click.
 * Upstream and downstream are lit in *different* colours rather than one, because the reader is
 * asking two questions and a single highlight makes them separate the answers by eye; the lit edges
 * animate along the direction of flow, and the selected table glows so it stays findable in a graph
 * too big to scan. All of that is page-only — `officeSvg.ts` renders a static picture and shares none
 * of it — so filters, animation and custom properties are all fair game here.
 *
 * Below the graph the same pipeline is shown a second way — as the project's **folder tree**, each
 * folder carrying the colour of the layer its SQL writes into (see the Project structure block).
 * Lineage answers "what feeds what"; that answers "where is it", which is the other thing a reader
 * new to the project needs and cannot get from a graph of table names.
 *
 * There is deliberately **no find-a-table box**. It dimmed non-matching nodes by writing
 * `style.opacity` straight onto them, and an inline style outranks a stylesheet — so after one
 * keystroke the focus mode's own opacity rules were dead, and clicking a table appeared to highlight
 * nothing but the table itself. Selection is one interaction, driven by clicking, and the two ways of
 * dimming the same nodes cannot both own that. If searching is ever wanted back, it must mark nodes
 * with a *class* the focus rules can outrank, never with an inline style.
 *
 * **What the copy buttons can and cannot do.** They copy a DOM *table* selection, which Word and
 * PowerPoint paste as a native, editable table — that part is genuinely useful and needs no files. They
 * deliberately do not offer to copy the diagram: a browser puts a bitmap of an SVG on the clipboard, so
 * pasting the graph here would produce a picture with dead text, which is the opposite of what someone
 * clicking "copy" wants. Editable *shapes* come from the .pptx and .svg that `reconcile diagrams`
 * writes, and the page says so rather than pretending otherwise.
 */

export interface LineageDiagramInput extends DiagramGraph {
  /**
   * The reviewer model's per-edge notes — the only part of its review this page shows.
   *
   * Its prose summary and its list of concerns are deliberately not rendered here: this page is the
   * graph, and a reader comes to it to see what connects to what. Both are still written to
   * `lineage.json` and printed at the approval prompt, where they are read once and acted on.
   */
  notes?: LineageEdgeNotes;
  /**
   * Filename of the editable deck sitting beside this page, linked from it when given.
   *
   * A name, not a path: the page and the deck are written into the same folder, so a bare filename is
   * a working `file://` link from wherever the folder ends up — including after it is copied or mailed
   * somewhere else, which an absolute path would not survive.
   */
  deckFile?: string;
  /**
   * The project's `.sql` files, which the structure block draws as a tree.
   *
   * Optional because the graph alone is a complete page — a caller with no file list gets the same
   * page minus that one section rather than a broken one. `writes` is what ties a file to a layer,
   * so a summary is enough and no SQL text is needed here.
   */
  files?: LocalFileSummary[];
}

export interface LineageDiagram {
  html: string;
  /** True when the graph was drawn schema-by-schema rather than table-by-table. */
  collapsed: boolean;
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

function renderSvg(layout: DagLayout, schemas: string[]): string {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));

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
        `<g class="node layer${schemaColourIndex(schemas, node.schema)}" data-id="${escapeHtml(
          node.qualified
        )}" transform="translate(${node.x},${node.y})">` +
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
    <!--
      One marker per highlight state. A marker cannot inherit its parent path's stroke portably
      (context-stroke is not everywhere yet), so the arrowhead colour is switched by pointing
      marker-end at a different marker from CSS — a presentation attribute a CSS rule outranks.
    -->
    <marker id="arrow-up" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z"/>
    </marker>
    <marker id="arrow-down" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
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

/**
 * One component's edges as a table.
 *
 * `tableId` is `edgetable` for the overview so the focus mode keeps highlighting rows as tables are
 * clicked; the per-hop tables are not wired to it, since a hop is already a filtered view.
 */
function edgeTable(edges: LineageEdge[], notes: LineageEdgeNotes | undefined, tableId: string, empty: string): string {
  const rows =
    edges.length === 0
      ? `<tr><td colspan="4" class="empty">${escapeHtml(empty)}</td></tr>`
      : edges
          .slice()
          .sort((a, b) => a.to.localeCompare(b.to) || a.from.localeCompare(b.from))
          .map((edge) => {
            const note = notes?.[edgeKey(edge.from, edge.to)] ?? "";
            return (
              `<tr data-from="${escapeHtml(edge.from.toLowerCase())}" data-to="${escapeHtml(edge.to.toLowerCase())}">` +
              `<td><code>${escapeHtml(edge.from)}</code></td>` +
              `<td><code>${escapeHtml(edge.to)}</code></td>` +
              `<td class="src">${escapeHtml(edge.notebookPath)}</td>` +
              `<td>${escapeHtml(note)}</td>` +
              "</tr>"
            );
          })
          .join("\n");

  return `<table id="${tableId}">
      <thead><tr><th>Source table</th><th>Target table</th><th>Files</th><th>Notes</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>`;
}

/** One copyable block per component: what it is, and its edges as a table Word will accept. */
function componentBlock(component: DiagramComponent, index: number, notes: LineageEdgeNotes | undefined): string {
  const tableId = index === 0 ? "edgetable" : `t_${component.id}`;
  const empty =
    component.emptyReason ?? "No lineage edges were extracted for this part of the project's SQL.";

  return `<section class="comp" id="c_${escapeHtml(component.id)}">
    <div class="comphead">
      <div>
        <h3>${escapeHtml(component.title)}</h3>
        <p class="dim small">${escapeHtml(component.subtitle)}</p>
      </div>
      <button class="copy" data-table="${tableId}" data-label="${escapeHtml(component.title)}">Copy table</button>
    </div>
    <div class="tablewrap">
    ${edgeTable(component.sourceEdges, notes, tableId, empty)}
    </div>
  </section>`;
}

/* ---- Project structure ---------------------------------------------------
   The layers beside the folders that build them.

   The diagram above says what feeds what; this says *where in the repo* each stage lives, which is
   the other half of finding your way around a project you didn't write. A folder is tied to a layer
   the same way `layerDetection.ts` groups by folder — through the tables the files under it
   **write** — so a folder coloured `silver` here is a folder whose SQL genuinely builds silver
   tables, never one whose name merely looks like it should.

   Files are counted, not all listed: a 300-file project drawn in full is a wall nobody reads, so each
   folder shows a few of its files and says how many it kept back. The ones held back are written into
   the page collapsed rather than left out, so "… N more files" can open them — a count of files you
   cannot then look at is the one thing worse than the wall. They cost no vertical space until asked
   for, which is why they are charged to their own budget and not to MAX_TREE_LINES. */

const MAX_FILES_PER_DIR = 6;
const MAX_TREE_LINES = 260;
const MAX_HIDDEN_FILES = 600;

interface StructureFile {
  name: string;
  /** The layer this file builds into, as an index into the pipeline, or null when it builds nothing. */
  layer: number | null;
  /** A node id the diagram above can focus, so a file is one click from what it produces. */
  focusId: string | null;
  writes: string[];
}

interface TreeDir {
  name: string;
  dirs: Map<string, TreeDir>;
  files: StructureFile[];
}

/**
 * The layer a set of written tables belongs to — by vote, so a file that writes into two layers is
 * placed with the one it builds most of rather than being dropped for being ambiguous.
 */
function layerOfTables(tables: string[], layers: LayerRef[]): number | null {
  const votes: number[] = layers.map(() => 0);
  for (const table of tables) {
    for (const [i, layer] of layers.entries()) if (layerHasTable(layer, table)) votes[i]++;
  }
  let best: number | null = null;
  for (const [i, count] of votes.entries()) if (count > 0 && (best === null || count > votes[best])) best = i;
  return best;
}

function emptyDir(name: string): TreeDir {
  return { name, dirs: new Map(), files: [] };
}

function buildTree(
  files: LocalFileSummary[],
  root: string,
  layers: LayerRef[],
  nodeIds: Set<string>,
  collapsed: boolean
): TreeDir {
  const tree = emptyDir(root);

  for (const file of files) {
    // Windows paths arrive from the CLI's own walk; the browser's upload uses "/" already.
    const parts = file.path.split(/[\\/]/).filter((p) => p.length > 0);
    const name = parts.pop();
    if (name === undefined) continue;

    let dir = tree;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = emptyDir(part);
        dir.dirs.set(part, next);
      }
      dir = next;
    }

    const written = file.writes.map((t) => t.toLowerCase());
    const first = written[0];
    const candidate = first === undefined ? null : collapsed ? schemaOf(first) : first;
    dir.files.push({
      name,
      layer: layerOfTables(written, layers),
      focusId: candidate !== null && nodeIds.has(candidate) ? candidate : null,
      writes: written
    });
  }

  return tree;
}

/** Every file at or below `dir`, which is what a folder's own layer is read from. */
function descendantFiles(dir: TreeDir): StructureFile[] {
  return [...dir.files, ...Array.from(dir.dirs.values()).flatMap(descendantFiles)];
}

/**
 * A folder's layer, and only when the files under it *agree* — a mixed folder gets none.
 *
 * By vote instead, the folder every stage lives under wins the layer that happens to have the most
 * files in it, and a project's `src/` comes out coloured `datamart`. That is worse than uncoloured:
 * it says the root builds the mart. Unanimity is the claim the colour is actually making, and files
 * that build nothing (a function, a grant script) abstain rather than break it.
 */
function unanimousLayer(files: StructureFile[]): number | null {
  let layer: number | null = null;
  for (const file of files) {
    if (file.layer === null) continue;
    if (layer === null) layer = file.layer;
    else if (layer !== file.layer) return null;
  }
  return layer;
}

/**
 * The palette slot each layer takes, so a layer's box, its folders and its boxes in the diagram are
 * one colour.
 *
 * A layer that *is* a schema takes that schema's slot — `orderedSchemas` lists the pipeline's schemas
 * first, so this is normally its own position anyway, but going through the palette keeps the two in
 * step whatever the ordering. A folder layer has no schema to look up (`orderedSchemas` deliberately
 * reserves nothing for it), so it falls back to its position in the pipeline.
 */
function layerColours(layers: LayerRef[], schemas: string[]): number[] {
  return layers.map((layer, i) =>
    layer.tables ? i % SCHEMA_COLOURS.length : schemaColourIndex(schemas, layer.schema.toLowerCase())
  );
}

/** `layerN` is what carries the colour; the diagram's boxes take theirs from the same class. */
function layerClass(colour: number | null): string {
  return colour === null ? "" : ` layer${colour % SCHEMA_COLOURS.length}`;
}

function treeLine(
  prefix: string,
  name: string,
  layer: number | null,
  colour: number | null,
  kind: string,
  meta: string,
  attrs = ""
): string {
  return (
    `<div class="tline ${kind}${layerClass(colour)}"${layer === null ? "" : ` data-layer="${layer}"`}${attrs}>` +
    `<span class="tpre">${prefix}</span><span class="tname">${escapeHtml(name)}</span>` +
    (meta ? `<span class="tmeta">${escapeHtml(meta)}</span>` : "") +
    "</div>"
  );
}

/**
 * One folder's lines, depth-first, folders before files.
 *
 * `budget` is shared across the whole walk rather than per folder, so a deep project truncates at the
 * point it gets too long instead of losing a little from every branch.
 */
function renderDir(
  dir: TreeDir,
  prefix: string,
  layers: LayerRef[],
  colours: number[],
  out: string[],
  budget: { left: number; cut: boolean; hiddenLeft: number }
): void {
  const dirs = Array.from(dir.dirs.values()).sort((a, b) => a.name.localeCompare(b.name));
  const files = dir.files.slice().sort((a, b) => a.name.localeCompare(b.name));
  const shown = files.slice(0, MAX_FILES_PER_DIR);
  const hidden = files.length - shown.length;
  const entries = dirs.length + shown.length + (hidden > 0 ? 1 : 0);

  let seen = 0;
  for (const child of dirs) {
    if (budget.left <= 0) {
      budget.cut = true;
      return;
    }
    budget.left--;
    seen++;
    const last = seen === entries;
    const kids = descendantFiles(child);
    const layer = unanimousLayer(kids);
    const count = kids.length;
    const label = layer === null ? "" : layers[layer].label;
    out.push(
      treeLine(
        `${prefix}${last ? "└── " : "├── "}`,
        child.name,
        layer,
        layer === null ? null : colours[layer],
        "dir",
        label ? `${count} file${count === 1 ? "" : "s"} · ${label}` : `${count} file${count === 1 ? "" : "s"}`
      )
    );
    renderDir(child, `${prefix}${last ? "    " : "│   "}`, layers, colours, out, budget);
  }

  for (const file of shown) {
    if (budget.left <= 0) {
      budget.cut = true;
      return;
    }
    budget.left--;
    seen++;
    const last = seen === entries;
    out.push(fileLine(file, `${prefix}${last ? "└── " : "├── "}`, colours, "", ""));
  }

  if (hidden > 0 && budget.left > 0) {
    budget.left--;
    // Only worth making a toggle of if every file behind it fits: a control that reveals some of
    // what it counted would misreport the folder twice over.
    const extras = budget.hiddenLeft >= hidden ? files.slice(MAX_FILES_PER_DIR) : [];
    budget.hiddenLeft -= extras.length;
    out.push(...moreLines(extras, hidden, prefix, colours, out.length));
  }
}

/** One file's line — the same whether it is one of the first few or one of the revealed extras. */
function fileLine(
  file: StructureFile,
  prefix: string,
  colours: number[],
  extraClass: string,
  extraAttrs: string
): string {
  return treeLine(
    prefix,
    file.name,
    file.layer,
    file.layer === null ? null : colours[file.layer],
    `${file.focusId ? "file link" : "file"}${extraClass}`,
    file.writes.length > 0 ? file.writes[0] : "",
    (file.focusId ? ` data-focus="${escapeHtml(file.focusId)}"` : "") +
      (file.writes.length > 0 ? ` title="builds ${escapeHtml(file.writes.join(", "))}"` : "") +
      extraAttrs
  );
}

/**
 * The "… N more files" line and, behind it, the files themselves — collapsed, in the page, ready.
 *
 * Both prefixes are carried on the line because expanding it stops it being the last entry in its
 * folder: the branch character has to become "├──" or the tree draws a corner with lines below it.
 * The script swaps them, which is cheaper than re-rendering and keeps the closed page correct with
 * no script at all.
 *
 * With `extras` empty (the hidden budget spent) the count is emitted exactly as it always was: a
 * plain, unclickable note, rather than a control that would open onto nothing.
 */
function moreLines(
  extras: StructureFile[],
  hidden: number,
  prefix: string,
  colours: number[],
  index: number
): string[] {
  const plural = hidden === 1 ? "" : "s";
  const show = `… ${hidden} more file${plural}`;
  if (extras.length === 0) return [treeLine(`${prefix}└── `, show, null, null, "more", "")];

  const id = `more${index}`;
  const closed = `${prefix}└── `;
  const open = `${prefix}├── `;
  const attrs =
    ` role="button" tabindex="0" aria-expanded="false" data-more="${id}"` +
    ` data-show="${escapeHtml(show)}" data-hide="${escapeHtml(`… hide ${hidden} file${plural}`)}"` +
    ` data-pre-closed="${escapeHtml(closed)}" data-pre-open="${escapeHtml(open)}"`;

  return [
    treeLine(closed, show, null, null, "more toggle", "", attrs),
    ...extras.map((file, i) =>
      fileLine(
        file,
        `${prefix}${i === extras.length - 1 ? "└── " : "├── "}`,
        colours,
        " extra",
        ` data-more-of="${id}" hidden`
      )
    )
  ];
}

/**
 * The stack of layers, most-derived at the top, beside the folder tree.
 *
 * Reversed deliberately: a pipeline stack is read bottom-up, raw at the bottom and what the business
 * reads at the top, which is the shape people already have in their heads for a medallion diagram.
 */
function layerStack(
  layers: LayerRef[],
  colours: number[],
  tables: LocalTableRef[],
  fileCounts: number[]
): string {
  if (layers.length === 0) {
    return '<p class="empty">No layers were detected — the SQL never qualifies its tables, so the whole project is one scope.</p>';
  }

  return layers
    .map((layer, i) => {
      const count = tables.filter((t) => layerHasTable(layer, t.qualified)).length;
      const files = fileCounts[i] ?? 0;
      return (
        `<div class="lbox${layerClass(colours[i])}" data-layer="${i}" role="button" tabindex="0">` +
        `<b>${escapeHtml(layer.label)}</b>` +
        `<span class="dim small">${escapeHtml(layer.tables ? `${layer.schema} (folder)` : layer.schema)}</span>` +
        `<span class="dim small">${count} table${count === 1 ? "" : "s"} · ${files} file${
          files === 1 ? "" : "s"
        }</span>` +
        "</div>"
      );
    })
    .reverse()
    .join("");
}

function structureSection(
  input: LineageDiagramInput,
  schemas: string[],
  nodeIds: Set<string>,
  collapsed: boolean
): string {
  const files = input.files ?? [];
  if (files.length === 0) return "";

  const colours = layerColours(input.layers, schemas);
  const tree = buildTree(files, input.projectName, input.layers, nodeIds, collapsed);
  const placed = descendantFiles(tree);
  const fileCounts = input.layers.map((_, i) => placed.filter((file) => file.layer === i).length);

  const lines: string[] = [];
  const budget = { left: MAX_TREE_LINES, cut: false, hiddenLeft: MAX_HIDDEN_FILES };
  renderDir(tree, "", input.layers, colours, lines, budget);

  const unplaced = placed.filter((file) => file.layer === null).length;
  // Whether any folder held files back *and* had room to write them in collapsed, which is the only
  // case where there is a control to tell the reader about.
  const expandable = budget.hiddenLeft < MAX_HIDDEN_FILES;

  return `  <h2>Project structure</h2>
  <p class="hint">Where each stage lives on disk. A folder takes the colour of the layer its SQL
  <em>writes into</em> — read off the tables the files under it build, not off the folder's name — so
  the boxes on the left and the folders on the right are the same pipeline seen two ways.
  <strong>Click a layer</strong> to pick out its folders${
    nodeIds.size > 0 ? ", or a file to light up the table it builds in the diagram above" : ""
  }.${
    expandable
      ? ' A folder with more files than fit ends in <strong>… N more files</strong> — click that to see them.'
      : ""
  }</p>
  <div class="structure" id="structure">
    <div>
      <h3 class="colhead">Layers</h3>
      <div class="layerstack">
${layerStack(input.layers, colours, input.tables, fileCounts)}
      </div>
      <p class="dim small" style="margin:.5rem 0 0">Read bottom-up: each layer is built from the one below it.</p>
    </div>
    <div>
      <h3 class="colhead">Layered project structure</h3>
      <div class="card tree">
        <div class="tline root"><span class="tname">${escapeHtml(input.projectName)}</span><span class="tmeta">${
          files.length
        } SQL file${files.length === 1 ? "" : "s"}</span></div>
${lines.join("\n")}
      </div>
      <p class="dim small" style="margin:.45rem 0 0">
        ${
          budget.cut
            ? `Tree cut off at ${MAX_TREE_LINES} lines — this project has more folders than fit here. `
            : ""
        }${
          unplaced > 0
            ? `${unplaced} file${unplaced === 1 ? " builds" : "s build"} no table any layer claims (a lookup, a
        procedure, or a table outside the pipeline), so ${unplaced === 1 ? "it is" : "they are"} left uncoloured.`
            : "Every file here builds into a layer."
        }
      </p>
    </div>
  </div>

`;
}

export function buildLineageDiagram(input: LineageDiagramInput): LineageDiagram {
  const schemas = orderedSchemas(input);
  const components = buildDiagramComponents(input);
  const overview = components[0];
  const layout = overview.layout;
  const collapsed = overview.collapsed;

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

  const legend = schemas
    .map((s, i) => `<span class="key layer${i % SCHEMA_COLOURS.length}"><i></i>${escapeHtml(s)}</span>`)
    .join("");

  const structure = structureSection(input, schemas, new Set(layout.nodes.map((n) => n.id)), collapsed);

  // Generated from the shared palette rather than written out here, so the boxes on a slide and the
  // boxes on this page cannot drift apart.
  const layerCss = SCHEMA_COLOURS.map((c, i) => `.layer${i} { --nc:${c.stroke}; }`).join(" ");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lineage — ${escapeHtml(input.projectName)}</title>
<style>
  :root { color-scheme: light dark;
    --bg:#fff; --fg:#1a1a1a; --dim:#6b6b6b; --line:#e2e2e2; --card:#fafafa; --warn:#8a6d1f;
    --edge:${EDGE_COLOUR}; --edge-hl:#3b7dd8; --node-bg:#fff; --sel:#3b7dd8; --ok:#2f7d4f;
    /* Upstream and downstream get their own colour: "what feeds this" and "what this feeds" are
       different questions, and one highlight colour makes the reader work out which is which. */
    --up:#b8701c; --down:#127f7f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181c; --fg:#e6e6e6; --dim:#9a9a9a; --line:#2e3238; --card:#1d2025; --warn:#d9b45b;
      --edge:#4a5058; --edge-hl:#6aa9ff; --node-bg:#22262c; --sel:#6aa9ff; --ok:#6cc48d;
      --up:#e8a95a; --down:#57cfcf; }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:1.5rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:1400px; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .2rem; }
  h2 { font-size:1rem; margin:2rem 0 .7rem; }
  .sub { color:var(--dim); margin:0 0 1.2rem; }
  .small { font-size:12.5px; }
  .stats { display:flex; flex-wrap:wrap; gap:.4rem 1.4rem; padding:.7rem .9rem; background:var(--card);
           border:1px solid var(--line); border-radius:8px; margin-bottom:1rem; }
  .stats b { font-variant-numeric:tabular-nums; }
  .card { padding:.9rem 1rem; background:var(--card); border:1px solid var(--line); border-radius:8px; }

  .toolbar { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; margin-bottom:.6rem; }
  button { padding:.4rem .7rem; border-radius:6px; border:1px solid var(--line);
           background:var(--card); color:var(--fg); font:inherit; font-size:13px; cursor:pointer; }
  button:hover { border-color:var(--sel); }
  button.done { border-color:var(--ok); color:var(--ok); }
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

  ${layerCss}
  .node rect { fill:color-mix(in srgb, var(--nc) 10%, var(--node-bg)); }

  /* ---- Focus mode -------------------------------------------------------
     Clicking a table asks two questions at once — what feeds it, and what it feeds — so the two
     directions carry their own colour instead of sharing one highlight, and the lit edges animate
     along the direction of flow. Everything off the path recedes far enough to read as background
     without dissolving the shape of the graph. */
  svg.focusing .edge { opacity:.06; }
  svg.focusing .node { opacity:.13; }
  svg.focusing .node.up, svg.focusing .node.down, svg.focusing .node.root { opacity:1; }

  svg.focusing .edge.up, svg.focusing .edge.down {
    opacity:1; stroke-width:2.6; filter:drop-shadow(0 0 3px);
    stroke-dasharray:10 4; animation:flow .85s linear infinite;
  }
  svg.focusing .edge.up   { stroke:var(--up);   color:var(--up);   marker-end:url(#arrow-up); }
  svg.focusing .edge.down { stroke:var(--down); color:var(--down); marker-end:url(#arrow-down); }
  #arrow-up path { fill:var(--up); }
  #arrow-down path { fill:var(--down); }
  @keyframes flow { to { stroke-dashoffset:-28; } }

  /* The glow itself. A drop-shadow in the box's own highlight colour reads as light coming off it,
     which is what makes the selected table findable in a graph too big to scan. */
  svg.focusing .node.up rect   { stroke:var(--up);   stroke-width:2.4; filter:drop-shadow(0 0 5px var(--up)); }
  svg.focusing .node.down rect { stroke:var(--down); stroke-width:2.4; filter:drop-shadow(0 0 5px var(--down)); }
  svg.focusing .node.root rect {
    stroke:var(--sel); stroke-width:3.5;
    filter:drop-shadow(0 0 7px var(--sel)) drop-shadow(0 0 15px var(--sel));
    animation:pulse 2.1s ease-in-out infinite;
  }
  @keyframes pulse {
    50% { filter:drop-shadow(0 0 11px var(--sel)) drop-shadow(0 0 22px var(--sel)); }
  }
  svg.focusing .node.root .nlabel { fill:var(--sel); }

  /* Before anything is selected, hovering still says "this is clickable". */
  svg:not(.focusing) .node:hover rect { stroke-width:2.6; filter:drop-shadow(0 0 6px var(--nc)); }

  @media (prefers-reduced-motion: reduce) {
    svg.focusing .edge.up, svg.focusing .edge.down { animation:none; stroke-dasharray:none; }
    svg.focusing .node.root rect { animation:none; }
  }

  /* Reads as the key to the colours above, and only exists while something is selected. */
  #focuskey { display:none; gap:1rem; flex-wrap:wrap; align-items:center; margin:.55rem 0 0; font-size:12.5px; }
  #focuskey.on { display:flex; }
  #focuskey .fk { display:inline-flex; align-items:center; gap:.35rem; color:var(--dim); }
  #focuskey .fk i { width:16px; height:3px; border-radius:2px; }
  #focuskey .fk.u i { background:var(--up); }
  #focuskey .fk.d i { background:var(--down); }
  #focuskey .fk.r i { background:var(--sel); height:11px; width:11px; border-radius:3px; }

  .panel { margin-top:.7rem; }
  .panel .empty { color:var(--dim); font-style:italic; }
  .panel h3 { margin:0 0 .3rem; font-size:.95rem; }
  .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:.9rem; }
  .cols ul { margin:.2rem 0 0; padding-left:1.1rem; }
  .cols li { font:12.5px ui-monospace,Menlo,Consolas,monospace; }
  .cols a.jump { color:inherit; text-decoration:none; border-bottom:1px dotted var(--dim); }
  .cols a.jump:hover { color:var(--sel); border-bottom-color:var(--sel); }

  .legend { display:flex; flex-wrap:wrap; gap:.9rem; margin:.6rem 0 0; font-size:12.5px; color:var(--dim); }
  .key { display:inline-flex; align-items:center; gap:.35rem; }
  .key i { width:11px; height:11px; border-radius:3px; border:1.5px solid var(--nc);
           background:color-mix(in srgb, var(--nc) 25%, transparent); }

  /* ---- Project structure ------------------------------------------------
     Two columns that must line up as one picture: the layer stack on the left and the folder tree on
     the right, sharing the diagram's colours. It collapses to one column on a narrow screen rather
     than letting the tree squeeze — a tree that wraps stops being a tree. */
  .structure { display:grid; grid-template-columns:minmax(200px,270px) 1fr; gap:1.1rem; align-items:start; }
  @media (max-width: 880px) { .structure { grid-template-columns:1fr; } }
  .colhead { margin:0 0 .5rem; font-size:.8rem; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); }
  .layerstack { display:flex; flex-direction:column; gap:.4rem; }
  .lbox { border:1.5px solid var(--nc,#888); border-left-width:5px; border-radius:7px; padding:.5rem .65rem;
          background:color-mix(in srgb, var(--nc) 13%, var(--bg)); cursor:pointer; }
  .lbox b { display:block; font-size:13.5px; }
  .lbox span { display:block; font-size:11.5px; line-height:1.35; }
  .lbox:hover { border-color:var(--sel); }
  .lbox.on { box-shadow:0 0 0 2px var(--nc) inset; }

  .tree { font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow-x:auto;
          padding:.7rem .9rem; }
  .tline { white-space:pre; border-radius:4px; }
  .tline.root .tname { font-weight:700; }
  .tpre { color:var(--dim); }
  .tname { color:var(--fg); }
  .tline.dir .tname { font-weight:700; color:var(--nc,var(--fg)); }
  .tline.file .tname { color:var(--nc,var(--fg)); }
  .tline.more .tname, .tline.more .tpre { color:var(--dim); font-style:italic; }
  /* The count is a control when the files behind it are in the page — see moreLines(). */
  .tline.more.toggle { cursor:pointer; }
  .tline.more.toggle:hover .tname { color:var(--sel); text-decoration:underline; }
  .tline.more.toggle:focus-visible { outline:2px solid var(--sel); outline-offset:-2px; }
  .tline.extra[hidden] { display:none; }
  .tmeta { color:var(--dim); font-size:11.5px; margin-left:.6rem; }
  .tline.link { cursor:pointer; }
  .tline.link:hover { background:color-mix(in srgb, var(--sel) 14%, transparent); }
  /* Picking a layer dims the rest rather than hiding it: the point is *where in the whole tree* that
     layer sits, which is lost the moment everything else disappears. */
  .structure.filtering .tline:not(.on):not(.root) { opacity:.3; }
  .structure.filtering .lbox:not(.on) { opacity:.5; }

  .deck { border-left:3px solid var(--sel); margin-bottom:.9rem; }
  .deck a { color:var(--sel); }
  .steps { margin:.5rem 0 0; padding-left:1.3rem; font-size:13.5px; }
  .steps li { margin:.15rem 0; }
  kbd { font:11.5px ui-monospace,Menlo,Consolas,monospace; border:1px solid var(--line);
        border-radius:3px; padding:0 .25rem; background:var(--bg); }

  .comp { border:1px solid var(--line); border-radius:8px; padding:.8rem .9rem; margin-bottom:.9rem; }
  .comphead { display:flex; gap:1rem; align-items:flex-start; justify-content:space-between; margin-bottom:.5rem; }
  .comphead h3 { margin:0; font-size:.95rem; }
  .comphead p { margin:.15rem 0 0; }
  .comphead button { flex:0 0 auto; }

  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th, td { text-align:left; padding:.4rem .55rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:600; }
  tr.match { background:color-mix(in srgb, var(--sel) 12%, transparent); }
  /* The edge table carries the same two colours as the diagram, so a row and its arrow agree. */
  tr.up { background:color-mix(in srgb, var(--up) 14%, transparent); }
  tr.down { background:color-mix(in srgb, var(--down) 14%, transparent); }
  .chip { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:.4rem; vertical-align:baseline; }
  .chip.u { background:var(--up); }
  .chip.d { background:var(--down); }
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
    ${input.files && input.files.length > 0 ? `<span><b>${input.files.length}</b> SQL files</span>` : ""}
    ${orphans.length > 0 ? `<span><b>${orphans.length}</b> unconnected</span>` : ""}
  </div>

  <h2>Pipeline${collapsed ? " (grouped by schema — too many tables to draw individually)" : ""}</h2>
  <div class="toolbar">
    <button id="fit">Fit</button>
    <button id="zin">+</button>
    <button id="zout">−</button>
    <button id="clear">Clear selection</button>
  </div>
  <p class="hint"><strong>Click any box</strong> to light up its whole flow — every table upstream of it
  in one colour, everything downstream in another, and all the arrows between them — with the rest of the
  graph dimmed. Table names in the panel below are clickable too, so you can walk the chain a hop at a
  time. Drag to pan, scroll to zoom, Esc to clear.</p>
  <div class="stage" id="stage">
${renderSvg(layout, schemas)}
  </div>
  <div class="legend">${legend}</div>
  <div id="focuskey">
    <span class="fk r"><i></i>selected</span>
    <span class="fk u"><i></i>feeds it (upstream)</span>
    <span class="fk d"><i></i>it feeds (downstream)</span>
  </div>

  <div class="panel card" id="panel"><span class="empty">No table selected — click one in the diagram.</span></div>

${structure}
  <h2>Copy into Word or PowerPoint</h2>
  ${
    input.deckFile
      ? `<div class="card deck">
    <strong>The diagram above, as editable shapes: <a href="${escapeHtml(input.deckFile)}">${escapeHtml(
      input.deckFile
    )}</a></strong>
    <ol class="steps">
      <li>Open it — slide 1 is this whole pipeline, then one slide per hop.</li>
      <li>Click the slide and press <kbd>Ctrl</kbd>+<kbd>A</kbd>, then <kbd>Ctrl</kbd>+<kbd>C</kbd>.</li>
      <li>Paste into your Word document or your own deck.</li>
    </ol>
    <p class="dim small" style="margin:.4rem 0 0">
      Every box is a real shape and every arrow a real connector bound to the two boxes it joins — so
      click a title to retype it, drag a box and its arrows follow, recolour anything with the normal
      Shape Format tools. Nothing in it is a picture.
    </p>
  </div>`
      : `<p class="hint">
    For the <em>diagram</em> as editable shapes, run <code>reconcile diagrams</code> — it writes a .pptx
    whose every box is a real shape with editable text, plus one .svg per hop.
  </p>`
  }
  <p class="hint">
    <strong>Copy table</strong> below puts that section on the clipboard as a real table — paste it into
    Word or PowerPoint and every cell is editable text. There is deliberately no "copy the diagram"
    button: a browser can only put a <em>picture</em> of an SVG on the clipboard, so it would hand you
    dead text. That is what the deck above is for.
  </p>
  <div id="components">
${components.map((component, i) => componentBlock(component, i, input.notes)).join("\n")}
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

  // Selection is driven from the pointer sequence, not from a "click" listener on the boxes.
  //
  // Dragging to pan needs setPointerCapture so the gesture survives leaving the stage, but capture
  // retargets pointerup to the capturing element — and the click event is then dispatched to the
  // common ancestor of pointerdown and pointerup, which is the stage. A click listener on a node
  // therefore never fires at all, while the stage's own listener does. So the box under the press is
  // recorded at pointerdown and acted on at pointerup, which capture cannot move.
  var dragging = false, moved = false, sx = 0, sy = 0, downX = 0, downY = 0, pressed = null;

  stage.addEventListener("pointerdown", function (e) {
    dragging = true;
    moved = false;
    sx = e.clientX - view.x;
    sy = e.clientY - view.y;
    downX = e.clientX;
    downY = e.clientY;
    pressed = e.target && e.target.closest ? e.target.closest(".node") : null;
    stage.classList.add("grabbing");
    // Guarded: if capture is unavailable the gesture should degrade to not surviving the stage
    // edge, not throw out of the handler and take selection down with it.
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
  });

  stage.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    // Measured from where the press started, not from the last frame: comparing against the running
    // view offset only sees each frame's increment, so a slow drag never crosses the threshold and
    // is mistaken for a tap.
    if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) moved = true;
    view.x = e.clientX - sx;
    view.y = e.clientY - sy;
    apply();
  });

  stage.addEventListener("pointerup", function (e) {
    dragging = false;
    stage.classList.remove("grabbing");
    try { stage.releasePointerCapture(e.pointerId); } catch (err) {}
    if (!moved) tap(pressed);
    pressed = null;
  });

  stage.addEventListener("pointercancel", function () {
    dragging = false;
    stage.classList.remove("grabbing");
    pressed = null;
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

  var focusKey = document.getElementById("focuskey");

  function clearFocus() {
    selected = null;
    svg.classList.remove("focusing");
    focusKey.classList.remove("on");
    nodes.forEach(function (n) { n.classList.remove("up", "down", "root"); });
    edges.forEach(function (e) { e.classList.remove("up", "down"); });
    rows.forEach(function (r) { r.classList.remove("match", "up", "down"); });
    panel.innerHTML = '<span class="empty">No table selected — click one in the diagram.</span>';
  }

  function focus(id) {
    if (!ADJ[id]) return;
    selected = id;
    var up = reach(id, "up"), down = reach(id, "down");

    // An edge lights up only when *both* its ends sit on the same side of the selection, the root
    // counting for either. Testing the two ends against the merged set instead would light a
    // shortcut running from something upstream straight to something downstream — an edge that
    // never passes through the table whose flow is being traced.
    function side(node) {
      if (node === id) return "root";
      if (up[node]) return "up";
      if (down[node]) return "down";
      return null;
    }
    function edgeSide(f, t) {
      var a = side(f), b = side(t);
      if (!a || !b) return null;
      if (a === "up" || b === "up") return a !== "down" && b !== "down" ? "up" : null;
      if (a === "down" || b === "down") return "down";
      return null;
    }

    svg.classList.add("focusing");
    focusKey.classList.add("on");
    nodes.forEach(function (n) {
      var s = side(n.getAttribute("data-id"));
      n.classList.toggle("root", s === "root");
      n.classList.toggle("up", s === "up");
      n.classList.toggle("down", s === "down");
    });
    edges.forEach(function (e) {
      var s = edgeSide(e.getAttribute("data-from"), e.getAttribute("data-to"));
      e.classList.toggle("up", s === "up");
      e.classList.toggle("down", s === "down");
    });
    rows.forEach(function (r) {
      var s = edgeSide(r.getAttribute("data-from"), r.getAttribute("data-to"));
      r.classList.toggle("up", s === "up");
      r.classList.toggle("down", s === "down");
      r.classList.toggle("match", !!s);
    });

    var d = DETAIL[id] || { schema: "", files: [] };
    var ups = (ADJ[id].up || []).slice().sort();
    var downs = (ADJ[id].down || []).slice().sort();

    function esc(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    // Table names are links back into the diagram, so tracing a chain is a click per hop rather
    // than a hunt for the next box.
    function list(items, empty, chip) {
      if (!items.length) return '<span class="empty">' + esc(empty) + "</span>";
      return "<ul>" + items.map(function (x) {
        return '<li><span class="chip ' + chip + '"></span><a href="#" class="jump" data-id="' +
          esc(x) + '">' + esc(x) + "</a></li>";
      }).join("") + "</ul>";
    }
    function plain(items, empty) {
      if (!items.length) return '<span class="empty">' + esc(empty) + "</span>";
      return "<ul>" + items.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>";
    }

    panel.innerHTML =
      "<h3>" + esc(id) + "</h3>" +
      '<div class="cols">' +
        '<div><strong><span class="chip u"></span>Feeds from (' + ups.length + ")</strong>" +
          list(ups, "nothing — this is a source", "u") + "</div>" +
        '<div><strong><span class="chip d"></span>Feeds into (' + downs.length + ")</strong>" +
          list(downs, "nothing — this is an endpoint", "d") + "</div>" +
        "<div><strong>All upstream</strong> " + Object.keys(up).length +
          "<br><strong>All downstream</strong> " + Object.keys(down).length +
          "<br><strong>Schema</strong> " + esc(d.schema) + "</div>" +
        "<div><strong>Built in</strong>" + plain(d.files, "no writing statement found") + "</div>" +
      "</div>";
  }

  panel.addEventListener("click", function (e) {
    var link = e.target.closest ? e.target.closest("a.jump") : null;
    if (!link) return;
    e.preventDefault();
    focus(link.getAttribute("data-id"));
  });

  /** A press that didn't turn into a drag: a box selects it, empty stage clears. */
  function tap(node) {
    if (!node) { clearFocus(); return; }
    var id = node.getAttribute("data-id");
    if (id === selected) clearFocus(); else focus(id);
  }

  document.getElementById("clear").onclick = clearFocus;
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") clearFocus(); });

  // ---- project structure ------------------------------------------------
  // Two links, both one-way into what is already here: a layer box picks out its own folders, and a
  // file jumps to the table it builds in the diagram above. Neither introduces a second way of
  // dimming the graph — the file click goes through the same focus() the boxes use.
  var structure = document.getElementById("structure");
  if (structure) {
    var lboxes = Array.prototype.slice.call(structure.querySelectorAll(".lbox"));
    var tlines = Array.prototype.slice.call(structure.querySelectorAll(".tline[data-layer]"));
    var activeLayer = null;

    function showLayer(layer) {
      activeLayer = layer;
      structure.classList.toggle("filtering", layer !== null);
      lboxes.forEach(function (box) {
        box.classList.toggle("on", layer !== null && box.getAttribute("data-layer") === layer);
      });
      tlines.forEach(function (line) {
        line.classList.toggle("on", layer !== null && line.getAttribute("data-layer") === layer);
      });
    }

    lboxes.forEach(function (box) {
      function pick() {
        var layer = box.getAttribute("data-layer");
        showLayer(layer === activeLayer ? null : layer);
      }
      box.addEventListener("click", pick);
      box.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
      });
    });

    // "… N more files" stands for lines that are already here, collapsed, so opening it is a hidden
    // flag and two label swaps — no re-render, and nothing to fetch.
    function toggleMore(line) {
      var open = line.getAttribute("aria-expanded") === "true";
      var extras = structure.querySelectorAll('.tline.extra[data-more-of="' + line.getAttribute("data-more") + '"]');
      Array.prototype.forEach.call(extras, function (extra) { extra.hidden = open; });
      line.setAttribute("aria-expanded", open ? "false" : "true");
      line.querySelector(".tname").textContent = line.getAttribute(open ? "data-show" : "data-hide");
      line.querySelector(".tpre").textContent = line.getAttribute(open ? "data-pre-closed" : "data-pre-open");
    }

    structure.addEventListener("click", function (e) {
      var more = e.target.closest ? e.target.closest(".tline.more.toggle") : null;
      if (more) { toggleMore(more); return; }
      var line = e.target.closest ? e.target.closest(".tline.link") : null;
      if (!line) return;
      focus(line.getAttribute("data-focus"));
      stage.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    structure.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var more = e.target.closest ? e.target.closest(".tline.more.toggle") : null;
      if (!more) return;
      e.preventDefault();
      toggleMore(more);
    });
  }

  // ---- copy for Word / PowerPoint ---------------------------------------
  // Selecting the real table and copying the selection is what puts genuine text/html on the clipboard,
  // which is what Word turns into a native table. Building an HTML string and handing it to
  // navigator.clipboard.write() is the modern API but Firefox gates non-text ClipboardItem behind a
  // pref, so the selection path leads and the async API is the fallback rather than the reverse.
  function copyElement(el) {
    var selection = window.getSelection();
    var saved = selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
    var range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);

    var ok = false;
    try { ok = document.execCommand("copy"); } catch (err) { ok = false; }

    selection.removeAllRanges();
    if (saved) selection.addRange(saved);
    return ok;
  }

  function copyViaClipboardApi(el) {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") return Promise.resolve(false);
    var html = "<html><body>" + el.outerHTML + "</body></html>";
    return navigator.clipboard
      .write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([el.innerText || ""], { type: "text/plain" })
      })])
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  function flash(button, message, good) {
    var original = button.textContent;
    button.textContent = message;
    button.classList.toggle("done", !!good);
    setTimeout(function () { button.textContent = original; button.classList.remove("done"); }, 1800);
  }

  Array.prototype.slice.call(document.querySelectorAll("button.copy")).forEach(function (button) {
    button.addEventListener("click", function () {
      var table = document.getElementById(button.getAttribute("data-table"));
      if (!table) return;
      if (copyElement(table)) { flash(button, "Copied", true); return; }
      copyViaClipboardApi(table).then(function (ok) {
        flash(button, ok ? "Copied" : "Press Ctrl+C", ok);
        // Leaving the table selected means the keyboard shortcut finishes the job the button couldn't.
        if (!ok) {
          var range = document.createRange();
          range.selectNodeContents(table);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
        }
      });
    });
  });

  fit();
})();
</script>
</body>
</html>
`;

  return { html, collapsed };
}
