import { columnRole, counterpart } from "./reconciliationScripts.js";
import type { ReconLayerFacts, ReconTargetFacts } from "./reconciliationScripts.js";
import type { ColumnInfo, ColumnKind, ColumnTerm } from "./sqlColumns.js";

/**
 * What a **reporting** table's own columns say about the business, read out of the project's SQL.
 *
 * The reconciliation the other three writers do is between tables: this column of the target against
 * the column it was built from. A data mart's last table is not mostly reconcilable that way, and the
 * reason is structural rather than a gap in the parsing. `rpt_snowball` holds `bop_arr`,
 * `customer_churn`, `product_churn`, `downsell`, `upsell`, `cross_sell`, `new_customer` and `eop_arr`
 * — **eight columns derived from one upstream column**, `fact_arr.arr`. Not one of them exists in any
 * source table, so column-against-source reconciliation has nothing to pair them with and passes over
 * the whole report in silence. Meanwhile the checks that would actually catch a broken snowball are
 * all *internal*: the movements have to add up to the closing balance, the closing balance has to
 * become the next period's opening balance, and the subtotals the code names — `grr`, `nrr` — have to
 * equal the columns they are declared to be the sum of.
 *
 * So this file reads three kinds of business fact, and they differ in how much is derived and how
 * much is convention:
 *
 * - **Stated identities** are not read at all, they are *quoted*. `bop_arr + customer_churn +
 *   product_churn + downsell AS grr` is the project asserting what `grr` is. `sqlColumns.additiveTerms`
 *   decomposes it and the check restates the assertion as SQL. Nothing here can be wrong about it
 *   without the SQL being wrong about it.
 * - **The walk** — opening plus movements equals closing — is the rule every snowball, waterfall,
 *   bridge and roll-forward report obeys, and no report states it, because the whole table *is* the
 *   statement. It is recognised from the columns' names, which is a reading; what keeps it honest is
 *   that the signs come from a stated identity wherever the project has one, so a project storing its
 *   churn as a negative number gets a walk that adds and one storing it positive gets a walk that
 *   subtracts, without anybody having to assume which.
 * - **The trace** is lineage: one business measure followed table by table from the report back to the
 *   raw feed, through the same `ReconField` pairs the per-layer reports use, so a rename along the way
 *   (`amount` -> `revenue` -> `arr`) is followed rather than breaking the chain.
 *
 * Everything is scoped by the report's own **slice** — the column whose two or three literal values the
 * SQL writes into it (`'LM'`, `'LTM'`) — because a report that unions its period windows into one
 * table holds every row more than once, and a total across the whole table is the sum of two different
 * questions.
 */

// ---- what the words mean ----

/**
 * Words that mark a balance at the edge of a period.
 *
 * Matched as whole segments at either end rather than as string prefixes, so `bop_arr` and `arr_bop`
 * both read and `openings_count` — whose `openings` is a different word — does not.
 */
const OPENING_WORDS = new Set(["bop", "opening", "open", "beg", "begin", "beginning", "start", "starting"]);
const CLOSING_WORDS = new Set(["eop", "closing", "close", "end", "ending", "closed", "final"]);

/**
 * Words that name a *movement* in a balance rather than a balance.
 *
 * Any segment counts, not only the head noun, because a movement column is named after what moved and
 * that is rarely the last word: `customer_churn` and `cross_sell` put it at either end, and
 * `new_customer` puts the movement first and the entity last. That is the opposite of `columnRole`'s
 * head-noun rule, and deliberately so — `columnRole` decides whether totalling a column means anything,
 * which the head noun answers, while this decides whether a column is one of the arrows in a waterfall,
 * which the whole name answers.
 *
 * The measure test keeps it honest: a column has to be summable *and* carry one of these words before
 * it can join a walk, so `new_customer_flag` and `churn_reason` never do.
 */
