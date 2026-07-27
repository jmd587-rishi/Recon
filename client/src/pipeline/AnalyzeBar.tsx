export function AnalyzeBar({
  analyzing,
  error,
  hasData,
  onAnalyze
}: {
  analyzing: boolean;
  error: string | null;
  hasData: boolean;
  onAnalyze: () => void;
}) {
  return (
    <div className="pl-card" style={{ padding: 12, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
      <div className="pl-card-sub" style={{ flex: 1 }}>
        {hasData
          ? "Showing the last analysis run. Re-run after changing layers, warehouse, or notebooks."
          : "Scans every notebook under the configured root once, extracts write statements, and asks the LLM to explain each exclusion rule."}
      </div>
      <button type="button" className="btn-sm" onClick={onAnalyze} disabled={analyzing}>
        {analyzing ? "Analyzing pipeline..." : hasData ? "Re-run analysis" : "Analyze pipeline"}
      </button>
      {error && (
        <p className="error" style={{ width: "100%", margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
