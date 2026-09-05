// BarcodeSchemeImportModal.tsx — review a barcode scheme before its gates and populations are
// created: where it attaches, which channels are drawn together, which template shapes the
// gates, and every problem the table has. Nothing is created until Import.

import { useRef } from "react";
import type { CoreState } from "../store";
import { populationTreeOrder } from "../engine/populations";
import type { BarcodeChannelLike, BarcodePlane, BarcodeScheme, BarcodeTable, QcChainPreview } from "../engine/barcodeScheme";

type QcPreviewWithSource = QcChainPreview & { source?: "file" | "template" | "none" };
import type { BarcodeTemplate } from "../engine/barcodeTemplate";
import { useI18n } from "./i18n";
import { pickFilesOrInput } from "../engine/fsAccess";

export interface BarcodeImportDraft {
  /** Name of the table file, for the summary line. */
  fileName: string;
  table: BarcodeTable;
  /** Edited plane layout; null means the layout the scheme proposed or declared. */
  planes: BarcodePlane[] | null;
  template: BarcodeTemplate;
  templateLabel: string;
  parentId: string;
  sampleId: string;
  /** Create the template's QC chain (Cells, Live, …) between the parent and the samples. */
  qc: boolean;
  /** Reference existing gates with the same name and channels instead of creating new ones. */
  reuse: boolean;
  /**
   * When set, the strategy goes into a new hierarchy of this name (its own All Events, the
   * QC chain beneath) and the current hierarchy is left untouched; `parentId` is ignored.
   */
  newHierarchyName: string | null;
}

