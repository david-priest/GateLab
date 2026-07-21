// PanelTab.tsx — Panel tab, mirroring GateLabR's Panel tab: rename the display name (marker)
// per channel. The FCS channel id ($PnN) is fixed and shown for reference; scatter (FSC/SSC)
// and QC/Time channels are locked. Renames are cosmetic — gates/masks/workspace key off the
// stable channel identity, never the label — so a rename can never break a gate. The rename
// applies to every loaded sample that has the channel, keeping the shared gate tree consistent.

import { useState } from "react";
import type { Sample } from "../engine/sample";
import { useI18n } from "./i18n";

interface Props {
  sample: Sample;
  /** rename the channel identity `key` to `label` ("" resets to default) across all samples */
  onRename: (key: string, label: string) => void;
  onResetAll: () => void;
}

export function PanelTab({ sample, onRename, onResetAll }: Props) {
  const { t } = useI18n();
  // Local draft so typing is smooth; commit on blur / Enter.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const rows = sample.channels.map((c, i) => ({
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

  return (
    <div className="gl-tab-panel">
      <div className="gl-tab-head">
        <h2 className="gl-tab-title">{t("Panel — channel names")}</h2>
        <button className="gl-btn-ghost" onClick={onResetAll} disabled={!anyRenamed}>
          {t("Reset all")}
        </button>
      </div>
      <p className="gl-hint gl-panel-hint">
        {t("Rename the display name (marker) for each channel. The FCS channel id ($PnN) is fixed. Scatter and Time/QC channels are locked. Renames apply to every loaded sample and are cosmetic — gates and statistics are unaffected.")}
      </p>

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
