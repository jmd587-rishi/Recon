import { strToU8, zipSync } from "fflate";
import type { LocalReconciliationSuite, ReconHopScripts } from "../types";

/**
 * Packs the generated reconciliation SQL into one zip — a folder per pipeline hop
 * (`raw_to_stage/`, `stage_to_transformation/`, …), each holding that hop's whole reconciliation as
 * one runnable query (`00_reconciliation.sql`) and one script per target table behind it, plus a
 * README that says what every file checks.
 *
 * Built in the browser from the suite already in memory, the same way `pipeline/corrections.ts`
 * bundles corrected notebooks. Folder and file names come from the server so the README, the zip and
 * the on-screen list cannot disagree about them.
 */

function hopHeading(hop: ReconHopScripts): string {
  return hop.fromLayer && hop.toLayer ? `${hop.fromLayer.label} → ${hop.toLayer.label}` : "Whole project";
}

function buildReadme(suite: LocalReconciliationSuite): string {
  const lines: string[] = [
    `# Reconciliation scripts — ${suite.folderName}`,
    "",
    `Generated ${new Date().toISOString().slice(0, 10)} by Recon, from the SQL in \`${suite.folderName}\`.`,
    "",
    "One folder per pipeline hop. In each: `00_reconciliation.sql` is the hop's whole reconciliation as",
    "a single query — row counts, measure totals, keys that went missing, keys with no source,",
    "duplicate keys, null keys, for every table the hop builds — returning one row per check with a",
    "`status` of PASS, REVIEW or FAIL. Run that one file. The per-table scripts beside it are the same",
    "checks written out a table at a time, for when a number needs chasing down.",
    "",
    suite.generatedBy === "ai"
      ? "The checks were written by Recon's reviewer model, which was given the transformation SQL and the"
      : "The checks are Recon's standard schema-derived ones — no model was involved in writing them.",
    suite.generatedBy === "ai"
      ? "exact column list of every table involved, extracted from your SQL beforehand: column lists come"
      : "Column lists come",
    "from `CREATE TABLE` DDL where the project has it and from the select list that builds the table",
    "where it doesn't. Nothing was measured — no database was queried to produce these — and a key",
    "marked *inferred* is a guess from column naming that the duplicate-key check in the same script",
    "will confirm or disprove. Read a check before you run it.",
    "",
    "The SQL is portable (no `TOP`/`LIMIT`), so it runs on SQL Server and Databricks SQL alike.",
    ""
  ];

  if (suite.notice) lines.push(`> ${suite.notice}`, "");

  for (const hop of suite.hops) {
    lines.push("---", "", `## ${hopHeading(hop)}`, "");
    if (hop.scripts.length === 0) {
      for (const note of hop.notes) lines.push(note, "");
      continue;
    }

    lines.push(`Folder: \`${hop.folder}/\``, "");
    lines.push(
      "| File | Target table | Sources | Key | Measures totalled | Labels compared | Checks |",
      "| --- | --- | --- | --- | --- | --- | --- |"
    );
    for (const script of hop.scripts) {
      lines.push(
        `| \`${script.filename}\` | \`${script.targetTable}\` | ${script.sourceTables.length} | ` +
          `${script.keyColumns.join(", ") || "—"}${script.keyConfidence === "inferred" ? " *(inferred)*" : ""} | ` +
          `${script.measureColumns.join(", ") || "—"} | ${script.categoryColumns.join(", ") || "—"} | ` +
          `${script.checks.length} |`
      );
    }
    lines.push("");

    const skipped = hop.scripts.filter((s) => s.notes.length > 0);
    if (skipped.length > 0) {
      lines.push("**Worth knowing**", "");
      for (const script of skipped) {
        for (const note of script.notes) lines.push(`- \`${script.targetTable}\` — ${note}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function buildReconciliationZip(suite: LocalReconciliationSuite): Blob {
  const files: Record<string, Uint8Array> = {};

  // The whole pipeline as one query, at the root — the file to run. The per-hop folders below are
  // the same checks sliced up, for when only one hop is of interest.
  files[suite.projectBundle.filename] = strToU8(suite.projectBundle.sql);

  for (const hop of suite.hops) {
    if (hop.scripts.length === 0) continue;
    files[`${hop.folder}/${hop.bundle.filename}`] = strToU8(hop.bundle.sql);
    for (const script of hop.scripts) {
      files[`${hop.folder}/${script.filename}`] = strToU8(script.sql);
    }
  }
  files["README.md"] = strToU8(buildReadme(suite));

  // Re-wrap into a plain-ArrayBuffer view: fflate's return type is backed by `ArrayBufferLike`,
  // which `BlobPart` won't accept because it could in principle be a `SharedArrayBuffer`.
  const zipped = new Uint8Array(zipSync(files, { level: 6 }));
  return new Blob([zipped], { type: "application/zip" });
}

/** `recon-reconciliation-optum_arr_build-2026-07-29.zip` */
export function reconciliationZipFilename(folderName: string): string {
  const slug = folderName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "folder";
  return `recon-reconciliation-${slug}-${new Date().toISOString().slice(0, 10)}.zip`;
}
