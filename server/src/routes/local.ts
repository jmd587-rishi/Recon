import { Router } from "express";
import { detectProjectLayers } from "../services/layerDetection.js";
import { detectPlatform, parsePlatform } from "../services/sqlPlatform.js";
import { type CodeFixCandidate, LlmConfigError, suggestLevelCodeFixes } from "../services/llmClient.js";
import {
  candidateKey,
  type LocalHop,
  parseLocalProject,
  rebuildCorrectedFiles,
  selectLocalCandidates
} from "../services/localProject.js";
import { buildAiReconciliationSuite } from "../services/aiReconciliation.js";
import { buildReconciliationSuite } from "../services/reconciliationScripts.js";
import { memoryStore } from "../store/memoryStore.js";
import type { CodeFix, LayerRef, LocalFixReport, LocalSqlFileInput } from "../types/index.js";

/**
 * Analysis of SQL files uploaded straight from disk. Deliberately *not* behind `requireConnection`:
 * the whole point of this flow is that it needs no Databricks workspace, no Unity Catalog and no SQL
 * warehouse — lineage and governance are derived from the SQL text alone, so every count-backed
 * feature of the connected flows (exclusion row counts, hop evidence, fix verification) is absent
 * here by construction rather than by omission.
 */
export const localRouter = Router();

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

function isLayerRef(value: unknown): value is LayerRef {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.label === "string" && v.label.trim().length > 0 &&
    typeof v.schema === "string" && v.schema.trim().length > 0
  );
}

function isFileInput(value: unknown): value is LocalSqlFileInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.path === "string" && v.path.trim().length > 0 && typeof v.content === "string";
}

localRouter.post("/scan", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const files = body.files;

  if (!Array.isArray(files) || files.length === 0 || !files.every(isFileInput)) {
    res.status(400).json({ error: "Expected body: { folderName?, files: [{ path, content }, ...] } with at least 1 file" });
    return;
  }
  if (files.length > MAX_FILES) {
    res.status(400).json({ error: `Too many files: ${files.length}. Upload at most ${MAX_FILES} SQL files.` });
    return;
  }

  const totalBytes = files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    res.status(400).json({
      error: `Uploaded SQL is too large (${Math.round(totalBytes / 1024)} KB). The limit is ${MAX_TOTAL_BYTES / 1024 / 1024} MB.`
    });
    return;
  }

  const folderName = typeof body.folderName === "string" && body.folderName.trim() ? body.folderName.trim() : "uploaded folder";
  const project = parseLocalProject(folderName, files);

  if (project.files.length === 0) {
    res.status(400).json({ error: "None of the uploaded files contained a parsable SQL statement." });
    return;
  }

  memoryStore.setLocalProject(project);
  res.json(project.scan);
});

localRouter.get("/scan", (_req, res) => {
  const project = memoryStore.getLocalProject();
  if (!project) {
    res.status(409).json({ error: "No SQL folder has been uploaded yet." });
    return;
  }
  res.json(project.scan);
});

/**
 * The pipeline layers of the uploaded folder, worked out by reading it rather than by recognising
 * its schema names — see `layerDetection.ts`.
 *
 * The client can already infer layers on its own (`wizard/layers.ts`), and still does when this
 * fails: the keyword list needs no round trip and no key. What it cannot do is read the SQL, and a
 * folder whose schemas are named after the business rather than after a medallion convention is
 * exactly the one where the names say nothing.
 *
 * Never 503s the way `/governance` does. Detection degrades internally — model, then names, then the
 * dependency graph — and `source` and `notice` say which answered, so an unconfigured deployment
 * costs the reading rather than the step.
 */
localRouter.post("/layers", async (_req, res) => {
  const project = memoryStore.getLocalProject();
  if (!project) {
    res.status(409).json({ error: "No SQL folder has been uploaded yet." });
    return;
  }

  try {
    res.json(await detectProjectLayers(project, { useAi: true }));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Layer detection failed." });
  }
});

localRouter.delete("/", (_req, res) => {
  memoryStore.setLocalProject(null);
  res.json({ cleared: true });
});

/**
 * Reconciliation scripts for the uploaded folder, written by the model from the folder's own
 * lineage, column lists, filters and transformation SQL.
 *
 * Unlike `/governance` this doesn't 503 when Azure OpenAI is unconfigured: it falls back to Recon's
 * standard schema-derived checks and says so in `generatedBy`/`notice`, because a folder analysed
 * offline should still come away with the mechanical half rather than an error page. A configured
 * endpoint that then *fails* is a different matter and still 502s.
 */
