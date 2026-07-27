import type { CodeCandidate, ConnectionConfig, SqlLogicFact } from "../types/index.js";
import { exportNotebookSource, listNotebooksRecursive } from "./databricksClient.js";
import { parseNotebookSource } from "./notebookParser.js";
import { snippet } from "./reconciliationEngine.js";
import { extractSqlFacts } from "./sqlAnalyzer.js";
import { extractLineageFacts } from "./tableLineage.js";

function referencesTable(fact: SqlLogicFact, tableName: string): boolean {
  const needle = tableName.toLowerCase();
  return fact.tables.some((ref) => {
    const lastSegment = ref.split(".").pop() ?? ref;
    return lastSegment === needle;
  });
}

/**
 * Scans notebooks under `notebookRoot` for SQL statements (including spark.sql calls)
 * that reference `tableName`, without paying the AST-parse cost for notebooks that
 * never mention the table.
 */
export async function findResponsibleCode(
  connection: ConnectionConfig,
  notebookRoot: string,
  tableName: string
): Promise<CodeCandidate[]> {
  const notebooks = await listNotebooksRecursive(connection, notebookRoot);
  const needle = tableName.toLowerCase();
  const candidates: CodeCandidate[] = [];

  for (const notebook of notebooks) {
    let source: string;
    try {
      source = await exportNotebookSource(connection, notebook.path);
    } catch {
      continue;
    }
    if (!source.toLowerCase().includes(needle)) continue;

    const parsed = parseNotebookSource(notebook.path, source, notebook.language);
    const facts = extractSqlFacts(parsed);
    for (const fact of facts) {
      if (!referencesTable(fact, needle)) continue;
      candidates.push({
        notebookPath: fact.notebookPath,
        cellIndex: fact.cellIndex,
        snippet: snippet(fact.rawSql)
      });
    }
  }

  return candidates;
}

function matchesFullTableName(targetTable: string, catalog: string, schemaName: string, tableName: string): boolean {
  const t = targetTable.toLowerCase();
  const table = tableName.toLowerCase();
  const schemaTable = `${schemaName}.${tableName}`.toLowerCase();
  const fullTable = `${catalog}.${schemaName}.${tableName}`.toLowerCase();
  return t === table || t === schemaTable || t === fullTable || t.endsWith(`.${schemaTable}`);
}

/**
 * Locates the notebook cell(s) that WRITE to `catalog.schemaName.tableName` — via
 * `CREATE TABLE ... AS SELECT`, `INSERT INTO/OVERWRITE`, `MERGE INTO`, or a DataFrame
 * `.saveAsTable()`/`.insertInto()` — under `notebookRoot`. Unlike `findResponsibleCode`, which
 * matches any statement that merely *references* the table, this is scoped to the statement(s)
 * that actually produce it, since that's the code an "implements this business rule?" check needs.
 */
export async function findCodeForTable(
  connection: ConnectionConfig,
  notebookRoot: string,
  catalog: string,
  schemaName: string,
  tableName: string
): Promise<CodeCandidate[]> {
  const notebooks = await listNotebooksRecursive(connection, notebookRoot);
  const needle = tableName.toLowerCase();
  const candidates: CodeCandidate[] = [];

  for (const notebook of notebooks) {
    let source: string;
    try {
      source = await exportNotebookSource(connection, notebook.path);
    } catch {
      continue;
    }
    if (!source.toLowerCase().includes(needle)) continue;

    const parsed = parseNotebookSource(notebook.path, source, notebook.language);
    const facts = extractLineageFacts(parsed);

    for (const fact of facts) {
      if (!fact.targetTable) continue;
      if (!matchesFullTableName(fact.targetTable, catalog, schemaName, tableName)) continue;

      candidates.push({
        notebookPath: fact.notebookPath,
        cellIndex: fact.cellIndex,
        snippet: snippet(fact.rawSql)
      });
    }
  }

  return candidates;
}