const MOVEMENT_WORDS = new Set([
  "churn", "churned", "upsell", "downsell", "cross", "sell", "sold", "new", "lost", "loss", "won",
  "win", "expansion", "contraction", "acquisition", "acquired", "attrition", "reactivation",
  "reactivated", "renewal", "renewed", "adjustment", "migration", "uplift", "shrink", "cancelled",
  "cancellation", "addition", "removal", "movement", "inflow", "outflow"
]);

/** Tokens that make a column a point in the reporting calendar. */
const PERIOD_WORDS = ["date", "month", "period", "quarter", "week", "year", "day", "fiscal", "calendar"];

/**
 * Timestamps a load wrote, which look like period columns and are not.
 *
 * `last_refresh` is a date on every row of the snowball, and grouping by it gives one slice per run of
 * the pipeline rather than one per month — not merely a worse check, but a check whose every row
 * answers a different question from the one the reader thinks they asked.
 */
const BOOKKEEPING_WORDS = new Set([
  "refresh", "refreshed", "load", "loaded", "insert", "inserted", "update", "updated", "modified",
  "created", "etl", "batch", "run", "processed", "ingested", "extract", "extracted", "audit"
]);

/** Name tokens that mark the column a report is sliced by, ahead of any other column with literals. */
const SLICE_WORDS = ["period", "type", "scenario", "version", "basis", "frequency", "grain", "window", "view"];

/**
 * How many periods back a slice's opening balance was the closing balance, by the code the slice uses.
 *
 * This is convention, not derivation, and it is the one place in this file that is. A slice holding a
 * single month has last month's closing balance as its opening balance; a slice holding a rolling
 * twelve-month window has the closing balance of twelve periods ago as its opening balance — which is
 * exactly the `DATEADD(MONTH, -12, ...)` an analyst writes by hand to check one. Nothing in the SQL
 * says which of the two a value like `'LTM'` is; the string is a label the report's author chose. So it
 * is recognised from the label, and a label not in this table gets **no** continuity check rather than
 * a wrong one. The window frames the SQL really uses (`ROWS BETWEEN 11 PRECEDING`) are read as
 * corroboration by `windowWidthsIn` and printed beside the check.
 */
const SLICE_LAG: Record<string, number> = {
  lm: 1, cm: 1, mtd: 1, m: 1, month: 1, monthly: 1, single: 1, current: 1, pm: 1,
  ltm: 12, ttm: 12, r12: 12, l12m: 12, rtm: 12, rolling12: 12, ly: 12, yoy: 12, annual: 12, yearly: 12,
  lq: 3, qtd: 3, q: 3, quarter: 3, quarterly: 3
};

function segments(name: string): string[] {
  return name.split("_").filter(Boolean);
}

/** `bop_arr` -> `arr`, `arr_eop` -> `arr`: the measure a period-edge balance is a balance *of*. */
function balanceOf(name: string, words: Set<string>): string | null {
  const parts = segments(name);
  if (parts.length < 2) return null;
  if (words.has(parts[0])) return parts.slice(1).join("_");
  if (words.has(parts[parts.length - 1])) return parts.slice(0, -1).join("_");
  return null;
}

function isMovementName(name: string): boolean {
  return segments(name).some((segment) => MOVEMENT_WORDS.has(segment));
}

// ---- the facts ----

/** A column the project's own SQL declares to be the sum of other columns of the same table. */
export interface StatedIdentity {
  /** The column the expression is assigned to — `nrr`. */
  column: string;
  /** Its terms, in the order written, with the sign each carries. */
  terms: ColumnTerm[];
  /** The expression restated for the header: `bop_arr + customer_churn + product_churn + downsell`. */
  expression: string;
}

/**
 * A roll-forward: an opening balance, the movements in between, and the closing balance they reach.
 *
 * `term` is the business measure all of them measure — `arr` — which is the answer to "many derived
 * columns, derived from what".
 */
