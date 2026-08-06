import { collectCteBodies, splitTopLevel } from "./sqlColumns.js";
import { stripSqlComments } from "./tableLineage.js";

/**
 * How a transformation actually *uses* each table it reads, which decides which checks mean anything.
 *
 * `tableLineage.ts` answers whether a statement reads a table. That is the right question for a
 * lineage diagram and the wrong one for a reconciliation script, because "reads" covers three very
 * different relationships and only one of them makes a row count comparable:
 *
 *   - a **driver** supplies the rows — the target's row count is a function of it;
 *   - a **lookup** is joined in for its columns — its own row count has nothing to do with the
 *     target's, and comparing them is noise whether they happen to match or not;
 *   - an **incidental** read never reaches the written rows at all. `trn_calendar` derives a single
 *     `@latest_year` from `stage.sales_report` and then builds 36 rows from a recursive CTE; reporting
 *     "2946 source rows, 36 target rows" against it is not a finding, it is a distraction that teaches
 *     the reader to skim past REVIEW rows.
 *
 * The other half of the question is **grain**. A dimension built with `GROUP BY customer_key` from a
 * 2946-row fact feed is *supposed* to have fewer rows, so a raw count is a check that can only ever
 * fail. The check an engineer writes there compares the source's distinct grain to the target's rows —
 * which can genuinely fail, when a join fans out or a group key goes null — so the `GROUP BY` that set
 * the grain is recovered here and `reconciliationScripts.ts` writes that check instead.
 *
 * Everything is read from the SQL the folder already contains; nothing here is configured or guessed.
 */

/** How far a chain of CTEs is followed before the analysis gives up and calls what it has. */
const MAX_CHAIN_DEPTH = 8;

export type SourceRole = "driver" | "lookup" | "incidental";

/**
 * How the statement reaches a table: the driving `FROM`, or the kind of join that brought it in.
 *
 * Worth recording separately from the role because it is half the explanation of a field-level
 * finding. A column sourced through a `LEFT JOIN` is null on every row the join failed to match —
 * that is the join working as written, not a defect — while the same nulls under an `INNER JOIN` mean
 * the rows should not have survived at all. A check that reports the count without saying which is
 * making the reader go and read the SQL to interpret its own output.
 */
export type JoinKind = "from" | "inner" | "left" | "right" | "full" | "cross";

export interface SourceUsage {
  role: SourceRole;
  /** `from` for the table the statement reads first, otherwise the join that brought this one in. */
  joinKind: JoinKind;
  /**
   * The transformation aggregates or dedups between this source and the target, so their row counts
   * are expected to differ and comparing them says nothing.
   */
  grainChanged: boolean;
  /**
   * The `GROUP BY` columns that set the target's grain, when they are plain columns of this source.
   * Empty when the grain changed by some route that can't be named — `DISTINCT *`, an aggregate with
   * no `GROUP BY`, an expression rather than a column.
   */
  grainColumns: string[];
}

// ---- splitting a routine body into its own statements ----

const QUOTE_CLOSERS: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };

