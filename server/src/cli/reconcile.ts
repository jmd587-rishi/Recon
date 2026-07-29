#!/usr/bin/env node
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAiReconciliationSuite } from "../services/aiReconciliation.js";
import { detectLayers, unassignedSchemas } from "../services/layers.js";
import { LlmConfigError } from "../services/llmClient.js";
import type { LocalProject } from "../services/localProject.js";
import { buildReconciliationSuite } from "../services/reconciliationScripts.js";
import { buildLocalProject, collectSourceFiles } from "./collectSourceFiles.js";
import { verifyLineage, writeLineageArtifacts, type VerifyOptions } from "./lineagePrompt.js";
import type { LayerRef, LocalReconciliationSuite } from "../types/index.js";

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
 */

const USAGE = `
reconcile <command> [options]

Commands:
  run         Build the lineage, confirm it, then write the reconciliation scripts
  scripts     Write one reconciliation query per hop into a governance/ folder
  layers      Detect and print the pipeline layers only — writes nothing

Options:
  --dir <path>        Project folder to scan (default: current directory)
  --out <name>         Output folder name, created under --dir (default: governance)
  --lineage-out <name> Folder for the lineage diagram and data (default: lineage)
  --layers a,b,c      Schema names, most-raw first, overriding auto-detection
  --env-file <path>   .env file with AZURE_OPENAI_* settings (default: <dir>/.env, then ./.env)
  --no-ai             Skip the reviewer model — write only the schema-derived standard checks
  --no-notebooks      Read .sql files only, ignoring Databricks notebooks
  --auto-approve      run: accept the extracted lineage without prompting (for CI)
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
  reconcile run --layers raw,staged,mart --out recon
  reconcile scripts --split
`.trim();

interface Args {
  command: "run" | "scripts" | "layers" | "help";
  dir: string;
  out: string;
  lineageOut: string;
  layers: string[] | null;
  envFile: string | null;
  useAi: boolean;
  includeNotebooks: boolean;
  autoApprove: boolean;
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
    layers: null,
    envFile: null,
    useAi: true,
    includeNotebooks: true,
    autoApprove: false,
    noOpen: false,
    split: false,
    oneFile: false,
    maxFiles: undefined
  };

  const rest = [...argv];
  const first = rest[0];
  if (first === "run" || first === "scripts" || first === "layers") {
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
    excludeDirs: [args.out, args.lineageOut],
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
  oneFile: boolean
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
async function generateAndWriteSuite(args: Args, project: LocalProject, layers: LayerRef[]): Promise<void> {
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

  await writeSuite(args.dir, args.out, suite, args.split, args.oneFile);
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
 */
async function runFull(args: Args): Promise<void> {
  loadEnv(args.dir, args.envFile);
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

  const result = await verifyLineage(project, layers, options);
  const lineageDir = await writeLineageArtifacts(options, result.artifacts);

  if (!result.approved) {
    console.log(`\nLineage so far is in ${lineageDir} — nothing was generated from it.`);
    return;
  }

  console.log(`\nLineage approved. Wrote ${lineageDir}`);
  console.log("  lineage.html  (the diagram you just reviewed)");
  console.log("  lineage.json  (the approved graph)");
  if (result.artifacts.feedback.length > 0) {
    console.log(`  lineage-feedback.json  (${result.artifacts.feedback.length} round(s) of corrections)`);
  }

  await generateAndWriteSuite(args, result.project, layers);
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
    else await runLayers(args);
  } catch (err) {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