export interface MeasureWalk {
  term: string;
  opening: string;
  closing: string;
  /** In the order the table declares them, each with the sign the walk adds it with. */
  movements: ColumnTerm[];
  /**
   * The stated identity the signs came from, or null when nothing stated one and every movement is
   * therefore added as stored. Named in the header, because it is the difference between a derived sign
   * convention and an assumed one.
   */
  signedBy: string | null;
  /** Movement columns no stated identity covered, so their sign is the default. */
  assumed: string[];
}

/** The column a report is cut by, and the values its own SQL writes into it. */
export interface BusinessSlice {
  column: string;
  /** Unquoted — `LM`, `LTM`. */
  values: string[];
  /** Periods back a slice's opening balance was a closing balance, by `SLICE_LAG`. Null when unknown. */
  lags: Record<string, number | null>;
}

/** One table a business measure passes through on its way to the report. */
export interface TraceStep {
  table: string;
  column: string;
  /** The layer that table belongs to, or null when no layer claims it. */
  layer: string | null;
  /** Nothing declares the column numeric, so its total goes through a try-conversion. */
  untyped: boolean;
}

/**
 * One business measure followed from the report back to where it entered the pipeline.
 *
 * The steps are in pipeline order — the outermost source first, the report last — which is the order
 * they are read in and the order the totals are compared in.
 */
export interface MeasureTrace {
  term: string;
  steps: TraceStep[];
}

export interface BusinessFacts {
  table: string;
  /** The layer this table reports from. */
  layer: string;
  /**
   * The report's own columns, as the project's SQL declares or builds them.
   *
   * Carried so the writer never has to look them up again, and so the one thing it needs from them —
   * whether a column is *declared* numeric, which decides whether its total goes through a
   * try-conversion — is answered from the same reading every check on this table was derived from.
   */
  columns: ColumnInfo[];
  walks: MeasureWalk[];
  identities: StatedIdentity[];
  traces: MeasureTrace[];
  /** The column every check groups by — `date_key`. Null when the report has no period column. */
  periodColumn: string | null;
  slice: BusinessSlice | null;
  /** Rolling window widths the SQL behind this table really uses, as corroboration for `SLICE_LAG`. */
  windowWidths: number[];
  /** What could not be derived, and why — carried into the file's header rather than dropped. */
  notes: string[];
  /** Filename this report takes inside the business folder. */
  filename: string;
}

// ---- reading one report table ----

/** Only a summable column can be a term of a walk: a flag or a reason code is never one of its arrows. */
function isMeasure(column: ColumnInfo): boolean {
  return columnRole(column) === "measure";
}

function statedIdentities(columns: ColumnInfo[]): { identities: StatedIdentity[]; dropped: string[] } {
  const present = new Set(columns.map((c) => c.name));
  const identities: StatedIdentity[] = [];
  const dropped: string[] = [];

  for (const column of columns) {
    if (!column.terms || column.terms.length < 2) continue;
    // A term naming something the table has not got is a column of a CTE that never reached it — the
    // arithmetic is real, but it cannot be restated against the table, so it is not a check.
    const missing = column.terms.filter((term) => !present.has(term.column)).map((term) => term.column);
    if (missing.length > 0) {
      dropped.push(
        `${column.name} (built from ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} ` +
          "not a column of this table)"
      );
      continue;
    }
    identities.push({
      column: column.name,
      terms: column.terms,
      expression: column.terms
        .map((term, i) => `${i === 0 ? (term.sign < 0 ? "-" : "") : term.sign < 0 ? " - " : " + "}${term.column}`)
        .join("")
    });
  }

  return { identities, dropped };
}

/**
 * The roll-forwards the table's columns describe: for each measure with a period-edge balance at both
 * ends, the movements in between.
 *
 * The movements are every summable column carrying a movement word that is neither balance and not
 * itself a stated identity. Excluding the identities is what keeps a subtotal out of the walk it is a
 * subtotal *of*: `nrr` is `bop_arr` plus five of the six movements, and adding it alongside them counts
 * every one of those five twice.
 */
