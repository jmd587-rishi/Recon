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
import { unassignedSchemas } from "./layers.js";
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
  gatherReconciliationFacts,
  templateChecks,
  type ReconTargetFacts
} from "./reconciliationScripts.js";
import {
  buildTroubleshootingPlan,
  FAILURE_GUIDE,
  KIND_LABELS,
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
  const layerBySchema = new Map(layers.map((layer) => [layer.schema.toLowerCase(), layer]));
  return project.scan.tables.map((table) => ({
    qualified: table.qualified,
    name: table.name,
    kind: classifyTable(table.name, table.schema ? layerBySchema.get(table.schema.toLowerCase()) : undefined),
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
    const tables = inventory.filter(
      (t) => qualifiedSchema(t.qualified)?.toLowerCase() === layer.schema.toLowerCase()
    );
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

  const allTargets = docHops.flatMap((hop) => hop.targets);

  return {
    projectName: project.folderName,
    scanRoot,
    layers: layerFacts,
    unassignedSchemas: unassignedSchemas(project.scan.schemas, layers),
    unqualifiedTables: inventory.filter((t) => qualifiedSchema(t.qualified) === null).map((t) => t.qualified),
    edges: project.scan.lineage,
    externalInputs: inventory.filter((t) => t.read && !t.written).map((t) => t.qualified),
    terminalTables: inventory.filter((t) => t.written && !t.read).map((t) => t.qualified),
    hops: docHops,
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
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Groups the gap notes by what they say, so a note true of every table in the hop is made once.
 *
 * Six tables missing a measure column is one fact about the hop, not six about its tables, and reading
 * it six times obscures the notes that *are* table-specific.
 */
function groupedNotes(targets: ReconTargetFacts[]): string[] {
  const byNote = new Map<string, string[]>();
  for (const target of targets) {
    for (const note of target.notes) {
      byNote.set(note, [...(byNote.get(note) ?? []), target.target]);
    }
  }
  return Array.from(byNote.entries()).map(([note, tables]) => `${list(tables, 5)} — ${note}`);
}

/** The kinds of check `reconcile scripts` derives, and what each one proves. Kept in step with `templateChecks`. */
const CHECK_GUIDE: [string, string, string][] = [
  [
    "Row count",
    "Rows in the table against rows in each table that feeds it.",
    "A difference the transformation's own filters don't account for."
  ],
  [
    "Measure totals",
    "The sum of every numeric column both sides share.",
    "Rows survived but values changed — a cast, a join fan-out, or a lost decimal."
  ],
  [
    "Missing keys",
    "Keys present in the source with no matching row in the target.",
    "Records were dropped somewhere in the transformation."
  ],
  [
    "Orphan keys",
    "Keys in the target that no source accounts for.",
    "Rows appeared from somewhere the lineage doesn't record."
  ],
  [
    "Duplicate keys",
    "The same key appearing more than once in the target.",
    "The grain isn't what the key says it is — usually a join that fanned out."
  ],
  [
    "Null keys",
    "Rows whose key columns are NULL.",
    "Rows that can never be reconciled or joined to, downstream."
  ]
];

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
            `${facts.layers.map((l) => l.layer.label).join(" then ")} — and this document describes each ` +
            "of those stages, the lineage between them, and the reconciliation that proves the data survived the trip."
          : "This document describes its tables, the lineage between them, and the reconciliation that " +
            "proves the data survived the transformations.")
    });
  }

  blocks.push({ kind: "heading", level: 2, text: "What was scanned" });
  blocks.push({
    kind: "table",
    columns: [
      { header: "Detail", widthPct: 34 },
      { header: "Value", widthPct: 66 }
    ],
    rows: [
      ["Project", facts.projectName],
      ["Folder scanned", facts.scanRoot],
      ["Generated", generatedAt.toISOString().replace("T", " ").slice(0, 16)],
      ["Files read", String(facts.stats.fileCount)],
      ["SQL statements parsed", String(facts.stats.statementCount)],
      ["Tables discovered", String(facts.stats.tableCount)],
      ["Schemas", String(facts.stats.schemaCount)],
      ["Lineage edges", String(facts.stats.edgeCount)],
      ["Pipeline layers", String(facts.stats.layerCount)],
      ["Reconciliation checks derived", String(facts.stats.checkCount)],
      [
        "Lineage",
        facts.lineage
          ? `${facts.lineage.approved ? "Reviewed and approved" : "Reviewed, not approved"} on ${facts.lineage.generatedAt.slice(0, 10)}` +
            (facts.lineage.feedback.length > 0
              ? ` after ${plural(facts.lineage.feedback.length, "round")} of corrections`
              : "")
          : "Extracted from the SQL for this document; not reviewed"
      ],
      ["Written explanations", prose.usedAi ? "Reviewer model, from the project's own SQL" : "Not included"]
    ]
  });

  blocks.push({ kind: "heading", level: 2, text: "How to read this document" });
  const guide: string[] = [
    "The layers and the lineage are parsed from the SQL in the folder above. Nothing was measured " +
      "against a live database, so there are no row counts here — only what the code says it does.",
    "The reconciliation checks are derived from the columns each table declares, so a check names a " +
      "column only if the project defines it.",
    "A join key marked inferred was guessed from column naming, not declared by a primary key. The " +
      "duplicate-key check in the same script is what confirms or disproves that guess."
  ];
  if (prose.usedAi) {
    guide.push(
      "The written explanations were produced by a reviewer model reading the same SQL, and are the one " +
        "part of this document to read sceptically: they say what the code appears to be for, which is " +
        "an interpretation, not a fact."
    );
  }
  for (const text of guide) blocks.push({ kind: "bullet", level: 1, text });

  return blocks;
}

