import type { NextFunction, Request, Response } from "express";
import type { ConnectionConfig } from "../types/index.js";
import { memoryStore } from "../store/memoryStore.js";

export interface ConnectedRequest extends Request<any, any, any, any> {
  databricksConnection: ConnectionConfig;
}

export function requireConnection(req: Request, res: Response, next: NextFunction): void {
  const connection = memoryStore.getConnection();
  if (!connection) {
    res.status(409).json({ error: "Not connected to a Databricks workspace. POST /api/connections first." });
    return;
  }
  (req as ConnectedRequest).databricksConnection = connection;
  next();
}
