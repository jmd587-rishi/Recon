import axios, { type AxiosInstance } from "axios";
import type { Catalog, ConnectionConfig, NotebookMeta, Schema, Table, TableColumn, Warehouse } from "../types/index.js";

export class DatabricksAuthError extends Error {}

function client(config: ConnectionConfig): AxiosInstance {
  const host = config.host.replace(/\/+$/, "");
  return axios.create({
    baseURL: host,
    headers: { Authorization: `Bearer ${config.token}` },
    timeout: 30_000
  });
}

function toApiError(err: unknown): Error {
  if (axios.isAxiosError(err)) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      return new DatabricksAuthError("Databricks rejected the token (401/403). Check the PAT and workspace URL.");
    }
    if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
      return new Error(`Could not reach Databricks host: ${err.message}`);
    }
    const detail = err.response?.data && typeof err.response.data === "object"
      ? JSON.stringify(err.response.data)
      : err.message;
    return new Error(`Databricks API error: ${detail}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export async function testConnection(config: ConnectionConfig): Promise<void> {
  try {
    await client(config).get("/api/2.1/unity-catalog/catalogs");
  } catch (err) {
    throw toApiError(err);
  }
}

export async function listCatalogs(config: ConnectionConfig): Promise<Catalog[]> {
  try {
    const res = await client(config).get("/api/2.1/unity-catalog/catalogs");
    const catalogs = (res.data.catalogs ?? []) as Array<{ name: string; comment?: string }>;
    return catalogs.map((c) => ({ name: c.name, comment: c.comment }));
  } catch (err) {
    throw toApiError(err);
  }
}

export async function listSchemas(config: ConnectionConfig, catalogName: string): Promise<Schema[]> {
  try {
    const res = await client(config).get("/api/2.1/unity-catalog/schemas", {
      params: { catalog_name: catalogName }
    });
    const schemas = (res.data.schemas ?? []) as Array<{ name: string; comment?: string }>;
    return schemas.map((s) => ({ name: s.name, catalogName, comment: s.comment }));
  } catch (err) {
    throw toApiError(err);
  }
}

interface RawColumn {
  name: string;
  type_name?: string;
  type_text?: string;
}

function mapColumns(columns?: RawColumn[]): TableColumn[] | undefined {
  if (!columns || columns.length === 0) return undefined;
  return columns.map((c) => ({ name: c.name, typeName: c.type_name ?? c.type_text ?? "" }));
}

export async function listTables(
  config: ConnectionConfig,
  catalogName: string,
  schemaName: string
): Promise<Table[]> {
  try {
    const res = await client(config).get("/api/2.1/unity-catalog/tables", {
      params: { catalog_name: catalogName, schema_name: schemaName }
    });
    const tables = (res.data.tables ?? []) as Array<{ name: string; comment?: string; columns?: RawColumn[] }>;
    return tables.map((t) => ({
      name: t.name,
      catalogName,
      schemaName,
      comment: t.comment,
      columns: mapColumns(t.columns)
    }));
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getTableColumns(
  config: ConnectionConfig,
  catalogName: string,
  schemaName: string,
  tableName: string
): Promise<TableColumn[]> {
  try {
    const res = await client(config).get(
      `/api/2.1/unity-catalog/tables/${encodeURIComponent(`${catalogName}.${schemaName}.${tableName}`)}`
    );
    return mapColumns(res.data.columns as RawColumn[] | undefined) ?? [];
  } catch (err) {
    throw toApiError(err);
  }
}

export async function listWarehouses(config: ConnectionConfig): Promise<Warehouse[]> {
  try {
    const res = await client(config).get("/api/2.0/sql/warehouses");
    const warehouses = (res.data.warehouses ?? []) as Array<{ id: string; name: string; state: string }>;
    return warehouses.map((w) => ({ id: w.id, name: w.name, state: w.state }));
  } catch (err) {
    throw toApiError(err);
  }
}

interface WorkspaceObject {
  path: string;
  object_type: "NOTEBOOK" | "DIRECTORY" | "FILE" | "REPO" | string;
  language?: "PYTHON" | "SQL" | "SCALA" | "R";
}

export async function listNotebooksRecursive(
  config: ConnectionConfig,
  rootPath = "/"
): Promise<NotebookMeta[]> {
  const c = client(config);
  const results: NotebookMeta[] = [];

  async function walk(path: string): Promise<void> {
    let objects: WorkspaceObject[];
    try {
      const res = await c.get("/api/2.0/workspace/list", { params: { path } });
      objects = (res.data.objects ?? []) as WorkspaceObject[];
    } catch (err) {
      throw toApiError(err);
    }

    for (const obj of objects) {
      if (obj.object_type === "DIRECTORY") {
        await walk(obj.path);
      } else if (obj.object_type === "NOTEBOOK") {
        results.push({
          path: obj.path,
          name: obj.path.split("/").pop() ?? obj.path,
          language: obj.language ?? "UNKNOWN"
        });
      }
    }
  }

  await walk(rootPath);
  return results;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  type: "DIRECTORY" | "NOTEBOOK";
  language?: "PYTHON" | "SQL" | "SCALA" | "R";
}

export async function listWorkspaceFolder(config: ConnectionConfig, path = "/"): Promise<WorkspaceEntry[]> {
  try {
    const res = await client(config).get("/api/2.0/workspace/list", { params: { path } });
    const objects = (res.data.objects ?? []) as WorkspaceObject[];
    return objects
      .filter((obj) => obj.object_type === "DIRECTORY" || obj.object_type === "NOTEBOOK")
      .map((obj) => ({
        path: obj.path,
        name: obj.path.split("/").pop() ?? obj.path,
        type: obj.object_type as "DIRECTORY" | "NOTEBOOK",
        language: obj.language
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "DIRECTORY" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch (err) {
    throw toApiError(err);
  }
}

interface StatementResponse {
  statement_id: string;
  status: { state: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "CLOSED"; error?: { message?: string } };
  result?: { data_array?: string[][] };
}

async function pollStatement(c: AxiosInstance, statementId: string): Promise<StatementResponse> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await c.get(`/api/2.0/sql/statements/${statementId}`);
    const body = res.data as StatementResponse;
    if (body.status.state === "SUCCEEDED" || body.status.state === "FAILED" || body.status.state === "CANCELED") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`SQL statement ${statementId} did not complete within the timeout.`);
}

/**
 * Runs an arbitrary `SELECT COUNT(*) ...` statement and returns the single scalar result.
 * `context` sets the statement's default catalog/schema, so notebook SQL that leaves tables
 * unqualified (`FROM customer`) still resolves.
 */
export async function runCountStatement(
  config: ConnectionConfig,
  warehouseId: string,
  statement: string,
  context?: { catalog?: string; schema?: string }
): Promise<number> {
  const c = client(config);

  try {
    const res = await c.post("/api/2.0/sql/statements", {
      warehouse_id: warehouseId,
      statement,
      wait_timeout: "30s",
      ...(context?.catalog ? { catalog: context.catalog } : {}),
      ...(context?.schema ? { schema: context.schema } : {})
    });
    let body = res.data as StatementResponse;
    if (body.status.state === "PENDING" || body.status.state === "RUNNING") {
      body = await pollStatement(c, body.statement_id);
    }

    if (body.status.state !== "SUCCEEDED") {
      throw new Error(body.status.error?.message ?? `SQL statement failed with state ${body.status.state}`);
    }

    const raw = body.result?.data_array?.[0]?.[0];
    const count = Number(raw);
    if (!Number.isFinite(count)) {
      throw new Error(`Unexpected COUNT(*) result for statement ${JSON.stringify(statement)}: ${JSON.stringify(raw)}`);
    }
    return count;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function runSqlCount(
  config: ConnectionConfig,
  warehouseId: string,
  catalogName: string,
  schemaName: string,
  tableName: string
): Promise<number> {
  const statement = `SELECT COUNT(*) AS cnt FROM \`${catalogName}\`.\`${schemaName}\`.\`${tableName}\``;
  return runCountStatement(config, warehouseId, statement);
}

export async function exportNotebookSource(config: ConnectionConfig, path: string): Promise<string> {
  try {
    const res = await client(config).get("/api/2.0/workspace/export", {
      params: { path, format: "SOURCE" }
    });
    const base64 = res.data.content as string;
    return Buffer.from(base64, "base64").toString("utf-8");
  } catch (err) {
    throw toApiError(err);
  }
}
