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

/**
 * The role a layer plays in the pipeline, inferred client-side from the schema name. Roles are
 * architecture-neutral: "gold", "datamart" and "presentation" all infer `serve`. Optional because
 * a layer the user added by hand may not resemble any known naming convention.
 */
export type LayerRole = "ingest" | "clean" | "transform" | "serve";

export interface LayerRef {
  /** Human label for the layer — defaults to the schema's own name, e.g. "staged" or "bronze". */
  label: string;
  /**
   * The schema backing that layer, and the layer's identity for a Databricks flow, where a layer is
   * a Unity Catalog schema and can be nothing else. For a layer that came from a source folder this
   * is the folder's name — a name, not a lookup — and `tables` is what says which tables are in it.
   */
  schema: string;
  /**
   * The layer's tables, qualified and lowercased, when the layer is *not* a schema.
   *
   * A pipeline does not have to be staged by schema. A project that writes every derived table into
   * one `refined` schema and separates its stages by source folder instead (`Prep/`, `Mart/`,
   * `ARR/`) has three layers and one schema, and keying membership on the schema would collapse all
   * three into a single hop. When this is set it is the definition of the layer and the schema is
   * not consulted — see `layerHasTable` in `services/layers.ts`, which is the only place that
   * decision is made.
   */
  tables?: string[];
  /** Inferred pipeline role, used only as a hint for heuristics and prompts. */
  role?: LayerRole;
}

/**
 * Where a detected pipeline came from, so a run never presents a fallback as the real thing.
 *
 * `explicit` and `approved` only arise in the CLI, where the user can name the layers with
 * `--layers` or have approved them in an earlier run; detection itself only ever returns the first
 * three.
 */
export type LayerDetectionSource = "ai" | "keyword" | "lineage" | "explicit" | "approved";

/**
 * A detected pipeline plus everything needed to say how it was arrived at.
 *
 * The layers alone would be enough to generate from, but not enough to trust: a project whose schemas
 * are named after its business (`arr`, `prep`) is exactly the case where the keyword heuristic and
 * the model disagree, so the answer carries which one spoke, what it left out and why.
 */
/**
 * What a pipeline's layers were grouped by. `schema` is the usual answer; `folder` is for a project
 * that writes every stage into one schema and separates them by source folder instead.
 */
export type LayerGroupingKind = "schema" | "folder";

export interface LayerDetectionReport {
  /** Pipeline order, most-raw first. Empty when nothing could recognise a pipeline. */
  layers: LayerRef[];
  source: LayerDetectionSource;
  /** Whether these layers are schemas or source folders. */
  grouping: LayerGroupingKind;
  /** One line per layer on why it is that stage, keyed by the layer's label. Empty when derived. */
  reasons: Record<string, string>;
  /** Groups deliberately left out — security, config, logging — each with the reason. */
  excluded: { schema: string; reason: string }[];
  /** Groups no layer claims and no exclusion explains, so a run can say what it passed over. */
  unplaced: string[];
  /** Why the model wasn't used, when it wasn't. Null when it was. */
  notice: string | null;
  /** Set when the SQL's own dependencies run against the proposed order. */
  warning: string | null;
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

// ---- Governance: per-level code-fix suggestions ----

export type CodeFixSeverity = "info" | "warning" | "error";

/** A measured source -> target row count for one write statement in the hop. */
export interface RowCountPair {
  sourceTable: string;
  sourceRows: number | null;
  targetTable: string;
  targetRows: number | null;
  /** `targetRows - sourceRows`, or null when either count couldn't be run. */
  delta: number | null;
}

/** A WHERE predicate measured against its source table via `COUNT(*) WHERE NOT (predicate)`. */
export interface FilterDrop {
  predicateSql: string;
  sourceTable: string;
  excludedRows: number | null;
}

/** Everything measured about one notebook cell, attached to the fix that touches that cell. */
export interface CellEvidence {
  notebookPath: string;
  cellIndex: number;
  rowCounts: RowCountPair[];
  filters: FilterDrop[];
}

/** Hop-wide measurements gathered before the LLM call — null when no warehouse was supplied. */
export interface HopEvidence {
  cells: CellEvidence[];
  /** Same-named tables on both sides of the hop whose counts differ. */
  mismatches: StageMismatch[];
  /** True when the per-review statement budget was hit and some cells went unmeasured. */
  truncated: boolean;
}

export type FixVerificationStatus = "verified" | "unverified" | "failed";

export interface FixVerification {
  status: FixVerificationStatus;
  /** Why the check landed where it did — shown verbatim in the UI. */
  reason: string;
  originalRows: number | null;
  correctedRows: number | null;
  /** `correctedRows - originalRows`, or null when either count didn't run. */
  delta: number | null;
}

export interface CodeFix {
  notebookPath: string;
  cellIndex: number;
  title: string;
  severity: CodeFixSeverity;
  /** Why this change prevents a reconciliation error (dropped/duplicated rows, wrong join, etc.). */
  rationale: string;
  /** The cell's code as-is (what was sent to the model). */
  originalCode: string;
  /** Copy-paste-ready corrected version of the cell. */
  correctedCode: string;
  /** Counts measured for this cell before the fix was requested; null without a warehouse. */
  evidence: CellEvidence | null;
  /** Result of re-checking the corrected code; null without a warehouse. */
  verification: FixVerification | null;
}

export interface NotebookCorrection {
  notebookPath: string;
  /** Suggested download filename, e.g. `load_fact_sales.corrected.py`. */
  filename: string;
  language: NotebookMeta["language"];
  /** The full notebook rebuilt in Databricks source format with the fixes applied — downloadable. */
  correctedSource: string;
  changedCells: number;
}

export interface LevelFixReport {
  fromLayer: LayerRef;
  toLayer: LayerRef;
  status: "ok" | "warning" | "error";
  summary: string;
  /** Notebooks found to write the target layer for this hop. */
  analyzedNotebooks: string[];
  fixes: CodeFix[];
  corrections: NotebookCorrection[];
  /** Counts measured across the hop, or null when no warehouse was supplied. */
  evidence: HopEvidence | null;
}

export interface LevelFixRequest {
  catalog: string;
  notebookRoot: string;
  fromLayer: LayerRef;
  toLayer: LayerRef;
  /** Optional — without it the review is code-only and skips evidence + verification. */
  warehouseId?: string;
}

// ---- Local SQL folder analysis (no Databricks connection required) ----

/** One SQL file located inside an uploaded folder, sent as plain text. */
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
  /** Tables the file writes / reads, exactly as the SQL names them (lowercased). */
  writes: string[];
  reads: string[];
}

