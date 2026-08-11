import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { buildDiagramComponents } from "../services/diagramComponents.js";
import { buildLineageDiagram } from "../services/lineageDiagram.js";
import { buildPptx } from "../services/pptxWriter.js";
import { LlmConfigError, LlmTimeoutError, reviewLineage } from "../services/llmClient.js";
import { applyLineageOverrides, diffEdges, validateOverrides } from "../services/lineageOverrides.js";
import type { LocalProject } from "../services/localProject.js";
import type {
  LayerRef,
  LineageArtifacts,
  LineageFeedbackRound,
  LineageReview
} from "../types/index.js";

/**
 * The verify loop: show the lineage, ask whether it's right, and let the user correct it in words
 * until it is — before any reconciliation script is written from it.
 *
 * The point of the gate is that everything downstream is built from this graph, so approving it is
 * the one decision worth interrupting for. Corrections go through `applyLineageOverrides`, which
 * rewrites the underlying facts, so an approved lineage is genuinely the lineage the scripts use.
 *
 * The model is only ever asked to *describe* the lineage and to *translate* a correction into edits
 * (`llmClient.reviewLineage` enforces that split). With Azure OpenAI unconfigured the loop still
 * runs: the diagram is drawn, the user can accept or reject it, only free-text correction is lost.
 */

const MAX_ROUNDS = 3;

export interface VerifyOptions {
  dir: string;
  /** Folder name under `dir` for the lineage artifacts. */
  lineageOut: string;
  /** Skip the prompts and accept the extracted lineage — for CI, or a non-interactive terminal. */
  autoApprove: boolean;
  /** Skip the reviewer model entirely; the diagram is still drawn and still needs approving. */
  useAi: boolean;
  /** Don't try to open a browser. */
  noOpen: boolean;
}

export interface VerifyResult {
  approved: boolean;
  /** The project after every accepted correction — this is what governance must be built from. */
  project: LocalProject;
  artifacts: LineageArtifacts;
  htmlPath: string;
}

const EMPTY_REVIEW: LineageReview = { narrative: "", notes: {}, concerns: [], proposed: [] };

/** Resolves to the line entered, or null once input has ended. */
export type Asker = (question: string) => Promise<string | null>;

/**
 * One readline interface for a whole command, not one per question.
 *
 * `reconcile run` asks about the lineage and then, at the end, about the document. Closing the
 * interface in between would end input for good (see `makeAsker` — closing tears `process.stdin`
 * down), so the session is opened once by the command and handed to everything that asks.
 */
export interface PromptSession {
  ask: Asker;
  close(): void;
}

export function openPromptSession(): PromptSession {
  const rl = createInterface({ input: process.stdin });
  return { ask: makeAsker(rl), close: () => rl.close() };
}

/** True when there is a human to ask: a TTY, and no flag saying to answer for them. */
export function canPrompt(autoApprove: boolean): boolean {
  return process.stdin.isTTY === true && !autoApprove;
}

/**
 * Reads answers off one readline interface, queueing lines that arrive before they're asked for.
 *
 * Two things make the obvious `rl.question()` call wrong here. One interface per question would tear
 * down `process.stdin` on close, so every question after the first reads EOF. And `rl.question()`
 * registers a *one-shot* line listener, which is fine when a human types one answer per prompt but
 * loses input when stdin is a pipe — readline emits every buffered line at once, so answers arriving
 * before their prompt are dropped and the run then hangs on a promise nothing will resolve. Queueing
 * makes `reconcile run` scriptable as well as interactive.
 *
 * End of input resolves to null rather than "", because "" is a real answer (bare Enter accepts the
 * default) and closed input must never be read as approval.
 */
