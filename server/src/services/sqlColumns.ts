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
/** How far a column's type is chased through tables that copy it — raw to stage to mart and back. */
const MAX_KIND_PASSES = 6;

export type ColumnKind = "numeric" | "date" | "text" | "boolean" | "other";

export interface ColumnInfo {
  /** Lowercased, unquoted. */
  name: string;
  /** Type exactly as declared (`decimal(18, 2)`), or null when only a select list named the column. */
  dataType: string | null;
  kind: ColumnKind;
  /** Declared part of a PRIMARY KEY. Only DDL can say this — a select list never does. */
  isDeclaredKey: boolean;
  /**
   * The column this one is a plain copy of, when its own expression says nothing about its type
   * (`month_date AS date_key`). Resolved against the tables the statement reads in a later pass, which
   * is how a column three CTEs from its origin still gets a type.
   *
   * It is also what the column *corresponds to* upstream, which is how a renamed column is compared
   * with the column it actually came from rather than with whatever shares its name.
   */
  kindRef?: string;
  /**
   * The literal every row of this column is set to, when the code hardcodes it (`'TBC' AS
   * customer_region`). A placeholder nobody filled in is worth reporting on its own, and a check
   * written against such a column can only ever confirm the placeholder.
   */
  constant?: string;
}

/** Which of the three extraction paths produced a table's columns. */
export type ColumnOrigin = "ddl" | "select" | "insert";

