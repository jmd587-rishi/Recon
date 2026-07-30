import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildDiagramComponents, type DiagramComponent, type DiagramGraph } from "../services/diagramComponents.js";
import { renderOfficeSvg } from "../services/officeSvg.js";
import { buildPptx } from "../services/pptxWriter.js";

/**
 * The disk side of `reconcile diagrams`: the deck, the per-component SVGs, and a note saying what to do
 * with them.
 *
 * Kept out of the two renderers so they stay pure — one returns a string, the other returns bytes, and
 * neither knows where anything lands — matching how `documentArtifacts.ts` sits in front of
 * `docxWriter.ts`.
 *
 * Both formats are written every time rather than either/or, because they answer different questions.
 * The .pptx is the one to hand someone: open it, copy the shapes off a slide, paste them into Word or a
 * deck, and the boxes are draggable and the text is typeable with nothing else to do. The .svg files are
 * for dropping *one* hop into a document that already exists, which is awkward with a deck — but they
 * need the Insert ▸ Convert to Shape dance, and whether their text stays editable text depends on the
 * Office build. Writing both means neither limitation is a dead end.
 */

const SVG_SUBDIR = "svg";

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "project";
}

export interface WrittenDiagrams {
  dir: string;
  /** Paths written, relative to `dir`. */
  files: string[];
  components: DiagramComponent[];
  /** Components that had no lineage to draw — written anyway, so the gap is visible. */
  emptyCount: number;
}

const README = `Lineage diagrams — how to get these into Word or PowerPoint
==========================================================

<deck>
  One slide per diagram. Every table is a real PowerPoint shape and every arrow is a real
  connector attached to the two shapes it joins.

  To reuse one:
    1. Open the deck and go to the slide you want.
    2. Select the shapes (Ctrl+A on the slide) and copy.
    3. Paste into your Word document or your own deck.

  What you get is editable: drag a box and its arrows follow, click the text and retype it,
  recolour anything with the normal Shape Format tools. Nothing is a picture.

svg/
  The same diagrams, one file each, for dropping a single hop into a document that already
  exists.

  To make one editable:
    1. In Word or PowerPoint: Insert > Pictures > This Device, and pick the .svg.
    2. Right-click it > Graphic > Convert to Shape.

  Caveat worth knowing: Convert to Shape reliably gives you editable boxes, but some Office
  builds turn the labels into outlines instead of text. If you need to retype the labels and
  yours does that, take them from the deck instead.

Both were generated from the same approved lineage as the reconciliation scripts, and the file
names match the hop folders in the governance output — bronze_to_silver.svg is the diagram for
bronze_to_silver.sql.
`;

/**
 * Builds the components from the graph and writes both formats.
 *
 * Takes the graph rather than a folder so `reconcile run` can hand over the lineage the user just
 * approved in memory, exactly as `writeDocumentArtifacts` takes a built document.
 */
export async function writeDiagramArtifacts(
  dir: string,
  outName: string,
  graph: DiagramGraph,
  generatedAt: Date
): Promise<WrittenDiagrams> {
  const components = buildDiagramComponents(graph);
  const outRoot = path.join(dir, outName);
  const svgRoot = path.join(outRoot, SVG_SUBDIR);
  await mkdir(svgRoot, { recursive: true });

  const files: string[] = [];

  const deckName = `${slug(graph.projectName)}-lineage.pptx`;
  const deck = buildPptx(components, {
    title: `${graph.projectName} — lineage`,
    generatedAt
  });
  await writeFile(path.join(outRoot, deckName), deck);
  files.push(deckName);

  for (const component of components) {
    const name = `${component.id}.svg`;
    await writeFile(path.join(svgRoot, name), renderOfficeSvg(component), "utf8");
    files.push(`${SVG_SUBDIR}/${name}`);
  }

  await writeFile(path.join(outRoot, "README.txt"), README.replace("<deck>", deckName), "utf8");
  files.push("README.txt");

  return {
    dir: outRoot,
    files,
    components,
    emptyCount: components.filter((c) => c.emptyReason !== null).length
  };
}

/** What the CLI prints after writing — one line per component, so the hop names are visible. */
export function describeDiagrams(written: WrittenDiagrams): string[] {
  return written.components.map((component) => {
    const detail = component.emptyReason
      ? "no lineage for this hop"
      : `${component.layout.nodes.length} table${component.layout.nodes.length === 1 ? "" : "s"}, ` +
        `${component.layout.edges.length} edge${component.layout.edges.length === 1 ? "" : "s"}`;
    return `${component.id}  (${detail})`;
  });
}
