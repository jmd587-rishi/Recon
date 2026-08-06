#!/usr/bin/env node
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAiReconciliationSuite } from "../services/aiReconciliation.js";
import { buildDocumentation } from "../services/documentation.js";
import {
  buildLayerReconciliation,
  summarizeLayerReconciliation
} from "../services/layerReconciliation.js";
import { detectLayers, unassignedSchemas } from "../services/layers.js";
import { LlmConfigError } from "../services/llmClient.js";
import type { LocalProject } from "../services/localProject.js";
import { buildReconciliationSuite } from "../services/reconciliationScripts.js";
import { buildLocalProject, collectSourceFiles } from "./collectSourceFiles.js";
import { describeDiagrams, writeDiagramArtifacts } from "./diagramArtifacts.js";
import {
  applyApprovedLineage,
  findTemplate,
  listGovernanceFiles,
  writeDocumentArtifacts
} from "./documentArtifacts.js";
import {
  askChoice,
  canPrompt,
  openPromptSession,
  readLineageArtifacts,
  verifyLineage,
  writeLineageArtifacts,
  type PromptSession,
  type VerifyOptions
} from "./lineagePrompt.js";
import type { LayerRef, LineageArtifacts, LocalReconciliationSuite } from "../types/index.js";

/**
 * `reconcile scripts` — the L4 tab (`/local/reconciliation` in the running app) as a standalone
 * command, for a data engineering project that was never uploaded anywhere. Same services, same
 * two-tier checks (`reconciliationScripts.templateChecks` derived from the columns, plus whatever
 * `aiReconciliation.ts` can add from reading the transformation SQL), same fallback when Azure OpenAI
 * isn't configured — just reading straight off disk and writing straight back to disk instead of
 * going through the browser's upload/zip round trip.
 *
 * What lands on disk is one `.sql` per hop: `reconciliationBundle.ts`'s single query, which returns
 * the hop's whole reconciliation as one status table. The per-table scripts the same suite carries
 * are written only on `--split` — one file you can run beats a folder you have to work through.
 *
 * `reconcile run` puts a gate in front of that. The reconciliation scripts are only as good as the
 * lineage they're derived from, and that lineage is parsed out of the SQL by heuristics that a real
 * project can defeat, so `run` draws the lineage first, asks the user to confirm it, and only writes
 * scripts once they have. Corrections are applied to the underlying facts (`lineageOverrides.ts`),
 * not just to the picture, so approving the diagram approves what the scripts are actually built on.
 *
 * `reconcile layers` runs only the scan + layer-detection step, so a schema-naming convention the
 * heuristic doesn't recognise can be sorted out with `--layers` before spending an LLM call on it.
 *
 * `reconcile document` writes the whole thing up — the project, its layers, its lineage, what each hop
 * means for the data, and the reconciliation behind it — into the branded Word template plus a
 * Markdown copy. It reads whatever the other commands have already left in the folder (the approved
 * lineage, the generated scripts) so the document describes the run rather than a fresh guess at it.
 * `run` offers it as its last question, since by then everything it would read is in memory already —
 * the template comes bundled with this package, so there is nothing to supply for that to work.
 *
 * `reconcile diagrams` writes the lineage as things you can paste: a .pptx whose every table is a real
 * PowerPoint shape with editable text and whose every arrow is a connector bound to the shapes it joins,
 * plus one Office-importable .svg per component. The split is by hop, with the same names the governance
 * folder uses, so `bronze_to_silver.svg` and `bronze_to_silver.sql` are the same hop. It needs no LLM and
 * no `.env` at all — the shapes are derived from the graph — so it is the one command that cannot
 * degrade. `document` writes them too, since a write-up without its diagrams is half delivered.
 */

