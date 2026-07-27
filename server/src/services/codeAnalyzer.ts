import type { CodeDefFact, ParsedNotebook } from "../types/index.js";

interface RawDef {
  name: string;
  kind: "function" | "variable";
  raw: string;
}

function normalizeBody(raw: string, lineCommentToken: string): string {
  return raw
    .split("\n")
    .map((line) => {
      const idx = line.indexOf(lineCommentToken);
      return (idx >= 0 ? line.slice(0, idx) : line).trim();
    })
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPythonDefs(source: string): RawDef[] {
  const lines = source.split("\n");
  const results: RawDef[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const defMatch = line.match(/^def\s+(\w+)\s*\(/);
    if (defMatch) {
      const bodyLines = [line];
      i++;
      while (i < lines.length && (lines[i].trim() === "" || /^[ \t]/.test(lines[i]))) {
        bodyLines.push(lines[i]);
        i++;
      }
      results.push({ name: defMatch[1], kind: "function", raw: bodyLines.join("\n") });
      continue;
    }

    const assignMatch = line.match(/^(\w+)\s*=\s*(?!=)(.+)$/);
    if (assignMatch) {
      results.push({ name: assignMatch[1], kind: "variable", raw: line });
    }
    i++;
  }

  return results;
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return source.length - 1;
}

function extractScalaDefs(source: string): RawDef[] {
  const results: RawDef[] = [];

  const defBraceRe = /^def\s+(\w+)\s*\([^)]*\)(?:\s*:\s*[\w[\],\s.]+)?\s*=\s*\{/gm;
  let m: RegExpExecArray | null;
  const consumedRanges: Array<[number, number]> = [];
  while ((m = defBraceRe.exec(source))) {
    const openBraceIdx = m.index + m[0].length - 1;
    const closeBraceIdx = findMatchingBrace(source, openBraceIdx);
    results.push({ name: m[1], kind: "function", raw: source.slice(m.index, closeBraceIdx + 1) });
    consumedRanges.push([m.index, closeBraceIdx]);
  }

  const withinConsumed = (idx: number) => consumedRanges.some(([s, e]) => idx >= s && idx <= e);

  const defLineRe = /^def\s+(\w+)\s*\([^)]*\)(?:\s*:\s*[\w[\],\s.]+)?\s*=\s*(.+)$/gm;
  while ((m = defLineRe.exec(source))) {
    if (withinConsumed(m.index)) continue;
    results.push({ name: m[1], kind: "function", raw: m[0] });
  }

  const valVarRe = /^(?:val|var)\s+(\w+)\s*(?::\s*[\w[\],\s.]+)?=\s*(.+)$/gm;
  while ((m = valVarRe.exec(source))) {
    if (withinConsumed(m.index)) continue;
    results.push({ name: m[1], kind: "variable", raw: m[0] });
  }

  return results;
}

export function extractCodeDefs(parsed: ParsedNotebook): CodeDefFact[] {
  const facts: CodeDefFact[] = [];

  for (const cell of parsed.cells) {
    if (cell.language === "python") {
      for (const def of extractPythonDefs(cell.source)) {
        facts.push({
          name: def.name,
          kind: def.kind,
          notebookPath: parsed.path,
          cellIndex: cell.index,
          normalizedBody: normalizeBody(def.raw, "#"),
          rawSource: def.raw
        });
      }
    } else if (cell.language === "scala") {
      for (const def of extractScalaDefs(cell.source)) {
        facts.push({
          name: def.name,
          kind: def.kind,
          notebookPath: parsed.path,
          cellIndex: cell.index,
          normalizedBody: normalizeBody(def.raw, "//"),
          rawSource: def.raw
        });
      }
    }
  }

  return facts;
}