function makeAsker(rl: ReturnType<typeof createInterface>): Asker {
  const buffered: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;

  rl.on("line", (line: string) => {
    const next = waiting.shift();
    if (next) next(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    ended = true;
    for (const next of waiting.splice(0)) next(null);
  });

  return (question) => {
    process.stdout.write(question);
    const queued = buffered.shift();
    if (queued !== undefined) {
      process.stdout.write(`${queued}\n`);
      return Promise.resolve(queued);
    }
    if (ended) return Promise.resolve(null);
    return new Promise((resolve) => waiting.push(resolve));
  };
}

/**
 * Yes/no/exit, re-asking until one of them is given. A bare Enter accepts the default ("yes"); input
 * ending mid-question is treated as "exit", never as approval.
 */
export async function askChoice(ask: Asker, question: string): Promise<"yes" | "no" | "exit"> {
  for (;;) {
    const raw = await ask(question);
    if (raw === null) {
      console.log("\nInput ended before this was answered — stopping without approving.");
      return "exit";
    }
    const answer = raw.trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") return "yes";
    if (answer === "n" || answer === "no") return "no";
    if (answer === "e" || answer === "exit" || answer === "q" || answer === "quit") return "exit";
    console.log('  Please answer "yes", "no" or "exit".');
  }
}

/** Best-effort — a CLI that can't open a browser prints the path and carries on. */
function openInBrowser(target: string): void {
  const command =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the path is printed either way */
  }
}

/** Sits beside `lineage.html`, so the editable copy is one click from the picture being reviewed. */
const DECK_FILENAME = "lineage.pptx";

/**
 * Writes the review page and, next to it, the same diagram as an editable deck.
 *
 * The deck is written here rather than only by `reconcile diagrams` because this is the moment someone
 * is looking at the graph and deciding what to do with it — being told to run another command to take it
 * away is a worse answer than the file already being there. Both are rewritten together after every
 * correction round, so the deck can never show a lineage the page has moved on from.
 *
 * A deck that fails to build must not take the review down with it: the page is what the user is about
 * to be asked to approve, and the export is a convenience. So the failure costs the link and nothing
 * else.
 */
async function writeDiagram(
  options: VerifyOptions,
  project: LocalProject,
  layers: LayerRef[],
  review: LineageReview
): Promise<string> {
  const graph = {
    projectName: project.folderName,
    edges: project.scan.lineage,
    layers,
    tables: project.scan.tables
  };

  const outDir = path.join(options.dir, options.lineageOut);
  await mkdir(outDir, { recursive: true });

  let deckFile: string | undefined;
  try {
    const deck = buildPptx(buildDiagramComponents(graph), {
      title: `${project.folderName} — lineage`
    });
    await writeFile(path.join(outDir, DECK_FILENAME), deck);
    deckFile = DECK_FILENAME;
  } catch (err) {
    console.log(`  (couldn't write ${DECK_FILENAME}: ${err instanceof Error ? err.message : String(err)})`);
  }

  // The file list is the page's only, and the deck deliberately not: a folder tree is a page-sized
  // thing to read, not a slide.
  const diagram = buildLineageDiagram({
    ...graph,
    notes: review.notes,
    deckFile,
    files: project.scan.files
  });

  const htmlPath = path.join(outDir, "lineage.html");
  await writeFile(htmlPath, diagram.html, "utf8");
  return htmlPath;
}

/** Asks the model to describe the lineage, degrading to no commentary if it can't. */
async function describe(project: LocalProject, layers: LayerRef[], useAi: boolean): Promise<LineageReview> {
  if (!useAi) return EMPTY_REVIEW;
  try {
    process.stdout.write("Asking the reviewer model to describe the lineage... ");
    const review = await reviewLineage({
      projectName: project.folderName,
      layers,
      edges: project.scan.lineage,
      tables: project.scan.tables
    });
    console.log("done.");
    return review;
  } catch (err) {
    console.log("skipped.");
    if (err instanceof LlmConfigError) {
      console.log("  Azure OpenAI isn't configured, so the diagram comes without commentary.");
      console.log("  The lineage itself is parsed from the SQL and is unaffected.");
    } else if (err instanceof LlmTimeoutError) {
      console.log("  The model didn't answer in time. The lineage itself is unaffected.");
    } else {
      console.log(`  ${err instanceof Error ? err.message : String(err)}`);
    }
    return EMPTY_REVIEW;
  }
}

