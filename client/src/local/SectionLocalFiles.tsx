import type { LocalScanResult } from "../types";

function kb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Groups the discovered tables by the schema they were qualified with, unqualified ones last. */
function tablesBySchema(scan: LocalScanResult): { schema: string; tables: LocalScanResult["tables"] }[] {
  const groups = new Map<string, LocalScanResult["tables"]>();
  for (const table of scan.tables) {
    const key = table.schema ?? "(unqualified)";
    groups.set(key, [...(groups.get(key) ?? []), table]);
  }
  return Array.from(groups.entries())
    .map(([schema, tables]) => ({ schema, tables }))
    .sort((a, b) => {
      if (a.schema === "(unqualified)") return 1;
      if (b.schema === "(unqualified)") return -1;
      return a.schema.localeCompare(b.schema);
    });
}

export function SectionLocalFiles({ scan }: { scan: LocalScanResult }) {
  return (
    <>
      <div className="pl-card">
        <div className="pl-card-header">
          <div>
            <div className="pl-card-title">SQL files</div>
            <div className="pl-card-sub">
              {scan.stats.fileCount} file{scan.stats.fileCount === 1 ? "" : "s"} · {scan.stats.statementCount} statement
              {scan.stats.statementCount === 1 ? "" : "s"} located under <span className="pl-mono">{scan.folderName}</span>
            </div>
          </div>
        </div>
        <div className="pl-tbl-wrap">
          <table className="pl-tbl">
            <thead>
              <tr>
                <th>File</th>
                <th>Statements</th>
                <th>Size</th>
                <th>Writes</th>
                <th>Reads</th>
              </tr>
            </thead>
            <tbody>
              {scan.files.map((file) => (
                <tr key={file.path}>
                  <td>
                    <span className="pl-mono">{file.path}</span>
                  </td>
                  <td>{file.statementCount}</td>
                  <td>{kb(file.bytes)}</td>
                  <td>
                    <span className="pl-mono">{file.writes.join(", ") || "—"}</span>
                  </td>
                  <td>
                    <span className="pl-mono">{file.reads.join(", ") || "—"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {scan.skipped.length > 0 && (
          <p className="hint" style={{ padding: 14 }}>
            Skipped: {scan.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}
          </p>
        )}
      </div>

      <div className="pl-card">
        <div className="pl-card-header">
          <div>
            <div className="pl-card-title">Tables referenced</div>
            <div className="pl-card-sub">
              {scan.stats.tableCount} table{scan.stats.tableCount === 1 ? "" : "s"} across {scan.stats.schemaCount} schema
              {scan.stats.schemaCount === 1 ? "" : "s"} — read from the SQL, not from a catalog, so this is exactly what
              the code touches
            </div>
          </div>
        </div>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          {tablesBySchema(scan).map((group) => (
            <div key={group.schema}>
              <div className="pl-rule-label">{group.schema}</div>
              <div className="layer-unassigned-chips" style={{ marginTop: 6 }}>
                {group.tables.map((t) => (
                  <span key={t.qualified} className={`chip ${t.written ? "chip-warn" : "chip-ok"}`} title={t.qualified}>
                    {t.name}
                    {t.written && t.read ? " · read+write" : t.written ? " · written" : " · read"}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