function walksIn(columns: ColumnInfo[], identities: StatedIdentity[]): MeasureWalk[] {
  const measures = columns.filter(isMeasure);
  const subtotals = stated(identities);

  const openings = new Map<string, string>();
  const closings = new Map<string, string>();
  for (const column of measures) {
    const opening = balanceOf(column.name, OPENING_WORDS);
    if (opening && !openings.has(opening)) openings.set(opening, column.name);
    const closing = balanceOf(column.name, CLOSING_WORDS);
    if (closing && !closings.has(closing)) closings.set(closing, column.name);
  }

  const walks: MeasureWalk[] = [];
  for (const [term, opening] of openings) {
    const closing = closings.get(term);
    if (!closing || closing === opening) continue;

    const candidates = measures.filter(
      (column) =>
        column.name !== opening &&
        column.name !== closing &&
        !subtotals.has(column.name) &&
        isMovementName(column.name)
    );
    if (candidates.length === 0) continue;

    // The signs come from whichever stated identity opens with this balance and covers the most
    // movements — the project saying, in its own SQL, which direction each one is stored in.
    const signs = new Map<string, 1 | -1>();
    let signedBy: string | null = null;
    let covered = 0;
    for (const identity of identities) {
      const opens = identity.terms.find((term) => term.column === opening);
      if (!opens) continue;
      const hits = identity.terms.filter((term) => candidates.some((c) => c.name === term.column));
      if (hits.length <= covered) continue;
      covered = hits.length;
      signedBy = identity.column;
      signs.clear();
      // Read relative to the opening balance, so an identity written `-bop_arr - churn` still says
      // churn sits on the same side of the walk as the opening balance does.
      for (const term of hits) signs.set(term.column, (term.sign * opens.sign) as 1 | -1);
    }

    walks.push({
      term,
      opening,
      closing,
      movements: candidates.map((column) => ({ column: column.name, sign: signs.get(column.name) ?? 1 })),
      signedBy,
      assumed: candidates.filter((column) => !signs.has(column.name)).map((column) => column.name)
    });
  }

  return walks;
}

/** The column the report is cut by: the one its own SQL writes more than one literal into. */
function sliceIn(columns: ColumnInfo[]): BusinessSlice | null {
  const candidates = columns.filter((column) => (column.literals?.length ?? 0) > 1);
  if (candidates.length === 0) return null;

  const rank = (column: ColumnInfo) =>
    segments(column.name).some((segment) => SLICE_WORDS.includes(segment)) ? 0 : 1;
  const chosen = candidates.slice().sort((a, b) => rank(a) - rank(b))[0];

  const values = (chosen.literals ?? []).map((literal) => literal.replace(/^'|'$/g, "").replace(/''/g, "'"));
  return {
    column: chosen.name,
    values,
    lags: Object.fromEntries(
      values.map((value) => [value, SLICE_LAG[value.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? null])
    )
  };
}

/** The date the report is reported *as at*, as against the timestamp its last load wrote. */
function periodColumnIn(columns: ColumnInfo[], slice: BusinessSlice | null): string | null {
  const ranked = columns
    .filter((column) => column.name !== slice?.column)
    .filter((column) => !segments(column.name).some((segment) => BOOKKEEPING_WORDS.has(segment)))
    .map((column) => ({
      column,
      rank: Math.min(
        ...segments(column.name).map((segment) => {
          const at = PERIOD_WORDS.indexOf(segment);
          return at < 0 ? Number.POSITIVE_INFINITY : at;
        })
      )
    }))
    .filter((entry) => Number.isFinite(entry.rank))
    .sort((a, b) => a.rank - b.rank);

  return ranked[0]?.column.name ?? null;
}

const WINDOW_FRAME_RE = /\brows\s+between\s+(\d+)\s+preceding\b/gi;

/** Rolling window widths the statements behind a table use — `11 PRECEDING AND CURRENT ROW` is 12. */
function windowWidthsIn(target: ReconTargetFacts): number[] {
  const widths = new Set<number>();
  for (const fact of target.facts) {
    WINDOW_FRAME_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WINDOW_FRAME_RE.exec(fact.rawSql))) widths.add(Number(match[1]) + 1);
  }
  return Array.from(widths).sort((a, b) => a - b);
}

