import { useMemo } from "react";
import type { LayerRef } from "../types";
import { roleForSchema, unassignedSchemas } from "../wizard/layers";

/**
 * Editor for the ordered list of pipeline layers, most-raw first.
 *
 * Shared by the two ways a pipeline gets defined: schemas listed from Unity Catalog
 * (`StepPipelineSetup`) and schemas parsed out of uploaded SQL files (`StepLocalFolder`). Both start
 * from `detectLayers`' guess, and in both cases that guess is only a proposal — mis-ordered layers
 * would silently produce the wrong hops downstream, so the user always gets to fix them.
 */
export function LayerEditor({
  schemas,
  layers,
  onChange,
  title = "Layers (top = most raw)",
  emptyHint
}: {
  /** Every schema a layer may be backed by. */
  schemas: string[];
  layers: LayerRef[];
  onChange: (next: LayerRef[]) => void;
  title?: string;
  emptyHint?: string;
}) {
  const unassigned = useMemo(() => unassignedSchemas(schemas, layers), [schemas, layers]);

  function updateLayer(index: number, patch: Partial<LayerRef>) {
    onChange(
      layers.map((l, i) => {
        if (i !== index) return l;
        const next = { ...l, ...patch };
        // Re-infer the role whenever the backing schema changes, so a hand-picked schema still
        // carries the hint that heuristics and prompts downstream read.
        if (patch.schema !== undefined) next.role = roleForSchema(patch.schema);
        return next;
      })
    );
  }

  function removeLayer(index: number) {
    onChange(layers.filter((_, i) => i !== index));
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= layers.length) return;
    const next = [...layers];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function addLayer(schemaName?: string) {
    const name = schemaName ?? unassigned[0] ?? "";
    onChange([...layers, { label: name, schema: name, role: name ? roleForSchema(name) : undefined }]);
  }

  return (
    <div className="layers-editor">
      <div className="layers-editor-head">
        <h3>{title}</h3>
        <button type="button" className="btn-ghost" onClick={() => addLayer()} disabled={unassigned.length === 0}>
          + Add layer
        </button>
      </div>

      {layers.length === 0 && (
        <p className="hint">
          {emptyHint ??
            "None of the schema names matched a recognizable pipeline layer. Add the schemas you want to analyze below, in order, most-raw first."}
        </p>
      )}

      <ul className="layer-rows">
        {layers.map((layer, i) => (
          <li key={i} className="layer-row">
            <div className="layer-order">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                ▲
              </button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === layers.length - 1} aria-label="Move down">
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
              {schemas.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button type="button" className="chip-x layer-remove" onClick={() => removeLayer(i)} aria-label="Remove layer">
              ×
            </button>
          </li>
        ))}
      </ul>

      {unassigned.length > 0 && (
        <div className="layer-unassigned">
          <p className="hint">Not in the pipeline yet — add any that belong, then move them into order:</p>
          <div className="layer-unassigned-chips">
            {unassigned.map((name) => (
              <button key={name} type="button" className="btn-ghost btn-sm" onClick={() => addLayer(name)}>
                + {name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
