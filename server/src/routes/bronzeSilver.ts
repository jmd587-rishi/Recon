import { Router } from "express";
import { findResponsibleCode } from "../services/codeResponsibility.js";
import { analyzeMismatchWithLlm, LlmConfigError } from "../services/llmClient.js";
import { compareMedallionStages } from "../services/tableComparator.js";
import { memoryStore } from "../store/memoryStore.js";
import type { MedallionStage, MismatchAnalysis } from "../types/index.js";
import { type ConnectedRequest, requireConnection } from "./requireConnection.js";

export const bronzeSilverRouter = Router();

bronzeSilverRouter.use(requireConnection);

function isValidStages(stages: unknown): stages is MedallionStage[] {
  if (!Array.isArray(stages) || stages.length < 2) return false;
  return stages.every(
    (s): s is MedallionStage =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as Record<string, unknown>).label === "string" &&
      typeof (s as Record<string, unknown>).schema === "string" &&
      (s as MedallionStage).label.length > 0 &&
      (s as MedallionStage).schema.length > 0
  );
}

bronzeSilverRouter.post("/compare", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;
  const { catalog, stages, warehouseId } = req.body ?? {};

  if (!catalog || !warehouseId || !isValidStages(stages)) {
    res.status(400).json({
      error: "Expected body: { catalog, warehouseId, stages: [{ label, schema }, ...] } with at least 2 stages"
    });
    return;
  }

  try {
    const mismatches = await compareMedallionStages(connection, warehouseId, catalog, stages);
    memoryStore.setStageMismatches(mismatches);
    res.json({ mismatches });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

bronzeSilverRouter.get("/mismatches", (_req, res) => {
  res.json({ mismatches: memoryStore.getStageMismatches() });
});

bronzeSilverRouter.post("/analyze", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;
  const { tableName, fromStage, toStage, fromCount, toCount, notebookRoot } = req.body ?? {};

  if (!tableName || !fromStage || !toStage || typeof fromCount !== "number" || typeof toCount !== "number") {
    res.status(400).json({
      error: "Expected body: { tableName, fromStage, toStage, fromCount, toCount, notebookRoot? }"
    });
    return;
  }

  const root = typeof notebookRoot === "string" && notebookRoot.length > 0 ? notebookRoot : "/";

  try {
    const candidates = await findResponsibleCode(connection, root, tableName);
    const { responsibleIndex, explanation } = await analyzeMismatchWithLlm({
      tableName,
      fromStage,
      toStage,
      fromCount,
      toCount,
      difference: toCount - fromCount,
      candidates
    });

    const analysis: MismatchAnalysis = {
      tableName,
      fromStage,
      toStage,
      fromCount,
      toCount,
      difference: toCount - fromCount,
      responsibleCode: responsibleIndex !== null ? candidates[responsibleIndex] : null,
      otherCandidates: candidates.filter((_, i) => i !== responsibleIndex),
      explanation
    };

    res.json({ analysis });
  } catch (err) {
    const status = err instanceof LlmConfigError ? 503 : 502;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
