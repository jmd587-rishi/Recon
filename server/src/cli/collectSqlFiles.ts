import { promises as fs } from "node:fs";
import path from "node:path";
import type { LocalSkippedFile, LocalSqlFileInput } from "../types/index.js";

/**
 * Walks a folder on disk and collects its `.sql` files, the CLI's counterpart to
 * `client/src/local/sqlFiles.ts` (which does the same thing over a browser `FileList`). The caps are
 * far more generous than the browser's — nothing here crosses a network request — but they still
 * exist so a CLI pointed at the wrong directory (a monorepo root, `node_modules` not excluded by the
 * caller) fails predictably instead of reading gigabytes.
 */

export const DEFAULT_MAX_FILES = 5000;
export const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Directories never worth descending into, regardless of what's being reconciled. */
const ALWAYS_EXCLUDED = new Set([
  "node_modules", ".git", ".hg", ".svn", ".vs", ".vscode", ".idea", "dist", "build", "bin", "obj", ".venv"
]);

export interface CollectOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /** Extra directory names to skip, beyond `ALWAYS_EXCLUDED` — typically the CLI's own output folder. */
  excludeDirs?: string[];
}

export interface CollectResult {
  folderName: string;
  files: LocalSqlFileInput[];
  skipped: LocalSkippedFile[];
  otherFileCount: number;
  truncated: boolean;
}

function isSqlFileName(name: string): boolean {
  return name.toLowerCase().endsWith(".sql");
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

export async function collectSqlFiles(rootDir: string, options: CollectOptions = {}): Promise<CollectResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const exclude = new Set([...ALWAYS_EXCLUDED, ...(options.excludeDirs ?? []).map((d) => d.toLowerCase())]);

  const resolved = path.resolve(rootDir);
  const allPaths: string[] = [];
  await walk(resolved, resolved, exclude, allPaths);
  allPaths.sort((a, b) => a.localeCompare(b));

  const sqlPaths = allPaths.filter(isSqlFileName);

  const files: LocalSqlFileInput[] = [];
  const skipped: LocalSkippedFile[] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const relPath of sqlPaths) {
    const absPath = path.join(resolved, relPath);
    const stat = await fs.stat(absPath);

    if (stat.size > maxFileBytes) {
      skipped.push({ path: relPath, reason: `too large (${formatKb(stat.size)}, limit ${formatKb(maxFileBytes)})` });
      continue;
    }
    if (files.length >= maxFiles) {
      skipped.push({ path: relPath, reason: `over the ${maxFiles}-file limit` });
      truncated = true;
      continue;
    }
    if (totalBytes + stat.size > maxTotalBytes) {
      skipped.push({ path: relPath, reason: `over the ${formatKb(maxTotalBytes)} total limit` });
      truncated = true;
      continue;
    }

    totalBytes += stat.size;
    files.push({ path: relPath, content: await fs.readFile(absPath, "utf8") });
  }

  return {
    folderName: path.basename(resolved) || resolved,
    files,
    skipped,
    otherFileCount: allPaths.length - sqlPaths.length,
    truncated
  };
}
