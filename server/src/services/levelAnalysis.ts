import type { CodeCandidate, ConnectionConfig, SelectedNotebook } from "../types/index.js";
import { exportNotebookSource } from "./databricksClient.js";
import { parseNotebookSource } from "./notebookParser.js";

const MAX_SNIPPET_CHARS = 4000;
const MAX_TOTAL_SNIPPETS = 40;

/** Reduce a qualified `catalog.schema.table` (or `schema.table`) to searchable needles. */
function tableNeedles(tables: string[]): string[] {
  const needles = new Set<string>();
  for (const t of tables) {
    const lower = t.toLowerCase();
    needles.add(lower);
    const bare = lower.split(".").pop();
    if (bare) needles.add(bare);
  }
  return [...needles];
}

/**
 * Exports each user-selected notebook, splits it into cells, and returns the code snippets that
 * actually reference the selected tables. Falls back to a notebook's full set of code cells when
 * none mention the tables by name (the user chose it deliberately). Never sends markdown cells,
 * and caps both per-snippet and total size so whole notebooks aren't shipped to the LLM.
 */
export async function gatherLevelCode(
  connection: ConnectionConfig,
  notebooks: SelectedNotebook[],
  tables: string[]
): Promise<CodeCandidate[]> {
  const needles = tableNeedles(tables);
  const candidates: CodeCandidate[] = [];

  for (const notebook of notebooks) {
    const source = await exportNotebookSource(connection, notebook.path);
    const language = notebook.language === "UNKNOWN" ? "PYTHON" : notebook.language;
    const parsed = parseNotebookSource(notebook.path, source, language);

    const codeCells = parsed.cells.filter((c) => c.language !== "md" && c.source.trim().length > 0);
    const matching = needles.length
      ? codeCells.filter((c) => {
          const lower = c.source.toLowerCase();
          return needles.some((n) => lower.includes(n));
        })
      : codeCells;
    const chosen = matching.length ? matching : codeCells;

    for (const cell of chosen) {
      candidates.push({
        notebookPath: notebook.path,
        cellIndex: cell.index,
        snippet: cell.source.slice(0, MAX_SNIPPET_CHARS)
      });
      if (candidates.length >= MAX_TOTAL_SNIPPETS) return candidates;
    }
  }

  return candidates;
}
