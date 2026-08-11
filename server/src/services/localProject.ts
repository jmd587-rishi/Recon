import type {
  CodeCandidate,
  LayerRef,
  LocalFileSummary,
  LocalScanResult,
  LocalSkippedFile,
  LocalSqlFileInput,
  LocalTableRef,
  NotebookCorrection,
  Table
} from "../types/index.js";
import { codeFileKind, readCodeFile } from "./codeFiles.js";
import { layerHasTable } from "./layers.js";
import { applySqlCorrections, correctedSqlFilename, type SqlStatement } from "./sqlFileParser.js";
import {
  buildLineageGraph,
  isTempTable,
  resolveTempTableSources,
  splitSqlTablesByOp,
  type LineageFact
} from "./tableLineage.js";

// Roughly the prompt budget the Databricks governance flow uses (governanceAnalysis.ts) — kept local
// so nothing on this path pulls in the Databricks client, which local analysis never needs. The
// per-snippet cap is larger than the notebook flow's because a statement here can be a whole stored
// procedure, and truncating one at 4 KB would cut off the `SELECT ... INTO` that says what it writes.
// `MAX_TOTAL_CHARS` is what actually bounds the request: 40 procedure-sized snippets would otherwise
// be far more than one prompt should carry.
const MAX_SNIPPET_CHARS = 16000;
const MAX_TOTAL_SNIPPETS = 40;
const MAX_TOTAL_CHARS = 80000;

export interface ParsedLocalFile {
  /** Path relative to the uploaded folder. */
  path: string;
  /** The file exactly as uploaded — corrections are spliced back into this. */
  content: string;
  statements: SqlStatement[];
  /** One fact per statement, `cellIndex` being the statement's ordinal in the file. */
  facts: LineageFact[];
  /**
   * Whether a corrected statement can be written back into this file. Only a `.sql` file carries the
   * byte spans that makes the splice exact; a notebook's fixes are shown but not applied to the file.
   */
  spliceable: boolean;
}

export interface LocalProject {
  folderName: string;
  files: ParsedLocalFile[];
  facts: LineageFact[];
  /** Precomputed so a re-render can ask for the scan again without re-parsing. */
  scan: LocalScanResult;
}

export interface LocalHop {
  from: LayerRef;
  to: LayerRef;
}

