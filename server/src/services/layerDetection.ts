import type { LayerDetectionReport, LayerGroupingKind, LayerRef } from "../types/index.js";
import { detectLayers } from "./layers.js";
import {
  detectPipelineLayers,
  LlmConfigError,
  LlmTimeoutError,
  type LayerGroupingEvidence
} from "./llmClient.js";
import { splitQualifiedTable, type LocalProject } from "./localProject.js";
import { isTempTable, type LineageFact } from "./tableLineage.js";

/**
 * Working out what this project's pipeline layers are, by reading it rather than by recognising its
 * schema names.
 *
 * `layers.ts` answers the same question from the names alone and answers it well for a project that
 * follows a convention it knows. It has nothing to say about a project whose schemas are named after
 * its business — `arr`, `prep`, `optum` — and, worse, nothing to say at all about a project that
 * doesn't stage by schema in the first place.
 *
 * That second case is the one that drove this. A project can write every derived table into a single
 * `refined` schema and separate its stages by *source folder* instead (`Prep/`, `Mart/`, `ARR/`).
 * Grouped by schema that pipeline has one real layer holding fourteen tables across six dependency
 * levels, and its whole reconciliation collapses into a single hop. Grouped by folder it has three.
 * So a grouping is a candidate, not a given: this module builds every candidate the project supports,
 * derives the dependency graph and the balance of each, and picks — or has the model pick — between
 * them.
 *
 * The division of labour is deliberate:
 *
 * - The **dependency graph** and the **balance** of a grouping are derived here, from the SQL. Which
 *   group is built by reading which is not a matter of opinion, and neither is how lopsided a
 *   grouping is. Together they are the whole answer for `--no-ai`.
 * - **What a group is for**, and which candidate grouping actually describes the pipeline, is a
 *   reading, and goes to the model. It is given both candidates with their graphs and is told the
 *   order has to respect whichever it picks, so what it contributes is meaning, not order.
 *
 * Everything the model returns is checked back against the real groups before it is used.
 */

/** Table names are the strongest single signal about a group, but a wide one shouldn't eat the prompt. */
const MAX_TABLES_PER_GROUP = 40;
/** Two statements per group is enough to show what it does to its data; more is repetition. */
const MAX_SAMPLES_PER_GROUP = 2;
const MAX_SAMPLE_CHARS = 1500;
const MAX_TOTAL_SAMPLE_CHARS = 30000;
/**
 * Above this, a folder level is organising something other than pipeline stages — one folder per
 * table, or per team — and proposing it as a layering would be noise.
 */
const MAX_FOLDER_GROUPS = 12;
/**
 * How much more even a grouping has to be before it displaces the schema one. Schemas are the
 * conventional answer and stay the default; folders have to earn it by actually separating the
 * pipeline the schemas ran together.
 */
const CONCENTRATION_MARGIN = 0.1;

/** The schema a table sits in, lowercased, or null for temp tables and unqualified names. */
function schemaOf(ref: string): string | null {
  if (isTempTable(ref)) return null;
  const schema = splitQualifiedTable(ref).schema;
  return schema ? schema.toLowerCase() : null;
}

export interface GroupEdge {
  from: string;
  to: string;
  edges: number;
}

/**
 * Collapses table-level lineage into weighted group-to-group edges, dropping self-references and
 * anything either end of which the grouping doesn't place.
 */