const USAGE = `
reconcile <command> [options]

Commands:
  run         Layers, lineage, scripts and — if you say yes — the document, in one pass
  scripts     Write one reconciliation query per hop into a governance/ folder
  document    Write the whole pipeline up as a Word document and a Markdown file
  diagrams    Write the lineage as editable PowerPoint shapes and Office-ready SVGs
  layers      Detect and print the pipeline layers only — writes nothing

Options:
  --dir <path>        Project folder to scan (default: current directory)
  --out <name>         Output folder name, created under --dir (default: governance)
  --lineage-out <name> Folder for the lineage diagram and data (default: lineage)
  --doc-out <name>    document: folder for the document (default: documentation)
  --diagrams-out <name> Folder for the deck and the SVGs (default: diagrams)
  --no-diagrams       document: skip the diagrams that normally accompany it
  --template <path>   Word template to render into (default: the one bundled with Recon)
  --layers a,b,c      Schema names, most-raw first, overriding auto-detection
  --env-file <path>   .env file with AZURE_OPENAI_* settings (default: <dir>/.env, then ./.env)
  --no-ai             Skip the reviewer model — write only the schema-derived standard checks
  --no-notebooks      Read .sql files only, ignoring Databricks notebooks
  --auto-approve      run: accept the extracted lineage without prompting (for CI)
  --document          run: write the document too, without asking
  --no-document       run: stop after the scripts, without asking
  --no-open           run: don't try to open the diagram in a browser
  --split             Also write the per-table scripts, a folder per hop, beside each query
  --one-file          Fold every hop into a single reconciliation.sql instead of one file per hop
  --max-files <n>     Cap on how many files are read (default: ${5000})
  -h, --help          Show this help

Examples:
  cd C:\\projects\\my-warehouse
  reconcile run
  reconcile layers
  reconcile scripts
  reconcile document
  reconcile diagrams
  reconcile run --layers raw,staged,mart --out recon
  reconcile run --auto-approve --document
  reconcile scripts --split
`.trim();

interface Args {
  command: "run" | "scripts" | "document" | "diagrams" | "layers" | "help";
  dir: string;
  out: string;
  lineageOut: string;
  docOut: string;
  diagramsOut: string;
  template: string | null;
  layers: string[] | null;
  envFile: string | null;
  useAi: boolean;
  includeNotebooks: boolean;
  autoApprove: boolean;
  /** run: true/false force it either way, null asks once the scripts are written. */
  document: boolean | null;
  /** document: whether the diagrams accompany it. `diagrams` writes them regardless. */
  diagrams: boolean;
  noOpen: boolean;
  split: boolean;
  oneFile: boolean;
  maxFiles: number | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "help",
    dir: process.cwd(),
    out: "governance",
    lineageOut: "lineage",
    docOut: "documentation",
    diagramsOut: "diagrams",
    template: null,
    layers: null,
    envFile: null,
    useAi: true,
    includeNotebooks: true,
    autoApprove: false,
    document: null,
    diagrams: true,
    noOpen: false,
    split: false,
    oneFile: false,
    maxFiles: undefined
  };

  const rest = [...argv];
  const first = rest[0];
  if (
    first === "run" ||
    first === "scripts" ||
    first === "document" ||
    first === "diagrams" ||
    first === "layers"
  ) {
    args.command = first;
    rest.shift();
  } else if (first === "-h" || first === "--help" || first === undefined) {
    args.command = "help";
    if (first !== undefined) rest.shift();
  } else {
    console.error(`Unknown command "${first}".\n`);
    args.command = "help";
  }

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const next = () => rest[++i];
    switch (flag) {
      case "--dir":
        args.dir = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--lineage-out":
        args.lineageOut = next();
        break;
      case "--doc-out":
        args.docOut = next();
        break;
      case "--diagrams-out":
        args.diagramsOut = next();
        break;
      case "--no-diagrams":
        args.diagrams = false;
        break;
      case "--template":
        args.template = next();
        break;
      case "--layers":
        args.layers = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--env-file":
        args.envFile = next();
        break;
      case "--no-ai":
        args.useAi = false;
        break;
      case "--no-notebooks":
        args.includeNotebooks = false;
        break;
      case "--auto-approve":
        args.autoApprove = true;
        break;
      case "--document":
        args.document = true;
        break;
      case "--no-document":
        args.document = false;
        break;
      case "--no-open":
        args.noOpen = true;
        break;
      case "--split":
        args.split = true;
        break;
      case "--one-file":
        args.oneFile = true;
        break;
      case "--max-files":
        args.maxFiles = Number(next());
        break;
      case "-h":
      case "--help":
        args.command = "help";
        break;
      default:
        console.error(`Unknown option "${flag}".\n`);
        args.command = "help";
    }
  }

  return args;
}

