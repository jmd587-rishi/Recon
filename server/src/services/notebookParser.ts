import type { CellLanguage, NotebookCell, NotebookMeta, ParsedNotebook } from "../types/index.js";

type DefaultLanguage = NotebookMeta["language"];

const COMMENT_PREFIX: Record<DefaultLanguage, string> = {
  PYTHON: "#",
  R: "#",
  SQL: "--",
  SCALA: "//",
  UNKNOWN: "#"
};

const DEFAULT_CELL_LANGUAGE: Record<DefaultLanguage, CellLanguage> = {
  PYTHON: "python",
  R: "r",
  SQL: "sql",
  SCALA: "scala",
  UNKNOWN: "unknown"
};

const MAGIC_LANGUAGE_MAP: Record<string, CellLanguage> = {
  sql: "sql",
  python: "python",
  scala: "scala",
  r: "r",
  md: "md",
  "md-sandbox": "md"
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseNotebookSource(
  path: string,
  source: string,
  defaultLanguage: DefaultLanguage
): ParsedNotebook {
  const prefix = COMMENT_PREFIX[defaultLanguage] ?? "#";
  const prefixRe = escapeRegExp(prefix);

  const normalized = source.replace(/\r\n/g, "\n");
  const withoutHeader = normalized.replace(
    new RegExp(`^${prefixRe}\\s*Databricks notebook source\\s*\\n`),
    ""
  );

  const commandSplit = new RegExp(`^${prefixRe}\\s*COMMAND -+\\s*$`, "m");
  const rawCells = withoutHeader.split(commandSplit);

  const cells: NotebookCell[] = [];
  rawCells.forEach((rawCell, index) => {
    const trimmed = rawCell.replace(/^\n+/, "").replace(/\n+$/, "");
    if (trimmed.length === 0) return;

    const allLines = trimmed.split("\n");
    const magicLinePattern = new RegExp(`^${prefixRe}\\s*MAGIC\\b ?(.*)$`);

    // `# DBTITLE 1,<title>` is cell metadata, not body: Databricks writes it above the `# MAGIC`
    // marker whenever a cell has been given a name. Testing only the very first line for the marker
    // therefore misses every *named* `%sql` cell, and the whole cell is then read as Python — which
    // means its CREATE/INSERT statements contribute no lineage at all, silently.
    const titlePattern = new RegExp(`^${prefixRe}\\s*DBTITLE\\b`);
    let start = 0;
    while (start < allLines.length && titlePattern.test(allLines[start])) start++;
    const lines = allLines.slice(start);

    if (lines.length > 0 && magicLinePattern.test(lines[0])) {
      const magicLines = lines.map((line) => {
        const m = line.match(magicLinePattern);
        return m ? m[1] : line;
      });

      const langMatch = magicLines[0].match(/^%([a-zA-Z-]+)\s*$/);
      let language: CellLanguage = DEFAULT_CELL_LANGUAGE[defaultLanguage];
      let bodyLines = magicLines;
      if (langMatch) {
        const key = langMatch[1].toLowerCase();
        language = MAGIC_LANGUAGE_MAP[key] ?? "unknown";
        bodyLines = magicLines.slice(1);
      }

      cells.push({
        index,
        language,
        source: bodyLines.join("\n").trim()
      });
    } else {
      cells.push({
        index,
        language: DEFAULT_CELL_LANGUAGE[defaultLanguage],
        source: trimmed
      });
    }
  });

  return { path, cells };
}
