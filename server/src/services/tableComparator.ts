import type { ConnectionConfig, MedallionStage, StageMismatch } from "../types/index.js";
import { listTables, runSqlCount } from "./databricksClient.js";

export function diffMismatches(
  tableNames: string[],
  fromCounts: Map<string, number>,
  toCounts: Map<string, number>,
  fromStage: string,
  toStage: string
): StageMismatch[] {
  const mismatches: StageMismatch[] = [];
  for (const tableName of tableNames) {
    const fromCount = fromCounts.get(tableName);
    const toCount = toCounts.get(tableName);
    if (fromCount === undefined || toCount === undefined) continue;
    if (fromCount === toCount) continue;
    mismatches.push({ tableName, fromStage, toStage, fromCount, toCount, difference: toCount - fromCount });
  }
  return mismatches;
}

async function countSharedTables(
  connection: ConnectionConfig,
  warehouseId: string,
  catalogName: string,
  fromSchema: string,
  toSchema: string
): Promise<{ tableNames: string[]; fromCounts: Map<string, number>; toCounts: Map<string, number> }> {
  const [fromTables, toTables] = await Promise.all([
    listTables(connection, catalogName, fromSchema),
    listTables(connection, catalogName, toSchema)
  ]);

  const toNames = new Set(toTables.map((t) => t.name));
  const tableNames = fromTables.map((t) => t.name).filter((name) => toNames.has(name));

  const fromCounts = new Map<string, number>();
  const toCounts = new Map<string, number>();

  await Promise.all(
    tableNames.map(async (name) => {
      const [fromCount, toCount] = await Promise.all([
        runSqlCount(connection, warehouseId, catalogName, fromSchema, name),
        runSqlCount(connection, warehouseId, catalogName, toSchema, name)
      ]);
      fromCounts.set(name, fromCount);
      toCounts.set(name, toCount);
    })
  );

  return { tableNames, fromCounts, toCounts };
}

/**
 * Compares row counts between each adjacent pair of stages in a medallion chain
 * (e.g. bronze -> silver -> gold), matching tables by name within each pair.
 */
export async function compareMedallionStages(
  connection: ConnectionConfig,
  warehouseId: string,
  catalogName: string,
  stages: MedallionStage[]
): Promise<StageMismatch[]> {
  if (stages.length < 2) {
    throw new Error("At least two stages (e.g. bronze and silver) are required to compare.");
  }

  const results = await Promise.all(
    stages.slice(0, -1).map(async (stage, i) => {
      const nextStage = stages[i + 1];
      const { tableNames, fromCounts, toCounts } = await countSharedTables(
        connection,
        warehouseId,
        catalogName,
        stage.schema,
        nextStage.schema
      );
      return diffMismatches(tableNames, fromCounts, toCounts, stage.label, nextStage.label);
    })
  );

  return results.flat();
}
