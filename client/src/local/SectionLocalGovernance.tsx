import { useMemo, useState } from "react";
import { getLocalGovernance } from "../api/client";
import {
  buildCorrectionsZip,
  correctionsZipFilename,
  type HopCorrections,
  hopFolderName,
  type PendingHop,
  triggerDownload
} from "../pipeline/corrections";
import { CorrectionRow, FixCard } from "../pipeline/FixCard";
import type { LayerRef, LocalFixReport } from "../types";

/**
 * The governance gate over uploaded SQL. Same idea as the Databricks one (`pipeline/SectionGovernance`)
 * minus everything that needs a warehouse: no measured row counts and no re-checking of the
 * suggested fixes, so the review is honestly labelled as read-from-the-code-only.
 *
 * A scope with null layers means the SQL never qualified its tables, so no hops could be inferred and
 * every located statement is reviewed in one pass instead.
 */
interface Scope {
  from: LayerRef | null;
  to: LayerRef | null;
}

const WHOLE_PROJECT_KEY = "__all__";

function scopeKey(scope: Scope): string {
  return scope.from && scope.to ? `${scope.from.schema}__${scope.to.schema}` : WHOLE_PROJECT_KEY;
}

function scopeLabel(scope: Scope): string {
  return scope.from && scope.to ? `${scope.from.label.toUpperCase()} → ${scope.to.label.toUpperCase()}` : "ALL FILES";
}

