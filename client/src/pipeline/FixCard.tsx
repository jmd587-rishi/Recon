import { useState } from "react";
import type { CellEvidence, CodeFix, FixVerification, NotebookCorrection } from "../types";
import { triggerDownload } from "./corrections";
import { fmt, signed } from "./format";

/**
 * Rendering for one suggested code fix, shared by the Databricks governance gate and the local SQL
 * folder review. The evidence and verification blocks are driven off the fix itself, so the local
 * flow — which has no warehouse and therefore neither — reuses this untouched.
 */

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button type="button" className="btn-sm" onClick={copy}>
      {copied ? "Copied ✓" : label}
    </button>
  );
}

/** The measured counts behind one cell, rendered under the fix that touches it. */
function EvidenceLines({ evidence }: { evidence: CellEvidence }) {
  const rows = [
    ...evidence.rowCounts.map((rc) => ({
      key: `${rc.sourceTable}->${rc.targetTable}`,
      text: `${rc.sourceTable} ${fmt(rc.sourceRows)} → ${rc.targetTable} ${fmt(rc.targetRows)}`,
      delta: rc.delta
    })),
    ...evidence.filters.map((f) => ({
      key: `filter:${f.predicateSql}`,
      text: `filter ${f.predicateSql} on ${f.sourceTable}`,
      delta: f.excludedRows === null ? null : -f.excludedRows
    }))
  ];
  if (rows.length === 0) return null;

  return (
    <div className="pl-evidence">
      {rows.map((r) => (
        <div key={r.key} className="pl-evidence-row">
          <span className="pl-evidence-text">{r.text}</span>
          {r.delta !== null && (
            <span className={`pl-delta ${r.delta === 0 ? "" : r.delta > 0 ? "up" : "down"}`}>{signed(r.delta)} rows</span>
          )}
        </div>
      ))}
    </div>
  );
}

const VERIFY_LABEL: Record<FixVerification["status"], string> = {
  verified: "verified",
  unverified: "not verified",
  failed: "check failed"
};

function VerificationBadge({ verification }: { verification: FixVerification }) {
  return (
    <span className={`pl-verify pl-verify-${verification.status}`} title={verification.reason}>
      {VERIFY_LABEL[verification.status]}
      {verification.delta !== null && ` · ${signed(verification.delta)} rows`}
    </span>
  );
}

export function FixCard({ fix, unit = "cell" }: { fix: CodeFix; unit?: string }) {
  const [showOriginal, setShowOriginal] = useState(false);
  return (
    <div className={`pl-rule-card ${fix.severity === "error" ? "warn" : fix.severity === "warning" ? "warn" : "ok"}`}>
      <div className="pl-rule-head">
        <span className="pl-rule-label">{fix.title}</span>
        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {fix.verification && <VerificationBadge verification={fix.verification} />}
          <span className={`pl-sev pl-sev-${fix.severity}`}>{fix.severity}</span>
        </span>
      </div>
      <div className="pl-card-sub" style={{ marginBottom: 6 }}>
        {fix.notebookPath} ({unit} {fix.cellIndex})
      </div>
      {fix.evidence && <EvidenceLines evidence={fix.evidence} />}
      {fix.rationale && <p className="pl-rule-body">{fix.rationale}</p>}
      {fix.verification && <p className="pl-card-sub">Verification: {fix.verification.reason}</p>}
      <div className="pl-code-head">
        <span className="pl-card-sub">{showOriginal ? "Original code" : "Corrected code"}</span>
        <span style={{ display: "flex", gap: 6 }}>
          <button type="button" className="btn-sm" onClick={() => setShowOriginal((v) => !v)}>
            {showOriginal ? "Show corrected" : "Show original"}
          </button>
          <CopyButton text={fix.correctedCode} label="Copy fix" />
        </span>
      </div>
      <pre className="pl-code">
        <code>{showOriginal ? fix.originalCode : fix.correctedCode}</code>
      </pre>
    </div>
  );
}

/** One downloadable whole-file correction, with the fixes for that file already applied. */
export function CorrectionRow({ correction, unit = "cell" }: { correction: NotebookCorrection; unit?: string }) {
  return (
    <div className="pl-corr-row">
      <div>
        <div className="pl-rule-label">{correction.filename}</div>
        <div className="pl-card-sub">
          {correction.notebookPath} · {correction.changedCells} {unit}
          {correction.changedCells === 1 ? "" : "s"} corrected
        </div>
      </div>
      <button
        type="button"
        className="btn-sm"
        onClick={() =>
          triggerDownload(
            correction.filename,
            new Blob([correction.correctedSource], { type: "text/plain;charset=utf-8" })
          )
        }
      >
        ↓ Download corrected file
      </button>
    </div>
  );
}