export function BarcodeSchemeImportModal({
  draft,
  scheme,
  channels,
  state,
  canLearn,
  qcPreview,
  reusePreview,
  suggestedHierarchyName,
  onPlanesChange,
  onParentChange,
  onNewHierarchyChange,
  onQcChange,
  onReuseChange,
  onTemplateDefault,
  onTemplateLearn,
  onTemplateFile,
  onDownloadTemplateCsv,
  onCancel,
  onImport,
}: {
  draft: BarcodeImportDraft;
  scheme: BarcodeScheme;
  channels: BarcodeChannelLike[];
  state: CoreState;
  canLearn: boolean;
  /** What the template's QC chain would create on this sample; null when the template has none. */
  qcPreview: QcPreviewWithSource | null;
  /** What a build would reuse and create, when the scheme has no problems. */
  reusePreview: { reused: number; created: number } | null;
  /** The name a new hierarchy is offered with. */
  suggestedHierarchyName: string;
  onPlanesChange: (planes: BarcodePlane[] | null) => void;
  onParentChange: (populationId: string) => void;
  /** null returns to attaching under a population of the current hierarchy. */
  onNewHierarchyChange: (name: string | null) => void;
  onQcChange: (qc: boolean) => void;
  onReuseChange: (reuse: boolean) => void;
  onTemplateDefault: () => void;
  onTemplateLearn: () => void;
  onTemplateFile: (file: File) => void;
  onDownloadTemplateCsv: () => void;
  onCancel: () => void;
  onImport: () => void;
}) {
  const { t } = useI18n();
  const templateFileRef = useRef<HTMLInputElement>(null);
  const order = populationTreeOrder(state.populations, state.root_population_id ?? null);
  const planes = draft.planes ?? scheme.planes;
  const channelKeys = channels.map((c) => c.key);
  const problems = scheme.problems;
  const toNewHierarchy = draft.newHierarchyName !== null;
  const hierarchyOnly = scheme.hierarchyOnly;
  const canImport =
    problems.length === 0 &&
    (hierarchyOnly ? !!qcPreview && qcPreview.populations.length > 0 && draft.qc : scheme.samples.length > 0 && planes.length > 0) &&
    (!toNewHierarchy || (draft.newHierarchyName ?? "").trim().length > 0);

  const setPlane = (i: number, patch: Partial<BarcodePlane>) => {
    const next = planes.map((p, j) => (j === i ? { ...p, ...patch } : p));
    onPlanesChange(next);
  };
  const removePlane = (i: number) => onPlanesChange(planes.filter((_, j) => j !== i));
  const addPlane = () => {
    const used = new Set(planes.flatMap((p) => [p.x, p.y]));
    const free = scheme.channels.filter((k) => !used.has(k));
    const x = free[1] ?? free[0] ?? channelKeys[0] ?? "";
    const y = free[0] ?? channelKeys[1] ?? channelKeys[0] ?? "";
    onPlanesChange([...planes, { x, y, xIsBarcode: scheme.channels.includes(x), yIsBarcode: scheme.channels.includes(y) }]);
  };

  return (
    <div className="gl-modal-backdrop">
      <div className="gl-modal" style={{ maxWidth: 720 }}>
        <div className="gl-modal-title">{t("Import hierarchy")}</div>
        <div className="gl-modal-note">
          {hierarchyOnly
            ? t("{file}: a hierarchy of {populations} population(s) and no sample table.", { file: draft.fileName, populations: scheme.populationDeclarations.length })
            : t("{file}: {samples} sample(s), {channels} barcode channel(s), {planes} plane(s).", {
              file: draft.fileName,
              samples: scheme.samples.length,
              channels: scheme.channels.length,
              planes: planes.length,
            })}
          {scheme.metadataColumns.length > 0 && (
            <> {t("Metadata columns: {columns}.", { columns: scheme.metadataColumns.join(", ") })}</>
          )}
        </div>
        {scheme.notes.map((n, i) => <div key={i} className="gl-modal-note">{n}</div>)}

        <label className="gl-modal-field">
          <span>{t("Attach under")}</span>
          <select
            value={toNewHierarchy ? "__new-hierarchy" : draft.parentId}
            onChange={(e) => {
              if (e.target.value === "__new-hierarchy") onNewHierarchyChange(suggestedHierarchyName);
              else {
                onNewHierarchyChange(null);
                onParentChange(e.target.value);
              }
            }}
          >
            {order.map(({ popId, depth }) => (
              <option key={popId} value={popId}>{" ".repeat(depth * 2)}{state.populations[popId]?.name ?? popId}</option>
            ))}
            <option value="__new-hierarchy">{t("New hierarchy… (the current one is kept; gates are shared)")}</option>
          </select>
        </label>
        {toNewHierarchy && (
          <label className="gl-modal-field">
            <span>{t("New hierarchy name")}</span>
            <input
              value={draft.newHierarchyName ?? ""}
              onChange={(e) => onNewHierarchyChange(e.target.value)}
              aria-label={t("New hierarchy name")}
            />
          </label>
        )}

        <div className="gl-modal-field">
          <span>{t("Template")}: {draft.templateLabel}</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="gl-btn-ghost" onClick={onTemplateDefault}>{t("GateLab default")}</button>
            <button className="gl-btn-ghost" disabled={!canLearn} title={canLearn ? "" : t("The current workspace has no plane with four gates to learn from.")} onClick={onTemplateLearn}>
              {t("Learn from this workspace")}
            </button>
            <button className="gl-btn-ghost" onClick={() => void pickFilesOrInput(templateFileRef.current, { "application/json": [".json"] }, "Barcode template").then((files) => { if (files?.[0]) onTemplateFile(files[0]); })}>{t("From a template file…")}</button>
            <input
              ref={templateFileRef}
              type="file"
              accept=".json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onTemplateFile(f);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        <div className="gl-modal-field">
          <label style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
            <input
              type="checkbox"
              checked={draft.qc}
              disabled={!qcPreview || qcPreview.populations.length === 0}
              onChange={(e) => onQcChange(e.target.checked)}
            />
            <span>
              {hierarchyOnly
                ? t("Create the populations the file declares")
                : qcPreview?.source === "file"
                  ? t("Create the QC populations the file declares")
                  : t("Create the QC populations above the samples")}
              {qcPreview && qcPreview.populations.length > 0 && (
                <>: {qcPreview.populations.map((p) => `${p.name} (${p.gates.length})${p.parent ? ` under ${p.parent}` : ""}`).join(qcPreview.populations.some((p) => p.parent) ? ", " : " → ")}</>
              )}
              {qcPreview && qcPreview.populations.length === 0 && <> ({t("none in this template")})</>}
            </span>
          </label>
          {draft.qc && qcPreview && qcPreview.skipped.length > 0 && (
            <ul className="gl-modal-note" style={{ margin: "2px 0 0 18px", padding: 0 }}>
              {qcPreview.skipped.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          )}
        </div>

        <div className="gl-modal-field">
          <label style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
            <input type="checkbox" checked={draft.reuse} onChange={(e) => onReuseChange(e.target.checked)} />
            <span>
              {t("Reuse gates this workspace already has, matched by name and channels")}
              {reusePreview && draft.reuse && (
                <>: {t("{reused} reused, {created} to create", reusePreview)}</>
              )}
            </span>
          </label>
        </div>

        {!hierarchyOnly && (
        <div className="gl-modal-field">
          <span>{t("Planes: which channels are drawn together. An axis that is not a barcode axis contributes no state.")}</span>
          <div style={{ overflowX: "auto" }}>
            <table className="gl-barcode-planes" style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>{t("x")}</th>
                  <th>{t("barcode")}</th>
                  <th style={{ textAlign: "left" }}>{t("y")}</th>
                  <th>{t("barcode")}</th>
                  <th>{t("gates")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {planes.map((p, i) => (
                  <tr key={i}>
                    <td>
                      <select value={p.x} onChange={(e) => setPlane(i, { x: e.target.value, xIsBarcode: scheme.channels.includes(e.target.value) })}>
                        {channelKeys.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <input type="checkbox" checked={p.xIsBarcode} onChange={(e) => setPlane(i, { xIsBarcode: e.target.checked })} />
                    </td>
                    <td>
                      <select value={p.y} onChange={(e) => setPlane(i, { y: e.target.value, yIsBarcode: scheme.channels.includes(e.target.value) })}>
                        {channelKeys.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <input type="checkbox" checked={p.yIsBarcode} onChange={(e) => setPlane(i, { yIsBarcode: e.target.checked })} />
                    </td>
                    <td style={{ textAlign: "center" }}>{p.xIsBarcode && p.yIsBarcode ? 4 : 2}</td>
                    <td><button className="gl-btn-ghost" onClick={() => removePlane(i)}>{t("Remove")}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="gl-btn-ghost" onClick={addPlane}>{t("Add plane")}</button>
            <button className="gl-btn-ghost" disabled={draft.planes === null} onClick={() => onPlanesChange(null)}>{t("Reset to proposed")}</button>
          </div>
        </div>
        )}

        {problems.length > 0 && (
          <div className="gl-modal-warning" role="alert">
            <div>{t("{count} problem(s) to fix before importing:", { count: problems.length })}</div>
            <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
              {problems.slice(0, 12).map((p, i) => <li key={i}>{p}</li>)}
              {problems.length > 12 && <li>{t("… and {n} more.", { n: problems.length - 12 })}</li>}
            </ul>
          </div>
        )}

        {scheme.samples.length > 0 && (
          <div className="gl-modal-note">
            {t("Sample populations to create:")}{" "}
            {scheme.samples.slice(0, 10).map((s) => s.name).join(", ")}
            {scheme.samples.length > 10 && t(" … and {n} more", { n: scheme.samples.length - 10 })}
          </div>
        )}

        <div className="gl-modal-actions">
          <button className="gl-btn-ghost" onClick={onDownloadTemplateCsv}>{t("Download scheme template CSV")}</button>
          <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
          <button className="gl-btn" disabled={!canImport} onClick={onImport}>{t("Import")}</button>
        </div>
      </div>
    </div>
  );
}
