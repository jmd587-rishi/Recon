import axios from "axios";
import type {
  Catalog,
  LevelAnalysisRequest,
  LevelAnalysisResponse,
  LevelFixReport,
  LevelFixRequest,
  LocalFixReport,
  LocalFixRequest,
  LocalReconciliationRequest,
  LocalReconciliationSuite,
  LocalScanRequest,
  LocalScanResult,
  PipelineAnalysis,
  PipelineAnalyzeRequest,
  ProjectSummary,
  ProjectSummaryRequest,
  Schema,
  Table,
  TableCountsRequest,
  Warehouse,
  WorkspaceEntry
} from "../types";

const api = axios.create({ baseURL: "/api" });

function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    return data?.error ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export class ApiError extends Error {}

async function unwrap<T>(promise: Promise<{ data: T }>): Promise<T> {
  try {
    const res = await promise;
    return res.data;
  } catch (err) {
    throw new ApiError(errorMessage(err));
  }
}

export function testConnection(host: string, token: string) {
  return unwrap<{ connected: boolean; host: string }>(api.post("/connections", { host, token }));
}

export function getConnectionStatus() {
  return unwrap<{ connected: boolean; host: string | null }>(api.get("/connections/status"));
}

export function disconnect() {
  return unwrap<{ connected: boolean }>(api.delete("/connections"));
}

export function getCatalogs() {
  return unwrap<{ catalogs: Catalog[] }>(api.get("/catalogs"));
}

export function getSchemas(catalogName: string) {
  return unwrap<{ schemas: Schema[] }>(api.get(`/catalogs/${encodeURIComponent(catalogName)}/schemas`));
}

export function getTables(catalogName: string, schemaName: string) {
  return unwrap<{ tables: Table[] }>(
    api.get(`/catalogs/${encodeURIComponent(catalogName)}/schemas/${encodeURIComponent(schemaName)}/tables`)
  );
}

export function browseWorkspace(path = "/") {
  return unwrap<{ path: string; entries: WorkspaceEntry[] }>(api.get("/notebooks/browse", { params: { path } }));
}

export function analyzeLevel(payload: LevelAnalysisRequest) {
  return unwrap<LevelAnalysisResponse>(api.post("/levels/analyze", payload));
}

export function getWarehouses() {
  return unwrap<{ warehouses: Warehouse[] }>(api.get("/pipeline/warehouses"));
}

export function getTableCounts(payload: TableCountsRequest) {
  return unwrap<{ counts: Record<string, number> }>(api.post("/pipeline/table-counts", payload));
}

export function analyzePipeline(payload: PipelineAnalyzeRequest) {
  return unwrap<PipelineAnalysis>(api.post("/pipeline/analyze", payload));
}

export function getProjectSummary(payload: ProjectSummaryRequest) {
  return unwrap<ProjectSummary>(api.post("/pipeline/summary", payload));
}

export function getLevelFixes(payload: LevelFixRequest) {
  return unwrap<LevelFixReport>(api.post("/levels/fixes", payload));
}

/** Uploads the SQL files located in a local folder and gets back lineage + discovered schemas. */
export function scanLocalFolder(payload: LocalScanRequest) {
  return unwrap<LocalScanResult>(api.post("/local/scan", payload));
}

export function getLocalGovernance(payload: LocalFixRequest) {
  return unwrap<LocalFixReport>(api.post("/local/governance", payload));
}

/** Reconciliation SQL for the uploaded folder — one script per target table, grouped by hop. */
export function getLocalReconciliation(payload: LocalReconciliationRequest) {
  return unwrap<LocalReconciliationSuite>(api.post("/local/reconciliation", payload));
}
