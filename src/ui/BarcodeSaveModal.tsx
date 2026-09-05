// BarcodeSaveModal.tsx — write a workspace's debarcoding strategy back out: the scheme table
// (CSV, one row per sample population) and the gate template (JSON: QC chain and plane shapes).
// The two are the same record split by what each file can hold, so the dialog offers both.

import { useState } from "react";
import { useI18n } from "./i18n";

export interface BarcodeSaveSummary {
  /** "scheme": a debarcoding strategy with its sample table; "hierarchy": any workspace's gates and populations. */
  mode: "scheme" | "hierarchy";
  /** Plane labels as they will be declared in the table. */
  planeLabels: string[];
  /** QC populations captured above the samples, outermost first. */
  qcNames: string[];
  nSamples: number;
  /** Hierarchy mode: what the file will hold. */
  nGates: number;
  nPopulations: number;
  /** Whether a gate template can be written (a workspace with barcode planes). */
  hasTemplate: boolean;
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
  const hierarchy = summary.mode === "hierarchy";
  const [scheme, setScheme] = useState(hierarchy ? summary.nPopulations > 0 : summary.nSamples > 0);
  const [template, setTemplate] = useState(summary.hasTemplate);
  return (
    <div className="gl-modal-backdrop">
      <div className="gl-modal" style={{ maxWidth: 560 }}>
        <div className="gl-modal-title">{t("Save hierarchy CSV")}</div>
        <div className="gl-modal-note">
          {hierarchy
            ? t("No barcode plane in this workspace, so the file holds the plain hierarchy: {gates} gate(s) and {populations} population(s).", { gates: summary.nGates, populations: summary.nPopulations })
            : t("{planes} plane(s): {labels}.", { planes: summary.planeLabels.length, labels: summary.planeLabels.join("; ") })}
          {" "}
          {!hierarchy && (summary.qcNames.length
            ? t("QC chain: {chain}.", { chain: summary.qcNames.join(" → ") })
            : t("No QC chain above the sample populations."))}
        </div>
        {summary.notes.map((n, i) => <div key={i} className="gl-modal-note">{n}</div>)}
        <label className="gl-modal-field" style={{ flexDirection: "row", gap: 8, alignItems: "baseline" }}>
          <input type="checkbox" checked={scheme} disabled={hierarchy ? summary.nPopulations === 0 : summary.nSamples === 0} onChange={(e) => setScheme(e.target.checked)} />
          <span>
            <strong>{hierarchy ? t("Hierarchy (CSV)") : t("Scheme table (CSV)")}</strong>{" "}
            {hierarchy
              ? t("Every polygon and rectangle gate as a \"# gate:\" line and every population as a \"# population:\" line naming its parent.")
              : summary.nSamples > 0
                ? t("{count} sample population(s), one row each with its 0/1 states, name, file name and metadata, plus every gate and the QC populations.", { count: summary.nSamples })
                : t("No population uses exactly one gate from every plane, so there is no table to write.")}
          </span>
        </label>
        <label className="gl-modal-field" style={{ flexDirection: "row", gap: 8, alignItems: "baseline" }}>
          <input type="checkbox" checked={template} disabled={!summary.hasTemplate} onChange={(e) => setTemplate(e.target.checked)} />
          <span>
            <strong>{t("Gate template (JSON)")}</strong>{" "}
            {summary.hasTemplate
              ? t("The QC chain and the four polygons per plane, in arcsinh units, for pre-placing gates on another run.")
              : t("Needs a barcode plane with four gates; none here.")}
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
