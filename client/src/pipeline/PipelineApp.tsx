import { useState } from "react";
import { LocalDashboard } from "../local/LocalDashboard";
import { StepLocalFolder } from "../local/StepLocalFolder";
import type { LayerRef, LocalScanResult } from "../types";
import { Dashboard } from "./Dashboard";
import { StepConnect } from "./StepConnect";
import { StepPipelineSetup } from "./StepPipelineSetup";

type Phase = "connect" | "setup" | "dashboard" | "local-folder" | "local-dashboard";

export function PipelineApp() {
  const [phase, setPhase] = useState<Phase>("connect");
  const [catalog, setCatalog] = useState("");
  const [layers, setLayers] = useState<LayerRef[]>([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [notebookRoot, setNotebookRoot] = useState("/");

  // The local-folder flow has its own layers: they're inferred from schema qualifiers in the
  // uploaded SQL rather than from a catalog, and the two entry points never run at once.
  const [localScan, setLocalScan] = useState<LocalScanResult | null>(null);
  const [localLayers, setLocalLayers] = useState<LayerRef[]>([]);

  function handleSetupDone(nextCatalog: string, nextLayers: LayerRef[], nextWarehouseId: string, nextNotebookRoot: string) {
    setCatalog(nextCatalog);
    setLayers(nextLayers);
    setWarehouseId(nextWarehouseId);
    setNotebookRoot(nextNotebookRoot);
    setPhase("dashboard");
  }

  function handleLocalReady(scan: LocalScanResult, scanLayers: LayerRef[]) {
    setLocalScan(scan);
    setLocalLayers(scanLayers);
    setPhase("local-dashboard");
  }

  if (phase === "dashboard") {
    return (
      <Dashboard
        catalog={catalog}
        layers={layers}
        warehouseId={warehouseId}
        notebookRoot={notebookRoot}
        onReconfigure={() => setPhase("setup")}
      />
    );
  }

  if (phase === "local-dashboard" && localScan) {
    return <LocalDashboard scan={localScan} layers={localLayers} onReconfigure={() => setPhase("local-folder")} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <div>
            <h1>Recon AI</h1>
            <p className="brand-tagline">Raw to Data Mart — AI-explained lineage and exclusion rules.</p>
          </div>
        </div>
      </header>
      <main>
        <div className="wizard">
          <div className="wizard-panel">
            {phase === "connect" && (
              <StepConnect onConnected={() => setPhase("setup")} onUseLocalFolder={() => setPhase("local-folder")} />
            )}
            {phase === "setup" && (
              <StepPipelineSetup
                initialCatalog={catalog}
                initialLayers={layers}
                initialWarehouseId={warehouseId}
                initialNotebookRoot={notebookRoot}
                onBack={() => setPhase("connect")}
                onDone={handleSetupDone}
              />
            )}
            {phase === "local-folder" && (
              <StepLocalFolder onBack={() => setPhase("connect")} onReady={handleLocalReady} />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
