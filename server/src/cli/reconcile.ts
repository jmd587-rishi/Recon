#!/usr/bin/env node
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAiReconciliationSuite } from "../services/aiReconciliation.js";
import { buildDocumentation } from "../services/documentation.js";
import { BUSINESS_RECON_DIR, HIGH_LEVEL_RECON_DIR, LOGICAL_RECON_DIR } from "../services/governanceLayout.js";
import {
  buildBusinessReconciliation,
  noBusinessChecksFile,
  summarizeBusinessReconciliation
} from "../services/businessReconciliation.js";
import {
  buildLayerReconciliation,
  summarizeLayerReconciliation
} from "../services/layerReconciliation.js";
import { buildLayerEvidence, detectProjectLayers } from "../services/layerDetection.js";
import { LlmConfigError } from "../services/llmClient.js";
import {
  detectPlatform,
  parsePlatform,
  platformLabel,
  SQL_PLATFORMS,
  type SqlPlatform
} from "../services/sqlPlatform.js";
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
  askOption,
  canPrompt,
  openPromptSession,
  readLineageArtifacts,
  verifyLineage,
  writeLineageArtifacts,
  type PromptSession,
  type VerifyOptions
} from "./lineagePrompt.js";
import type {
  LayerDetectionReport,
  LayerRef,
  LineageArtifacts,
  LocalReconciliationSuite
} from "../types/index.js";

/**
 * `reconcile scripts` — the L4 tab (`/local/reconciliation` in the running app) as a standalone
 * command, for a data engineering project that was never uploaded anywhere. Same services, same
 * two-tier checks (`reconciliationScripts.templateChecks` derived from the columns, plus whatever
 * `aiReconciliation.ts` can add from reading the transformation SQL), same fallback when Azure OpenAI
 * isn't configured — just reading straight off disk and writing straight back to disk instead of
 * going through the browser's upload/zip round trip.
 *
 * What lands on disk is one `.sql` per hop in `governance/High level recon/`: `reconciliationBundle.ts`'s
 * single query, which returns the hop's whole reconciliation as one status table. The per-table scripts
 * the same suite carries are written only on `--split` — one file you can run beats a folder you have to
 * work through. Beside it, `governance/Logical recon/` holds the column reports — a folder per layer,
 * in pipeline order, and inside it one query per table of that layer. And `governance/Business recon/`
 * holds one query per *reporting* table. Three folders rather than one because they answer different
 * questions and are read at different times: the hop queries say whether the pipeline ties out, the
 * layer reports say which column of which table stopped agreeing with what built it, and the business
 * checks say whether the table the business actually reads adds up on its own terms — its movements
 * reaching its closing balance, the subtotals its own SQL declares, one period's close opening the
 * next, and the measure it reports still being the one that entered the pipeline. That last folder
 * exists because the first two have almost nothing to say about a report: `rpt_snowball`'s movement
 * columns are eight readings of one upstream column and exist in no source table, so a
 * source-versus-target reconciliation describes them entirely by what it could not check.
 * `governanceLayout.ts` names all three.
 *
 * `reconcile run` puts a gate in front of that. The reconciliation scripts are only as good as the
 * lineage they're derived from, and that lineage is parsed out of the SQL by heuristics that a real
 * project can defeat, so `run` draws the lineage first, asks the user to confirm it, and only writes
 * scripts once they have. Corrections are applied to the underlying facts (`lineageOverrides.ts`),
 * not just to the picture, so approving the diagram approves what the scripts are actually built on.
 *
 * Every command starts by working out the pipeline's layers, and it does that by reading the project
 * rather than by recognising its schema names (`layerDetection.ts`): the dependency graph between
 * schemas is derived from the SQL, and the reviewer model is asked which of those schemas are stages of
 * the pipeline and what each one is for. A project whose schemas are called `arr` and `prep` gets a
 * pipeline; the old keyword list is the fallback for when no model is configured, and the graph's own
 * ordering is the fallback after that. `--layers` still overrides everything.
 *
 * `reconcile layers` runs only the scan + layer-detection step, so what the rest of the run will be
 * built on can be checked — and overridden with `--layers` — before anything is generated from it.
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
  scripts     Write the hop queries, the per-layer column reports and the business
              checks on the reporting tables, into governance/
  document    Write the whole pipeline up as a Word document and a Markdown file
  diagrams    Write the lineage as editable PowerPoint shapes and Office-ready SVGs
  layers      Work out and print the pipeline layers only — writes nothing

Options:
  --dir <path>        Project folder to scan (default: current directory)
  --out <name>         Output folder name, created under --dir (default: governance). Holds
                       "High level recon" (a query per hop), "Logical recon" (a folder per
                       layer, one query per table inside it) and "Business recon" (a query
                       per reporting table: roll-forwards, stated subtotals, period
                       continuity and the measure traced end to end)
  --lineage-out <name> Folder for the lineage diagram and data (default: lineage)
  --doc-out <name>    document: folder for the document (default: documentation)
  --diagrams-out <name> Folder for the deck and the SVGs (default: diagrams)
  --no-diagrams       document: skip the diagrams that normally accompany it
  --template <path>   Word template to render into (default: the one bundled with Recon)
  --layers a,b,c      Schema or folder names, most-raw first, overriding the detected pipeline
  --platform <name>   SQL engine the scripts must run on: snowflake, sqlserver,
                      databricks or portable (default: asked, detected from your SQL)
  --env-file <path>   .env file with AZURE_OPENAI_* settings (default: <dir>/.env, then ./.env)
  --no-ai             Skip the reviewer model — standard checks only, layers by name and dependency
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
  platform: SqlPlatform | null;
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
    platform: null,
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
      case "--platform": {
        const raw = next();
        const parsed = parsePlatform(raw ?? "");
        if (!parsed) {
          console.error(`Unknown --platform "${raw}". One of: ${SQL_PLATFORMS.join(", ")}.
`);
          args.command = "help";
        } else {
          args.platform = parsed;
        }
        break;
      }
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

/**
 * Folders Recon writes into, which it must never read back as if they were the project.
 *
 * The *configured* names are excluded, and so are the defaults, because those are two different sets
 * the moment anyone passes `--out`: a run with `--out governance-check` would otherwise scan the
 * `governance/` an earlier run left behind, take its generated queries for transformation SQL, and
 * invent a whole extra layer out of them.
 */
