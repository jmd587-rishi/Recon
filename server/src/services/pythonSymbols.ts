/**
 * Works out the string values a PySpark notebook builds its table names out of, so a metadata-driven
 * pipeline yields real lineage instead of none.
 *
 * `tableLineage.ts`'s DataFrame fallback originally required the table name to be a quoted literal —
 * `saveAsTable("cat.sch.tbl")`. Production notebooks rarely look like that. The common shape is a
 * table of metadata driving a loop:
 *
 *     TARGET_CATALOG = "02_silver"
 *     SILVER_TABLES = [{"source_table": "customers", "target_table": "customers_clean"}, ...]
 *     for meta in SILVER_TABLES:
 *         src = meta["source_table"]
 *         full = f"{SOURCE_CATALOG}.{SOURCE_SCHEMA}.{src}"
 *         spark.table(full) ... .saveAsTable(f"{TARGET_CATALOG}.{TARGET_SCHEMA}.{meta['target_table']}")
 *
 * where every name is a variable and nothing is a literal. Resolving that needs three things the
 * regexes couldn't do: constant folding, f-string expansion, and reading the string values back out
 * of a list-of-dicts literal.
 *
 * This is deliberately *not* a Python interpreter. It reads assignments as facts, ignores control
 * flow, and gives up (returns null) the moment a placeholder can't be resolved — a name that still
 * contains `{}` is worse than no name at all, because it becomes a phantom node in the lineage graph.
 * Symbols are collected notebook-wide rather than per-cell, since Databricks cells share one
 * namespace and the constants are conventionally set in the first cell.
 *
 * The alignment rule in `resolveAligned` is what keeps the fan-out honest: a loop that reads
 * `src` and writes `tgt` off the same metadata row produces N edges, one per row — not the N×N the
 * cross-product of both value sets would give.
 */

/** Guards against a self-referential assignment (`a = f"{a}"`) rather than any real nesting depth. */
const MAX_DEPTH = 8;

/** Cap on rows read from one metadata list, so a generated file can't blow up the graph. */
const MAX_ROWS = 200;

export interface PythonSymbols {
  /** `NAME = "literal"` */
  constants: Map<string, string>;
  /** `NAME = f"a{B}c"`, kept as the raw template so placeholders resolve against a row lazily. */
  templates: Map<string, string>;
  /** `NAME = [{...}, {...}]` -> one key->value map per dict, string-valued entries only. */
  dictLists: Map<string, Map<string, string>[]>;
  /** `for row in NAME:` -> row -> NAME. Also matches a function parameter of the same name. */
  loopVars: Map<string, string>;
  /** `x = row["key"]` -> x -> {row, key} */
  fieldAliases: Map<string, { rowVar: string; key: string }>;
}

export function emptySymbols(): PythonSymbols {
  return {
    constants: new Map(),
    templates: new Map(),
    dictLists: new Map(),
    loopVars: new Map(),
    fieldAliases: new Map()
  };
}

// ---- collection ----

