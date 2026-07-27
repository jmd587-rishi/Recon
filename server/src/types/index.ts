export interface ConnectionConfig {
  host: string;
  token: string;
}

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

export type CellLanguage = "python" | "sql" | "scala" | "r" | "md" | "unknown";

export interface NotebookCell {
  index: number;
  language: CellLanguage;
  source: string;
}

export interface ParsedNotebook {
  path: string;
  cells: NotebookCell[];
}

export interface SqlLogicFact {
  metricName: string;
  notebookPath: string;
  cellIndex: number;
  tables: string[];
  columns: string[];
  normalizedStructure: string;
  rawSql: string;
}

export interface CodeDefFact {
  name: string;
  kind: "function" | "variable";
  notebookPath: string;
  cellIndex: number;
  normalizedBody: string;
  rawSource: string;
}

export interface NotebookFacts {
  path: string;
  sqlFacts: SqlLogicFact[];
  codeDefs: CodeDefFact[];
}

export type ReconciliationErrorType = "sql-logic-mismatch" | "code-def-mismatch";

export interface ReconciliationError {
  id: string;
  groupId: string;
  type: ReconciliationErrorType;
  key: string;
  description: string;
  left: {
    notebookPath: string;
    cellIndex: number;
    snippet: string;
  };
  right: {
    notebookPath: string;
    cellIndex: number;
    snippet: string;
  };
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

export interface LayerRef {
  /** Human label for the medallion layer, e.g. "bronze". */
  label: string;
  /** Actual Unity Catalog schema name backing that layer. */
  schema: string;
}

export interface SelectedNotebook {
  path: string;
  language: NotebookMeta["language"];
}

export type LevelSeverity = "info" | "warning" | "error";

export interface LevelFinding {
  severity: LevelSeverity;
  /** Table the finding relates to, if specific to one. */
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
  /** Qualified as `schema.table`. */
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
  /** What this data project is, in plain English. */
  overview: string;
  /** How it's set up — the medallion architecture / layering. */
  architecture: string;
  /** How the pipeline actually runs data end to end. */
  howItWorks: string;
  /** Practical pointers for an engineer joining the project. */
  onboardingTips: string[];
}

export interface ProjectSummary {
  catalog: string;
  warehouseId: string;
  notebookRoot: string;
  layers: ProjectLayerSummary[];
  stats: ProjectStats;
  lineage: LineageEdge[];
  /** Null when Azure OpenAI is not configured — the structured summary is still returned. */
  narrative: ProjectNarrative | null;
}

export interface ProjectSummaryRequest {
  catalog: string;
  warehouseId: string;
  notebookRoot: string;
  layers: LayerRef[];
}
