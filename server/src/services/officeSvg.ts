import {
  EDGE_COLOUR,
  LABEL_COLOUR,
  NODE_H,
  NODE_W,
  SCHEMA_LABEL_COLOUR,
  edgeCurve,
  schemaColour,
  truncate,
  type DagNode
} from "./dagLayout.js";
import type { DiagramComponent } from "./diagramComponents.js";

/**
 * One component as a standalone `.svg` that Word and PowerPoint can turn into editable shapes.
 *
 * This is deliberately *not* the SVG in `lineageDiagram.ts`. That one is styled for a browser and uses
 * four things Office's importer does not implement: CSS custom properties (`var(--nc)`), `color-mix()`,
 * classes defined in the surrounding page's `<style>`, and `<marker>` arrowheads. Imported into Word it
 * comes through as uncoloured boxes with no arrows, because every one of those resolves to nothing.
 *
 * So this renderer keeps to the subset Office actually reads:
 *   - every colour a literal hex, on the element, as a presentation attribute — no stylesheet at all;
 *   - arrowheads as explicit polygons, rotated onto the curve's arrival tangent, not markers;
 *   - one `<text>` per line with an explicit baseline `y`, no `dominant-baseline` and no nested
 *     `<tspan>` positioning, which is what keeps the text importable *as text* rather than as outlines;
 *   - a common font stack, since the shape Office builds inherits the font name it is given.
 *
 * The usable path in Office is Insert ▸ Pictures ▸ this file, then right-click ▸ Graphic ▸ Convert to
 * Shape. That yields a native group: boxes you can drag and recolour, text you can retype. Whether the
 * *text* survives as text depends on the Office build, which is the one thing this cannot guarantee —
 * `pptxWriter.ts` exists because that guarantee was wanted.
 */

/** Office resolves a font *name*, not a stack, so the first entry is what the shape will carry. */
const FONT = "Calibri, Segoe UI, sans-serif";
const MONO_FONT = "Consolas, Courier New, monospace";

const TITLE_SIZE = 17;
const SUBTITLE_SIZE = 11;
const NODE_LABEL_SIZE = 12.5;
const NODE_SCHEMA_SIZE = 10.5;
const LEGEND_SIZE = 11;

