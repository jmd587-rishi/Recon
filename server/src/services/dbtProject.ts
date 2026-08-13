import { isSqlFile } from "./sqlFileParser.js";
import { splitSqlTablesByOp } from "./tableLineage.js";

/**
 * Lineage read off the **file layout** instead of out of the SQL's own table names.
 *
 * Everywhere else in Recon a statement says what it writes — `CREATE TABLE datamart.fact_arr AS`,
 * `SELECT ... INTO stage.sales`, `INSERT INTO gold.orders` — and `tableLineage.splitSqlTablesByOp`
 * reads the answer out of the text. A dbt project says none of that. A model file is a bare
 * `SELECT`, the table it becomes is the *file's own name*, and what it reads is written
 * `{{ ref('stg_orders') }}` rather than as a table at all. Run through the ordinary path such a
 * project produces no target for any statement, no resolvable source for most, and therefore no
 * lineage, no hops and nothing to reconcile — the failure is total rather than partial, which is why
 * this is a separate reading rather than another dialect quirk.
 *
 * So for a dbt project the identity of a table is its file, and the edges are its `ref()`s. That is
 * the whole idea; everything below is the detail of doing it safely:
 *
 * - **The jinja is rendered, not stripped.** `{{ ref('stg_orders') }}` becomes `stg_orders` and
 *   `{{ source('raw','orders') }}` becomes `raw.orders`, so the statement handed to `sqlColumns.ts`,
 *   to `whereClauseAnalyzer.ts` and to the reviewer model is real SQL naming real tables. Stripping
 *   the tags instead would leave `select ... from` and every column report would say the columns
 *   could not be recovered. What cannot be resolved — `{{ var('x') }}`, a macro call — becomes
 *   `JINJA_PLACEHOLDER`, an identifier that parses in every position jinja can sit in and that is
 *   filtered back out of the lineage.
 * - **The implicit `CREATE TABLE … AS` is written out.** Resolving the convention means resolving all
 *   of it: dbt takes a file of bare `SELECT` and runs it as a create-table-as-select named after the
 *   file, and `renderedStatement` says so in the SQL. Without it every reader downstream would still
 *   be looking at a statement that declares nothing — `sqlColumns.ts` deliberately refuses to hand
 *   back a select list for a table the statement never claims to write, which is the right rule for a
 *   procedure staging through three temp tables and would leave a dbt project with no column list at
 *   all. It is a rendering, not an invention: the table, the columns and the reads are the model's own.
 * - **Only the first branch of an `{% if %}` survives.** Dropping the tags and keeping every branch
 *   would emit two contradictory versions of the same query as one statement. Keeping the first is
 *   right for the common case by a wide margin: `{% if is_incremental() %} where … {% endif %}` has
 *   no second branch at all.
 * - **Models are named bare — `stg_orders`, not `staging.stg_orders`.** Which schema a model lands in
 *   is decided at run time by the dbt profile's target, and a profile is not in the repository. The
 *   folder a model sits in is *not* that schema, so qualifying by folder would name a table that does
 *   not exist. Naming the model the way the code names it is honest, and the stage a model belongs to
 *   is recovered from the folder anyway — by `layerDetection.ts`, which already groups a project by
 *   the folder level that partitions it, which for the standard `models/staging`, `models/marts`
 *   layout is exactly the pipeline. An `alias` **is** applied, because that is the project stating
 *   outright what the table is called.
 *
 * Detection is per project but the treatment is per file: a folder is dbt-shaped when any `.sql` in
 * it calls `ref`, `source` or `config`, and within such a folder the models are the files that call
 * them plus everything under `models/`. `macros/`, `tests/` and `analyses/` are excluded, since a
 * macro body parsed as SQL invents tables the project has not got.
 */

/**
 * What an unresolvable `{{ … }}` leaves behind.
 *
 * A bare identifier rather than an empty string or `NULL`, because jinja appears in both positions a
 * SQL fragment can take: `{{ dbt_utils.surrogate_key(…) }} as customer_key` has to keep its alias for
 * the column to be seen at all, and `from {{ var('table') }}` has to leave something a parser
 * accepts. It is filtered out of the lineage by name, so it never becomes a table.
 */
export const JINJA_PLACEHOLDER = "jinja_expr";

/** The folder dbt keeps models in — the one path segment the convention actually fixes. */
const MODELS_DIR = "models";

