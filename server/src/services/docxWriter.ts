import { strToU8, strFromU8, unzipSync, zipSync } from "fflate";
import type { DocBlock, DocDocument, DocTableColumn, DocTocEntry } from "./docModel.js";

/**
 * Renders a `DocDocument` into the branded Word template, keeping the template as the authority on
 * how the result looks.
 *
 * A .docx is a zip of XML parts. Rather than write one from scratch — which would mean reinventing the
 * cover art, the header and footer logos, the theme, the heading numbering and the table style — this
 * takes the template apart, replaces the *body* of `word/document.xml` with generated content, and
 * puts every other part back byte for byte. So the styles referenced below (`Heading1`, `Bullet`,
 * `Style1`, `TOC1`) are the template's own: change the template's look and the generated document
 * follows, with no code change here.
 *
 * Three things are edited outside the body, all of them consequences of generating the document:
 * `docProps/core.xml` (the cover-page title is a content control bound to `dc:title`, so the property
 * and the visible text have to agree), `word/settings.xml` (`updateFields`, so Word replaces the
 * static table of contents with a real one on open), and the cover paragraph's own placeholder text.
 */

/** The template's style ids, by the block that uses them. Nothing else here hard-codes a style name. */
const STYLE = {
  heading: ["Heading1", "Heading2", "Heading3", "Heading4"] as const,
  bullet: ["Bullet", "SubBullet", "Subsubbullet"] as const,
  numbered: "Listnumber1",
  quote: "Quote",
  table: "Style1",
  toc: ["TOC1", "TOC2"] as const,
  tocHeading: "TOCHeading"
} as const;

/** Usable text width in twips: A4 (11906) less the template's 994-twip side margins. */
const CONTENT_WIDTH_TWIPS = 9918;

/** EMU (English Metric Units) is what `<wp:extent>` measures in; 1 px at 96dpi is 9525 of them. */
const EMU_PER_PX = 9525;
/** 1 twip is 635 EMU, so the page's usable width caps how wide an inline picture can render. */
const MAX_IMAGE_WIDTH_EMU = CONTENT_WIDTH_TWIPS * 635;

/** Where an image block's relationship lands once assigned, so `renderBlock` doesn't invent one. */
type ImageRelId = { rId: string; docPrId: number };

/** Placeholder text on the template's cover page, replaced with the real title. */
const TITLE_PLACEHOLDER = "Document Title";
const SUBTITLE_PLACEHOLDER = "Document Subtitle";

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Strips characters XML 1.0 cannot carry at all.
 *
 * Model prose won't contain them, but SQL pulled out of a file scanned off disk can — a stray control
 * byte in a comment is enough to make Word refuse to open the document, and refusing to open is a far
 * worse failure than a missing character.
 */
const XML_ILLEGAL = new RegExp("[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]", "g");

function sanitize(text: string): string {
  return text.replace(XML_ILLEGAL, "");
}

/** One or more runs for `text`, with newlines rendered as line breaks inside the paragraph. */
function runs(text: string, props = ""): string {
  const rPr = props ? `<w:rPr>${props}</w:rPr>` : "";
  return sanitize(text)
    .split(/\r?\n/)
    .map((line, i) => `<w:r>${rPr}${i > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`)
    .join("");
}

function paragraph(text: string, style: string | null, props = "", runProps = ""): string {
  const pPr = `${style ? `<w:pStyle w:val="${style}"/>` : ""}${props}`;
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${text.length > 0 ? runs(text, runProps) : ""}</w:p>`;
}

const MONO_RUN_PROPS = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="17"/>';
const HEADER_RUN_PROPS = '<w:b/><w:color w:val="FFFFFF" w:themeColor="background1"/>';
const TIGHT_SPACING = '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>';

/** Column widths in fiftieths of a percent, which is how `w:tcW`/`w:type="pct"` measures them. */
function columnWidths(columns: DocTableColumn[]): number[] {
  const declared = columns.reduce((sum, c) => sum + (c.widthPct ?? 0), 0);
  const undeclared = columns.filter((c) => c.widthPct === undefined).length;
  const share = undeclared > 0 ? Math.max(5, (100 - declared) / undeclared) : 0;
  return columns.map((c) => Math.round((c.widthPct ?? share) * 50));
}

function tableCell(text: string, widthPct50: number, mono: boolean, header = false): string {
  const runProps = `${header ? HEADER_RUN_PROPS : ""}${mono ? MONO_RUN_PROPS : ""}`;
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${widthPct50}" w:type="pct"/></w:tcPr>` +
    paragraph(text, null, TIGHT_SPACING, runProps) +
    "</w:tc>"
  );
}

