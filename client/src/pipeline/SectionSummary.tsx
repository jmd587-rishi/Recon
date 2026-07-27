import { useState } from "react";
import { getProjectSummary } from "../api/client";
import type { LayerRef, ProjectSummary, ProjectTableInfo, TableKind } from "../types";

const KIND_LABEL: Record<TableKind, string> = {
  fact: "Fact",
  dimension: "Dimension",
  bridge: "Bridge",
  staging: "Staging",
  other: "Other"
};

function fmt(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="pl-stat">
      <div className="pl-stat-value">{value}</div>
      <div className="pl-stat-label">{label}</div>
    </div>
  );
}

export function SectionSummary({
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
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await getProjectSummary({ catalog, warehouseId, notebookRoot, layers });
      setSummary(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="pl-card" style={{ padding: 12, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <div className="pl-card-sub" style={{ flex: 1 }}>
          {summary
            ? "Full project overview built from the catalog, layers, table inventory, and notebook lineage. Re-run after changing the setup."
            : "Builds an onboarding brief for the whole data project — layer inventory, fact/dimension counts, lineage, and an AI-written explanation of how it's set up and how it runs."}
        </div>
        <button type="button" className="btn-sm" onClick={generate} disabled={loading}>
          {loading ? "Building summary..." : summary ? "Rebuild summary" : "Generate project summary"}
        </button>
        {error && (
          <p className="error" style={{ width: "100%", margin: 0 }}>
            {error}
          </p>
        )}
      </div>

      {loading && !summary && (
        <p className="hint" style={{ padding: 14 }}>
          Listing tables, counting rows, and scanning notebooks under <span className="pl-mono">{notebookRoot}</span>. This can
          take a moment for large pipelines.
        </p>
      )}

      {summary && (
        <>
          {/* Setup */}
          <div className="pl-card">
            <div className="pl-card-header">
              <div>
                <div className="pl-card-title">Project setup</div>
                <div className="pl-card-sub">How this project is configured</div>
              </div>
            </div>
            <div className="pl-tbl-wrap">
              <table className="pl-tbl">
                <tbody>
                  <tr>
                    <th style={{ width: 160 }}>Catalog</th>
                    <td>
                      <span className="pl-mono">{summary.catalog}</span>
                    </td>
                  </tr>
                  <tr>
                    <th>Medallion layers</th>
                    <td>{summary.layers.map((l) => `${l.layer.label} (${l.layer.schema})`).join("  →  ")}</td>
                  </tr>
                  <tr>
                    <th>Notebook root</th>
                    <td>
                      <span className="pl-mono">{summary.notebookRoot}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* KPIs */}
          <div className="pl-stat-row">
            <StatTile value={String(summary.stats.layerCount)} label="Layers" />
            <StatTile value={String(summary.stats.tableCount)} label="Tables" />
            <StatTile value={String(summary.stats.factTableCount)} label="Fact tables" />
            <StatTile value={String(summary.stats.dimensionTableCount)} label="Dimension tables" />
            <StatTile value={fmt(summary.stats.totalRows)} label="Total rows" />
            <StatTile value={String(summary.stats.lineageEdgeCount)} label="Lineage edges" />
            <StatTile value={String(summary.stats.notebookCount)} label="Notebooks" />
          </div>

          {/* AI narrative */}
          {summary.narrative ? (
            <div className="pl-card">
              <div className="pl-card-header">
                <div>
                  <div className="pl-card-title">Project overview</div>
                  <div className="pl-card-sub">AI-generated onboarding brief for a new engineer</div>
                </div>
              </div>
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <div className="pl-narrative-h">What this project is</div>
                  <p className="pl-rule-body">{summary.narrative.overview}</p>
                </div>
                {summary.narrative.architecture && (
                  <div>
                    <div className="pl-narrative-h">How it's set up</div>
                    <p className="pl-rule-body">{summary.narrative.architecture}</p>
                  </div>
                )}
                {summary.narrative.howItWorks && (
                  <div>
                    <div className="pl-narrative-h">How it works</div>
                    <p className="pl-rule-body">{summary.narrative.howItWorks}</p>
                  </div>
                )}
                {summary.narrative.onboardingTips.length > 0 && (
                  <div>
                    <div className="pl-narrative-h">Getting started</div>
                    <ul className="pl-tips">
                      {summary.narrative.onboardingTips.map((tip, i) => (
                        <li key={i}>{tip}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="pl-card">
              <p className="hint" style={{ padding: 14 }}>
                The structured summary below is ready. The AI-written overview is unavailable because Azure OpenAI is not
                configured (set <span className="pl-mono">AZURE_OPENAI_*</span> in <span className="pl-mono">server/.env</span>).
              </p>
            </div>
          )}

          {/* Per-layer table inventory */}
          {summary.layers.map((layerSummary, i) => (
            <div className="pl-card" key={i}>
              <div className="pl-card-header">
                <div>
                  <div className="pl-card-title">
                    {layerSummary.layer.label} <span className="pl-card-sub">· {layerSummary.layer.schema}</span>
                  </div>
                  <div className="pl-card-sub">
                    {layerSummary.tables.length} table{layerSummary.tables.length === 1 ? "" : "s"}
                    {layerSummary.totalRows !== null ? ` · ${layerSummary.totalRows.toLocaleString()} rows` : ""}
                  </div>
                </div>
              </div>
              {layerSummary.tables.length === 0 ? (
                <p className="hint" style={{ padding: 14 }}>
                  No tables in this layer.
                </p>
              ) : (
                <div className="pl-tbl-wrap">
                  <table className="pl-tbl">
                    <thead>
                      <tr>
                        <th>Table</th>
                        <th>Type</th>
                        <th>Rows</th>
                        <th>Columns</th>
                        <th>Comment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {layerSummary.tables.map((t: ProjectTableInfo) => (
                        <tr key={t.name}>
                          <td>
                            <span className="pl-mono">{t.name}</span>
                          </td>
                          <td>
                            <span className={`pl-kind pl-kind-${t.kind}`}>{KIND_LABEL[t.kind]}</span>
                          </td>
                          <td>{fmt(t.rowCount)}</td>
                          <td>{t.columnCount ?? "—"}</td>
                          <td>{t.comment ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}

          {/* Lineage flow */}
          <div className="pl-card">
            <div className="pl-card-header">
              <div>
                <div className="pl-card-title">Data flow</div>
                <div className="pl-card-sub">{summary.lineage.length} table-to-table lineage edges</div>
              </div>
            </div>
            {summary.lineage.length === 0 ? (
              <p className="hint" style={{ padding: 14 }}>
                No lineage edges were discovered under the configured notebook root.
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
                    {summary.lineage.map((edge, i) => (
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
        </>
      )}
    </>
  );
}
