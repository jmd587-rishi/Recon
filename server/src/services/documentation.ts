import type {
  HopBusinessContext,
  LayerRef,
  LineageArtifacts,
  LineageEdge,
  LocalFileSummary,
  LocalSkippedFile,
  ProjectDocumentationProse,
  ReconCheckKind,
  TableKind
} from "../types/index.js";
import { Resvg } from "@resvg/resvg-js";
import { mapWithConcurrency } from "./concurrency.js";
import { buildDiagramComponents, type DiagramGraph } from "./diagramComponents.js";
import { withTableOfContents, type DocBlock, type DocDocument } from "./docModel.js";
import { joinLabel } from "./layerReconciliation.js";
import { layerHasTable, unclaimedSchemas } from "./layers.js";
import {
  describeHopContext,
  envInt,
  LlmConfigError,
  writeProjectDocumentation,
  type HopContextLlmInput
} from "./llmClient.js";
import type { LocalProject } from "./localProject.js";
import { renderOfficeSvg } from "./officeSvg.js";
import { classifyTable } from "./projectSummary.js";
import {
  gatherLayerFacts,
  gatherReconciliationFacts,
  templateChecks,
  type ReconTargetFacts
} from "./reconciliationScripts.js";
import {
  buildTroubleshootingPlan,
  FAILURE_GUIDE,
  groupConcerns,
  KIND_LABELS,
  LAYER_REVIEW_GUIDE,
  type TroubleshootingPlan
} from "./troubleshooting.js";

/**
 * `reconcile document` — the whole reconciliation exercise written up as a document.
 *
 * Everything structural is *derived*, from the same primitives the rest of Recon uses: the layers, the
 * tables in each, the lineage graph, and — via `gatherReconciliationFacts` — the join keys, measures
 * and filters behind every check the scripts would run. The reviewer model is asked for one thing
 * only, and it is the one thing the SQL cannot state: what the pipeline is *for*, layer by layer and
 * hop by hop. So a document produced with `--no-ai` (or with Azure OpenAI unconfigured) is the same
 * document minus its prose, never a broken one, and every table in it is as trustworthy as the parse.
 *
 * The prose is fetched in two shapes because the grounding differs. One call sees the shape of the
 * whole pipeline — layers, tables, edges — and writes the introduction, the architecture and the
 * lineage narrative. One call per hop sees that hop's transformation SQL and writes its business
 * context. A hop whose call fails costs that hop's context and nothing else.
 */

/** How much of one transformation goes into a hop's prompt. Enough to read the joins and filters. */
const MAX_SNIPPET_CHARS = 3000;
const MAX_HOP_PROMPT_CHARS = 24_000;
const MAX_TARGETS_PER_HOP_PROMPT = 20;
/** Edges and per-layer tables carried into the project-level prompt. */
const MAX_PROMPT_EDGES = 200;
const MAX_PROMPT_TABLES_PER_LAYER = 60;

/** Caps on what goes into the document itself, so an appendix can't run to fifty pages. */
const MAX_LAYER_TABLE_ROWS = 40;
const MAX_EDGE_ROWS = 80;
const MAX_FILE_ROWS = 120;
const MAX_INVENTORY_ROWS = 200;
const MAX_SKIPPED_ROWS = 20;
/** Source/target pairs listed per layer in the column-reconciliation coverage table. */
const MAX_PAIR_ROWS = 24;

/**
 * Caps on the *written* half, which is where a document stops being read.
 *
 * The model is asked for at most four rules and three watch-outs, so these are the second line of
 * defence rather than the mechanism — but a stage that answers with nine rules should still cost the
 * reader four lines, not nine.
 */
const MAX_RULES_PER_HOP = 4;
const MAX_DIFFERENCES_PER_HOP = 3;
const MAX_WATCHOUTS_PER_HOP = 3;
/**
 * Points listed under a written section's opening paragraph before the rest are dropped.
 *
 * The model is asked for three or four, so this is the backstop. Five is where a bulleted section stops
 * being a summary of the section and starts being the section.
 */
const MAX_POINTS_PER_SECTION = 5;
/** Tables named against one finding before the rest are counted — a warehouse has a lot of them. */
const MAX_TABLES_PER_CONCERN = 10;
/** Concerns raised at lineage-review time, and rounds of corrections, listed before they are counted. */
const MAX_LINEAGE_CONCERNS = 5;
const MAX_FEEDBACK_ROUNDS = 4;
/** Grounding notes carried into the closing section — the honest list of what was *not* checked. */
const MAX_LIMIT_NOTES = 10;

/**
 * One line each, so a bullet is a bullet rather than a paragraph with a dash in front of it.
 *
 * Sized so that the one sentence the model was asked for normally fits whole: the cut is the backstop
 * for a sentence that ran long, not the usual case, because an ellipsis in every bullet reads as a
 * document that was truncated rather than as one that was edited.
 */
const RULE_CHARS = 320;
const EVIDENCE_CHARS = 90;
const WATCHOUT_CHARS = 320;
const FILTER_CHARS = 110;
const CONCERN_CHARS = 260;
const NOTE_CHARS = 300;
/**
 * A written *point* — a sentence or two the model wrote to stand on its own, not a predicate lifted out
 * of a CTE — so it gets more room than a rule and is cut back to a sentence end rather than to a word.
 */
const POINT_CHARS = 420;

const DOC_CONCURRENCY = envInt("RECON_DOC_CONCURRENCY", 3, 1, 8);
const DOC_TIMEOUT_MS = envInt("RECON_DOC_LLM_TIMEOUT_MS", 100_000, 10_000, 300_000);

// ---- facts ----

export interface DocTableFacts {
  qualified: string;
  name: string;
  kind: TableKind;
  written: boolean;
  read: boolean;
}

export interface DocLayerFacts {
  layer: LayerRef;
  tables: DocTableFacts[];
  factCount: number;
  dimensionCount: number;
  builtHereCount: number;
}

export interface DocHopFacts {
  label: string;
  folder: string;
  from: LayerRef | null;
  to: LayerRef | null;
  targets: ReconTargetFacts[];
  /** How many checks `reconcile scripts` derives for this hop, counted the same way it writes them. */
  checkCount: number;
  notes: string[];
}

/** One source/target pair of the per-layer column report, as that report's own first four columns. */
export interface DocReconPair {
  source: string;
  target: string;
  /** `FROM`, `LEFT JOIN`, … — `layerReconciliation.joinLabel`, so the two never disagree. */
  joinType: string;
  /** Columns reconciled across this pair — one row each in the generated script. */
  columnCount: number;
  /** Of those, the ones compared as totals rather than as distinct-value counts. */
  measureCount: number;
}

/**
 * What `governance/layers/<layer>.sql` covers, per layer.
 *
 * The document has to describe *both* reconciliation artifacts or it describes half the run: the hop
 * bundles say whether a pair of layers ties out, and these say, column by column, which source each
 * column came from and how the code relates them. Derived from the same `gatherLayerFacts` the scripts
 * are written from — the model's `comments` column is the one thing not reproduced here, because it is
 * written against the SQL when the script is generated, not when the document is.
 */
export interface DocLayerReconFacts {
  layer: LayerRef | null;
  label: string;
  /** The file `reconcile scripts` writes for it, so the document can name it. */
  filename: string;
  targetCount: number;
  pairs: DocReconPair[];
  columnCount: number;
  notes: string[];
}

export interface DocFacts {
  projectName: string;
  scanRoot: string;
  layers: DocLayerFacts[];
  /** Schemas the SQL uses that no layer claims — named in the document rather than quietly dropped. */
  unassignedSchemas: string[];
  /** Tables the SQL never qualifies with a schema, so no layer can hold them. */
  unqualifiedTables: string[];
  edges: LineageEdge[];
  /** Read here but built somewhere else: this project's inputs. */
  externalInputs: string[];
  /** Built here and never read again: this project's outputs. */
  terminalTables: string[];
  hops: DocHopFacts[];
  /** The other half of what was generated: one column-level report per layer. */
  layerReconciliation: DocLayerReconFacts[];
  files: LocalFileSummary[];
  skipped: LocalSkippedFile[];
  inventory: DocTableFacts[];
  stats: {
    fileCount: number;
    statementCount: number;
    tableCount: number;
    schemaCount: number;
    edgeCount: number;
    layerCount: number;
    checkCount: number;
    /** Rows the per-layer reports carry between them — one per column reconciled. */
    reconciledColumnCount: number;
    inferredKeyCount: number;
    tablesWithoutColumns: number;
  };
  /** The approved lineage from `reconcile run`, when the folder has one. */
  lineage: LineageArtifacts | null;
  /** The pipeline overview diagram, rasterized for embedding — `null` when there was nothing to draw. */
  diagramImage: { png: Uint8Array; widthPx: number; heightPx: number } | null;
}

