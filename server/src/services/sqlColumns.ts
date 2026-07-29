import { stripSqlComments } from "./tableLineage.js";

/**
 * Recovers each table's column list from the SQL that builds it.
 *
 * `tableLineage.ts` answers *which* tables a statement reads and writes; this answers *what is in*
 * the table it writes, which is what a reconciliation script needs — you cannot sum an amount column
 * or anti-join on a key without knowing their names. There is no catalog behind an uploaded folder,
 * so the SQL text is the only description of a table that exists.
 *
 * Three sources, in descending order of authority:
 *   1. `CREATE TABLE t (...)` DDL — names, declared types, and PRIMARY KEY columns.
 *   2. the select list of the statement that builds the table (`SELECT ... INTO t`, CTAS,
 *      `INSERT INTO t SELECT ...`) — names only, since a `TRY_CONVERT(...) AS revenue` states no type.
 *   3. an `INSERT INTO t (a, b, c)` column list — names only.
 *
 * Hand-written rather than AST-based on purpose: node-sql-parser rejects real SQL Server DDL
 * (`[amount] [decimal](18, 2) NULL`, `CONSTRAINT ... PRIMARY KEY CLUSTERED`, `ON [PRIMARY]`,
 * `TEXTIMAGE_ON`) in all four dialects it knows, and an SSDT project is mostly that. The scanner
 * below only has to find identifiers at paren-depth 0, which survives dialect quirks the parsers
 * choke on.
 */

/** How far a `SELECT *` is followed through CTEs before giving up. */
const MAX_STAR_DEPTH = 6;
/** How many times the index re-runs to complete a `SELECT *` that pointed at another table. */
const MAX_COMPLETION_PASSES = 3;

export type ColumnKind = "numeric" | "date" | "text" | "boolean" | "other";

export interface ColumnInfo {
  /** Lowercased, unquoted. */
  name: string;
  /** Type exactly as declared (`decimal(18, 2)`), or null when only a select list named the column. */
  dataType: string | null;
  kind: ColumnKind;
  /** Declared part of a PRIMARY KEY. Only DDL can say this — a select list never does. */
  isDeclaredKey: boolean;
}

/** Which of the three extraction paths produced a table's columns. */
export type ColumnOrigin = "ddl" | "select" | "insert";

export interface TableColumns {
  table: string;
  columns: ColumnInfo[];
  origin: ColumnOrigin;
  /** A `SELECT *` that could not be expanded — the list is a subset of the table's real columns. */
  incomplete: boolean;
  /** Tables whose columns would complete the list, when a `*` pointed at one. */
  pending: string[];
}

export type ColumnIndex = Map<string, TableColumns>;

// ---- low-level scanning ----

const QUOTE_CLOSERS: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };

/** Index just past the quoted run opening at `i`, whose opening character is `sql[i]`. */
function skipQuoted(sql: string, i: number): number {
  const close = QUOTE_CLOSERS[sql[i]];
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === "\\") {
      j += 2;
      continue;
    }
    if (sql[j] === close) {
      // A doubled quote escapes itself (`'it''s'`); `]` has no such rule in T-SQL bracket quoting.
      if (close !== "]" && sql[j + 1] === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return sql.length;
}

interface Word {
  word: string;
  start: number;
  end: number;
}

/**
 * Every bare word sitting at paren-depth 0, lowercased. Quoted text and anything nested inside
 * parentheses is skipped, so the `SELECT` of a subquery or CTE body never masquerades as the
 * statement's own — which is the whole point: the outer query is the one that writes the table.
 */
function topLevelWords(sql: string): Word[] {
  const words: Word[] = [];
  let depth = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    if (QUOTE_CLOSERS[ch]) {
      i = skipQuoted(sql, i);
      continue;
    }
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i++;
      words.push({ word: sql.slice(start, i).toLowerCase(), start, end: i });
      continue;
    }
    i++;
  }

  return words;
}

/** Splits on `separator` occurrences at paren-depth 0, leaving quoted and nested text intact. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (QUOTE_CLOSERS[ch]) {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }

  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Text inside the parenthesis opening at `open`, plus the index just past its `)`. */