/**
 * A table in the template's own `Style1` — branded header row, hairline rules between rows.
 *
 * The header row carries `cnfStyle` and `tblHeader`: the first says "this is the first row" so the
 * style's `firstRow` formatting applies, the second repeats it at the top of every page the table
 * spans, which a 60-row lineage listing certainly will.
 */
function renderTable(columns: DocTableColumn[], rows: string[][]): string {
  const widths = columnWidths(columns);
  const grid = widths
    .map((w) => `<w:gridCol w:w="${Math.round((w / 5000) * CONTENT_WIDTH_TWIPS)}"/>`)
    .join("");

  const headerRow =
    '<w:tr><w:trPr><w:cnfStyle w:val="100000000000" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:oddVBand="0" w:evenVBand="0" w:oddHBand="0" w:evenHBand="0" w:firstRowFirstColumn="0" w:firstRowLastColumn="0" w:lastRowFirstColumn="0" w:lastRowLastColumn="0"/><w:tblHeader/><w:trHeight w:val="397"/></w:trPr>' +
    columns.map((c, i) => tableCell(c.header, widths[i], false, true)).join("") +
    "</w:tr>";

  const bodyRows = rows
    .map(
      (row) =>
        "<w:tr>" +
        columns.map((c, i) => tableCell(row[i] ?? "", widths[i], c.mono === true)).join("") +
        "</w:tr>"
    )
    .join("");

  return (
    "<w:tbl><w:tblPr>" +
    `<w:tblStyle w:val="${STYLE.table}"/><w:tblW w:w="5000" w:type="pct"/>` +
    '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
    `</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>` +
    // Word needs a paragraph after a table: without one, two adjacent tables merge into one.
    paragraph("", null, TIGHT_SPACING)
  );
}

/**
 * A real Word TOC field whose *result* is the headings we already know about.
 *
 * Written as a complex field spanning several paragraphs — begin/instruction/separate in the first,
 * the entries as `TOC1`/`TOC2` paragraphs, end in the last — so the document is readable as-is, and
 * refreshing the field (which `updateFields` asks Word to do on open) replaces these entries with the
 * same list plus page numbers.
 */