const HEADER_H = 62;
const LEGEND_H = 30;
/** Room for the wrapped note a hop with no lineage carries instead of a graph. */
const NOTE_LINE_H = 17;
const MARGIN = 18;
const ARROW = 8;

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Trims trailing zeros so the file stays readable and Office parses fewer digits. */
function n(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function text(
  content: string,
  x: number,
  y: number,
  opts: { size: number; fill: string; weight?: number; mono?: boolean }
): string {
  return (
    `<text x="${n(x)}" y="${n(y)}" font-family="${opts.mono ? MONO_FONT : FONT}" font-size="${n(opts.size)}"` +
    `${opts.weight ? ` font-weight="${opts.weight}"` : ""} fill="${opts.fill}">${esc(content)}</text>`
  );
}

/**
 * The arrowhead, as a triangle rotated onto the direction the curve arrives from.
 *
 * `transform="rotate(...)"` rather than three computed vertices: Office reads a rotate transform, and
 * keeping the polygon axis-aligned in its own space means the shape it converts to is a clean triangle
 * rather than a freeform with rounding noise in its points.
 */
function arrowhead(x: number, y: number, angleDeg: number): string {
  const half = n(ARROW / 2.2);
  const points = `0,0 -${ARROW},-${half} -${ARROW},${half}`;
  return (
    `<polygon points="${points}" fill="${EDGE_COLOUR}" ` +
    `transform="translate(${n(x)},${n(y)}) rotate(${n(angleDeg)})"/>`
  );
}

function renderEdges(component: DiagramComponent, offsetY: number): string {
  const byId = new Map(component.layout.nodes.map((node) => [node.id, node]));

  return component.layout.edges
    .flatMap((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return [];

      const c = edgeCurve(shift(from, offsetY), shift(to, offsetY));
      // The tangent at the end of a cubic runs from its second control point to its endpoint. Pull the
      // head back along it so the triangle's tip lands on the box edge instead of overshooting it.
      const angle = (Math.atan2(c.y2 - c.c2y, c.x2 - c.c2x) * 180) / Math.PI;

      return [
        `<path d="M${n(c.x1)},${n(c.y1)} C${n(c.c1x)},${n(c.c1y)} ${n(c.c2x)},${n(c.c2y)} ${n(c.x2)},${n(c.y2)}" ` +
          `fill="none" stroke="${EDGE_COLOUR}" stroke-width="1.5"/>`,
        arrowhead(c.x2, c.y2, angle)
      ];
    })
    .join("\n    ");
}

function shift(node: DagNode, offsetY: number): DagNode {
  return { ...node, y: node.y + offsetY };
}

function renderNodes(component: DiagramComponent, offsetY: number): string {
  return component.layout.nodes
    .map((node) => {
      const colour = schemaColour(component.palette, node.schema);
      const y = node.y + offsetY;
      return (
        `<g>` +
        `<rect x="${n(node.x)}" y="${n(y)}" width="${NODE_W}" height="${NODE_H}" rx="7" ry="7" ` +
        `fill="${colour.fill}" stroke="${colour.stroke}" stroke-width="1.5"/>` +
        text(node.label, node.x + 11, y + 16, { size: NODE_LABEL_SIZE, fill: LABEL_COLOUR, weight: 600 }) +
        text(truncate(node.schema, 28), node.x + 11, y + 29, {
          size: NODE_SCHEMA_SIZE,
          fill: SCHEMA_LABEL_COLOUR,
          mono: true
        }) +
        `</g>`
      );
    })
    .join("\n    ");
}

function renderLegend(component: DiagramComponent, y: number): string {
  let x = MARGIN;
  return component.schemas
    .map((schema) => {
      const colour = schemaColour(component.palette, schema);
      const swatch =
        `<rect x="${n(x)}" y="${n(y - 9)}" width="11" height="11" rx="2" ry="2" ` +
        `fill="${colour.fill}" stroke="${colour.stroke}" stroke-width="1.5"/>` +
        text(schema, x + 17, y, { size: LEGEND_SIZE, fill: SCHEMA_LABEL_COLOUR, mono: true });
      // Advanced by a monospace estimate rather than measured text — there is no font metric available
      // here, and a legend that is slightly loosely spaced is not worth a measuring pass.
      x += 17 + schema.length * 6.4 + 20;
      return swatch;
    })
    .join("\n    ");
}

/** Breaks a note into lines short enough for the component's width. */
function wrapNote(note: string, width: number): string[] {
  const perLine = Math.max(20, Math.floor((width - MARGIN * 2) / 6.6));
  const lines: string[] = [];
  let line = "";
  for (const word of note.split(/\s+/).filter(Boolean)) {
    if (line.length > 0 && line.length + word.length + 1 > perLine) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * `width`/`height` are set in absolute px as well as a `viewBox`, because Office sizes the imported
 * graphic from the attributes and a viewBox-only SVG lands at an arbitrary default size.
 */
export function renderOfficeSvg(component: DiagramComponent): string {
  const graphW = Math.max(component.layout.width, 420);
  const width = Math.max(graphW, MARGIN * 2 + 320);

  const noteLines = component.emptyReason ? wrapNote(component.emptyReason, width) : [];
  const graphH = component.emptyReason ? noteLines.length * NOTE_LINE_H + 10 : component.layout.height;
  const graphTop = HEADER_H;
  const legendY = graphTop + graphH + 20;
  const height = legendY + (component.schemas.length > 0 ? LEGEND_H : 0);

  const body = component.emptyReason
    ? noteLines
        .map((line, i) =>
          text(line, MARGIN, graphTop + 16 + i * NOTE_LINE_H, { size: SUBTITLE_SIZE, fill: SCHEMA_LABEL_COLOUR })
        )
        .join("\n    ")
    : `${renderEdges(component, graphTop)}\n    ${renderNodes(component, graphTop)}`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(
    width
  )} ${n(height)}">
  <title>${esc(component.title)}</title>
  <desc>${esc(component.subtitle)}</desc>
  <rect x="0" y="0" width="${n(width)}" height="${n(height)}" fill="#ffffff"/>
  <g>
    ${text(component.title, MARGIN, 26, { size: TITLE_SIZE, fill: LABEL_COLOUR, weight: 700 })}
    ${text(component.subtitle, MARGIN, 45, { size: SUBTITLE_SIZE, fill: SCHEMA_LABEL_COLOUR })}
    ${body}
    ${component.schemas.length > 0 ? renderLegend(component, legendY) : ""}
  </g>
</svg>
`;
}
