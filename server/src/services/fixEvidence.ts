import type {
  CellEvidence,
  ConnectionConfig,
  FilterDrop,
  HopEvidence,
  LayerRef,
  RowCountPair,
  StageMismatch,
  Table
} from "../types/index.js";
import { CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { runSqlCount } from "./databricksClient.js";
import { computeLayerExclusions } from "./exclusionAnalyzer.js";
import { diffMismatches } from "./tableComparator.js";
import type { LineageFact } from "./tableLineage.js";

/**
 * Ceiling on `COUNT(*)` statements issued per governance review. A review already caps the code it
 * ships to the model at `MAX_TOTAL_SNIPPETS` (40); this is the matching cap on warehouse work, so a
 * workspace with hundreds of tables can't turn one button click into hundreds of queries.
 */
export const MAX_EVIDENCE_STATEMENTS = 40;

/** `bronze.customer` -> `customer`; `customer` -> `customer`. */
function bareName(ref: string): string {
  return (ref.split(".").pop() ?? ref).toLowerCase();
}

/** The schema part of a qualified ref, if the notebook SQL bothered to qualify it. */
function qualifiedSchema(ref: string): string | null {
  const parts = ref.split(".");
  return parts.length >= 2 ? parts[parts.length - 2].toLowerCase() : null;
}

interface ResolvedRef {
  schema: string;
  name: string;
  /** `schema.name`, for display and as the dedup key. */
  key: string;
}

/**
 * Works out which schema a table reference actually lives in. Notebook SQL frequently leaves tables
 * bare (`FROM customer`), so a bare name is resolved against the tables of the layer it's expected
 * in first (`preferred`), then the other side of the hop. An explicitly qualified ref wins outright.
 */
function resolveRef(ref: string, preferred: Map<string, Table>, fallback: Map<string, Table>): ResolvedRef | null {
  const name = bareName(ref);
  const explicit = qualifiedSchema(ref);
  if (explicit) return { schema: explicit, name, key: `${explicit}.${name}` };

  const meta = preferred.get(name) ?? fallback.get(name);
  if (!meta?.schemaName) return null;
  return { schema: meta.schemaName, name, key: `${meta.schemaName.toLowerCase()}.${name}` };
}

function byBareName(tables: Table[]): Map<string, Table> {
  return new Map(tables.map((t) => [t.name.toLowerCase(), t]));
}

/** One source -> target pairing awaiting its counts. */
interface PendingPair {
  notebookPath: string;
  cellIndex: number;
  source: ResolvedRef;
  target: ResolvedRef;
}

/**
 * Measures the row-count reality behind one medallion hop so the fix model reasons over numbers
 * instead of code shape alone.
 *
 * Two independent measurements, both best-effort — a table that's a view, a cold warehouse, or a
 * table the PAT can't read yields a `null` count rather than failing the whole review:
 *
 * 1. **Per write-statement pairing** — each lineage fact that writes a target-layer table gets its
 *    target counted against each of its source tables. This pairs by *lineage* rather than by name,
 *    which matters because silver -> gold routinely renames tables (`orders` -> `fact_sales`), so
 *    name matching would find nothing there.
 * 2. **Per filter drop** — delegated wholesale to `computeLayerExclusions`, which runs
 *    `COUNT(*) ... WHERE NOT (<predicate>)` against the source table and already reports its results
 *    keyed by `notebookPath` + `cellIndex`, exactly how fixes are keyed.
 *
 * `diffMismatches` supplies the same-named-table summary line on top, computed from counts already
 * in the cache rather than by re-querying.
 */
export async function gatherHopEvidence(params: {
  connection: ConnectionConfig;
  warehouseId: string;
  catalog: string;
  fromLayer: LayerRef;
  toLayer: LayerRef;
  facts: LineageFact[];
  fromTables: Table[];
  toTables: Table[];
}): Promise<HopEvidence> {
  const { connection, warehouseId, catalog, fromLayer, toLayer, facts, fromTables, toTables } = params;

  const fromByName = byBareName(fromTables);
  const toByName = byBareName(toTables);
  const toSet = new Set(toByName.keys());

  // Collect every source -> target pairing this hop's write statements imply.
  const pairs: PendingPair[] = [];
  for (const fact of facts) {
    if (!fact.targetTable || !toSet.has(bareName(fact.targetTable))) continue;
    const target = resolveRef(fact.targetTable, toByName, fromByName);
    if (!target) continue;
    for (const sourceRef of fact.sourceTables) {
      const source = resolveRef(sourceRef, fromByName, toByName);
      if (!source || source.key === target.key) continue;
      pairs.push({ notebookPath: fact.notebookPath, cellIndex: fact.cellIndex, source, target });
    }
  }

  // Count each distinct table once, under the shared statement budget.
  const wanted = new Map<string, ResolvedRef>();
  for (const p of pairs) {
    wanted.set(p.source.key, p.source);
    wanted.set(p.target.key, p.target);
  }
  // Same-named tables on both sides feed the mismatch summary, so make sure both sides are counted.
  for (const name of toSet) {
    const from = fromByName.get(name);
    const to = toByName.get(name);
    if (!from?.schemaName || !to?.schemaName) continue;
    const fromKey = `${from.schemaName.toLowerCase()}.${name}`;
    const toKey = `${to.schemaName.toLowerCase()}.${name}`;
    if (fromKey === toKey) continue;
    wanted.set(fromKey, { schema: from.schemaName, name, key: fromKey });
    wanted.set(toKey, { schema: to.schemaName, name, key: toKey });
  }

  const all = [...wanted.values()];
  const budgeted = all.slice(0, MAX_EVIDENCE_STATEMENTS);
  let truncated = budgeted.length < all.length;

  const counted = await mapWithConcurrency(budgeted, CONCURRENCY, async (ref) => {
    try {
      return { key: ref.key, count: await runSqlCount(connection, warehouseId, catalog, ref.schema, ref.name) };
    } catch {
      return { key: ref.key, count: null };
    }
  });
  const counts = new Map<string, number | null>(counted.map((c) => [c.key, c.count]));

  // Filter drops, with whatever statement budget the pairings left over. Slicing the table list is
  // the only lever `computeLayerExclusions` offers, and it only queries tables that actually have a
  // predicate — so this is a ceiling on its work, not an exact quota.
  const filterBudget = Math.max(0, MAX_EVIDENCE_STATEMENTS - budgeted.length);
  if (filterBudget < toTables.length) truncated = true;
  const tableIndex = new Map<string, Table>([...fromByName, ...toByName]);
  let rules: Awaited<ReturnType<typeof computeLayerExclusions>> = [];
  if (filterBudget > 0) {
    try {
      rules = await computeLayerExclusions(
        connection,
        warehouseId,
        catalog,
        toTables.slice(0, filterBudget),
        facts,
        tableIndex
      );
    } catch {
      rules = [];
    }
  }

  // Fold both measurements into one entry per cell.
  const cells = new Map<string, CellEvidence>();
  const cellFor = (notebookPath: string, cellIndex: number): CellEvidence => {
    const key = `${notebookPath}::${cellIndex}`;
    const existing = cells.get(key);
    if (existing) return existing;
    const created: CellEvidence = { notebookPath, cellIndex, rowCounts: [], filters: [] };
    cells.set(key, created);
    return created;
  };

  for (const pair of pairs) {
    const sourceRows = counts.get(pair.source.key) ?? null;
    const targetRows = counts.get(pair.target.key) ?? null;
    const rowCount: RowCountPair = {
      sourceTable: pair.source.key,
      sourceRows,
      targetTable: pair.target.key,
      targetRows,
      delta: sourceRows !== null && targetRows !== null ? targetRows - sourceRows : null
    };
    const cell = cellFor(pair.notebookPath, pair.cellIndex);
    if (!cell.rowCounts.some((r) => r.sourceTable === rowCount.sourceTable && r.targetTable === rowCount.targetTable)) {
      cell.rowCounts.push(rowCount);
    }
  }

  for (const rule of rules) {
    const filter: FilterDrop = {
      predicateSql: rule.predicateSql ?? "",
      sourceTable: rule.sourceTable,
      excludedRows: rule.excludedCount
    };
    if (!filter.predicateSql) continue;
    cellFor(rule.notebookPath, rule.cellIndex).filters.push(filter);
  }

  return {
    cells: [...cells.values()],
    mismatches: buildMismatches(fromLayer, toLayer, fromByName, toByName, counts),
    truncated
  };
}

/** Same-named tables on both sides of the hop whose counts differ, from the already-fetched counts. */
function buildMismatches(
  fromLayer: LayerRef,
  toLayer: LayerRef,
  fromByName: Map<string, Table>,
  toByName: Map<string, Table>,
  counts: Map<string, number | null>
): StageMismatch[] {
  const shared: string[] = [];
  const fromCounts = new Map<string, number>();
  const toCounts = new Map<string, number>();

  for (const [name, from] of fromByName) {
    const to = toByName.get(name);
    if (!to?.schemaName || !from.schemaName) continue;
    const fromValue = counts.get(`${from.schemaName.toLowerCase()}.${name}`);
    const toValue = counts.get(`${to.schemaName.toLowerCase()}.${name}`);
    if (typeof fromValue !== "number" || typeof toValue !== "number") continue;
    shared.push(name);
    fromCounts.set(name, fromValue);
    toCounts.set(name, toValue);
  }

  return diffMismatches(shared, fromCounts, toCounts, fromLayer.label, toLayer.label);
}

/** Looks up the evidence gathered for one cell, for attaching to a candidate or a fix. */
export function evidenceForCell(
  evidence: HopEvidence | null,
  notebookPath: string,
  cellIndex: number
): CellEvidence | null {
  if (!evidence) return null;
  return evidence.cells.find((c) => c.notebookPath === notebookPath && c.cellIndex === cellIndex) ?? null;
}