/** `main.silver.orders` -> silver/orders, `silver.orders` -> silver/orders, `orders` -> null/orders. */
export function splitQualifiedTable(ref: string): { schema: string | null; name: string } {
  const parts = ref.split(".").filter((p) => p.length > 0);
  const name = parts[parts.length - 1] ?? ref;
  const schema = parts.length >= 2 ? parts[parts.length - 2] : null;
  return { schema, name };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * The schema a file's folder implies, e.g. `src/datamart/Tables/fact_arr.sql` -> `datamart`.
 *
 * Database projects exported from SQL Server / SSDT lay out one folder per schema with `Tables/`,
 * `Views/` and `Stored Procedures/` underneath, so the folder often names the schema more reliably
 * than the SQL does — plenty of scripts inside such a folder write their table unqualified, trusting
 * the deployment context to place it. Only folders naming a schema the SQL *itself* uses somewhere
 * count, so an arbitrary directory name can never invent a layer that isn't in the project.
 */
function schemaFromPath(path: string, knownSchemas: Set<string>): string | null {
  const folders = path.split("/").slice(0, -1);
  for (let i = folders.length - 1; i >= 0; i--) {
    const candidate = folders[i].toLowerCase();
    if (knownSchemas.has(candidate)) return candidate;
  }
  return null;
}

/** Qualifies a target the SQL left bare with the schema its folder implies; leaves the rest alone. */
function qualifyTargetByPath(fact: LineageFact, knownSchemas: Set<string>): LineageFact {
  const target = fact.targetTable;
  if (!target || isTempTable(target) || splitQualifiedTable(target).schema !== null) return fact;
  const schema = schemaFromPath(fact.notebookPath, knownSchemas);
  return schema ? { ...fact, targetTable: `${schema}.${target}` } : fact;
}

/**
 * Parses every uploaded SQL file into statements and lineage facts.
 *
 * The whole-pipeline lineage graph is built with the *same* `buildLineageGraph` the Databricks flow
 * uses, but its `tableIndex` is derived from the SQL itself rather than from Unity Catalog — there
 * is no catalog to consult here, so the set of tables the code mentions is the only definition of
 * "tables in this project" available.
 */
export function parseLocalProject(folderName: string, inputs: LocalSqlFileInput[]): LocalProject {
  const files: ParsedLocalFile[] = [];
  const skipped: LocalSkippedFile[] = [];

  for (const input of inputs) {
    const kind = codeFileKind(input.path);
    if (!kind) {
      skipped.push({ path: input.path, reason: "not a code file Recon can read" });
      continue;
    }

    const read = readCodeFile(input.path, input.content);
    if (!read) {
      skipped.push({ path: input.path, reason: kind === "sql" ? "no SQL statements found" : "no code cells found" });
      continue;
    }

    // A notebook's lineage is already resolved cell by cell by `extractLineageFacts`, which knows
    // `spark.sql()`, the DataFrame API and `%sql` cells. A SQL file's unit is the statement, so its
    // tables are split here.
    const facts: LineageFact[] =
      kind === "sql"
        ? resolveTempTableSources(
            read.statements.map((stmt) => {
              const { sourceTables, targetTable } = splitSqlTablesByOp(stmt.sql);
              return { notebookPath: input.path, cellIndex: stmt.index, sourceTables, targetTable, rawSql: stmt.sql };
            })
          )
        : read.facts;

    files.push({
      path: input.path,
      content: input.content,
      statements: read.statements,
      facts,
      spliceable: read.spliceable
    });
  }

  // Which schemas the project uses has to be settled before any folder-implied schema can be
  // trusted, so the qualified names the SQL states outright are collected first and then applied.
  const knownSchemas = new Set(
    files
      .flatMap((f) => f.facts)
      .flatMap((fact) => [...(fact.targetTable ? [fact.targetTable] : []), ...fact.sourceTables])
      .flatMap((ref) => {
        const schema = isTempTable(ref) ? null : splitQualifiedTable(ref).schema;
        return schema ? [schema.toLowerCase()] : [];
      })
  );
  for (const file of files) {
    file.facts = file.facts.map((fact) => qualifyTargetByPath(fact, knownSchemas));
  }

  return { folderName, files, facts: files.flatMap((f) => f.facts), scan: buildScanResult(folderName, files, skipped) };
}

/**
 * Derives the scan — tables, schemas, lineage graph and stats — from already-parsed files.
 *
 * Split out of `parseLocalProject` so `lineageOverrides.ts` can rebuild it after the user corrects
 * an edge, rather than keeping a second copy of these rules that could drift from this one.
 */
export function buildScanResult(
  folderName: string,
  files: ParsedLocalFile[],
  skipped: LocalSkippedFile[]
): LocalScanResult {
  const facts = files.flatMap((f) => f.facts);

  const tables = new Map<string, LocalTableRef>();
  const record = (qualified: string, role: "written" | "read") => {
    // Temp tables aren't project tables: they live for one script and `resolveTempTableSources` has
    // already redrawn the lineage that ran through them onto the real tables at either end.
    if (isTempTable(qualified)) return;
    const { schema, name } = splitQualifiedTable(qualified);
    const existing = tables.get(qualified) ?? { qualified, schema, name, written: false, read: false };
    existing[role] = true;
    tables.set(qualified, existing);
  };
  for (const fact of facts) {
    if (fact.targetTable) record(fact.targetTable, "written");
    for (const source of fact.sourceTables) record(source, "read");
  }

  // buildLineageGraph keys on the bare table name, so a name used in two schemas resolves to
  // whichever was seen last — harmless here, since the index only gates which edges are kept and
  // every table in the index came from this project's own SQL.
  const tableIndex = new Map<string, Table>();
  for (const ref of tables.values()) {
    tableIndex.set(ref.name, { name: ref.name, catalogName: "", schemaName: ref.schema ?? "" });
  }

  const lineage = buildLineageGraph(facts, tableIndex);

  const fileSummaries: LocalFileSummary[] = files.map((file) => ({
    path: file.path,
    statementCount: file.statements.length,
    bytes: Buffer.byteLength(file.content, "utf8"),
    writes: unique(file.facts.flatMap((f) => (f.targetTable && !isTempTable(f.targetTable) ? [f.targetTable] : []))),
    reads: unique(file.facts.flatMap((f) => f.sourceTables.filter((t) => !isTempTable(t))))
  }));

  const schemas = unique(
    Array.from(tables.values()).flatMap((t) => (t.schema ? [t.schema] : []))
  ).sort();

  return {
    folderName,
    files: fileSummaries,
    skipped,
    tables: Array.from(tables.values()).sort((a, b) => a.qualified.localeCompare(b.qualified)),
    schemas,
    lineage,
    stats: {
      fileCount: files.length,
      statementCount: files.reduce((n, f) => n + f.statements.length, 0),
      tableCount: tables.size,
      schemaCount: schemas.length,
      lineageEdgeCount: lineage.length
    }
  };
}

export interface LocalCandidateSelection {
  candidates: CodeCandidate[];
  /**
   * Keys of statements whose snippet was cut down to fit the prompt. A fix for one of these must not
   * be spliced back over the whole statement — the model never saw the tail it would overwrite.
   */
  partial: Set<string>;
  /** Whether the budget stopped some statements in scope from being reviewed at all. */
  truncated: boolean;
}

/** Identifies a statement across the candidate list and the fixes that come back for it. */
export function candidateKey(notebookPath: string, cellIndex: number): string {
  return `${notebookPath}#${cellIndex}`;
}

/** Whether a fact writes a table of `layer`, ignoring temp targets and statements that write nothing. */
function writesLayer(fact: LineageFact, layer: LayerRef): boolean {
  if (!fact.targetTable || isTempTable(fact.targetTable)) return false;
  return layerHasTable(layer, fact.targetTable);
}

/**
 * Picks the statements a governance review should look at. With a `hop`, that's every statement
 * writing a table in the target layer's schema — the file-level equivalent of "notebooks that write
 * the target layer" in `governanceAnalysis.gatherLevelTransformationCode`. Without one (the folder's
 * SQL never qualifies its tables, so no layers could be inferred), it's every statement, capped.
 *
 * A script that stages through temp tables before its real write is taken as a whole: those
 * statements carry the filters and joins that decide the target's row count, so reviewing only the
 * final `SELECT ... INTO` would hand the model the one statement where nothing much happens.
 */
export function selectLocalCandidates(project: LocalProject, hop: LocalHop | null): LocalCandidateSelection {
  const target = hop?.to ?? null;
  const candidates: CodeCandidate[] = [];
  const partial = new Set<string>();
  let truncated = false;
  let totalChars = 0;

  for (const file of project.files) {
    const buildsTargetLayer = target !== null && file.facts.some((fact) => writesLayer(fact, target));

    for (const fact of file.facts) {
      if (target !== null) {
        const staging = buildsTargetLayer && fact.targetTable !== null && isTempTable(fact.targetTable);
        if (!writesLayer(fact, target) && !staging) continue;
      }
      const snippet = fact.rawSql.slice(0, MAX_SNIPPET_CHARS);
      if (candidates.length >= MAX_TOTAL_SNIPPETS || totalChars + snippet.length > MAX_TOTAL_CHARS) {
        truncated = true;
        break;
      }
      totalChars += snippet.length;
      if (snippet.length < fact.rawSql.length) partial.add(candidateKey(file.path, fact.cellIndex));
      candidates.push({ notebookPath: file.path, cellIndex: fact.cellIndex, snippet });
    }
    if (truncated) break;
  }

  return { candidates, partial, truncated };
}

/**
 * Rebuilds each touched SQL file with its corrected statements spliced back in, so the download is
 * the whole file with the fixes applied even though only the changed statements went to the model.
 */
export function rebuildCorrectedFiles(
  project: LocalProject,
  correctionsByFile: Map<string, Map<number, string>>
): NotebookCorrection[] {
  return project.files
    // A notebook has no byte spans, so there is nothing to splice into: its fixes are reported but
    // the file is not rebuilt, rather than rebuilt wrongly.
    .filter((file) => file.spliceable && (correctionsByFile.get(file.path)?.size ?? 0) > 0)
    .map((file) => {
      const perStatement = correctionsByFile.get(file.path)!;
      return {
        notebookPath: file.path,
        filename: correctedSqlFilename(file.path),
        language: "SQL" as const,
        correctedSource: applySqlCorrections(file.content, file.statements, perStatement),
        changedCells: perStatement.size
      };
    });
}
