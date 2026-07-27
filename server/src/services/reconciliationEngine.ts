import type {
  CodeDefFact,
  NotebookFacts,
  NotebookGroup,
  ParsedNotebook,
  ReconciliationError,
  SqlLogicFact
} from "../types/index.js";
import { extractCodeDefs } from "./codeAnalyzer.js";
import { extractSqlFacts } from "./sqlAnalyzer.js";

export function buildNotebookFacts(parsed: ParsedNotebook): NotebookFacts {
  return {
    path: parsed.path,
    sqlFacts: extractSqlFacts(parsed),
    codeDefs: extractCodeDefs(parsed)
  };
}

export function snippet(raw: string, maxLen = 400): string {
  return raw.length > maxLen ? `${raw.slice(0, maxLen)}\n...` : raw;
}

function factPairKey(a: SqlLogicFact, b: SqlLogicFact): string {
  return [a.notebookPath, a.cellIndex, b.notebookPath, b.cellIndex].join("|");
}

function compareSqlFacts(
  groupId: string,
  allFacts: SqlLogicFact[]
): ReconciliationError[] {
  const errors: ReconciliationError[] = [];
  const flaggedPairs = new Set<string>();
  let counter = 0;

  const byMetric = new Map<string, SqlLogicFact[]>();
  for (const fact of allFacts) {
    const list = byMetric.get(fact.metricName) ?? [];
    list.push(fact);
    byMetric.set(fact.metricName, list);
  }

  for (const [metricName, facts] of byMetric.entries()) {
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const a = facts[i];
        const b = facts[j];
        if (a.notebookPath === b.notebookPath) continue;
        if (a.normalizedStructure === b.normalizedStructure) continue;

        flaggedPairs.add(factPairKey(a, b));
        counter++;
        errors.push({
          id: `${groupId}-sql-${counter}`,
          groupId,
          type: "sql-logic-mismatch",
          key: metricName,
          description: `SQL logic for "${metricName}" differs between ${a.notebookPath} (cell ${a.cellIndex}) and ${b.notebookPath} (cell ${b.cellIndex}).`,
          left: { notebookPath: a.notebookPath, cellIndex: a.cellIndex, snippet: snippet(a.rawSql) },
          right: { notebookPath: b.notebookPath, cellIndex: b.cellIndex, snippet: snippet(b.rawSql) }
        });
      }
    }
  }

  const byTableSet = new Map<string, SqlLogicFact[]>();
  for (const fact of allFacts) {
    if (fact.tables.length === 0) continue;
    const key = [...fact.tables].sort().join(",");
    const list = byTableSet.get(key) ?? [];
    list.push(fact);
    byTableSet.set(key, list);
  }

  for (const [tableKey, facts] of byTableSet.entries()) {
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const a = facts[i];
        const b = facts[j];
        if (a.notebookPath === b.notebookPath) continue;
        if (a.normalizedStructure === b.normalizedStructure) continue;
        if (flaggedPairs.has(factPairKey(a, b))) continue;

        flaggedPairs.add(factPairKey(a, b));
        counter++;
        errors.push({
          id: `${groupId}-sql-${counter}`,
          groupId,
          type: "sql-logic-mismatch",
          key: tableKey,
          description: `Queries against table(s) "${tableKey}" differ between ${a.notebookPath} (cell ${a.cellIndex}) and ${b.notebookPath} (cell ${b.cellIndex}).`,
          left: { notebookPath: a.notebookPath, cellIndex: a.cellIndex, snippet: snippet(a.rawSql) },
          right: { notebookPath: b.notebookPath, cellIndex: b.cellIndex, snippet: snippet(b.rawSql) }
        });
      }
    }
  }

  return errors;
}

function compareCodeDefs(groupId: string, allDefs: CodeDefFact[]): ReconciliationError[] {
  const errors: ReconciliationError[] = [];
  let counter = 0;

  const byName = new Map<string, CodeDefFact[]>();
  for (const def of allDefs) {
    const list = byName.get(def.name) ?? [];
    list.push(def);
    byName.set(def.name, list);
  }

  for (const [name, defs] of byName.entries()) {
    for (let i = 0; i < defs.length; i++) {
      for (let j = i + 1; j < defs.length; j++) {
        const a = defs[i];
        const b = defs[j];
        if (a.notebookPath === b.notebookPath) continue;
        if (a.normalizedBody === b.normalizedBody) continue;

        counter++;
        errors.push({
          id: `${groupId}-code-${counter}`,
          groupId,
          type: "code-def-mismatch",
          key: name,
          description: `${a.kind === "function" ? "Function" : "Variable"} "${name}" is defined differently in ${a.notebookPath} (cell ${a.cellIndex}) vs ${b.notebookPath} (cell ${b.cellIndex}).`,
          left: { notebookPath: a.notebookPath, cellIndex: a.cellIndex, snippet: snippet(a.rawSource) },
          right: { notebookPath: b.notebookPath, cellIndex: b.cellIndex, snippet: snippet(b.rawSource) }
        });
      }
    }
  }

  return errors;
}

export function reconcileGroup(group: NotebookGroup, factsByPath: Map<string, NotebookFacts>): ReconciliationError[] {
  const relevantFacts = group.notebookPaths
    .map((path) => factsByPath.get(path))
    .filter((f): f is NotebookFacts => f !== undefined);

  if (relevantFacts.length < 2) return [];

  const allSqlFacts = relevantFacts.flatMap((f) => f.sqlFacts);
  const allCodeDefs = relevantFacts.flatMap((f) => f.codeDefs);

  return [...compareSqlFacts(group.id, allSqlFacts), ...compareCodeDefs(group.id, allCodeDefs)];
}