function skipQuoted(sql: string, i: number): number {
  const close = QUOTE_CLOSERS[sql[i]];
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === close) {
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

/**
 * The statement's own sub-statements, split on `;` outside quotes and parentheses.
 *
 * `sqlFileParser.ts` deliberately keeps a `CREATE PROCEDURE` whole, because a correction has to be
 * spliced back over the whole routine. That is right for the file and wrong here: a procedure that
 * reads one table to set a variable and then builds another from a CTE has two statements, and
 * attributing the first one's read to the second one's write is what produces a calendar reconciled
 * against a sales report.
 */
export function splitSubStatements(sql: string): { text: string; start: number }[] {
  const parts: { text: string; start: number }[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    if (QUOTE_CLOSERS[ch]) {
      i = skipQuoted(sql, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      parts.push({ text: sql.slice(start, i), start });
      start = i + 1;
    }
    i++;
  }

  parts.push({ text: sql.slice(start), start });
  return parts.filter((part) => part.text.trim().length > 0);
}

// ---- reading one query block ----

const IDENT = "[\\w.$#`\\[\\]\"]+";
/**
 * The join keyword and everything that qualifies it: `LEFT OUTER JOIN`, `INNER JOIN`, `CROSS JOIN`,
 * Spark's `LEFT SEMI`/`LEFT ANTI JOIN`, and a bare `JOIN` (which is an inner one). A plain `FROM`
 * matches with no qualifier, which is how the driving table is told apart from the joined ones.
 */
const REF_RE = new RegExp(
  `(?:\\b(inner|left|right|full|cross)(?:\\s+outer)?(?:\\s+(?:semi|anti))?\\s+)?\\b(from|join)\\s+(${IDENT}|\\()`,
  "gi"
);

function cleanRef(ref: string): string {
  return ref.replace(/[`[\]"]/g, "").trim().toLowerCase();
}

/** Parenthesised text opening at `open`, plus the index just past its `)`. */
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

interface BlockRef {
  /** A table or CTE name, or the text of a derived table. */
  ref: string;
  derived: string | null;
  /** The first thing the block reads — what its row count is a function of. */
  driving: boolean;
  /** How this block reaches it: the driving `FROM`, or the kind of join written in front of it. */
  joinKind: JoinKind;
}

/** Every table, CTE or derived table this block reads, in the order it reads them. */
function blockRefs(block: string): BlockRef[] {
  const refs: BlockRef[] = [];
  REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = REF_RE.exec(block))) {
    const driving = refs.length === 0;
    // A bare `JOIN` is an inner one; `FROM` is not a join at all.
    const joinKind: JoinKind =
      match[2].toLowerCase() === "from" ? "from" : ((match[1]?.toLowerCase() as JoinKind) ?? "inner");

    if (match[3] === "(") {
      const group = parenContent(block, match.index + match[0].length - 1);
      if (!group) continue;
      refs.push({ ref: "", derived: group.content, driving, joinKind });
      REF_RE.lastIndex = group.end;
      continue;
    }
    refs.push({ ref: cleanRef(match[3]), derived: null, driving, joinKind });
  }

  return refs;
}

const GROUP_BY_RE = /\bgroup\s+by\b/i;
const AGGREGATE_RE = /\b(?:sum|count|avg|min|max|stdev|var|string_agg|collect_set|collect_list)\s*\(/i;

interface BlockGrain {
  changed: boolean;
  columns: string[];
}

/**
 * Whether this block collapses rows, and on what.
 *
 * Only the block's *own* `GROUP BY` and `DISTINCT` count — the ones inside its subqueries belong to
 * those subqueries, and are reached separately when the walk descends into them.
 */
function blockGrain(block: string): BlockGrain {
  // Blanking nested parentheses leaves the block's own keywords and nothing else.
  let flattened = "";
  let depth = 0;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (QUOTE_CLOSERS[ch]) {
      const end = skipQuoted(block, i);
      flattened += " ".repeat(end - i);
      i = end - 1;
      continue;
    }
    if (ch === "(") depth++;
    flattened += depth === 0 ? ch : " ";
    if (ch === ")") depth = Math.max(0, depth - 1);
  }

  const distinct = /\bselect\s+distinct\b/i.test(flattened);
  const groupAt = flattened.search(GROUP_BY_RE);
  // The aggregate test runs on the original text: `MAX(x)` is a call, so its parens are blanked out.
  const aggregated = AGGREGATE_RE.test(block.slice(0, block.search(/\bfrom\b/i) + 1 || block.length));

  if (groupAt < 0) return { changed: distinct || aggregated, columns: [] };

  const after = flattened.slice(groupAt + flattened.slice(groupAt).match(GROUP_BY_RE)![0].length);
  const end = after.search(/\b(?:having|order|union|except|intersect|option|into|for)\b/i);
  const list = end < 0 ? after : after.slice(0, end);

  const columns = splitTopLevel(list, ",")
    .map((item) => cleanRef(item))
    // Only plain columns can be named in a portable check; `GROUP BY YEAR(d)` cannot be reproduced.
    .filter((item) => /^[a-z_][\w$#]*$/.test(item) || /^[a-z_][\w$#]*\.[a-z_][\w$#]*$/.test(item))
    .map((item) => item.split(".").pop()!);

  return { changed: true, columns };
}

// ---- the walk ----

interface Visit {
  block: string;
  driving: boolean;
  grainChanged: boolean;
  /** The innermost `GROUP BY` seen on the way down, which is the grain the base table is read at. */
  grainColumns: string[];
  /**
   * The outermost join on the way down, which is the one that decides what reaches the target. A CTE
   * `LEFT JOIN`ed into the write query contributes its own tables through that left join however they
   * are joined inside it — the outer join is what leaves their columns null.
   */
  joinKind: JoinKind;
  depth: number;
}

/**
 * Follows the write query back through its CTEs and derived tables to the base tables that feed it.
 *
 * A warehouse transformation is a chain — `sales_report` grouped into `customer_date_summary`, joined
 * to a mapping in `mapping_update`, projected in `final`, and only then written — so the tables that
 * matter are several hops from the `INTO`, and which of them drives the rows is decided at every hop.
 */
function walk(start: Visit, ctes: Map<string, string>, found: Map<string, SourceUsage>): void {
  const queue: Visit[] = [start];

  while (queue.length > 0) {
    const visit = queue.shift()!;
    if (visit.depth > MAX_CHAIN_DEPTH) continue;

    const grain = blockGrain(visit.block);
    const grainChanged = visit.grainChanged || grain.changed;
    // The nearest GROUP BY on the way down is the one that set the grain of what this block reads.
    const grainColumns = grain.columns.length > 0 ? grain.columns : visit.grainColumns;

    for (const ref of blockRefs(visit.block)) {
      const driving = visit.driving && ref.driving;
      // Once inside a join, everything below it arrives through that join whatever it says locally.
      const joinKind = visit.joinKind === "from" ? ref.joinKind : visit.joinKind;
      const next = { driving, grainChanged, grainColumns, joinKind, depth: visit.depth + 1 };

      if (ref.derived !== null) {
        queue.push({ block: ref.derived, ...next });
        continue;
      }

      const body = ctes.get(ref.ref);
      if (body !== undefined) {
        queue.push({ block: body, ...next });
        continue;
      }

      const existing = found.get(ref.ref);
      const role: SourceRole = driving ? "driver" : "lookup";
      // A table read twice keeps the stronger relationship: driving anywhere makes it a driver.
      if (existing && existing.role === "driver" && role !== "driver") continue;
      found.set(ref.ref, {
        role,
        joinKind,
        grainChanged: role === "driver" ? grainChanged : existing?.grainChanged ?? grainChanged,
        grainColumns: role === "driver" ? grainColumns : existing?.grainColumns ?? []
      });
    }
  }
}

/** Where in `sql` the statement names `target` as the table it writes. */
const WRITE_RES = [
  /\binto\s+([\w.$#`[\]"]+)/gi,
  /\bcreate\s+(?:or\s+(?:replace|alter)\s+)?(?:external\s+|temp(?:orary)?\s+|global\s+)*table\s+(?:if\s+not\s+exists\s+)?([\w.$#`[\]"]+)/gi,
  /\bmerge\s+(?:into\s+)?([\w.$#`[\]"]+)/gi
];

function writesTarget(text: string, target: string): boolean {
  const wanted = cleanRef(target).split(".").pop();
  for (const re of WRITE_RES) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      if (cleanRef(match[1]).split(".").pop() === wanted) return true;
    }
  }
  return false;
}

/**
 * How the statement uses each table it reads, on the way to writing `targetTable`.
 *
 * Returns null when the statement doesn't visibly write the target — the caller then keeps its
 * existing behaviour rather than acting on an analysis that found nothing to analyse.
 */
export function analyseSourceUsage(rawSql: string, targetTable: string): Map<string, SourceUsage> | null {
  const sql = stripSqlComments(rawSql);
  const writing = splitSubStatements(sql).find((part) => writesTarget(part.text, targetTable));
  if (!writing) return null;

  const ctes = collectCteBodies(writing.text);
  const found = new Map<string, SourceUsage>();
  // The write query itself is everything after the last CTE body, which `blockRefs` reaches by
  // skipping what `collectCteBodies` already consumed — passing the whole text is equivalent, since
  // a CTE reached from the outer query is followed anyway and one that isn't contributes nothing.
  walk(
    { block: outerQuery(writing.text, ctes), driving: true, grainChanged: false, grainColumns: [], joinKind: "from", depth: 0 },
    ctes,
    found
  );

  return found;
}

/**
 * The statement text with its `WITH` bodies removed, so `blockRefs` sees the outer query's own FROM
 * rather than the first CTE's. The bodies are still followed — `walk` looks them up by name.
 */
function outerQuery(sql: string, ctes: Map<string, string>): string {
  let text = sql;
  for (const body of ctes.values()) {
    const at = text.indexOf(body);
    if (at >= 0) text = `${text.slice(0, at)}${" ".repeat(body.length)}${text.slice(at + body.length)}`;
  }
  return text;
}

/**
 * Merges the usage found across every statement that writes the target. A table that drives the rows
 * in one of them drives them, and one no statement reaches on its way to the target is incidental.
 */
export function mergeUsage(perStatement: (Map<string, SourceUsage> | null)[]): Map<string, SourceUsage> | null {
  const analysed = perStatement.filter((entry): entry is Map<string, SourceUsage> => entry !== null);
  if (analysed.length === 0) return null;

  const merged = new Map<string, SourceUsage>();
  for (const usage of analysed) {
    for (const [table, entry] of usage) {
      const existing = merged.get(table);
      if (!existing || (existing.role !== "driver" && entry.role === "driver")) merged.set(table, entry);
    }
  }
  return merged;
}
