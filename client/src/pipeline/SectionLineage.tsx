import type { PipelineAnalysis } from "../types";
import { AnalyzeBar } from "./AnalyzeBar";

export function SectionLineage({
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

      {analysis && (
        <div className="pl-card">
          <div className="pl-card-header">
            <div>
              <div className="pl-card-title">Table lineage</div>
              <div className="pl-card-sub">{analysis.lineage.length} join/dependency edges across the pipeline</div>
            </div>
          </div>
          {analysis.lineage.length === 0 ? (
            <p className="hint" style={{ padding: 14 }}>
              No lineage edges found under the configured notebook root.
            </p>
          ) : (
            <div className="pl-tbl-wrap">
              <table className="pl-tbl">
                <thead>
                  <tr>
                    <th>Source table</th>
                    <th>Target table</th>
                    <th>Join key</th>
                    <th>Notebook</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.lineage.map((edge, i) => (
                    <tr key={i}>
                      <td>
                        <span className="pl-mono">{edge.from}</span>
                      </td>
                      <td>
                        <span className="pl-mono">{edge.to}</span>
                      </td>
                      <td>{edge.joinKeyHint ?? "—"}</td>
                      <td className="pl-card-sub">
                        {edge.notebookPath} (cell {edge.cellIndex})
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}
