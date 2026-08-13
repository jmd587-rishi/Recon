import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown, type DocDocument } from "../services/docModel.js";
import { buildDocx } from "../services/docxWriter.js";
import { BUSINESS_RECON_DIR, HIGH_LEVEL_RECON_DIR, LOGICAL_RECON_DIR } from "../services/governanceLayout.js";
import { applyLineageOverrides, validateOverrides } from "../services/lineageOverrides.js";
import type { LocalProject } from "../services/localProject.js";
import type { LineageArtifacts } from "../types/index.js";

/**
 * The disk side of `reconcile document`: finding the Word template, rebuilding the project the way the
 * user approved it, and writing the two files out.
 *
 * Kept out of `documentation.ts` so that stays pure — it turns a project into a document model and
 * touches nothing else — and out of `reconcile.ts` so the command reads as the four steps it is.
 */

/** The template shipped with Recon. Also the name looked for in the project folder itself. */
const TEMPLATE_FILENAME = "Document Title.docx";

/**
 * Where the shipped template sits relative to this module: `<package>/templates/`.
 *
 * The same two hops up land on it whether this file is running as `dist/cli/documentArtifacts.js`
 * (installed, or after `npm run build`) or as `src/cli/documentArtifacts.ts` (via tsx), which is why
 * `templates/` is a sibling of `src`/`dist` rather than living inside either. `package.json` ships it
 * with `files`, so `npm i -g recon-server` carries the template with the binary — nobody has to supply
 * one for `reconcile document` to produce a branded .docx.
 */
const BUNDLED_TEMPLATE_DIR = ["..", "..", "templates"];

/** How far up from this module to look for the template, so a `git clone` needs no configuration. */
const TEMPLATE_SEARCH_DEPTH = 5;

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** The copy that ships inside the package — the default every run falls back to. */
export function bundledTemplate(): string {
  return path.join(moduleDir(), ...BUNDLED_TEMPLATE_DIR, TEMPLATE_FILENAME);
}

/**
 * Locates the branded Word template.
 *
 * An explicit `--template` wins and is an error if it doesn't exist — being told where the template is
 * and silently using a different one would be worse than failing. Otherwise the project folder is
 * tried (a team can keep its own template beside its SQL), then the copy shipped in the package, then
 * the repository the CLI is running from. So the only reason to pass `--template` at all is to render
 * into a *different* template; the standard one is always there.
 *
 * Finding nothing is still not fatal — a package installed with its `templates/` folder stripped
 * should print the Markdown and say why there is no .docx rather than fail the run.
 */
export function findTemplate(dir: string, explicit: string | null): string | null {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!existsSync(resolved)) {
      throw new Error(`No template at ${resolved} (--template).`);
    }
    return resolved;
  }

  const fromEnv = process.env.RECON_DOC_TEMPLATE?.trim();
  if (fromEnv && existsSync(path.resolve(fromEnv))) return path.resolve(fromEnv);

  const candidates = [path.join(dir, TEMPLATE_FILENAME), bundledTemplate()];
  let up = moduleDir();
  for (let i = 0; i < TEMPLATE_SEARCH_DEPTH; i++) {
    candidates.push(path.join(up, TEMPLATE_FILENAME));
    up = path.dirname(up);
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * The reconciliation scripts already generated in this folder, so the document can point at them.
 *
 * Both folders `reconcile scripts` writes are read — the hop queries and the layer reports — because
 * the report describes both artifacts, and a reader told about a column report has to be told where
 * it is. A nested folder is named as a folder rather than expanded: the layer reports are a file per
 * table, and twenty paths in a sentence is a list nobody reads where four folder names are a place to
 * go. The same goes for the per-hop folders `--split` writes.
 *
 * Loose `.sql` sitting in the governance root is deliberately not listed: since the split into two
 * named folders, anything there is left over from an earlier run (see `reportOldLayout`), and a
 * document is worse for pointing at files describing a pipeline this run no longer produces.
 */
export async function listGovernanceFiles(dir: string, governanceOut: string): Promise<string[]> {
  const found: string[] = [];

  for (const subfolder of [HIGH_LEVEL_RECON_DIR, LOGICAL_RECON_DIR, BUSINESS_RECON_DIR]) {
    let entries;
    try {
      entries = await readdir(path.join(dir, governanceOut, subfolder), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".sql")) {
        found.push(`${governanceOut}/${subfolder}/${entry.name}`);
      } else if (entry.isDirectory()) {
        found.push(`${governanceOut}/${subfolder}/${entry.name}/`);
      }
    }
  }

  return found.sort();
}

export interface CorrectionOutcome {
  project: LocalProject;
  /** Corrections replayed onto the freshly scanned project. */
  applied: number;
  /** Corrections that no longer map onto the SQL — the file has moved on since it was approved. */
  stale: number;
}

/**
 * Replays the lineage corrections recorded at approval time onto the project as it is on disk now.
 *
 * Without this the document would describe lineage the user has already rejected: `reconcile run`
 * applies corrections to the in-memory facts and records them in `lineage.json`, but the SQL on disk
 * is unchanged, so a fresh scan reproduces the original mistake. Replaying them here is what makes
 * "the approved lineage" mean the same thing in the document as it did in the diagram — and because
 * they are applied through `lineageOverrides.ts`, they reach the facts the check counts are derived
 * from, not just the picture.
 *
 * A correction that no longer matches anything is counted as stale rather than forced: the SQL may
 * have been fixed since, in which case the parser is now right and the override is obsolete.
 */
export function applyApprovedLineage(project: LocalProject, lineage: LineageArtifacts | null): CorrectionOutcome {
  const overrides = lineage?.feedback.flatMap((round) => round.applied) ?? [];
  if (overrides.length === 0) return { project, applied: 0, stale: 0 };

  const { kept, dropped } = validateOverrides(overrides, project.scan.tables);
  const outcome = applyLineageOverrides(project, kept);
  return {
    project: outcome.project,
    applied: outcome.applied.length,
    stale: dropped.length + outcome.discarded.length
  };
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "project";
}

export interface WrittenDocument {
  /** Folder the files landed in. */
  dir: string;
  /** Paths written, relative to that folder. */
  files: string[];
  /** Set when there was no template to render into, so only the Markdown was written. */
  templateMissing: boolean;
}

/**
 * Writes the document: the .docx rendered into the template, and the same content as Markdown.
 *
 * Both, always — the .docx is what gets circulated, and the Markdown is what can be diffed against
 * the next run, grepped, or read in a terminal. When no template can be found the Markdown is still
 * the whole document rather than a placeholder, which is the only reason a missing template is a
 * warning here and not an error.
 */
export async function writeDocumentArtifacts(
  dir: string,
  outName: string,
  doc: DocDocument,
  templatePath: string | null,
  generatedAt: Date
): Promise<WrittenDocument> {
  const outRoot = path.join(dir, outName);
  await mkdir(outRoot, { recursive: true });

  const stem = `${slug(doc.title)}-documentation`;
  const files: string[] = [];

  await writeFile(path.join(outRoot, `${stem}.md`), renderMarkdown(doc), "utf8");
  files.push(`${stem}.md`);

  if (templatePath) {
    const template = await readFile(templatePath);
    const docx = buildDocx(new Uint8Array(template), doc, generatedAt);
    await writeFile(path.join(outRoot, `${stem}.docx`), docx);
    files.push(`${stem}.docx`);
  }

  return { dir: outRoot, files, templateMissing: templatePath === null };
}
