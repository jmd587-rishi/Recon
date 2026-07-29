import type { LocalScanResult } from "../types";

export function SectionLocalLineage({ scan }: { scan: LocalScanResult }) {
  return (
    <div className="pl-card">
      <div className="pl-card-header">
        <div>
          <div className="pl-card-title">Table lineage</div>
          <div className="pl-card-sub">
            {scan.lineage.length} join/dependency edge{scan.lineage.length === 1 ? "" : "s"} parsed from the SQL in{" "}
            <span className="pl-mono">{scan.folderName}</span>
          </div>
        </div>
      </div>
      {scan.lineage.length === 0 ? (
        <p className="hint" style={{ padding: 14 }}>
          No lineage edges were found. Recon builds edges from statements that write a table (
          <span className="pl-mono">CREATE TABLE … AS</span>, <span className="pl-mono">INSERT INTO</span>,{" "}
          <span className="pl-mono">MERGE INTO</span>) while reading another — a folder of read-only queries produces
          none.
        </p>
      ) : (
        <div className="pl-tbl-wrap">
          <table className="pl-tbl">
            <thead>
              <tr>
                <th>Source table</th>
                <th>Target table</th>
                <th>Join key</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {scan.lineage.map((edge, i) => (
                <tr key={i}>
                  <td>
                    <span className="pl-mono">{edge.from}</span>
                  </td>
                  <td>
                    <span className="pl-mono">{edge.to}</span>
                  </td>
                  <td>{edge.joinKeyHint ?? "—"}</td>
                  <td className="pl-card-sub">
                    {edge.notebookPath} (statement {edge.cellIndex})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
