// BarcodeSaveModal.tsx — write a workspace's debarcoding strategy back out: the scheme table
// (CSV, one row per sample population) and the gate template (JSON: QC chain and plane shapes).
// The two are the same record split by what each file can hold, so the dialog offers both.

import { useState } from "react";
import { useI18n } from "./i18n";

export interface BarcodeSaveSummary {
  /** Plane labels as they will be declared in the table. */
  planeLabels: string[];
  /** QC populations captured above the samples, outermost first. */
  qcNames: string[];
  nSamples: number;
  notes: string[];
}

export interface BarcodeSaveChoice {
  scheme: boolean;
  template: boolean;
}

export function BarcodeSaveModal({
  summary,
  onSave,
  onCancel,
}: {
  summary: BarcodeSaveSummary;
  onSave: (choice: BarcodeSaveChoice) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [scheme, setScheme] = useState(summary.nSamples > 0);
  const [template, setTemplate] = useState(true);
  return (
    <div className="gl-modal-backdrop">
      <div className="gl-modal" style={{ maxWidth: 560 }}>
        <div className="gl-modal-title">{t("Save barcode scheme")}</div>
        <div className="gl-modal-note">
          {t("{planes} plane(s): {labels}.", { planes: summary.planeLabels.length, labels: summary.planeLabels.join("; ") })}
          {" "}
          {summary.qcNames.length
            ? t("QC chain: {chain}.", { chain: summary.qcNames.join(" → ") })
            : t("No QC chain above the sample populations.")}
        </div>
        {summary.notes.map((n, i) => <div key={i} className="gl-modal-note">{n}</div>)}
        <label className="gl-modal-field" style={{ flexDirection: "row", gap: 8, alignItems: "baseline" }}>
          <input type="checkbox" checked={scheme} disabled={summary.nSamples === 0} onChange={(e) => setScheme(e.target.checked)} />
          <span>
            <strong>{t("Scheme table (CSV)")}</strong>{" "}
            {summary.nSamples > 0
              ? t("{count} sample population(s), one row each with its 0/1 states, name, file name and metadata.", { count: summary.nSamples })
              : t("No population uses exactly one gate from every plane, so there is no table to write.")}
          </span>
        </label>
        <label className="gl-modal-field" style={{ flexDirection: "row", gap: 8, alignItems: "baseline" }}>
          <input type="checkbox" checked={template} onChange={(e) => setTemplate(e.target.checked)} />
          <span>
            <strong>{t("Gate template (JSON)")}</strong>{" "}
            {t("The QC chain and the four polygons per plane, in arcsinh units, for pre-placing gates on another run.")}
          </span>
        </label>
        <div className="gl-modal-actions">
          <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
          <button className="gl-btn" disabled={!scheme && !template} onClick={() => onSave({ scheme, template })}>{t("Save")}</button>
        </div>
      </div>
    </div>
  );
}