/** Loads AZURE_OPENAI_* from the first .env found: an explicit --env-file, then <dir>/.env, then ./.env. */
function loadEnv(dir: string, explicit: string | null): void {
  const candidates = explicit ? [explicit] : [path.join(dir, ".env"), path.join(process.cwd(), ".env")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate });
      console.log(`Loaded ${candidate}`);
      return;
    }
  }
  console.log("No .env found — the reviewer model step will be skipped unless AZURE_OPENAI_* is already set in the environment.");
}

async function scanProject(args: Args): Promise<LocalProject> {
  const scan = await collectSourceFiles(args.dir, {
    maxFiles: args.maxFiles,
    excludeDirs: [args.out, args.lineageOut, args.docOut, args.diagramsOut],
    includeNotebooks: args.includeNotebooks
  });

  const total = scan.sqlFiles.length + scan.notebooks.length;
  if (total === 0) {
    console.error(
      `No ${args.includeNotebooks ? ".sql files or notebooks" : ".sql files"} found under ${path.resolve(args.dir)}.`
    );
    process.exit(1);
  }

  const parts = [
    `${scan.sqlFiles.length} SQL file${scan.sqlFiles.length === 1 ? "" : "s"}`,
    ...(scan.notebooks.length > 0 ? [`${scan.notebooks.length} notebook${scan.notebooks.length === 1 ? "" : "s"}`] : [])
  ];
  console.log(`Found ${parts.join(" and ")} under ${path.resolve(args.dir)}.`);

  if (scan.truncated) {
    console.warn("Some files were left out by the caps above — pass --max-files to raise the limit if this project is bigger than that.");
  }

  const project = buildLocalProject(scan);

  if (project.scan.skipped.length > 0) {
    console.log(`Skipped ${project.scan.skipped.length} file${project.scan.skipped.length === 1 ? "" : "s"}:`);
    for (const s of project.scan.skipped.slice(0, 10)) console.log(`  - ${s.path}: ${s.reason}`);
    if (project.scan.skipped.length > 10) console.log(`  ... and ${project.scan.skipped.length - 10} more`);
  }

  if (project.files.length === 0) {
    console.error("None of the files contained a parsable SQL statement.");
    process.exit(1);
  }
  return project;
}

function resolveLayers(schemas: string[], override: string[] | null): LayerRef[] {
  if (override) {
    const known = new Set(schemas.map((s) => s.toLowerCase()));
    const unknown = override.filter((name) => !known.has(name.toLowerCase()));
    if (unknown.length > 0) {
      console.warn(
        `Warning: --layers named ${unknown.join(", ")}, which no SQL in this project qualifies a table with. ` +
          "Proceeding anyway — statements naming it will simply produce no hop."
      );
    }
    return override.map((name) => ({ label: name, schema: name }));
  }
  return detectLayers(schemas);
}

