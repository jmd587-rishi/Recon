import { useMemo, useState } from "react";
import { getLevelFixes } from "../api/client";
import type { HopEvidence, LayerRef, LevelFixReport } from "../types";
import {
  buildCorrectionsZip,
  correctionsZipFilename,
  hopFolderName,
  type HopCorrections,
  triggerDownload
} from "./corrections";
import { CorrectionRow, FixCard } from "./FixCard";
import { signed } from "./format";

interface Level {
  from: LayerRef;
  to: LayerRef;
}

function levelKey(level: Level): string {
  return `${level.from.schema}__${level.to.schema}`;
}

/** Hop-wide measured context: the count mismatches found across same-named tables. */
function EvidenceCard({ evidence }: { evidence: HopEvidence }) {
  const measured = evidence.cells.reduce((n, c) => n + c.rowCounts.length + c.filters.length, 0);
  return (
    <div className="pl-card">
      <div className="pl-card-header">
        <div>
          <div className="pl-card-title">Measured row counts</div>
          <div className="pl-card-sub">
            {measured} measurement{measured === 1 ? "" : "s"} across {evidence.cells.length} cell
            {evidence.cells.length === 1 ? "" : "s"} · fed to the model as ground truth
            {evidence.truncated ? " · statement budget reached, some tables unmeasured" : ""}
          </div>
        </div>
      </div>
      <div style={{ padding: 14 }}>
        {evidence.mismatches.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            No same-named table differs in row count across this hop.
          </p>
        ) : (
          <div className="pl-tbl-wrap">
            <table className="pl-tbl">
              <thead>
                <tr>
                  <th>Table</th>
                  <th>{evidence.mismatches[0].fromStage}</th>
                  <th>{evidence.mismatches[0].toStage}</th>
                  <th>Difference</th>
                </tr>
              </thead>
              <tbody>
                {evidence.mismatches.map((m) => (
                  <tr key={m.tableName}>
                    <td>
                      <span className="pl-mono">{m.tableName}</span>
                    </td>
                    <td>{m.fromCount.toLocaleString()}</td>
                    <td>{m.toCount.toLocaleString()}</td>
                    <td>
                      <span className={`pl-delta ${m.difference > 0 ? "up" : "down"}`}>{signed(m.difference)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function SectionGovernance({
  catalog,
  layers,
  warehouseId,
  notebookRoot
}: {
  catalog: string;
  layers: LayerRef[];
  warehouseId: string;
  notebookRoot: string;
}) {
  const levels = useMemo<Level[]>(
    () => layers.slice(0, -1).map((from, i) => ({ from, to: layers[i + 1] })),
    [layers]
  );
  const [activeIdx, setActiveIdx] = useState(0);
  const [reports, setReports] = useState<Record<string, LevelFixReport>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reviewingAll, setReviewingAll] = useState(false);

  if (levels.length === 0) {
    return (
      <p className="hint" style={{ padding: 14 }}>
        Governance review needs at least two layers so there's a hop to analyze (e.g. bronze → silver). Add another layer
        in Reconfigure.
      </p>
    );
  }

  const active = levels[Math.min(activeIdx, levels.length - 1)];
  const key = levelKey(active);
  const report = reports[key];
  const loading = loadingKey === key;
  const error = errors[key];

  const reviewedCount = levels.filter((l) => reports[levelKey(l)]).length;
  const allReviewed = reviewedCount === levels.length;
  const bundledNotebooks = levels.reduce((n, l) => n + (reports[levelKey(l)]?.corrections.length ?? 0), 0);
  const busy = loadingKey !== null || reviewingAll;

  async function reviewLevel(level: Level) {
    const levelId = levelKey(level);
    setLoadingKey(levelId);
    setErrors((prev) => ({ ...prev, [levelId]: "" }));
    try {
      const res = await getLevelFixes({
        catalog,
        notebookRoot,
        warehouseId: warehouseId || undefined,
        fromLayer: level.from,
        toLayer: level.to
      });
      setReports((prev) => ({ ...prev, [levelId]: res }));
    } catch (err) {
      setErrors((prev) => ({ ...prev, [levelId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setLoadingKey(null);
    }
  }

  /**
   * Reviews every level that hasn't been done yet, one at a time — each hop is its own LLM call plus
   * a round of warehouse queries, so running them in parallel would just contend for the warehouse.
   * `reports` is snapshotted at click time on purpose: the only entries added during the loop are the
   * ones this loop just produced.
   */
  async function reviewAll() {
    const alreadyReviewed = reports;
    setReviewingAll(true);
    try {
      for (const level of levels) {
        if (alreadyReviewed[levelKey(level)]) continue;
        await reviewLevel(level);
      }
    } finally {
      setReviewingAll(false);
    }
  }

  function downloadBundle() {
    const hops: HopCorrections[] = [];
    const pending: Level[] = [];
    for (const level of levels) {
      const levelReport = reports[levelKey(level)];
      if (levelReport) hops.push({ from: level.from, to: level.to, report: levelReport });
      else pending.push(level);
    }
    triggerDownload(
      correctionsZipFilename(catalog),
      buildCorrectionsZip({ projectName: catalog, sourceLabel: notebookRoot, hops, pending })
    );
  }

  return (
    <>
      <div className="pl-layer-tabs">
        {levels.map((lvl, i) => {
          const lvlKey = levelKey(lvl);
          const state = loadingKey === lvlKey ? "…" : reports[lvlKey] ? "✓" : "";
          return (
            <button
              key={lvlKey}
              type="button"
              className={`pl-layer-tab${i === activeIdx ? " on" : ""}`}
              onClick={() => setActiveIdx(i)}
            >
              {lvl.from.label.toUpperCase()} → {lvl.to.label.toUpperCase()}
              {state && <span className="pl-tab-state">{state}</span>}
            </button>
          );
        })}
      </div>

      <div className="pl-card pl-bundle-bar">
        <div>
          <div className="pl-card-title">Correction bundle</div>
          <div className="pl-card-sub">
            {reviewedCount} of {levels.length} level{levels.length === 1 ? "" : "s"} reviewed ·{" "}
            {bundledNotebooks} corrected notebook{bundledNotebooks === 1 ? "" : "s"}
            {bundledNotebooks > 0 && (
              <>
                {" "}
                · one folder per hop, e.g. <span className="pl-mono">{hopFolderName(levels[0].from, levels[0].to)}/</span>
              </>
            )}
          </div>
        </div>
        <div className="pl-bundle-actions">
          {!allReviewed && (
            <button type="button" className="btn-sm" onClick={reviewAll} disabled={busy}>
              {reviewingAll ? "Reviewing all levels..." : "Review all levels"}
            </button>
          )}
          <button type="button" className="btn-sm" onClick={downloadBundle} disabled={bundledNotebooks === 0 || busy}>
            ↓ Download all as .zip
          </button>
        </div>
      </div>

      <div className="pl-card" style={{ padding: 12, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <div className="pl-card-sub" style={{ flex: 1 }}>
          Governance gate for the <b>{active.from.label} → {active.to.label}</b> hop: scans the notebooks that write the{" "}
          {active.to.label} layer,{" "}
          {warehouseId
            ? "measures the real row counts behind them, then suggests code-level fixes grounded in those numbers and re-checks each one."
            : "then suggests code-level fixes to prevent reconciliation errors."}{" "}
          Copy a fix, or download the whole corrected notebook.
        </div>
        <button type="button" className="btn-sm" onClick={() => reviewLevel(active)} disabled={busy}>
          {loading ? "Reviewing code..." : report ? "Re-review level" : "Review this level"}
        </button>
        {error && (
          <p className="error" style={{ width: "100%", margin: 0 }}>
            {error}
          </p>
        )}
      </div>

      {report && (
        <>
          <div className="pl-card">
            <div className="pl-card-header">
              <div>
                <div className="pl-card-title">
                  {report.fromLayer.label} → {report.toLayer.label}{" "}
                  <span className={`chip ${report.status === "ok" ? "chip-ok" : "chip-warn"}`}>{report.status}</span>
                </div>
                <div className="pl-card-sub">
                  {report.analyzedNotebooks.length} notebook{report.analyzedNotebooks.length === 1 ? "" : "s"} analyzed ·{" "}
                  {report.fixes.length} suggestion{report.fixes.length === 1 ? "" : "s"}
                </div>
              </div>
            </div>
            <div style={{ padding: 14 }}>
              <p className="pl-rule-body">{report.summary}</p>
              {report.analyzedNotebooks.length === 0 && (
                <p className="hint" style={{ marginTop: 8 }}>
                  No notebooks under <span className="pl-mono">{notebookRoot}</span> were found writing the{" "}
                  {report.toLayer.label} layer. Check the notebook root in Reconfigure.
                </p>
              )}
              {!report.evidence && (
                <p className="hint" style={{ marginTop: 8 }}>
                  Row counts unavailable — no SQL warehouse is selected, so these fixes come from reading the code alone and
                  weren't re-checked against the data. Pick a warehouse in Reconfigure to ground them in real counts.
                </p>
              )}
            </div>
          </div>

          {report.evidence && <EvidenceCard evidence={report.evidence} />}

          {report.corrections.length > 0 && (
            <div className="pl-card">
              <div className="pl-card-header">
                <div>
                  <div className="pl-card-title">Corrected notebooks</div>
                  <div className="pl-card-sub">
                    Full notebooks with the fixes applied — download and review before committing. In the zip bundle these
                    land in <span className="pl-mono">{hopFolderName(report.fromLayer, report.toLayer)}/</span>
                  </div>
                </div>
              </div>
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                {report.corrections.map((c) => (
                  <CorrectionRow key={c.notebookPath} correction={c} />
                ))}
              </div>
            </div>
          )}

          {report.fixes.length === 0 ? (
            <div className="pl-card">
              <p className="hint" style={{ padding: 14 }}>
                No reconciliation-risk changes were suggested for this hop — the transformation code looks safe.
              </p>
            </div>
          ) : (
            <div className="pl-card">
              <div className="pl-card-header">
                <div>
                  <div className="pl-card-title">Code-level suggestions</div>
                  <div className="pl-card-sub">
                    {report.evidence
                      ? "Verified fixes first, then by measured row impact — copy an individual fix into your notebook"
                      : "Copy an individual fix into your notebook"}
                  </div>
                </div>
              </div>
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                {report.fixes.map((fix, i) => (
                  <FixCard key={`${fix.notebookPath}-${fix.cellIndex}-${i}`} fix={fix} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
