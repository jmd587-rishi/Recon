import type { PipelineAnalysis } from "../types";
import { AnalyzeBar } from "./AnalyzeBar";

export function SectionExclusions({
  analysis,
  analyzing,
  error,
  onAnalyze
}: {
  analysis: PipelineAnalysis | null;
  analyzing: boolean;
  error: string | null;
  onAnalyze: () => void;
}) {
  return (
    <>
      <AnalyzeBar analyzing={analyzing} error={error} hasData={analysis !== null} onAnalyze={onAnalyze} />

      {analysis?.exclusions.map((layerResult, i) => (
        <div className="pl-card" key={i}>
          <div className="pl-card-header">
            <div>
              <div className="pl-card-title">{layerResult.layer.label}</div>
              <div className="pl-card-sub">
                {layerResult.totalRows !== null ? `${layerResult.totalRows.toLocaleString()} rows · ` : ""}
                {layerResult.rules.length} exclusion rule{layerResult.rules.length === 1 ? "" : "s"}
              </div>
            </div>
          </div>
          <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            {layerResult.rules.length === 0 ? (
              <p className="hint">No exclusion rules found — every write statement for this layer's tables is a pass-through.</p>
            ) : (
              layerResult.rules.map((rule, j) => (
                <div className={`pl-rule-card ${rule.severity === "warning" ? "warn" : "ok"}`} key={j}>
                  <div className="pl-rule-head">
                    <span className="pl-rule-label">{rule.label}</span>
                    <span className={`chip ${rule.severity === "warning" ? "chip-warn" : "chip-ok"}`}>
                      {rule.excludedCount !== null ? `${rule.excludedCount.toLocaleString()} rows excluded` : "count unavailable"}
                    </span>
                  </div>
                  <div className="pl-card-sub" style={{ marginBottom: 6 }}>
                    {rule.notebookPath} (cell {rule.cellIndex}) · source: <span className="pl-mono">{rule.sourceTable}</span>
                  </div>
                  {rule.predicateSql && (
                    <p className="pl-rule-body">
                      <code>{rule.predicateSql}</code>
                    </p>
                  )}
                  <p className="pl-rule-body">{rule.explanation}</p>
                </div>
              ))
            )}
          </div>
        </div>
      ))}
    </>
  );
}
