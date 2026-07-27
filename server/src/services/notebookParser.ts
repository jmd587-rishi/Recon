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

    const lines = trimmed.split("\n");
    const magicLinePattern = new RegExp(`^${prefixRe}\\s*MAGIC\\b ?(.*)$`);
    const firstLineMagic = lines[0].match(magicLinePattern);

    if (firstLineMagic) {
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
