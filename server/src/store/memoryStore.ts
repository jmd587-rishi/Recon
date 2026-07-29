import type { LocalProject } from "../services/localProject.js";
import type {
  Catalog,
  ConnectionConfig,
  LineageTransformation,
  NotebookGroup,
  NotebookMeta,
  ReconciliationError,
  Schema,
  StageMismatch,
  Table
} from "../types/index.js";

interface State {
  connection: ConnectionConfig | null;
  catalogs: Catalog[];
  schemasByCatalog: Map<string, Schema[]>;
  tablesBySchema: Map<string, Table[]>;
  notebooks: NotebookMeta[];
  groups: NotebookGroup[];
  reconciliationResults: ReconciliationError[];
  stageMismatches: StageMismatch[];
  lineageSourceTable: string | null;
  lineageTransformations: LineageTransformation[];
  localProject: LocalProject | null;
}

const state: State = {
  connection: null,
  catalogs: [],
  schemasByCatalog: new Map(),
  tablesBySchema: new Map(),
  notebooks: [],
  groups: [],
  reconciliationResults: [],
  stageMismatches: [],
  lineageSourceTable: null,
  lineageTransformations: [],
  localProject: null
};

export function schemaKey(catalogName: string): string {
  return catalogName;
}

export function tableKey(catalogName: string, schemaName: string): string {
  return `${catalogName}.${schemaName}`;
}

export const memoryStore = {
  getConnection(): ConnectionConfig | null {
    return state.connection;
  },
  setConnection(config: ConnectionConfig | null): void {
    state.connection = config;
  },
  isConnected(): boolean {
    return state.connection !== null;
  },

  setCatalogs(catalogs: Catalog[]): void {
    state.catalogs = catalogs;
  },
  getCatalogs(): Catalog[] {
    return state.catalogs;
  },

  setSchemas(catalogName: string, schemas: Schema[]): void {
    state.schemasByCatalog.set(schemaKey(catalogName), schemas);
  },
  getSchemas(catalogName: string): Schema[] {
    return state.schemasByCatalog.get(schemaKey(catalogName)) ?? [];
  },

  setTables(catalogName: string, schemaName: string, tables: Table[]): void {
    state.tablesBySchema.set(tableKey(catalogName, schemaName), tables);
  },
  getTables(catalogName: string, schemaName: string): Table[] {
    return state.tablesBySchema.get(tableKey(catalogName, schemaName)) ?? [];
  },

  setNotebooks(notebooks: NotebookMeta[]): void {
    state.notebooks = notebooks;
  },
  getNotebooks(): NotebookMeta[] {
    return state.notebooks;
  },

  setGroups(groups: NotebookGroup[]): void {
    state.groups = groups;
  },
  getGroups(): NotebookGroup[] {
    return state.groups;
  },
  updateGroups(updater: (groups: NotebookGroup[]) => NotebookGroup[]): void {
    state.groups = updater(state.groups);
  },

  setReconciliationResults(results: ReconciliationError[]): void {
    state.reconciliationResults = results;
  },
  getReconciliationResults(): ReconciliationError[] {
    return state.reconciliationResults;
  },

  setStageMismatches(mismatches: StageMismatch[]): void {
    state.stageMismatches = mismatches;
  },
  getStageMismatches(): StageMismatch[] {
    return state.stageMismatches;
  },

  setLineageResults(sourceTable: string, transformations: LineageTransformation[]): void {
    state.lineageSourceTable = sourceTable;
    state.lineageTransformations = transformations;
  },
  getLineageResults(): { sourceTable: string | null; transformations: LineageTransformation[] } {
    return { sourceTable: state.lineageSourceTable, transformations: state.lineageTransformations };
  },

  // The uploaded SQL folder lives here so a governance review doesn't have to re-upload every file
  // per hop. Unlike everything above it is *not* tied to a Databricks connection — local analysis
  // works with no workspace at all — but `reset()` still clears it, since reset means "forget
  // everything this process knows".
  setLocalProject(project: LocalProject | null): void {
    state.localProject = project;
  },
  getLocalProject(): LocalProject | null {
    return state.localProject;
  },

  reset(): void {
    state.connection = null;
    state.catalogs = [];
    state.schemasByCatalog.clear();
    state.tablesBySchema.clear();
    state.notebooks = [];
    state.groups = [];
    state.reconciliationResults = [];
    state.stageMismatches = [];
    state.lineageSourceTable = null;
    state.lineageTransformations = [];
    state.localProject = null;
  }
};