// ---- following one measure back up the pipeline ----

/** How far back a measure is followed. Past this the chain is a different pipeline, not a history. */
const MAX_TRACE_STEPS = 8;
/**
 * Measures traced per report.
 *
 * A wide mart table carries thirty of them and their traces are the same chain thirty times over, since
 * they were all built by one statement out of one source. The walks' own terms are traced first, so the
 * cap never costs the measure the report is actually about.
 */
const MAX_TRACES = 6;

/** The columns a stated identity computes — a subtotal's trace is its terms' traces added up. */
function stated(identities: StatedIdentity[]): Set<string> {
  return new Set(identities.map((identity) => identity.column));
}

/**
 * Kinds a measure may legitimately change between as it moves down the pipeline.
 *
 * A trace is not a join and never becomes one: it totals one column at each table and compares the
 * totals, so a `varchar` amount in a raw feed and the `decimal` it is cast to in staging are the same
 * measure and the comparison across them is the whole point — it is where the cast that silently
 * dropped a thousand rows shows up. That is why this is looser than the `kindsConflict` rule the
 * per-column reports use: there, the two columns are joined on, and joining text to a number fails.
 *
 * A date or a boolean is a different matter. Those are not a measure written in another type, they are
 * another column with the same name, and following one turns the trace into a chain of unrelated
 * totals.
 */
function traceable(a: ColumnKind, b: ColumnKind): boolean {
  if (a === b) return true;
  const summable = new Set<ColumnKind>(["numeric", "text", "other"]);
  return summable.has(a) && summable.has(b);
}

/**
 * One business measure from the report back to where it entered the project.
 *
 * Each step follows the same `counterpart` rule the per-column reports pair a column with — what the
 * transformation says this column was built from, and failing that the column of the same name — so a
 * rename is followed rather than ending the chain: `rpt_monthly_revenue.revenue` came from
 * `fact_arr.revenue`, which came from `trn_revenue.revenue`, which came from `stage.sales_report.revenue`,
 * which came from `raw.sales_report.amount`. Stopping at the first table nothing in the project builds
 * is what makes the first step the raw feed rather than an arbitrary depth.
 *
 * The driving source is preferred at each hop: a measure joined in from a lookup is that lookup's own
 * total over its own population, which is a different number and not a step in this measure's history.
 */
function traceMeasure(
  table: string,
  column: ColumnInfo,
  byTable: Map<string, ReconTargetFacts>,
  layerOf: (table: string) => string | null
): TraceStep[] {
  const steps: TraceStep[] = [
    { table, column: column.name, layer: layerOf(table), untyped: column.kind !== "numeric" }
  ];
  const seen = new Set([table.toLowerCase()]);

  let current = table;
  let currentColumn = column;
  while (steps.length < MAX_TRACE_STEPS) {
    const facts = byTable.get(current.toLowerCase());
    if (!facts) break;

    const sources = facts.perSource
      .slice()
      .sort((a, b) => (a.role === "driver" ? 0 : 1) - (b.role === "driver" ? 0 : 1));

    const hop = sources.flatMap((entry) => {
      if (seen.has(entry.source.toLowerCase())) return [];
      const columns = byTable.get(entry.source.toLowerCase())?.columns?.columns ?? [];
      if (columns.length === 0) return [];
      const origin = counterpart(currentColumn, new Map(columns.map((c) => [c.name, c])));
      if (!origin || !traceable(currentColumn.kind, origin.kind)) return [];
      return [{ source: entry.source, origin }];
    })[0];
    if (!hop) break;

    seen.add(hop.source.toLowerCase());
    steps.push({
      table: hop.source,
      column: hop.origin.name,
      layer: layerOf(hop.source),
      untyped: hop.origin.kind !== "numeric"
    });
    current = hop.source;
    currentColumn = hop.origin;
  }

  // Built report-first because that is the direction lineage is followed in, and read raw-first
  // because that is the direction the pipeline runs.
  return steps.reverse();
}

