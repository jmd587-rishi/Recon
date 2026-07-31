/**
 * The shape of a generated document, independent of how it is written out.
 *
 * `documentation.ts` builds one of these from the project's facts and the model's prose; `docxWriter.ts`
 * renders it into the branded Word template and `renderMarkdown` below renders the same thing as text.
 * Keeping the model in the middle is what lets the .docx and the .md say exactly the same thing, and
 * it means a folder with no template to render into still gets a document rather than an error.
 *
 * Blocks name *styles*, not formatting — `heading`, `bullet`, `table` map onto the template's own
 * style ids (`Heading1`, `Bullet`, `Style1`), so the output inherits the numbering, fonts and colours
 * the template defines rather than carrying its own.
 */

export type DocHeadingLevel = 1 | 2 | 3 | 4;
export type DocBulletLevel = 1 | 2 | 3;

export interface DocTableColumn {
  header: string;
  /** Render cell text as code — table and column names, file paths, SQL fragments. */
  mono?: boolean;
  /** Share of the table's width, as a percentage. Columns without one split what is left equally. */
  widthPct?: number;
}

export interface DocTocEntry {
  level: 1 | 2;
  text: string;
}

export type DocBlock =
  /**
   * `unnumbered` keeps a level-1 heading out of the template's automatic section numbering, and out of
   * the table of contents — the contents page itself is the one heading that is neither section 1 nor
   * an entry in its own list.
   */
  | { kind: "heading"; level: DocHeadingLevel; text: string; unnumbered?: boolean }
  | { kind: "para"; text: string; style?: "Normal" | "Quote" }
  | { kind: "bullet"; level: DocBulletLevel; text: string }
  | { kind: "numbered"; text: string }
  | { kind: "table"; columns: DocTableColumn[]; rows: string[][] }
  | { kind: "code"; text: string }
  /** A Word TOC field, with `entries` as its static result for readers who never refresh it. */
  | { kind: "toc"; entries: DocTocEntry[] }
  | { kind: "pageBreak" }
  /** A raster picture — `png` is the already-rendered bytes, sized in device pixels. */
  | { kind: "image"; png: Uint8Array; widthPx: number; heightPx: number; altText: string };

export interface DocDocument {
  /** Cover-page title, and `dc:title` in the .docx. */
  title: string;
  subtitle: string;
  blocks: DocBlock[];
}

/** Collects the level 1 and 2 headings a table of contents lists. */
export function tocEntries(blocks: DocBlock[]): DocTocEntry[] {
  return blocks.flatMap((block) =>
    block.kind === "heading" && !block.unnumbered && (block.level === 1 || block.level === 2)
      ? [{ level: block.level, text: block.text }]
      : []
  );
}

/**
 * Puts the table of contents at the top of the document, listing the headings that follow it.
 *
 * Called after every section is built rather than while building them, so the contents cannot drift
 * from the document: it is derived from the headings, not maintained alongside them.
 */
export function withTableOfContents(doc: DocDocument, heading = "Table of contents"): DocDocument {
  const entries = tocEntries(doc.blocks);
  return {
    ...doc,
    blocks: [
      { kind: "heading", level: 1, text: heading, unnumbered: true },
      { kind: "toc", entries },
      { kind: "pageBreak" },
      ...doc.blocks
    ]
  };
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function mdCell(text: string, mono: boolean | undefined): string {
  const cell = escapePipes(text.trim());
  if (cell.length === 0 || cell === "—") return "—";
  return mono ? `\`${cell}\`` : cell;
}

/**
 * The same document as Markdown — written beside the .docx so the text is diffable, greppable and
 * reviewable without Word, and so a run with no template to render into still produces something.
 */
export function renderMarkdown(doc: DocDocument): string {
  const lines: string[] = [`# ${doc.title}`, "", `*${doc.subtitle}*`, ""];

  // A list run pushes no blank line of its own, so anything that isn't another list item has to open
  // one — a paragraph or table butted straight against a `-` line is read as part of the list.
  const separate = () => {
    if (lines[lines.length - 1] !== "") lines.push("");
  };

  for (const block of doc.blocks) {
    switch (block.kind) {
      case "heading":
        separate();
        lines.push(`${"#".repeat(block.level + 1)} ${block.text}`, "");
        break;
      case "para":
        separate();
        lines.push(block.style === "Quote" ? `> ${block.text}` : block.text, "");
        break;
      case "bullet":
        lines.push(`${"  ".repeat(block.level - 1)}- ${block.text}`);
        break;
      case "numbered":
        lines.push(`1. ${block.text}`);
        break;
      case "table": {
        separate();
        lines.push(`| ${block.columns.map((c) => c.header).join(" | ")} |`);
        lines.push(`| ${block.columns.map(() => "---").join(" | ")} |`);
        for (const row of block.rows) {
          lines.push(`| ${block.columns.map((c, i) => mdCell(row[i] ?? "", c.mono)).join(" | ")} |`);
        }
        lines.push("");
        break;
      }
      case "code":
        separate();
        lines.push("```sql", block.text, "```", "");
        break;
      case "toc":
        separate();
        for (const entry of block.entries) {
          lines.push(`${entry.level === 1 ? "" : "  "}- ${entry.text}`);
        }
        lines.push("");
        break;
      case "pageBreak":
        separate();
        lines.push("---", "");
        break;
      case "image":
        separate();
        lines.push(`![${escapePipes(block.altText)}](data:image/png;base64,${Buffer.from(block.png).toString("base64")})`, "");
        break;
      default: {
        // A block kind added without a case here would otherwise vanish from the Markdown while still
        // appearing in the .docx, which is the one way the two renderers can silently disagree.
        const unhandled: never = block;
        throw new Error(`No Markdown rendering for block ${JSON.stringify(unhandled)}`);
      }
    }
  }

  // Bullet runs leave no trailing blank line of their own; one at the end keeps the file tidy.
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
