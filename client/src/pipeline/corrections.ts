import { strToU8, zipSync } from "fflate";
import type { CodeFix, FixVerification, HopEvidence, LayerRef, NotebookCorrection } from "../types";

/**
 * What the bundler needs from a review, structurally — satisfied by both `LevelFixReport` (the
 * Databricks governance gate) and `LocalFixReport` (the uploaded SQL folder review), which differ in
 * everything else.
 */
export interface CorrectableReport {
  status: string;
  summary: string;
  fixes: CodeFix[];
  corrections: NotebookCorrection[];
  /** Absent on local reviews, which never have a warehouse to measure against. */
  evidence?: HopEvidence | null;
}

/**
 * One reviewed scope, with the report it produced. `from`/`to` are null when the review covered a
 * whole project in one pass rather than a single hop.
 */
export interface HopCorrections {
  from: LayerRef | null;
  to: LayerRef | null;
  report: CorrectableReport;
}

/** A hop the user hasn't reviewed yet — recorded in the README so the bundle is honest about gaps. */
export interface PendingHop {
  from: LayerRef | null;
  to: LayerRef | null;
}

/** Lowercases and collapses anything that isn't alphanumeric, so labels are safe as path segments. */
function slug(label: string): string {
  const cleaned = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "layer";
}

/** `bronze` -> `silver` becomes `bronze_to_silver`, the folder that hop's files land in. */
export function hopFolderName(from: LayerRef | null, to: LayerRef | null): string {
  if (!from || !to) return "all_files";
  return `${slug(from.label)}_to_${slug(to.label)}`;
}

/**
 * Reserves `name` within `taken`, appending `_2`, `_3`, ... before the extension until it's free.
 *
 * Two notebooks at different workspace paths can share a basename (`/etl/a/load_orders` and
 * `/etl/b/load_orders`), and the server names corrections from the basename alone — so without this
 * the second would silently overwrite the first inside the zip.
 */
function reserve(taken: Set<string>, name: string): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.indexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  for (let n = 2; ; n++) {
    const candidate = `${stem}_${n}${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** A hop resolved to the exact folder and filenames it occupies in the zip. */
interface PlannedHop {
  from: LayerRef | null;
  to: LayerRef | null;
  report: CorrectableReport;
  /** Null when the hop was reviewed but produced no corrected files — no folder is created. */
  folder: string | null;
  files: { path: string; correction: NotebookCorrection }[];
}

/** Resolves folder and file names up front so the zip and the README can't disagree about them. */
function planHops(hops: HopCorrections[]): PlannedHop[] {
  const folders = new Set<string>();

  return hops.map((hop) => {
    if (hop.report.corrections.length === 0) {
      return { ...hop, folder: null, files: [] };
    }
    const folder = reserve(folders, hopFolderName(hop.from, hop.to));
    const names = new Set<string>();
    const files = hop.report.corrections.map((correction) => ({
      path: `${folder}/${reserve(names, correction.filename)}`,
      correction
    }));
    return { ...hop, folder, files };
  });
}

/** Collapses newlines and pipes so a rationale can't break the markdown it's embedded in. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function verificationNote(verification: FixVerification | null): string {
  if (!verification) return "";
  const delta =
    verification.delta === null ? "" : `, ${verification.delta > 0 ? "+" : ""}${verification.delta} rows`;
  return `, ${verification.status}${delta}`;
}

function hopHeading(hop: PlannedHop | PendingHop): string {
  return hop.from && hop.to ? `${hop.from.label} → ${hop.to.label}` : "Whole project";
}

function buildReadme(params: {
  projectName: string;
  sourceLabel: string;
  planned: PlannedHop[];
  pending: PendingHop[];
}): string {
  const { projectName, sourceLabel, planned, pending } = params;
  const lines: string[] = [
    `# Corrected files — ${projectName}`,
    "",
    `Generated ${new Date().toISOString().slice(0, 10)} by Recon, from the code under \`${sourceLabel}\`.`,
    "",
    "Each folder holds one pipeline hop's files with the suggested fixes already applied — the",
    "whole file, not just the changed statements. These are suggestions: review every change before",
    "committing it.",
    ""
  ];

  for (const hop of planned) {
    lines.push("---", "", `## ${hopHeading(hop)}`, "");

    if (!hop.folder) {
      lines.push(`Reviewed — status **${hop.report.status}**. No changes were suggested for this hop.`, "");
      if (hop.report.summary) lines.push(oneLine(hop.report.summary), "");
      continue;
    }

    lines.push(`Folder: \`${hop.folder}/\` · status **${hop.report.status}**`, "");
    if (hop.report.summary) lines.push(oneLine(hop.report.summary), "");
    lines.push("| File | Source | Sections changed |", "| --- | --- | --- |");
    for (const file of hop.files) {
      const name = file.path.slice(hop.folder.length + 1);
      lines.push(`| \`${name}\` | \`${file.correction.notebookPath}\` | ${file.correction.changedCells} |`);
    }
    lines.push("");

    if (hop.report.fixes.length > 0) {
      lines.push("**Fixes applied**", "");
      for (const fix of hop.report.fixes) {
        lines.push(
          `- **${oneLine(fix.title)}** — \`${fix.notebookPath}\` #${fix.cellIndex} ` +
            `(${fix.severity}${verificationNote(fix.verification)})`
        );
        if (fix.rationale) lines.push(`  ${oneLine(fix.rationale)}`);
      }
      lines.push("");
    }

    if (!hop.report.evidence) {
      lines.push(
        "> Row counts were unavailable here — no SQL warehouse was queried, so these fixes come from",
        "> reading the code alone and were not re-checked against the data.",
        ""
      );
    }
  }

  if (pending.length > 0) {
    lines.push(
      "---",
      "",
      "## Not included",
      "",
      "These hops had not been reviewed when this bundle was built, so nothing from them is here:",
      ""
    );
    for (const hop of pending) lines.push(`- ${hopHeading(hop)}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Packs every reviewed hop's corrected files into a zip — one folder per hop, named for the hop
 * (`bronze_to_silver/`) — alongside a README describing what changed and why.
 *
 * Built entirely in the browser from reports already in memory: re-fetching would mean paying for
 * every hop's LLM call and warehouse queries a second time.
 */
export function buildCorrectionsZip(params: {
  /** Names the bundle — the catalog for a Databricks review, the folder for an uploaded one. */
  projectName: string;
  /** Where the reviewed code came from, quoted in the README. */
  sourceLabel: string;
  hops: HopCorrections[];
  pending: PendingHop[];
}): Blob {
  const planned = planHops(params.hops);
  const files: Record<string, Uint8Array> = {};

  for (const hop of planned) {
    for (const file of hop.files) {
      files[file.path] = strToU8(file.correction.correctedSource);
    }
  }
  files["README.md"] = strToU8(
    buildReadme({ projectName: params.projectName, sourceLabel: params.sourceLabel, planned, pending: params.pending })
  );

  // Re-wrap into a plain-ArrayBuffer view: fflate's return type is backed by `ArrayBufferLike`,
  // which `BlobPart` won't accept because it could in principle be a `SharedArrayBuffer`.
  const zipped = new Uint8Array(zipSync(files, { level: 6 }));
  return new Blob([zipped], { type: "application/zip" });
}

/** `recon-corrections-main_catalog-2026-07-28.zip` */
export function correctionsZipFilename(projectName: string): string {
  return `recon-corrections-${slug(projectName)}-${new Date().toISOString().slice(0, 10)}.zip`;
}

/** Hands a generated file to the browser's downloader. */
export function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
