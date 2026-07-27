import { Router } from "express";
import { listCatalogs, listSchemas, listTables } from "../services/databricksClient.js";
import { memoryStore } from "../store/memoryStore.js";
import { type ConnectedRequest, requireConnection } from "./requireConnection.js";

export const catalogRouter = Router();

catalogRouter.use(requireConnection);

catalogRouter.get("/", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;
  try {
    const catalogs = await listCatalogs(connection);
    memoryStore.setCatalogs(catalogs);
    res.json({ catalogs });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

catalogRouter.get("/:catalog/schemas", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;
  try {
    const schemas = await listSchemas(connection, req.params.catalog);
    memoryStore.setSchemas(req.params.catalog, schemas);
    res.json({ schemas });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

catalogRouter.get("/:catalog/schemas/:schema/tables", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;
  try {
    const tables = await listTables(connection, req.params.catalog, req.params.schema);
    memoryStore.setTables(req.params.catalog, req.params.schema, tables);
    res.json({ tables });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
