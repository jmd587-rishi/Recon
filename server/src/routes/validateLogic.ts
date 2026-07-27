import { Router } from "express";
import { findCodeForTable } from "../services/codeResponsibility.js";
import { LlmConfigError, validateBusinessLogic } from "../services/llmClient.js";
import type { LogicValidationResponse, ValidateLogicRequest } from "../types/index.js";
import { type ConnectedRequest, requireConnection } from "./requireConnection.js";

export const validateLogicRouter = Router();

validateLogicRouter.use(requireConnection);

function isValidRequest(body: unknown): body is ValidateLogicRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.catalog === "string" && b.catalog.trim().length > 0 &&
    typeof b.schema === "string" && b.schema.trim().length > 0 &&
    typeof b.table === "string" && b.table.trim().length > 0 &&
    typeof b.workspacePath === "string" && b.workspacePath.trim().length > 0 &&
    typeof b.businessLogic === "string" && b.businessLogic.trim().length > 0
  );
}

validateLogicRouter.post("/", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;

  if (!isValidRequest(req.body)) {
    res.status(400).json({
      error: "Expected body: { catalog, schema, table, workspacePath, businessLogic }"
    });
    return;
  }

  const { catalog, schema, table, workspacePath, businessLogic } = req.body;
  const tableName = `${catalog}.${schema}.${table}`;

  try {
    const candidates = await findCodeForTable(connection, workspacePath, catalog, schema, table);
    const result = await validateBusinessLogic(tableName, businessLogic, candidates);

    const response: LogicValidationResponse = {
      tableName,
      candidates,
      ...result
    };
    res.json(response);
  } catch (err) {
    const status = err instanceof LlmConfigError ? 503 : 502;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
