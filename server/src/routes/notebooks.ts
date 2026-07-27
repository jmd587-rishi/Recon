import { Router } from "express";
import { listNotebooksRecursive, listWorkspaceFolder } from "../services/databricksClient.js";
import { groupNotebooksByNamingPattern } from "../services/notebookGrouping.js";
import { memoryStore } from "../store/memoryStore.js";
import type { NotebookGroup } from "../types/index.js";
import { type ConnectedRequest, requireConnection } from "./requireConnection.js";

export const notebooksRouter = Router();

notebooksRouter.use(requireConnection);

notebooksRouter.get("/browse", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;
  const path = typeof req.query.path === "string" && req.query.path.length > 0 ? req.query.path : "/";

  try {
    const entries = await listWorkspaceFolder(connection, path);
    res.json({ path, entries });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

notebooksRouter.get("/", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;
  const root = typeof req.query.root === "string" ? req.query.root : "/";

  try {
    const notebooks = await listNotebooksRecursive(connection, root);
    const groups = groupNotebooksByNamingPattern(notebooks);
    memoryStore.setNotebooks(notebooks);
    memoryStore.setGroups(groups);
    res.json({ notebooks, groups });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

notebooksRouter.get("/groups", (_req, res) => {
  res.json({ groups: memoryStore.getGroups() });
});

notebooksRouter.put("/groups", (req, res) => {
  const groups = req.body?.groups;
  if (!Array.isArray(groups)) {
    res.status(400).json({ error: "Expected body: { groups: NotebookGroup[] }" });
    return;
  }
  memoryStore.setGroups(groups as NotebookGroup[]);
  res.json({ groups: memoryStore.getGroups() });
});