// ---- the report tables of a project ----

/**
 * Whether this table is one the pipeline *reports from*, as opposed to one it builds on the way.
 *
 * Terminal is the fact and the name is at most corroboration, so only the fact is used. Nothing in the
 * project reading a table means the pipeline ends there whatever it is called, while a table called
 * `rpt_something` that four other tables read is a staging step with a misleading name — and a walk
 * checked on it is a walk checked on an intermediate result.
 */
function isReportingTable(table: string, readTables: Set<string>): boolean {
  return !readTables.has(table.toLowerCase());
}

function bareTable(table: string): string {
  return table.split(".").pop() ?? table;
}

/**
 * Everything the reporting tables of one project say about the business.
 *
 * Driven off `ReconLayerFacts` rather than off the project directly, so the tables, their columns,
 * their sources and their per-column pairings are the same ones the per-layer reports reconcile: two
 * generated files describing one table have to be describing the same reading of it.
 */
export function gatherBusinessFacts(layers: ReconLayerFacts[]): BusinessFacts[] {
  const byTable = new Map<string, ReconTargetFacts>();
  const layerByTable = new Map<string, string>();
  const readTables = new Set<string>();

  for (const layer of layers) {
    for (const target of layer.targets) {
      byTable.set(target.target.toLowerCase(), target);
      layerByTable.set(target.target.toLowerCase(), layer.label);
      for (const entry of target.perSource) readTables.add(entry.source.toLowerCase());
      for (const source of target.incidentalSources) readTables.add(source.toLowerCase());
    }
  }
  const layerOf = (table: string) => layerByTable.get(table.toLowerCase()) ?? null;

  const out: BusinessFacts[] = [];
  const used = new Set<string>();

  for (const layer of layers) {
    for (const target of layer.targets) {
      if (!isReportingTable(target.target, readTables)) continue;

      const columns = target.columns?.columns ?? [];
      const { identities, dropped } = statedIdentities(columns);
      const walks = walksIn(columns, identities);
      const slice = sliceIn(columns);
      const periodColumn = periodColumnIn(columns, slice);

      // A trace per walk first, following the measure the walk is *about* rather than either of its
      // balances — `eop_arr` exists in no source table, and `arr` is the name the pipeline carried —
      // and then every other measure the report holds, which is where a report with no roll-forward in
      // it at all still gets its business term followed back to the feed it came from.
      const traced = new Set<string>();
      const traces: MeasureTrace[] = [];
      const subtotals = stated(identities);
      const addTrace = (term: string, name: string) => {
        const column = columns.find((candidate) => candidate.name === name);
        if (!column || traced.has(name) || traces.length >= MAX_TRACES) return;
        traced.add(name);
        const steps = traceMeasure(target.target, column, byTable, layerOf);
        if (steps.length > 1) traces.push({ term, steps });
      };

      for (const walk of walks) {
        const carried = columns.some((column) => column.name === walk.term && isMeasure(column));
        addTrace(walk.term, carried ? walk.term : walk.closing);
      }
      for (const column of columns) {
        if (isMeasure(column) && !subtotals.has(column.name)) addTrace(column.name, column.name);
      }

      // Two reports of the same bare name in different schemas would otherwise overwrite each other.
      let filename = `${bareTable(target.target)}.sql`;
      if (used.has(filename.toLowerCase())) filename = `${target.target.replace(/\./g, "_")}.sql`;
      used.add(filename.toLowerCase());

      out.push({
        table: target.target,
        layer: layer.label,
        columns,
        walks,
        identities,
        traces,
        periodColumn,
        slice,
        windowWidths: windowWidthsIn(target),
        notes: notesFor(target.target, columns.length, walks, identities, dropped, slice, periodColumn),
        filename
      });
    }
  }

  return out;
}