/**
 * The same overview `reconcile diagrams` writes to disk, rasterized here so it can sit inside the
 * document itself rather than only beside it as a separate file — same graph, same renderer
 * (`officeSvg.ts`), so the picture in the document and the one in `diagrams/` never disagree.
 */
function buildOverviewDiagramImage(project: LocalProject, layers: LayerRef[]): DocFacts["diagramImage"] {
  const graph: DiagramGraph = {
    projectName: project.folderName,
    edges: project.scan.lineage,
    layers,
    tables: project.scan.tables
  };
  const [overview] = buildDiagramComponents(graph);
  if (!overview || overview.emptyReason) return null;

  const svg = renderOfficeSvg(overview);
  const rendered = new Resvg(svg).render();
  return { png: rendered.asPng(), widthPx: rendered.width, heightPx: rendered.height };
}

function tableFacts(project: LocalProject, layers: LayerRef[]): DocTableFacts[] {
  // `classifyTable` only wants the layer as a hint, so the first layer claiming the table is enough.
  const layerOf = (qualified: string) => layers.find((layer) => layerHasTable(layer, qualified));
  return project.scan.tables.map((table) => ({
    qualified: table.qualified,
    name: table.name,
    kind: classifyTable(table.name, layerOf(table.qualified)),
    written: table.written,
    read: table.read
  }));
}

/**
 * Reads the project into everything the document states as fact.
 *
 * Pure, and separate from the model calls on purpose: this is the half that can be checked against the
 * SQL, so it is also the half worth testing.
 */
export function gatherDocumentationFacts(
  project: LocalProject,
  layers: LayerRef[],
  lineage: LineageArtifacts | null,
  scanRoot: string
): DocFacts {
  const inventory = tableFacts(project, layers);

  const layerFacts: DocLayerFacts[] = layers.map((layer) => {
    const tables = inventory.filter((t) => layerHasTable(layer, t.qualified));
    return {
      layer,
      tables,
      factCount: tables.filter((t) => t.kind === "fact").length,
      dimensionCount: tables.filter((t) => t.kind === "dimension").length,
      builtHereCount: tables.filter((t) => t.written).length
    };
  });

  const { hops } = gatherReconciliationFacts(project, layers);
  const docHops: DocHopFacts[] = hops.map((hop) => ({
    label: hop.label,
    folder: hop.folder,
    from: hop.from,
    to: hop.to,
    targets: hop.targets,
    checkCount: hop.targets.reduce((n, target) => n + templateChecks(target).length, 0),
    notes: hop.notes
  }));

  const layerRecon: DocLayerReconFacts[] = gatherLayerFacts(project, layers).layers.map((facts) => {
    const pairs = facts.targets.flatMap((target) =>
      target.perSource
        .filter((entry) => entry.fields.length > 0)
        .map((entry) => ({
          source: entry.source,
          target: target.target,
          joinType: joinLabel(entry),
          columnCount: entry.fields.length,
          measureCount: entry.fields.filter((field) => field.role === "measure").length
        }))
    );
    return {
      layer: facts.layer,
      label: facts.label,
      filename: facts.filename,
      targetCount: facts.targets.length,
      pairs,
      columnCount: pairs.reduce((n, pair) => n + pair.columnCount, 0),
      notes: facts.notes
    };
  });

  const allTargets = docHops.flatMap((hop) => hop.targets);

  return {
    projectName: project.folderName,
    scanRoot,
    layers: layerFacts,
    unassignedSchemas: unclaimedSchemas(project.scan.tables, layers),
    unqualifiedTables: inventory.filter((t) => qualifiedSchema(t.qualified) === null).map((t) => t.qualified),
    edges: project.scan.lineage,
    externalInputs: inventory.filter((t) => t.read && !t.written).map((t) => t.qualified),
    terminalTables: inventory.filter((t) => t.written && !t.read).map((t) => t.qualified),
    hops: docHops,
    layerReconciliation: layerRecon,
    files: project.scan.files,
    skipped: project.scan.skipped,
    inventory,
    stats: {
      fileCount: project.scan.stats.fileCount,
      statementCount: project.scan.stats.statementCount,
      tableCount: project.scan.stats.tableCount,
      schemaCount: project.scan.stats.schemaCount,
      edgeCount: project.scan.stats.lineageEdgeCount,
      layerCount: layers.length,
      checkCount: docHops.reduce((n, hop) => n + hop.checkCount, 0),
      reconciledColumnCount: layerRecon.reduce((n, layer) => n + layer.columnCount, 0),
      inferredKeyCount: allTargets.filter((t) => t.key.confidence === "inferred").length,
      tablesWithoutColumns: allTargets.filter((t) =>
        t.columnSources.some((c) => c.table === t.target && c.columnCount === 0)
      ).length
    },
    lineage,
    diagramImage: buildOverviewDiagramImage(project, layers)
  };
}

