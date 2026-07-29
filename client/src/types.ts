export interface Catalog {
  name: string;
  comment?: string;
}

export interface Schema {
  name: string;
  catalogName: string;
  comment?: string;
}

export interface TableColumn {
  name: string;
  typeName: string;
}

export interface Table {
  name: string;
  catalogName: string;
  schemaName: string;
  comment?: string;
  columns?: TableColumn[];
}

export interface Warehouse {
  id: string;
  name: string;
  state: string;
}

export interface NotebookMeta {
  path: string;
  name: string;
  language: "PYTHON" | "SQL" | "SCALA" | "R" | "UNKNOWN";
}

export interface NotebookGroup {
  id: string;
  baseKey: string;
  notebookPaths: string[];
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  type: "DIRECTORY" | "NOTEBOOK";
  language?: "PYTHON" | "SQL" | "SCALA" | "R";
}

export type ReconciliationErrorType = "sql-logic-mismatch" | "code-def-mismatch";

export interface ReconciliationErrorSide {
  notebookPath: string;
  cellIndex: number;
  snippet: string;
}

export interface ReconciliationError {
  id: string;
  groupId: string;
  type: ReconciliationErrorType;
  key: string;
  description: string;
  left: ReconciliationErrorSide;
  right: ReconciliationErrorSide;
}

export interface MedallionStage {
  label: string;
  schema: string;
}

export interface StageMismatch {
  tableName: string;
  fromStage: string;
  toStage: string;
  fromCount: number;
  toCount: number;
  difference: number;
}

export interface CodeCandidate {
  notebookPath: string;
  cellIndex: number;
  snippet: string;
}

export interface MismatchAnalysis {
  tableName: string;
  fromStage: string;
  toStage: string;
  fromCount: number;
  toCount: number;
  difference: number;
  responsibleCode: CodeCandidate | null;
  otherCandidates: CodeCandidate[];
  explanation: string;
}

export interface LineageTransformation {
  targetTable: string;
  notebookPath: string;
  cellIndex: number;
  sourceTables: string[];
  snippet: string;
  explanation: string | null;
}

export interface ValidateLogicRequest {
  catalog: string;
  schema: string;
  table: string;
  workspacePath: string;
  businessLogic: string;
}

export interface LogicValidationResult {
  isCorrect: boolean;
  alerts: string[];
  explanation: string;
}

export interface LogicValidationResponse extends LogicValidationResult {
  tableName: string;
  candidates: CodeCandidate[];
}

// ---- Guided level-by-level reconciliation wizard ----

export type LayerRole = "ingest" | "clean" | "transform" | "serve";

export interface LayerRef {
  label: string;
  schema: string;
  role?: LayerRole;
}

export interface SelectedNotebook {
  path: string;
  language: NotebookMeta["language"];
}

export type LevelSeverity = "info" | "warning" | "error";

export interface LevelFinding {
  severity: LevelSeverity;
  table?: string;
  message: string;
}

export interface LevelReport {
  fromLayer: string;
  toLayer: string;
  status: "ok" | "warning" | "error";
  summary: string;
  reconciliationAlerts: string[];
  findings: LevelFinding[];
}

export interface LevelAnalysisRequest {
  catalog: string;
  fromLayer: LayerRef;
  toLayer: LayerRef;
  sourceTables: string[];
  targetTables: string[];
  notebooks: SelectedNotebook[];
  businessContext: string;
}

export interface LevelAnalysisResponse {
  report: LevelReport;
  codeSnippets: CodeCandidate[];
}

// ---- Problem 1: Raw to Data Mart pipeline dashboard ----

export type ExclusionSeverity = "ok" | "warning";

export interface ExclusionRule {
  notebookPath: string;
  cellIndex: number;
  predicateSql: string | null;
  sourceTable: string;
  excludedCount: number | null;
  label: string;
  explanation: string;
  severity: ExclusionSeverity;
}

export interface LayerExclusionResult {
  layer: LayerRef;
  totalRows: number | null;
  rules: ExclusionRule[];
}

export interface LineageEdge {
  from: string;
  to: string;
  joinKeyHint: string | null;
  notebookPath: string;
  cellIndex: number;
}

