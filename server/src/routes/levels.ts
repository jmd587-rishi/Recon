import { Router } from "express";
import { CONCURRENCY, mapWithConcurrency } from "../services/concurrency.js";
import { evidenceForCell, gatherHopEvidence } from "../services/fixEvidence.js";
import { rankFixes, verifyFix } from "../services/fixVerification.js";
import {
  correctedFilename,
  gatherLevelTransformationCode,
  reconstructNotebookSource
} from "../services/governanceAnalysis.js";
import { gatherLevelCode } from "../services/levelAnalysis.js";
import {
  analyzeLevelReconciliation,
  type CodeFixCandidate,
  LlmConfigError,
  suggestLevelCodeFixes
} from "../services/llmClient.js";
import type {
  CellLanguage,
  CodeFix,
  HopEvidence,
  LayerRef,
  LevelAnalysisRequest,
  LevelAnalysisResponse,
  LevelFixReport,
  NotebookCorrection,
  SelectedNotebook
} from "../types/index.js";
import { type ConnectedRequest, requireConnection } from "./requireConnection.js";

export const levelsRouter = Router();

levelsRouter.use(requireConnection);

const LANGUAGES = new Set(["PYTHON", "SQL", "SCALA", "R", "UNKNOWN"]);

function isLayerRef(value: unknown): value is LayerRef {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.label === "string" && v.label.trim().length > 0 &&
    typeof v.schema === "string" && v.schema.trim().length > 0
  );
}

function isNotebook(value: unknown): value is SelectedNotebook {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.path === "string" && v.path.trim().length > 0 && typeof v.language === "string" && LANGUAGES.has(v.language);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isValidRequest(body: unknown): body is LevelAnalysisRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.catalog === "string" && b.catalog.trim().length > 0 &&
    isLayerRef(b.fromLayer) &&
    isLayerRef(b.toLayer) &&
    isStringArray(b.sourceTables) &&
    isStringArray(b.targetTables) &&
    Array.isArray(b.notebooks) && b.notebooks.length > 0 && b.notebooks.every(isNotebook) &&
    typeof b.businessContext === "string" && b.businessContext.trim().length > 0
  );
}

levelsRouter.post("/analyze", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;

  if (!isValidRequest(req.body)) {
    res.status(400).json({
      error:
        "Expected body: { catalog, fromLayer: {label, schema}, toLayer: {label, schema}, sourceTables[], targetTables[], notebooks: [{path, language}] (>=1), businessContext }"
    });
    return;
  }

  const { fromLayer, toLayer, sourceTables, targetTables, notebooks, businessContext } = req.body;

  try {
    const codeSnippets = await gatherLevelCode(connection, notebooks, [...sourceTables, ...targetTables]);
    const body = await analyzeLevelReconciliation({
      fromLayer: fromLayer.label,
      toLayer: toLayer.label,
      sourceTables,
      targetTables,
      businessContext,
      candidates: codeSnippets
    });

    const response: LevelAnalysisResponse = {
      report: { fromLayer: fromLayer.label, toLayer: toLayer.label, ...body },
      codeSnippets
    };
    res.json(response);
  } catch (err) {
    const status = err instanceof LlmConfigError ? 503 : 502;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

levelsRouter.post("/fixes", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (
    typeof body.catalog !== "string" || body.catalog.trim().length === 0 ||
    !isLayerRef(body.fromLayer) ||
    !isLayerRef(body.toLayer)
  ) {
    res.status(400).json({
      error:
        "Expected body: { catalog, notebookRoot?, warehouseId?, fromLayer: {label, schema}, toLayer: {label, schema} }"
    });
    return;
  }

  const { catalog, fromLayer, toLayer } = body as { catalog: string; fromLayer: LayerRef; toLayer: LayerRef };
  const notebookRoot = typeof body.notebookRoot === "string" && body.notebookRoot.length > 0 ? body.notebookRoot : "/";
  // Optional on purpose: without a warehouse the review stays code-only (today's behaviour) rather
  // than 400-ing, so S5 still works before a warehouse is picked.
  const warehouseId = typeof body.warehouseId === "string" && body.warehouseId.length > 0 ? body.warehouseId : null;

  try {
    const { notebooks, candidates, facts, fromTables, toTables } = await gatherLevelTransformationCode(
      connection,
      catalog,
      notebookRoot,
      fromLayer,
      toLayer
    );

    // Phase A — measure the hop before asking for fixes, so the model reasons over real counts.
    let evidence: HopEvidence | null = null;
    if (warehouseId) {
      evidence = await gatherHopEvidence({
        connection,
        warehouseId,
        catalog,
        fromLayer,
        toLayer,
        facts,
        fromTables,
        toTables
      });
    }

    const llmCandidates: CodeFixCandidate[] = candidates.map((c, index) => ({
      index,
      notebookPath: c.notebookPath,
      cellIndex: c.cellIndex,
      language: "code",
      code: c.snippet,
      evidence: evidenceForCell(evidence, c.notebookPath, c.cellIndex)
    }));

    const result = await suggestLevelCodeFixes({ from: fromLayer.label, to: toLayer.label }, llmCandidates);

    // The cell's real language, needed to pull SQL back out of a corrected cell for verification.
    const languageAt = (notebookPath: string, cellIndex: number): CellLanguage =>
      notebooks.find((n) => n.path === notebookPath)?.parsed.cells.find((c) => c.index === cellIndex)?.language ??
      "unknown";

    // Map each fix back onto the exact cell it came from, and collect corrected bodies per notebook.
    const fixes: CodeFix[] = [];
    const correctionsByNotebook = new Map<string, Map<number, string>>();
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
        evidence: evidenceForCell(evidence, candidate.notebookPath, candidate.cellIndex),
        verification: null
      });
      const perCell = correctionsByNotebook.get(candidate.notebookPath) ?? new Map<number, string>();
      perCell.set(candidate.cellIndex, fix.correctedCode);
      correctionsByNotebook.set(candidate.notebookPath, perCell);
    }

    // Phase B — re-check each suggestion. A `failed` verdict is demoted to `info` and sorted last,
    // never dropped: the rationale can be right even when the rewrite isn't runnable here.
    if (warehouseId) {
      const verified = await mapWithConcurrency(fixes, CONCURRENCY, (fix) =>
        verifyFix({
          connection,
          warehouseId,
          catalog,
          schema: fromLayer.schema,
          language: languageAt(fix.notebookPath, fix.cellIndex),
          originalCode: fix.originalCode,
          correctedCode: fix.correctedCode
        })
      );
      verified.forEach((verification, i) => {
        fixes[i].verification = verification;
        if (verification.status === "failed") fixes[i].severity = "info";
      });
    }

    const corrections: NotebookCorrection[] = notebooks
      .filter((nb) => (correctionsByNotebook.get(nb.path)?.size ?? 0) > 0)
      .map((nb) => {
        const perCell = correctionsByNotebook.get(nb.path)!;
        return {
          notebookPath: nb.path,
          filename: correctedFilename(nb.path, nb.language),
          language: nb.language,
          correctedSource: reconstructNotebookSource(nb.parsed, nb.language, perCell),
          changedCells: perCell.size
        };
      });

    const report: LevelFixReport = {
      fromLayer,
      toLayer,
      status: result.status,
      summary: result.summary,
      analyzedNotebooks: notebooks.map((n) => n.path),
      fixes: rankFixes(fixes),
      corrections,
      evidence
    };
    res.json(report);
  } catch (err) {
    const status = err instanceof LlmConfigError ? 503 : 502;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
