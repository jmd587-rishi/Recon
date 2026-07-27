import { Router } from "express";
import { explainLineageWithLlm, LlmConfigError } from "../services/llmClient.js";
import { findTransformationsFromTable } from "../services/tableLineage.js";
import { memoryStore } from "../store/memoryStore.js";
import type { LineageTransformation } from "../types/index.js";
import { type ConnectedRequest, requireConnection } from "./requireConnection.js";

export const lineageRouter = Router();

lineageRouter.use(requireConnection);

lineageRouter.post("/", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;
  const { sourceTable, notebookRoot, targetSchema } = req.body ?? {};

  if (typeof sourceTable !== "string" || !sourceTable.trim()) {
    res.status(400).json({
      error: "Expected body: { sourceTable, notebookRoot?, targetSchema? }"
    });
    return;
  }

  const root = typeof notebookRoot === "string" && notebookRoot.length > 0 ? notebookRoot : "/";
  const schema = typeof targetSchema === "string" && targetSchema.trim() ? targetSchema.trim() : undefined;

  try {
    const found = await findTransformationsFromTable(connection, root, sourceTable.trim(), schema);
    const transformations: LineageTransformation[] = found.map((t) => ({ ...t, explanation: null }));
    memoryStore.setLineageResults(sourceTable.trim(), transformations);
    res.json({ sourceTable: sourceTable.trim(), transformations });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

lineageRouter.get("/results", (_req, res) => {
  res.json(memoryStore.getLineageResults());
});

function isValidTransformations(value: unknown): value is LineageTransformation[] {
  return (
    Array.isArray(value) &&
    value.every(
      (t) =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as Record<string, unknown>).targetTable === "string" &&
        typeof (t as Record<string, unknown>).snippet === "string"
    )
  );
}

lineageRouter.post("/explain", async (req, res) => {
  const { sourceTable, transformations } = req.body ?? {};

  if (typeof sourceTable !== "string" || !sourceTable.trim() || !isValidTransformations(transformations)) {
    res.status(400).json({
      error: "Expected body: { sourceTable, transformations: LineageTransformation[] }"
    });
    return;
  }

  try {
    const explanations = await explainLineageWithLlm(
      sourceTable.trim(),
      transformations.map((t) => ({
        targetTable: t.targetTable,
        sourceTables: t.sourceTables,
        notebookPath: t.notebookPath,
        cellIndex: t.cellIndex,
        snippet: t.snippet
      }))
    );
    const explanationByTarget = new Map(explanations.map((e) => [e.targetTable, e.explanation]));
    const merged: LineageTransformation[] = transformations.map((t) => ({
      ...t,
      explanation: explanationByTarget.get(t.targetTable) ?? t.explanation ?? null
    }));

    memoryStore.setLineageResults(sourceTable.trim(), merged);
    res.json({ sourceTable: sourceTable.trim(), transformations: merged });
  } catch (err) {
    const status = err instanceof LlmConfigError ? 503 : 502;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
