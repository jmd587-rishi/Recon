import { Router } from "express";
import { computeLayerExclusions } from "../services/exclusionAnalyzer.js";
import { listTables, listWarehouses, runSqlCount } from "../services/databricksClient.js";
import { explainExclusionRules, LlmConfigError } from "../services/llmClient.js";
import { buildLineageGraph, scanAllLineageFacts } from "../services/tableLineage.js";
import type { ExclusionRule, LayerExclusionResult, LayerRef, PipelineAnalysis, Table } from "../types/index.js";
import { type ConnectedRequest, requireConnection } from "./requireConnection.js";

export const pipelineRouter = Router();

pipelineRouter.use(requireConnection);

const CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function isValidLayers(layers: unknown): layers is LayerRef[] {
  if (!Array.isArray(layers) || layers.length === 0) return false;
  return layers.every(
    (l): l is LayerRef =>
      typeof l === "object" &&
      l !== null &&
      typeof (l as Record<string, unknown>).label === "string" &&
      typeof (l as Record<string, unknown>).schema === "string" &&
      (l as LayerRef).label.length > 0 &&
      (l as LayerRef).schema.length > 0
  );
}

pipelineRouter.get("/warehouses", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;
  try {
    const warehouses = await listWarehouses(connection);
    res.json({ warehouses });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

pipelineRouter.post("/table-counts", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;
  const { catalog, warehouseId, tables } = req.body ?? {};

  const validTables =
    Array.isArray(tables) &&
    tables.every(
      (t) => typeof t === "object" && t !== null && typeof t.schema === "string" && typeof t.name === "string"
    );

  if (!catalog || !warehouseId || !validTables) {
    res.status(400).json({ error: "Expected body: { catalog, warehouseId, tables: [{ schema, name }, ...] }" });
    return;
  }

  try {
    const counts: Record<string, number> = {};
    const rows = await mapWithConcurrency(
      tables as { schema: string; name: string }[],
      CONCURRENCY,
      async (t) => ({ key: `${t.schema}.${t.name}`, count: await runSqlCount(connection, warehouseId, catalog, t.schema, t.name) })
    );
    for (const row of rows) counts[row.key] = row.count;
    res.json({ counts });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

pipelineRouter.post("/analyze", async (req, res) => {
  const { databricksConnection: connection } = req as ConnectedRequest;
  const { catalog, warehouseId, notebookRoot, layers } = req.body ?? {};

  if (!catalog || !warehouseId || !isValidLayers(layers)) {
    res.status(400).json({
      error: "Expected body: { catalog, warehouseId, notebookRoot?, layers: [{ label, schema }, ...] } with at least 1 layer"
    });
    return;
  }

  const root = typeof notebookRoot === "string" && notebookRoot.length > 0 ? notebookRoot : "/";

  try {
    const tablesByLayer = await mapWithConcurrency(layers as LayerRef[], CONCURRENCY, async (layer) => ({
      layer,
      tables: await listTables(connection, catalog, layer.schema)
    }));

    const tableIndex = new Map<string, Table>();
    for (const { tables } of tablesByLayer) {
      for (const table of tables) tableIndex.set(table.name.toLowerCase(), table);
    }

    const facts = await scanAllLineageFacts(connection, root);
    const lineage = buildLineageGraph(facts, tableIndex);

    const perLayerRules = await mapWithConcurrency(tablesByLayer.slice(1), 1, async ({ layer, tables }) => {
      const rules = await computeLayerExclusions(connection, warehouseId, catalog, tables, facts, tableIndex);
      const totalRows = tables.length
        ? (await mapWithConcurrency(tables, CONCURRENCY, (t) => runSqlCount(connection, warehouseId, catalog, layer.schema, t.name))).reduce(
            (a, b) => a + b,
            0
          )
        : 0;
      return { layer, totalRows, rules };
    });

    const flatRules = perLayerRules.flatMap((l) => l.rules);
    let explanations: Awaited<ReturnType<typeof explainExclusionRules>> = [];
    try {
      explanations = await explainExclusionRules(
        flatRules.map((r) => ({
          label: r.label,
          predicateSql: r.predicateSql ?? "",
          sourceTable: r.sourceTable,
          excludedCount: r.excludedCount
        }))
      );
    } catch (err) {
      if (!(err instanceof LlmConfigError)) throw err;
      // LLM not configured — still return the mechanically-derived rules, just without narrative.
    }

    let cursor = 0;
    const exclusions: LayerExclusionResult[] = perLayerRules.map(({ layer, totalRows, rules }) => {
      const explained: ExclusionRule[] = rules.map((rule) => {
        const exp = explanations[cursor++];
        return exp ? { ...rule, explanation: exp.explanation, severity: exp.severity } : rule;
      });
      return { layer, totalRows, rules: explained };
    });

    const analysis: PipelineAnalysis = { exclusions, lineage };
    res.json(analysis);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
