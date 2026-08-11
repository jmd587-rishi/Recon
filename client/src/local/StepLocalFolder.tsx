import { useEffect, useRef, useState } from "react";
import { detectLocalLayers, scanLocalFolder } from "../api/client";
import { LayerEditor } from "../pipeline/LayerEditor";
import type { LayerDetectionReport, LayerRef, LocalScanResult } from "../types";
import { detectLayers } from "../wizard/layers";
import { type FolderScan, locateSqlFiles, MAX_FILES } from "./sqlFiles";

function kb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** How the layers on screen were arrived at, said plainly so a fallback never passes for a reading. */
const LAYER_SOURCE_NOTE: Record<LayerDetectionReport["source"], string> = {
  ai: "These layers were read out of the SQL — what each schema's tables are and what the code does to them.",
  keyword: "These layers were matched from the schema names alone.",
  lineage: "No schema name was recognizable, so these layers are ordered by which schema the SQL builds from which.",
  explicit: "These layers were given explicitly.",
  approved: "These layers were approved in an earlier run."
};

/**
 * Picks a folder from disk, finds the SQL in it, and confirms the pipeline layers before opening the
 * analysis.
 *
 * The layer step matters more here than in the Databricks flow: there is no catalog to list the
 * schemas, only whatever the SQL happens to qualify its tables with. So the layers are worked out
 * twice — instantly from the schema names, which is wrong for any project not named after a
 * medallion convention, and then properly by the server reading the SQL itself. The second answer
 * replaces the first when it arrives, and either way it is shown for correction rather than applied
 * silently.
 */