export interface LocalTableRef {
  /** The table as written in the SQL, lowercased — `silver.orders`, or `orders` when unqualified. */
  qualified: string;
  /** Schema segment of `qualified`, or null when the SQL never qualifies the table. */
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
  /** Every schema qualifier seen in the SQL — the client turns these into pipeline layers. */
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
  /** Files that contributed at least one statement to the review. */
  analyzedFiles: string[];
  /** `notebookPath` is the file's relative path and `cellIndex` its statement ordinal in that file. */
  fixes: CodeFix[];
  /** Whole SQL files rebuilt with the corrected statements spliced back in. */
  corrections: NotebookCorrection[];
  /** True when the statement budget capped how much of the folder was reviewed. */
  truncated: boolean;
}

// ---- Reconciliation scripts generated from an uploaded SQL folder ----

export type ReconCheckKind =
  | "row_count"
  | "measure_totals"
  /** The value sets of a label column compared, which is what a label gets instead of a total. */
  | "category_values"
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
  /** What running it tells you — written into the script as the comment above the query. */
  description: string;
  sql: string;
  source: ReconCheckSource;
}

/** Whether the key the join checks use was declared by DDL, guessed from names, or not found. */
export type ReconKeyConfidence = "declared" | "inferred" | "none";

/** Where a table's column list came from, so the UI can say how solid the script's ground is. */
export interface ReconColumnSource {
  table: string;
  /** `ddl`, `select`, `insert`, `unknown` — with ` (partial)` when a `SELECT *` wasn't expandable. */
  origin: string;
  columnCount: number;
}

/** The reconciliation script for one target table and the sources feeding it across a hop. */
export interface ReconScript {
  targetTable: string;
  sourceTables: string[];
  /** Filename inside the hop's folder, e.g. `03_fact_arr.sql`. */
  filename: string;
  /** The model's one-line read of what this hop does and what the checks prove; "" without one. */
  summary: string;
  keyColumns: string[];
  keyConfidence: ReconKeyConfidence;
  /** How those key columns were chosen, quoted in the script header. */
  keyReason: string;
  /** Columns totalled on both sides. */
  measureColumns: string[];
  /** Label columns compared as sets of values instead — a status or a period has no meaningful sum. */
  categoryColumns: string[];
  /** WHERE predicates the building statements apply — the expected, explainable row loss. */
  knownFilters: string[];
  builtBy: { path: string; statementIndex: number }[];
  columnSources: ReconColumnSource[];
  checks: ReconCheck[];
  /** Checks that were skipped, and why — the script says the same thing in its header. */
  notes: string[];
  /** The whole script, header comment included. This is what lands in the zip. */
  sql: string;
}

