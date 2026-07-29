import { useState } from "react";
import "../pipeline/pipeline.css";
import type { LayerRef, LocalReconciliationSuite, LocalScanResult } from "../types";
import { SectionLocalFiles } from "./SectionLocalFiles";
import { SectionLocalGovernance } from "./SectionLocalGovernance";
import { SectionLocalLineage } from "./SectionLocalLineage";
import { SectionLocalReconciliation } from "./SectionLocalReconciliation";

type Section = "files" | "lineage" | "governance" | "reconciliation";

export function LocalDashboard({
  scan,
  layers,
  onReconfigure
}: {
  scan: LocalScanResult;
  layers: LayerRef[];
  onReconfigure: () => void;
}) {
  const [section, setSection] = useState<Section>("files");
  // Kept here rather than in the section: writing the scripts costs LLM calls, and leaving the tab
  // unmounts the section, so holding it there would re-run the model on every visit.
  const [reconSuite, setReconSuite] = useState<LocalReconciliationSuite | null>(null);

  return (
    <div className="pipeline-shell">
      <div className="pl-topbar">
        <div className="pl-topbar-brand">
          <div className="pl-mark">R</div>
          <div>
            <div className="pl-name">Recon AI</div>
            <div className="pl-org">Local SQL folder</div>
          </div>
        </div>
        <span className="pl-topbar-crumb">
          <b>{scan.folderName}</b> · {scan.stats.fileCount} SQL files ·{" "}
          {layers.length >= 2 ? `${layers.length} layers` : "no layers inferred"}
        </span>
        <div className="pl-topbar-right">
          <button type="button" className="btn-ghost" onClick={onReconfigure}>
            Choose another folder
          </button>
        </div>
      </div>

      <div className="pl-body">
        <aside className="pl-sidebar">
          <button type="button" className={`pl-nav-item${section === "files" ? " on" : ""}`} onClick={() => setSection("files")}>
            L1 · Files &amp; tables
          </button>
          <button
            type="button"
            className={`pl-nav-item${section === "lineage" ? " on" : ""}`}
            onClick={() => setSection("lineage")}
          >
            L2 · Table lineage
          </button>
          <button
            type="button"
            className={`pl-nav-item${section === "governance" ? " on" : ""}`}
            onClick={() => setSection("governance")}
          >
            L3 · Governance &amp; fixes
          </button>
          <button
            type="button"
            className={`pl-nav-item${section === "reconciliation" ? " on" : ""}`}
            onClick={() => setSection("reconciliation")}
          >
            L4 · Reconciliation scripts
          </button>
        </aside>

        <div className="pl-main">
          {section === "files" && <SectionLocalFiles scan={scan} />}
          {section === "lineage" && <SectionLocalLineage scan={scan} />}
          {section === "governance" && <SectionLocalGovernance folderName={scan.folderName} layers={layers} />}
          {section === "reconciliation" && (
            <SectionLocalReconciliation
              folderName={scan.folderName}
              layers={layers}
              suite={reconSuite}
              onSuite={setReconSuite}
            />
          )}
        </div>
      </div>
    </div>
  );
}