function outputDirs(args: Args): string[] {
  return [
    args.out,
    args.lineageOut,
    args.docOut,
    args.diagramsOut,
    "governance",
    "lineage",
    "documentation",
    "diagrams"
  ];
}

async function scanProject(args: Args): Promise<LocalProject> {
  const scan = await collectSourceFiles(args.dir, {
    maxFiles: args.maxFiles,
    excludeDirs: outputDirs(args),
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

  printFileLineage(project);
  return project;
}

/**
 * Says when the lineage was read off the file layout rather than out of the SQL, and what that means
 * for the names in everything about to be generated.
 *
 * Worth a paragraph rather than a line: a dbt project's scripts name `stg_orders` where the warehouse
 * holds `analytics_staging.stg_orders`, and someone who runs one without knowing why reads the
 * resulting error as a bug in the tool. The reason is that dbt keeps the schema in a profile and a
 * profile is not in the repository — Recon names each model the way the code does.
 */
function printFileLineage(project: LocalProject): void {
  const lineage = project.fileLineage;
  if (!lineage) return;

  console.log("");
  console.log(
    `This is a dbt project: ${lineage.modelCount} model${lineage.modelCount === 1 ? "" : "s"} ` +
      `(${lineage.jinjaFileCount} file${lineage.jinjaFileCount === 1 ? "" : "s"} using ref/source/config), ` +
      `reading ${lineage.sourceCount} table${lineage.sourceCount === 1 ? "" : "s"} between them.`
  );
  console.log(
    "Its lineage comes from the files rather than from the SQL: each model is the table its file names, " +
      "and its ref() and source() calls are its sources."
  );
  console.log(
    "Models are named unqualified — dbt decides the schema at run time from the profile's target, which " +
      "isn't in the repo — so prefix them for your own warehouse before running the generated SQL."
  );

  if (lineage.unresolvedRefs.length > 0) {
    const shown = lineage.unresolvedRefs.slice(0, 8).join(", ");
    console.log(
      `Warning: ${lineage.unresolvedRefs.length} ref() name${lineage.unresolvedRefs.length === 1 ? "" : "s"} ` +
        `no model in this folder: ${shown}${lineage.unresolvedRefs.length > 8 ? ", ..." : ""}. They are ` +
        "treated as tables arriving from outside — point --dir at the whole dbt project if they are part of it."
    );
  }
}

/**
 * Which engine the generated SQL is written for — asked, not assumed, because it changes what the
 * scripts may contain.
 *
 * The project's own SQL supplies the default (`detectPlatform`), so the usual answer is Enter: a
 * folder full of `QUALIFY` and `TRY_TO_DECIMAL` is Snowflake and there is no sense making someone
 * say so. It is still a question, because the engine a project is *written* in and the one it is
 * *deployed* to are not always the same, and a folder of plain `SELECT`s says nothing either way.
 *
 * `--platform` answers it in advance, which is also how a non-interactive run decides — with nobody
 * to ask, the detected engine is used rather than a prompt nobody would see.
 */
async function resolvePlatform(
  project: LocalProject,
  args: Args,
  session: PromptSession | null
): Promise<SqlPlatform> {
  if (args.platform) return args.platform;

  const guess = detectPlatform(project);
  console.log("");
  if (guess.platform === "portable") {
    console.log("Nothing in this project's SQL identifies which engine it targets.");
  } else {
    console.log(`This project's SQL looks like ${platformLabel(guess.platform)}:`);
    for (const line of guess.evidence) console.log(`  ${line}`);
  }

  if (!session) {
    console.log(
      `Writing the scripts for ${platformLabel(guess.platform)} — pass --platform to target a different engine.`
    );
    return guess.platform;
  }

  const answer = await askOption(
    session.ask,
    `Which engine will these scripts run on? [${guess.platform}] / ${SQL_PLATFORMS.filter((p) => p !== guess.platform).join(" / ")}: `,
    SQL_PLATFORMS,
    guess.platform
  );
  console.log(`Writing the scripts for ${platformLabel(answer)}.`);
  return answer;
}

/**
 * The pipeline this run is built around, and where it came from.
 *
 * `--layers` is the user's own answer and skips detection altogether — including the model, since
 * paying for a reading nobody will use is just latency. It is still resolved against the project
 * rather than taken as bare strings, because a named layer may be a *folder* rather than a schema
 * (`--layers Prep,Mart,ARR` on a project that writes every stage into one schema), and a folder layer
 * has to carry its tables or nothing downstream can find them.
 *
 * Everything else goes to `layerDetection.ts`, which reads the project rather than pattern-matching
 * its schema names: the point of `reconcile` is to work on a real project, and a real project is as
 * likely to be named after its business (`arr`, `prep`, `optum`) as after a medallion convention.
 */
async function resolveLayers(project: LocalProject, args: Args): Promise<LayerDetectionReport> {
  if (args.layers) {
    const wanted = args.layers;
    const evidence = buildLayerEvidence(project);

    // One grouping for the whole list, chosen by how much of it each can account for — never a name
    // from each. `--layers Prep,Mart,ARR` on a project with both a `prep` schema and a `Prep` folder
    // means the folders, because that is the only grouping that has all three; resolving name by name
    // would take `prep` from the schemas and the other two from the folders and build a pipeline out
    // of two incompatible partitions. Schemas win a tie, as everywhere else.
    const matches = (grouping: { groups: { name: string }[] }) =>
      wanted.filter((name) => grouping.groups.some((g) => g.name.toLowerCase() === name.toLowerCase())).length;
    const chosen = evidence.groupings.reduce<(typeof evidence.groupings)[number] | null>(
      (best, candidate) => (best === null || matches(candidate) > matches(best) ? candidate : best),
      null
    );

    const unknown: string[] = [];
    const layers: LayerRef[] = wanted.map((name) => {
      const group = chosen?.groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
      if (!group) {
        unknown.push(name);
        return { label: name, schema: name };
      }
      return chosen!.kind === "folder"
        ? { label: group.name, schema: group.name, tables: group.tables }
        : { label: group.name, schema: group.name };
    });

    if (unknown.length > 0) {
      console.warn(
        `Warning: --layers named ${unknown.join(", ")}, which is neither a ${chosen?.kind ?? "schema"} ` +
          "this project's SQL uses. Proceeding anyway — statements naming it will simply produce no hop."
      );
    }

    return {
      layers,
      source: "explicit",
      grouping: chosen?.kind ?? "schema",
      reasons: {},
      excluded: [],
      unplaced: [],
      notice: null,
      warning: null
    };
  }

  return detectProjectLayers(project, {
    useAi: args.useAi,
    onProgress: (message) => console.log(`${message}...`)
  });
}

/**
 * The layers for a command that re-reads a folder someone has already run — `document` and
 * `diagrams`.
 *
 * An approved layer order beats re-detection, and not only to save a call: these commands describe
 * and draw what the scripts were built for, and a hop split that has drifted from the one in
 * `governance/` makes `bronze_to_silver.svg` and `bronze_to_silver.sql` two different hops. An
 * explicit `--layers` still beats both, because that is the user overriding on purpose.
 */
async function layersForExistingRun(
  project: LocalProject,
  args: Args,
  lineage: LineageArtifacts | null
): Promise<LayerDetectionReport> {
  if (!args.layers && lineage?.layers.length) {
    return {
      layers: lineage.layers,
      source: "approved",
      grouping: lineage.layers.some((l) => l.tables) ? "folder" : "schema",
      reasons: {},
      excluded: [],
      unplaced: [],
      notice: null,
      warning: null
    };
  }
  return resolveLayers(project, args);
}

const LAYER_SOURCE_LABEL: Record<LayerDetectionReport["source"], string> = {
  ai: "read out of the code by the reviewer model",
  keyword: "matched from the schema names",
  lineage: "ordered by the dependencies in the SQL",
  explicit: "as given by --layers",
  approved: "as approved in the earlier run"
};

/**
 * Prints the pipeline and, just as importantly, how confident anyone should be in it: what it was
 * grouped by, which reading produced it, why each layer is where it is, what was deliberately left
 * out, and whether the SQL's own dependencies disagree. A layer order is the one input every
 * generated file is shaped by, so a wrong one is worth catching here rather than in a folder of
 * queries built on it.
 */
function printLayers(report: LayerDetectionReport): void {
  if (report.notice) console.log(report.notice);

  if (report.layers.length === 0) {
    console.log(
      "No pipeline layers were detected from this project's SQL, so everything will be written as one " +
        "scope rather than per-hop. Pass --layers to name them explicitly, e.g. --layers raw,staged,mart."
    );
    return;
  }

  const grouped = report.grouping === "folder" ? "source folder" : "schema";
  console.log(
    `Detected ${report.layers.length} layer${report.layers.length === 1 ? "" : "s"} by ${grouped}, ` +
      `most-raw first (${LAYER_SOURCE_LABEL[report.source]}): ${report.layers.map((l) => l.label).join(" -> ")}`
  );

  for (const layer of report.layers) {
    const role = layer.role ? ` [${layer.role}]` : "";
    const size = layer.tables ? ` (${layer.tables.length} table${layer.tables.length === 1 ? "" : "s"})` : "";
    const reason = report.reasons[layer.label];
    if (role || size || reason) console.log(`  ${layer.label}${role}${size}${reason ? ` — ${reason}` : ""}`);
  }

  for (const entry of report.excluded) {
    console.log(`  (not a pipeline layer) ${entry.schema}${entry.reason ? ` — ${entry.reason}` : ""}`);
  }

  if (report.unplaced.length > 0) {
    console.log(
      `Not placed in the pipeline: ${report.unplaced.join(", ")} (add them with --layers if they belong).`
    );
  }

  if (report.warning) console.log(`Warning: ${report.warning}`);
  console.log("Override with --layers a,b,c if this is wrong.");
}

/**
 * Names the `.sql` files already in an output folder that this run did not write.
 *
 * Changing the layers changes the file names — a project re-read as `Prep -> Mart -> ARR` writes
 * `prep_to_mart.sql` beside the `prep_to_refined.sql` an earlier schema-based run left behind, and
 * `01_prep.sql` beside `02_prep.sql`. Both look current. Reported rather than deleted: these sit in
 * the user's project, and a generator that removes files it did not create this run is a generator
 * you cannot safely point at a folder.
 */
async function reportStale(dir: string, written: string[]): Promise<void> {
  const mine = new Set(written);
  let present: string[];
  try {
    present = await readdir(dir);
  } catch {
    return;
  }

  const stale = present.filter((name) => name.toLowerCase().endsWith(".sql") && !mine.has(name)).sort();
  if (stale.length === 0) return;

  console.log("");
  console.log(
    `Note: ${stale.length} .sql file(s) in this folder were not written by this run and are left over ` +
      "from an earlier one with different layers:"
  );
  for (const name of stale.slice(0, 12)) console.log(`  ${name}`);
  if (stale.length > 12) console.log(`  ... and ${stale.length - 12} more`);
  console.log("Delete them — they describe a pipeline this run no longer produces.");
}

/**
 * Names what an earlier version of this tool left in the governance root.
 *
 * The hop queries used to sit directly in `governance/` and the layer reports in `governance/layers/`;
 * they are now split into two named folders, so a folder that has been run before holds a full set of
 * files under the old layout describing the same pipeline. They are not deleted for the same reason
 * `reportStale` doesn't delete: these are files in the user's own project. But left unmentioned they
 * are indistinguishable from what this run just wrote.
 */
async function reportOldLayout(governanceRoot: string): Promise<void> {
  let present: string[];
  try {
    present = await readdir(governanceRoot);
  } catch {
    return;
  }

  const loose = present.filter((name) => name.toLowerCase().endsWith(".sql")).sort();
  const oldLayerDir = present.includes("layers") && existsSync(path.join(governanceRoot, "layers"));
  if (loose.length === 0 && !oldLayerDir) return;

  console.log("");
  console.log(`Note: ${governanceRoot} still holds output from an earlier version of Recon, which wrote`);
  console.log(`the hop queries into the folder itself and the layer reports into layers/. They now go`);
  console.log(`into ${HIGH_LEVEL_RECON_DIR}/ and ${LOGICAL_RECON_DIR}/:`);
  for (const name of loose.slice(0, 12)) console.log(`  ${name}`);
  if (loose.length > 12) console.log(`  ... and ${loose.length - 12} more`);
  if (oldLayerDir) console.log("  layers/");
  console.log("Delete them — this run has rewritten all of it under the two folders above.");
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
  const outRoot = path.join(dir, outName, HIGH_LEVEL_RECON_DIR);
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
    "  source_value, target_value, difference, accuracy, status",
    "",
    "Every row compares a source with a target, and status is graded from accuracy — the difference as",
    "a percentage of what it was measured against. 100.00% passes, below 75% fails, anything between",
    "reviews: the numbers differ and a filter or aggregation has to explain it. The percentage is what",
    "makes two rows comparable, since 300 rows missing out of 320 and 300 out of three million are the",
    "same difference and are not the same problem. It is floored rather than rounded, so only a check",
    "that really tied out reads 100.00%. The detail queries behind any count are at the foot of the",
    "same file, commented out.",
    "",
    `The ${LOGICAL_RECON_DIR}/ folder beside this one reconciles the same pipeline column by column: a`,
    "folder per layer, and inside it one file per table of that layer, with the reviewer model's",
    "reading of why each row might not tie out.",
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

  await reportStale(outRoot, oneFile ? [suite.projectBundle.filename] : suite.hops.map((hop) => `${hop.folder}.sql`));
}

/** The governance half, shared by `scripts` and the tail of `run`. */
async function generateAndWriteSuite(
  args: Args,
  project: LocalProject,
  layers: LayerRef[],
  session: PromptSession | null,
  suggestDocument = true
): Promise<void> {
  // Asked before anything is written, since it decides what the SQL may contain rather than how it
  // is presented — the model is told which engine it is writing for, and the derived checks pick the
  // conversion that engine actually accepts.
  const platform = await resolvePlatform(project, args, session);

  console.log("\nWriting the standard checks and, where configured, asking the reviewer model for the rest...");

  let suite: LocalReconciliationSuite;
  if (!args.useAi) {
    suite = buildReconciliationSuite(
      project,
      layers,
      "Run with --no-ai — these are Recon's standard schema-derived checks only.",
      platform
    );
  } else {
    try {
      suite = await buildAiReconciliationSuite(project, layers, platform);
    } catch (err) {
      if (err instanceof LlmConfigError) {
        suite = buildReconciliationSuite(
          project,
          layers,
          "Azure OpenAI isn't configured, so these are Recon's standard schema-derived checks rather than " +
            "scripts written for this pipeline. Set AZURE_OPENAI_* in a .env file (see --env-file) and re-run.",
          platform
        );
      } else {
        throw err;
      }
    }
  }

  await writeSuite(args.dir, args.out, suite, args.split, args.oneFile, false);
  await writeLayerReconciliation(args, project, layers, platform);
  await writeBusinessReconciliation(args, project, layers, platform);
  await reportOldLayout(path.join(args.dir, args.out));

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
async function writeLayerReconciliation(
  args: Args,
  project: LocalProject,
  layers: LayerRef[],
  platform: SqlPlatform
): Promise<void> {
  console.log("\nReconciling each layer column by column, and asking the reviewer model to explain each row...");

  const suite = await buildLayerReconciliation(project, layers, args.useAi, platform);
  const outRoot = path.join(args.dir, args.out, LOGICAL_RECON_DIR);
  await mkdir(outRoot, { recursive: true });

  // A folder per layer, in pipeline order, and a file per table inside it. Stale files are reported
  // per layer folder rather than for the root: a table dropped from the SQL leaves its script behind
  // in the folder it belonged to, and that is where someone would look for it.
  for (const script of suite.scripts) {
    const layerDir = path.join(outRoot, script.folder);
    await mkdir(layerDir, { recursive: true });
    for (const table of script.tables) {
      await writeFile(path.join(layerDir, table.filename), table.sql, "utf8");
    }
  }
  await writeFile(path.join(outRoot, "SUMMARY.txt"), summarizeLayerReconciliation(suite, new Date()), "utf8");

  console.log("");
  console.log(`Wrote ${outRoot}`);
  for (const script of suite.scripts) {
    console.log(
      `  ${script.folder}/  (${script.tables.length} table${script.tables.length === 1 ? "" : "s"}, ` +
        `${script.pairCount} source/target pair${script.pairCount === 1 ? "" : "s"}, ` +
        `${script.rowCount} column${script.rowCount === 1 ? "" : "s"}` +
        `${script.commentedCount > 0 ? `, ${script.commentedCount} explained` : ""})`
    );
    for (const table of script.tables) {
      console.log(
        `    ${table.filename}${
          table.rowCount === 0
            ? "  (nothing to reconcile — the file says why)"
            : `  (${table.rowCount} column${table.rowCount === 1 ? "" : "s"})`
        }`
      );
    }
  }

  for (const script of suite.scripts) {
    await reportStale(path.join(outRoot, script.folder), script.tables.map((table) => table.filename));
  }

  console.log("");
  console.log("  ten columns: source_table, target_table, source_column, target_column, type,");
  console.log("               source_value, target_value, accuracy, result, comments");
  if (suite.notice) console.log(`
  Note: comments is empty — ${suite.notice}`);
}

/**
 * The per-report business checks, written straight after the layer reports and from the same project.
 *
 * The third folder exists because the third question is not a variant of the other two. The hop
 * bundles ask whether a pair of layers ties out and the layer reports ask whether a column still agrees
 * with what built it; both compare a table with its sources, and the last table of a data mart has
 * hardly any. `rpt_snowball`'s movement columns exist in no source table — they are eight readings of
 * one upstream column — so the first two folders describe the report almost entirely by what they could
 * not check. What is checkable there is internal (the movements reach the closing balance, the
 * subtotals the SQL declares still hold, one period's close opens the next) or end to end (the business
 * measure the report shows is still the one that entered the pipeline), and that is what this writes.
 */
async function writeBusinessReconciliation(
  args: Args,
  project: LocalProject,
  layers: LayerRef[],
  platform: SqlPlatform
): Promise<void> {
  console.log(
    "\nChecking the reporting tables on their own terms, and asking the reviewer model to explain each check..."
  );

  const suite = await buildBusinessReconciliation(project, layers, args.useAi, platform);
  const outRoot = path.join(args.dir, args.out, BUSINESS_RECON_DIR);
  await mkdir(outRoot, { recursive: true });

  const written: string[] = [];
  for (const script of suite.scripts) {
    await writeFile(path.join(outRoot, script.filename), script.sql, "utf8");
    written.push(script.filename);
  }

  // A folder holding one file that says why, rather than an absent folder: a folder missing from the
  // listing is indistinguishable from a run that never got this far.
  if (suite.scripts.length === 0) {
    const empty = noBusinessChecksFile(suite, platform);
    await writeFile(path.join(outRoot, empty.filename), empty.sql, "utf8");
    written.push(empty.filename);
  }

  await writeFile(path.join(outRoot, "SUMMARY.txt"), summarizeBusinessReconciliation(suite, new Date()), "utf8");

  console.log("");
  console.log(`Wrote ${outRoot}`);
  if (suite.scripts.length === 0) {
    console.log("  no reporting table carries a business check derivable from its SQL —");
    console.log(`  ${written[0]} lists every table this pipeline ends at and why`);
  }
  for (const script of suite.scripts) {
    console.log(
      `  ${script.filename}  (${script.table}: ${script.checkCount} check${script.checkCount === 1 ? "" : "s"} — ` +
        `${script.walkCount} roll-forward, ${script.identityCount} stated identit` +
        `${script.identityCount === 1 ? "y" : "ies"}, ${script.traceCount} measure trace` +
        `${script.traceCount === 1 ? "" : "s"}` +
        `${script.commentedCount > 0 ? `, ${script.commentedCount} explained` : ""})`
    );
  }
  for (const entry of suite.skipped) {
    console.log(`  (skipped ${entry.table} — nothing about it could be checked as a report)`);
  }

  await reportStale(outRoot, written);

  if (suite.scripts.length > 0) {
    console.log("");
    console.log("  thirteen columns: check_seq, check_name, business_term, source_table, target_table,");
    console.log("                    period_slice, period, source_value, target_value, difference,");
    console.log("                    accuracy, status, comments");
    if (suite.notice) console.log(`\n  Note: comments is empty — ${suite.notice}`);
  }
}

async function runScripts(args: Args): Promise<void> {
  loadEnv(args.dir, args.envFile);
  const project = await scanProject(args);
  const detected = await resolveLayers(project, args);
  printLayers(detected);

  // Opened only for the platform question and closed straight after: leaving readline attached ends
  // stdin for anything that follows it.
  const session = canPrompt(args.autoApprove) ? openPromptSession() : null;
  try {
    await generateAndWriteSuite(args, project, detected.layers, session);
  } finally {
    session?.close();
  }
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
  const detected = await resolveLayers(project, args);
  printLayers(detected);
  const layers = detected.layers;

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

    await generateAndWriteSuite(args, result.project, layers, session, args.document === false);

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
  // The shapes are derived from the graph, so nothing here needs a model to draw them. The one thing
  // that does is working out which layers the hops split on, when this folder has no approved run to
  // take them from — hence `loadEnv`, and hence a missing .env costing detection quality rather than
  // costing the command.
  loadEnv(args.dir, args.envFile);
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

  const detected = await layersForExistingRun(project, args, lineage);
  printLayers(detected);

  console.log("");
  await writeDiagrams(args, project, detected.layers);
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

  const detected = await layersForExistingRun(project, args, lineage);
  printLayers(detected);

  console.log("");
  await writeDocument(args, { project, layers: detected.layers, lineage, template });
}

async function runLayers(args: Args): Promise<void> {
  loadEnv(args.dir, args.envFile);
  const project = await scanProject(args);
  const schemas = project.scan.schemas.join(", ") || "(none — every table is unqualified)";
  console.log("");
  console.log(`Schemas found in this project's SQL: ${schemas}`);
  printLayers(await resolveLayers(project, args));
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
