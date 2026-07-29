import { Annotation, END, StateGraph } from "@langchain/langgraph";
import type { ConnectionConfig, LayerRef } from "../types/index.js";
import { runDataQualityChecks, type DataQualityResult } from "../services/dataQuality.js";
import { read_notebook_source, search_notebooks_by_keyword } from "./dqTools.js";

export interface DQStateInput {
  connection: ConnectionConfig;
  warehouseId: string;
  catalog: string;
  notebookRoot: string;
  layer: LayerRef;
}

export interface DQGraphProgressEvent {
  step: string;
  message: string;
  detail?: unknown;
}

const DQState = Annotation.Root({
  connection: Annotation<ConnectionConfig>(),
  warehouseId: Annotation<string>(),
  catalog: Annotation<string>(),
  notebookRoot: Annotation<string>(),
  layer: Annotation<LayerRef>(),
  preferredNotebookPaths: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  discoverySummary: Annotation<string | null>({ default: () => null }),
  result: Annotation<DataQualityResult | null>({ default: () => null })
});

type DQGraphState = typeof DQState.State;

async function discoverNotebookNode(state: DQGraphState) {
  const root = state.notebookRoot?.trim() || "/";
  const searchTerms = Array.from(
    new Set([state.layer.schema, state.layer.label].map((value) => value.trim().toLowerCase()).filter(Boolean))
  );

  const candidates = new Set<string>();
  for (const term of searchTerms) {
    const matches = await search_notebooks_by_keyword(state.connection, root, term);
    for (const match of matches.slice(0, 5)) {
      candidates.add(match.path);
    }
  }

  const preferredNotebookPaths = Array.from(candidates);
  let discoverySummary =
    preferredNotebookPaths.length > 0
      ? `Found ${preferredNotebookPaths.length} candidate notebook(s) for ${state.layer.label}.`
      : `No notebook candidates found for ${state.layer.label}; falling back to a full scan.`;

  if (preferredNotebookPaths.length > 0) {
    try {
      const source = await read_notebook_source(state.connection, preferredNotebookPaths[0]);
      discoverySummary += ` First candidate source length: ${source.length}.`;
    } catch {
      discoverySummary += " Unable to read the first candidate source.";
    }
  }

  return { preferredNotebookPaths, discoverySummary };
}

function routeAfterDiscovery(state: DQGraphState) {
  return state.preferredNotebookPaths.length > 0 ? "execute_with_discovery" : "execute_fallback";
}

async function executeWithDiscovery(state: DQGraphState) {
  const result = await runDataQualityChecks(
    state.connection,
    state.warehouseId,
    state.catalog,
    state.notebookRoot,
    state.layer,
    { preferredNotebookPaths: state.preferredNotebookPaths }
  );
  return { result };
}

async function executeFallback(state: DQGraphState) {
  const result = await runDataQualityChecks(state.connection, state.warehouseId, state.catalog, state.notebookRoot, state.layer);
  return { result };
}

function summarizeGraphEvent(eventName: string, nodeName: string, data: Record<string, unknown>): DQGraphProgressEvent | null {
  if (nodeName === "discover" && eventName === "on_chain_start") {
    return { step: "graph:discover:start", message: "Discovering candidate notebooks." };
  }

  if (nodeName === "discover" && eventName === "on_chain_end") {
    return {
      step: "graph:discover:done",
      message: "Notebook discovery complete.",
      detail: data.output
    };
  }

  if ((nodeName === "execute_with_discovery" || nodeName === "execute_fallback") && eventName === "on_chain_start") {
    return {
      step: "graph:execute:start",
      message:
        nodeName === "execute_with_discovery"
          ? "Running DQ checks with discovered notebook candidates."
          : "Running DQ checks with fallback notebook scan."
    };
  }

  if ((nodeName === "execute_with_discovery" || nodeName === "execute_fallback") && eventName === "on_chain_end") {
    return { step: "graph:execute:done", message: "DQ execution complete." };
  }

  if (nodeName === "dq-graph" && eventName === "on_chain_start") {
    return { step: "graph:start", message: "LangGraph run started." };
  }

  if (nodeName === "dq-graph" && eventName === "on_chain_end") {
    return {
      step: "graph:done",
      message: "LangGraph run complete.",
      detail: data.output
    };
  }

  return null;
}

const graph = new StateGraph(DQState)
  .addNode("discover", discoverNotebookNode)
  .addNode("execute_with_discovery", executeWithDiscovery)
  .addNode("execute_fallback", executeFallback)
  .addEdge("__start__", "discover")
  .addConditionalEdges("discover", routeAfterDiscovery, {
    execute_with_discovery: "execute_with_discovery",
    execute_fallback: "execute_fallback"
  })
  .addEdge("execute_with_discovery", END)
  .addEdge("execute_fallback", END)
  .compile({ name: "dq-graph" });

export async function runDQGraph(input: DQStateInput): Promise<DataQualityResult> {
  const state = await graph.invoke({
    connection: input.connection,
    warehouseId: input.warehouseId,
    catalog: input.catalog,
    notebookRoot: input.notebookRoot,
    layer: input.layer,
    preferredNotebookPaths: [],
    discoverySummary: null,
    result: null
  });

  if (!state.result) {
    throw new Error("DQ graph completed without a result.");
  }

  return state.result;
}

export async function runDQGraphWithProgress(
  input: DQStateInput,
  onProgress: (event: DQGraphProgressEvent) => void
): Promise<DataQualityResult> {
  const stream = await graph.streamEvents(
    {
      connection: input.connection,
      warehouseId: input.warehouseId,
      catalog: input.catalog,
      notebookRoot: input.notebookRoot,
      layer: input.layer,
      preferredNotebookPaths: [],
      discoverySummary: null,
      result: null
    },
    { version: "v2" }
  );

  let finalResult: DataQualityResult | null = null;

  for await (const event of stream) {
    const progress = summarizeGraphEvent(event.event, event.name, event.data ?? {});
    if (progress) {
      onProgress(progress);
    }

    if (event.name === "dq-graph" && event.event === "on_chain_end") {
      const output = event.data?.output as DQGraphState | undefined;
      if (output?.result) {
        finalResult = output.result;
      }
    }
  }

  if (!finalResult) {
    throw new Error("DQ graph completed without a result.");
  }

  return finalResult;
}

export async function findNotebookNode(
  connection: ConnectionConfig,
  notebookRoot: string,
  layer: LayerRef
): Promise<{ notebookPath?: string; notebookSource?: string } | null> {
  const root = notebookRoot?.trim() || "/";
  const searchTerms = Array.from(
    new Set([layer.schema, layer.label].map((value) => value.trim().toLowerCase()).filter(Boolean))
  );

  for (const term of searchTerms) {
    const matches = await search_notebooks_by_keyword(connection, root, term);
    if (matches.length === 0) continue;

    const first = matches[0];
    try {
      const source = await read_notebook_source(connection, first.path);
      return { notebookPath: first.path, notebookSource: source };
    } catch {
      return { notebookPath: first.path };
    }
  }

  return null;
}

export default runDQGraph;
