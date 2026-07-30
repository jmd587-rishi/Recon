import { strToU8, zipSync } from "fflate";
import {
  LABEL_COLOUR,
  NODE_H,
  NODE_W,
  SCHEMA_LABEL_COLOUR,
  edgeCurve,
  schemaColour,
  type DagNode
} from "./dagLayout.js";
import type { DiagramComponent } from "./diagramComponents.js";

/**
 * The lineage as a PowerPoint deck of native shapes — the one route where "copy it into Word and edit
 * the text" is true without qualification.
 *
 * Every table is a real `<p:sp>` rounded rectangle with a real text body, and every edge is a real
 * `<p:cxnSp>` connector *attached to the two shapes it joins* (`stCxn`/`endCxn`). Attaching them is the
 * point: drag a box on the slide and its arrows follow, because PowerPoint recomputes the route from
 * the connection sites rather than from the coordinates written here. A picture cannot do that, and
 * neither can an SVG converted to shapes, which arrives as unattached lines.
 *
 * The file is built from scratch rather than from a template, unlike `docxWriter.ts`. A .docx template
 * exists because the Word output has to match a house style — cover art, headers, numbering. A deck of
 * lineage diagrams has no such style to inherit, and generating the dozen boilerplate parts is less
 * work than shipping and maintaining a .pptx to graft slides into. `fflate` does the zipping, as it
 * does there.
 *
 * Shapes are laid out from `dagLayout`'s pixel coordinates, scaled to fit the slide. So a diagram
 * reviewed in `lineage.html` and the same diagram on a slide have their boxes in the same relative
 * places — the deck is the reviewed picture, not a second interpretation of the graph.
 */

/** 16:9 at 13.333in × 7.5in, the modern PowerPoint default. */
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;

const EMU_PER_IN = 914400;
/** CSS pixels are 96 to the inch, which is the unit `dagLayout` works in. */
const EMU_PER_PX = EMU_PER_IN / 96;

const MARGIN = Math.round(0.4 * EMU_PER_IN);
const TITLE_TOP = Math.round(0.28 * EMU_PER_IN);
const TITLE_H = Math.round(0.72 * EMU_PER_IN);
const GRAPH_TOP = TITLE_TOP + TITLE_H + Math.round(0.1 * EMU_PER_IN);
const LEGEND_H = Math.round(0.28 * EMU_PER_IN);

const AVAIL_W = SLIDE_W - MARGIN * 2;
const AVAIL_H = SLIDE_H - GRAPH_TOP - MARGIN - LEGEND_H;

/** Point sizes before scaling. OOXML wants hundredths of a point, so these are ×100 on the way out. */
const PT = { title: 20, subtitle: 11, node: 9.5, schema: 8, legend: 9, note: 12 };
/**
 * Below this a shrunken label is illegible anyway, so the diagram is left to overflow instead.
 *
 * 6 rather than 7 so the schema sub-label can still sit a step below the table name on a wide pipeline.
 * At a 7pt floor both clamped to the same size and the box lost its hierarchy.
 */
const MIN_PT = 6;

const FONT = "Calibri";
const MONO_FONT = "Consolas";

/** The first id a slide's own shapes may take — 1 is always the root group. */
const FIRST_SHAPE_ID = 2;

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Strips what XML 1.0 cannot carry, for the same reason `docxWriter.ts` does: a stray control byte in
 * a table name scanned off disk would make PowerPoint refuse to open the file, which is a far worse
 * failure than a missing character.
 */
const XML_ILLEGAL = new RegExp("[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]", "g");

function clean(text: string): string {
  return esc(text.replace(XML_ILLEGAL, ""));
}

/** `#b8863f` -> `B8863F`, the form `srgbClr` wants. */
function hex(colour: string): string {
  return colour.replace("#", "").toUpperCase();
}

function sz(points: number, scale: number): number {
  return Math.round(Math.max(MIN_PT, points * scale) * 100);
}