function layerSection(facts: DocFacts, prose: DocProse): DocBlock[] {
  const blocks: DocBlock[] = [{ kind: "heading", level: 1, text: "Pipeline layers" }];

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
      blocks.push({
        kind: "table",
        columns: [
          { header: "Table", mono: true, widthPct: 46 },
          { header: "Looks like", widthPct: 18 },
          { header: "Built here", widthPct: 18 },
          { header: "Read downstream", widthPct: 18 }
        ],
        rows: tables
          .slice(0, MAX_LAYER_TABLE_ROWS)
          .map((t) => [t.name, t.kind, t.written ? "Yes" : "No", t.read ? "Yes" : "No"])
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

  if (facts.lineage?.concerns.length) {
    blocks.push({ kind: "heading", level: 2, text: "Raised during lineage review" });
    for (const concern of facts.lineage.concerns) blocks.push({ kind: "bullet", level: 1, text: concern });
  }

  if (facts.lineage?.feedback.length) {
    blocks.push({ kind: "heading", level: 2, text: "Corrections made to the extracted lineage" });
    blocks.push({
      kind: "para",
      text:
        `The lineage above is not purely what the parser produced: it was corrected ${plural(facts.lineage.feedback.length, "time")} ` +
        "during review, and those corrections are part of what everything below is built on."
    });
    for (const round of facts.lineage.feedback) {
      blocks.push({ kind: "bullet", level: 1, text: `“${round.instruction}”` });
      for (const applied of round.applied) {
        blocks.push({
          kind: "bullet",
          level: 2,
          text: `${applied.kind === "add" ? "Added" : "Removed"} ${applied.from} → ${applied.to} — ${applied.reason}`
        });
      }
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

    if (context?.rules.length) {
      blocks.push({ kind: "heading", level: 3, text: "Rules this stage applies" });
      for (const rule of context.rules) {
        blocks.push({ kind: "bullet", level: 1, text: rule.rule });
        if (rule.evidence) blocks.push({ kind: "bullet", level: 2, text: `From the code: ${rule.evidence}` });
      }
    }

    const filtered = hop.targets.filter((t) => t.knownFilters.length > 0);
    if (context?.expectedDifferences.length || filtered.length > 0) {
      blocks.push({ kind: "heading", level: 3, text: "Differences to expect between the layers" });
      for (const difference of context?.expectedDifferences ?? []) {
        blocks.push({ kind: "bullet", level: 1, text: difference });
      }
      for (const target of filtered) {
        blocks.push({
          kind: "bullet",
          level: 1,
          text: `${target.target} is built with a filter, so it is expected to hold fewer rows than its source:`
        });
        for (const filter of target.knownFilters) {
          blocks.push({ kind: "bullet", level: 2, text: oneLine(filter, 240) });
        }
      }
    }

    const gaps = groupedNotes(hop.targets);
    if (context?.watchOuts.length || gaps.length > 0) {
      blocks.push({ kind: "heading", level: 3, text: "Worth watching" });
      for (const watchOut of context?.watchOuts ?? []) blocks.push({ kind: "bullet", level: 1, text: watchOut });
      for (const gap of gaps) blocks.push({ kind: "bullet", level: 1, text: gap });
    }
  }

  return blocks;
}

function reconciliationSection(facts: DocFacts, governanceFiles: string[]): DocBlock[] {
  const blocks: DocBlock[] = [{ kind: "heading", level: 1, text: "How the pipeline is reconciled" }];

  blocks.push({
    kind: "para",
    text:
      `Recon derives ${plural(facts.stats.checkCount, "check")} for this project, ` +
      `${facts.hops.length === 1 ? "in one scope" : `across ${plural(facts.hops.length, "hop")}`}. ` +
      "Each hop's checks are written out as a single query that returns one row per check, so the hop is " +
      "run once and read down its status column: PASS where the numbers tie out, REVIEW where they " +
      "differ and a filter or an aggregation has to explain it, FAIL for duplicate keys, null keys, or " +
      "target rows no source accounts for."
  });
  blocks.push({
    kind: "para",
    text:
      "The columns are the same in every file: check_seq, scope, target_table, source_table, " +
      "check_name, metric, source_value, target_value, difference and status. The row-listing queries " +
      "behind any count are at the foot of the same file, commented out, for when a number needs chasing down."
  });

  blocks.push({ kind: "heading", level: 2, text: "What each check proves" });
  blocks.push({
    kind: "table",
    columns: [
      { header: "Check", widthPct: 18 },
      { header: "What it compares", widthPct: 41 },
      { header: "What a failure means", widthPct: 41 }
    ],
    rows: CHECK_GUIDE.map(([name, compares, failure]) => [name, compares, failure])
  });
  blocks.push({
    kind: "para",
    text:
      "Those six are derived from the columns each table declares, so they cannot name a column the " +
      "project doesn't define. Where Azure OpenAI is configured, the reviewer model adds checks written " +
      "for the specific transformation — a grain, a date window, a cast — on top of them."
  });

  blocks.push({ kind: "heading", level: 2, text: "Coverage by hop" });
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

  if (governanceFiles.length > 0) {
    blocks.push({
      kind: "para",
      text: `The generated SQL is on disk beside this document: ${list(governanceFiles, 12)}.`
    });
  } else {
    blocks.push({
      kind: "para",
      text:
        "Those scripts have not been generated in this folder yet — `reconcile scripts` (or `reconcile " +
        "run`, which confirms the lineage first) writes them."
    });
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
 * What to do when a check fails — the section that turns a REVIEW into a next action.
 *
 * Everything structural about this document says whether the pipeline ties out. This is the only part
 * that says what to do when it doesn't, and it is deliberately the last thing before the open
 * questions: by here the reader knows the layers, the lineage and the checks, so a drill-down naming
 * two of their own tables reads as a next step rather than as more generated SQL.
 *
 * The queries are written into the document rather than into the scripts on purpose. A reconciliation
 * file is run and read down its status column; padding it with diagnostics for failures that mostly
 * won't happen is how it stops being read. Here they cost nothing until they are needed.
 */
function troubleshootingSection(plan: TroubleshootingPlan): DocBlock[] {
  const blocks: DocBlock[] = [{ kind: "heading", level: 1, text: "If a check fails" }];

  blocks.push({
    kind: "para",
    text:
      "A REVIEW or FAIL row names the table, the source and the metric, but not the cause. This section " +
      "is the step after that: what each kind of failure usually means, and — for this project's own " +
      "tables — the query to run next, so a difference can be chased down without anyone rewriting the " +
      "join by hand."
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

  if (plan.targets.length === 0) {
    blocks.push({
      kind: "para",
      text:
        "No drill-down queries could be built for this project: they are keyed on the join columns " +
        "between a target and its sources, and none were recoverable here. The guidance above still " +
        "applies — the queries would only have saved the typing."
    });
    return blocks;
  }

  blocks.push({ kind: "heading", level: 2, text: "Ready-made drill-down queries" });
  blocks.push({
    kind: "para",
    text:
      `${plural(plan.shown, "query", "queries")} for ${plural(plan.targets.length, "table")}, built from the same ` +
      "lineage and column lists as the checks themselves, so every table and column named below is one " +
      "this project defines. They are read-only and portable — the same SQL runs on SQL Server and " +
      "Databricks SQL. Work down each table in the order given: prove the joins are clean before " +
      "believing what the totals say, because one source that fans out fails every other check at once."
  });

  for (const entry of plan.targets) {
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

  for (const risk of prose.project.risks) blocks.push({ kind: "bullet", level: 1, text: risk });
  for (const gap of gaps) blocks.push({ kind: "bullet", level: 1, text: gap });
  if (prose.project.risks.length === 0 && gaps.length === 0) {
    blocks.push({
      kind: "para",
      text:
        "Nothing was left unresolved in the scan: every table in scope has a column list, every key is " +
        "declared, and every file parsed."
    });
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
 * Assembles the document: cover, contents, and the sections in the order a reader needs them —
 * what this is, how it's laid out, how the data flows, what each stage means, how it is proved, what
 * to do when it isn't, and what is still open. Pure, so the assembly is testable without a model or a
 * template.
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
