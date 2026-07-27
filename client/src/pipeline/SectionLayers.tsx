import { useEffect, useState } from "react";
import { getTableCounts, getTables } from "../api/client";
import type { LayerRef, Table } from "../types";

export function SectionLayers({ catalog, layers, warehouseId }: { catalog: string; layers: LayerRef[]; warehouseId: string }) {
  const [active, setActive] = useState(0);
  const [tables, setTables] = useState<Table[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingCounts, setLoadingCounts] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const layer = layers[active];

  useEffect(() => {
    let cancelled = false;
    setLoadingTables(true);
    setError(null);
    setCounts({});
    getTables(catalog, layer.schema)
      .then((res) => {
        if (!cancelled) setTables(res.tables);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingTables(false);
      });
    return () => {
      cancelled = true;
    };
  }, [catalog, layer.schema]);

  async function loadCounts() {
    if (tables.length === 0) return;
    setLoadingCounts(true);
    setError(null);
    try {
      const res = await getTableCounts({
        catalog,
        warehouseId,
        tables: tables.map((t) => ({ schema: t.schemaName, name: t.name }))
      });
      setCounts(res.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingCounts(false);
    }
  }

  return (
    <>
      <div className="pl-layer-tabs">
        {layers.map((l, i) => (
          <button key={i} type="button" className={`pl-layer-tab${i === active ? " on" : ""}`} onClick={() => setActive(i)}>
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
            <div className="pl-card-sub">{tables.length} tables</div>
          </div>
          <button type="button" className="btn-sm" onClick={loadCounts} disabled={loadingCounts || tables.length === 0}>
            {loadingCounts ? "Loading counts..." : "Load row/column counts"}
          </button>
        </div>

        {loadingTables ? (
          <p className="hint" style={{ padding: 14 }}>
            Loading tables...
          </p>
        ) : error ? (
          <p className="error" style={{ padding: 14 }}>
            {error}
          </p>
        ) : tables.length === 0 ? (
          <p className="hint" style={{ padding: 14 }}>
            No tables in this schema.
          </p>
        ) : (
          <div className="pl-tbl-wrap">
            <table className="pl-tbl">
              <thead>
                <tr>
                  <th>Table</th>
                  <th>Rows</th>
                  <th>Columns</th>
                  <th>Comment</th>
                </tr>
              </thead>
              <tbody>
                {tables.map((t) => {
                  const key = `${t.schemaName}.${t.name}`;
                  return (
                    <tr key={t.name}>
                      <td>
                        <span className="pl-mono">{t.name}</span>
                      </td>
                      <td>{counts[key] !== undefined ? counts[key].toLocaleString() : "—"}</td>
                      <td>{t.columns?.length ?? "—"}</td>
                      <td>{t.comment ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
