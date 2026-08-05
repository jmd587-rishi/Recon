import type { LineageFact } from "./tableLineage.js";
import { extractLineageFacts, resolveTempTableSources } from "./tableLineage.js";
import { parseNotebookSource } from "./notebookParser.js";
import { isSqlFile, splitSqlStatements, type SqlStatement } from "./sqlFileParser.js";
import type { NotebookMeta } from "../types/index.js";

/**
 * Reads any file a data engineer writes pipeline logic in, not only `.sql`.
 *
 * A warehouse project is rarely one language. The same pipeline has SSDT `.sql` scripts, Databricks
 * notebooks exported as `.py` or `.scala`, and Jupyter `.ipynb` files, and the lineage that governance
 * has to follow runs straight through all of them — a `.sql` procedure reading a table that a
 * PySpark notebook wrote. Reading only the SQL leaves those tables looking like they come from
 * nowhere, which is exactly where a reconciliation script has nothing to say.
 *
 * Everything here routes into machinery that already exists: `sqlFileParser` for standalone SQL,
 * `notebookParser` + `tableLineage.extractLineageFacts` for notebooks — the same path the Databricks
 * flows use, so `spark.sql()`, the DataFrame API and `%sql` magic cells are all understood as they
 * already are there. The one thing a notebook does not carry is byte spans, so a fix cannot be
 * spliced back into it; `spliceable` says so rather than producing a corrupted file.
 */

/** Extensions whose contents are pipeline code, by how they have to be read. */
const NOTEBOOK_LANGUAGES: Record<string, NotebookMeta["language"]> = {
  ".py": "PYTHON",
  ".scala": "SCALA",
  ".r": "R"
};

export type CodeFileKind = "sql" | "notebook" | "ipynb";

/** How this file has to be read, or null when it holds no pipeline code. */
export function codeFileKind(path: string): CodeFileKind | null {
  const lower = path.toLowerCase();
  if (isSqlFile(lower)) return "sql";
  if (lower.endsWith(".ipynb")) return "ipynb";
  return Object.keys(NOTEBOOK_LANGUAGES).some((ext) => lower.endsWith(ext)) ? "notebook" : null;
}

/** Every extension the folder scan should pick up, for the client to filter with. */
export const CODE_EXTENSIONS = [".sql", ".py", ".scala", ".r", ".ipynb"];

function notebookLanguage(path: string): NotebookMeta["language"] {
  const lower = path.toLowerCase();
  for (const [ext, language] of Object.entries(NOTEBOOK_LANGUAGES)) {
    if (lower.endsWith(ext)) return language;
  }
  return "PYTHON";
}

interface JupyterCell {
  cell_type?: unknown;
  source?: unknown;
}

/**
 * Rewrites a Jupyter notebook as the Databricks export format, so one parser handles both.
 *
 * The formats say the same things differently: a `.ipynb` holds a JSON array of cells where a
 * Databricks export holds `# COMMAND ----------` separators, and a `%sql` first line means the same
 * in each. Converting is a dozen lines; a second cell parser would be a second place for the
 * `%magic` and `DBTITLE` rules to drift out of step.
 */
export function ipynbToNotebookSource(content: string): string | null {
  let parsed: { cells?: unknown };
  try {
    parsed = JSON.parse(content) as { cells?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.cells)) return null;

  const blocks: string[] = [];
  for (const cell of parsed.cells as JupyterCell[]) {
    if (cell.cell_type !== "code") continue;
    const source = Array.isArray(cell.source)
      ? cell.source.filter((line): line is string => typeof line === "string").join("")
      : typeof cell.source === "string"
        ? cell.source
        : "";
    const body = source.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    if (body.trim().length === 0) continue;

    // A `%sql` / `%%sql` cell becomes the MAGIC form `notebookParser` already resolves.
    const magic = /^\s*%{1,2}([a-zA-Z-]+)\s*\n?/.exec(body);
    blocks.push(
      magic
        ? [`# MAGIC %${magic[1].toLowerCase()}`, ...body.slice(magic[0].length).split("\n").map((l) => `# MAGIC ${l}`)].join("\n")
        : body
    );
  }

  return blocks.length > 0 ? blocks.join("\n\n# COMMAND ----------\n\n") : null;
}

export interface ReadCodeFile {
  statements: SqlStatement[];
  facts: LineageFact[];
  /** Whether a corrected statement can be spliced back — only a `.sql` file carries byte spans. */
  spliceable: boolean;
}

/** Reads one file into the statements and lineage facts the rest of the flow works from. */
export function readCodeFile(path: string, content: string): ReadCodeFile | null {
  const kind = codeFileKind(path);
  if (!kind) return null;

  if (kind === "sql") {
    const statements = splitSqlStatements(content);
    if (statements.length === 0) return null;
    const facts: LineageFact[] = statements.map((stmt) => ({
      notebookPath: path,
      cellIndex: stmt.index,
      // `splitSqlTablesByOp` runs inside `extractLineageFacts` for notebooks; here the statement is
      // already the unit, so the caller splits it directly (kept in `localProject`).
      sourceTables: [],
      targetTable: null,
      rawSql: stmt.sql
    }));
    return { statements, facts, spliceable: true };
  }

  const source = kind === "ipynb" ? ipynbToNotebookSource(content) : content;
  if (source === null) return null;

  const parsed = parseNotebookSource(path, source, notebookLanguage(path));
  const code = parsed.cells.filter((cell) => cell.language !== "md" && cell.source.trim().length > 0);
  if (code.length === 0) return null;

  // One "statement" per cell. The spans are zero because a notebook has none to give — nothing may
  // splice using them, which `spliceable: false` enforces.
  const statements: SqlStatement[] = code.map((cell) => ({
    index: cell.index,
    sql: cell.source,
    start: 0,
    end: 0
  }));

  return {
    statements,
    facts: resolveTempTableSources(extractLineageFacts({ path, cells: code })),
    spliceable: false
  };
}