function printSummary(project: LocalProject, layers: LayerRef[], review: LineageReview, htmlPath: string): void {
  const { stats } = project.scan;
  console.log("");
  console.log("─".repeat(72));
  console.log(`  ${stats.tableCount} tables, ${stats.lineageEdgeCount} lineage edges, ${layers.length} layers`);
  if (layers.length > 0) console.log(`  ${layers.map((l) => l.label).join(" -> ")}`);
  if (review.narrative) {
    console.log("");
    for (const line of wrap(review.narrative, 68)) console.log(`  ${line}`);
  }
  if (review.concerns.length > 0) {
    console.log("");
    console.log("  Worth a look:");
    for (const concern of review.concerns.slice(0, 6)) {
      for (const [i, line] of wrap(concern, 64).entries()) console.log(`    ${i === 0 ? "-" : " "} ${line}`);
    }
  }
  console.log("");
  console.log(`  Diagram: ${pathToFileURL(htmlPath).href}`);
  console.log("─".repeat(72));
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length > 0 && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Turns one free-text instruction into applied corrections, reporting exactly what it did. */
async function applyInstruction(
  project: LocalProject,
  layers: LayerRef[],
  instruction: string,
  round: number,
  priorOverrides: LineageFeedbackRound[]
): Promise<{ project: LocalProject; round: LineageFeedbackRound }> {
  process.stdout.write("Working out what that changes... ");
  const review = await reviewLineage({
    projectName: project.folderName,
    layers,
    edges: project.scan.lineage,
    tables: project.scan.tables,
    userInstruction: instruction,
    priorOverrides: priorOverrides.flatMap((r) => r.applied)
  });
  console.log("done.");

  // Two guards, in order: the model may not name a table this project has never heard of, and it may
  // not claim an edit that doesn't correspond to a real statement.
  const { kept, dropped } = validateOverrides(review.proposed, project.scan.tables);
  const outcome = applyLineageOverrides(project, kept);
  const diff = diffEdges(project.scan.lineage, outcome.project.scan.lineage);

  if (outcome.applied.length === 0) {
    console.log("  Nothing changed — the correction didn't map onto any statement in this project.");
  } else {
    for (const edge of diff.removed) console.log(`  - removed  ${edge.from} -> ${edge.to}`);
    for (const edge of diff.added) console.log(`  + added    ${edge.from} -> ${edge.to}`);
  }
  for (const d of [...dropped, ...outcome.discarded]) {
    console.log(`  ! ignored  ${d.override.kind} ${d.override.from} -> ${d.override.to}: ${d.why}`);
  }

  return {
    project: outcome.project,
    round: {
      round,
      instruction,
      applied: outcome.applied,
      discarded: [...dropped, ...outcome.discarded].map((d) => d.override)
    }
  };
}

function buildArtifacts(
  project: LocalProject,
  layers: LayerRef[],
  review: LineageReview,
  feedback: LineageFeedbackRound[],
  approved: boolean
): LineageArtifacts {
  return {
    generatedAt: new Date().toISOString(),
    projectName: project.folderName,
    approved,
    layers,
    edges: project.scan.lineage,
    tables: project.scan.tables,
    narrative: review.narrative,
    concerns: review.concerns,
    notes: review.notes,
    feedback,
    stats: {
      fileCount: project.scan.stats.fileCount,
      statementCount: project.scan.stats.statementCount,
      tableCount: project.scan.stats.tableCount,
      edgeCount: project.scan.stats.lineageEdgeCount,
      layerCount: layers.length
    }
  };
}

/**
 * @param session an already-open prompt session to ask on. `reconcile run` passes the one it also
 *   uses for the document question at the end; without it this opens and closes its own.
 */
export async function verifyLineage(
  initial: LocalProject,
  layers: LayerRef[],
  options: VerifyOptions,
  session?: PromptSession | null
): Promise<VerifyResult> {
  let project = initial;
  let review = await describe(project, layers, options.useAi);
  const feedback: LineageFeedbackRound[] = [];

  let htmlPath = await writeDiagram(options, project, layers, review);

  // A non-interactive terminal can't be asked, so it is told instead — failing here would make the
  // command unusable in CI for no safety gain, since nothing is written outside --dir.
  const interactive = canPrompt(options.autoApprove);
  if (!interactive) {
    printSummary(project, layers, review, htmlPath);
    console.log(
      options.autoApprove
        ? "\n--auto-approve given: accepting the extracted lineage without review."
        : "\nNot an interactive terminal: accepting the extracted lineage without review."
    );
    return { approved: true, project, artifacts: buildArtifacts(project, layers, review, feedback, true), htmlPath };
  }

  if (!options.noOpen) openInBrowser(pathToFileURL(htmlPath).href);

  // A session passed in belongs to the caller, which has more questions to ask on it later; only one
  // opened here is closed here.
  const owned = session ?? openPromptSession();
  try {
    return await verifyLoop(project, layers, options, review, htmlPath, feedback, owned.ask);
  } finally {
    if (!session) owned.close();
  }
}

/** The question loop itself, split out so the readline interface is closed on every exit path. */
async function verifyLoop(
  project: LocalProject,
  layers: LayerRef[],
  options: VerifyOptions,
  review: LineageReview,
  htmlPath: string,
  feedback: LineageFeedbackRound[],
  ask: Asker
): Promise<VerifyResult> {
  for (let round = 1; ; round++) {
    printSummary(project, layers, review, htmlPath);

    const verdict = await askChoice(ask, "\nIs this lineage correct? [yes] / no / exit: ");

    if (verdict === "exit") {
      console.log("Stopped. No reconciliation scripts were written.");
      return {
        approved: false,
        project,
        artifacts: buildArtifacts(project, layers, review, feedback, false),
        htmlPath
      };
    }

    if (verdict === "yes") {
      return { approved: true, project, artifacts: buildArtifacts(project, layers, review, feedback, true), htmlPath };
    }

    if (round >= MAX_ROUNDS) {
      console.log(`\nThat's ${MAX_ROUNDS} rounds of corrections — stopping here so this doesn't loop.`);
      console.log("Re-run once the SQL or the --layers are adjusted.");
      return {
        approved: false,
        project,
        artifacts: buildArtifacts(project, layers, review, feedback, false),
        htmlPath
      };
    }

    const wantsToExplain = await askChoice(ask, "Do you want to give more information? [yes] / no / exit: ");
    if (wantsToExplain === "exit") {
      console.log("Stopped. No reconciliation scripts were written.");
      return {
        approved: false,
        project,
        artifacts: buildArtifacts(project, layers, review, feedback, false),
        htmlPath
      };
    }
    if (wantsToExplain === "no") {
      console.log("Nothing to change, then — showing the same lineage again.");
      continue;
    }

    if (!options.useAi) {
      console.log("\nCorrections need the reviewer model, which is off (--no-ai). Re-run without it to");
      console.log("describe changes in words, or adjust the SQL / --layers directly.");
      continue;
    }

    console.log("\nDescribe what's wrong — e.g. \"bronze.payments also feeds silver.invoices\",");
    console.log('or "silver.audit_log is not a source for anything".');
    const typed = await ask("> ");
    const instruction = (typed ?? "").trim();
    if (instruction.length === 0) {
      console.log("Nothing entered — showing the same lineage again.");
      continue;
    }

    try {
      const applied = await applyInstruction(project, layers, instruction, round, feedback);
      project = applied.project;
      feedback.push(applied.round);
    } catch (err) {
      if (err instanceof LlmConfigError) {
        console.log("\nAzure OpenAI isn't configured, so free-text corrections aren't available.");
        console.log("Set AZURE_OPENAI_* (see --env-file) to use them.");
      } else if (err instanceof LlmTimeoutError) {
        console.log("\nThe model didn't answer in time. Nothing was changed — try a shorter instruction.");
      } else {
        console.log(`\nCouldn't apply that: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    // Re-describe the corrected graph so the narrative and notes match what is now on screen.
    review = await describe(project, layers, options.useAi);
    htmlPath = await writeDiagram(options, project, layers, review);
    if (!options.noOpen) console.log("Diagram updated — refresh the page in your browser.");
  }
}

/**
 * Reads back what a previous `reconcile run` approved, or null when this folder has never had one.
 *
 * Deliberately forgiving: a lineage file that is missing, unreadable or not the shape it should be is
 * a reason to document the freshly extracted lineage instead, not a reason to fail. The caller says
 * which of the two it got.
 */
export async function readLineageArtifacts(dir: string, lineageOut: string): Promise<LineageArtifacts | null> {
  try {
    const raw = await readFile(path.join(dir, lineageOut, "lineage.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<LineageArtifacts>;
    if (!Array.isArray(parsed.edges) || !Array.isArray(parsed.layers)) return null;
    return {
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
      projectName: typeof parsed.projectName === "string" ? parsed.projectName : "",
      approved: parsed.approved === true,
      layers: parsed.layers,
      edges: parsed.edges,
      tables: Array.isArray(parsed.tables) ? parsed.tables : [],
      narrative: typeof parsed.narrative === "string" ? parsed.narrative : "",
      concerns: Array.isArray(parsed.concerns) ? parsed.concerns.filter((c): c is string => typeof c === "string") : [],
      notes: parsed.notes && typeof parsed.notes === "object" ? parsed.notes : {},
      feedback: Array.isArray(parsed.feedback) ? parsed.feedback : [],
      stats: parsed.stats ?? { fileCount: 0, statementCount: 0, tableCount: 0, edgeCount: 0, layerCount: 0 }
    };
  } catch {
    return null;
  }
}

/** Writes `lineage.json` and, when the user corrected anything, `lineage-feedback.json`. */
export async function writeLineageArtifacts(options: VerifyOptions, artifacts: LineageArtifacts): Promise<string> {
  const outDir = path.join(options.dir, options.lineageOut);
  await mkdir(outDir, { recursive: true });

  await writeFile(path.join(outDir, "lineage.json"), `${JSON.stringify(artifacts, null, 2)}\n`, "utf8");
  if (artifacts.feedback.length > 0) {
    await writeFile(
      path.join(outDir, "lineage-feedback.json"),
      `${JSON.stringify(artifacts.feedback, null, 2)}\n`,
      "utf8"
    );
  }
  return outDir;
}

/**
 * One of a fixed set of options, re-asked until one is given. A bare Enter takes `fallback`; input
 * ending mid-question takes it too, so a piped run is never left waiting on an answer nobody typed.
 *
 * Matching is by prefix as well as by full name, because nobody wants to type "databricks" to answer
 * a question whose options are on the screen in front of them.
 */
export async function askOption<T extends string>(
  ask: Asker,
  question: string,
  options: readonly T[],
  fallback: T
): Promise<T> {
  for (;;) {
    const raw = await ask(question);
    if (raw === null) {
      console.log(`\nInput ended before this was answered — using ${fallback}.`);
      return fallback;
    }
    const answer = raw.trim().toLowerCase();
    if (answer === "") return fallback;

    const exact = options.find((option) => option.toLowerCase() === answer);
    if (exact) return exact;
    const prefixed = options.filter((option) => option.toLowerCase().startsWith(answer));
    if (prefixed.length === 1) return prefixed[0];

    console.log(`  Please answer one of: ${options.join(", ")}.`);
  }
}
