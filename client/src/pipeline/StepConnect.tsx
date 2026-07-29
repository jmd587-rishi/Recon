import { useEffect, useState } from "react";
import { disconnect, getConnectionStatus, testConnection } from "../api/client";

export function StepConnect({
  onConnected,
  onUseLocalFolder
}: {
  onConnected: (host: string) => void;
  onUseLocalFolder: () => void;
}) {
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [connectedHost, setConnectedHost] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getConnectionStatus()
      .then((s) => {
        if (s.connected && s.host) setConnectedHost(s.host);
      })
      .catch(() => undefined);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await testConnection(host.trim(), token.trim());
      setConnectedHost(result.host);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDisconnect() {
    await disconnect().catch(() => undefined);
    setConnectedHost(null);
    setHost("");
    setToken("");
  }

  if (connectedHost) {
    return (
      <div className="step-body">
        <div className="connected-banner">
          <span className="dot-live" />
          <div>
            <strong>Connected</strong>
            <div className="notebook-path">{connectedHost}</div>
          </div>
          <button type="button" className="btn-ghost" onClick={handleDisconnect}>
            Disconnect
          </button>
        </div>
        <div className="step-actions">
          <button type="button" className="btn-ghost" onClick={onUseLocalFolder}>
            Analyze a local SQL folder instead
          </button>
          <button type="button" onClick={() => onConnected(connectedHost)}>
            Next: choose catalog →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="step-body">
      <h2>Connect to Databricks</h2>
      <p className="hint">Point Recon at your workspace with a personal access token to begin.</p>
      <form onSubmit={handleSubmit} className="form">
        <label>
          Workspace URL
          <input
            type="text"
            placeholder="https://xxxxxx.cloud.databricks.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            required
          />
        </label>
        <label>
          Personal Access Token
          <input
            type="password"
            placeholder="dapi..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? "Testing connection..." : "Connect"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}

      <div className="local-alt">
        <span className="hint">No workspace to hand? Recon can read SQL straight off your machine.</span>
        <button type="button" className="btn-ghost" onClick={onUseLocalFolder}>
          Analyze a local SQL folder →
        </button>
      </div>
    </div>
  );
}
