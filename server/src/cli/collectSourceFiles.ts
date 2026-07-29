import { promises as fs } from "node:fs";
import path from "node:path";
import { buildScanResult, type LocalProject, type ParsedLocalFile } from "../services/localProject.js";
import { parseNotebookSource } from "../services/notebookParser.js";
import { extractLineageFacts, resolveTempTableSources } from "../services/tableLineage.js";
import type { LocalSkippedFile, LocalSqlFileInput, NotebookMeta } from "../types/index.js";
import { parseLocalProject } from "../services/localProject.js";

/**
 * Walks a folder on disk and collects everything the analysis can read — `.sql` files *and*
 * Databricks notebook exports — the CLI's counterpart to `client/src/local/sqlFiles.ts`.
 *
 * The browser flow only ever sees `.sql`, because that is what a user can practically drag into a
 * page. A CLI is pointed at a repo, and a Databricks repo is full of `.py` notebooks, so restricting
 * this to `.sql` would make `reconcile` find nothing at all in the most common case. Both kinds end
 * up as `LineageFact`s, which is the only thing the reconciliation scripts read.
 *
 * Caps are far more generous than the browser's — nothing here crosses a network request — but they
 * still exist so a CLI pointed at a monorepo root fails predictably instead of reading gigabytes.
 */

export const DEFAULT_MAX_FILES = 5000;
export const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Directories never worth descending into, regardless of what's being reconciled. */
const ALWAYS_EXCLUDED = new Set([
  "node_modules", ".git", ".hg", ".svn", ".vs", ".vscode", ".idea", "dist", "build", "bin", "obj", ".venv"
]);

const NOTEBOOK_LANGUAGE: Record<string, NotebookMeta["language"]> = {
  ".py": "PYTHON",
  ".scala": "SCALA",
  ".r": "R"
};

export interface NotebookInput {
  path: string;
  source: string;
  language: NotebookMeta["language"];
}

export interface CollectOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /** Extra directory names to skip, beyond `ALWAYS_EXCLUDED` — typically the CLI's own output folders. */
  excludeDirs?: string[];
  /** Set false to ignore notebooks and read `.sql` only. */
  includeNotebooks?: boolean;
}

export interface CollectResult {
  folderName: string;
  sqlFiles: LocalSqlFileInput[];
  notebooks: NotebookInput[];
  skipped: LocalSkippedFile[];
  otherFileCount: number;
  truncated: boolean;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/** Recursively lists every file under `root`, relative-pathed with forward slashes throughout. */
async function walk(root: string, dir: string, exclude: Set<string>, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (exclude.has(entry.name.toLowerCase())) continue;
      await walk(root, path.join(dir, entry.name), exclude, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"));
    }
  }
}

function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Flattens a `.ipynb` into the Databricks source format `parseNotebookSource` already understands,
 * rather than teaching that parser a second format. Only code cells carry lineage.
 */
export function ipynbToSource(json: string): { source: string; language: NotebookMeta["language"] } | null {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.cells)) return null;

  const kernel = String(parsed?.metadata?.kernelspec?.language ?? "python").toLowerCase();
  const language: NotebookMeta["language"] = kernel.startsWith("scala")
    ? "SCALA"
    : kernel === "r"
      ? "R"
      : kernel.startsWith("sql")
        ? "SQL"
        : "PYTHON";

  const comment = language === "SQL" ? "--" : language === "SCALA" ? "//" : "#";
  const bodies = parsed.cells
    .filter((cell: any) => cell?.cell_type === "code")
    .map((cell: any) => (Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "")))
    .filter((body: string) => body.trim().length > 0);

  if (bodies.length === 0) return null;
  return { source: bodies.join(`\n\n${comment} COMMAND ----------\n\n`), language };
}

