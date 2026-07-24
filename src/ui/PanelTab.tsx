// PanelTab.tsx — Panel tab, mirroring GateLabR's Panel tab: rename the display name (marker)
// per channel. The FCS channel id ($PnN) is fixed and shown for reference; scatter (FSC/SSC)
// and QC/Time channels are locked. Renames are cosmetic — gates/masks/workspace key off the
// stable channel identity, never the label — so a rename can never break a gate. The rename
// applies to every loaded sample that has the channel, keeping the shared gate tree consistent.

import { useRef, useState } from "react";
import {
  parsePanelImport,
  serializePanelTemplate,
  type PanelImportPreview,
  type PanelTableChannel,
} from "../engine/panelTable";
import type { Sample } from "../engine/sample";
import { useI18n } from "./i18n";

interface Props {
  sample: Sample;
  /** rename the channel identity `key` to `label` ("" resets to default) across all samples */
  onRename: (key: string, label: string) => void;
  /** Apply a validated bulk rename as one workspace change. */
  onRenameMany: (changes: readonly { key: string; label: string }[]) => void;
  onResetAll: () => void;
}

interface ImportDraft {
  fileName: string;
  preview: PanelImportPreview;
}

export function PanelTab({ sample, onRename, onRenameMany, onResetAll }: Props) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  // Local draft so typing is smooth; commit on blur / Enter.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [importDraft, setImportDraft] = useState<ImportDraft | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const rows: (PanelTableChannel & { idx: number; renamed: boolean })[] = sample.channels.map((c, i) => ({
    idx: i,
    key: c.key,
    pnn: c.pnn,
    marker: c.marker,
    label: sample.channelLabel(i),
    renamable: sample.isRenamable(i),
    renamed: !!c.label && c.label !== c.key,
  }));
  const anyRenamed = rows.some((r) => r.renamed);

  const clearDraft = (key: string) =>
    setDraft((d) => {
      const n = { ...d };
      delete n[key];
      return n;
    });
  // Commit the LIVE input value (not `draft` state, which may not have flushed on a fast blur).
  const commit = (key: string, value: string) => {
    onRename(key, value);
    clearDraft(key);
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([serializePanelTemplate(rows)], {
      type: "text/csv;charset=utf-8",
    }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "gatelab_panel_template.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const readImport = async (file: File) => {
    setImportError(null);
    setImportDraft(null);
    try {
      setImportDraft({ fileName: file.name, preview: parsePanelImport(await file.text(), rows) });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not read the panel import file.");
    }
  };

  const applyImport = () => {
    if (!importDraft || importDraft.preview.changes.length === 0) return;
    onRenameMany(importDraft.preview.changes.map(({ key, label }) => ({ key, label })));
    setImportDraft(null);
    setImportError(null);
  };

  return (
    <div className="gl-tab-panel">
      <div className="gl-tab-head">
        <h2 className="gl-tab-title">{t("Panel — channel names")}</h2>
        <div className="gl-panel-actions">
          <button type="button" className="gl-btn-ghost" onClick={downloadTemplate}>
            {t("Download template")}
          </button>
          <button type="button" className="gl-btn-ghost" onClick={() => fileRef.current?.click()}>
            {t("Upload CSV/TSV…")}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void readImport(file);
            }}
          />
          <button type="button" className="gl-btn-ghost" onClick={onResetAll} disabled={!anyRenamed}>
            {t("Reset all")}
          </button>
        </div>
      </div>
      <p className="gl-hint gl-panel-hint">
        {t("Rename the display name (marker) for each channel. The FCS channel id ($PnN) is fixed. Scatter and Time/QC channels are locked. Renames apply to every loaded sample and are cosmetic — gates and statistics are unaffected. Download the template to edit display names in Excel, then upload it here; omitted channels remain unchanged.")}
      </p>

      {importError && (
        <div className="gl-panel-import gl-panel-import-error" role="alert">
          <span>{t(importError)}</span>
          <button type="button" className="gl-mini-btn" onClick={() => setImportError(null)}>{t("Dismiss")}</button>
        </div>
      )}
      {importDraft && (
        <div className="gl-panel-import" role="status" aria-live="polite">
          <div className="gl-panel-import-copy">
            <strong>{importDraft.fileName}</strong>
            <span>
              {importDraft.preview.changes.length > 0
                ? t("Ready to apply {count} display-name changes.", { count: importDraft.preview.changes.length })
                : t("No display-name changes found.")}
            </span>
            <div className="gl-panel-import-counts">
              <span>{t("{count} matched", { count: importDraft.preview.matchedCount })}</span>
              {importDraft.preview.unchangedCount > 0 && (
                <span>{t("{count} unchanged", { count: importDraft.preview.unchangedCount })}</span>
              )}
              {importDraft.preview.lockedIgnoredCount > 0 && (
                <span>{t("{count} locked changes ignored", { count: importDraft.preview.lockedIgnoredCount })}</span>
              )}
              {importDraft.preview.unknownIdentifiers.length > 0 && (
                <span>{t("{count} unknown rows ignored", { count: importDraft.preview.unknownIdentifiers.length })}</span>
              )}
              {importDraft.preview.omittedCount > 0 && (
                <span>{t("{count} omitted channels unchanged", { count: importDraft.preview.omittedCount })}</span>
              )}
            </div>
          </div>
          <div className="gl-panel-import-actions">
            <button type="button" className="gl-btn-ghost" onClick={() => setImportDraft(null)}>{t("Cancel")}</button>
            <button
              type="button"
              className="gl-btn-primary"
              disabled={importDraft.preview.changes.length === 0}
              onClick={applyImport}
            >
              {t("Apply panel changes")}
            </button>
          </div>
        </div>
      )}

      <div className="gl-stats-scroll">
        <table className="gl-stats-table gl-panel-table">
          <thead>
            <tr>
              <th className="gl-stats-name">{t("Channel ($PnN)")}</th>
              <th className="gl-stats-name">{t("Marker ($PnS)")}</th>
              <th className="gl-stats-name">{t("Display name")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.renamed ? "renamed" : ""}>
                <td className="gl-stats-name"><code>{r.pnn}</code></td>
                <td className="gl-stats-name">{r.marker ?? <span className="gl-muted">—</span>}</td>
                <td className="gl-stats-name">
                  <div className="gl-panel-edit">
                    <input
                      className="gl-field-input gl-panel-input"
                      value={draft[r.key] ?? r.label}
                      disabled={!r.renamable}
                      title={r.renamable ? "" : t("Locked (scatter / QC channel)")}
                      onChange={(e) => setDraft((d) => ({ ...d, [r.key]: e.target.value }))}
                      onBlur={(e) => commit(r.key, e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        else if (e.key === "Escape") {
                          clearDraft(r.key);
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                    />
                    {r.renamed && (
                      <button
                        className="gl-mini-btn"
                        title={t("Reset to default")}
                        onClick={() => onRename(r.key, "")}
                      >
                        ↺
                      </button>
                    )}
                    {!r.renamable && <span className="gl-pill-lock">{t("locked")}</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