export interface PipelineAnalysis {
  exclusions: LayerExclusionResult[];
  lineage: LineageEdge[];
}

export interface PipelineAnalyzeRequest {
  catalog: string;
  warehouseId: string;
  notebookRoot: string;
  layers: LayerRef[];
}

export interface TableCountsRequest {
  catalog: string;
  warehouseId: string;
  tables: { schema: string; name: string }[];
}

// ---- Project summary (onboarding overview) ----

export type TableKind = "fact" | "dimension" | "bridge" | "staging" | "other";

export interface ProjectTableInfo {
  schema: string;
  name: string;
  kind: TableKind;
  rowCount: number | null;
  columnCount: number | null;
  comment: string | null;
}

export interface ProjectLayerSummary {
  layer: LayerRef;
  tables: ProjectTableInfo[];
  totalRows: number | null;
}

export interface ProjectStats {
  layerCount: number;
  tableCount: number;
  factTableCount: number;
  dimensionTableCount: number;
  otherTableCount: number;
  totalRows: number | null;
  lineageEdgeCount: number;
  notebookCount: number;
}

export interface ProjectNarrative {
  overview: string;
  architecture: string;
  howItWorks: string;
  onboardingTips: string[];
}

export interface ProjectSummary {
  catalog: string;
  warehouseId: string;
  notebookRoot: string;
  layers: ProjectLayerSummary[];
  stats: ProjectStats;
  lineage: LineageEdge[];
  narrative: ProjectNarrative | null;
}

export interface ProjectSummaryRequest {
  catalog: string;
  warehouseId: string;
  notebookRoot: string;
  layers: LayerRef[];
}

// ---- Governance: per-level code-fix suggestions ----

export type CodeFixSeverity = "info" | "warning" | "error";

export interface RowCountPair {
  sourceTable: string;
  sourceRows: number | null;
  targetTable: string;
  targetRows: number | null;
  delta: number | null;
}

export interface FilterDrop {
  predicateSql: string;
  sourceTable: string;
  excludedRows: number | null;
}

export interface CellEvidence {
  notebookPath: string;
  cellIndex: number;
  rowCounts: RowCountPair[];
  filters: FilterDrop[];
}

export interface HopEvidence {
  cells: CellEvidence[];
  mismatches: StageMismatch[];
  truncated: boolean;
}

export type FixVerificationStatus = "verified" | "unverified" | "failed";

export interface FixVerification {
  status: FixVerificationStatus;
  reason: string;
  originalRows: number | null;
  correctedRows: number | null;
  delta: number | null;
}

export interface CodeFix {
  notebookPath: string;
  cellIndex: number;
  title: string;
  severity: CodeFixSeverity;
  rationale: string;
  originalCode: string;
  correctedCode: string;
  evidence: CellEvidence | null;
  verification: FixVerification | null;
}

export interface NotebookCorrection {
  notebookPath: string;
  filename: string;
  language: NotebookMeta["language"];
  correctedSource: string;
  changedCells: number;
}

export interface LevelFixReport {
  fromLayer: LayerRef;
  toLayer: LayerRef;
  status: "ok" | "warning" | "error";
  summary: string;
  analyzedNotebooks: string[];
  fixes: CodeFix[];
  corrections: NotebookCorrection[];
  evidence: HopEvidence | null;
}

export interface LevelFixRequest {
  catalog: string;
  notebookRoot: string;
  fromLayer: LayerRef;
  toLayer: LayerRef;
  warehouseId?: string;
}

// ---- Local SQL folder analysis (no Databricks connection required) ----

export interface LocalSqlFileInput {
  /** Path relative to the uploaded folder, e.g. `etl/silver/load_orders.sql`. */
  path: string;
  content: string;
}

export interface LocalSkippedFile {
  path: string;
  reason: string;
}

export interface LocalFileSummary {
  path: string;
  statementCount: number;
  bytes: number;
  writes: string[];
  reads: string[];
}

export interface LocalTableRef {
  qualified: string;
  schema: string | null;
  name: string;
  written: boolean;
  read: boolean;
}

export interface LocalProjectStats {
  fileCount: number;
  statementCount: number;
  tableCount: number;
  schemaCount: number;
  lineageEdgeCount: number;
}

