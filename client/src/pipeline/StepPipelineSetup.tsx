import { useEffect, useState } from "react";
import { getCatalogs, getSchemas, getWarehouses } from "../api/client";
import type { Catalog, LayerRef, Schema, Warehouse } from "../types";
import { detectLayers } from "../wizard/layers";
import { NotebookRootPicker } from "./NotebookRootPicker";

export function StepPipelineSetup({
  initialCatalog,
  initialLayers,
  initialWarehouseId,
  initialNotebookRoot,
  onBack,
  onDone
}: {
  initialCatalog: string;
  initialLayers: LayerRef[];
  initialWarehouseId: string;
  initialNotebookRoot: string;
  onBack: () => void;
  onDone: (catalog: string, layers: LayerRef[], warehouseId: string, notebookRoot: string) => void;
}) {
  const [catalogs, setCatalogs] = useState<Catalog[]>([]);
  const [catalog, setCatalog] = useState(initialCatalog);
  const [schemas, setSchemas] = useState<Schema[]>([]);
  const [layers, setLayers] = useState<LayerRef[]>(initialLayers);
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState(initialWarehouseId);
  const [loadingWarehouses, setLoadingWarehouses] = useState(true);
  const [notebookRoot, setNotebookRoot] = useState(initialNotebookRoot || "/");

  useEffect(() => {
    getCatalogs()
      .then((res) => setCatalogs(res.catalogs))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    getWarehouses()
      .then((res) => setWarehouses(res.warehouses))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingWarehouses(false));
  }, []);

  async function handleCatalogChange(name: string) {
    setCatalog(name);
    setSchemas([]);
    setLayers([]);
    if (!name) return;
    setLoadingSchemas(true);
    setError(null);
    try {
      const res = await getSchemas(name);
      setSchemas(res.schemas);
      setLayers(detectLayers(res.schemas));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSchemas(false);
    }
  }

  function updateLayer(index: number, patch: Partial<LayerRef>) {
    setLayers((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLayer(index: number) {
    setLayers((prev) => prev.filter((_, i) => i !== index));
  }

  function move(index: number, dir: -1 | 1) {
    setLayers((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function addLayer() {
    const used = new Set(layers.map((l) => l.schema));
    const firstFree = schemas.find((s) => !used.has(s.name));
    setLayers((prev) => [...prev, { label: "", schema: firstFree?.name ?? "" }]);
  }

  const completeLayers = layers.filter((l) => l.label.trim() && l.schema.trim());
  const canContinue = completeLayers.length >= 1 && warehouseId.trim().length > 0;

  return (
    <div className="step-body">
      <h2>Pipeline setup</h2>
      <p className="hint">
        Pick a catalog — Recon auto-detects the medallion layers from schema names and orders them. Adjust the
        order, labels, or schemas if needed, then choose the SQL warehouse and notebook folder to analyze.
      </p>

      <label className="form-label">
        Catalog
        <select value={catalog} onChange={(e) => handleCatalogChange(e.target.value)} required>
          <option value="">Select a catalog...</option>
          {catalogs.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {loadingSchemas && <p className="hint">Loading schemas...</p>}
      {error && <p className="error">{error}</p>}

      {catalog && !loadingSchemas && (
        <div className="layers-editor">
          <div className="layers-editor-head">
            <h3>Layers (top = most raw)</h3>
            <button type="button" className="btn-ghost" onClick={addLayer} disabled={layers.length >= schemas.length}>
              + Add layer
            </button>
          </div>

          {layers.length === 0 && (
            <p className="hint">
              No medallion layers were auto-detected from the schema names. Add them manually below.
            </p>
          )}

          <ul className="layer-rows">
            {layers.map((layer, i) => (
              <li key={i} className="layer-row">
                <div className="layer-order">
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={i === layers.length - 1}
                    aria-label="Move down"
                  >
                    ▼
                  </button>
                </div>
                <input
                  className="layer-label-input"
                  placeholder="label (e.g. raw)"
                  value={layer.label}
                  onChange={(e) => updateLayer(i, { label: e.target.value })}
                />
                <select value={layer.schema} onChange={(e) => updateLayer(i, { schema: e.target.value })}>
                  <option value="">Select schema...</option>
                  {schemas.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button type="button" className="chip-x layer-remove" onClick={() => removeLayer(i)} aria-label="Remove layer">
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {catalog && (
        <div className="layers-editor">
          <h3>Warehouse &amp; notebooks</h3>
          <label className="form-label">
            SQL warehouse
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required disabled={loadingWarehouses}>
              <option value="">{loadingWarehouses ? "Loading warehouses..." : "Select a warehouse..."}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.state.toLowerCase()})
                </option>
              ))}
            </select>
          </label>
          <label className="form-label">
            Notebook root folder
            <NotebookRootPicker value={notebookRoot} onChange={setNotebookRoot} />
          </label>
          <p className="hint">Used to scan for the transformation code that writes each table when analyzing the pipeline.</p>
        </div>
      )}

      <div className="step-actions">
        <button type="button" className="btn-ghost" onClick={onBack}>
          ← Back
        </button>
        <button
          type="button"
          onClick={() => onDone(catalog, completeLayers, warehouseId, notebookRoot || "/")}
          disabled={!canContinue}
        >
          Open pipeline dashboard →
        </button>
      </div>
    </div>
  );
}