function parenContent(sql: string, open: number): { content: string; end: number } | null {
  let depth = 0;
  let i = open;
  while (i < sql.length) {
    const ch = sql[i];
    if (QUOTE_CLOSERS[ch]) {
      i = skipQuoted(sql, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return { content: sql.slice(open + 1, i), end: i + 1 };
    i++;
  }
  return null;
}

/** `[datamart].[Fact_ARR]` -> `datamart.fact_arr`. */
function cleanRef(ref: string): string {
  return ref.replace(/[`[\]"]/g, "").trim().toLowerCase();
}

/** The last dot-separated segment of a table reference: `main.silver.orders` -> `orders`. */
function bareName(ref: string): string {
  const parts = cleanRef(ref).split(".");
  return parts[parts.length - 1] ?? ref;
}

// ---- CTE bodies ----

const IDENT_RE = /^[\w.$#`[\]"]+/;

/**
 * Every `WITH x AS ( ... )` body in the statement, keyed by CTE name.
 *
 * The same shape `tableLineage.collectCteNames` recognises, but keeping the body text rather than
 * just the name: a `SELECT * INTO t FROM final_arr` says nothing about `t`'s columns until you read
 * what `final_arr` selects, and every table in a T-SQL warehouse project is built that way.
 */
export function collectCteBodies(sql: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const withRe = /\bwith\b/gi;
  let match: RegExpExecArray | null;

  while ((match = withRe.exec(sql))) {
    let i = match.index + match[0].length;

    for (;;) {
      while (i < sql.length && /\s/.test(sql[i])) i++;
      const name = IDENT_RE.exec(sql.slice(i));
      if (!name) break;
      i += name[0].length;

      while (i < sql.length && /\s/.test(sql[i])) i++;
      if (sql[i] === "(") {
        // optional explicit column list, e.g. `WITH totals (customer, amount) AS (...)`
        const columns = parenContent(sql, i);
        if (!columns) break;
        i = columns.end;
        while (i < sql.length && /\s/.test(sql[i])) i++;
      }

      if (!/^as\b/i.test(sql.slice(i))) break;
      i += 2;
      while (i < sql.length && /\s/.test(sql[i])) i++;
      if (sql[i] !== "(") break;

      const body = parenContent(sql, i);
      if (!body) break;
      bodies.set(cleanRef(name[0]), body.content);
      i = body.end;

      while (i < sql.length && /\s/.test(sql[i])) i++;
      if (sql[i] !== ",") break;
      i++;
    }
  }

  return bodies;
}

// ---- the select that writes the table ----

/** Words that follow FROM/JOIN but name no table, so they can't be mistaken for an alias. */
const NOT_AN_ALIAS = new Set([
  "on", "where", "group", "order", "having", "union", "inner", "left", "right", "full", "cross",
  "outer", "join", "apply", "with", "option", "into", "select", "and", "or", "as", "for", "except",
  "intersect", "pivot", "unpivot"
]);

interface WriteSelect {
  /** Raw text of the select list. */
  list: string;
  /** What the outer query selects FROM, when it names one — a CTE name or a table. */
  fromRef: string | null;
  /** Alias -> source, so `enriched.*` can be followed back to `enriched_revenue`. */
  aliases: Map<string, string>;
}

function stripSelectModifiers(list: string): string {
  return list
    .replace(/^\s*(?:all|distinct)\b/i, "")
    .replace(/^\s*top\s*(?:\(\s*\d+\s*\)|\d+)(?:\s+percent)?(?:\s+with\s+ties)?/i, "")
    .trim();
}

/**
 * Locates the select list that produces the written table, plus what it reads from.
 *
 * `targetTable` disambiguates the common T-SQL shape where one statement stages through several
 * `SELECT ... INTO #tmp` before its real write: the `INTO` naming the table we were asked about is
 * the one whose select list describes that table.
 */
function findWriteSelect(sql: string, targetTable: string | null): WriteSelect | null {
  const words = topLevelWords(sql);

  const intoWords = words.filter((w, i) => {
    if (w.word !== "into") return false;
    const previous = words[i - 1]?.word;
    return previous !== "insert" && previous !== "merge" && previous !== "bulk";
  });

  const wanted = targetTable ? bareName(targetTable) : null;
  const into =
    intoWords.find((w) => wanted !== null && bareName(IDENT_RE.exec(sql.slice(w.end).trimStart())?.[0] ?? "") === wanted) ??
    intoWords[intoWords.length - 1] ??
    null;

  const select = into
    ? [...words].reverse().find((w) => w.word === "select" && w.start < into.start)
    : words.find((w) => w.word === "select");
  if (!select) return null;

  const from = words.find((w) => w.word === "from" && w.start > (into?.start ?? select.start));
  const listEnd = into ? into.start : (from?.start ?? sql.length);
  if (listEnd <= select.end) return null;

  const aliases = new Map<string, string>();
  let fromRef: string | null = null;
  if (from) {
    const tail = sql.slice(from.start);
    const joinRe = /\b(?:from|join)\s+([\w.$#`[\]"]+)(?:\s+(?:as\s+)?([\w`[\]"]+))?/gi;
    let m: RegExpExecArray | null;
    while ((m = joinRe.exec(tail))) {
      const source = cleanRef(m[1]);
      if (fromRef === null) fromRef = source;
      const alias = m[2] ? cleanRef(m[2]) : null;
      if (alias && !NOT_AN_ALIAS.has(alias)) aliases.set(alias, source);
    }
  }

  return { list: stripSelectModifiers(sql.slice(select.end, listEnd)), fromRef, aliases };
}

/** The name a select-list item gives its column, or the `*` it expands from. */
function itemColumn(item: string): { name: string | null; star: string | null } {
  // Select lists in ETL SQL are laid out over many lines; only the tokens matter here.
  const text = item.replace(/\s+/g, " ").trim();
  if (text === "*") return { name: null, star: "*" };

  const qualifiedStar = /^([\w`[\]"]+)\s*\.\s*\*$/.exec(text);
  if (qualifiedStar) return { name: null, star: cleanRef(qualifiedStar[1]) };

  // The *last* top-level `AS` is the column's own alias — earlier ones belong to casts inside it.
  const parts = splitTopLevel(text, " ");
  const asAt = parts.map((p) => p.toLowerCase()).lastIndexOf("as");
  if (asAt >= 0 && parts[asAt + 1]) return { name: cleanRef(parts[asAt + 1]), star: null };

  if (/^[\w.`[\]"]+$/.test(text)) return { name: bareName(text), star: null };
  return { name: null, star: null };
}

interface SelectColumns {
  names: string[];
  incomplete: boolean;
  /** Real tables a `*` pointed at, which a later pass can expand once their columns are known. */
  pending: string[];
}

function selectListColumns(
  sql: string,
  targetTable: string | null,
  ctes: Map<string, string>,
  depth: number
): SelectColumns {
  const write = findWriteSelect(sql, targetTable);
  if (!write) return { names: [], incomplete: true, pending: [] };

  const names: string[] = [];
  const pending: string[] = [];
  let incomplete = false;

  for (const item of splitTopLevel(write.list, ",")) {
    const { name, star } = itemColumn(item);
    if (name) {
      names.push(name);
      continue;
    }
    if (!star) {
      // An expression nobody aliased — SQL Server names such a column only at runtime.
      incomplete = true;
      continue;
    }

    const ref = star === "*" ? write.fromRef : (write.aliases.get(star) ?? star);
    const body = ref ? ctes.get(bareName(ref)) : undefined;
    if (body && depth < MAX_STAR_DEPTH) {
      const expanded = selectListColumns(body, null, ctes, depth + 1);
      names.push(...expanded.names);
      pending.push(...expanded.pending);
      incomplete = incomplete || expanded.incomplete;
    } else {
      incomplete = true;
      if (ref) pending.push(ref);
    }
  }

  return { names: unique(names), incomplete, pending: unique(pending) };
}

// ---- DDL ----

const CREATE_TABLE_RE = /\bcreate\s+(?:or\s+(?:replace|alter)\s+)?(?:temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w.$#`[\]"]+)\s*\(/gi;
const TABLE_CONSTRAINT_RE = /^(?:constraint|primary\s+key|unique|foreign\s+key|check|index|period)\b/i;
const PRIMARY_KEY_RE = /\bprimary\s+key\b/i;

const NUMERIC_TYPES = new Set([
  "tinyint", "smallint", "int", "integer", "bigint", "decimal", "numeric", "number", "money",
  "smallmoney", "float", "real", "double", "dec", "long"
]);
const DATE_TYPES = new Set(["date", "datetime", "datetime2", "smalldatetime", "datetimeoffset", "timestamp", "time"]);
const TEXT_TYPES = new Set(["char", "nchar", "varchar", "nvarchar", "text", "ntext", "string", "uniqueidentifier"]);
const BOOLEAN_TYPES = new Set(["bit", "boolean", "bool"]);

/** Classifies a declared type, so an amount column can be told from a name column. */
export function kindOfType(dataType: string | null): ColumnKind {
  if (!dataType) return "other";
  const base = dataType.replace(/\(.*$/, "").trim().toLowerCase();
  if (NUMERIC_TYPES.has(base)) return "numeric";
  if (DATE_TYPES.has(base)) return "date";
  if (TEXT_TYPES.has(base)) return "text";
  if (BOOLEAN_TYPES.has(base)) return "boolean";
  return "other";
}

/** Reads the leading identifier of a column definition, bracket-quoted or bare. */
function leadingIdentifier(item: string): { name: string; end: number } | null {
  const text = item.trimStart();
  const offset = item.length - text.length;
  if (QUOTE_CLOSERS[text[0]] && text[0] !== "'") {
    const end = skipQuoted(text, 0);
    return { name: cleanRef(text.slice(0, end)), end: offset + end };
  }
  const bare = /^[A-Za-z_][\w$#@]*/.exec(text);
  return bare ? { name: bare[0].toLowerCase(), end: offset + bare[0].length } : null;
}

function ddlColumns(definitionList: string): ColumnInfo[] {
  const columns: ColumnInfo[] = [];
  const declaredKeys = new Set<string>();

  for (const item of splitTopLevel(definitionList, ",")) {
    if (TABLE_CONSTRAINT_RE.test(item)) {
      // `CONSTRAINT [PK_fact] PRIMARY KEY CLUSTERED ([arr_key] ASC)` — the parens hold the columns.
      if (!PRIMARY_KEY_RE.test(item) && !/^unique\b/i.test(item)) continue;
      const open = item.indexOf("(", item.search(PRIMARY_KEY_RE.test(item) ? /\bprimary\s+key\b/i : /\bunique\b/i));
      const group = open >= 0 ? parenContent(item, open) : null;
      if (!group) continue;
      for (const keyItem of splitTopLevel(group.content, ",")) {
        const key = leadingIdentifier(keyItem);
        if (key) declaredKeys.add(key.name);
      }
      continue;
    }

    const identifier = leadingIdentifier(item);
    if (!identifier) continue;

    const rest = item.slice(identifier.end).replace(/[`[\]"]/g, "").trimStart();
    const typeMatch = /^([A-Za-z_]\w*)\s*(\([^)]*\))?/.exec(rest);
    // `col AS <expression>` is a computed column: the word after the name is a keyword, not a type.
    const declared = typeMatch && !/^as$/i.test(typeMatch[1]) ? `${typeMatch[1].toLowerCase()}${typeMatch[2] ?? ""}` : null;

    columns.push({
      name: identifier.name,
      dataType: declared,
      kind: kindOfType(declared),
      isDeclaredKey: PRIMARY_KEY_RE.test(item)
    });
  }

  for (const column of columns) {
    if (declaredKeys.has(column.name)) column.isDeclaredKey = true;
  }
  return columns;
}

/** The `CREATE TABLE` definition list for `targetTable`, if this statement holds one. */
function findDdl(sql: string, targetTable: string | null): string | null {
  const wanted = targetTable ? bareName(targetTable) : null;
  CREATE_TABLE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CREATE_TABLE_RE.exec(sql))) {
    if (wanted !== null && bareName(match[1]) !== wanted) continue;
    const group = parenContent(sql, match.index + match[0].length - 1);
    // `CREATE TABLE t AS SELECT` has no definition list, just a query the select-list path handles.
    if (group && !/^\s*select\b/i.test(group.content)) return group.content;
  }
  return null;
}

const INSERT_COLUMNS_RE = /\binsert\s+(?:overwrite\s+)?(?:into\s+)?(?:table\s+)?([\w.$#`[\]"]+)\s*\(/i;

/** The `INSERT INTO t (a, b, c)` column list — only when every item is a plain identifier. */
function insertColumns(sql: string, targetTable: string | null): string[] | null {
  const match = INSERT_COLUMNS_RE.exec(sql);
  if (!match) return null;
  if (targetTable && bareName(match[1]) !== bareName(targetTable)) return null;

  const group = parenContent(sql, match.index + match[0].length - 1);
  if (!group) return null;

  const items = splitTopLevel(group.content, ",");
  if (items.length === 0) return null;
  if (!items.every((item) => /^[\w`[\]"]+$/.test(item.trim()))) return null;
  return items.map((item) => cleanRef(item));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function named(names: string[]): ColumnInfo[] {
  return names.map((name) => ({ name, dataType: null, kind: "other" as const, isDeclaredKey: false }));
}

/**
 * Columns for the table one statement builds, or null when the statement describes none.
 * `targetTable` is the table lineage resolved for the statement, which is what the result is keyed
 * on — the SQL may name it unqualified, or name several tables in one procedure.
 */
export function extractStatementColumns(sql: string, targetTable: string | null): TableColumns | null {
  const stripped = stripSqlComments(sql);
  const table = targetTable ? cleanRef(targetTable) : "";

  const ddl = findDdl(stripped, targetTable);
  if (ddl) {
    const columns = ddlColumns(ddl);
    if (columns.length > 0) return { table, columns, origin: "ddl", incomplete: false, pending: [] };
  }

  // Ahead of the select list: `INSERT INTO t (a, b, c) SELECT x, y, z` names the *target's* columns
  // in the parens and the source's in the query, and it's the target this is describing.
  const inserted = insertColumns(stripped, targetTable);
  if (inserted && inserted.length > 0) {
    return { table, columns: named(inserted), origin: "insert", incomplete: false, pending: [] };
  }

  const ctes = collectCteBodies(stripped);
  const selected = selectListColumns(stripped, targetTable, ctes, 0);
  if (selected.names.length > 0) {
    return {
      table,
      columns: named(selected.names),
      origin: "select",
      incomplete: selected.incomplete,
      pending: selected.pending
    };
  }

  // A `SELECT * INTO t FROM other_table` names no column of its own, but recording it lets a later
  // pass fill the list in from `other_table`. With nothing to point at there is nothing to record.
  if (selected.pending.length > 0) {
    return { table, columns: [], origin: "select", incomplete: true, pending: selected.pending };
  }
  return null;
}

const ORIGIN_RANK: Record<ColumnOrigin, number> = { ddl: 3, select: 2, insert: 1 };

/** Keeps whichever of two readings of the same table says more: DDL first, then the longer list. */
function better(a: TableColumns, b: TableColumns): TableColumns {
  if (ORIGIN_RANK[a.origin] !== ORIGIN_RANK[b.origin]) return ORIGIN_RANK[a.origin] > ORIGIN_RANK[b.origin] ? a : b;
  if (a.incomplete !== b.incomplete) return a.incomplete ? b : a;
  return a.columns.length >= b.columns.length ? a : b;
}

/**
 * Builds the project's column index from every statement that writes a table.
 *
 * A `SELECT * INTO stage.sales FROM raw.sales` names no columns of its own — it has exactly the
 * columns of the table it read. Those are only known once *that* table has been read, which may be a
 * later file, so unresolved stars are completed in follow-up passes over the finished index rather
 * than at parse time. Three passes cover a chain of three such copies, which is past anything seen
 * in practice; a longer chain simply stays marked incomplete.
 */
export function buildColumnIndex(statements: { table: string; sql: string }[]): ColumnIndex {
  const index: ColumnIndex = new Map();

  for (const { table, sql } of statements) {
    if (!table) continue;
    const extracted = extractStatementColumns(sql, table);
    if (!extracted) continue;
    const existing = index.get(extracted.table);
    index.set(extracted.table, existing ? better(existing, extracted) : extracted);
  }

  for (let pass = 0; pass < MAX_COMPLETION_PASSES; pass++) {
    let changed = false;
    for (const entry of index.values()) {
      if (!entry.incomplete || entry.pending.length === 0) continue;
      const known = new Set(entry.columns.map((c) => c.name));
      const added: ColumnInfo[] = [];
      let resolvedAll = true;

      for (const ref of entry.pending) {
        const source = index.get(ref) ?? index.get(bareName(ref));
        if (!source || source === entry) {
          resolvedAll = false;
          continue;
        }
        if (source.incomplete) resolvedAll = false;
        for (const column of source.columns) {
          if (known.has(column.name)) continue;
          known.add(column.name);
          added.push(column);
        }
      }

      if (added.length > 0) {
        entry.columns = [...entry.columns, ...added];
        changed = true;
      }
      if (resolvedAll && entry.columns.length > 0) {
        entry.incomplete = false;
        entry.pending = [];
        changed = true;
      }
    }
    if (!changed) break;
  }

  return index;
}
