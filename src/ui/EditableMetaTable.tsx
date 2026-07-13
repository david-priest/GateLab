// EditableMetaTable.tsx — a small hand-rolled editable metadata table (no table library — matches the
// app's lightweight house style). Rows have a name + read-only derived columns, then user-defined
// editable field columns (add / rename / delete). Used for BOTH the Sample and Population metadata
// tables in the Metadata tab. Values are keyed by row id (sample id / population id).

import { useRef, useState } from "react";
import type { MetadataColumn } from "../engine/metadata";

export interface MetaRow {
  id: string; // join key: sample id or population id
  name: string; // first-column display name
  fixed: (string | number)[]; // read-only derived cell values, aligned to fixedHeaders
}

interface Props {
  title: string;
  rowHeader: string; // "Sample" | "Population"
  fixedHeaders: string[]; // read-only derived column headers
  rows: MetaRow[];
  columns: MetadataColumn[]; // editable field columns
  values: Record<string, Record<string, string>>; // rowId → field → value
  onSetCell: (id: string, field: string, value: string) => void;
  onAddColumn: (name: string) => void;
  onRenameColumn: (oldName: string, newName: string) => void;
  onDeleteColumn: (name: string) => void;
  onImport?: (file: File) => void; // optional CSV/TSV import
  templateFilename: string;
  templateKeyHeader: string; // first CSV column header: "filename" | "population"
  hint: string;
  emptyMessage: string;
}

export function EditableMetaTable({
  title, rowHeader, fixedHeaders, rows, columns, values,
  onSetCell, onAddColumn, onRenameColumn, onDeleteColumn, onImport,
  templateFilename, templateKeyHeader, hint, emptyMessage,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Record<string, string>>({}); // "cell:id:field" | "hdr:field" → live text
  const cellKey = (id: string, f: string) => `cell:${id}:${f}`;
  const hdrKey = (f: string) => `hdr:${f}`;
  const clear = (k: string) => setDraft((d) => { const n = { ...d }; delete n[k]; return n; });

  // Download a CSV template (key column + one row per entity, current field values pre-filled).
  const downloadTemplate = () => {
    const cols = columns.length ? columns.map((c) => c.name) : ["group"];
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const header = [templateKeyHeader, ...cols].join(",");
    const body = rows.map((r) => [r.name, ...cols.map((c) => values[r.id]?.[c] ?? "")].map(esc).join(","));
    const url = URL.createObjectURL(new Blob([[header, ...body].join("\n") + "\n"], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = templateFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="gl-meta-section">
      <div className="gl-tab-head">
        <h2 className="gl-tab-title">{title}</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="gl-btn-ghost" onClick={() => onAddColumn(`field${columns.length + 1}`)}>+ Field</button>
          <button className="gl-btn-ghost" onClick={downloadTemplate}>Export template</button>
          {onImport && (
            <>
              <button className="gl-btn-ghost" onClick={() => fileRef.current?.click()}>Import CSV/TSV…</button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
                style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f && onImport) onImport(f); e.currentTarget.value = ""; }}
              />
            </>
          )}
        </div>
      </div>
      <p className="gl-hint gl-panel-hint">{hint}</p>

      {rows.length === 0 ? (
        <p className="gl-hint">{emptyMessage}</p>
      ) : (
        <div className="gl-stats-scroll">
          <table className="gl-stats-table gl-meta-table">
            <thead>
              <tr>
                <th className="gl-stats-name">{rowHeader}</th>
                {fixedHeaders.map((h) => <th key={h} className="gl-stats-num">{h}</th>)}
                {columns.map((c) => (
                  <th key={c.name} className="gl-meta-col">
                    <div className="gl-meta-col-head">
                      <input
                        className="gl-field-input gl-meta-hdr-input"
                        value={draft[hdrKey(c.name)] ?? c.name}
                        onChange={(e) => setDraft((d) => ({ ...d, [hdrKey(c.name)]: e.target.value }))}
                        onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v && v !== c.name) onRenameColumn(c.name, v); clear(hdrKey(c.name)); }}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      />
                      <button className="gl-meta-del" title="Delete field" onClick={() => onDeleteColumn(c.name)}>×</button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="gl-stats-name">{r.name}</td>
                  {r.fixed.map((v, i) => <td key={i} className="gl-stats-num">{v}</td>)}
                  {columns.map((c) => {
                    const k = cellKey(r.id, c.name);
                    const val = values[r.id]?.[c.name] ?? "";
                    return (
                      <td key={c.name} className="gl-meta-cell">
                        <input
                          className="gl-field-input gl-meta-input"
                          value={draft[k] ?? val}
                          onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                          onBlur={(e) => { onSetCell(r.id, c.name, e.currentTarget.value); clear(k); }}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