localRouter.post("/reconciliation", async (req, res) => {
  const project = memoryStore.getLocalProject();
  if (!project) {
    res.status(409).json({ error: "No SQL folder has been uploaded yet. Upload a folder before generating scripts." });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const layers = body.layers ?? [];
  if (!Array.isArray(layers) || !layers.every(isLayerRef)) {
    res.status(400).json({ error: "Expected body: { layers: [{ label, schema }, ...] } — ordered most-raw first." });
    return;
  }

  // The CLI asks which engine the scripts must run on; there is nobody to ask on a request, so the
  // caller may say and the project's own SQL decides when it doesn't. Detected beats `portable`: a
  // folder written in Snowflake gets Snowflake either way, and only an explicit choice overrides it.
  const platform =
    (typeof body.platform === "string" ? parsePlatform(body.platform) : null) ?? detectPlatform(project).platform;

  try {
    res.json(await buildAiReconciliationSuite(project, layers, platform));
  } catch (err) {
    if (err instanceof LlmConfigError) {
      res.json(
        buildReconciliationSuite(
          project,
          layers,
          "Azure OpenAI isn't configured, so these are Recon's standard schema-derived checks rather than " +
            "scripts written for this pipeline. Set AZURE_OPENAI_* in server/.env and regenerate.",
          platform
        )
      );
      return;
    }
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

localRouter.post("/governance", async (req, res) => {
  const project = memoryStore.getLocalProject();
  if (!project) {
    res.status(409).json({ error: "No SQL folder has been uploaded yet. Upload a folder before running a review." });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  // Both layers or neither: one alone can't describe a hop, and silently reviewing the whole folder
  // when the caller thought it had scoped the request would be worse than saying so.
  const hasLayer = body.fromLayer !== undefined || body.toLayer !== undefined;
  if (hasLayer && !(isLayerRef(body.fromLayer) && isLayerRef(body.toLayer))) {
    res.status(400).json({
      error: "Expected body: { fromLayer: {label, schema}, toLayer: {label, schema} } — or neither, to review every file."
    });
    return;
  }
  const hop: LocalHop | null = hasLayer
    ? { from: body.fromLayer as LayerRef, to: body.toLayer as LayerRef }
    : null;

  try {
    const { candidates, partial, truncated } = selectLocalCandidates(project, hop);

    const llmCandidates: CodeFixCandidate[] = candidates.map((c, index) => ({
      index,
      notebookPath: c.notebookPath,
      cellIndex: c.cellIndex,
      language: "sql",
      code: c.snippet,
      evidence: null,
      unit: "statement"
    }));

    const result = await suggestLevelCodeFixes(hop && { from: hop.from.label, to: hop.to.label }, llmCandidates);

    // Map each fix back onto the exact statement it came from, and collect corrected bodies per file.
    const fixes: CodeFix[] = [];
    const correctionsByFile = new Map<string, Map<number, string>>();
    for (const fix of result.fixes) {
      const candidate = candidates[fix.index];
      if (!candidate) continue;
      fixes.push({
        notebookPath: candidate.notebookPath,
        cellIndex: candidate.cellIndex,
        title: fix.title,
        severity: fix.severity,
        rationale: fix.rationale,
        originalCode: candidate.snippet,
        correctedCode: fix.correctedCode,
        evidence: null,
        verification: null
      });
      // A statement too long to send whole is still worth reviewing, but its fix can only be offered
      // as a copyable suggestion: splicing it over the full statement span would silently drop the
      // tail the model never saw, and the corrected file is promised to be otherwise untouched.
      if (partial.has(candidateKey(candidate.notebookPath, candidate.cellIndex))) continue;
      const perStatement = correctionsByFile.get(candidate.notebookPath) ?? new Map<number, string>();
      perStatement.set(candidate.cellIndex, fix.correctedCode);
      correctionsByFile.set(candidate.notebookPath, perStatement);
    }

    const report: LocalFixReport = {
      fromLayer: hop?.from ?? null,
      toLayer: hop?.to ?? null,
      status: result.status,
      summary: result.summary,
      analyzedFiles: Array.from(new Set(candidates.map((c) => c.notebookPath))),
      fixes,
      corrections: rebuildCorrectedFiles(project, correctionsByFile),
      truncated
    };
    res.json(report);
  } catch (err) {
    const status = err instanceof LlmConfigError ? 503 : 502;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
