import type { LocalSkippedFile } from "../types";

/**
 * Locates the pipeline code in a folder the user picked from disk.
 *
 * A directory `<input>` hands back every file under the folder — hundreds of them in a real repo,
 * most irrelevant. Filtering and reading happen here in the browser so only the code text crosses the
 * wire, and so the caps below are enforced before a multi-megabyte request is built rather than
 * after the server rejects it.
 */

export const MAX_FILES = 300;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_TOTAL_BYTES = 6 * 1024 * 1024;

/**
 * Extensions holding pipeline code, kept in step with the server's `codeFiles.CODE_EXTENSIONS` — both
 * sides filter and the server has the last word. A warehouse project is rarely one language: SSDT
 * `.sql` scripts next to Databricks notebooks exported as `.py` or `.scala`, with the lineage running
 * straight through both, so filtering to `.sql` alone leaves half the pipeline looking like it comes
 * from nowhere.
 */
const CODE_EXTENSIONS = [".sql", ".py", ".scala", ".r", ".ipynb"];

export function isSqlFileName(path: string): boolean {
  const lower = path.toLowerCase();
  return CODE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface LocatedSqlFile {
  /** Path relative to the picked folder, including the folder itself. */
  path: string;
  content: string;
  bytes: number;
}

export interface FolderScan {
  folderName: string;
  files: LocatedSqlFile[];
  skipped: LocalSkippedFile[];
  /** How many files in the folder weren't SQL at all — reported as a count, not a list. */
  otherFileCount: number;
}

function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

export async function locateSqlFiles(fileList: FileList): Promise<FolderScan> {
  const all = Array.from(fileList);
  const folderName = all[0]?.webkitRelativePath?.split("/")[0] || "uploaded folder";

  const sqlFiles = all
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }))
    .filter((entry) => isSqlFileName(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  const files: LocatedSqlFile[] = [];
  const skipped: LocalSkippedFile[] = [];
  let totalBytes = 0;

  for (const { file, path } of sqlFiles) {
    if (file.size > MAX_FILE_BYTES) {
      skipped.push({ path, reason: `too large (${formatKb(file.size)}, limit ${formatKb(MAX_FILE_BYTES)})` });
      continue;
    }
    if (files.length >= MAX_FILES) {
      skipped.push({ path, reason: `over the ${MAX_FILES}-file limit` });
      continue;
    }
    if (totalBytes + file.size > MAX_TOTAL_BYTES) {
      skipped.push({ path, reason: `over the ${formatKb(MAX_TOTAL_BYTES)} total limit` });
      continue;
    }

    totalBytes += file.size;
    files.push({ path, content: await file.text(), bytes: file.size });
  }

  return { folderName, files, skipped, otherFileCount: all.length - sqlFiles.length };
}
