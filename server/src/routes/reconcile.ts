import { Router } from "express";
import { exportNotebookSource } from "../services/databricksClient.js";
import { parseNotebookSource } from "../services/notebookParser.js";
import { buildNotebookFacts, reconcileGroup } from "../services/reconciliationEngine.js";
import { memoryStore } from "../store/memoryStore.js";
import type { NotebookFacts } from "../types/index.js";
import { type ConnectedRequest, requireConnection } from "./requireConnection.js";

export const reconcileRouter = Router();

reconcileRouter.use(requireConnection);

reconcileRouter.post("/", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;
  const requestedGroupIds: string[] | undefined = Array.isArray(req.body?.groupIds)
    ? req.body.groupIds
    : undefined;

  const allGroups = memoryStore.getGroups();
  const groups = requestedGroupIds
    ? allGroups.filter((g) => requestedGroupIds.includes(g.id))
    : allGroups;

  if (groups.length === 0) {
    res.status(400).json({ error: "No matching notebook groups. Call GET /api/notebooks first." });
    return;
  }

  const notebookLanguage = new Map(memoryStore.getNotebooks().map((nb) => [nb.path, nb.language]));
  const uniquePaths = Array.from(new Set(groups.flatMap((g) => g.notebookPaths)));

  const factsByPath = new Map<string, NotebookFacts>();
  try {
    for (const path of uniquePaths) {
      const source = await exportNotebookSource(connection, path);
      const language = notebookLanguage.get(path) ?? "UNKNOWN";
      const parsed = parseNotebookSource(path, source, language);
      factsByPath.set(path, buildNotebookFacts(parsed));
    }
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const results = groups.flatMap((group) => reconcileGroup(group, factsByPath));
  memoryStore.setReconciliationResults(results);
  res.json({ results });
});

reconcileRouter.get("/results", (_req, res) => {
  res.json({ results: memoryStore.getReconciliationResults() });
});
