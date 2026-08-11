import type { LocalProject } from "./localProject.js";

/**
 * Which SQL engine the generated scripts are meant to run on.
 *
 * Everything Recon emits was portable by construction — no `TOP`, no `LIMIT`, no vendor functions —
 * which is the right default and not always the right answer. Portable SQL is a subset, and the
 * places it costs something are real: a measure whose type nothing declares has to be totalled
 * through a try-conversion, and Snowflake does not have the one SQL Server and Databricks share:
 * its `TRY_CAST` is defined for string input only, and `TRY_TO_DECIMAL` is what it uses instead. The reviewer model has the same problem from
 * the other side — told to write portable SQL it avoids the function that would actually express the
 * check, and told nothing it guesses a dialect.
 *
 * So the platform is asked for rather than assumed, with the project's own SQL supplying the default.
 */
export type SqlPlatform = "portable" | "snowflake" | "sqlserver" | "databricks";

export const SQL_PLATFORMS: readonly SqlPlatform[] = ["portable", "snowflake", "sqlserver", "databricks"];

const LABELS: Record<SqlPlatform, string> = {
  portable: "portable (runs on all three)",
  snowflake: "Snowflake",
  sqlserver: "SQL Server / Azure SQL",
  databricks: "Databricks SQL"
};

export function platformLabel(platform: SqlPlatform): string {
  return LABELS[platform];
}

/** Parses a `--platform` value, accepting the spellings people actually type. */
export function parsePlatform(value: string): SqlPlatform | null {
  const name = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["snowflake", "sf"].includes(name)) return "snowflake";
  if (["sqlserver", "mssql", "tsql", "transactsql", "azuresql", "synapse"].includes(name)) return "sqlserver";
  if (["databricks", "spark", "sparksql", "databrickssql", "delta"].includes(name)) return "databricks";
  if (["portable", "any", "ansi", "generic"].includes(name)) return "portable";
  return null;
}

/**
 * Markers that identify an engine from the project's own SQL, weighted by how much each one proves.
 *
 * A `3` is written by no other engine — `QUALIFY` and `SEQ4()` are Snowflake, `ON [PRIMARY]` and a
 * bare `GO` batch separator are SQL Server, `ZORDER` is Databricks. A `1` is suggestive and shared:
 * `CREATE OR REPLACE TABLE` is Snowflake *and* Databricks, `::` casting is Snowflake and recent
 * Databricks, so neither can carry a decision on its own but both are worth counting.
 */
