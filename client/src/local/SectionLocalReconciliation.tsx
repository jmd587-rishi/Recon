import { useCallback, useEffect, useState } from "react";
import { getLocalReconciliation } from "../api/client";
import { triggerDownload } from "../pipeline/corrections";
import { CopyButton } from "../pipeline/FixCard";
import type { LayerRef, LocalReconciliationSuite, ReconHopScripts, ReconScript } from "../types";
import { buildReconciliationZip, reconciliationZipFilename } from "./reconciliationZip";

/**
 * The reconciliation-script tab of the uploaded-folder dashboard: the SQL a data engineer would
 * otherwise hand-write to prove a hop moved the rows it should have.
 *
 * Each script has two halves. The standard checks are derived from the folder's own lineage and
 * column lists and are always present; the checks marked `ai` were written by the model after
 * reading the transformation SQL, and are the part that costs LLM calls — which is why the suite is
 * held by `LocalDashboard` rather than here: switching tabs and back must not pay for it twice.
 */

function hopLabel(hop: ReconHopScripts): string {
  return hop.fromLayer && hop.toLayer
    ? `${hop.fromLayer.label.toUpperCase()} → ${hop.toLayer.label.toUpperCase()}`
    : "ALL TABLES";
}

function countAi(script: ReconScript): number {
  return script.checks.filter((check) => check.source === "ai").length;
}

function downloadSql(filename: string, sql: string) {
  triggerDownload(filename, new Blob([sql], { type: "text/plain;charset=utf-8" }));
}

/** One generated script: what it keys on and what it totals, with the SQL a click away. */
function ScriptCard({ script, folder }: { script: ReconScript; folder: string }) {
  const [open, setOpen] = useState(false);
  const ai = countAi(script);

  return (
    <div className="pl-rule-card ok">
      <div className="pl-rule-head">
        <span className="pl-rule-label">{script.targetTable}</span>
        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className="pl-card-sub">
            {script.checks.length} check{script.checks.length === 1 ? "" : "s"}
            {ai > 0 && ` · ${ai} for this transformation`}
          </span>
          <span className={`pl-sev pl-sev-${script.keyConfidence === "none" ? "warning" : "info"}`}>
            key: {script.keyColumns.join(", ") || "not found"}
          </span>
        </span>
      </div>

      <div className="pl-card-sub" style={{ marginBottom: 6 }}>
        <span className="pl-mono">
          {folder}/{script.filename}
        </span>{" "}
        · from {script.sourceTables.join(", ")}
      </div>

      <div className="pl-card-sub">
        Totals: {script.measureColumns.length > 0 ? script.measureColumns.join(", ") : "no shared measure column"} ·
        columns read from{" "}
        {script.columnSources.map((c) => `${c.table} (${c.origin}, ${c.columnCount})`).join(", ")}
      </div>

      {script.summary && <p className="pl-rule-body">{script.summary}</p>}

      {script.knownFilters.length > 0 && (
        <p className="pl-rule-body">
          Filter applied by the transformation: <span className="pl-mono">{script.knownFilters.join(" / ")}</span> — rows
          it removes are an expected difference.
        </p>
      )}

      {script.notes.map((note) => (
        <p key={note} className="hint" style={{ margin: "6px 0 0" }}>
          {note}
        </p>
      ))}

      <div className="pl-code-head">
        <span className="pl-card-sub">
          {script.checks.map((c) => (c.source === "ai" ? `${c.title} [ai]` : c.title)).join(" · ")}
        </span>
        <span style={{ display: "flex", gap: 6 }}>
          <button type="button" className="btn-sm" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide SQL" : "Show SQL"}
          </button>
          <CopyButton text={script.sql} label="Copy script" />
          <button type="button" className="btn-sm" onClick={() => downloadSql(script.filename, script.sql)}>
            ↓ .sql
          </button>
        </span>
      </div>
      {open && (
        <pre className="pl-code">
          <code>{script.sql}</code>
        </pre>
      )}
    </div>
  );
}

