import { Router } from "express";
import { gatherLevelCode } from "../services/levelAnalysis.js";
import { analyzeLevelReconciliation, LlmConfigError } from "../services/llmClient.js";
import type { LayerRef, LevelAnalysisRequest, LevelAnalysisResponse, SelectedNotebook } from "../types/index.js";
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
