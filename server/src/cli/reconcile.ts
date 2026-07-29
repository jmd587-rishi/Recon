#!/usr/bin/env node
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAiReconciliationSuite } from "../services/aiReconciliation.js";
import { detectLayers, unassignedSchemas } from "../services/layers.js";
import { parseLocalProject } from "../services/localProject.js";
import { LlmConfigError } from "../services/llmClient.js";
import { buildReconciliationSuite } from "../services/reconciliationScripts.js";
import { collectSqlFiles } from "./collectSqlFiles.js";
import type { LayerRef, LocalReconciliationSuite } from "../types/index.js";

/**
 * `reconcile scripts` — the L4 tab (`/local/reconciliation` in the running app) as a standalone
 * command, for a data engineering project that was never uploaded anywhere. Same services, same
 * two-tier checks (`reconciliationScripts.templateChecks` derived from the columns, plus whatever
 * `aiReconciliation.ts` can add from reading the transformation SQL), same fallback when Azure OpenAI
 * isn't configured — just reading straight off disk and writing straight back to disk instead of
 * going through the browser's upload/zip round trip.
 *
 * `reconcile layers` runs only the scan + layer-detection step, so a schema-naming convention the
 * heuristic doesn't recognise can be sorted out with `--layers` before spending an LLM call on it.
 */

const USAGE = `
reconcile <command> [options]

Commands:
  scripts     Write reconciliation SQL for the current project into a governance/ folder
  layers      Detect and print the pipeline layers only — writes nothing

Options:
  --dir <path>        Project folder to scan (default: current directory)
  --out <name>         Output folder name, created under --dir (default: governance)
  --layers a,b,c      Schema names, most-raw first, overriding auto-detection
  --env-file <path>   .env file with AZURE_OPENAI_* settings (default: <dir>/.env, then ./.env)
  --no-ai             Skip the reviewer model — write only the schema-derived standard checks
  --max-files <n>     Cap on how many .sql files are read (default: ${5000})
  -h, --help          Show this help

Examples:
  cd C:\\projects\\my-warehouse
  reconcile layers
  reconcile scripts
  reconcile scripts --layers raw,staged,mart --out recon
`.trim();

interface Args {
  command: "scripts" | "layers" | "help";
  dir: string;
  out: string;
  layers: string[] | null;
  envFile: string | null;
  useAi: boolean;
  maxFiles: number | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "help", dir: process.cwd(), out: "governance", layers: null, envFile: null, useAi: true, maxFiles: undefined };

  const rest = [...argv];
  const first = rest[0];
  if (first === "scripts" || first === "layers") {
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

async function scanProject(dir: string, outName: string, maxFiles: number | undefined) {
  const scan = await collectSqlFiles(dir, { maxFiles, excludeDirs: [outName] });
  if (scan.files.length === 0) {
    console.error(`No .sql files found under ${path.resolve(dir)}.`);
    process.exit(1);
  }
  console.log(`Found ${scan.files.length} SQL file${scan.files.length === 1 ? "" : "s"} under ${path.resolve(dir)}.`);
  if (scan.skipped.length > 0) {
    console.log(`Skipped ${scan.skipped.length} file${scan.skipped.length === 1 ? "" : "s"}:`);
    for (const s of scan.skipped.slice(0, 10)) console.log(`  - ${s.path}: ${s.reason}`);
    if (scan.skipped.length > 10) console.log(`  ... and ${scan.skipped.length - 10} more`);
  }
  if (scan.truncated) {
    console.warn("Some files were left out by the caps above — pass --max-files to raise the limit if this project is bigger than that.");
  }

  const project = parseLocalProject(scan.folderName, scan.files);
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

async function writeSuite(dir: string, outName: string, suite: LocalReconciliationSuite): Promise<void> {
  const outRoot = path.join(dir, outName);
  await mkdir(outRoot, { recursive: true });

  for (const hop of suite.hops) {
    const hopDir = path.join(outRoot, hop.folder);
    await mkdir(hopDir, { recursive: true });
    await writeFile(path.join(hopDir, hop.controlTotals.filename), hop.controlTotals.sql, "utf8");
    for (const script of hop.scripts) {
      await writeFile(path.join(hopDir, script.filename), script.sql, "utf8");
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
    `${suite.stats.hopCount} hop(s), ${suite.stats.scriptCount} script(s), ${suite.stats.checkCount} check(s) ` +
      `(${aiChecks} written by the reviewer model, ${suite.stats.checkCount - aiChecks} derived from the schema).`,
    ...(suite.notice ? ["", suite.notice] : []),
    "",
    ...suite.hops.map(
      (hop) =>
        `${hop.folder}/ (${hop.fromLayer && hop.toLayer ? `${hop.fromLayer.label} -> ${hop.toLayer.label}` : "whole project"}): ` +
        `${hop.controlTotals.filename}, ${hop.scripts.map((s) => s.filename).join(", ") || "(no tables found for this hop)"}`
    )
  ];
  await writeFile(path.join(outRoot, "SUMMARY.txt"), `${summaryLines.join("\n")}\n`, "utf8");

  console.log("");
  console.log(`Wrote ${outRoot}`);
  for (const hop of suite.hops) {
    console.log(`  ${hop.folder}/  (${hop.scripts.length} script${hop.scripts.length === 1 ? "" : "s"})`);
  }
  if (suite.notice) console.log(`\nNote: ${suite.notice}`);
}

async function runScripts(args: Args): Promise<void> {
  loadEnv(args.dir, args.envFile);
  const project = await scanProject(args.dir, args.out, args.maxFiles);
  const layers = resolveLayers(project.scan.schemas, args.layers);
  printLayers(project.scan.schemas, layers);

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

  await writeSuite(args.dir, args.out, suite);
}

async function runLayers(args: Args): Promise<void> {
  const project = await scanProject(args.dir, args.out, args.maxFiles);
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
    if (args.command === "scripts") await runScripts(args);
    else await runLayers(args);
  } catch (err) {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