export function SectionLocalReconciliation({
  folderName,
  layers,
  suite,
  onSuite
}: {
  folderName: string;
  layers: LayerRef[];
  /** Held by the dashboard so re-opening the tab doesn't re-run the model. */
  suite: LocalReconciliationSuite | null;
  onSuite: (suite: LocalReconciliationSuite) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [showTotals, setShowTotals] = useState(false);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      onSuite(await getLocalReconciliation({ layers }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [layers, onSuite]);

  // First open generates; afterwards the suite is kept, and "Regenerate" is the only way to spend
  // another round of LLM calls.
  useEffect(() => {
    if (!suite) void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hops = suite?.hops ?? [];
  const active = hops[Math.min(activeIdx, Math.max(0, hops.length - 1))];
  const aiChecks = hops.reduce((n, hop) => n + hop.scripts.reduce((m, s) => m + countAi(s), 0), 0);

  return (
    <>
      <div className="pl-card pl-bundle-bar">
        <div>
          <div className="pl-card-title">
            Reconciliation scripts{" "}
            {suite && (
              <span className={`chip ${aiChecks > 0 ? "chip-ok" : "chip-warn"}`}>
                {aiChecks > 0 ? `+${aiChecks} written for this pipeline` : "standard checks only"}
              </span>
            )}
          </div>
          <div className="pl-card-sub">
            {suite
              ? `${suite.stats.scriptCount} script${suite.stats.scriptCount === 1 ? "" : "s"} · ${suite.stats.checkCount} checks · ${suite.stats.hopCount} hop${suite.stats.hopCount === 1 ? "" : "s"} — one folder per hop in the zip`
              : "Row counts, measure totals, missing and duplicate keys, plus whatever this transformation calls for."}
          </div>
        </div>
        <div className="pl-bundle-actions">
          <button type="button" className="btn-sm" onClick={generate} disabled={loading}>
            {loading ? "Writing scripts..." : "Regenerate"}
          </button>
          <button
            type="button"
            className="btn-sm"
            disabled={!suite || suite.stats.scriptCount === 0 || loading}
            onClick={() => suite && triggerDownload(reconciliationZipFilename(folderName), buildReconciliationZip(suite))}
          >
            ↓ Download all as .zip
          </button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {hops.length > 1 && (
        <div className="pl-layer-tabs">
          {hops.map((hop, i) => (
            <button
              key={hop.folder}
              type="button"
              className={`pl-layer-tab${i === activeIdx ? " on" : ""}`}
              onClick={() => setActiveIdx(i)}
            >
              {hopLabel(hop)}
              <span className="pl-tab-state">{hop.scripts.length}</span>
            </button>
          ))}
        </div>
      )}

      <div className="pl-card" style={{ padding: 14 }}>
        <p className="pl-rule-body" style={{ marginTop: 0 }}>
          The reconciliation queries a data engineer writes by hand for every hop — does the target hold the rows the
          source had, do the amounts still add up, did any key go missing or arrive twice — plus the checks this
          particular transformation calls for, which come from the model reading the SQL in{" "}
          <span className="pl-mono">{folderName}</span>: aggregation grain, window partitions, casts that null a value
          out, date windows that leave a gap.
        </p>
        <p className="hint" style={{ margin: 0 }}>
          The standard checks are derived from your declared columns, so they cannot name a column a table hasn't got,
          and they are written whether or not the model answers. The ones marked <span className="pl-mono">[ai]</span>{" "}
          are the model's additions — checked back against the same column lists, with anything naming a table or column
          this project doesn't have dropped before you see it. Nothing was measured: an uploaded folder has no database
          behind it. A key marked <i>inferred</i> was guessed from column naming — the duplicate-key check inside each
          script tells you whether the guess holds.
        </p>
        {suite?.notice && (
          <p className="hint" style={{ margin: "8px 0 0" }}>
            {suite.notice}
          </p>
        )}
      </div>

      {loading && !suite && (
        <p className="hint">
          Deriving the standard checks from your column lists, then asking the model what else this transformation
          calls for — a few calls run at once, so this is about as long as one of them.
        </p>
      )}

      {active && (
        <>
          <div className="pl-card">
            <div className="pl-card-header">
              <div>
                <div className="pl-card-title">Control totals — {hopLabel(active)}</div>
                <div className="pl-card-sub">
                  Every source/target pair in this hop counted in one query. Run it first, then open the script for any
                  pair whose <span className="pl-mono">row_diff</span> you can't explain.
                </div>
              </div>
            </div>
            <div style={{ padding: 14 }}>
              <div className="pl-code-head">
                <span className="pl-card-sub pl-mono">
                  {active.folder}/{active.controlTotals.filename}
                </span>
                <span style={{ display: "flex", gap: 6 }}>
                  <button type="button" className="btn-sm" onClick={() => setShowTotals((v) => !v)}>
                    {showTotals ? "Hide SQL" : "Show SQL"}
                  </button>
                  <CopyButton text={active.controlTotals.sql} label="Copy" />
                  <button
                    type="button"
                    className="btn-sm"
                    onClick={() => downloadSql(active.controlTotals.filename, active.controlTotals.sql)}
                  >
                    ↓ .sql
                  </button>
                </span>
              </div>
              {showTotals && (
                <pre className="pl-code">
                  <code>{active.controlTotals.sql}</code>
                </pre>
              )}
            </div>
          </div>

          {active.scripts.length === 0 ? (
            <div className="pl-card">
              <p className="hint" style={{ padding: 14 }}>
                {active.notes.join(" ")}
              </p>
            </div>
          ) : (
            <div className="pl-card">
              <div className="pl-card-header">
                <div>
                  <div className="pl-card-title">Per-table scripts</div>
                  <div className="pl-card-sub">
                    One per table this hop builds, in the zip under{" "}
                    <span className="pl-mono">{active.folder}/</span>
                  </div>
                </div>
              </div>
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                {active.scripts.map((script) => (
                  <ScriptCard key={script.filename} script={script} folder={active.folder} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
