import { Router } from "express";
import { DatabricksAuthError, testConnection } from "../services/databricksClient.js";
import { memoryStore } from "../store/memoryStore.js";

export const connectionsRouter = Router();

connectionsRouter.post("/", async (req, res) => {
  const { host, token } = req.body ?? {};
  if (typeof host !== "string" || !host.trim() || typeof token !== "string" || !token.trim()) {
    res.status(400).json({ error: "host and token are required" });
    return;
  }

  try {
    await testConnection({ host, token });
  } catch (err) {
    const status = err instanceof DatabricksAuthError ? 401 : 502;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  memoryStore.reset();
  memoryStore.setConnection({ host, token });
  res.json({ connected: true, host });
});

connectionsRouter.get("/status", (_req, res) => {
  const connection = memoryStore.getConnection();
  res.json({ connected: connection !== null, host: connection?.host ?? null });
});

connectionsRouter.delete("/", (_req, res) => {
  memoryStore.reset();
  res.json({ connected: false });
});