export interface TableColumns {
  table: string;
  columns: ColumnInfo[];
  origin: ColumnOrigin;
  /** A `SELECT *` that could not be expanded — the list is a subset of the table's real columns. */
  incomplete: boolean;
  /**
   * Two statements of equal authority build this table with different columns, so the list is what
   * they agree on. Worth telling the reader: it usually means two scripts define one table.
   */
  conflicted?: boolean;
  /** Tables whose columns would complete the list, when a `*` pointed at one. */
  pending: string[];
  /** Tables this statement reads, against which a column's `kindRef` is resolved. */
  readsFrom: string[];
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

/**
 * Whether two references name the same table. The schema is compared only when both sides state one,
 * since half this SQL writes its tables unqualified — but when both do state it, `staging.orders` and
 * `datamart.orders` are two tables and must not swap column lists.
 */
function sameTable(a: string, b: string): boolean {
  const left = cleanRef(a).split(".");
  const right = cleanRef(b).split(".");
  if (left[left.length - 1] !== right[right.length - 1]) return false;
  if (left.length < 2 || right.length < 2) return true;
  return left[left.length - 2] === right[right.length - 2];
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
  "intersect", "pivot", "unpivot", "set", "using", "when", "then", "else", "end", "values", "limit",
  "qualify", "window", "from"
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

/** `INSERT INTO t ... SELECT` and `CREATE TABLE t AS SELECT` — the shapes that write *after* naming t. */
const WRITE_ANCHOR_RES = [
  /\binsert\s+(?:overwrite\s+)?(?:into\s+)?(?:table\s+)?([\w.$#`[\]"]+)/gi,
  /\bcreate\s+(?:or\s+(?:replace|alter)\s+)?(?:external\s+|temp(?:orary)?\s+|global\s+)*table\s+(?:if\s+not\s+exists\s+)?([\w.$#`[\]"]+)/gi,
  /\bmerge\s+(?:into\s+)?([\w.$#`[\]"]+)/gi
];

/** Offset just past the point where the statement names `wanted` as the table it writes. */
function writeAnchor(sql: string, wanted: string): number | null {
  for (const re of WRITE_ANCHOR_RES) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(sql))) {
      if (bareName(match[1]) === wanted) return match.index + match[0].length;
    }
  }
  return null;
}

/**
 * Locates the select list that produces the written table, plus what it reads from.
 *
 * `targetTable` is what makes this answerable at all, because one statement can write several tables:
 * a T-SQL procedure stages through `SELECT ... INTO #tmp` before its real write, and the list that
 * describes the table we were asked about is the one belonging to *its* write, found either before an
 * `INTO` naming it or after an `INSERT INTO`/`CREATE TABLE` naming it.
 *
 * When the statement writes the target by none of those routes, the answer is that this statement
 * doesn't describe it — never the select list of whichever other table it did write. Handing back a
 * staging table's columns for a fact table is how a reconciliation script ends up naming a column the
 * table has not got, which is worse than having no column list for it at all.
 */
function findWriteSelect(sql: string, targetTable: string | null): WriteSelect | null {
  const words = topLevelWords(sql);

  const intoWords = words.filter((w, i) => {
    if (w.word !== "into") return false;
    const previous = words[i - 1]?.word;
    return previous !== "insert" && previous !== "merge" && previous !== "bulk";
  });

  const wanted = targetTable ? bareName(targetTable) : null;
  const named = (w: Word) => bareName(IDENT_RE.exec(sql.slice(w.end).trimStart())?.[0] ?? "") === wanted;
  // With no target named, the statement is being read on its own terms and its last write is its own.
  const into = wanted === null ? (intoWords[intoWords.length - 1] ?? null) : (intoWords.find(named) ?? null);

  const anchor = into === null && wanted !== null ? writeAnchor(sql, wanted) : null;
  if (into === null && anchor === null && wanted !== null) return null;

  const select = into
    ? [...words].reverse().find((w) => w.word === "select" && w.start < into.start)
    : words.find((w) => w.word === "select" && w.start >= (anchor ?? 0));
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

// ---- what type an expression produces ----

/**
 * The type a function returns, where it doesn't depend on its arguments.
 *
 * `YEAR`, `MONTH` and `DATEPART` are here as *numeric* deliberately — they take a date and return an
 * integer, and reading them as dates is how a check ends up comparing an int to a date.
 */
const FUNCTION_KINDS: Record<string, ColumnKind> = {
  concat: "text", concat_ws: "text", format: "text", datename: "text", left: "text", right: "text",
  substring: "text", upper: "text", lower: "text", ltrim: "text", rtrim: "text", trim: "text",
  replace: "text", stuff: "text", str: "text", string_agg: "text", newid: "text", hashbytes: "text",
  quotename: "text", replicate: "text", reverse: "text", md5: "text", sha2: "text",
  dateadd: "date", date_add: "date", date_sub: "date", eomonth: "date", datefromparts: "date",
  getdate: "date", getutcdate: "date", sysdatetime: "date", current_timestamp: "date",
  date_trunc: "date", datetrunc: "date", to_date: "date", current_date: "date",
  year: "numeric", month: "numeric", day: "numeric", datepart: "numeric", datediff: "numeric",
  sum: "numeric", count: "numeric", count_big: "numeric", avg: "numeric", abs: "numeric",
  round: "numeric", ceiling: "numeric", floor: "numeric", power: "numeric", sign: "numeric",
  len: "numeric", length: "numeric", row_number: "numeric", rank: "numeric", dense_rank: "numeric",
  ntile: "numeric", checksum: "numeric", binary_checksum: "numeric"
};

/**
 * Functions callable with no parentheses, so a bare word can genuinely be one of them. Everything
 * else in `FUNCTION_KINDS` needs an argument list, which makes a bare occurrence a column name.
 */
const NILADIC_KINDS: Record<string, ColumnKind> = {
  current_timestamp: "date",
  current_date: "date",
  current_time: "date",
  sysdatetime: "date",
  current_user: "text",
  session_user: "text",
  system_user: "text"
};

/** Functions whose type is their argument's, so the answer is one level down. */
const PASSTHROUGH: Record<string, number> = {
  isnull: 0, coalesce: 0, nullif: 0, min: 0, max: 0, iif: 1, ifnull: 0, nvl: 0, first_value: 0,
  last_value: 0, lag: 0, lead: 0
};

export interface ExpressionKind {
  kind: ColumnKind;
  /** Set instead of a kind when the expression is a plain copy of another column. */
  ref: string | null;
}

const PLAIN_REF_RE = /^[A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)*$/;

/**
 * The type a select-list expression produces, read from the expression itself.
 *
 * This is what tells `date_key` in one table apart from `date_key` in another. A warehouse hashes its
 * surrogate keys — `CONVERT(VARCHAR(32), HASHBYTES('MD5', …), 2) AS date_key` is a *string* — while
 * the table downstream calls its actual date `date_key` too. Joining the two on the shared name is
 * `Msg 241, Conversion failed when converting date and/or time from character string`, and no amount
 * of checking column *names* can see it coming; only the expressions can.
 *
 * A plain reference resolves to nothing here and comes back as `ref`, for `buildColumnIndex` to chase
 * through the tables the statement reads once they are all known.
 */
export function inferExpressionKind(expression: string, depth = 0): ExpressionKind {
  const text = expression.replace(/\s+/g, " ").trim();
  if (!text || depth > 4) return { kind: "other", ref: null };

  if (text.startsWith("'")) return { kind: "text", ref: null };
  if (/^[-+]?\d+(?:\.\d+)?$/.test(text)) return { kind: "numeric", ref: null };

  if (PLAIN_REF_RE.test(text)) {
    const bare = text.split(".").pop()!.toLowerCase();
    // Only the niladic functions are values written like columns. Everything else spelled without
    // parentheses is a column, and a calendar table's `month` column is exactly that — reading it as
    // the `MONTH()` function types the column as a number and then compares a date against one.
    const known = NILADIC_KINDS[bare];
    return known ? { kind: known, ref: null } : { kind: "other", ref: bare };
  }

  const call = /^([A-Za-z_]\w*)\s*\(/.exec(text);
  if (!call) {
    // `CASE … THEN <expr>` takes the type of what it returns.
    if (/^case\b/i.test(text)) {
      const then = /\bthen\b/i.exec(text);
      if (then) {
        const rest = text.slice(then.index + then[0].length);
        const end = rest.search(/\b(?:when|else|end)\b/i);
        return inferExpressionKind(end < 0 ? rest : rest.slice(0, end), depth + 1);
      }
    }
    return { kind: "other", ref: null };
  }

  const fn = call[1].toLowerCase();
  const group = parenContent(text, call.index + call[0].length - 1);
  if (!group) return { kind: "other", ref: null };
  const args = splitTopLevel(group.content, ",");

  if (fn === "cast" || fn === "try_cast") {
    // `CAST(x AS DECIMAL(18, 2))` — the type follows the last top-level AS.
    const parts = splitTopLevel(group.content, " ");
    const asAt = parts.map((p) => p.toLowerCase()).lastIndexOf("as");
    return { kind: asAt >= 0 ? kindOfType(parts.slice(asAt + 1).join(" ")) : "other", ref: null };
  }
  if (fn === "convert" || fn === "try_convert") {
    return { kind: args[0] ? kindOfType(args[0]) : "other", ref: null };
  }

  const passthrough = PASSTHROUGH[fn];
  if (passthrough !== undefined && args[passthrough]) {
    return inferExpressionKind(args[passthrough], depth + 1);
  }

  return { kind: FUNCTION_KINDS[fn] ?? "other", ref: null };
}

/**
 * Whether two columns of the same name are demonstrably different things.
 *
 * Unknown is compatible with everything — this only ever reports a conflict it can prove, so a column
 * whose type nothing in the folder states is still joined on, as it was before.
 */
export function kindsConflict(a: ColumnKind, b: ColumnKind): boolean {
  return a !== "other" && b !== "other" && a !== b;
}

/** The type known for one column of one table, or `other` when nothing said. */
export function columnKindOf(index: ColumnIndex, table: string, column: string): ColumnKind {
  return index.get(table.toLowerCase())?.columns.find((c) => c.name === column)?.kind ?? "other";
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

/** The item with its alias stripped, leaving the expression whose type is the column's. */
function itemExpression(item: string): string {
  const text = item.replace(/\s+/g, " ").trim();
  const parts = splitTopLevel(text, " ");
  const asAt = parts.map((p) => p.toLowerCase()).lastIndexOf("as");
  if (asAt >= 0) return parts.slice(0, asAt).join(" ");
  // `t.amount` with no alias is both the expression and the name.
  return text;
}

interface SelectColumns {
  names: string[];
  /** The expression each name was built from, so its type can be read off it. */
  expressions: Map<string, string>;
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
  if (!write) return { names: [], expressions: new Map(), incomplete: true, pending: [] };

  const names: string[] = [];
  const expressions = new Map<string, string>();
  const pending: string[] = [];
  let incomplete = false;

  for (const item of splitTopLevel(write.list, ",")) {
    const { name, star } = itemColumn(item);
    if (name) {
      names.push(name);
      expressions.set(name, itemExpression(item));
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
      for (const [name, expression] of expanded.expressions) expressions.set(name, expression);
      pending.push(...expanded.pending);
      incomplete = incomplete || expanded.incomplete;
    } else {
      incomplete = true;
      if (ref) pending.push(ref);
    }
  }

  return { names: unique(names), expressions, incomplete, pending: unique(pending) };
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
  CREATE_TABLE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CREATE_TABLE_RE.exec(sql))) {
    if (targetTable !== null && !sameTable(match[1], targetTable)) continue;
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
  if (targetTable && !sameTable(match[1], targetTable)) return null;

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

/**
 * Columns a select list or an insert list named, typed by the expression behind each where there is
 * one. No DDL stated these types, so `dataType` stays null — what is known is the *kind*, which is
 * what decides whether two same-named columns are the same thing.
 */
/**
 * The literal a column is hardcoded to, following the same CTE chain a type follows.
 *
 * `'TBC' AS customer_region` in the final select is a placeholder that will be the value of every row
 * in the table. Recognising it is what lets Recon report it as a finding in its own right, rather
 * than leaving it to be discovered by a check whose passing means the placeholder is intact.
 */
function constantThroughCtes(expression: string, cteColumns: Map<string, string[]>, depth = 0): string | null {
  const text = expression.replace(/\s+/g, " ").trim();
  if (!text || depth >= MAX_STAR_DEPTH) return null;

  if (/^'(?:''|[^'])*'$/.test(text) || /^[-+]?\d+(?:\.\d+)?$/.test(text)) return text;

  // A plain copy of a column that is itself constant is constant too.
  if (PLAIN_REF_RE.test(text) && !NILADIC_KINDS[text.split(".").pop()!.toLowerCase()]) {
    const bare = text.split(".").pop()!.toLowerCase();
    for (const candidate of cteColumns.get(bare) ?? []) {
      if (candidate.replace(/\s+/g, " ").trim().toLowerCase() === bare) continue;
      const deeper = constantThroughCtes(candidate, cteColumns, depth + 1);
      if (deeper) return deeper;
    }
  }
  return null;
}

function named(
  names: string[],
  expressions?: Map<string, string>,
  cteColumns: Map<string, string[]> = new Map()
): ColumnInfo[] {
  return names.map((name) => {
    const expression = expressions?.get(name);
    const inferred = expression
      ? kindThroughCtes(expression, cteColumns)
      : { kind: "other" as const, ref: null };
    const constant = expression ? constantThroughCtes(expression, cteColumns) : null;
    return {
      name,
      dataType: null,
      kind: inferred.kind,
      isDeclaredKey: false,
      ...(inferred.ref ? { kindRef: inferred.ref } : {}),
      ...(constant ? { constant } : {})
    };
  });
}

/** Every expression the statement's CTEs give a column name, in the order they define them. */
function cteColumnExpressions(ctes: Map<string, string>): Map<string, string[]> {
  const map = new Map<string, string[]>();

  for (const body of ctes.values()) {
    const write = findWriteSelect(body, null);
    if (!write) continue;
    for (const item of splitTopLevel(write.list, ",")) {
      const { name } = itemColumn(item);
      if (!name) continue;
      const list = map.get(name) ?? [];
      list.push(itemExpression(item));
      map.set(name, list);
    }
  }

  return map;
}

/**
 * The type an expression produces, following a plain reference back through the statement's own CTEs.
 *
 * The statement that writes a table is usually the *last* link of a chain: `SELECT * INTO trn_revenue
 * FROM final_revenue`, where `final_revenue` passes `date_key` straight through from `revenue_keyed`,
 * which is where `CONVERT(VARCHAR(32), HASHBYTES(…), 2)` actually says what it is. Reading only the
 * outer list sees a bare name and learns nothing.
 */
function kindThroughCtes(expression: string, cteColumns: Map<string, string[]>, depth = 0): ExpressionKind {
  const inferred = inferExpressionKind(expression);
  if (inferred.kind !== "other" || !inferred.ref || depth >= MAX_STAR_DEPTH) return inferred;

  let closest = inferred.ref;
  for (const candidate of cteColumns.get(inferred.ref) ?? []) {
    // A CTE that just re-selects the column says nothing; the definition is further down.
    if (inferExpressionKind(candidate).ref === inferred.ref) continue;
    const deeper = kindThroughCtes(candidate, cteColumns, depth + 1);
    if (deeper.kind !== "other") return deeper;
    // No type yet, but a name nearer the origin: `date_key` is really `month_date`, and it is
    // `month_date` that another table in the project will have something to say about.
    if (deeper.ref && deeper.ref !== inferred.ref) closest = deeper.ref;
  }

  return { kind: "other", ref: closest };
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
    if (columns.length > 0) return { table, columns, origin: "ddl", incomplete: false, pending: [], readsFrom: [] };
  }

  const ctes = collectCteBodies(stripped);
  // Only real tables: a CTE resolves inside the statement, and its columns are already followed here.
  const readsFrom = unique(
    tableBindings(stripped)
      .map((binding) => binding.ref)
      .filter((ref) => ref !== table && !ctes.has(bareName(ref)))
  );

  // Ahead of the select list: `INSERT INTO t (a, b, c) SELECT x, y, z` names the *target's* columns
  // in the parens and the source's in the query, and it's the target this is describing.
  const inserted = insertColumns(stripped, targetTable);
  if (inserted && inserted.length > 0) {
    return { table, columns: named(inserted), origin: "insert", incomplete: false, pending: [], readsFrom };
  }

  const selected = selectListColumns(stripped, targetTable, ctes, 0);
  if (selected.names.length > 0) {
    return {
      table,
      columns: named(selected.names, selected.expressions, cteColumnExpressions(ctes)),
      origin: "select",
      incomplete: selected.incomplete,
      pending: selected.pending,
      readsFrom
    };
  }

  // A `SELECT * INTO t FROM other_table` names no column of its own, but recording it lets a later
  // pass fill the list in from `other_table`. With nothing to point at there is nothing to record.
  if (selected.pending.length > 0) {
    return { table, columns: [], origin: "select", incomplete: true, pending: selected.pending, readsFrom };
  }
  return null;
}

const ORIGIN_RANK: Record<ColumnOrigin, number> = { ddl: 3, select: 2, insert: 1 };

/**
 * Merges two readings of the same table.
 *
 * A more authoritative reading wins outright — DDL describes the table, a select list only describes
 * one thing that was put in it. Between readings of *equal* authority that disagree, neither is more
 * likely to be the table that is actually deployed, so what survives is their intersection.
 *
 * This is not a hypothetical tie. A warehouse project routinely carries two scripts building the same
 * report table — `rpt_snowball_jman.sql` and `rpt_snowball_jman_tb_pf.sql`, one an evolution of the
 * other — and taking the longer list means every column the newer one added is checked against a
 * table that, if the older script is what ran, has not got them. Keeping only the columns both agree
 * on gives checks that hold whichever was deployed, and `conflicted` says so in the script.
 */
/**
 * One column as two readings agree on it. Where they disagree about its type neither is authoritative,
 * so the answer is "unknown" — which stops the check comparing it, rather than comparing it wrongly.
 */
function mergeColumn(a: ColumnInfo, b: ColumnInfo): ColumnInfo {
  if (a.kind === b.kind) return a;
  if (a.kind === "other") return { ...a, kind: b.kind, kindRef: b.kindRef };
  if (b.kind === "other") return a;
  return { ...a, kind: "other", kindRef: undefined };
}

function better(a: TableColumns, b: TableColumns): TableColumns {
  if (ORIGIN_RANK[a.origin] !== ORIGIN_RANK[b.origin]) return ORIGIN_RANK[a.origin] > ORIGIN_RANK[b.origin] ? a : b;

  const inB = new Map(b.columns.map((c) => [c.name, c]));
  const shared = a.columns.flatMap((column) => {
    const counterpart = inB.get(column.name);
    return counterpart ? [mergeColumn(column, counterpart)] : [];
  });
  if (shared.length === a.columns.length && shared.length === b.columns.length) {
    // The same list twice — the ordinary case of a table written by more than one statement.
    const kept = a.incomplete && !b.incomplete ? b : a;
    return { ...kept, columns: shared, readsFrom: unique([...a.readsFrom, ...b.readsFrom]) };
  }

  return {
    ...a,
    columns: shared,
    // Whatever either reading has beyond the overlap may still be a real column, so absence from the
    // intersection proves nothing and must not be read as "the table has not got it".
    incomplete: true,
    conflicted: true,
    pending: unique([...a.pending, ...b.pending]),
    readsFrom: unique([...a.readsFrom, ...b.readsFrom])
  };
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
        // Bare-name matching only where it is unambiguous: copying `dbo.sales`'s columns onto a table
        // that read `staging.sales` is how a script ends up naming a column the table hasn't got.
        const resolved = resolveTableRef(ref, index.keys());
        const source = resolved ? index.get(resolved) : undefined;
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

  resolveColumnKinds(index);
  return index;
}

/**
 * Gives a type to every column that is a plain copy of another, by chasing the copy to its origin.
 *
 * `month_date AS date_key` says nothing about itself; `month_date` on the table this statement reads
 * says it is a date. The chain can be several tables long — a datamart column copied from a
 * transformation column copied from a `TRY_CONVERT(DATE, …)` in stage — so this runs to a fixed point
 * rather than once, which is also what keeps it from mattering in which order the files were read.
 */
function resolveColumnKinds(index: ColumnIndex): void {
  for (let pass = 0; pass < MAX_KIND_PASSES; pass++) {
    let changed = false;

    for (const entry of index.values()) {
      for (const column of entry.columns) {
        if (column.kind !== "other" || !column.kindRef) continue;

        for (const ref of entry.readsFrom) {
          const table = resolveTableRef(ref, index.keys());
          const source = table ? index.get(table) : undefined;
          if (!source || source === entry) continue;
          const match = source.columns.find((c) => c.name === column.kindRef);
          if (match && match.kind !== "other") {
            column.kind = match.kind;
            changed = true;
            break;
          }
        }
      }
    }

    if (!changed) break;
  }
}

// ---- columns the project only ever *reads* ----

/**
 * Columns the project's SQL is seen reading off a table, keyed by the table's qualified name.
 *
 * `buildColumnIndex` above can only describe a table the folder *builds* — it works from the DDL or
 * the select list that writes it. The first layer of a pipeline is exactly the case that has neither:
 * bronze is landed by an ingestion tool, so nothing in the folder declares it, and the index has no
 * entry for it at all. But every statement reading it names its columns (`FROM bronze.orders o …
 * o.order_id`), and that is proof those columns exist even though it is no proof of the ones that
 * don't. Reading *all* the code, not just the code that writes, is what turns a table Recon could say
 * nothing about into one it can at least check a generated column name against.
 *
 * This is positive evidence only, and is kept apart from `ColumnIndex` for that reason: a list
 * assembled from usage is never complete, so it can say "yes, that column exists" and must never be
 * read as "those are the columns". `columnKnowledge` is what combines the two safely.
 */
export type ColumnUsage = Map<string, Set<string>>;

/** A table reference in a statement's FROM/JOIN, with the name the rest of the statement calls it by. */
export interface TableBinding {
  /** Alias the statement gave it, lowercased. Absent when it declared none. */
  alias: string | null;
  /** The reference as written, lowercased and unquoted (`[dbo].[Orders]` -> `dbo.orders`). */
  ref: string;
  /** Offset of the reference in the statement — what says which scope it was bound in. */
  at: number;
}

const BINDING_RE = /\b(?:from|join|into|update)\s+([\w.$#`[\]"]+)(?:\s+(?:as\s+)?([\w`[\]"]+))?/gi;

/** Every table the statement reads or writes by name, and what it calls each one. */
export function tableBindings(sql: string): TableBinding[] {
  const bindings: TableBinding[] = [];
  BINDING_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = BINDING_RE.exec(sql))) {
    const ref = cleanRef(match[1]);
    // `FROM (SELECT ...)` and `JOIN (VALUES ...)` name no table; the regex can't match them anyway,
    // but a stray keyword can still arrive as a reference.
    if (!ref || NOT_AN_ALIAS.has(ref)) continue;
    const alias = match[2] ? cleanRef(match[2]) : null;
    const named = alias !== null && !NOT_AN_ALIAS.has(alias);
    bindings.push({ alias: named ? alias : null, ref, at: match.index });
    // `INTO t FROM u` — the optional alias group swallows the `FROM`, and with it the next binding.
    // Rewinding to the rejected word lets it be read as the keyword it is.
    if (alias !== null && !named) BINDING_RE.lastIndex = match.index + match[0].length - match[2].length;
  }

  return bindings;
}

/**
 * Parenthesis depth at every offset of the statement, which is as much scope as a scanner can know
 * without a parser: a table joined inside a subquery is not in the outer query's scope, and a column
 * named there is not resolved against the outer query's tables.
 */
export function parenDepths(sql: string): number[] {
  const depths = new Array<number>(sql.length);
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === ")") depth = Math.max(0, depth - 1);
    depths[i] = depth;
    if (sql[i] === "(") depth++;
  }
  return depths;
}

/**
 * The project table a reference names: the same name, or — since plenty of statements qualify a table
 * only by its schema, or not at all — the one table whose bare name it matches. Ambiguous bare names
 * resolve to nothing rather than to a guess, because attributing one schema's columns to another
 * schema's same-named table is precisely the mistake that puts a wrong column in a script.
 */
export function resolveTableRef(ref: string, tables: Iterable<string>): string | null {
  const wanted = cleanRef(ref);
  if (!wanted) return null;

  const known = Array.from(tables, (t) => t.toLowerCase());
  if (known.includes(wanted)) return wanted;

  const matches = known.filter((table) => bareName(table) === bareName(wanted));
  return matches.length === 1 ? matches[0] : null;
}

/** Blanks out string literals, so `'o.order_id'` in a check name isn't read as a column reference. */
export function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "''");
}

/** Everything a statement calls a table by: its alias, or its own name when it declared none. */
function bindingNames(binding: TableBinding): string[] {
  if (binding.alias) return [binding.alias];
  return unique([binding.ref, bareName(binding.ref)]);
}

/**
 * Reads every statement in the project for `<alias>.<column>` references and records them against the
 * table the alias is bound to. Only references whose table resolves to one of `tables` are kept, so a
 * CTE or derived-table alias contributes nothing.
 */
export function buildColumnUsage(statements: { sql: string }[], tables: Iterable<string>): ColumnUsage {
  const known = Array.from(tables);
  const usage: ColumnUsage = new Map();

  for (const { sql } of statements) {
    const cleaned = stripStringLiterals(stripSqlComments(sql));

    for (const binding of tableBindings(cleaned)) {
      const table = resolveTableRef(binding.ref, known);
      if (!table) continue;

      for (const name of bindingNames(binding)) {
        const useRe = new RegExp(`\\b${name.replace(/[.$#]/g, "\\$&")}\\s*\\.\\s*([A-Za-z_]\\w*)`, "gi");
        let use: RegExpExecArray | null;
        while ((use = useRe.exec(cleaned))) {
          const columns = usage.get(table) ?? new Set<string>();
          columns.add(use[1].toLowerCase());
          usage.set(table, columns);
        }
      }
    }
  }

  return usage;
}

/** Everything the project's SQL says about its tables' columns, from both directions. */
export interface ColumnFacts {
  /** Tables the folder builds, described by their DDL or by the select list that writes them. */
  index: ColumnIndex;
  /** Columns seen read off any table, including ones nothing in the folder defines. */
  usage: ColumnUsage;
}

export interface TableColumnKnowledge {
  /** Every column name the project shows this table has. */
  names: Set<string>;
  /**
   * The set is the table's *whole* set, so a name missing from it is genuinely not a column. False
   * for a usage-assembled or `SELECT *`-derived list, where absence proves nothing.
   */
  complete: boolean;
}

/**
 * What is known about one table's columns, merging the two sources under the rule that decides
 * whether a generated column name can be rejected.
 *
 * A declared list wins outright: it is complete, so it alone decides, and a usage reference that
 * disagrees with it means the reference was misattributed rather than that the DDL is short. Anything
 * weaker is a union — more names to accept, and never a reason to reject.
 */
export function columnKnowledge(facts: ColumnFacts, table: string): TableColumnKnowledge {
  const key = table.toLowerCase();
  const entry = facts.index.get(key);
  const declared = entry?.columns.map((c) => c.name) ?? [];

  if (entry && !entry.incomplete && declared.length > 0) {
    return { names: new Set(declared), complete: true };
  }
  return { names: new Set([...declared, ...(facts.usage.get(key) ?? [])]), complete: false };
}

// ---- which names can be written into a generated script ----

/**
 * Words no engine will read as a column name unless they are quoted. The SQL Server reserved list,
 * plus the few Spark adds, because a warehouse column called `[Key]`, `[Order]`, `[Percent]` or
 * `[Desc]` is ordinary and every one of them is reserved.
 */
const RESERVED_WORDS = new Set([
  "add", "all", "alter", "and", "any", "as", "asc", "authorization", "backup", "begin", "between",
  "break", "browse", "bulk", "by", "cascade", "case", "check", "checkpoint", "close", "clustered",
  "coalesce", "collate", "column", "commit", "compute", "constraint", "contains", "containstable",
  "continue", "convert", "create", "cross", "current", "current_date", "current_time",
  "current_timestamp", "current_user", "cursor", "database", "dbcc", "deallocate", "declare",
  "default", "delete", "deny", "desc", "disk", "distinct", "distributed", "double", "drop", "dump",
  "else", "end", "errlvl", "escape", "except", "exec", "execute", "exists", "exit", "external",
  "fetch", "file", "fillfactor", "for", "foreign", "freetext", "freetexttable", "from", "full",
  "function", "goto", "grant", "group", "having", "holdlock", "identity", "identity_insert",
  "identitycol", "if", "in", "index", "inner", "insert", "intersect", "into", "is", "join", "key",
  "kill", "left", "like", "lineno", "load", "merge", "national", "nocheck", "nonclustered", "not",
  "null", "nullif", "of", "off", "offsets", "on", "open", "opendatasource", "openquery",
  "openrowset", "openxml", "option", "or", "order", "outer", "over", "percent", "pivot", "plan",
  "precision", "primary", "print", "proc", "procedure", "public", "raiserror", "read", "readtext",
  "reconfigure", "references", "replication", "restore", "restrict", "return", "revert", "revoke",
  "right", "rollback", "rowcount", "rowguidcol", "rule", "save", "schema", "securityaudit",
  "select", "session_user", "set", "setuser", "shutdown", "some", "statistics", "system_user",
  "table", "tablesample", "textsize", "then", "to", "top", "tran", "transaction", "trigger",
  "truncate", "try_convert", "tsequal", "union", "unique", "unpivot", "update", "updatetext", "use",
  "user", "values", "varying", "view", "waitfor", "when", "where", "while", "with", "writetext",
  // Spark SQL adds these in ANSI mode; harmless to refuse everywhere.
  "anti", "semi", "lateral", "qualify", "window", "natural", "using", "minus", "cluster",
  "distribute", "sort", "reduce", "transform"
]);

/**
 * Whether a column name can be written into a check as it stands.
 *
 * The scripts promise to run unchanged on SQL Server and Databricks SQL, and there is no quoting the
 * two share — SQL Server wants `[Total Revenue (USD)]`, Databricks wants backticks, and a double
 * quote is a string literal on one of them. So a name that is not a plain identifier cannot appear in
 * a portable script at all, and the alternative to leaving it out is a file that does not run.
 *
 * This is not hypothetical tidiness. Column names reach here unquoted (`cleanRef` strips the quoting
 * the DDL used), so `[Year Over Year (%)]` arrives as `year over year (%)`, and `SUM(year over year
 * (%))` is read by SQL Server as the `YEAR` function against an `OVER` clause — *"'YEAR' is not a
 * valid windowing function"* — which kills the statement and, in the folded bundle, the whole file.
 */
export function isEmittableIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$#]*$/.test(name) && !RESERVED_WORDS.has(name.toLowerCase());
}

/**
 * The columns of `entry` that a script can name, recording the ones left out in `skipped`.
 * Returns the entry unchanged when every name is usable, which is the overwhelming majority.
 */
export function emittableColumns(entry: TableColumns | undefined, skipped: Set<string>): TableColumns | undefined {
  if (!entry) return entry;
  const kept = entry.columns.filter((column) => {
    if (isEmittableIdentifier(column.name)) return true;
    skipped.add(column.name);
    return false;
  });
  return kept.length === entry.columns.length ? entry : { ...entry, columns: kept };
}

/**
 * The kind a column's *declared* type gives it, or null when nothing declared one.
 *
 * The null is the point: a column named only by a select list has whatever type its expression
 * returned, which the SQL text does not say, so "not numeric" and "not known to be numeric" are
 * different answers and only the first one justifies refusing to total it.
 */
export function declaredKind(facts: ColumnFacts, table: string, column: string): ColumnKind | null {
  const info = facts.index.get(table.toLowerCase())?.columns.find((c) => c.name === column.toLowerCase());
  return info?.dataType ? info.kind : null;
}