function printLayers(schemas: string[], layers: LayerRef[]): void {
  if (layers.length === 0) {
    console.log(
      "No pipeline layers were detected from the schema names in this project's SQL, so everything will be " +
        "written as one scope rather than per-hop. Pass --layers to name them explicitly, e.g. --layers raw,staged,mart."
    );
    return;
  }
  console.log(`Detected ${layers.length} layer${layers.length === 1 ? "" : "s"}, most-raw first: ${layers.map((l) => l.label).join(" -> ")}`);
  const unassigned = unassignedSchemas(schemas, layers);
  if (unassigned.length > 0) {
    console.log(`Schemas not placed in the pipeline: ${unassigned.join(", ")} (add them with --layers if they belong).`);
  }
  console.log("Override with --layers a,b,c if this is wrong.");
}

/**
 * One `.sql` per hop by default — the hop's whole reconciliation as a single query — and, with
 * `--split`, the per-table scripts behind it in a folder alongside.
 */
async function writeSuite(
  dir: string,
  outName: string,
  suite: LocalReconciliationSuite,
  split: boolean,
  oneFile: boolean,
  /** Off inside `run`, which asks about the document rather than telling you to go and run it. */
  suggestDocument: boolean
): Promise<void> {
  const outRoot = path.join(dir, outName);
  await mkdir(outRoot, { recursive: true });

  const written: string[] = [];

  // One file per hop — one adjacent layer pair each. Every check for that hop comes back as a single
  // table, so the file is run once and read down the `status` column.
  if (oneFile) {
    await writeFile(path.join(outRoot, suite.projectBundle.filename), suite.projectBundle.sql, "utf8");
    written.push(
      `${suite.projectBundle.filename}  (all ${suite.stats.hopCount} hop${
        suite.stats.hopCount === 1 ? "" : "s"
      } folded into one query, --one-file)`
    );
  } else {
    for (const hop of suite.hops) {
      const file = `${hop.folder}.sql`;
      await writeFile(path.join(outRoot, file), hop.bundle.sql, "utf8");
      written.push(`${file}  (${hop.scripts.length} table${hop.scripts.length === 1 ? "" : "s"} in one query)`);
    }
  }

  if (split) {
    for (const hop of suite.hops) {
      if (hop.scripts.length === 0) continue;
      const hopDir = path.join(outRoot, hop.folder);
      await mkdir(hopDir, { recursive: true });
      for (const script of hop.scripts) {
        await writeFile(path.join(hopDir, script.filename), script.sql, "utf8");
      }
      written.push(`${hop.folder}/  (${hop.scripts.length} per-table script${hop.scripts.length === 1 ? "" : "s"})`);
    }
  }

  const aiChecks = suite.hops.reduce(
    (n, hop) => n + hop.scripts.reduce((m, s) => m + s.checks.filter((c) => c.source === "ai").length, 0),
    0
  );
  const summaryLines = [
    `Reconciliation scripts for ${suite.folderName}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    `${suite.stats.hopCount} hop(s), ${suite.stats.scriptCount} table(s), ${suite.stats.checkCount} check(s) ` +
      `(${aiChecks} written by the reviewer model, ${suite.stats.checkCount - aiChecks} derived from the schema).`,
    "",
    ...(oneFile
      ? [
          `--one-file: the whole pipeline is in ${suite.projectBundle.filename} as a single query.`,
          "`scope` names the hop each row belongs to."
        ]
      : ["One .sql per hop — one adjacent layer pair each. Run it and read the `status` column."]),
    "",
    "Each file is a single query returning one row per check, with these columns:",
    "  check_seq, scope, target_table, source_table, check_name, metric,",
    "  source_value, target_value, difference, status",
    "",
    "PASS on every row means the hop ties out. REVIEW means the numbers differ and a filter or",
    "aggregation has to explain it; FAIL means duplicate keys, null keys, or target rows no source",
    "accounts for. The detail queries behind any count are at the foot of the same file, commented out.",
    "",
    "The layers/ folder beside this one reconciles the same pipeline column by column, one file per",
    "layer, with the reviewer model's reading of why each row might not tie out.",
    ...(split ? ["", "--split also wrote the per-table scripts, one folder per hop."] : []),
    ...(suite.notice ? ["", suite.notice] : []),
    "",
    ...suite.hops.map(
      (hop) =>
        `${hop.folder}.sql (${hop.fromLayer && hop.toLayer ? `${hop.fromLayer.label} -> ${hop.toLayer.label}` : "whole project"}): ` +
        `${hop.scripts.map((s) => s.targetTable).join(", ") || "(no tables found for this hop)"}`
    )
  ];
  await writeFile(path.join(outRoot, "SUMMARY.txt"), `${summaryLines.join("\n")}\n`, "utf8");

  console.log("");
  console.log(`Wrote ${outRoot}`);
  for (const line of written) console.log(`  ${line}`);
  if (suite.notice) console.log(`\nNote: ${suite.notice}`);
}

/** The governance half, shared by `scripts` and the tail of `run`. */
async function generateAndWriteSuite(
  args: Args,
  project: LocalProject,
  layers: LayerRef[],
  suggestDocument = true
): Promise<void> {
  console.log("\nWriting the standard checks and, where configured, asking the reviewer model for the rest...");

  let suite: LocalReconciliationSuite;
  if (!args.useAi) {
    suite = buildReconciliationSuite(project, layers, "Run with --no-ai — these are Recon's standard schema-derived checks only.");
  } else {
    try {
      suite = await buildAiReconciliationSuite(project, layers);
    } catch (err) {
      if (err instanceof LlmConfigError) {
        suite = buildReconciliationSuite(
          project,
          layers,
          "Azure OpenAI isn't configured, so these are Recon's standard schema-derived checks rather than " +
            "scripts written for this pipeline. Set AZURE_OPENAI_* in a .env file (see --env-file) and re-run."
        );
      } else {
        throw err;
      }
    }
  }

  await writeSuite(args.dir, args.out, suite, args.split, args.oneFile, false);
  await writeLayerReconciliation(args, project, layers);

  if (suggestDocument) {
    console.log("\nWrite this up as a document with: reconcile document");
    console.log("Export the lineage as editable PowerPoint shapes with: reconcile diagrams");
  }
}

/**
 * The per-layer reconciliation, written straight after the governance scripts and from the same
 * project — never as a command of its own.
 *
 * The hop bundles say whether the pipeline ties out. This says, for every column of every table, which
 * source it came from, how the code relates the two, and — when it does not tie out — what in the
 * transformation SQL would explain it, as read by the reviewer model. One is the status, the other is
 * the reason, and asking someone to remember a second command to get the reason is how the reason
 * stops being read.
 */
async function writeLayerReconciliation(args: Args, project: LocalProject, layers: LayerRef[]): Promise<void> {
  console.log("\nReconciling each layer column by column, and asking the reviewer model to explain each row...");

  const suite = await buildLayerReconciliation(project, layers, args.useAi);
  const outRoot = path.join(args.dir, args.out, "layers");
  await mkdir(outRoot, { recursive: true });

  for (const script of suite.scripts) {
    await writeFile(path.join(outRoot, script.filename), script.sql, "utf8");
  }
  await writeFile(path.join(outRoot, "SUMMARY.txt"), summarizeLayerReconciliation(suite, new Date()), "utf8");

  console.log("");
  console.log(`Wrote ${outRoot}`);
  for (const script of suite.scripts) {
    console.log(
      `  ${script.filename}  (${script.pairCount} source/target pair${script.pairCount === 1 ? "" : "s"}, ` +
        `${script.rowCount} column${script.rowCount === 1 ? "" : "s"}` +
        `${script.commentedCount > 0 ? `, ${script.commentedCount} explained` : ""})`
    );
  }
  console.log("");
  console.log("  six columns: source_table, target_table, reconciled_column, join_type, result, comments");
  if (suite.notice) console.log(`
  Note: comments is empty — ${suite.notice}`);
}

async function runScripts(args: Args): Promise<void> {
  loadEnv(args.dir, args.envFile);
  const project = await scanProject(args);
  const layers = resolveLayers(project.scan.schemas, args.layers);
  printLayers(project.scan.schemas, layers);
  await generateAndWriteSuite(args, project, layers);
}

/**
 * Lineage first, governance second, with the user's confirmation in between — and, crucially, the
 * *approved* project handed to the governance step rather than the originally extracted one.
 *
 * The document is offered last, as a question rather than another command to remember: everything it
 * needs is already in hand at that point (the approved project, the layers, the lineage just written,
 * the scripts just written), so answering yes costs a scan nobody has to repeat. `--document` and
 * `--no-document` answer it in advance, which is also how a non-interactive run decides — with nothing
 * to ask, the default is to stop after the scripts and say how to get the document.
 */
async function runFull(args: Args): Promise<void> {
  loadEnv(args.dir, args.envFile);

  // Resolved before the long work so a bad --template fails now rather than after the LLM calls.
  const template = findTemplate(args.dir, args.template);

  const project = await scanProject(args);
  const layers = resolveLayers(project.scan.schemas, args.layers);
  printLayers(project.scan.schemas, layers);

  const options: VerifyOptions = {
    dir: args.dir,
    lineageOut: args.lineageOut,
    autoApprove: args.autoApprove,
    useAi: args.useAi,
    noOpen: args.noOpen
  };

  // One session for both questions — the lineage gate and the document offer. Opened here so it
  // outlives `verifyLineage`, since closing readline ends stdin for everything after it.
  const session: PromptSession | null = canPrompt(args.autoApprove) ? openPromptSession() : null;

  try {
    const result = await verifyLineage(project, layers, options, session);
    const lineageDir = await writeLineageArtifacts(options, result.artifacts);

    if (!result.approved) {
      console.log(`\nLineage so far is in ${lineageDir} — nothing was generated from it.`);
      return;
    }

    console.log(`\nLineage approved. Wrote ${lineageDir}`);
    console.log("  lineage.html  (the diagram you just reviewed)");
    console.log("  lineage.pptx  (the same diagram as editable PowerPoint shapes — copy them into Word)");
    console.log("  lineage.json  (the approved graph)");
    if (result.artifacts.feedback.length > 0) {
      console.log(`  lineage-feedback.json  (${result.artifacts.feedback.length} round(s) of corrections)`);
    }

    await generateAndWriteSuite(args, result.project, layers, args.document === false);

    if (!(await wantsDocument(args, session))) return;

    console.log("");
    await writeDocument(args, {
      project: result.project,
      layers,
      lineage: result.artifacts,
      template
    });
  } finally {
    session?.close();
  }
}

/**
 * Whether `run` should go on to write the document — the flags if either was given, otherwise the
 * question, otherwise no.
 */
async function wantsDocument(args: Args, session: PromptSession | null): Promise<boolean> {
  if (args.document !== null) return args.document;

  if (!session) {
    console.log("\nWrite this up as a document with: reconcile document  (or --document to include it here)");
    console.log("Or just the diagram you approved, as editable PowerPoint shapes: reconcile diagrams");
    return false;
  }

  const answer = await askChoice(session.ask, "\nWrite this up as a document as well? [yes] / no: ");
  if (answer === "yes") return true;
  console.log("Skipped. Run `reconcile document` later if you change your mind — it reads what was just written.");
  // Worth saying here rather than only in `diagrams --help`: the user has just spent the last few
  // minutes looking at the diagram, so this is the moment they want to know they can take it with them.
  console.log("To take the diagram itself into Word or PowerPoint as editable shapes: reconcile diagrams");
  return false;
}

/**
 * `reconcile document` — the run written up, rather than another artifact to interpret.
 *
 * It documents what is *there*: the lineage `reconcile run` approved if this folder has one (replayed
 * onto the current SQL, so the document and the diagram agree), the scripts `reconcile scripts` wrote
 * if they exist, and the layers, tables and checks derived either way. So it can be run at any point —
 * before anything else, to understand a folder, or last, to hand over what was done.
 */
interface DocumentInputs {
  /** The project as it should be described — corrections already applied. */
  project: LocalProject;
  layers: LayerRef[];
  /** The approved lineage, when there is one to describe. */
  lineage: LineageArtifacts | null;
  template: string | null;
}

/**
 * The writing half, shared by `document` and the tail of `run`.
 *
 * Takes the project rather than a folder, so `run` can hand over the one the user just approved
 * in memory instead of it being scanned and corrected a second time off disk.
 */
async function writeDocument(args: Args, inputs: DocumentInputs): Promise<void> {
  const governanceFiles = await listGovernanceFiles(args.dir, args.out);
  const generatedAt = new Date();

  const result = await buildDocumentation(inputs.project, inputs.layers, {
    scanRoot: path.resolve(args.dir),
    useAi: args.useAi,
    lineage: inputs.lineage,
    governanceFiles,
    generatedAt,
    onProgress: (message) => console.log(`  ${message}...`)
  });

  const written = await writeDocumentArtifacts(args.dir, args.docOut, result.doc, inputs.template, generatedAt);

  console.log("");
  console.log(`Wrote ${written.dir}`);
  for (const file of written.files) console.log(`  ${file}`);
  console.log("");
  console.log(
    `${result.doc.blocks.filter((b) => b.kind === "heading").length} sections covering ` +
      `${result.facts.stats.layerCount} layer(s), ${result.facts.stats.edgeCount} lineage edge(s), ` +
      `${result.facts.hops.length} hop(s) and ${result.facts.stats.checkCount} derived check(s).`
  );

  if (written.templateMissing) {
    console.log("");
    console.log("No Word template was found, so only the Markdown was written. This package ships one,");
    console.log("so it has been removed or stripped from the install — pass --template <path/to.docx>");
    console.log("to render the branded document.");
  } else {
    console.log("The .docx opens with an empty table of contents until Word refreshes its fields — it does");
    console.log("that on open, or press Ctrl+A then F9.");
  }

  for (const notice of result.notices) {
    console.log("");
    console.log(`Note: ${notice}`);
  }

  if (args.diagrams) {
    console.log("");
    await writeDiagrams(args, inputs.project, inputs.layers);
  }
}

/**
 * The deck and the SVGs, shared by `diagrams` and the tail of `document`.
 *
 * Takes the project rather than a folder for the same reason `writeDocument` does — `run` and
 * `document` already hold the corrected one, and re-deriving it would risk drawing a lineage the user
 * has already rejected.
 */
async function writeDiagrams(args: Args, project: LocalProject, layers: LayerRef[]): Promise<void> {
  const written = await writeDiagramArtifacts(
    args.dir,
    args.diagramsOut,
    {
      projectName: project.folderName,
      edges: project.scan.lineage,
      layers,
      tables: project.scan.tables
    },
    new Date()
  );

  console.log(`Wrote ${written.dir}`);
  for (const file of written.files) console.log(`  ${file}`);
  console.log("");
  console.log(`${written.components.length} diagram(s) — the overview, then one per hop:`);
  for (const line of describeDiagrams(written)) console.log(`  ${line}`);
  console.log("");
  console.log("Open the .pptx, select a slide's shapes and paste them into Word or your own deck — the");
  console.log("boxes stay draggable and the text stays editable. README.txt covers the .svg route.");

  if (written.emptyCount > 0) {
    console.log("");
    console.log(
      `Note: ${written.emptyCount} hop(s) had no lineage to draw and were written as a slide saying so, ` +
        "rather than left out. Check that --layers matches the schema names the SQL uses."
    );
  }
}

async function runDiagrams(args: Args): Promise<void> {
  // No `loadEnv` and no `--no-ai` handling: the shapes are derived from the graph, so this command has
  // no LLM step to configure or to fall back from.
  const scanned = await scanProject(args);

  const lineage = await readLineageArtifacts(args.dir, args.lineageOut);
  const corrected = applyApprovedLineage(scanned, lineage);
  const project = corrected.project;

  if (lineage) {
    console.log(
      `Found ${args.lineageOut}/lineage.json — ${lineage.approved ? "approved" : "not approved"} lineage from ${
        lineage.generatedAt.slice(0, 10) || "an earlier run"
      }.`
    );
    if (corrected.applied > 0) console.log(`  Replayed ${corrected.applied} recorded correction(s) onto this scan.`);
    if (corrected.stale > 0) {
      console.log(`  ${corrected.stale} recorded correction(s) no longer match the SQL and were left out.`);
    }
  } else {
    console.log(`No ${args.lineageOut}/lineage.json here, so the diagrams draw the lineage as extracted.`);
  }

  // Same precedence as `document`: an approved layer order beats re-detection, an explicit --layers
  // beats both. The hop split has to match the one the scripts were built for or the file names lie.
  const layers = args.layers
    ? resolveLayers(project.scan.schemas, args.layers)
    : lineage?.layers.length
      ? lineage.layers
      : resolveLayers(project.scan.schemas, null);
  printLayers(project.scan.schemas, layers);

  console.log("");
  await writeDiagrams(args, project, layers);
}

async function runDocument(args: Args): Promise<void> {
  loadEnv(args.dir, args.envFile);

  const template = findTemplate(args.dir, args.template);
  const scanned = await scanProject(args);

  const lineage = await readLineageArtifacts(args.dir, args.lineageOut);
  const corrected = applyApprovedLineage(scanned, lineage);
  const project = corrected.project;

  if (lineage) {
    console.log(
      `Found ${args.lineageOut}/lineage.json — ${lineage.approved ? "approved" : "not approved"} lineage from ${lineage.generatedAt.slice(0, 10) || "an earlier run"}.`
    );
    if (corrected.applied > 0) {
      console.log(`  Replayed ${corrected.applied} recorded correction(s) onto this scan.`);
    }
    if (corrected.stale > 0) {
      console.log(`  ${corrected.stale} recorded correction(s) no longer match the SQL and were left out.`);
    }
  } else {
    console.log(`No ${args.lineageOut}/lineage.json here, so the document describes the lineage as extracted.`);
  }

  // Layers approved in an earlier run beat re-detection, since the document is meant to describe the
  // same pipeline the scripts were built for. An explicit --layers still wins over both.
  const layers = args.layers
    ? resolveLayers(project.scan.schemas, args.layers)
    : lineage?.layers.length
      ? lineage.layers
      : resolveLayers(project.scan.schemas, null);
  printLayers(project.scan.schemas, layers);

  console.log("");
  await writeDocument(args, { project, layers, lineage, template });
}

async function runLayers(args: Args): Promise<void> {
  const project = await scanProject(args);
  const layers = resolveLayers(project.scan.schemas, args.layers);
  console.log(`\nSchemas found in this project's SQL: ${project.scan.schemas.join(", ") || "(none — every table is unqualified)"}`);
  printLayers(project.scan.schemas, layers);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    console.log(USAGE);
    // Exit 1 when help was forced by an unrecognised command/flag (argv beyond node + script path);
    // exit 0 for a bare `reconcile` or an explicit `--help`, which are not errors.
    process.exit(process.argv.length > 2 && !["-h", "--help"].includes(process.argv[2]) ? 1 : 0);
  }

  try {
    if (args.command === "run") await runFull(args);
    else if (args.command === "scripts") await runScripts(args);
    else if (args.command === "document") await runDocument(args);
    else if (args.command === "diagrams") await runDiagrams(args);
    else await runLayers(args);
  } catch (err) {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
