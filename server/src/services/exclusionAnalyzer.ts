import type { ConnectionConfig, ExclusionRule, Table } from "../types/index.js";
import { runCountStatement } from "./databricksClient.js";
import type { LineageFact } from "./tableLineage.js";
import { extractWherePredicate } from "./whereClauseAnalyzer.js";

const MAX_LABEL_LEN = 70;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * For each table in one layer, finds the notebook statement that writes it (from `facts`, already
 * scanned once for the whole pipeline by `tableLineage.scanAllLineageFacts` — this function doesn't
 * re-scan notebooks itself) and, if that statement has a WHERE predicate, runs a live
 * `COUNT(*) ... WHERE NOT (predicate)` against its source table to report how many rows it drops.
 * `tableIndex` (bare table name -> Table, built across every layer) resolves which schema the
 * source table actually lives in, since `LineageFact.sourceTables` carries bare names when the
 * notebook SQL doesn't schema-qualify them.
 *
 * Statements with more than one source table (a join) still produce a rule with the predicate
 * shown, but `excludedCount` is left null rather than guessing which side of the join it applies to.
 */
export async function computeLayerExclusions(
  connection: ConnectionConfig,
  warehouseId: string,
  catalog: string,
  tables: Table[],
  facts: LineageFact[],
  tableIndex: Map<string, Table>
): Promise<ExclusionRule[]> {
  const rules: ExclusionRule[] = [];

  for (const table of tables) {
    const needle = table.name.toLowerCase();
    const fact = facts.find((f) => f.targetTable && f.targetTable.split(".").pop() === needle);
    if (!fact) continue;

    const predicateSql = extractWherePredicate(fact.rawSql);
    if (!predicateSql) continue;

    const sourceTable = fact.sourceTables[0] ?? null;
    let excludedCount: number | null = null;

    if (sourceTable && fact.sourceTables.length === 1) {
      const sourceBareName = sourceTable.split(".").pop()!;
      const sourceMeta = tableIndex.get(sourceBareName);
      const sourceSchema = sourceMeta?.schemaName;

      if (sourceSchema) {
        const statement = `SELECT COUNT(*) AS cnt FROM \`${catalog}\`.\`${sourceSchema}\`.\`${sourceBareName}\` WHERE NOT (${predicateSql})`;
        try {
          excludedCount = await runCountStatement(connection, warehouseId, statement);
        } catch {
          excludedCount = null;
        }
      }
    }

    rules.push({
      notebookPath: fact.notebookPath,
      cellIndex: fact.cellIndex,
      predicateSql,
      sourceTable: sourceTable ?? "(unknown)",
      excludedCount,
      label: `${table.name}: ${truncate(predicateSql, MAX_LABEL_LEN)}`,
      explanation: "",
      severity: "ok"
    });
  }

  return rules;
}