function renderToc(entries: DocTocEntry[]): string {
  const begin =
    '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
  const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';

  if (entries.length === 0) {
    return `<w:p><w:pPr><w:pStyle w:val="${STYLE.toc[0]}"/></w:pPr>${begin}${runs("(no sections)")}${end}</w:p>`;
  }

  return entries
    .map((entry, i) => {
      const style = STYLE.toc[entry.level - 1] ?? STYLE.toc[1];
      const content =
        (i === 0 ? begin : "") + runs(entry.text) + (i === entries.length - 1 ? end : "");
      return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${content}</w:p>`;
    })
    .join("");
}

/**
 * An inline picture, centred in its own paragraph, scaled down to the page's content width when the
 * rendered diagram is wider than that — Word does not do this itself, it just overflows the margin.
 */
function imageParagraph(rel: ImageRelId, widthPx: number, heightPx: number, altText: string): string {
  let wEmu = widthPx * EMU_PER_PX;
  let hEmu = heightPx * EMU_PER_PX;
  if (wEmu > MAX_IMAGE_WIDTH_EMU) {
    const scale = MAX_IMAGE_WIDTH_EMU / wEmu;
    wEmu = Math.round(wEmu * scale);
    hEmu = Math.round(hEmu * scale);
  }
  const alt = escapeXml(sanitize(altText));
  const drawing =
    '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${wEmu}" cy="${hEmu}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${rel.docPrId}" name="Picture ${rel.docPrId}" descr="${alt}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:nvPicPr><pic:cNvPr id="${rel.docPrId}" name="Picture ${rel.docPrId}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rel.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>";
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r>${drawing}</w:r></w:p>`;
}

function renderBlock(block: DocBlock, imageRels: Map<DocBlock, ImageRelId>): string {
  switch (block.kind) {
    case "heading":
      return paragraph(
        block.text,
        block.unnumbered && block.level === 1 ? STYLE.tocHeading : STYLE.heading[block.level - 1]
      );
    case "para":
      return paragraph(block.text, block.style === "Quote" ? STYLE.quote : null);
    case "bullet":
      return paragraph(block.text, STYLE.bullet[block.level - 1]);
    case "numbered":
      return paragraph(block.text, STYLE.numbered);
    case "table":
      return renderTable(block.columns, block.rows);
    case "code":
      return paragraph(
        block.text,
        null,
        `${TIGHT_SPACING}<w:shd w:val="clear" w:color="auto" w:fill="F4F4F6"/><w:ind w:left="113" w:right="113"/>`,
        MONO_RUN_PROPS
      );
    case "toc":
      return renderToc(block.entries);
    case "pageBreak":
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    case "image": {
      const rel = imageRels.get(block);
      return rel ? imageParagraph(rel, block.widthPx, block.heightPx, block.altText) : "";
    }
  }
}

/** The generated `<w:body>` content — everything between the template's cover page and its `sectPr`. */
export function renderDocumentBody(blocks: DocBlock[], imageRels: Map<DocBlock, ImageRelId> = new Map()): string {
  return blocks.map((block) => renderBlock(block, imageRels)).join("");
}

/** The highest numeric `rId` already used in a relationships part, so new ones don't collide. */
function highestRelId(relsXml: string): number {
  let max = 0;
  const pattern = /Id="rId(\d+)"/g;
  for (let match = pattern.exec(relsXml); match !== null; match = pattern.exec(relsXml)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

/** Appends image relationships to `word/_rels/document.xml.rels`, keeping every existing one intact. */
function addImageRelationships(relsXml: string, images: { rId: string; target: string }[]): string {
  const entries = images
    .map(
      (img) =>
        `<Relationship Id="${img.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${img.target}"/>`
    )
    .join("");
  return relsXml.replace("</Relationships>", `${entries}</Relationships>`);
}

/**
 * Assigns each `image` block its own relationship id and media part, so `renderDocumentBody` can
 * reference a real `r:embed` instead of inventing one mid-render.
 */
function prepareImageRelationships(
  blocks: DocBlock[],
  existingRelsXml: string
): { imageRels: Map<DocBlock, ImageRelId>; relsAdditions: { rId: string; target: string }[]; media: Record<string, Uint8Array> } {
  const imageRels = new Map<DocBlock, ImageRelId>();
  const relsAdditions: { rId: string; target: string }[] = [];
  const media: Record<string, Uint8Array> = {};

  let nextId = highestRelId(existingRelsXml) + 1;
  let index = 0;
  for (const block of blocks) {
    if (block.kind !== "image") continue;
    index += 1;
    const rId = `rId${nextId++}`;
    const target = `media/recon-diagram-${index}.png`;
    imageRels.set(block, { rId, docPrId: index });
    relsAdditions.push({ rId, target });
    media[`word/${target}`] = block.png;
  }

  return { imageRels, relsAdditions, media };
}

/** Where the template's own content ends and generated content begins. */
interface TemplateShell {
  /** Everything up to and including `<w:body>`. */
  head: string;
  /** The cover page: the paragraphs before the first section break, that break included. */
  cover: string;
  /** The final `<w:sectPr>`, which is what references the page size, headers and footers. */
  sectPr: string;
}

/**
 * Splits the body into its direct children, so an element can be kept or dropped whole.
 *
 * Hand-written rather than done with an XML parser for the same reason `sqlColumns.ts` scans SQL by
 * hand: what is needed is one narrow question — where does this element end — and the answer has to
 * preserve the bytes exactly, which a parse-and-serialise round trip through a general XML library
 * would not. Nesting of the same tag name is counted (a `w:p` inside a textbox inside a `w:p` is why
 * this cannot be a search for the next `</w:p>`), and self-closing tags are not counted as opening one.
 */
function topLevelChildren(body: string): { tag: string; xml: string }[] {
  const children: { tag: string; xml: string }[] = [];
  let cursor = 0;

  while (cursor < body.length) {
    const open = body.indexOf("<", cursor);
    if (open < 0) break;

    const name = /^<([A-Za-z_][\w.:-]*)/.exec(body.slice(open, open + 64));
    if (!name) {
      cursor = open + 1;
      continue;
    }
    const tag = name[1];
    const openEnd = body.indexOf(">", open);
    if (openEnd < 0) break;

    if (body[openEnd - 1] === "/") {
      children.push({ tag, xml: body.slice(open, openEnd + 1) });
      cursor = openEnd + 1;
      continue;
    }

    const boundary = new RegExp(`<${tag}(?=[\\s>/])|</${tag}>`, "g");
    boundary.lastIndex = open;
    let depth = 0;
    let end = -1;
    for (let match = boundary.exec(body); match !== null; match = boundary.exec(body)) {
      if (match[0].startsWith("</")) {
        depth--;
        if (depth === 0) {
          end = match.index + match[0].length;
          break;
        }
      } else {
        const tagEnd = body.indexOf(">", match.index);
        if (tagEnd > 0 && body[tagEnd - 1] === "/") continue;
        depth++;
      }
    }

    const childEnd = end < 0 ? body.length : end;
    children.push({ tag, xml: body.slice(open, childEnd) });
    cursor = childEnd;
  }

  return children;
}

/**
 * Splits the template's `document.xml` into the parts worth keeping.
 *
 * The cover page is found by its section break: a paragraph carrying a `w:sectPr` in its properties is
 * the last paragraph of a section, and the first such paragraph in the body is the end of the cover.
 * Everything between there and the trailing `sectPr` is the template's style showcase — placeholder
 * headings, bullets and a demo table — which is exactly what the generated content replaces.
 */
export function splitTemplate(documentXml: string): TemplateShell {
  const bodyOpen = documentXml.indexOf("<w:body>");
  const bodyClose = documentXml.lastIndexOf("</w:body>");
  if (bodyOpen < 0 || bodyClose < 0) {
    throw new Error("The template's word/document.xml has no <w:body> — it may not be a Word document.");
  }

  const head = documentXml.slice(0, bodyOpen + "<w:body>".length);
  const children = topLevelChildren(documentXml.slice(bodyOpen + "<w:body>".length, bodyClose));

  // Only a paragraph counts as the cover boundary. The document's own trailing `w:sectPr` also
  // contains that string, and taking it as the boundary would keep the entire template body.
  const coverEnd = children.findIndex((child) => child.tag === "w:p" && child.xml.includes("<w:sectPr"));
  const cover = coverEnd >= 0 ? children.slice(0, coverEnd + 1).map((child) => child.xml).join("") : "";

  const last = children[children.length - 1];
  const sectPr = last && last.tag === "w:sectPr" ? last.xml : "";

  return { head, cover, sectPr };
}

/** Puts the real title on the cover page, where the template has its placeholder text. */
function fillCover(cover: string, doc: DocDocument): string {
  return cover
    .split(TITLE_PLACEHOLDER)
    .join(escapeXml(sanitize(doc.title)))
    .split(SUBTITLE_PLACEHOLDER)
    .join(escapeXml(sanitize(doc.subtitle)));
}

/** Replaces one element's text content, keeping its attributes. Leaves the part alone if it has no such element. */
function replaceTag(xml: string, tag: string, value: string): string {
  const pattern = new RegExp(`(<${tag}(?:\\s[^>]*)?>)[\\s\\S]*?(</${tag}>)`);
  return xml.replace(pattern, (_match, open: string, close: string) => `${open}${value}${close}`);
}

/**
 * The cover title is a content control bound to `dc:title`, so the document property and the visible
 * text have to be set together — Word refreshes the control from the property, and a document whose
 * properties still say "Document Title" would revert the cover the first time it is opened.
 */
function updateCoreProperties(coreXml: string, doc: DocDocument, generatedAt: Date): string {
  const stamp = `${generatedAt.toISOString().slice(0, 19)}Z`;
  let xml = replaceTag(coreXml, "dc:title", escapeXml(sanitize(doc.title)));
  xml = replaceTag(xml, "dc:subject", escapeXml(sanitize(doc.subtitle)));
  xml = replaceTag(xml, "dc:creator", "Recon");
  xml = replaceTag(xml, "cp:lastModifiedBy", "Recon");
  xml = replaceTag(xml, "dcterms:modified", stamp);
  return xml;
}

/**
 * Asks Word to update fields when the document is opened, so the table of contents picks up page
 * numbers by itself. Inserted before `hdrShapeDefaults`, which is where the settings schema expects
 * it; a template that already has the flag is left alone.
 */
function enableFieldUpdate(settingsXml: string): string {
  if (settingsXml.includes("<w:updateFields")) return settingsXml;
  for (const anchor of ["<w:hdrShapeDefaults", "<w:footnotePr", "<w:compat"]) {
    const at = settingsXml.indexOf(anchor);
    if (at >= 0) return `${settingsXml.slice(0, at)}<w:updateFields w:val="true"/>${settingsXml.slice(at)}`;
  }
  return settingsXml;
}

/**
 * Renders `doc` into a copy of the template, returning the bytes of a .docx.
 *
 * `templateBytes` is the template file read off disk; every part of it other than the three named
 * above is passed through untouched, so whatever the template contains — logos, fonts, custom XML,
 * the footer's page numbering — survives into the output.
 */
export function buildDocx(templateBytes: Uint8Array, doc: DocDocument, generatedAt = new Date()): Uint8Array {
  const parts = unzipSync(templateBytes);

  const documentPart = parts["word/document.xml"];
  if (!documentPart) {
    throw new Error("The template is not a Word document — it has no word/document.xml.");
  }

  const relsPart = parts["word/_rels/document.xml.rels"];
  const { imageRels, relsAdditions, media } = prepareImageRelationships(
    doc.blocks,
    relsPart ? strFromU8(relsPart) : "<Relationships></Relationships>"
  );
  if (relsAdditions.length > 0) {
    if (!relsPart) {
      throw new Error("The template has no word/_rels/document.xml.rels to add the diagram's relationship to.");
    }
    parts["word/_rels/document.xml.rels"] = strToU8(addImageRelationships(strFromU8(relsPart), relsAdditions));
    for (const [path, bytes] of Object.entries(media)) parts[path] = new Uint8Array(bytes);
  }

  const shell = splitTemplate(strFromU8(documentPart));
  const body = `${fillCover(shell.cover, doc)}${renderDocumentBody(doc.blocks, imageRels)}${shell.sectPr}`;
  parts["word/document.xml"] = strToU8(`${shell.head}${body}</w:body></w:document>`);

  const core = parts["docProps/core.xml"];
  if (core) parts["docProps/core.xml"] = strToU8(updateCoreProperties(strFromU8(core), doc, generatedAt));

  const settings = parts["word/settings.xml"];
  if (settings) parts["word/settings.xml"] = strToU8(enableFieldUpdate(strFromU8(settings)));

  return zipSync(parts, { level: 6 });
}