function qualifiedSchema(qualified: string): string | null {
  const parts = qualified.split(".").filter((p) => p.length > 0);
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

// ---- prose ----

export interface DocProse {
  project: ProjectDocumentationProse;
  /** Keyed by hop folder, so two hops between similarly named layers can't be confused. */
  hops: Map<string, HopBusinessContext>;
  /** Why the prose isn't all there, in the words the document will print. */
  notices: string[];
  /** False when nothing was written by the model at all — the document says so up front. */
  usedAi: boolean;
}

export const EMPTY_PROSE: ProjectDocumentationProse = {
  introduction: [],
  architecture: [],
  layers: [],
  lineage: [],
  risks: []
};

function hopPrompt(hop: DocHopFacts): HopContextLlmInput | null {
  if (hop.targets.length === 0) return null;

  let budget = MAX_HOP_PROMPT_CHARS;
  const targets: HopContextLlmInput["targets"] = [];

  for (const target of hop.targets.slice(0, MAX_TARGETS_PER_HOP_PROMPT)) {
    // The statements that build one table, longest first: the biggest is the one carrying the joins
    // and filters, and it is the one worth spending the budget on if only one fits.
    const sql = [...target.facts]
      .sort((a, b) => b.rawSql.length - a.rawSql.length)
      .map((fact) => fact.rawSql.trim())
      .join("\n\n")
      .slice(0, MAX_SNIPPET_CHARS);
    if (sql.length > budget) break;
    budget -= sql.length;

    targets.push({
      target: target.target,
      sources: target.sources,
      keyColumns: target.key.columns,
      keyConfidence: target.key.confidence,
      measureColumns: target.measureColumns,
      knownFilters: target.knownFilters,
      snippet: sql
    });
  }

  if (targets.length === 0) return null;
  return {
    hopLabel: hop.label,
    fromLayer: hop.from?.label ?? null,
    toLayer: hop.to?.label ?? null,
    targets
  };
}

/**
 * Fetches the prose, degrading one call at a time.
 *
 * `LlmConfigError` is the one failure that stops the whole thing: an unconfigured endpoint won't
 * answer the hop calls either, so there is nothing to gain from making them. Every other failure is
 * recorded as a notice and the document goes out with the derived content for that section.
 */
export async function fetchDocumentationProse(
  facts: DocFacts,
  options: { useAi: boolean; onProgress?: (message: string) => void }
): Promise<DocProse> {
  const hops = new Map<string, HopBusinessContext>();
  const notices: string[] = [];
  const progress = options.onProgress ?? (() => {});

  if (!options.useAi) {
    return {
      project: EMPTY_PROSE,
      hops,
      notices: [
        "This document was generated with --no-ai, so it contains only what Recon derives from the " +
          "project's SQL: the layers, the lineage, and the checks behind the reconciliation scripts. " +
          "The written explanations of what each layer is for are absent by request."
      ],
      usedAi: false
    };
  }

  let project = EMPTY_PROSE;
  try {
    progress("Asking the reviewer model to introduce the project");
    project = await writeProjectDocumentation(
      {
        projectName: facts.projectName,
        layers: facts.layers.map((l) => ({
          label: l.layer.label,
          schema: l.layer.schema,
          role: l.layer.role,
          tables: l.tables.slice(0, MAX_PROMPT_TABLES_PER_LAYER).map((t) => ({
            name: t.name,
            kind: t.kind,
            written: t.written
          }))
        })),
        stats: {
          fileCount: facts.stats.fileCount,
          statementCount: facts.stats.statementCount,
          tableCount: facts.stats.tableCount,
          schemaCount: facts.stats.schemaCount,
          edgeCount: facts.stats.edgeCount,
          layerCount: facts.stats.layerCount
        },
        edges: facts.edges.slice(0, MAX_PROMPT_EDGES).map((e) => ({ from: e.from, to: e.to })),
        unassignedSchemas: facts.unassignedSchemas,
        priorNarrative: facts.lineage?.narrative,
        priorConcerns: facts.lineage?.concerns
      },
      { timeoutMs: DOC_TIMEOUT_MS }
    );
  } catch (err) {
    if (err instanceof LlmConfigError) {
      return {
        project: EMPTY_PROSE,
        hops,
        notices: [
          "Azure OpenAI isn't configured, so this document is what Recon derives from the project's SQL " +
            "— its layers, its lineage and the checks behind the reconciliation scripts — without the " +
            "written explanation of what each layer is for. Set AZURE_OPENAI_* (see --env-file) and " +
            "re-run to fill those in."
        ],
        usedAi: false
      };
    }
    notices.push(
      `The reviewer model didn't answer for the project overview (${message(err)}), so the introduction ` +
        "and layer descriptions below are Recon's own summary of what it parsed."
    );
  }

  const prompts = facts.hops.flatMap((hop) => {
    const prompt = hopPrompt(hop);
    return prompt ? [{ folder: hop.folder, prompt }] : [];
  });

  const results = await mapWithConcurrency(prompts, DOC_CONCURRENCY, async ({ folder, prompt }) => {
    try {
      progress(`Describing ${prompt.hopLabel}`);
      return { folder, context: await describeHopContext(prompt, { timeoutMs: DOC_TIMEOUT_MS }), failure: null };
    } catch (err) {
      return { folder, context: null, failure: message(err) };
    }
  });

  const failures: string[] = [];
  for (const result of results) {
    if (result.context) hops.set(result.folder, result.context);
    else if (result.failure) failures.push(result.failure);
  }

  if (failures.length > 0) {
    notices.push(
      `${failures.length} of ${prompts.length} pipeline stage${prompts.length === 1 ? "" : "s"} has no ` +
        `written business context (${Array.from(new Set(failures))[0]}) — the tables, keys and filters ` +
        "for those stages are still documented below. Re-run to retry just those."
    );
  }

  return { project, hops, notices, usedAi: project.introduction.length > 0 || hops.size > 0 };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- the document ----

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Verb agreement for the counted sentences below, where the count decides the form. */
function agree(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function list(values: string[], max = 6): string {
  if (values.length === 0) return "";
  if (values.length <= max) return values.join(", ");
  return `${values.slice(0, max).join(", ")} and ${values.length - max} more`;
}

function dash(value: string): string {
  return value.trim().length > 0 ? value : "—";
}

/**
 * Flattens SQL onto one line and cuts it to length.
 *
 * A predicate extracted from a real transformation can run to hundreds of characters — the extractor
 * reads to the end of the enclosing expression, which in a CTE chain is most of the statement — and a
 * document is for reading, not for running. The full text is in the generated script beside it.
 */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;

  // Back up to a word boundary. A sentence cut mid-word ("a row-number deduplication fil…") reads as a
  // broken document rather than as an abridged one, and the whole word costs a character or two.
  const cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The opening sentence, which in a grounding note is the finding — the rest is the explanation and the
 * fix, and both are in the generated script's own header where someone acting on them is looking.
 */
function firstSentence(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const stop = flat.indexOf(". ");
  return oneLine(stop > 40 ? flat.slice(0, stop + 1) : flat, max);
}

/**
 * A written point cut to length at a sentence end rather than mid-thought.
 *
 * `oneLine` backs up to a word boundary, which is right for a SQL predicate — there are no sentences in
 * one to back up to — but a point cut that way ends on an ellipsis in the middle of the clause that
 * says what to do about it, which is the half a reader came for. Dropping the whole trailing sentence
 * leaves the ones before it intact and reads as edited rather than as truncated; a point with no
 * sentence break in range still falls back to the word cut, since something has to give.
 */
function trimPoint(text: string, max = POINT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;

  const cut = flat.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastStop > max / 2 ? cut.slice(0, lastStop + 1) : oneLine(flat, max);
}

/**
 * A written section rendered the way every written section in this report is: one opening paragraph,
 * then bullets.
 *
 * This is half of an arrangement, and the prompts are the other half — `buildDocumentationMessages` and
 * `buildHopContextMessages` ask for a lead followed by points precisely so that this can lay them out.
 * Three paragraphs of prose in a row is the shape a reader skips: nothing on the page says which
 * sentence carries the finding, so all of them get the same weight, which is none. Bulleting *all* of
 * it fails the other way — a section that opens on a bullet has no sentence to stand on and reads as
 * notes rather than as a document. So the first entry stays a paragraph and the rest become points.
 *
 * Returns nothing at all for an empty list, so a caller can fall back to its own derived sentence
 * rather than emit a heading with nothing under it.
 */
function leadAndPoints(entries: string[], max = MAX_POINTS_PER_SECTION): DocBlock[] {
  const [lead, ...points] = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (lead === undefined) return [];

  return [
    { kind: "para", text: lead },
    ...points
      .slice(0, max)
      .map((point): DocBlock => ({ kind: "bullet", level: 1, text: trimPoint(point) }))
  ];
}

/**
 * Groups the gap notes by what they say, so a note true of every table in the project is made once.
 *
 * Six tables missing a measure column is one fact about the pipeline, not six about its tables, and
 * reading it six times obscures the notes that *are* table-specific.
 */
function groupedNotes(targets: ReconTargetFacts[]): string[] {
  const byNote = new Map<string, string[]>();
  for (const target of targets) {
    for (const note of target.notes) {
      byNote.set(note, [...(byNote.get(note) ?? []), target.target]);
    }
  }
  return (
    Array.from(byNote.entries())
      // Widest first, because the list is capped and a limit true of twelve tables is a fact about the
      // pipeline — "no measure column is shared anywhere" is the headline — while one true of a single
      // table is detail its own script header already carries.
      .sort((a, b) => b[1].length - a[1].length)
      .map(([note, tables]) => `${list(tables, 5)} — ${firstSentence(note, NOTE_CHARS)}`)
  );
}

/**
 * The kinds of check `reconcile scripts` derives, and what each compares. Kept in step with
 * `templateChecks`.
 *
 * What a *failure* of each means is deliberately not here: that is `FAILURE_GUIDE`, printed once in the
 * failure section with the next step beside it. Two tables saying the same thing in different words is
 * how they drift apart.
 */
const CHECK_GUIDE: [string, string][] = [
  ["Row count", "Rows in the table against rows in each table that feeds it."],
  ["Measure totals", "The sum of every numeric column both sides share."],
  ["Missing keys", "Keys present in the source with no matching row in the target."],
  ["Orphan keys", "Keys in the target that no source accounts for."],
  ["Duplicate keys", "The same key appearing more than once in the target."],
  ["Null keys", "Rows whose key columns are NULL."]
];

/**
 * The opening: what this pipeline is, and on what basis this report says so.
 *
 * Deliberately two things and no more. The inventory table that used to sit here ("files read", "tables
 * discovered") and the guide to reading the document were both *about* the report rather than about the
 * pipeline, and a reader who has opened a reconciliation report is looking for the pipeline. The counts
 * that carried real weight — what was read, and what was and wasn't measured — are one sentence each in
 * the basis paragraph, which is where a professional report puts its scope.
 */
function introSection(facts: DocFacts, prose: DocProse, generatedAt: Date): DocBlock[] {
  const blocks: DocBlock[] = [{ kind: "heading", level: 1, text: "Introduction" }];

  for (const notice of prose.notices) blocks.push({ kind: "para", text: notice, style: "Quote" });

  if (prose.project.introduction.length > 0) {
    for (const para of prose.project.introduction) blocks.push({ kind: "para", text: para });
  } else {
    blocks.push({
      kind: "para",
      text:
        `${facts.projectName} is a SQL data project of ${plural(facts.stats.fileCount, "file")} building ` +
        `${plural(facts.stats.tableCount, "table")} across ${plural(facts.stats.schemaCount, "schema")}. ` +
        (facts.stats.layerCount >= 2
          ? `Its tables move through ${plural(facts.stats.layerCount, "pipeline layer")} — ` +
            `${facts.layers.map((l) => l.layer.label).join(" then ")} — and this report describes each ` +
            "of those stages, the lineage between them, and the reconciliation that proves the data survived the trip."
          : "This report describes its tables, the lineage between them, and the reconciliation that " +
            "proves the data survived the transformations.")
    });
  }

  blocks.push({
    kind: "para",
    text:
      `The pipeline described here was read from the SQL in ${facts.scanRoot} on ` +
      `${generatedAt.toISOString().slice(0, 10)}: ${plural(facts.stats.fileCount, "file")}, ` +
      `${plural(facts.stats.statementCount, "SQL statement")}, ${plural(facts.stats.tableCount, "table")} ` +
      `and ${plural(facts.stats.edgeCount, "lineage edge")}. Nothing was measured against a live database, ` +
      "so the layers, the lineage and every check below are derived from the code: this report says what " +
      "the pipeline does and what to run to prove it, not what the data currently shows."
  });

  const provenance = facts.lineage
    ? `The lineage it is built on was ${facts.lineage.approved ? "reviewed and approved" : "reviewed but not approved"} on ` +
      `${facts.lineage.generatedAt.slice(0, 10)}` +
      (facts.lineage.feedback.length > 0
        ? `, after ${plural(facts.lineage.feedback.length, "round")} of corrections, and those corrections are part of what everything below is built on.`
        : ", and this report describes that graph.")
    : "The lineage it is built on was extracted for this report and has not been reviewed — `reconcile run` " +
      "walks through it edge by edge and records the approval.";

  blocks.push({
    kind: "para",
    text: prose.usedAi
      ? `${provenance} Where the report says what a layer, a table or a stage is *for*, that reading came ` +
        "from a reviewer model given the same SQL; everything counted, named or quoted is from the parse."
      : provenance
  });

  return blocks;
}

/** How a table sits in the pipeline, in one cell: built here, read on, or only read. */
function tableRole(table: DocTableFacts): string {
  if (table.written && table.read) return "Built here, read downstream";
  if (table.written) return "Built here, not read again";
  if (table.read) return "Read only — built outside this project";
  return "Neither built nor read here";
}

function layerSection(facts: DocFacts, prose: DocProse): DocBlock[] {
  const blocks: DocBlock[] = [{ kind: "heading", level: 1, text: "Pipeline layers and tables" }];

  if (facts.layers.length === 0) {
    blocks.push({
      kind: "para",
      text:
        "No pipeline layers could be inferred: the SQL in this project never qualifies its tables with a " +
        "schema, so there is nothing to tell one stage from another. Everything below is documented as a " +
        "single scope. Naming the layers explicitly (`reconcile document --layers a,b,c`) splits it up."
    });
    return blocks;
  }

  for (const para of prose.project.architecture) blocks.push({ kind: "para", text: para });
  if (prose.project.architecture.length === 0) {
    blocks.push({
      kind: "para",
      text:
        `Data moves through ${plural(facts.layers.length, "layer")}, most-raw first: ` +
        `${facts.layers.map((l) => `${l.layer.label} (schema ${l.layer.schema})`).join(", then ")}.`
    });
  }

  blocks.push({
    kind: "table",
    columns: [
      { header: "Layer", widthPct: 22 },
      { header: "Schema", mono: true, widthPct: 20 },
      { header: "Tables", widthPct: 12 },
      { header: "Built here", widthPct: 14 },
      { header: "Facts", widthPct: 10 },
      { header: "Dimensions", widthPct: 12 }
    ],
    rows: facts.layers.map((l) => [
      l.layer.label,
      l.layer.schema,
      String(l.tables.length),
      String(l.builtHereCount),
      String(l.factCount),
      String(l.dimensionCount)
    ])
  });

  const byLabel = new Map(prose.project.layers.map((entry) => [entry.layer.trim().toLowerCase(), entry]));

  for (const layerFacts of facts.layers) {
    const { layer, tables } = layerFacts;
    blocks.push({
      kind: "heading",
      level: 2,
      // The schema is only worth naming when the layer was relabelled to something else.
      text: layer.label.toLowerCase() === layer.schema.toLowerCase() ? layer.label : `${layer.label} (${layer.schema})`
    });

    // Unknown labels in the model's answer are simply never looked up — the document asks by the
    // labels it already has, so an invented layer cannot get a section of its own.
    const entry = byLabel.get(layer.label.trim().toLowerCase());
    if (entry?.purpose) blocks.push({ kind: "para", text: entry.purpose });
    if (entry?.contents) blocks.push({ kind: "para", text: entry.contents });
    if (!entry?.purpose && !entry?.contents) {
      blocks.push({
        kind: "para",
        text:
          tables.length === 0
            ? `No table in this project is qualified with the ${layer.schema} schema.`
            : `${plural(tables.length, "table")} ${agree(tables.length, "sits", "sit")} in this layer, ` +
              `${layerFacts.builtHereCount} of them built by SQL in this project: ` +
              `${list(tables.map((t) => t.name), 8)}.`
      });
    }

    if (tables.length > 0) {
      // The model's use cases are looked up by the table's own name, so an invented table cannot get a
      // row — and a layer it wrote nothing for falls back to the three derived columns rather than to a
      // column of dashes.
      const uses = new Map((entry?.tables ?? []).map((t) => [t.name.trim().toLowerCase(), t.use]));
      const known = tables.filter((t) => uses.has(t.name.toLowerCase())).length;

      blocks.push({
        kind: "table",
        columns: known > 0
          ? [
              { header: "Table", mono: true, widthPct: 22 },
              { header: "Looks like", widthPct: 11 },
              { header: "In the pipeline", widthPct: 21 },
              { header: "What it is used for", widthPct: 46 }
            ]
          : [
              { header: "Table", mono: true, widthPct: 46 },
              { header: "Looks like", widthPct: 18 },
              { header: "In the pipeline", widthPct: 36 }
            ],
        rows: tables
          .slice(0, MAX_LAYER_TABLE_ROWS)
          .map((t) =>
            known > 0
              ? [t.name, t.kind, tableRole(t), dash(uses.get(t.name.toLowerCase()) ?? "")]
              : [t.name, t.kind, tableRole(t)]
          )
      });
      if (tables.length > MAX_LAYER_TABLE_ROWS) {
        blocks.push({
          kind: "para",
          text: `${tables.length - MAX_LAYER_TABLE_ROWS} further table(s) in this layer are listed in the table inventory appendix.`
        });
      }
    }
  }

  if (facts.unassignedSchemas.length > 0 || facts.unqualifiedTables.length > 0) {
    blocks.push({ kind: "heading", level: 2, text: "Outside the pipeline" });
    if (facts.unassignedSchemas.length > 0) {
      blocks.push({
        kind: "bullet",
        level: 1,
        text:
          `The SQL also uses ${plural(facts.unassignedSchemas.length, "schema")} that no layer claims: ` +
          `${list(facts.unassignedSchemas, 10)}. Tables there are documented in the appendix but take part ` +
          "in no hop, so nothing reconciles them."
      });
    }
    if (facts.unqualifiedTables.length > 0) {
      blocks.push({
        kind: "bullet",
        level: 1,
        text:
          `${plural(facts.unqualifiedTables.length, "table")} are never qualified with a schema in the SQL ` +
          `(${list(facts.unqualifiedTables, 6)}), so which layer they belong to is decided at deployment ` +
          "time rather than by the code."
      });
    }
  }

  return blocks;
}

function lineageSection(facts: DocFacts, prose: DocProse): DocBlock[] {
  const blocks: DocBlock[] = [{ kind: "heading", level: 1, text: "Table lineage" }];

  const narrative = prose.project.lineage.length > 0 ? prose.project.lineage : [facts.lineage?.narrative ?? ""].filter(Boolean);
  if (narrative.length > 0) {
    for (const para of narrative) blocks.push({ kind: "para", text: para });
  } else {
    blocks.push({
      kind: "para",
      text:
        `${plural(facts.stats.edgeCount, "lineage edge")} ${agree(facts.stats.edgeCount, "was", "were")} ` +
        "extracted from the project's SQL, each one a statement that reads one table and writes another. " +
        "The table below is that graph: read it as “this source feeds this target, in this file”."
    });
  }

  if (facts.diagramImage) {
    blocks.push({
      kind: "image",
      png: facts.diagramImage.png,
      widthPx: facts.diagramImage.widthPx,
      heightPx: facts.diagramImage.heightPx,
      altText: `${facts.projectName} pipeline lineage diagram`
    });
  }

  if (facts.edges.length > 0) {
    blocks.push({
      kind: "table",
      columns: [
        { header: "Source table", mono: true, widthPct: 26 },
        { header: "Target table", mono: true, widthPct: 26 },
        { header: "Join key seen", mono: true, widthPct: 18 },
        { header: "Built by", mono: true, widthPct: 30 }
      ],
      rows: facts.edges
        .slice(0, MAX_EDGE_ROWS)
        .map((e) => [e.from, e.to, dash(e.joinKeyHint ?? ""), `${e.notebookPath} #${e.cellIndex}`])
    });
    if (facts.edges.length > MAX_EDGE_ROWS) {
      blocks.push({
        kind: "para",
        text: `${facts.edges.length - MAX_EDGE_ROWS} further edge(s) were extracted; the full graph is in lineage/lineage.json.`
      });
    }
  }

  blocks.push({ kind: "heading", level: 2, text: "Where the pipeline starts and ends" });
  blocks.push({
    kind: "bullet",
    level: 1,
    text:
      facts.externalInputs.length > 0
        ? `Read but never built here — the project's inputs: ${list(facts.externalInputs, 10)}.`
        : "Every table this project reads is also built by it, so it has no external inputs."
  });
  blocks.push({
    kind: "bullet",
    level: 1,
    text:
      facts.terminalTables.length > 0
        ? `Built here and never read again — what the pipeline exists to produce: ${list(facts.terminalTables, 10)}.`
        : "Every table this project builds is read again by it, so nothing here is a final output."
  });

  // Both of these are a *log* of the review, and a log read in full is a log skipped. One line each,
  // capped, with the count of what is not shown — the full record is in lineage/lineage.json.
  if (facts.lineage?.concerns.length) {
    blocks.push({ kind: "heading", level: 2, text: "Raised during lineage review" });
    for (const concern of facts.lineage.concerns.slice(0, MAX_LINEAGE_CONCERNS)) {
      blocks.push({ kind: "bullet", level: 1, text: oneLine(concern, CONCERN_CHARS) });
    }
    if (facts.lineage.concerns.length > MAX_LINEAGE_CONCERNS) {
      blocks.push({
        kind: "bullet",
        level: 1,
        text: `${facts.lineage.concerns.length - MAX_LINEAGE_CONCERNS} further point(s) are recorded in lineage/lineage.json.`
      });
    }
  }

  if (facts.lineage?.feedback.length) {
    blocks.push({ kind: "heading", level: 2, text: "Corrections made to the extracted lineage" });
    const edits = facts.lineage.feedback.flatMap((round) => round.applied);
    blocks.push({
      kind: "para",
      text:
        `The lineage above is not purely what the parser produced: it was corrected ${plural(facts.lineage.feedback.length, "time")} ` +
        `during review — ${plural(edits.length, "edge")} added or removed — and those corrections are part ` +
        "of what everything below is built on."
    });
    for (const round of facts.lineage.feedback.slice(0, MAX_FEEDBACK_ROUNDS)) {
      blocks.push({
        kind: "bullet",
        level: 1,
        text:
          `“${oneLine(round.instruction, CONCERN_CHARS)}” — ` +
          `${list(
            round.applied.map((a) => `${a.kind === "add" ? "added" : "removed"} ${a.from} → ${a.to}`),
            3
          ) || "no edge changed"}`
      });
    }
    if (facts.lineage.feedback.length > MAX_FEEDBACK_ROUNDS) {
      blocks.push({
        kind: "bullet",
        level: 1,
        text: `${facts.lineage.feedback.length - MAX_FEEDBACK_ROUNDS} further round(s) are recorded in lineage/lineage-feedback.json.`
      });
    }
  }

  return blocks;
}

function hopSection(facts: DocFacts, prose: DocProse): DocBlock[] {
  const blocks: DocBlock[] = [{ kind: "heading", level: 1, text: "Business context, layer by layer" }];

  blocks.push({
    kind: "para",
    text:
      "One section per hop — one adjacent pair of layers — covering what the transformation does to the " +
      "data, which rules it applies, and which differences between the two layers are expected rather " +
      "than a fault. This is the context a reconciliation result has to be read against."
  });

  for (const hop of facts.hops) {
    blocks.push({
      kind: "heading",
      level: 2,
      text: hop.from && hop.to ? `${hop.from.label} → ${hop.to.label}` : "Whole project"
    });

    if (hop.targets.length === 0) {
      for (const note of hop.notes) blocks.push({ kind: "para", text: note });
      continue;
    }

    const context = prose.hops.get(hop.folder);
    if (context?.context.length) {
      for (const para of context.context) blocks.push({ kind: "para", text: para });
    } else {
      const sourceCount = new Set(hop.targets.flatMap((t) => t.sources)).size;
      blocks.push({
        kind: "para",
        text:
          `${plural(hop.targets.length, "table")} ${agree(hop.targets.length, "is", "are")} built in this ` +
          `hop, from ${plural(sourceCount, "source table")}. ` +
          `${plural(hop.checkCount, "reconciliation check")} ${agree(hop.checkCount, "covers", "cover")} it.`
      });
    }

    blocks.push({
      kind: "table",
      columns: [
        { header: "Table built", mono: true, widthPct: 22 },
        { header: "Built from", mono: true, widthPct: 24 },
        { header: "Reconciled on", mono: true, widthPct: 18 },
        { header: "Measures compared", mono: true, widthPct: 18 },
        { header: "Filters applied", mono: true, widthPct: 18 }
      ],
      rows: hop.targets.map((target) => [
        target.target,
        list(target.sources, 4),
        target.key.columns.length > 0
          ? `${target.key.columns.join(", ")}${target.key.confidence === "inferred" ? " (inferred)" : ""}`
          : "—",
        dash(list(target.measureColumns, 4)),
        target.knownFilters.length === 0
          ? "—"
          : `${oneLine(target.knownFilters[0], 60)}${target.knownFilters.length > 1 ? ` (+${target.knownFilters.length - 1} more)` : ""}`
      ])
    });

    // The rule and the fragment that shows it on one line: the evidence is what makes the rule
    // checkable, and a second bullet under every rule doubled the length of this section to say it.
    if (context?.rules.length) {
      blocks.push({ kind: "heading", level: 3, text: "Rules this stage applies" });
      for (const rule of context.rules.slice(0, MAX_RULES_PER_HOP)) {
        blocks.push({
          kind: "bullet",
          level: 1,
          text:
            oneLine(rule.rule, RULE_CHARS) +
            (rule.evidence ? ` (${oneLine(rule.evidence, EVIDENCE_CHARS)})` : "")
        });
      }
    }

    const filtered = hop.targets.filter((t) => t.knownFilters.length > 0);
    if (context?.expectedDifferences.length || filtered.length > 0) {
      blocks.push({ kind: "heading", level: 3, text: "Differences to expect between the layers" });
      for (const difference of (context?.expectedDifferences ?? []).slice(0, MAX_DIFFERENCES_PER_HOP)) {
        blocks.push({ kind: "bullet", level: 1, text: oneLine(difference, RULE_CHARS) });
      }
      // A predicate lifted out of a CTE chain runs to hundreds of characters, and the same text is
      // already in the table above and in full in the script — so this names the tables and quotes at
      // most one filter, rather than reprinting every one of them.
      if (filtered.length === 1) {
        blocks.push({
          kind: "bullet",
          level: 1,
          text:
            `${filtered[0].target} applies a filter of its own (${oneLine(filtered[0].knownFilters[0], FILTER_CHARS)}), ` +
            "so it is expected to hold fewer rows than its source."
        });
      } else if (filtered.length > 1) {
        blocks.push({
          kind: "bullet",
          level: 1,
          text:
            `${list(filtered.map((t) => t.target), 5)} apply filters of their own, so each is expected to ` +
            "hold fewer rows than its source — the predicates are in the table above and in full in the " +
            "generated script."
        });
      }
    }

    // The model's watch-outs only. The derived grounding notes used to land here too and buried them
    // twenty bullets deep; they are about what the *checks* can prove, so they close the report instead.
    if (context?.watchOuts.length) {
      blocks.push({ kind: "heading", level: 3, text: "Worth watching" });
      for (const watchOut of context.watchOuts.slice(0, MAX_WATCHOUTS_PER_HOP)) {
        blocks.push({ kind: "bullet", level: 1, text: oneLine(watchOut, WATCHOUT_CHARS) });
      }
    }
  }

  return blocks;
}

/**
 * What was actually reconciled, and in what form — the section the report exists for.
 *
 * Two artifacts, described in the order they are used: the per-hop query that answers *does this stage
 * tie out*, and the per-layer report that answers *which column of which table disagrees with what it
 * was built from*. The document used to describe only the first, which left the six-column reports on
 * disk unexplained and the reader with no idea what the `type` or `comments` columns were for.
 */
function reconciliationSection(facts: DocFacts, governanceFiles: string[]): DocBlock[] {
  const blocks: DocBlock[] = [{ kind: "heading", level: 1, text: "The reconciliation performed" }];

  const layersWithRows = facts.layerReconciliation.filter((layer) => layer.columnCount > 0);

  blocks.push({
    kind: "para",
    text:
      "The pipeline is reconciled in two passes, and both are generated from the lineage described above " +
      `rather than written by hand. The first asks whether each stage ties out: ${plural(facts.stats.checkCount, "check")} ` +
      `${facts.hops.length === 1 ? "in one scope" : `across ${plural(facts.hops.length, "hop")}`}. The second ` +
      `asks the same question column by column: ${plural(facts.stats.reconciledColumnCount, "column")} ` +
      `reconciled against the source ${agree(facts.stats.reconciledColumnCount, "it was", "they were")} ` +
      `built from, ${facts.layerReconciliation.length === 1 ? "in one report" : `across ${plural(layersWithRows.length, "layer report")}`}.`
  });

  blocks.push({ kind: "heading", level: 2, text: "Stage by stage: does the hop tie out" });
  blocks.push({
    kind: "para",
    text:
      "Each hop's checks are written out as a single query that returns one row per check, so the hop is " +
      "run once and read down its status column: PASS where the numbers tie out, REVIEW where they " +
      "differ and a filter or an aggregation has to explain it, FAIL for duplicate keys, null keys, or " +
      "target rows no source accounts for. The columns are the same in every file — check_seq, scope, " +
      "target_table, source_table, check_name, metric, source_value, target_value, difference and " +
      "status — and the row-listing queries behind any count are at the foot of the same file, commented " +
      "out, for when a number needs chasing down."
  });

  blocks.push({
    kind: "table",
    columns: [
      { header: "Check", widthPct: 22 },
      { header: "What it compares", widthPct: 78 }
    ],
    rows: CHECK_GUIDE.map(([name, compares]) => [name, compares])
  });
  blocks.push({
    kind: "para",
    text:
      "Those six are derived from the columns each table declares, so they cannot name a column the " +
      "project doesn't define. Where Azure OpenAI is configured, the reviewer model adds checks written " +
      "for the specific transformation — a grain, a date window, a cast — on top of them. What a failing " +
      "check points at is in the next section."
  });

  blocks.push({
    kind: "table",
    columns: [
      { header: "Hop", widthPct: 30 },
      { header: "Tables covered", widthPct: 16 },
      { header: "Checks", widthPct: 14 },
      { header: "Script", mono: true, widthPct: 40 }
    ],
    rows: facts.hops.map((hop) => [
      hop.from && hop.to ? `${hop.from.label} → ${hop.to.label}` : "Whole project",
      String(hop.targets.length),
      String(hop.checkCount),
      `governance/${hop.folder}.sql`
    ])
  });

  blocks.push(...columnReconciliationBlocks(facts, layersWithRows));

  if (governanceFiles.length > 0) {
    blocks.push({
      kind: "para",
      text: `The generated SQL is on disk beside this report: ${list(governanceFiles, 12)}.`
    });
  } else {
    blocks.push({
      kind: "para",
      text:
        "Those scripts have not been generated in this folder yet — `reconcile scripts` (or `reconcile " +
        "run`, which confirms the lineage first) writes them, hop queries and layer reports together."
    });
  }

  return blocks;
}

/** The per-layer six-column report: what it holds, what it covers, and where each column comes from. */
function columnReconciliationBlocks(facts: DocFacts, layersWithRows: DocLayerReconFacts[]): DocBlock[] {
  const blocks: DocBlock[] = [
    { kind: "heading", level: 2, text: "Column by column: what each column was reconciled against" }
  ];

  if (layersWithRows.length === 0) {
    blocks.push({
      kind: "para",
      text:
        "No column-level reconciliation could be built for this project: it needs a table whose columns " +
        "are traceable to the columns of a table that feeds it, and no pair here provided both column " +
        "lists. The hop checks above still apply — they compare rows and totals rather than columns."
    });
    return blocks;
  }

  blocks.push({
    kind: "para",
    text:
      "Beside each hop query is one report per layer, answering the question an engineer reconciles by " +
      "hand: for every table in this layer, does each column still agree with the table it came from? " +
      "Each returns nine columns and nothing else — source_table, target_table, source_column, " +
      "target_column, type, source_value, target_value, result, comments — one row per column reconciled."
  });

  blocks.push({
    kind: "table",
    columns: [
      { header: "Column of the report", widthPct: 24 },
      { header: "What it holds", widthPct: 76 }
    ],
    rows: [
      [
        "source_table, target_table",
        "A pair the code actually relates, read out of the lineage rather than chosen — the pair is the " +
          "one the transformation reads and writes."
      ],
      [
        "source_column, target_column",
        "The same column at both ends of its lineage: the name the source declares it under, and the name " +
          "the target writes it as. Followed through the transformation, so a renamed column is compared " +
          "with the column it was really built from. The two hold the same name wherever nothing was " +
          "renamed — so where they differ, that difference is the rename, and either side can be looked " +
          "up in that table's own DDL as it stands."
      ],
      [
        "type",
        "How the code reaches the source: FROM for the driving read, LEFT JOIN, INNER JOIN and the rest " +
          "for everything joined in. This is what makes a difference interpretable rather than just visible."
      ],
      [
        "result",
        "Computed when the script runs. PASS where the two sides agree, REVIEW where they do not. A " +
          "measure is compared by its total, every other column by how many distinct values it holds — " +
          "the comparison that still means something once the transformation has grouped or joined."
      ],
      [
        "comments",
        "Empty on every PASS. On a REVIEW, what in your own transformation SQL would explain it — the " +
          "filter, the join, the CASE, the cast — quoted from the code by the reviewer model. It is a " +
          "reading of the code and not a measurement, so it is a first place to look rather than a verdict."
      ]
    ]
  });

  blocks.push({
    kind: "table",
    columns: [
      { header: "Layer", widthPct: 20 },
      { header: "Tables", widthPct: 10 },
      { header: "Source/target pairs", widthPct: 16 },
      { header: "Columns reconciled", widthPct: 16 },
      { header: "Report", mono: true, widthPct: 38 }
    ],
    rows: facts.layerReconciliation.map((layer) => [
      layer.label,
      String(layer.targetCount),
      String(layer.pairs.length),
      String(layer.columnCount),
      `governance/layers/${layer.filename}`
    ])
  });

  // A layer with a report and nothing in it is the one line of that table a reader stops on, so it says
  // why rather than leaving two zeroes to be interpreted.
  const empty = facts.layerReconciliation.filter((layer) => layer.columnCount === 0);
  if (empty.length > 0) {
    const notes = Array.from(new Set(empty.flatMap((layer) => layer.notes)));
    blocks.push({
      kind: "para",
      text:
        `${list(empty.map((layer) => layer.label), 6)} ${agree(empty.length, "reconciles", "reconcile")} ` +
        "nothing: no table there is built from another table this project can see, so there is no pair to " +
        `compare. ${notes.length > 0 ? `${oneLine(notes[0], CONCERN_CHARS)} ` : ""}` +
        `${agree(empty.length, "Its report says", "Their reports say")} the same when run.`
    });
  }

  // The pairs themselves, which is the part a reviewer checks: these are the relationships the report
  // asserts, and a wrong one here is a wrong one in every row of the script it produces.
  for (const layer of layersWithRows) {
    blocks.push({ kind: "heading", level: 3, text: `${layer.label}: what is compared with what` });
    blocks.push({
      kind: "table",
      columns: [
        { header: "Target table", mono: true, widthPct: 30 },
        { header: "Reconciled against", mono: true, widthPct: 30 },
        { header: "Reached by", widthPct: 18 },
        { header: "Columns", widthPct: 11 },
        { header: "Totalled", widthPct: 11 }
      ],
      rows: layer.pairs
        .slice(0, MAX_PAIR_ROWS)
        .map((pair) => [
          pair.target,
          pair.source,
          pair.joinType,
          String(pair.columnCount),
          String(pair.measureCount)
        ])
    });
    if (layer.pairs.length > MAX_PAIR_ROWS) {
      blocks.push({
        kind: "para",
        text: `${layer.pairs.length - MAX_PAIR_ROWS} further pair(s) in this layer are reconciled by the same report.`
      });
    }
  }

  return blocks;
}

/**
 * `a, b or c` — for the sentences naming which checks send you to a query.
 *
 * Separate from `list` above, which is for inventories where a trailing conjunction would read oddly
 * ("tables x, y and z" is a set; "run this when x, y fails" is a sentence and needs the word).
 */
function orList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

/** The order the guide reads in — the order someone works in, not the order the enum declares. */
const GUIDE_ORDER: ReconCheckKind[] = [
  "row_count",
  "measure_totals",
  "missing_keys",
  "orphan_keys",
  "duplicate_keys",
  "null_keys",
  "category_values",
  "custom"
];

/**
 * What to do when a check does not tie out — the section that turns a REVIEW into a next action.
 *
 * Everything structural about this report says whether the pipeline ties out. This is the only part
 * that says what to do when it doesn't, and it is deliberately the last thing before the open
 * questions: by here the reader knows the layers, the lineage and the checks, so a drill-down naming
 * two of their own tables reads as a next step rather than as more generated SQL.
 *
 * **The drill-downs follow the issues.** Every table used to get its queries printed whether or not
 * anything about it was in doubt, which is a query dump however it is titled — and it costs the reader
 * the very distinction the section exists to draw, between the table reconciled on a declared key and
 * the one reconciled on a guess. So `concernsFor` decides who appears here: nothing flagged, nothing
 * printed, and the count of clean tables said out loud instead.
 *
 * The queries are written into the report rather than into the scripts on purpose. A reconciliation
 * file is run and read down its status column; padding it with diagnostics for failures that mostly
 * won't happen is how it stops being read. Here they cost nothing until they are needed.
 */
function troubleshootingSection(plan: TroubleshootingPlan): DocBlock[] {
  const blocks: DocBlock[] = [{ kind: "heading", level: 1, text: "If a check does not tie out" }];

  blocks.push({
    kind: "para",
    text:
      "A REVIEW or FAIL row names the table, the source and the metric, but not the cause. This section " +
      "is the step after that: what each kind of difference usually comes from, and — for the tables " +
      "where something here rests on an assumption — the query to run next, so a difference can be " +
      "chased down without anyone rewriting the join by hand."
  });

  blocks.push({ kind: "heading", level: 2, text: "Where to start, by check" });
  blocks.push({
    kind: "table",
    columns: [
      { header: "Check", widthPct: 16 },
      { header: "Suspect first", widthPct: 42 },
      { header: "Next step", widthPct: 42 }
    ],
    rows: GUIDE_ORDER.map((kind) => [KIND_LABELS[kind], FAILURE_GUIDE[kind].suspect, FAILURE_GUIDE[kind].nextStep])
  });

  blocks.push({ kind: "heading", level: 2, text: "Why a column-level row comes back REVIEW" });
  blocks.push({
    kind: "para",
    text:
      "The per-layer reports are read a row at a time, and each row already carries the two facts that " +
      "narrow the cause: what is being compared, and how the code reaches the source. Read the row " +
      "against this table first, then read its comments column, which names the fragment of your own SQL " +
      "that would explain it."
  });
  blocks.push({
    kind: "table",
    columns: [
      { header: "What the row shows", widthPct: 32 },
      { header: "What a REVIEW usually comes from", widthPct: 68 }
    ],
    rows: LAYER_REVIEW_GUIDE.map((cause) => [cause.signal, cause.meaning])
  });
  blocks.push({
    kind: "para",
    text:
      "Grouping and aggregation are the one difference already accounted for: a measure is compared by " +
      "its total and every other column by its distinct values, both of which survive a GROUP BY. A row " +
      "that reviews under an aggregating transformation is a value that changed, not a row that was " +
      "collapsed."
  });

  blocks.push({ kind: "heading", level: 2, text: "Points to check in this pipeline" });

  if (plan.targets.length === 0) {
    blocks.push({
      kind: "para",
      text:
        plan.clean > 0
          ? `Nothing was flagged. All ${plural(plan.clean, "table")} reconciled here join on a key the ` +
            "project declares, against sources whose columns are all recoverable, so no drill-down " +
            "queries are included — the guidance above is enough if a check does come back REVIEW."
          : "No table in this project could be paired with a source, so there is nothing to flag and " +
            "nothing to drill into. The layer sections above say why."
    });
    return blocks;
  }

  blocks.push({
    kind: "para",
    text:
      `${plural(plan.targets.length, "table")} ${agree(plan.targets.length, "rests", "rest")} on something ` +
      "this project does not state outright — a key inferred from column naming, a source whose columns " +
      "could not be read, a lookup assumed to hold one row per key. None of these is a fault in itself; " +
      "each is a place where a check could pass or fail for a reason that has nothing to do with the " +
      `data.${plan.clean > 0 ? ` The other ${plural(plan.clean, "table")} had nothing to flag.` : ""}`
  });

  // Grouped by what is assumed rather than listed per table: the same sentence written out once per
  // table is the fastest way to make a findings table stop being read.
  blocks.push({
    kind: "table",
    columns: [
      { header: "What rests on an assumption", widthPct: 38 },
      { header: "Where", mono: true, widthPct: 30 },
      { header: "Suggested action", widthPct: 32 }
    ],
    rows: groupConcerns(plan.targets).map((group) => [
      group.issue,
      list(group.tables, MAX_TABLES_PER_CONCERN),
      group.suggestion
    ])
  });

  if (plan.shown > 0) {
    blocks.push({
      kind: "para",
      text:
        `${plural(plan.shown, "query", "queries")} follow, one group per table, built from the same lineage ` +
        "and column lists as the checks themselves — so every table and column named is one this project " +
        "defines. They are read-only and portable, the same SQL on SQL Server and Databricks SQL. Work " +
        "down each table in the order given: prove the joins are clean before believing what the totals " +
        "say, because one source that fans out fails every other check at once."
    });
  }

  for (const entry of plan.targets) {
    if (entry.queries.length === 0) continue;
    blocks.push({ kind: "heading", level: 3, text: `${entry.target} (${entry.hopLabel})` });
    for (const query of entry.queries) {
      // Level 4 so the queries don't each claim a line in the table of contents, which lists 1 and 2.
      blocks.push({ kind: "heading", level: 4, text: query.title });
      blocks.push({
        kind: "para",
        text:
          `Run this when ${orList(query.triggeredBy.map((kind) => KIND_LABELS[kind].toLowerCase()))} ` +
          `${agree(query.triggeredBy.length, "fails", "fail")}. ${query.reading}`
      });
      blocks.push({ kind: "code", text: query.sql });
    }
  }

  if (plan.omitted > 0) {
    blocks.push({
      kind: "para",
      text:
        `${plural(plan.omitted, "further query", "further queries")} of the same shapes were left out to keep this ` +
        "section readable. The patterns above are identical for every table — copy the nearest one and " +
        "change the table and key names."
    });
  }

  if (plan.withoutQueries.length > 0) {
    blocks.push({
      kind: "para",
      text:
        `No drill-down could be built for ${list(plan.withoutQueries, 8)} — these have no recoverable join ` +
        "key between target and source, which is the same reason their row-level checks are limited."
    });
  }

  return blocks;
}

function risksSection(facts: DocFacts, prose: DocProse): DocBlock[] {
  const blocks: DocBlock[] = [{ kind: "heading", level: 1, text: "Gaps and open questions" }];

  const gaps: string[] = [];
  if (facts.stats.inferredKeyCount > 0) {
    gaps.push(
      `${plural(facts.stats.inferredKeyCount, "table")} ${agree(facts.stats.inferredKeyCount, "is", "are")} ` +
        "reconciled on a key inferred from column naming rather than one the project declares. Confirm " +
        "those keys before trusting their row-level checks."
    );
  }
  if (facts.stats.tablesWithoutColumns > 0) {
    gaps.push(
      `${plural(facts.stats.tablesWithoutColumns, "table")} ${agree(facts.stats.tablesWithoutColumns, "has", "have")} ` +
        "no recoverable column list — nothing in this project defines them with CREATE TABLE or builds " +
        "them with a named select list — so only their row counts can be checked."
    );
  }
  if (facts.skipped.length > 0) {
    gaps.push(
      `${plural(facts.skipped.length, "file")} in the folder could not be parsed and took no part in this ` +
        "document; they are listed in the appendix."
    );
  }
  if (facts.unassignedSchemas.length > 0) {
    gaps.push(
      `Tables in ${list(facts.unassignedSchemas, 6)} belong to no layer, so no hop reconciles them.`
    );
  }
  if (facts.hops.some((hop) => hop.targets.length === 0)) {
    gaps.push(
      "At least one hop has no table to reconcile, which usually means the layer names don't match the " +
        "schemas the SQL actually uses."
    );
  }
  if (!facts.lineage) {
    gaps.push(
      "The lineage in this document was extracted for it and never reviewed. `reconcile run` walks " +
        "through it edge by edge and records the approval."
    );
  }

  for (const risk of prose.project.risks) blocks.push({ kind: "bullet", level: 1, text: oneLine(risk, RULE_CHARS) });
  for (const gap of gaps) blocks.push({ kind: "bullet", level: 1, text: gap });
  if (prose.project.risks.length === 0 && gaps.length === 0) {
    blocks.push({
      kind: "para",
      text:
        "Nothing was left unresolved in the scan: every table in scope has a column list, every key is " +
        "declared, and every file parsed."
    });
  }

  // What the generated checks do *not* cover, table by table. These are the notes each script already
  // carries in its own header; collected here, first sentence only, they are the honest answer to "so
  // what wasn't checked?" — and they are not repeated per hop, where twenty of them buried the three
  // sentences of business context above them.
  const limits = groupedNotes(facts.hops.flatMap((hop) => hop.targets));
  if (limits.length > 0) {
    blocks.push({ kind: "heading", level: 2, text: "What these checks do not cover" });
    for (const limit of limits.slice(0, MAX_LIMIT_NOTES)) {
      blocks.push({ kind: "bullet", level: 1, text: limit });
    }
    if (limits.length > MAX_LIMIT_NOTES) {
      blocks.push({
        kind: "bullet",
        level: 1,
        text:
          `${limits.length - MAX_LIMIT_NOTES} further note(s) of the same kinds are in the header of the ` +
          "generated script for the table they concern."
      });
    }
  }

  return blocks;
}

function appendixSection(facts: DocFacts): DocBlock[] {
  const blocks: DocBlock[] = [
    { kind: "pageBreak" },
    { kind: "heading", level: 1, text: "Appendix: files scanned" },
    {
      kind: "table",
      columns: [
        { header: "File", mono: true, widthPct: 44 },
        { header: "Statements", widthPct: 12 },
        { header: "Builds", mono: true, widthPct: 22 },
        { header: "Reads", mono: true, widthPct: 22 }
      ],
      rows: facts.files
        .slice(0, MAX_FILE_ROWS)
        .map((file) => [file.path, String(file.statementCount), dash(list(file.writes, 3)), dash(list(file.reads, 3))])
    }
  ];

  if (facts.files.length > MAX_FILE_ROWS) {
    blocks.push({
      kind: "para",
      text: `${facts.files.length - MAX_FILE_ROWS} further file(s) were scanned but are not listed here.`
    });
  }

  if (facts.skipped.length > 0) {
    blocks.push({ kind: "heading", level: 2, text: "Files that could not be parsed" });
    blocks.push({
      kind: "table",
      columns: [
        { header: "File", mono: true, widthPct: 60 },
        { header: "Why", widthPct: 40 }
      ],
      rows: facts.skipped.slice(0, MAX_SKIPPED_ROWS).map((s) => [s.path, s.reason])
    });
  }

  blocks.push({ kind: "heading", level: 1, text: "Appendix: table inventory" });
  blocks.push({
    kind: "table",
    columns: [
      { header: "Table", mono: true, widthPct: 46 },
      { header: "Looks like", widthPct: 18 },
      { header: "Built here", widthPct: 18 },
      { header: "Read here", widthPct: 18 }
    ],
    rows: facts.inventory
      .slice(0, MAX_INVENTORY_ROWS)
      .map((t) => [t.qualified, t.kind, t.written ? "Yes" : "No", t.read ? "Yes" : "No"])
  });
  if (facts.inventory.length > MAX_INVENTORY_ROWS) {
    blocks.push({
      kind: "para",
      text: `${facts.inventory.length - MAX_INVENTORY_ROWS} further table(s) were discovered but are not listed here.`
    });
  }

  return blocks;
}

/** `optum_arr_build` -> `Optum arr build`, so the cover page reads as a title rather than a path. */
export function humanizeProjectName(folderName: string): string {
  const words = folderName.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  if (words.length === 0) return "Data pipeline";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Assembles the report: cover, contents, and the sections in the order a reader needs them — what this
 * pipeline is, what sits in each layer and what it is for, how the data flows, what each stage means,
 * what was reconciled and how, what to do when a check doesn't tie out, and what is still open. Pure,
 * so the assembly is testable without a model or a template.
 */
export function buildDocumentationModel(
  facts: DocFacts,
  prose: DocProse,
  options: { generatedAt: Date; governanceFiles?: string[] }
): DocDocument {
  // Derived from the same target facts the checks are, so a drill-down can only name a column the
  // project defines — and needs no model, so it is one section that cannot arrive empty.
  const troubleshooting = buildTroubleshootingPlan(
    facts.hops.map((hop) => ({ label: hop.label, targets: hop.targets }))
  );

  const blocks: DocBlock[] = [
    ...introSection(facts, prose, options.generatedAt),
    ...layerSection(facts, prose),
    ...lineageSection(facts, prose),
    ...hopSection(facts, prose),
    ...reconciliationSection(facts, options.governanceFiles ?? []),
    ...troubleshootingSection(troubleshooting),
    ...risksSection(facts, prose),
    ...appendixSection(facts)
  ];

  const generated = options.generatedAt.toISOString().slice(0, 10);
  return withTableOfContents({
    title: `${humanizeProjectName(facts.projectName)} data pipeline`,
    subtitle: `Lineage, business context and reconciliation · generated ${generated} by Recon`,
    blocks
  });
}

export interface BuildDocumentationOptions {
  scanRoot: string;
  useAi: boolean;
  lineage: LineageArtifacts | null;
  /** Names of the reconciliation scripts already on disk, so the document can point at them. */
  governanceFiles?: string[];
  generatedAt?: Date;
  onProgress?: (message: string) => void;
}

export interface DocumentationResult {
  doc: DocDocument;
  facts: DocFacts;
  notices: string[];
  usedAi: boolean;
}

/** Facts, then prose, then the document. The one entry point the CLI needs. */
export async function buildDocumentation(
  project: LocalProject,
  layers: LayerRef[],
  options: BuildDocumentationOptions
): Promise<DocumentationResult> {
  const generatedAt = options.generatedAt ?? new Date();
  const facts = gatherDocumentationFacts(project, layers, options.lineage, options.scanRoot);
  const prose = await fetchDocumentationProse(facts, { useAi: options.useAi, onProgress: options.onProgress });
  const doc = buildDocumentationModel(facts, prose, {
    generatedAt,
    governanceFiles: options.governanceFiles
  });
  return { doc, facts, notices: prose.notices, usedAi: prose.usedAi };
}
