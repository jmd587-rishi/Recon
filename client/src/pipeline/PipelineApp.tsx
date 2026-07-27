import { useState } from "react";
import type { LayerRef } from "../types";
import { Dashboard } from "./Dashboard";
import { StepConnect } from "./StepConnect";
import { StepPipelineSetup } from "./StepPipelineSetup";

type Phase = "connect" | "setup" | "dashboard";

export function PipelineApp() {
  const [phase, setPhase] = useState<Phase>("connect");
  const [catalog, setCatalog] = useState("");
  const [layers, setLayers] = useState<LayerRef[]>([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [notebookRoot, setNotebookRoot] = useState("/");

  function handleSetupDone(nextCatalog: string, nextLayers: LayerRef[], nextWarehouseId: string, nextNotebookRoot: string) {
    setCatalog(nextCatalog);
    setLayers(nextLayers);
    setWarehouseId(nextWarehouseId);
    setNotebookRoot(nextNotebookRoot);
    setPhase("dashboard");
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
            {phase === "connect" && <StepConnect onConnected={() => setPhase("setup")} />}
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
          </div>
        </div>
      </main>
    </div>
  );
}