interface Placed {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

function xfrm(box: Placed, flip = ""): string {
  return (
    `<a:xfrm${flip}><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/>` +
    `<a:ext cx="${Math.max(0, Math.round(box.cx))}" cy="${Math.max(0, Math.round(box.cy))}"/></a:xfrm>`
  );
}

interface Run {
  text: string;
  points: number;
  colour: string;
  bold?: boolean;
  mono?: boolean;
}

function paragraph(run: Run, scale: number, align = "l"): string {
  return (
    `<a:p><a:pPr algn="${align}"/><a:r><a:rPr lang="en-US" sz="${sz(run.points, scale)}"` +
    `${run.bold ? ' b="1"' : ""} dirty="0"><a:solidFill><a:srgbClr val="${hex(run.colour)}"/></a:solidFill>` +
    `<a:latin typeface="${run.mono ? MONO_FONT : FONT}"/></a:rPr><a:t>${clean(run.text)}</a:t></a:r></a:p>`
  );
}

/** A borderless text box — the title, the subtitle and a note about an empty hop. */
function textBox(id: number, name: string, box: Placed, runs: Run[], scale: number, anchor = "t"): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${clean(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}">` +
    `<a:normAutofit/></a:bodyPr><a:lstStyle/>` +
    `${runs.map((run) => paragraph(run, scale)).join("")}</p:txBody></p:sp>`
  );
}

/**
 * One table as a rounded rectangle carrying two lines: the table name and its schema.
 *
 * `name` is the qualified table name so PowerPoint's selection pane is navigable — on a 40-box slide
 * that is the difference between finding a table and hunting for it.
 */
function nodeShape(id: number, node: DagNode, box: Placed, palette: string[], scale: number): string {
  const colour = schemaColour(palette, node.schema);
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${clean(node.qualified)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm(box)}<a:prstGeom prst="roundRect"><a:avLst>` +
    `<a:gd name="adj" fmla="val 14000"/></a:avLst></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${hex(colour.fill)}"/></a:solidFill>` +
    `<a:ln w="19050"><a:solidFill><a:srgbClr val="${hex(colour.stroke)}"/></a:solidFill></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr lIns="54864" tIns="18288" rIns="27432" bIns="18288" anchor="ctr" wrap="square">` +
    `<a:normAutofit/></a:bodyPr><a:lstStyle/>` +
    paragraph({ text: node.name, points: PT.node, colour: LABEL_COLOUR, bold: true }, scale) +
    paragraph({ text: node.schema, points: PT.schema, colour: SCHEMA_LABEL_COLOUR, mono: true }, scale) +
    `</p:txBody></p:sp>`
  );
}

/**
 * One edge as a connector bound to both shapes.
 *
 * `straightConnector1` for every edge — a direct line between the two attach points, with no adjust
 * handles at all. Curved presets (`curvedConnector3`, `bentConnector3`) each need some per-edge control
 * (an inflection point, a routed midpoint) to keep same-gutter arrows apart, and every attempt to drive
 * that control from the layout either bunched several arrows into one visual line or, when spread out
 * to avoid that, distorted the curve into an uneven swoop. A straight line has no such handle to fight:
 * its shape is just its two endpoints, so there is nothing left to distort.
 *
 * Two edges only run exactly on top of each other if they share the same source *and* the same target,
 * which never happens in a DAG — every other pair differs in row on at least one end, so it has a
 * different slope and stays visually distinct. Edges do still cross where flows genuinely cross (the
 * same crossings the HTML page's curves show, just drawn with straight segments), which is the "split
 * of flow" reading a lineage diagram is supposed to give.
 *
 * `idx="3"` is the right-hand connection site of `roundRect` and `idx="1"` the left-hand one, which is
 * what gives the curve its horizontal tangents and keeps every arrow flowing left to right.
 *
 * The line takes its **source table's schema colour** rather than the page's uniform grey. The page can
 * afford grey because clicking a table dims everything off its path; a slide has no focus mode, so the
 * only thing that can tell two crossing arrows apart is how they look. Colouring by where an arrow comes
 * *from* means a bundle converging on one table is visibly several different inputs.
 *
 * The `xfrm` written here is the initial route only; PowerPoint recomputes it from the connection sites
 * as soon as either shape moves. It still has to be right, or the arrow is drawn wrong until something
 * is dragged.
 */
function connector(
  id: number,
  fromId: number,
  toId: number,
  from: DagNode,
  to: DagNode,
  place: Placer,
  palette: string[]
): string {
  const c = edgeCurve(from, to);
  const start = place.point(c.x1, c.y1);
  const end = place.point(c.x2, c.y2);

  const flip = `${end.x < start.x ? ' flipH="1"' : ""}${end.y < start.y ? ' flipV="1"' : ""}`;
  const box: Placed = {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    cx: Math.abs(end.x - start.x),
    cy: Math.abs(end.y - start.y)
  };

  return (
    `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${clean(`${from.qualified} to ${to.qualified}`)}"/>` +
    `<p:cNvCxnSpPr><a:stCxn id="${fromId}" idx="3"/><a:endCxn id="${toId}" idx="1"/></p:cNvCxnSpPr>` +
    `<p:nvPr/></p:nvCxnSpPr>` +
    `<p:spPr>${xfrm(box, flip)}<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>` +
    `<a:ln w="12700"><a:solidFill><a:srgbClr val="${hex(schemaColour(palette, from.schema).stroke)}"/></a:solidFill>` +
    `<a:tailEnd type="triangle" w="med" len="med"/></a:ln></p:spPr></p:cxnSp>`
  );
}