export interface LocalScanResult {
  folderName: string;
  files: LocalFileSummary[];
  skipped: LocalSkippedFile[];
  tables: LocalTableRef[];
  /** Every schema qualifier seen in the SQL — turned into pipeline layers by `detectLayers`. */
  schemas: string[];
  lineage: LineageEdge[];
  stats: LocalProjectStats;
}

export interface LocalScanRequest {
  folderName?: string;
  files: LocalSqlFileInput[];
}

/** Omit both layers to review every located statement as a single scope. */
export interface LocalFixRequest {
  fromLayer?: LayerRef;
  toLayer?: LayerRef;
}

export interface LocalFixReport {
  /** Null when the review covered the whole folder rather than one hop. */
  fromLayer: LayerRef | null;
  toLayer: LayerRef | null;
  status: "ok" | "warning" | "error";
  summary: string;
  analyzedFiles: string[];
  /** `notebookPath` is the file's relative path and `cellIndex` its statement ordinal in that file. */
  fixes: CodeFix[];
  corrections: NotebookCorrection[];
  truncated: boolean;
}

// ---- Reconciliation scripts generated from an uploaded SQL folder ----

export type ReconCheckKind =
  | "row_count"
  | "measure_totals"
  | "missing_keys"
  | "orphan_keys"
  | "duplicate_keys"
  | "null_keys"
  /** A check the model wrote for this specific transformation — grain, window, cast, date gap. */
  | "custom";

/**
 * Who wrote a check. `recon` is derived mechanically from the declared columns and cannot name a
 * column the table lacks; `ai` was written from the transformation SQL and is the half worth reading
 * before you run it. Every script carries both, so the standard checks survive an LLM failure.
 */
export type ReconCheckSource = "recon" | "ai";

/** One runnable query inside a reconciliation script. */
export interface ReconCheck {
  kind: ReconCheckKind;
  title: string;
  description: string;
  sql: string;
  source: ReconCheckSource;
}

/** Whether the key the join checks use was declared by DDL, guessed from names, or not found. */
export type ReconKeyConfidence = "declared" | "inferred" | "none";

export interface ReconColumnSource {
  table: string;
  /** `ddl`, `select`, `insert`, `unknown` — with ` (partial)` when a `SELECT *` wasn't expandable. */
  origin: string;
  columnCount: number;
}

export interface ReconScript {
  targetTable: string;
  sourceTables: string[];
  /** Filename inside the hop's folder, e.g. `03_fact_arr.sql`. */
  filename: string;
  /** The model's one-line read of what this hop does and what the checks prove; "" without one. */
  summary: string;
  keyColumns: string[];
  keyConfidence: ReconKeyConfidence;
  keyReason: string;
  measureColumns: string[];
  /** WHERE predicates the building statements apply — the expected, explainable row loss. */
  knownFilters: string[];
  builtBy: { path: string; statementIndex: number }[];
  columnSources: ReconColumnSource[];
  checks: ReconCheck[];
  notes: string[];
  /** The whole script, header comment included. This is what lands in the zip. */
  sql: string;
}

export interface ReconHopScripts {
  /** Both null when the folder had no inferable layers and everything was written as one scope. */
  fromLayer: LayerRef | null;
  toLayer: LayerRef | null;
  folder: string;
  scripts: ReconScript[];
  /** The whole hop as one query, returning one status row per check. The file to run. */
  bundle: { filename: string; sql: string };
  notes: string[];
}

export interface LocalReconciliationSuite {
  folderName: string;
  /** `ai` when the model wrote the checks, `rules` when Azure OpenAI wasn't configured. */
  generatedBy: "ai" | "rules";
  /** Why the result isn't wholly what was asked for — null when it is. */
  notice: string | null;
  hops: ReconHopScripts[];
  stats: {
    hopCount: number;
    scriptCount: number;
    checkCount: number;
    tablesWithColumns: number;
    tablesWithoutColumns: number;
  };
}

export interface LocalReconciliationRequest {
  /** Ordered pipeline layers, most-raw first. Fewer than 2 writes every lineage pair as one scope. */
  layers?: LayerRef[];
}
