import type {
  CellLanguage,
  CodeCandidate,
  ConnectionConfig,
  LayerRef,
  NotebookMeta,
  ParsedNotebook,
  Table
} from "../types/index.js";
import { exportNotebookSource, listNotebooksRecursive, listTables } from "./databricksClient.js";
import { parseNotebookSource } from "./notebookParser.js";
import { extractLineageFacts, type LineageFact } from "./tableLineage.js";

const MAX_SNIPPET_CHARS = 4000;
const MAX_TOTAL_SNIPPETS = 40;

const COMMENT_PREFIX: Record<NotebookMeta["language"], string> = {
  PYTHON: "#",
  R: "#",
  SQL: "--",
  SCALA: "//",
  UNKNOWN: "#"
};

const DEFAULT_CELL_LANGUAGE: Record<NotebookMeta["language"], CellLanguage> = {
  PYTHON: "python",
  R: "r",
  SQL: "sql",
  SCALA: "scala",
  UNKNOWN: "unknown"
};

const FILE_EXTENSION: Record<NotebookMeta["language"], string> = {
  PYTHON: "py",
  R: "r",
  SQL: "sql",
  SCALA: "scala",
  UNKNOWN: "py"
};

/** Maps a cell language back to the `%magic` keyword used in Databricks source exports. */
const CELL_MAGIC: Partial<Record<CellLanguage, string>> = {
  sql: "sql",
  python: "python",
  scala: "scala",
  r: "r",
  md: "md"
};

export interface ResponsibleNotebook {
  path: string;
  language: NotebookMeta["language"];
  parsed: ParsedNotebook;
}

export interface GatheredLevelCode {
  /** Every notebook that writes a table in the target layer of this hop. */
  notebooks: ResponsibleNotebook[];
  /** The relevant code cells across those notebooks, capped, ready for the LLM. */
  candidates: CodeCandidate[];
  /** Lineage facts from the responsible notebooks, so evidence gathering needn't re-parse them. */
  facts: LineageFact[];
  /** Tables in the hop's source and target schemas, reused for schema resolution downstream. */
  fromTables: Table[];
  toTables: Table[];
}

function bareNameSet(tables: { name: string }[]): Set<string> {
  return new Set(tables.map((t) => t.name.toLowerCase()));
}

function bareTarget(target: string | null): string | null {
  return target ? (target.split(".").pop() ?? target).toLowerCase() : null;
}

/**
 * Finds the notebooks responsible for one medallion hop (`fromLayer` -> `toLayer`) by scanning every
 * notebook under `notebookRoot` and keeping those whose lineage facts *write* a table living in the
 * target layer's schema. From each responsible notebook it collects the code cells that reference a
 * table on either side of the hop (falling back to all code cells), capped in size, for the LLM;
 * the full parsed notebook is retained separately so a corrected file can be rebuilt afterwards.
 */
export async function gatherLevelTransformationCode(
  connection: ConnectionConfig,
  catalog: string,
  notebookRoot: string,
  fromLayer: LayerRef,
  toLayer: LayerRef
): Promise<GatheredLevelCode> {
  const [fromTables, toTables] = await Promise.all([
    listTables(connection, catalog, fromLayer.schema),
    listTables(connection, catalog, toLayer.schema)
  ]);
  const fromSet = bareNameSet(fromTables);
  const toSet = bareNameSet(toTables);
  const needles = new Set<string>([...fromSet, ...toSet]);

  const allNotebooks = await listNotebooksRecursive(connection, notebookRoot);
  const notebooks: ResponsibleNotebook[] = [];
  const candidates: CodeCandidate[] = [];
  const facts: LineageFact[] = [];

  for (const meta of allNotebooks) {
    let source: string;
    try {
      source = await exportNotebookSource(connection, meta.path);
    } catch {
      continue;
    }
    const parsed = parseNotebookSource(meta.path, source, meta.language);
    const notebookFacts = extractLineageFacts(parsed);

    const writesTargetLayer = notebookFacts.some((f) => {
      const target = bareTarget(f.targetTable);
      return target !== null && toSet.has(target);
    });
    if (!writesTargetLayer) continue;

    notebooks.push({ path: meta.path, language: meta.language, parsed });
    facts.push(...notebookFacts);

    if (candidates.length >= MAX_TOTAL_SNIPPETS) continue;
    const codeCells = parsed.cells.filter((c) => c.language !== "md" && c.source.trim().length > 0);
    const matching = codeCells.filter((c) => {
      const lower = c.source.toLowerCase();
      return [...needles].some((n) => lower.includes(n));
    });
    const chosen = matching.length ? matching : codeCells;

    for (const cell of chosen) {
      if (candidates.length >= MAX_TOTAL_SNIPPETS) break;
      candidates.push({
        notebookPath: meta.path,
        cellIndex: cell.index,
        snippet: cell.source.slice(0, MAX_SNIPPET_CHARS)
      });
    }
  }

  return { notebooks, candidates, facts, fromTables, toTables };
}

/**
 * Rebuilds a notebook in Databricks "source" export format (the inverse of `parseNotebookSource`),
 * substituting corrected cell bodies from `correctionsByCell` (keyed by cell index) where present and
 * leaving all other cells untouched — so the download is the *whole* notebook with the fixes applied,
 * even though only the changed cells were ever sent to the model.
 */
export function reconstructNotebookSource(
  parsed: ParsedNotebook,
  defaultLanguage: NotebookMeta["language"],
  correctionsByCell: Map<number, string>
): string {
  const prefix = COMMENT_PREFIX[defaultLanguage] ?? "#";
  const defaultCellLang = DEFAULT_CELL_LANGUAGE[defaultLanguage];
  const out: string[] = [`${prefix} Databricks notebook source`];

  for (const cell of parsed.cells) {
    const body = correctionsByCell.get(cell.index) ?? cell.source;
    out.push("", `${prefix} COMMAND ----------`, "");

    if (cell.language === defaultCellLang) {
      out.push(body);
    } else {
      const magic = CELL_MAGIC[cell.language];
      if (magic) out.push(`${prefix} MAGIC %${magic}`);
      for (const line of body.split("\n")) out.push(`${prefix} MAGIC ${line}`);
    }
  }

  return `${out.join("\n")}\n`;
}

/** `/Repos/team/etl/load_fact_sales` -> `load_fact_sales.corrected.py` (extension by language). */
export function correctedFilename(notebookPath: string, language: NotebookMeta["language"]): string {
  const base = notebookPath.split("/").pop() || "notebook";
  return `${base}.corrected.${FILE_EXTENSION[language] ?? "py"}`;
}
