/**
 * Where `reconcile scripts` puts what it writes, named once.
 *
 * The command produces three different readings of the same pipeline and they answer different
 * questions, so they do not share a folder:
 *
 * - **High level recon** — one query per hop (`reconciliationBundle.ts`). Does this pair of layers
 *   tie out? One row per check, run it and read the `status` column.
 * - **Logical recon** — one query per layer (`layerReconciliation.ts`). For every column of every
 *   table in the layer, does it still agree with the column it was built from?
 * - **Business recon** — one query per reporting table (`businessReconciliation.ts`). Does the last
 *   table of the mart add up *as a report*: do its movements reach its closing balance, do the
 *   subtotals its own SQL declares still hold, does one period's close open the next, and is the
 *   business measure it reports still the one that entered the pipeline? The other two reconcile a
 *   table against its sources, which a report table mostly has not got — `bop_arr`, `customer_churn`
 *   and `eop_arr` are eight readings of one upstream column and exist in no source table at all.
 *
 * The names are constants here rather than string literals at each writer because the document
 * *names the files it is describing* (`documentation.ts`), so a folder renamed in one place and not
 * the other sends a reader to a path that does not exist.
 */

/** The per-hop bundles: the file you run to find out whether the pipeline ties out. */
export const HIGH_LEVEL_RECON_DIR = "High level recon";

/** The per-layer column reports: the detail behind a hop that did not tie out. */
export const LOGICAL_RECON_DIR = "Logical recon";

/** The per-report business checks: does the table the business reads add up on its own terms. */
export const BUSINESS_RECON_DIR = "Business recon";