export function groupEdges(facts: LineageFact[], groupOf: (table: string) => string | null): GroupEdge[] {
  const counts = new Map<string, number>();
  for (const fact of facts) {
    if (!fact.targetTable) continue;
    const to = groupOf(fact.targetTable);
    if (!to) continue;
    for (const source of fact.sourceTables) {
      const from = groupOf(source);
      if (!from || from === to) continue;
      const key = `${from}->${to}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries()).map(([key, edges]) => {
    const [from, to] = key.split("->");
    return { from, to, edges };
  });
}

/** Lineage edges that stay inside one group — the ones a layering at this grouping cannot see. */
function innerEdgeCount(facts: LineageFact[], groupOf: (table: string) => string | null): number {
  let inner = 0;
  for (const fact of facts) {
    if (!fact.targetTable) continue;
    const to = groupOf(fact.targetTable);
    if (!to) continue;
    for (const source of fact.sourceTables) {
      if (groupOf(source) === to && source.toLowerCase() !== fact.targetTable.toLowerCase()) inner++;
    }
  }
  return inner;
}

/**
 * Longest path to each group through the dependency graph — 0 for a group nothing in the project
 * feeds.
 *
 * Relaxation rather than a topological sort because a real project's graph is not guaranteed acyclic:
 * a serving table joined back to a lookup that a later job rebuilds closes a loop. Two things keep a
 * cycle from running away — the pass count, and the cap at `names.length - 1`, which is the longest
 * path any acyclic graph of this size can have and so never binds on one that is. A cycle's members
 * end up level with each other, which is the honest answer: nothing orders them.
 */
export function groupDepths(names: string[], edges: GroupEdge[]): Map<string, number> {
  const depth = new Map(names.map((n) => [n, 0]));
  const ceiling = Math.max(0, names.length - 1);

  for (let pass = 0; pass < names.length; pass++) {
    let changed = false;
    for (const edge of edges) {
      if (!depth.has(edge.from) || !depth.has(edge.to)) continue;
      const next = Math.min(depth.get(edge.from)! + 1, ceiling);
      if (next > depth.get(edge.to)!) {
        depth.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return depth;
}

export interface LayerGroup {
  /** The group's name — a schema qualifier, or a source folder. */
  name: string;
  /** The group's tables, qualified and lowercased. */
  tables: string[];
  /** Tables read here that no statement in the project writes — inputs arriving from outside. */
  externalTableCount: number;
}

export interface LayerGrouping {
  kind: LayerGroupingKind;
  groups: LayerGroup[];
  edges: GroupEdge[];
  depth: Map<string, number>;
  /** Group names in dependency order, most-raw first. */
  derivedOrder: string[];
  /** Lineage edges that cross groups, and those that stay inside one. */
  crossEdges: number;
  innerEdges: number;
  /**
   * The largest group's share of the tables this grouping places, 0..1.
   *
   * The single number that says whether a grouping is a layering at all. A project with one schema
   * holding fourteen of its fifteen tables scores 0.93 by schema: technically a partition, but it
   * separates nothing, and every check derived from it lands in one hop.
   */
  concentration: number;
}

/** Which group each table belongs to, for a grouping already built. */
function lookup(grouping: LayerGrouping): (table: string) => string | null {
  const index = new Map<string, string>();
  for (const group of grouping.groups) {
    for (const table of group.tables) index.set(table.toLowerCase(), group.name);
  }
  return (table) => index.get(table.toLowerCase()) ?? null;
}

/** Assembles a grouping from a table -> group-name assignment, deriving everything else from it. */
function buildGrouping(
  kind: LayerGroupingKind,
  project: LocalProject,
  assign: (table: { qualified: string; schema: string | null; written: boolean }) => string | null
): LayerGrouping | null {
  const groups = new Map<string, LayerGroup>();
  const groupOfTable = new Map<string, string>();

  for (const table of project.scan.tables) {
    const name = assign(table);
    if (!name) continue;
    const group = groups.get(name) ?? { name, tables: [], externalTableCount: 0 };
    group.tables.push(table.qualified);
    if (!table.written) group.externalTableCount++;
    groups.set(name, group);
    groupOfTable.set(table.qualified.toLowerCase(), name);
  }

  if (groups.size < 2) return null;

  const groupOf = (table: string) => groupOfTable.get(table.toLowerCase()) ?? null;
  const names = Array.from(groups.keys());
  const edges = groupEdges(project.facts, groupOf);
  const depth = groupDepths(names, edges);
  const placed = Array.from(groups.values()).reduce((n, g) => n + g.tables.length, 0);

  return {
    kind,
    groups: Array.from(groups.values()),
    edges,
    depth,
    derivedOrder: [...names].sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0) || a.localeCompare(b)),
    crossEdges: edges.reduce((n, e) => n + e.edges, 0),
    innerEdges: innerEdgeCount(project.facts, groupOf),
    concentration: placed === 0 ? 1 : Math.max(...Array.from(groups.values(), (g) => g.tables.length)) / placed
  };
}

/**
 * The path level whose folder names partition this project — the first one with more than a single
 * distinct value.
 *
 * Both layouts this tool sees put their stages at a different depth: an SSDT export nests them under
 * a common `src/` (`src/raw/Tables/x.sql`), while a folder-per-stage project puts them at the top
 * (`ARR/1_monthly_revenue.sql`). Taking the first level that actually distinguishes anything handles
 * both without either being special-cased, and a flat folder of `.sql` files is left with no level at
 * all, which is correct — it has no folder structure to read.
 */
export function folderLevel(paths: string[]): number | null {
  const depths = paths.map((p) => p.split("/").length - 1);
  const maxDepth = Math.max(0, ...depths);

  for (let level = 0; level < maxDepth; level++) {
    const values = new Set(paths.map((p) => folderAt(p, level)));
    if (values.size > 1) return level;
  }
  return null;
}

/** The folder naming `path` at `level`, or `(root)` for a file that sits above that level. */
function folderAt(path: string, level: number): string {
  const parts = path.split("/");
  return parts.length - 1 > level ? parts[level] : "(root)";
}

export interface LayerEvidence {
  /** Every grouping this project supports, schema first. Never empty when it has two-plus schemas. */
  groupings: LayerGrouping[];
  /** The grouping the derived rules prefer — what `--no-ai` uses, and the model's default. */
  preferred: LayerGrouping | null;
  /** A statement or two per group, tagged with both groupings so the two can be compared. */
  samples: { schema: string; folder: string; path: string; builds: string; sql: string }[];
}

/**
 * Every candidate layering of this project, and which one the SQL alone prefers.
 *
 * Built whether or not the model will be called: the preferred grouping is the no-AI answer, and the
 * prompt is rendered from this same structure, so the two can never disagree about the facts.
 */
export function buildLayerEvidence(project: LocalProject): LayerEvidence {
  const groupings: LayerGrouping[] = [];

  const bySchema = buildGrouping("schema", project, (t) => (t.schema ? t.schema.toLowerCase() : null));
  if (bySchema) groupings.push(bySchema);

  // A table's folder is the folder of the file that *builds* it. A table the project only reads has
  // no folder and joins no group, which is right: it arrives from outside the pipeline.
  const writerPaths = project.files.filter((f) => f.facts.some((fact) => fact.targetTable !== null));
  const level = folderLevel(writerPaths.map((f) => f.path));
  const folderOfTable = new Map<string, string>();
  if (level !== null) {
    for (const file of writerPaths) {
      for (const fact of file.facts) {
        if (fact.targetTable && !isTempTable(fact.targetTable)) {
          folderOfTable.set(fact.targetTable.toLowerCase(), folderAt(file.path, level));
        }
      }
    }
    const byFolder = buildGrouping("folder", project, (t) => folderOfTable.get(t.qualified.toLowerCase()) ?? null);
    if (byFolder && byFolder.groups.length <= MAX_FOLDER_GROUPS) groupings.push(byFolder);
  }

  return {
    groupings,
    preferred: preferredGrouping(groupings),
    samples: collectSamples(project, groupings, folderOfTable)
  };
}

/**
 * The grouping to use when nobody is reading the code — the most even one.
 *
 * Evenness rather than edge counts, because edge counts reward the wrong thing here: folding a whole
 * chain into one group *removes* cross-group edges, so the most lopsided grouping can also be the one
 * with the cleanest-looking graph. What actually disqualifies a grouping is that one group holds
 * nearly everything, and `concentration` is exactly that. Schemas win ties, and near-ties, because
 * they are the conventional answer and the one a reader expects.
 */
export function preferredGrouping(groupings: LayerGrouping[]): LayerGrouping | null {
  const schema = groupings.find((g) => g.kind === "schema") ?? null;
  let best = schema ?? groupings[0] ?? null;
  if (!best) return null;

  for (const candidate of groupings) {
    if (candidate === best) continue;
    if (candidate.concentration < best.concentration - CONCENTRATION_MARGIN) best = candidate;
  }
  return best;
}

/**
 * A statement or two per group, picked for how much they say rather than for where they sit in the
 * folder: the statement reading the most tables is the one that shows the joins, the filters and the
 * shape of what the group holds. A statement reading nothing is a bare `CREATE TABLE`, which the
 * table list already covers.
 *
 * Sampled over the *finest* grouping available so that neither candidate is under-represented, and
 * tagged with both, so the model can see which schema and which folder each statement belongs to
 * rather than being asked to take the correspondence on trust.
 */
function collectSamples(
  project: LocalProject,
  groupings: LayerGrouping[],
  folderOfTable: Map<string, string>
): { schema: string; folder: string; path: string; builds: string; sql: string }[] {
  const finest = groupings.reduce<LayerGrouping | null>(
    (best, g) => (best === null || g.groups.length > best.groups.length ? g : best),
    null
  );
  if (!finest) return [];

  const groupOf = lookup(finest);
  const samples: { schema: string; folder: string; path: string; builds: string; sql: string }[] = [];
  let totalChars = 0;

  for (const group of finest.groups) {
    const candidates = project.files
      .flatMap((file) => file.facts.map((fact) => ({ file, fact })))
      .filter(({ fact }) => fact.targetTable !== null && groupOf(fact.targetTable) === group.name)
      .sort((a, b) => b.fact.sourceTables.length - a.fact.sourceTables.length);

    for (const { file, fact } of candidates.slice(0, MAX_SAMPLES_PER_GROUP)) {
      const sql = fact.rawSql.slice(0, MAX_SAMPLE_CHARS);
      if (totalChars + sql.length > MAX_TOTAL_SAMPLE_CHARS) return samples;
      totalChars += sql.length;
      samples.push({
        schema: schemaOf(fact.targetTable!) ?? "(unqualified)",
        folder: folderOfTable.get(fact.targetTable!.toLowerCase()) ?? "(none)",
        path: file.path,
        builds: fact.targetTable!,
        sql
      });
    }
  }

  return samples;
}

/** The grouping evidence as the prompt needs it — the derived facts, nothing interpreted. */
function groupingEvidence(grouping: LayerGrouping): LayerGroupingEvidence {
  const byWeight = (a: { edges: number }, b: { edges: number }) => b.edges - a.edges;
  return {
    kind: grouping.kind,
    derivedOrder: grouping.derivedOrder,
    crossEdges: grouping.crossEdges,
    innerEdges: grouping.innerEdges,
    concentration: grouping.concentration,
    groups: grouping.groups.map((group) => ({
      name: group.name,
      tableCount: group.tables.length,
      tables: group.tables.slice(0, MAX_TABLES_PER_GROUP).map((t) => splitQualifiedTable(t).name),
      externalTableCount: group.externalTableCount,
      readsFrom: grouping.edges
        .filter((e) => e.to === group.name)
        .map((e) => ({ name: e.from, edges: e.edges }))
        .sort(byWeight),
      feeds: grouping.edges
        .filter((e) => e.from === group.name)
        .map((e) => ({ name: e.to, edges: e.edges }))
        .sort(byWeight),
      depth: grouping.depth.get(group.name) ?? 0
    }))
  };
}

/**
 * Turns a group into a layer.
 *
 * A schema group becomes a layer defined by its schema, as it always has. A folder group becomes one
 * defined by its *tables*, because the folder is not a schema and nothing downstream could look it
 * up — the folder name survives only as the label the hop files and the report are named with.
 */
function layerFor(grouping: LayerGrouping, group: LayerGroup, role: LayerRef["role"]): LayerRef {
  return {
    label: group.name,
    schema: group.name,
    ...(grouping.kind === "folder" ? { tables: group.tables } : {}),
    ...(role ? { role } : {})
  };
}

/**
 * Keeps only what the project can back up. The model is told to spell the group names exactly as
 * given and mostly does, but "mostly" is not a basis for naming the file someone runs — a layer for a
 * group that isn't in the project would produce a hop with no tables and a query with no rows.
 */
function validateAnswer(
  answer: {
    grouping: LayerGroupingKind | null;
    layers: { name: string; role: LayerRef["role"] | null; reason: string }[];
    excluded: { name: string; reason: string }[];
  },
  evidence: LayerEvidence
): {
  grouping: LayerGrouping;
  layers: LayerRef[];
  reasons: Record<string, string>;
  excluded: { schema: string; reason: string }[];
  unplaced: string[];
  dropped: string[];
} | null {
  const grouping =
    evidence.groupings.find((g) => g.kind === answer.grouping) ?? evidence.preferred ?? evidence.groupings[0];
  if (!grouping) return null;

  const real = new Map(grouping.groups.map((g) => [g.name.toLowerCase(), g]));
  const layers: LayerRef[] = [];
  const reasons: Record<string, string> = {};
  const dropped: string[] = [];
  const taken = new Set<string>();

  for (const entry of answer.layers) {
    const group = real.get(entry.name.toLowerCase());
    if (!group) {
      dropped.push(entry.name);
      continue;
    }
    if (taken.has(group.name)) continue;
    taken.add(group.name);
    layers.push(layerFor(grouping, group, entry.role ?? undefined));
    if (entry.reason) reasons[group.name] = entry.reason;
  }

  const excluded = answer.excluded
    .flatMap((entry) => {
      const group = real.get(entry.name.toLowerCase());
      return group && !taken.has(group.name) ? [{ schema: group.name, reason: entry.reason }] : [];
    })
    .filter((entry, i, all) => all.findIndex((other) => other.schema === entry.schema) === i);

  const named = new Set([...taken, ...excluded.map((e) => e.schema)]);
  return {
    grouping,
    layers,
    reasons,
    excluded,
    unplaced: grouping.groups.map((g) => g.name).filter((name) => !named.has(name)),
    dropped
  };
}

/**
 * Whether the proposed order runs against the direction data actually flows, and which pairs say so.
 *
 * Reported rather than corrected. A back edge is sometimes real — a serving table joined back to a
 * reference table an earlier layer owns — and sometimes the sign that two layers are the wrong way
 * round, and only someone who knows the project can tell which. Silently reordering would hide the
 * one case where the person reading needs to look.
 */
function orderWarning(layers: LayerRef[], edges: GroupEdge[]): string | null {
  const position = new Map(layers.map((layer, i) => [layer.label.toLowerCase(), i]));
  const backwards = edges.filter((edge) => {
    const from = position.get(edge.from.toLowerCase());
    const to = position.get(edge.to.toLowerCase());
    return from !== undefined && to !== undefined && from > to;
  });

  if (backwards.length === 0) return null;
  const shown = backwards
    .slice(0, 3)
    .map((edge) => `${edge.from} -> ${edge.to}`)
    .join(", ");
  return (
    `${backwards.length} dependenc${backwards.length === 1 ? "y runs" : "ies run"} against this order ` +
    `(${shown}${backwards.length > 3 ? ", ..." : ""}) — the SQL builds the earlier layer by reading the later one. ` +
    "Check the order, or pass --layers if it is wrong."
  );
}

export interface DetectLayersOptions {
  /** False takes the derived path straight away — no call, no key needed. */
  useAi: boolean;
  onProgress?: (message: string) => void;
}

/**
 * The layers of a local project, most-raw first, from whichever source could answer.
 *
 * The order of preference is the order of how much of the project each one read: the model, which saw
 * the candidate groupings, the tables and the SQL; the keyword heuristic, which saw only the schema
 * names; the derived grouping, which saw the shape but cannot say what a group is for. Every fallback
 * sets `notice`, so a run that quietly stopped using the model still says it did.
 *
 * The derived path is last rather than never: a project whose schemas match no keyword used to come
 * back with no pipeline at all, and an order the SQL itself draws beats writing everything as one
 * undifferentiated scope.
 */
export async function detectProjectLayers(
  project: LocalProject,
  options: DetectLayersOptions
): Promise<LayerDetectionReport> {
  const evidence = buildLayerEvidence(project);

  const finish = (
    report: Omit<LayerDetectionReport, "warning">,
    edges: GroupEdge[]
  ): LayerDetectionReport => ({ ...report, warning: orderWarning(report.layers, edges) });

  const nothing: LayerDetectionReport = {
    layers: [],
    source: "keyword",
    grouping: "schema",
    reasons: {},
    excluded: [],
    unplaced: [],
    notice: null,
    warning: null
  };

  if (evidence.groupings.length === 0) return nothing;

  let notice: string | null = null;

  if (options.useAi) {
    options.onProgress?.(
      `Reading ${project.scan.tables.length} table(s) to work out the pipeline layers` +
        (evidence.groupings.length > 1 ? " — by schema, or by source folder" : "")
    );
    try {
      const answer = await detectPipelineLayers({
        projectName: project.folderName,
        groupings: evidence.groupings.map(groupingEvidence),
        preferred: evidence.preferred?.kind ?? null,
        samples: evidence.samples
      });
      const checked = validateAnswer(answer, evidence);
      if (checked && checked.layers.length > 0) {
        return finish(
          {
            layers: checked.layers,
            source: "ai",
            grouping: checked.grouping.kind,
            reasons: checked.reasons,
            excluded: checked.excluded,
            unplaced: checked.unplaced,
            notice:
              checked.dropped.length > 0
                ? `Ignored ${checked.dropped.length} layer(s) the model named that this project has no ${checked.grouping.kind} for: ${checked.dropped.join(", ")}.`
                : null
          },
          checked.grouping.edges
        );
      }
      // Each of these says only why the code wasn't read. Which fallback answered is `source`'s job,
      // and it isn't decided yet — a project the keyword list recognises and one it doesn't take
      // different paths from here.
      notice = "The reviewer model returned no usable layers, so these layers were not read from the code.";
    } catch (err) {
      notice =
        err instanceof LlmConfigError
          ? "Azure OpenAI isn't configured, so these layers were not read from the code. Set AZURE_OPENAI_* in server/.env, or pass --env-file when using the CLI, to have them read."
          : err instanceof LlmTimeoutError
            ? `The reviewer model didn't answer in time (${err.message}), so these layers were not read from the code.`
            : `Reading the layers out of the code failed (${err instanceof Error ? err.message : String(err)}).`;
    }
  }

  const preferred = evidence.preferred;
  if (!preferred) return { ...nothing, notice };

  // The keyword list only speaks about schemas, so it is consulted only when the schemas are also the
  // grouping the evidence prefers. On a project staged by folder its answer would be a different
  // pipeline from the one the rest of the run is about.
  if (preferred.kind === "schema") {
    const keyword = detectLayers(preferred.derivedOrder);
    if (keyword.length > 0) {
      const named = new Set(keyword.map((l) => l.schema));
      return finish(
        {
          layers: keyword,
          source: "keyword",
          grouping: "schema",
          reasons: {},
          excluded: [],
          unplaced: preferred.derivedOrder.filter((name) => !named.has(name)),
          notice
        },
        preferred.edges
      );
    }
  }

  // Nothing recognised the names. The grouping still knows what feeds what, and an ordering drawn
  // from the SQL is worth more than no pipeline at all.
  return finish(
    {
      layers: preferred.derivedOrder.map((name) =>
        layerFor(preferred, preferred.groups.find((g) => g.name === name)!, undefined)
      ),
      source: "lineage",
      grouping: preferred.kind,
      reasons: Object.fromEntries(
        preferred.groups.map((group) => [
          group.name,
          `Depth ${preferred.depth.get(group.name) ?? 0} in the ${preferred.kind} dependency graph, ${group.tables.length} table(s).`
        ])
      ),
      excluded: [],
      unplaced: [],
      notice
    },
    preferred.edges
  );
}
