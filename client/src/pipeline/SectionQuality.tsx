import { useState, useRef, useEffect } from "react";
import type { DataQualityRequest, DataQualityResult, LayerRef } from "../types";
import { runQualityCheck, runQualityCheckStream } from "../api/client";

export function SectionQuality({
  catalog,
  warehouseId,
  notebookRoot,
  layers
}: {
  catalog: string;
  warehouseId: string;
  notebookRoot: string;
  layers: LayerRef[];
}) {
  const [active, setActive] = useState(0);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [expandedIssue, setExpandedIssue] = useState<string | null>(null);
  const [resultsByLayer, setResultsByLayer] = useState<Record<number, DataQualityResult | null>>({});
  const [runningLayer, setRunningLayer] = useState<number | null>(null);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [progressSteps, setProgressSteps] = useState<Array<{ step: string; message: string; detail?: unknown }>>([]);
  const streamRef = useRef<{ abort: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!layers || layers.length === 0) {
    return (
      <div className="pl-card">
        <div className="pl-card-header">
          <div>
            <div className="pl-card-title">Data Quality</div>
            <div className="pl-card-sub">No layers configured.</div>
          </div>
        </div>
        <p className="hint" style={{ padding: 14 }}>
          Configure pipeline layers in the setup step before running quality checks.
        </p>
      </div>
    );
  }

  const layer = layers[active];
  const layerResult = resultsByLayer[active] ?? null;
  const hasRun = layerResult !== null;
  const isRunning = runningLayer === active;

  function tableStatus(checks: DataQualityResult["tables"][number]["checks"]): "PASS" | "FAIL" {
    return checks.some((c) => c.status === "FAIL") ? "FAIL" : "PASS";
  }

  async function handleRunQualityCheck() {
    setError(null);
    setRunningLayer(active);
    setProgressMessage("Starting...");
    setProgressSteps([]);

    try {
      const payload: DataQualityRequest = {
        catalog,
        warehouseId,
        notebookRoot,
        layers,
        layerIndex: active
      };

      // Use streaming endpoint to receive progress and final result
      const s = runQualityCheckStream(
        payload,
        (ev) => {
          if (ev.event === "status") {
            const step = typeof ev.data?.step === "string" ? ev.data.step : "status";
            const message = typeof ev.data?.message === "string" ? ev.data.message : JSON.stringify(ev.data);
            const detail = ev.data?.detail;
            setProgressMessage(message);
            setProgressSteps((prev) => {
              const next = [...prev, { step, message, detail }];
              return next.slice(-8);
            });
          } else if (ev.event === "result") {
            const r = ev.data.result ?? ev.data;
            setResultsByLayer((prev) => ({ ...prev, [active]: r }));
          } else if (ev.event === "error") {
            setError(ev.data?.message ?? String(ev.data));
          }
        },
        (err) => setError(err instanceof Error ? err.message : String(err))
      );
      streamRef.current = s;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningLayer(null);
      streamRef.current = null;
    }
  }

  useEffect(() => {
    return () => {
      // cleanup: abort any running stream
      streamRef.current?.abort();
    };
  }, []);

  const allChecks = layerResult?.tables.flatMap((t) => t.checks) ?? [];
  const passCount = allChecks.filter((c) => c.status === "PASS").length;
  const failCount = allChecks.filter((c) => c.status === "FAIL").length;
  const latestDiscovery = progressSteps.findLast((step) => step.step === "graph:discover:done");
  const latestGraphDone = progressSteps.findLast((step) => step.step === "graph:done");
  const discoveredPaths = Array.isArray(latestDiscovery?.detail && (latestDiscovery.detail as any).preferredNotebookPaths)
    ? ((latestDiscovery?.detail as any).preferredNotebookPaths as string[])
    : [];

  return (
    <>
      <div className="pl-layer-tabs">
        {layers.map((l, i) => (
          <button
            key={i}
            type="button"
            className={`pl-layer-tab${i === active ? " on" : ""}`}
            onClick={() => {
              setActive(i);
              setExpandedTable(null);
              setExpandedIssue(null);
            }}
          >
            {l.label.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="pl-card">
        <div className="pl-card-header">
          <div>
            <div className="pl-card-title">
              {layer.label} <span className="pl-card-sub">· {layer.schema}</span>
            </div>
            <div className="pl-card-sub">
              {layerResult ? layerResult.tables.length : 0} tables · {passCount} passed · {failCount} failed
            </div>
          </div>
          <button type="button" className="btn-sm" onClick={handleRunQualityCheck} disabled={isRunning}>
            {isRunning ? "Running check..." : hasRun ? "Re-run Quality Check" : "Run Quality Check"}
          </button>
        </div>

        {error ? (
          <p className="hint" style={{ padding: 14, color: "#b91c1c" }}>
            {error}
          </p>
        ) : null}

        {!hasRun && !isRunning ? (
          <p className="hint" style={{ padding: 14 }}>
            No results yet. Click "Run Quality Check" to validate this layer.
          </p>
        ) : isRunning ? (
          <div className="pl-dq-progress-panel" style={{ padding: 14 }}>
            <div className="hint" style={{ marginBottom: 10 }}>
              Running quality checks for {layer.label}... {progressMessage ? `· ${progressMessage}` : null}
            </div>
            <div className="pl-dq-progress-title">What it is doing</div>
            <div className="pl-dq-progress-list">
              {progressSteps.length === 0 ? (
                <div className="pl-dq-progress-row muted">Waiting for graph updates...</div>
              ) : (
                progressSteps.map((step, index) => (
                  <div key={`${step.step}-${index}`} className="pl-dq-progress-row">
                    <span className="pl-dq-progress-step">{step.step}</span>
                    <span className="pl-dq-progress-message">{step.message}</span>
                  </div>
                ))
              )}
            </div>
            {discoveredPaths.length > 0 ? (
              <div className="pl-dq-source-box" style={{ marginTop: 12 }}>
                <div className="pl-dq-progress-title">Notebook candidates</div>
                <div className="pl-dq-progress-list">
                  {discoveredPaths.map((path) => (
                    <div key={path} className="pl-dq-progress-row pl-mono">
                      {path}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : layerResult && layerResult.tables.length === 0 ? (
          <p className="hint" style={{ padding: 14 }}>
            No quality checks were generated for this layer.
          </p>
        ) : (
          <div className="pl-dq-table-list">
            {layerResult?.tables.map((table) => {
              const status = tableStatus(table.checks);
              const isOpen = expandedTable === table.tableName;
              return (
                <div key={table.tableName} className="pl-dq-table-block">
                  <button
                    type="button"
                    className="pl-dq-table-row"
                    onClick={() => setExpandedTable(isOpen ? null : table.tableName)}
                  >
                    <span className="pl-dq-caret">{isOpen ? "▾" : "▸"}</span>
                    <span className="pl-mono pl-dq-table-name">{table.tableName}</span>
                    <span className={`pl-badge ${status === "PASS" ? "pl-badge-good" : "pl-badge-bad"}`}>
                      {status === "PASS" ? "Good" : "Failed"}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="pl-dq-checks">
                      {table.checks.map((check) => {
                        const issueKey = `${table.tableName}-${check.ruleId}`;
                        const issueOpen = expandedIssue === issueKey;
                        return (
                          <div key={check.ruleId} className="pl-dq-check-block">
                            <div
                              className={`pl-dq-check-row ${check.status === "FAIL" ? "clickable" : ""}`}
                              onClick={() => check.status === "FAIL" && setExpandedIssue(issueOpen ? null : issueKey)}
                            >
                              <span className="pl-dq-status">{check.status === "PASS" ? "✅" : "❌"}</span>
                              <span className="pl-dq-col">{check.column ?? "—"}</span>
                              <span className="pl-dq-rule">{check.ruleType}: {check.ruleExpr}</span>
                              {check.status === "FAIL" && (
                                <span className="pl-dq-link">{issueOpen ? "Hide ▾" : "View issue ▸"}</span>
                              )}
                            </div>

                            {issueOpen && (
                              <div className="pl-dq-issue-detail">
                                <div className="pl-modal-row">
                                  <span className="pl-modal-label">Failed rows</span>
                                  <span>{check.failedCount ?? "—"}</span>
                                </div>
                                <div className="pl-modal-row">
                                  <span className="pl-modal-label">Judgment</span>
                                  <span>{check.judgment?.explanation ?? "No judgment available."}</span>
                                </div>
                                <div className="pl-modal-row">
                                  <span className="pl-modal-label">Notebook</span>
                                  <span className="pl-mono">{check.diagnosis?.notebookPath ?? "—"}</span>
                                </div>
                                <div className="pl-modal-row">
                                  <span className="pl-modal-label">Cell</span>
                                  <span className="pl-mono">{check.diagnosis?.cell ?? "—"}</span>
                                </div>
                                <div className="pl-modal-row pl-code-row">
                                  <span className="pl-modal-label">What the model read</span>
                                  <pre className="pl-code-block">
                                    {check.diagnosis?.codeSnippet
                                      ? check.diagnosis.codeSnippet
                                      : "Full notebook source was used when available, but no diagnostic snippet was returned."}
                                  </pre>
                                </div>
                                {check.diagnosis?.codeSnippet ? (
                                  <div className="pl-modal-row pl-code-row">
                                    <span className="pl-modal-label">Code snippet</span>
                                    <pre className="pl-code-block">{check.diagnosis.codeSnippet}</pre>
                                  </div>
                                ) : null}
                                <div className="pl-modal-row pl-modal-fix">
                                  <span className="pl-modal-label">Suggested fix</span>
                                  <span>{check.diagnosis?.suggestedFix ?? "No suggestion available."}</span>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!isRunning && latestGraphDone ? (
        <div className="pl-card" style={{ marginTop: 12 }}>
          <div className="pl-card-header">
            <div>
              <div className="pl-card-title">Last run summary</div>
              <div className="pl-card-sub">The graph completed and the DQ engine returned a final result.</div>
            </div>
          </div>
          <div className="pl-dq-progress-list" style={{ padding: 14 }}>
            {progressSteps.map((step, index) => (
              <div key={`${step.step}-done-${index}`} className="pl-dq-progress-row">
                <span className="pl-dq-progress-step">{step.step}</span>
                <span className="pl-dq-progress-message">{step.message}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
