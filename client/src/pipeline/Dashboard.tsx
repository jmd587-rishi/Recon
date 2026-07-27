import { useState } from "react";
import { analyzePipeline } from "../api/client";
import type { LayerRef, PipelineAnalysis } from "../types";
import "./pipeline.css";
import { SectionExclusions } from "./SectionExclusions";
import { SectionLayers } from "./SectionLayers";
import { SectionLineage } from "./SectionLineage";
import { SectionSummary } from "./SectionSummary";

type Section = "layers" | "exclusions" | "lineage" | "summary";

export function Dashboard({
  catalog,
  layers,
  warehouseId,
  notebookRoot,
  onReconfigure
}: {
  catalog: string;
  layers: LayerRef[];
  warehouseId: string;
  notebookRoot: string;
  onReconfigure: () => void;
}) {
  const [section, setSection] = useState<Section>("layers");
  const [analysis, setAnalysis] = useState<PipelineAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  async function runAnalysis() {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await analyzePipeline({ catalog, warehouseId, notebookRoot, layers });
      setAnalysis(res);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <div className="pipeline-shell">
      <div className="pl-topbar">
        <div className="pl-topbar-brand">
          <div className="pl-mark">R</div>
          <div>
            <div className="pl-name">Recon AI</div>
            <div className="pl-org">Raw to Data Mart</div>
          </div>
        </div>
        <span className="pl-topbar-crumb">
          <b>{catalog}</b> · {layers.length} layers
        </span>
        <div className="pl-topbar-right">
          <button type="button" className="btn-ghost" onClick={onReconfigure}>
            Reconfigure
          </button>
        </div>
      </div>

      <div className="pl-body">
        <aside className="pl-sidebar">
          <button type="button" className={`pl-nav-item${section === "layers" ? " on" : ""}`} onClick={() => setSection("layers")}>
            S1 · Layers &amp; tables
          </button>
          <button
            type="button"
            className={`pl-nav-item${section === "exclusions" ? " on" : ""}`}
            onClick={() => setSection("exclusions")}
          >
            S2 · Exclusions
          </button>
          <button type="button" className={`pl-nav-item${section === "lineage" ? " on" : ""}`} onClick={() => setSection("lineage")}>
            S3 · Table lineage
          </button>
          <button type="button" className={`pl-nav-item${section === "summary" ? " on" : ""}`} onClick={() => setSection("summary")}>
            S4 · Project summary
          </button>
        </aside>

        <div className="pl-main">
          {section === "layers" && <SectionLayers catalog={catalog} layers={layers} warehouseId={warehouseId} />}
          {section === "exclusions" && (
            <SectionExclusions analysis={analysis} analyzing={analyzing} error={analyzeError} onAnalyze={runAnalysis} />
          )}
          {section === "lineage" && (
            <SectionLineage analysis={analysis} analyzing={analyzing} error={analyzeError} onAnalyze={runAnalysis} />
          )}
          {section === "summary" && (
            <SectionSummary catalog={catalog} layers={layers} warehouseId={warehouseId} notebookRoot={notebookRoot} />
          )}
        </div>
      </div>
    </div>
  );
}