/**
 * Top-level folders whose `.sql` builds nothing: a macro definition, a singular test, a scratch query.
 *
 * Matched against the *first* path segment only, which is where dbt puts them by default. Matching at
 * any depth would drop `src/warehouse/tests/*.sql` out of an SSDT project that happened to contain one
 * templated file, and those scripts are real.
 */
const NON_MODEL_DIRS = new Set(["macros", "tests", "analyses", "analysis"]);

/** What makes a folder dbt-shaped. `this` is left out on purpose — Airflow templates `{{ ds }}` too. */
const DBT_CALL_RE = /\{\{-?\s*(?:ref|source|config)\s*\(/;

export interface DbtModelFile {
  /** Path relative to the project root, as collected. */
  path: string;
  /** The model's name — how a `ref()` elsewhere addresses it. */
  name: string;
  /** The table it becomes: its `alias` where it declares one, otherwise its name. Lowercased. */
  table: string;
  /**
   * The statement dbt runs: the file's jinja resolved, wrapped in the `CREATE TABLE … AS` the
   * convention leaves implicit. This is what every reader downstream is given instead of the text.
   */
  rendered: string;
  /** Everything it reads: resolved `ref()`s and `source()`s, plus tables the SQL names outright. */
  sources: string[];
  /** `ref()` calls naming no model in this project — an installed package's, or a typo. */
  unresolvedRefs: string[];
}

export interface DbtProject {
  /** Model files by path: the ones whose lineage comes from the file rather than from the SQL. */
  models: Map<string, DbtModelFile>;
  /** `.sql` under a dbt project that defines no table, with why it was left out. */
  ignored: Map<string, string>;
  /** How many files carried dbt jinja — what the detection actually rests on. */
  jinjaFileCount: number;
}

/** What a project's lineage was read from, for the CLI to state rather than imply. */
export interface FileLineageSummary {
  /** The convention read. Only dbt so far; a second one would be named here beside it. */
  kind: "dbt";
  modelCount: number;
  jinjaFileCount: number;
  /** Distinct tables the models read, `ref()`d, `source()`d and named outright alike. */
  sourceCount: number;
  /** `ref()`s naming a model this folder hasn't got — installed packages, or a folder read in part. */
  unresolvedRefs: string[];
}

export interface DbtFileInput {
  path: string;
  content: string;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function lowerSegments(path: string): string[] {
  return path.toLowerCase().split("/");
}

/** `models/marts/fct_orders.sql` -> `fct_orders`. */
function baseName(path: string): string {
  const file = path.split("/").pop() ?? path;
  const dot = file.lastIndexOf(".");
  return (dot === -1 ? file : file.slice(0, dot)).trim();
}

// ---------------------------------------------------------------------------
// Jinja
// ---------------------------------------------------------------------------

type TagKind = "expr" | "stmt" | "comment";

interface JinjaTag {
  kind: TagKind;
  /** The text between the delimiters, whitespace-control dashes already trimmed off. */
  inner: string;
  start: number;
  end: number;
}

/**
 * The end of a `{{ … }}`, counting brace depth so a dict literal inside it (`config(meta={'a': 1})`)
 * doesn't close the tag early, and skipping quoted text so a `}}` inside a string doesn't either.
 */
function findExprEnd(text: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;

  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      if (depth > 0) depth--;
      else if (text[i + 1] === "}") return i + 2;
    }
  }
  return -1;
}

/** The end of a `{% … %}` or `{# … #}` — no nesting to track, but strings still hide the delimiter. */
function findTagEnd(text: string, from: number, close: string): number {
  let quote: string | null = null;

  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (text.startsWith(close, i)) return i + close.length;
  }
  return -1;
}

/** Every jinja tag in the file, in order. An unterminated tag ends the scan — the rest stays text. */
function scanJinja(text: string): JinjaTag[] {
  const tags: JinjaTag[] = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const marker = text[i + 1];
    if (marker !== "{" && marker !== "%" && marker !== "#") continue;

    const kind: TagKind = marker === "{" ? "expr" : marker === "%" ? "stmt" : "comment";
    const end =
      kind === "expr" ? findExprEnd(text, i + 2) : findTagEnd(text, i + 2, marker === "%" ? "%}" : "#}");
    if (end === -1) break;

    tags.push({
      kind,
      inner: text.slice(i + 2, end - 2).replace(/^-/, "").replace(/-$/, "").trim(),
      start: i,
      end
    });
    i = end - 1;
  }

  return tags;
}

