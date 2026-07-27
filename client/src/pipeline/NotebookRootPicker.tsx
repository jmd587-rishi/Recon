import { useEffect, useState } from "react";
import { browseWorkspace } from "../api/client";
import type { WorkspaceEntry } from "../types";

function parentOf(path: string): string {
  if (path === "/" || path === "") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

/**
 * Browse the Databricks workspace tree and pick a single folder to use as the root for a
 * whole-pipeline notebook scan (as opposed to `NotebookMultiPicker`, which accumulates a
 * multi-selection of individual notebooks across folders).
 */
export function NotebookRootPicker({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const [browsing, setBrowsing] = useState(false);
  const [currentPath, setCurrentPath] = useState(value || "/");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!browsing) return;
    setLoading(true);
    setError(null);
    browseWorkspace(currentPath)
      .then((res) => setEntries(res.entries))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [browsing, currentPath]);

  const directories = entries.filter((e) => e.type === "DIRECTORY");

  return (
    <div className="nb-picker">
      <div className="row" style={{ gap: 8 }}>
        <input
          type="text"
          value={value}
          placeholder="/Shared/etl"
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            setCurrentPath(value || "/");
            setBrowsing((b) => !b);
          }}
        >
          {browsing ? "Close" : "Browse..."}
        </button>
      </div>

      {browsing && (
        <div className="tree nb-tree" style={{ marginTop: 8 }}>
          <div className="breadcrumbs">{currentPath}</div>
          {loading && <p className="hint">Loading...</p>}
          {error && <p className="error">{error}</p>}
          {!loading && !error && (
            <ul className="tree nb-tree">
              {currentPath !== "/" && (
                <li>
                  <button type="button" className="tree-toggle" onClick={() => setCurrentPath(parentOf(currentPath))}>
                    ‹ up
                  </button>
                </li>
              )}
              {directories.map((dir) => (
                <li key={dir.path} className="row" style={{ gap: 8 }}>
                  <button type="button" className="tree-toggle" onClick={() => setCurrentPath(dir.path)}>
                    <span className="nb-folder-icon">▸</span> {dir.name}
                  </button>
                  <button
                    type="button"
                    className="btn-sm"
                    onClick={() => {
                      onChange(dir.path);
                      setBrowsing(false);
                    }}
                  >
                    Use this folder
                  </button>
                </li>
              ))}
              {directories.length === 0 && <li className="hint">(no subfolders)</li>}
            </ul>
          )}
          <button type="button" className="btn-sm" onClick={() => { onChange(currentPath); setBrowsing(false); }}>
            Use current folder ({currentPath})
          </button>
        </div>
      )}
    </div>
  );
}