/** `NAME = "lit"` or `NAME = f"tpl"`, one per line, with an optional trailing comment. */
const STRING_ASSIGN_RE =
  /^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*([rfRF]{0,2})(['"])((?:\\.|(?!\3)[^\n])*)\3[ \t]*(?:#[^\n]*)?$/gm;

/** `x = row["key"]` / `x = row['key']` / `x = row.get("key")` */
const FIELD_ALIAS_RE =
  /^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*([A-Za-z_]\w*)[ \t]*(?:\[[ \t]*(['"])([^'"\]]+)\3[ \t]*\]|\.get\([ \t]*(['"])([^'"()]+)\5)/gm;

/** `for row in NAME:` — a single loop variable only, so `for a, b in zip(...)` is left alone. */
const FOR_RE = /^[ \t]*for[ \t]+([A-Za-z_]\w*)[ \t]+in[ \t]+([A-Za-z_]\w*)[ \t]*:/gm;

/** The head of a list literal assignment; the body is scanned for balance, not matched. */
const LIST_ASSIGN_RE = /^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*\[/gm;

/** String-keyed, string-valued dict entries. A list- or number-valued entry simply doesn't match. */
const DICT_PAIR_RE = /(['"])([\w]+)\1[ \t]*:[ \t]*(['"])((?:\\.|(?!\3)[^\n])*)\3/g;

/**
 * Index just past the bracket matching the one at `open`, or -1. Quotes and `#` comments are skipped
 * so a bracket inside a string can't unbalance the scan.
 */
function matchBracket(text: string, open: number): number {
  const opener = text[open];
  const closer = opener === "[" ? "]" : opener === "{" ? "}" : null;
  if (closer === null) return -1;

  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "#") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    if (ch === opener) depth++;
    else if (ch === closer && --depth === 0) return i + 1;
  }
  return -1;
}

/** The `{...}` groups sitting directly inside a list literal body. */
function dictRowsIn(body: string): Map<string, string>[] {
  const rows: Map<string, string>[] = [];
  for (let i = 0; i < body.length && rows.length < MAX_ROWS; i++) {
    const ch = body[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < body.length && body[i] !== quote) i += body[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch !== "{") continue;

    const close = matchBracket(body, i);
    if (close === -1) break;

    const row = new Map<string, string>();
    const text = body.slice(i, close);
    DICT_PAIR_RE.lastIndex = 0;
    let pair: RegExpExecArray | null;
    while ((pair = DICT_PAIR_RE.exec(text))) row.set(pair[2], pair[4]);
    if (row.size > 0) rows.push(row);

    i = close - 1;
  }
  return rows;
}

/**
 * Reads every assignment in a notebook into one symbol table.
 *
 * Later assignments win, matching how the cells would actually run. Nothing here understands scope:
 * a name assigned inside a function and a name assigned at the top level are the same symbol, which
 * is what lets a `for meta in TABLES:` loop in one cell resolve the `meta["name"]` used inside a
 * helper defined in another.
 */
export function collectPythonSymbols(sources: string[]): PythonSymbols {
  const symbols = emptySymbols();
  const joined = sources.join("\n");

  let m: RegExpExecArray | null;

  STRING_ASSIGN_RE.lastIndex = 0;
  while ((m = STRING_ASSIGN_RE.exec(joined))) {
    const [, name, prefix, , body] = m;
    if (prefix.toLowerCase().includes("f")) symbols.templates.set(name, body);
    else symbols.constants.set(name, body);
  }

  FIELD_ALIAS_RE.lastIndex = 0;
  while ((m = FIELD_ALIAS_RE.exec(joined))) {
    const key = m[4] ?? m[6];
    if (key) symbols.fieldAliases.set(m[1], { rowVar: m[2], key });
  }

  FOR_RE.lastIndex = 0;
  while ((m = FOR_RE.exec(joined))) symbols.loopVars.set(m[1], m[2]);

  LIST_ASSIGN_RE.lastIndex = 0;
  while ((m = LIST_ASSIGN_RE.exec(joined))) {
    const open = joined.indexOf("[", m.index);
    const close = matchBracket(joined, open);
    if (close === -1) continue;
    const rows = dictRowsIn(joined.slice(open + 1, close - 1));
    if (rows.length > 0) symbols.dictLists.set(m[1], rows);
    LIST_ASSIGN_RE.lastIndex = close;
  }

  return symbols;
}

// ---- resolution ----

const LITERAL_RE = /^([rfRF]{0,2})(['"])((?:\\.|(?!\2).)*)\2$/;
const SUBSCRIPT_RE = /^([A-Za-z_]\w*)[ \t]*(?:\[[ \t]*(['"])([^'"\]]+)\2[ \t]*\]|\.get\([ \t]*(['"])([^'"()]+)\4[ \t]*\))$/;

/** `{expr}` / `{expr:spec}` / `{expr!r}` — the placeholder body, format spec dropped. */
function placeholderExpression(inner: string): string {
  const cut = inner.search(/[!:]/);
  return (cut === -1 ? inner : inner.slice(0, cut)).trim();
}

export interface Expansion {
  text: string;
  /** False if any placeholder was left unresolved — the text still contains `{}`. */
  resolved: boolean;
}

/**
 * Expands `{...}` placeholders in an f-string body.
 *
 * `{{`/`}}` are literal braces and are left as one brace, as Python renders them. An unresolved
 * placeholder is kept verbatim and flagged, so a caller wanting a table name can reject it while
 * `spark.sql(f"...")` can still hand the partially-expanded SQL to the parser.
 */
export function expandTemplate(
  body: string,
  symbols: PythonSymbols,
  rowIdx: number | null,
  depth = 0
): Expansion {
  let out = "";
  let resolved = true;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" && body[i + 1] === "{") {
      out += "{";
      i++;
    } else if (ch === "}" && body[i + 1] === "}") {
      out += "}";
      i++;
    } else if (ch === "{") {
      const close = body.indexOf("}", i);
      if (close === -1) {
        out += body.slice(i);
        break;
      }
      const expr = placeholderExpression(body.slice(i + 1, close));
      const value = resolveExpression(expr, symbols, rowIdx, depth + 1);
      if (value === null) {
        out += body.slice(i, close + 1);
        resolved = false;
      } else {
        out += value;
      }
      i = close;
    } else {
      out += ch;
    }
  }

  return { text: out, resolved };
}

/** The value of `row[key]` for the row at `rowIdx` of whichever list `rowVar` iterates. */
function fieldValue(
  rowVar: string,
  key: string,
  symbols: PythonSymbols,
  rowIdx: number | null
): string | null {
  if (rowIdx === null) return null;
  const listName = symbols.loopVars.get(rowVar);
  if (!listName) return null;
  return symbols.dictLists.get(listName)?.[rowIdx]?.get(key) ?? null;
}

/**
 * The string a Python expression evaluates to, or null if it can't be settled.
 *
 * Handles a quoted literal, a name bound to a constant or an f-string template, a `row["key"]`
 * subscript, and a name aliased to one. Anything else — a function call, a concatenation, an
 * attribute — is null rather than a guess.
 */
export function resolveExpression(
  expr: string,
  symbols: PythonSymbols,
  rowIdx: number | null,
  depth = 0
): string | null {
  if (depth > MAX_DEPTH) return null;
  const trimmed = expr.trim();
  if (trimmed.length === 0) return null;

  const literal = LITERAL_RE.exec(trimmed);
  if (literal) {
    const [, prefix, , body] = literal;
    if (!prefix.toLowerCase().includes("f")) return body;
    const expanded = expandTemplate(body, symbols, rowIdx, depth);
    return expanded.resolved ? expanded.text : null;
  }

  const subscript = SUBSCRIPT_RE.exec(trimmed);
  if (subscript) {
    const key = subscript[3] ?? subscript[5];
    return key ? fieldValue(subscript[1], key, symbols, rowIdx) : null;
  }

  const constant = symbols.constants.get(trimmed);
  if (constant !== undefined) return constant;

  const template = symbols.templates.get(trimmed);
  if (template !== undefined) {
    const expanded = expandTemplate(template, symbols, rowIdx, depth);
    return expanded.resolved ? expanded.text : null;
  }

  const alias = symbols.fieldAliases.get(trimmed);
  if (alias) return fieldValue(alias.rowVar, alias.key, symbols, rowIdx);

  return null;
}

/** The metadata list an expression's value varies with, if any. */
function listDependency(expr: string, symbols: PythonSymbols, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  const trimmed = expr.trim();

  const subscript = SUBSCRIPT_RE.exec(trimmed);
  if (subscript) return symbols.loopVars.get(subscript[1]) ?? null;

  const alias = symbols.fieldAliases.get(trimmed);
  if (alias) return symbols.loopVars.get(alias.rowVar) ?? null;

  const literal = LITERAL_RE.exec(trimmed);
  const body = literal?.[1].toLowerCase().includes("f")
    ? literal[3]
    : symbols.templates.get(trimmed);
  if (body === undefined) return null;

  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "{" || body[i + 1] === "{") continue;
    const close = body.indexOf("}", i);
    if (close === -1) break;
    const found = listDependency(placeholderExpression(body.slice(i + 1, close)), symbols, depth + 1);
    if (found) return found;
    i = close;
  }
  return null;
}

/**
 * Resolves several expressions *together*, one tuple per metadata row they share.
 *
 * This is the whole point of the module. A loop over 7 tables that reads `src` and writes `tgt`
 * must yield 7 source/target pairs; resolving each expression to its own set of 7 values and pairing
 * them freely would yield 49 edges, of which 42 are fiction. Binding both to the same row index
 * makes the fan-out exactly what the loop does.
 *
 * Expressions that don't depend on the list still resolve — they just take the same value in every
 * tuple. With no list involved at all the result is a single tuple.
 */
export function resolveAligned(exprs: string[], symbols: PythonSymbols): (string | null)[][] {
  const rows = rowsFor(exprs, symbols);
  if (!rows) return [exprs.map((e) => resolveExpression(e, symbols, null))];
  return rows.map((_, i) => exprs.map((e) => resolveExpression(e, symbols, i)));
}

function rowsFor(exprs: string[], symbols: PythonSymbols): Map<string, string>[] | null {
  const listName = exprs.map((e) => listDependency(e, symbols)).find((n) => n !== null) ?? null;
  const rows = listName ? symbols.dictLists.get(listName) : undefined;
  return rows && rows.length > 0 ? rows : null;
}

/**
 * How many times a whole notebook has to be walked for its table names to come out aligned, or null
 * when no expression depends on a metadata list and one static walk is enough.
 *
 * The read and the write of one loop iteration are often several statements apart, tied together by
 * a DataFrame variable rather than sitting in one expression, so the alignment `resolveAligned` does
 * within a statement has to be lifted to the walk itself: the caller replays its pass once per
 * metadata row, and every name resolved during a given pass belongs to that same row.
 *
 * Null rather than 1 for the no-list case, because a list with exactly one row also needs one walk —
 * but that walk has to bind row 0, where a static one resolves no subscript at all.
 */
export function alignmentRowCount(exprs: string[], symbols: PythonSymbols): number | null {
  return rowsFor(exprs, symbols)?.length ?? null;
}

/**
 * The argument text of a call whose `(` sits at `open`, balanced and quote-aware.
 *
 * A regex can't do this: `spark.table(meta.get("k"))` has a `)` inside the argument, and stopping at
 * the first one hands back `meta.get("k"` — which resolves to nothing.
 */
export function readCallArgument(source: string, open: number): string | null {
  const close = matchBracketParen(source, open);
  return close === -1 ? null : source.slice(open + 1, close - 1).trim();
}

function matchBracketParen(text: string, open: number): number {
  if (text[open] !== "(") return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i + 1;
  }
  return -1;
}