export function StepLocalFolder({
  onBack,
  onReady
}: {
  onBack: () => void;
  onReady: (scan: LocalScanResult, layers: LayerRef[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState<FolderScan | null>(null);
  const [reading, setReading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<LocalScanResult | null>(null);
  const [layers, setLayers] = useState<LayerRef[]>([]);
  const [detection, setDetection] = useState<LayerDetectionReport | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `webkitdirectory` isn't in React's attribute types, and setting it via a spread would defeat
  // JSX's type checking for the rest of the element — so it goes on the DOM node directly.
  useEffect(() => {
    inputRef.current?.setAttribute("webkitdirectory", "");
    inputRef.current?.setAttribute("directory", "");
  }, []);

  async function handlePick(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setReading(true);
    setError(null);
    setScan(null);
    try {
      setFolder(await locateSqlFiles(fileList));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(false);
    }
  }

  async function handleAnalyze() {
    if (!folder) return;
    setScanning(true);
    setError(null);
    try {
      const result = await scanLocalFolder({
        folderName: folder.folderName,
        files: folder.files.map((f) => ({ path: f.path, content: f.content }))
      });
      setScan(result);
      // The schema-name guess goes up straight away so the editor is never blank, then the read of
      // the SQL replaces it a few seconds later. Not awaited: the stats and the file list are worth
      // looking at while that happens.
      setLayers(detectLayers(result.schemas));
      void readLayers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }

  /**
   * Asks the server what this folder's layers are, having read it. A failure here is not the step
   * failing — the schema-name guess is already on screen and stays there — so it is reported next to
   * the layers rather than as the page's error.
   */
  async function readLayers() {
    setDetecting(true);
    setDetection(null);
    try {
      const report = await detectLocalLayers();
      setDetection(report);
      if (report.layers.length > 0) setLayers(report.layers);
    } catch (err) {
      setDetection({
        layers: [],
        source: "keyword",
        grouping: "schema",
        reasons: {},
        excluded: [],
        unplaced: [],
        notice: `Reading the SQL to work the layers out failed (${err instanceof Error ? err.message : String(err)}), so these were matched from the schema names.`,
        warning: null
      });
    } finally {
      setDetecting(false);
    }
  }

  const completeLayers = layers.filter((l) => l.label.trim() && l.schema.trim());

  return (
    <div className="step-body">
      <h2>Analyze a local SQL folder</h2>
      <p className="hint">
        Pick a folder from your machine — Recon finds every <span className="pl-mono">.sql</span> file inside it,
        including subfolders, and works out the table lineage and governance risks from the SQL alone. No workspace
        connection, catalog or warehouse needed.
      </p>

      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => handlePick(e.target.files)}
      />

      <div className="local-drop">
        <button type="button" onClick={() => inputRef.current?.click()} disabled={reading || scanning}>
          {reading ? "Reading folder..." : folder ? "Choose a different folder" : "Choose folder"}
        </button>
        {folder && (
          <span className="pl-card-sub">
            <b>{folder.folderName}</b> — {folder.files.length} SQL file{folder.files.length === 1 ? "" : "s"}
            {folder.otherFileCount > 0 && ` · ${folder.otherFileCount} other file(s) ignored`}
          </span>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {folder && folder.files.length === 0 && (
        <p className="hint">
          No <span className="pl-mono">.sql</span> files were found in that folder. Pick a folder containing your SQL
          transformation scripts.
        </p>
      )}

      {folder && folder.files.length > 0 && (
        <div className="layers-editor">
          <div className="layers-editor-head">
            <h3>SQL files found</h3>
            {!scan && (
              <button type="button" className="btn-ghost" onClick={handleAnalyze} disabled={scanning}>
                {scanning ? "Analyzing..." : `Analyze ${folder.files.length} file${folder.files.length === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
          <div className="local-file-list">
            {folder.files.map((f) => (
              <div key={f.path} className="local-file-row">
                <span className="pl-mono">{f.path}</span>
                <span className="pl-card-sub">{kb(f.bytes)}</span>
              </div>
            ))}
          </div>
          {folder.skipped.length > 0 && (
            <p className="hint">
              Skipped {folder.skipped.length} file(s): {folder.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}.
              At most {MAX_FILES} files are read per folder.
            </p>
          )}
        </div>
      )}

      {scan && (
        <>
          <div className="layers-editor">
            <h3>What was found</h3>
            <div className="pl-stat-row">
              <div className="pl-stat">
                <div className="pl-stat-value">{scan.stats.statementCount}</div>
                <div className="pl-stat-label">SQL statements</div>
              </div>
              <div className="pl-stat">
                <div className="pl-stat-value">{scan.stats.tableCount}</div>
                <div className="pl-stat-label">Tables referenced</div>
              </div>
              <div className="pl-stat">
                <div className="pl-stat-value">{scan.stats.lineageEdgeCount}</div>
                <div className="pl-stat-label">Lineage edges</div>
              </div>
              <div className="pl-stat">
                <div className="pl-stat-value">{scan.stats.schemaCount}</div>
                <div className="pl-stat-label">Schemas</div>
              </div>
            </div>
          </div>

          <div className="hint">
            {detecting && <div>Reading the SQL to work out which schemas are pipeline layers...</div>}
            {!detecting && detection && (
              <>
                {detection.layers.length > 0 && (
                  <div>
                    {LAYER_SOURCE_NOTE[detection.source]}
                    {detection.grouping === "folder"
                      ? " The schemas did not separate this pipeline, so the layers are its source folders."
                      : ""}
                  </div>
                )}
                {detection.notice && <div>{detection.notice}</div>}
                {detection.layers.map((layer) => (
                  <div key={layer.schema}>
                    <b>{layer.label}</b>
                    {layer.role ? ` [${layer.role}]` : ""}
                    {layer.tables ? ` (${layer.tables.length} table${layer.tables.length === 1 ? "" : "s"})` : ""}
                    {detection.reasons[layer.schema] ? ` — ${detection.reasons[layer.schema]}` : ""}
                  </div>
                ))}
                {detection.excluded.map((entry) => (
                  <div key={entry.schema}>
                    Left out of the pipeline: <b>{entry.schema}</b>
                    {entry.reason ? ` — ${entry.reason}` : ""}
                  </div>
                ))}
                {detection.unplaced.length > 0 && (
                  <div>Not placed in the pipeline: {detection.unplaced.join(", ")}.</div>
                )}
                {detection.warning && <div>{detection.warning}</div>}
              </>
            )}
          </div>

          <LayerEditor
            schemas={scan.schemas}
            layers={layers}
            onChange={setLayers}
            title="Layers inferred from the SQL (top = most raw)"
            emptyHint={
              scan.schemas.length === 0
                ? "The SQL never qualifies its tables with a schema, so no layers could be inferred. You can still run a governance review across every file — it just won't be split into hops."
                : "None of the schemas found in the SQL matched a recognizable pipeline layer. Add the ones that are layers below, in order, most-raw first."
            }
          />
        </>
      )}

      <div className="step-actions">
        <button type="button" className="btn-ghost" onClick={onBack}>
          ← Back
        </button>
        <button type="button" onClick={() => scan && onReady(scan, completeLayers)} disabled={!scan}>
          Open analysis →
        </button>
      </div>
    </div>
  );
}