export async function collectSourceFiles(rootDir: string, options: CollectOptions = {}): Promise<CollectResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const includeNotebooks = options.includeNotebooks ?? true;
  const exclude = new Set([...ALWAYS_EXCLUDED, ...(options.excludeDirs ?? []).map((d) => d.toLowerCase())]);

  const resolved = path.resolve(rootDir);
  const allPaths: string[] = [];
  await walk(resolved, resolved, exclude, allPaths);
  allPaths.sort((a, b) => a.localeCompare(b));

  const readable = allPaths.filter((p) => {
    const ext = extensionOf(p);
    if (ext === ".sql") return true;
    if (!includeNotebooks) return false;
    return ext === ".ipynb" || ext in NOTEBOOK_LANGUAGE;
  });

  const sqlFiles: LocalSqlFileInput[] = [];
  const notebooks: NotebookInput[] = [];
  const skipped: LocalSkippedFile[] = [];
  let totalBytes = 0;
  let truncated = false;
  let accepted = 0;

  for (const relPath of readable) {
    const absPath = path.join(resolved, relPath);
    const stat = await fs.stat(absPath);

    if (stat.size > maxFileBytes) {
      skipped.push({ path: relPath, reason: `too large (${formatKb(stat.size)}, limit ${formatKb(maxFileBytes)})` });
      continue;
    }
    if (accepted >= maxFiles) {
      skipped.push({ path: relPath, reason: `over the ${maxFiles}-file limit` });
      truncated = true;
      continue;
    }
    if (totalBytes + stat.size > maxTotalBytes) {
      skipped.push({ path: relPath, reason: `over the ${formatKb(maxTotalBytes)} total limit` });
      truncated = true;
      continue;
    }

    const content = await fs.readFile(absPath, "utf8");
    const ext = extensionOf(relPath);

    if (ext === ".sql") {
      sqlFiles.push({ path: relPath, content });
    } else if (ext === ".ipynb") {
      const converted = ipynbToSource(content);
      if (!converted) {
        skipped.push({ path: relPath, reason: "no code cells found" });
        continue;
      }
      notebooks.push({ path: relPath, source: converted.source, language: converted.language });
    } else {
      notebooks.push({ path: relPath, source: content, language: NOTEBOOK_LANGUAGE[ext] ?? "UNKNOWN" });
    }

    totalBytes += stat.size;
    accepted++;
  }

  return {
    folderName: path.basename(resolved) || resolved,
    sqlFiles,
    notebooks,
    skipped,
    otherFileCount: allPaths.length - readable.length,
    truncated
  };
}

/**
 * Turns collected notebooks into the same `ParsedLocalFile` shape SQL files take.
 *
 * `statements` is left empty on purpose: it exists so a corrected statement can be spliced back into
 * the original file by byte span, and a notebook cell has no such span. Nothing on the reconciliation
 * path needs it — `gatherReconciliationFacts` and `aiReconciliation` read `project.facts` and
 * `project.folderName` only — so notebooks cost nothing to support here. The `/api/local` governance
 * flow, which *does* splice, never sees these files.
 */
function parseNotebooks(notebooks: NotebookInput[], skipped: LocalSkippedFile[]): ParsedLocalFile[] {
  const files: ParsedLocalFile[] = [];

  for (const notebook of notebooks) {
    const parsed = parseNotebookSource(notebook.path, notebook.source, notebook.language);
    // Temp tables are scoped to the notebook that creates them, so each resolves on its own —
    // the same rule `parseLocalProject` applies per SQL file.
    const facts = resolveTempTableSources(extractLineageFacts(parsed));
    if (facts.length === 0) {
      skipped.push({ path: notebook.path, reason: "no table reads or writes found" });
      continue;
    }
    files.push({ path: notebook.path, content: notebook.source, statements: [], facts });
  }

  return files;
}

/**
 * Builds one project from both halves of a collection, so downstream code never has to care whether
 * a fact came from a `.sql` file or a notebook cell.
 */
export function buildLocalProject(collected: CollectResult): LocalProject {
  const sqlProject = parseLocalProject(collected.folderName, collected.sqlFiles);

  const skipped: LocalSkippedFile[] = [...collected.skipped, ...sqlProject.scan.skipped];
  const notebookFiles = parseNotebooks(collected.notebooks, skipped);

  if (notebookFiles.length === 0) {
    return { ...sqlProject, scan: { ...sqlProject.scan, skipped } };
  }

  const files = [...sqlProject.files, ...notebookFiles];
  return {
    folderName: collected.folderName,
    files,
    facts: files.flatMap((f) => f.facts),
    scan: buildScanResult(collected.folderName, files, skipped)
  };
}