const MARKERS: { platform: Exclude<SqlPlatform, "portable">; weight: number; re: RegExp }[] = [
  // Snowflake
  { platform: "snowflake", weight: 3, re: /\bqualify\s/i },
  { platform: "snowflake", weight: 3, re: /\bseq[1248]\s*\(/i },
  { platform: "snowflake", weight: 3, re: /\bgenerator\s*\(\s*rowcount/i },
  { platform: "snowflake", weight: 3, re: /\btry_to_(?:decimal|number|double|date|timestamp|boolean)\s*\(/i },
  { platform: "snowflake", weight: 3, re: /\blateral\s+flatten\s*\(/i },
  { platform: "snowflake", weight: 3, re: /\bcurrent_warehouse\s*\(/i },
  { platform: "snowflake", weight: 2, re: /\bcopy\s+into\s/i },
  { platform: "snowflake", weight: 2, re: /\biff\s*\(/i },
  { platform: "snowflake", weight: 2, re: /\bto_varchar\s*\(/i },
  { platform: "snowflake", weight: 1, re: /\blistagg\s*\(/i },
  { platform: "snowflake", weight: 1, re: /::\s*[a-z]/i },

  // SQL Server / Azure SQL
  { platform: "sqlserver", weight: 3, re: /^\s*go\s*$/im },
  { platform: "sqlserver", weight: 3, re: /\bon\s+\[primary\]/i },
  { platform: "sqlserver", weight: 3, re: /\btry_convert\s*\(/i },
  { platform: "sqlserver", weight: 3, re: /\bobject_id\s*\(/i },
  { platform: "sqlserver", weight: 3, re: /\bwith\s*\(\s*nolock\s*\)/i },
  { platform: "sqlserver", weight: 2, re: /\bnvarchar\b/i },
  { platform: "sqlserver", weight: 2, re: /\bisnull\s*\(/i },
  { platform: "sqlserver", weight: 2, re: /\bgetdate\s*\(\s*\)/i },
  { platform: "sqlserver", weight: 2, re: /\bselect\s+top\s/i },
  { platform: "sqlserver", weight: 1, re: /\[[a-z_][a-z0-9_]*\]\.\[/i },

  // Databricks SQL / Spark
  { platform: "databricks", weight: 3, re: /\bzorder\s+by\b/i },
  { platform: "databricks", weight: 3, re: /\busing\s+delta\b/i },
  { platform: "databricks", weight: 3, re: /\bspark\.(?:sql|table|read)\b/i },
  { platform: "databricks", weight: 3, re: /^#\s*MAGIC\s+%sql/im },
  { platform: "databricks", weight: 2, re: /\boptimize\s+[a-z0-9_.`]+\s*(?:zorder|;|$)/im },
  { platform: "databricks", weight: 2, re: /\bsaveastable\s*\(/i },
  { platform: "databricks", weight: 2, re: /\.write\.(?:format|mode)\s*\(/i },
  { platform: "databricks", weight: 1, re: /\bexplode\s*\(/i },
  { platform: "databricks", weight: 1, re: /`[a-z_][a-z0-9_]*`\./i }
];

export interface PlatformGuess {
  platform: SqlPlatform;
  /** What in the SQL pointed at it, most telling first — printed beside the question. */
  evidence: string[];
}

/**
 * The engine this project's SQL was written for, as far as the SQL says.
 *
 * A default for the question rather than an answer to it: the same project can be deployed to a
 * different engine than it was written against, and a folder of plain `SELECT`s says nothing at all.
 * A tie is not a guess — two engines scoring the same means the evidence does not distinguish them,
 * and `portable` is the honest reading of that.
 */
export function detectPlatform(project: LocalProject): PlatformGuess {
  const scores = new Map<SqlPlatform, number>();
  const evidence: { weight: number; text: string }[] = [];

  for (const file of project.files) {
    for (const marker of MARKERS) {
      const hit = marker.re.exec(file.content);
      if (!hit) continue;
      scores.set(marker.platform, (scores.get(marker.platform) ?? 0) + marker.weight);
      evidence.push({
        weight: marker.weight,
        text: `${platformLabel(marker.platform)}: \`${hit[0].trim().replace(/\s+/g, " ").slice(0, 40)}\` in ${file.path}`
      });
    }
  }

  const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  const [best, runnerUp] = ranked;
  const platform = best && (!runnerUp || best[1] > runnerUp[1]) ? best[0] : "portable";

  return {
    platform,
    evidence: evidence
      .filter((e) => platform === "portable" || e.text.startsWith(platformLabel(platform)))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((e) => e.text)
  };
}

/**
 * The expression a measure of unknown type is totalled through, per engine.
 *
 * `SUM` over a text column is a hard error rather than a wrong answer, and it takes every check after
 * it in the file down with it — so an undeclared column is converted first, in the one form that
 * yields NULL instead of failing.
 *
 * Snowflake gets a different function, not a different spelling of the same one. `TRY_CAST` is
 * fragile there — it is defined for string input only, so it raises "invalid argument types" the
 * moment the column turns out to be numeric after all — while `TRY_TO_DECIMAL` is the native
 * try-conversion and takes the precision and scale as arguments rather than as a type. Wrapping the
 * column in `TO_VARCHAR` first makes it valid whatever the column really holds, which is the whole
 * point of the conversion.
 */
export function measureCast(platform: SqlPlatform, column: string, type: string): string {
  if (platform !== "snowflake") return `TRY_CAST(${column} AS ${type})`;
  const digits = type.match(/\((\d+)\s*,\s*(\d+)\)/);
  return digits
    ? `TRY_TO_DECIMAL(TO_VARCHAR(${column}), ${digits[1]}, ${digits[2]})`
    : `TRY_TO_DECIMAL(TO_VARCHAR(${column}))`;
}

/** The line every generated file carries saying what it was written to run on. */
export function platformNote(platform: SqlPlatform): string {
  return platform === "portable"
    ? "Portable SQL — no TOP/LIMIT, no vendor functions — so it runs unchanged on SQL Server, Snowflake and Databricks SQL."
    : `Written for ${platformLabel(platform)}. Re-run with --platform to target a different engine.`;
}

/**
 * What the reviewer model is told about the engine it is writing for.
 *
 * Worth being specific rather than just naming the platform: told only "portable" a model avoids the
 * function that would actually express a check, and told only "Snowflake" it still reaches for
 * `TOP`. Each of these names the trap that engine invites.
 */
export function platformRule(platform: SqlPlatform): string {
  switch (platform) {
    case "snowflake":
      return (
        "Write Snowflake SQL. Snowflake functions are allowed and preferred where they express the check " +
        "better (QUALIFY, IFF, LISTAGG, ::casts). Do not use TOP, ISNULL, GETDATE, TRY_CONVERT or " +
        "square-bracket identifiers — those are SQL Server. Do not use TRY_CAST either: it is defined " +
        "for string input only and errors on anything else. To convert a column whose type you are not " +
        "sure of, use TRY_TO_DECIMAL(TO_VARCHAR(col), 38, 6) — or TRY_TO_NUMBER, TRY_TO_DATE, " +
        "TRY_TO_TIMESTAMP for the other types."
      );
    case "sqlserver":
      return (
        "Write SQL Server (T-SQL). T-SQL functions are allowed and preferred where they express the check " +
        "better (TRY_CONVERT, ISNULL, IIF, STRING_AGG). Do not use LIMIT, QUALIFY, IFF or ::casts — those " +
        "are other engines. Use TOP only inside a subquery that has its own ORDER BY."
      );
    case "databricks":
      return (
        "Write Databricks SQL. Spark functions are allowed and preferred where they express the check " +
        "better (date_format, explode, named_struct). Do not use TOP, ISNULL, GETDATE or QUALIFY. " +
        "Remember a FULL OUTER JOIN must join on an equality — Spark rejects any other condition."
      );
    case "portable":
      return (
        "Portable SQL only: no TOP, no LIMIT, no temp tables, no vendor-specific functions, nothing " +
        "that runs on one engine and not another. It has to run on SQL Server, Snowflake and Databricks " +
        "SQL alike."
      );
  }
}