/** Everything about this report that a check could not be written for, said rather than dropped. */
function notesFor(
  table: string,
  columnCount: number,
  walks: MeasureWalk[],
  identities: StatedIdentity[],
  dropped: string[],
  slice: BusinessSlice | null,
  periodColumn: string | null
): string[] {
  const notes: string[] = [];

  if (columnCount === 0) {
    notes.push(
      `No column list could be recovered for ${table}, so nothing about what it reports could be read. ` +
        "Add its CREATE TABLE to the project, or the statement that builds it with a named select " +
        "list, and the business checks follow from that."
    );
    return notes;
  }

  if (dropped.length > 0) {
    notes.push(
      `${dropped.join("; ")} — the arithmetic is in the code but names something that is not a column ` +
        "of the finished table, so it cannot be restated as a check against it."
    );
  }
  if (walks.length === 0) {
    notes.push(
      "No roll-forward could be read from these columns. That needs an opening and a closing balance " +
        "of the same measure — named bop_/eop_, opening_/closing_ or similar — with movement columns " +
        "between them."
    );
  }
  if (identities.length === 0) {
    notes.push(
      "No column of this table is written as a sum of its other columns, so there is no subtotal " +
        "identity to restate. Only expressions that are nothing but additions and subtractions of " +
        "plain columns count: a CASE or a window function is not an identity."
    );
  }
  if (slice === null) {
    notes.push(
      "No slice column was found — no column of this table is written with more than one literal value " +
        "by the SQL that builds it — so every check below is taken over the whole table. If it does " +
        "hold more than one kind of period row, filter it yourself before reading the result."
    );
  }
  if (periodColumn === null) {
    notes.push(
      "No reporting period column was found, so the checks compare whole-table totals rather than one " +
        "period at a time. A roll-forward only balances within a period, so read a difference here as " +
        "the periods being mixed rather than as a break."
    );
  }

  for (const walk of walks) {
    if (walk.signedBy === null) {
      notes.push(
        `Nothing in the code states how ${walk.term}'s movements combine, so the walk adds every one of ` +
          `them to ${walk.opening} as stored. If this report holds its churn and downsell as positive ` +
          "numbers they have to be subtracted instead, and the check will be out by twice their total."
      );
    } else if (walk.assumed.length > 0) {
      notes.push(
        `${walk.assumed.join(", ")} ${walk.assumed.length === 1 ? "is" : "are"} added to the ` +
          `${walk.term} walk as stored: ${walk.signedBy} gave the sign of every other movement and does ` +
          `not include ${walk.assumed.length === 1 ? "this one" : "these"}.`
      );
    }
  }

  if (slice) {
    const unknown = Object.entries(slice.lags)
      .filter(([, lag]) => lag === null)
      .map(([value]) => value);
    if (unknown.length > 0) {
      notes.push(
        `${unknown.join(", ")} — nothing says how long a period of this kind is, so the opening balance ` +
          `of one is not checked against the closing balance of an earlier one. Every ${slice.column} ` +
          "whose length is known is checked; add the rest by hand if you know the window."
      );
    }
  }

  return notes;
}

/** Whether a report has anything to check at all — a walk, a stated identity, or a measure to trace. */
export function hasBusinessChecks(facts: BusinessFacts): boolean {
  return facts.walks.length > 0 || facts.identities.length > 0 || facts.traces.length > 0;
}