export interface ReconHopScripts {
  /** Both null when the folder had no inferable layers and everything was written as one scope. */
  fromLayer: LayerRef | null;
  toLayer: LayerRef | null;
  /** Folder this hop occupies in the zip, e.g. `raw_to_stage`. */
  folder: string;
  scripts: ReconScript[];
  /**
   * The whole hop as one runnable query: every check above folded into a single
   * `WITH … SELECT … UNION ALL …` that returns one status row per check. This is the file to run;
   * `scripts` is the per-table detail behind it.
   */
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
  /**
   * Every hop's checks folded into one query, told apart by its `scope` column. This is the file to
   * run — `hops[].bundle` is the same thing sliced per hop, for when only one is of interest.
   */
  projectBundle: { filename: string; sql: string };
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

// ---- Interactive lineage verification (`reconcile run`) ----
//
// These types are CLI-only — no `client/src/types.ts` counterpart, because nothing in the browser
// app reaches this flow. The hand-sync rule in CLAUDE.md applies to shapes that cross the API.

/**
 * One correction to the extracted lineage, expressed against the *facts* rather than the graph.
 *
 * The diagram the user reviews is built from `LineageEdge`s, but `gatherReconciliationFacts` groups
 * over `LineageFact`s, so an approval that only touched the graph would be cosmetic — the generated
 * SQL would ignore it. `(notebookPath, cellIndex)` is the join between the two, which is why a
 * `remove` carries the provenance of the edge it came from.
 */
export interface LineageOverride {
  kind: "remove" | "add";
  /** Source table of the edge, exactly as the SQL names it (lowercased, possibly unqualified). */
  from: string;
  /** Target table of the edge. */
  to: string;
  /** Statement the edge came from. Absent on an `add` the user invented rather than corrected. */
  notebookPath?: string;
  cellIndex?: number;
  /** Why, in the user's or the model's words — replayed in the artifacts so a re-run is auditable. */
  reason: string;
}

/** Per-edge commentary from the reviewer model, keyed by `"<from>-><to>"`. */
export type LineageEdgeNotes = Record<string, string>;

export interface LineageReview {
  /** 2-4 sentences describing the pipeline as extracted — empty when the model wasn't reachable. */
  narrative: string;
  notes: LineageEdgeNotes;
  /** Things worth a second look: suspicious fan-out, orphan tables, a layer skipped entirely. */
  concerns: string[];
  /**
   * Corrections the model proposes. On the first pass these come from reading the SQL; on later
   * passes they are the user's free-text instruction turned into structured edits. Always validated
   * against the project's own tables before being applied — an invented table is dropped.
   */
  proposed: LineageOverride[];
}

/** One round of the verify loop, retained so `lineage-feedback.json` can show how we got here. */
export interface LineageFeedbackRound {
  round: number;
  /** What the user typed when they rejected the lineage. */
  instruction: string;
  /** Overrides derived from that instruction and actually applied. */
  applied: LineageOverride[];
  /** Overrides the model proposed but which were rejected as naming unknown tables. */
  discarded: LineageOverride[];
}

// ---- Generated documentation (`reconcile document`) ----
//
// CLI-only, like the lineage types above: nothing in the browser app reaches this flow.

/**
 * The written half of the generated document — what the SQL cannot state for itself.
 *
 * Everything else in the document is derived from the project (layers, tables, lineage, checks), so
 * this is deliberately narrow: prose the reader needs, keyed so it can be dropped in beside the facts
 * it describes. An empty value means the reviewer model wasn't reachable, and the document says so
 * rather than going without a section.
 */
export interface ProjectDocumentationProse {
  /** What this project is and what it produces, a paragraph per entry. */
  introduction: string[];
  /** How the pipeline is laid out, in terms of its own layers. */
  architecture: string[];
  /** Keyed by the layer's label, exactly as it was given to the model. */
  layers: {
    layer: string;
    purpose: string;
    contents: string;
    /**
     * What each table in the layer is *for*, keyed by the table name as it was given.
     *
     * The one thing a reader wants from a table list that no parse can supply: `trn_revenue` holding
     * columns `date_key, customer_key, revenue` is a fact; that it is the monthly revenue line every
     * downstream report is built from is a reading. Names not in the layer are dropped on the way in,
     * so a table the model invents cannot appear in the document.
     */
    tables: { name: string; use: string }[];
  }[];
  /** How data moves table to table. */
  lineage: string[];
  /** Things a reader should be sceptical about, in the pipeline or in this document. */
  risks: string[];
}

/** One hop's business context: what the transformation means, and what it may legitimately change. */
export interface HopBusinessContext {
  /** What this stage of the pipeline does, in business terms, a paragraph per entry. */
  context: string[];
  /** A rule the code implements, paired with the SQL that shows it. */
  rules: { rule: string; evidence: string }[];
  /** Why the source and target row counts can differ without anything being wrong. */
  expectedDifferences: string[];
  /** Where this hop could go wrong unnoticed. */
  watchOuts: string[];
}

/** What `lineage/lineage.json` holds after the user approves. */
export interface LineageArtifacts {
  generatedAt: string;
  projectName: string;
  approved: boolean;
  layers: LayerRef[];
  edges: LineageEdge[];
  tables: LocalTableRef[];
  narrative: string;
  concerns: string[];
  notes: LineageEdgeNotes;
  feedback: LineageFeedbackRound[];
  stats: {
    fileCount: number;
    statementCount: number;
    tableCount: number;
    edgeCount: number;
    layerCount: number;
  };
}