export function SectionLocalGovernance({ folderName, layers }: { folderName: string; layers: LayerRef[] }) {
  const scopes = useMemo<Scope[]>(
    () =>
      layers.length >= 2
        ? layers.slice(0, -1).map((from, i) => ({ from, to: layers[i + 1] }))
        : [{ from: null, to: null }],
    [layers]
  );

  const [activeIdx, setActiveIdx] = useState(0);
  const [reports, setReports] = useState<Record<string, LocalFixReport>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reviewingAll, setReviewingAll] = useState(false);

  const active = scopes[Math.min(activeIdx, scopes.length - 1)];
  const key = scopeKey(active);
  const report = reports[key];
  const loading = loadingKey === key;
  const error = errors[key];

  const reviewedCount = scopes.filter((s) => reports[scopeKey(s)]).length;
  const allReviewed = reviewedCount === scopes.length;
  const bundledFiles = scopes.reduce((n, s) => n + (reports[scopeKey(s)]?.corrections.length ?? 0), 0);
  const busy = loadingKey !== null || reviewingAll;

  async function review(scope: Scope) {
    const id = scopeKey(scope);
    setLoadingKey(id);
    setErrors((prev) => ({ ...prev, [id]: "" }));
    try {
      const res = await getLocalGovernance(
        scope.from && scope.to ? { fromLayer: scope.from, toLayer: scope.to } : {}
      );
      setReports((prev) => ({ ...prev, [id]: res }));
    } catch (err) {
      setErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setLoadingKey(null);
    }
  }

  /**
   * Reviews every scope not done yet, one at a time — each is its own LLM call, so firing them in
   * parallel just queues them behind each other at the provider. `reports` is snapshotted at click
   * time on purpose: the only entries added during the loop are the ones this loop produced.
   */
  async function reviewAll() {
    const alreadyReviewed = reports;
    setReviewingAll(true);
    try {
      for (const scope of scopes) {
        if (alreadyReviewed[scopeKey(scope)]) continue;
        await review(scope);
      }
    } finally {
      setReviewingAll(false);
    }
  }

  function downloadBundle() {
    const hops: HopCorrections[] = [];
    const pending: PendingHop[] = [];
    for (const scope of scopes) {
      const scopeReport = reports[scopeKey(scope)];
      if (scopeReport) hops.push({ from: scope.from, to: scope.to, report: scopeReport });
      else pending.push({ from: scope.from, to: scope.to });
    }
    triggerDownload(
      correctionsZipFilename(folderName),
      buildCorrectionsZip({ projectName: folderName, sourceLabel: folderName, hops, pending })
    );
  }

  return (
    <>
      <div className="pl-layer-tabs">
        {scopes.map((scope, i) => {
          const id = scopeKey(scope);
          const state = loadingKey === id ? "…" : reports[id] ? "✓" : "";
          return (
            <button
              key={id}
              type="button"
              className={`pl-layer-tab${i === activeIdx ? " on" : ""}`}
              onClick={() => setActiveIdx(i)}
            >
              {scopeLabel(scope)}
              {state && <span className="pl-tab-state">{state}</span>}
            </button>
          );
        })}
      </div>

      <div className="pl-card pl-bundle-bar">
        <div>
          <div className="pl-card-title">Correction bundle</div>
          <div className="pl-card-sub">
            {reviewedCount} of {scopes.length} scope{scopes.length === 1 ? "" : "s"} reviewed · {bundledFiles} corrected
            file{bundledFiles === 1 ? "" : "s"}
            {bundledFiles > 0 && (
              <>
                {" "}
                · one folder per scope, e.g. <span className="pl-mono">{hopFolderName(scopes[0].from, scopes[0].to)}/</span>
              </>
            )}
          </div>
        </div>
        <div className="pl-bundle-actions">
          {!allReviewed && (
            <button type="button" className="btn-sm" onClick={reviewAll} disabled={busy}>
              {reviewingAll ? "Reviewing all scopes..." : "Review all scopes"}
            </button>
          )}
          <button type="button" className="btn-sm" onClick={downloadBundle} disabled={bundledFiles === 0 || busy}>
            ↓ Download all as .zip
          </button>
        </div>
      </div>

      <div className="pl-card" style={{ padding: 12, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <div className="pl-card-sub" style={{ flex: 1 }}>
          {active.from && active.to ? (
            <>
              Governance gate for the{" "}
              <b>
                {active.from.label} → {active.to.label}
              </b>{" "}
              hop: reviews every statement that writes a <span className="pl-mono">{active.to.schema}</span> table and
              suggests code-level fixes to prevent reconciliation errors.
            </>
          ) : (
            <>
              Governance review across <b>every SQL statement</b> in the folder — the SQL doesn't qualify its tables with
              schemas, so there are no layers to split it into hops by.
            </>
          )}{" "}
          Copy a fix, or download the whole corrected file.
        </div>
        <button type="button" className="btn-sm" onClick={() => review(active)} disabled={busy}>
          {loading ? "Reviewing SQL..." : report ? "Re-review" : "Review"}
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
                  {scopeLabel(active)}{" "}
                  <span className={`chip ${report.status === "ok" ? "chip-ok" : "chip-warn"}`}>{report.status}</span>
                </div>
                <div className="pl-card-sub">
                  {report.analyzedFiles.length} file{report.analyzedFiles.length === 1 ? "" : "s"} analyzed ·{" "}
                  {report.fixes.length} suggestion{report.fixes.length === 1 ? "" : "s"}
                </div>
              </div>
            </div>
            <div style={{ padding: 14 }}>
              <p className="pl-rule-body">{report.summary}</p>
              {report.analyzedFiles.length === 0 && active.to && (
                <p className="hint" style={{ marginTop: 8 }}>
                  No statement in this folder writes a table in the <span className="pl-mono">{active.to.schema}</span>{" "}
                  schema. Check that the layers match the schema names your SQL actually uses.
                </p>
              )}
              {report.truncated && (
                <p className="hint" style={{ marginTop: 8 }}>
                  The statement budget was reached — some statements in this scope weren't reviewed.
                </p>
              )}
              <p className="hint" style={{ marginTop: 8 }}>
                These fixes come from reading the SQL alone: there is no warehouse behind an uploaded folder, so no row
                counts were measured and no suggestion was re-checked against data.
              </p>
            </div>
          </div>

          {report.corrections.length > 0 && (
            <div className="pl-card">
              <div className="pl-card-header">
                <div>
                  <div className="pl-card-title">Corrected SQL files</div>
                  <div className="pl-card-sub">
                    Whole files with the fixes spliced back in — everything outside a corrected statement is byte-for-byte
                    what you uploaded. In the zip these land in{" "}
                    <span className="pl-mono">{hopFolderName(active.from, active.to)}/</span>
                  </div>
                </div>
              </div>
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                {report.corrections.map((c) => (
                  <CorrectionRow key={c.notebookPath} correction={c} unit="statement" />
                ))}
              </div>
            </div>
          )}

          {report.fixes.length === 0 ? (
            <div className="pl-card">
              <p className="hint" style={{ padding: 14 }}>
                No reconciliation-risk changes were suggested here — the SQL looks safe.
              </p>
            </div>
          ) : (
            <div className="pl-card">
              <div className="pl-card-header">
                <div>
                  <div className="pl-card-title">Code-level suggestions</div>
                  <div className="pl-card-sub">Copy an individual fix into your SQL file</div>
                </div>
              </div>
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                {report.fixes.map((fix, i) => (
                  <FixCard key={`${fix.notebookPath}-${fix.cellIndex}-${i}`} fix={fix} unit="statement" />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