function legendShape(id: number, schema: string, box: Placed, palette: string[], scale: number): string {
  const colour = schemaColour(palette, schema);
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${clean(`Legend ${schema}`)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm(box)}<a:prstGeom prst="roundRect"><a:avLst>` +
    `<a:gd name="adj" fmla="val 18000"/></a:avLst></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${hex(colour.fill)}"/></a:solidFill>` +
    `<a:ln w="19050"><a:solidFill><a:srgbClr val="${hex(colour.stroke)}"/></a:solidFill></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr lIns="45720" tIns="0" rIns="45720" bIns="0" anchor="ctr" wrap="none">` +
    `<a:normAutofit/></a:bodyPr><a:lstStyle/>` +
    paragraph({ text: schema, points: PT.legend, colour: SCHEMA_LABEL_COLOUR, mono: true }, scale, "ctr") +
    `</p:txBody></p:sp>`
  );
}

/**
 * Maps `dagLayout`'s pixel space onto the slide, scaling down only when the graph is too big.
 *
 * Never scaling *up*: a two-table hop blown up to fill a slide looks like a mistake, and the boxes
 * would no longer match the other slides' boxes in size.
 */
class Placer {
  readonly scale: number;
  private readonly offsetX: number;
  private readonly offsetY: number;

  constructor(width: number, height: number) {
    this.scale = Math.min(1, AVAIL_W / (width * EMU_PER_PX), AVAIL_H / (height * EMU_PER_PX));
    const drawnW = width * EMU_PER_PX * this.scale;
    const drawnH = height * EMU_PER_PX * this.scale;
    this.offsetX = MARGIN + Math.max(0, (AVAIL_W - drawnW) / 2);
    this.offsetY = GRAPH_TOP + Math.max(0, (AVAIL_H - drawnH) / 2);
  }

  point(px: number, py: number): { x: number; y: number } {
    return { x: this.offsetX + px * EMU_PER_PX * this.scale, y: this.offsetY + py * EMU_PER_PX * this.scale };
  }

  box(px: number, py: number, pw: number, ph: number): Placed {
    const { x, y } = this.point(px, py);
    return { x, y, cx: pw * EMU_PER_PX * this.scale, cy: ph * EMU_PER_PX * this.scale };
  }
}