/** The string literals of a jinja call, in order — `ref('pkg', 'orders')` -> ["pkg", "orders"]. */
function stringArgs(inner: string): string[] {
  return Array.from(inner.matchAll(/'([^']*)'|"([^"]*)"/g), (m) => m[1] ?? m[2]);
}

function firstWord(inner: string): string {
  return (/^[a-zA-Z_]+/.exec(inner)?.[0] ?? "").toLowerCase();
}

export interface RenderedModel {
  sql: string;
  /** Model names this file `ref()`s, in order of appearance, deduplicated. */
  refs: string[];
  /** `source()` calls resolved to `<source>.<table>`. */
  sources: string[];
}

/**
 * Resolves a model file's jinja into SQL.
 *
 * `resolveRef` maps a model name onto the table it becomes, which is the project's own index and not
 * something a single file can answer: `ref('stg_orders')` has to render as whatever `stg_orders.sql`
 * declared itself to be called.
 */
export function renderModelSql(
  text: string,
  resolveRef: (name: string) => string | null,
  selfTable: string | null
): RenderedModel {
  const tags = scanJinja(text);
  const refs: string[] = [];
  const sources: string[] = [];

  let out = "";
  let cursor = 0;
  let ifDepth = 0;
  /** The `{% if %}` nesting level whose branch is currently being dropped, or null. */
  let skippingFrom: number | null = null;

  for (const tag of tags) {
    if (skippingFrom === null) out += text.slice(cursor, tag.start);
    cursor = tag.end;

    if (tag.kind === "comment") continue;

    if (tag.kind === "stmt") {
      const keyword = firstWord(tag.inner);
      if (keyword === "if") {
        ifDepth++;
      } else if (keyword === "endif") {
        if (skippingFrom === ifDepth) skippingFrom = null;
        ifDepth = Math.max(0, ifDepth - 1);
      } else if ((keyword === "else" || keyword === "elif") && skippingFrom === null && ifDepth > 0) {
        skippingFrom = ifDepth;
      }
      // Every other statement tag — set, for, snapshot, macro — contributes no SQL of its own, and
      // dropping it keeps the body it wraps, which is the part that reads and writes tables.
      continue;
    }

    if (skippingFrom !== null) continue;

    const keyword = firstWord(tag.inner);
    if (keyword === "config") continue;

    if (keyword === "ref") {
      const args = stringArgs(tag.inner);
      // `ref('package', 'model')` and `ref('model', v=2)` both name the model in the last literal.
      const name = args[args.length - 1];
      if (!name) {
        out += JINJA_PLACEHOLDER;
        continue;
      }
      if (!refs.includes(name)) refs.push(name);
      out += resolveRef(name) ?? name.toLowerCase();
      continue;
    }

    if (keyword === "source") {
      const args = stringArgs(tag.inner);
      if (args.length >= 2) {
        const table = `${args[0]}.${args[1]}`.toLowerCase();
        if (!sources.includes(table)) sources.push(table);
        out += table;
      } else {
        out += JINJA_PLACEHOLDER;
      }
      continue;
    }

    // `{{ this }}` is the model itself; `{{ this.schema }}` is a property of it and not a table.
    out += tag.inner === "this" ? (selfTable ?? JINJA_PLACEHOLDER) : JINJA_PLACEHOLDER;
  }

  if (skippingFrom === null) out += text.slice(cursor);
  return { sql: out, refs, sources };
}

/**
 * A rendered model body as the statement dbt runs: the create-table-as-select the file leaves implicit.
 *
 * Always `CREATE TABLE`, whatever the `materialized` config says. The materialization decides what the
 * warehouse builds — a table, a view, an incremental merge — and none of that changes the model's
 * columns or what it reads, which is all any reader here is after. The leading comment is there so the
 * quoted SQL in a report or a prompt is never mistaken for something the user wrote.
 */
function renderedStatement(model: Omit<DbtModelFile, "sources" | "rendered">, body: string): string {
  return (
    `-- Recon: dbt model "${model.name}" from ${model.path}, with ref() and source() resolved.
` +
    `CREATE TABLE ${model.table} AS
${body.trim()}`
  );
}

// ---------------------------------------------------------------------------
// The project
// ---------------------------------------------------------------------------

