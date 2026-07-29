import { useEffect, useMemo, useState } from "react";
import { getCatalogs, getSchemas, getWarehouses } from "../api/client";
import type { Catalog, LayerRef, Schema, Warehouse } from "../types";
import { detectLayers } from "../wizard/layers";
import { LayerEditor } from "./LayerEditor";
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
      setLayers(detectLayers(res.schemas.map((s) => s.name)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSchemas(false);
    }
  }

  const schemaNames = useMemo(() => schemas.map((s) => s.name), [schemas]);
  const completeLayers = layers.filter((l) => l.label.trim() && l.schema.trim());
  const canContinue = completeLayers.length >= 1 && warehouseId.trim().length > 0;

  return (
    <div className="step-body">
      <h2>Pipeline setup</h2>
      <p className="hint">
        Pick a catalog — Recon proposes a pipeline from the schema names and orders it most-raw first. Any layering
        works: bronze/silver/gold, raw → staged → transformation → datamart, or your own. Adjust the order, labels, or
        schemas, then choose the SQL warehouse and notebook folder to analyze.
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

      {catalog && !loadingSchemas && <LayerEditor schemas={schemaNames} layers={layers} onChange={setLayers} />}

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