function slideXml(component: DiagramComponent): string {
  const place = new Placer(Math.max(component.layout.width, 1), Math.max(component.layout.height, 1));
  const shapes: string[] = [];
  let id = FIRST_SHAPE_ID;

  shapes.push(
    textBox(
      id++,
      "Title",
      { x: MARGIN, y: TITLE_TOP, cx: AVAIL_W, cy: TITLE_H },
      [
        { text: component.title, points: PT.title, colour: LABEL_COLOUR, bold: true },
        { text: component.subtitle, points: PT.subtitle, colour: SCHEMA_LABEL_COLOUR }
      ],
      // Titles are not scaled with the graph — a dense slide should not also have a small heading.
      1
    )
  );

  if (component.emptyReason) {
    shapes.push(
      textBox(
        id++,
        "Note",
        { x: MARGIN, y: GRAPH_TOP, cx: AVAIL_W, cy: Math.round(1.2 * EMU_PER_IN) },
        [{ text: component.emptyReason, points: PT.note, colour: SCHEMA_LABEL_COLOUR }],
        1
      )
    );
  } else {
    // Shapes first, then connectors: a connector's `stCxn`/`endCxn` names a shape id, and keeping the
    // ids assigned in this order means the pass below can look each one up as it goes.
    const shapeIds = new Map<string, number>();
    for (const node of component.layout.nodes) {
      const nodeId = id++;
      shapeIds.set(node.id, nodeId);
      shapes.push(nodeShape(nodeId, node, place.box(node.x, node.y, NODE_W, NODE_H), component.palette, place.scale));
    }

    const byId = new Map(component.layout.nodes.map((node) => [node.id, node]));
    for (const edge of component.layout.edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      const fromId = shapeIds.get(edge.from);
      const toId = shapeIds.get(edge.to);
      if (!from || !to || fromId === undefined || toId === undefined) continue;
      shapes.push(connector(id++, fromId, toId, from, to, place, component.palette));
    }
  }

  let legendX = MARGIN;
  const legendY = SLIDE_H - MARGIN - LEGEND_H;
  for (const schema of component.schemas) {
    const cx = Math.round((0.16 + schema.length * 0.075) * EMU_PER_IN);
    if (legendX + cx > SLIDE_W - MARGIN) break;
    shapes.push(legendShape(id++, schema, { x: legendX, y: legendY, cx, cy: LEGEND_H }, component.palette, 1));
    legendX += cx + Math.round(0.08 * EMU_PER_IN);
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join(
    ""
  )}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

// ---- the boilerplate parts ----

const ACCENTS = ["4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"];

function themeXml(): string {
  const accents = ACCENTS.map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`).join("");
  const line = (w: number) =>
    `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>`;
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Recon"><a:themeElements><a:clrScheme name="Recon"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>${accents}<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Recon"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Recon"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${line(
    6350
  )}${line(12700)}${line(19050)}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}

const EMPTY_TREE =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function slideMasterXml(): string {
  const map =
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
    'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${NS}><p:cSld>${EMPTY_TREE}</p:cSld>${map}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
}

function slideLayoutXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function presentationXml(slideCount: number): string {
  const ids = Array.from({ length: slideCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/></p:presentation>`;
}

const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function rels(entries: { id: string; type: string; target: string }[]): string {
  const items = entries
    .map((e) => `<Relationship Id="${e.id}" Type="${REL_BASE}/${e.type}" Target="${e.target}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships ${REL_NS}>${items}</Relationships>`;
}

function contentTypesXml(slideCount: number): string {
  const pml = "application/vnd.openxmlformats-officedocument.presentationml";
  const slides = Array.from(
    { length: slideCount },
    (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${pml}.slide+xml"/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="${pml}.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${pml}.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${pml}.slideLayout+xml"/>${slides}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
}

function coreXml(title: string, generatedAt: Date): string {
  const stamp = generatedAt.toISOString().replace(/\.\d{3}Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${clean(
    title
  )}</dc:title><dc:creator>Recon</dc:creator><cp:lastModifiedBy>Recon</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`;
}

function appXml(titles: string[]): string {
  const ep = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
  const vt = "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";
  const parts = titles.map((t) => `<vt:lpstr>${clean(t)}</vt:lpstr>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="${ep}" xmlns:vt="${vt}"><Application>Recon</Application><Slides>${titles.length}</Slides><TitlesOfParts><vt:vector size="${titles.length}" baseType="lpstr">${parts}</vt:vector></TitlesOfParts></Properties>`;
}

export interface PptxMeta {
  /** Deck title, stored as `dc:title`. */
  title: string;
  generatedAt?: Date;
}

/**
 * One slide per component, in the order given — the overview, then a hop at a time.
 *
 * Returns the bytes; the caller decides where they land, as everything else in `services/` does.
 */
export function buildPptx(components: DiagramComponent[], meta: PptxMeta): Uint8Array {
  if (components.length === 0) {
    throw new Error("A .pptx needs at least one slide, and no diagram components were given.");
  }

  const generatedAt = meta.generatedAt ?? new Date();
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, xml: string) => {
    files[path] = strToU8(xml);
  };

  put("[Content_Types].xml", contentTypesXml(components.length));
  put("_rels/.rels", rels([
    { id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" },
    { id: "rId2", type: "metadata/core-properties", target: "docProps/core.xml" },
    { id: "rId3", type: "extended-properties", target: "docProps/app.xml" }
  ]));
  put("docProps/core.xml", coreXml(meta.title, generatedAt));
  put("docProps/app.xml", appXml(components.map((c) => c.title)));

  put("ppt/presentation.xml", presentationXml(components.length));
  put(
    "ppt/_rels/presentation.xml.rels",
    rels([
      { id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
      ...components.map((_, i) => ({
        id: `rId${i + 2}`,
        type: "slide",
        target: `slides/slide${i + 1}.xml`
      })),
      { id: `rId${components.length + 2}`, type: "theme", target: "theme/theme1.xml" }
    ])
  );

  put("ppt/theme/theme1.xml", themeXml());
  put("ppt/slideMasters/slideMaster1.xml", slideMasterXml());
  put(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    rels([
      { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: "theme", target: "../theme/theme1.xml" }
    ])
  );
  put("ppt/slideLayouts/slideLayout1.xml", slideLayoutXml());
  put(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }])
  );

  components.forEach((component, i) => {
    put(`ppt/slides/slide${i + 1}.xml`, slideXml(component));
    put(
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      rels([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }])
    );
  });

  return zipSync(files, { level: 6 });
}