/** The name a model addresses itself by, and the table it becomes — both readable file by file. */
function modelIdentity(path: string, text: string): { name: string; table: string } {
  let name = baseName(path);
  let alias: string | null = null;

  for (const tag of scanJinja(text)) {
    // `{% snapshot orders_snapshot %}` names the relation, not the file.
    if (tag.kind === "stmt" && firstWord(tag.inner) === "snapshot") {
      const declared = /^snapshot\s+([A-Za-z_]\w*)/.exec(tag.inner)?.[1];
      if (declared) name = declared;
    }
    if (tag.kind === "expr" && firstWord(tag.inner) === "config") {
      alias = /\balias\s*=\s*['"]([^'"]+)['"]/.exec(tag.inner)?.[1] ?? alias;
    }
  }

  return { name: name.toLowerCase(), table: (alias ?? name).toLowerCase() };
}

/**
 * Reads a folder as a dbt project, or returns null when it isn't one.
 *
 * Detection is deliberately narrow — a `ref`, `source` or `config` call in at least one `.sql` — and
 * the treatment is then applied per file rather than to the whole folder, so a single templated query
 * dropped into an SSDT project changes how that one file is read and nothing else.
 */
export function detectDbtProject(inputs: readonly DbtFileInput[]): DbtProject | null {
  const sqlFiles = inputs.filter((input) => isSqlFile(input.path.toLowerCase()));
  const jinjaFileCount = sqlFiles.filter((input) => DBT_CALL_RE.test(input.content)).length;
  if (jinjaFileCount === 0) return null;

  const hasModelsDir = sqlFiles.some((input) => lowerSegments(input.path).slice(0, -1).includes(MODELS_DIR));
  const ignored = new Map<string, string>();
  const candidates: DbtFileInput[] = [];

  for (const input of sqlFiles) {
    const folders = lowerSegments(input.path).slice(0, -1);

    // Left out rather than read plainly: a macro body run through the table extractor reports the
    // tables of whatever the macro happens to mention, which the project may not even have.
    if (folders.length > 0 && NON_MODEL_DIRS.has(folders[0])) {
      ignored.set(input.path, `dbt ${folders[0]}/ — defines no table`);
      continue;
    }

    if (DBT_CALL_RE.test(input.content) || (hasModelsDir && folders.includes(MODELS_DIR))) {
      candidates.push(input);
    }
  }

  if (candidates.length === 0) return null;

  // Names first, then bodies: `ref('stg_orders')` renders as whatever `stg_orders.sql` calls itself,
  // which is only known once every file has been looked at.
  const identities = new Map(candidates.map((input) => [input.path, modelIdentity(input.path, input.content)]));
  const tableOfModel = new Map<string, string>();
  for (const identity of identities.values()) tableOfModel.set(identity.name, identity.table);
  const resolveRef = (name: string) => tableOfModel.get(name.toLowerCase()) ?? null;

  const models = new Map<string, DbtModelFile>();
  for (const input of candidates) {
    const { name, table } = identities.get(input.path)!;
    const body = renderModelSql(input.content, resolveRef, table);
    const rendered = renderedStatement({ path: input.path, name, table, unresolvedRefs: [] }, body.sql);

    // A model reads what it `ref()`s and `source()`s, and also whatever its SQL names outright — a
    // dbt project is allowed to address a table directly, and that dependency is just as real. Read
    // off the rendered statement, so an incremental model's `{{ this }}` self-reference drops out with
    // every other mention of the target.
    const named = splitSqlTablesByOp(rendered).sourceTables;
    const sources = unique([
      ...body.refs.map((ref) => resolveRef(ref) ?? ref.toLowerCase()),
      ...body.sources,
      ...named
    ]).filter((source) => source !== table && source !== JINJA_PLACEHOLDER);

    models.set(input.path, {
      path: input.path,
      name,
      table,
      rendered,
      sources,
      unresolvedRefs: body.refs.filter((ref) => resolveRef(ref) === null)
    });
  }

  return { models, ignored, jinjaFileCount };
}

/** The one-line account of what was read, for the CLI to print and the project to carry. */
export function summarizeDbtProject(dbt: DbtProject): FileLineageSummary {
  const models = Array.from(dbt.models.values());
  return {
    kind: "dbt",
    modelCount: models.length,
    jinjaFileCount: dbt.jinjaFileCount,
    sourceCount: unique(models.flatMap((model) => model.sources)).length,
    unresolvedRefs: unique(models.flatMap((model) => model.unresolvedRefs)).sort()
  };
}
