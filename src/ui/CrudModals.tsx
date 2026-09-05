// CrudModals.tsx — rename prompt + "Create Population" dialog (add_pop_btn).
// Create Population mirrors app.R: name, parent select, per-gate Include (AND) checkboxes.

import { useMemo, useRef, useState } from "react";
import type { CoreState, Action } from "../store";
import { wouldCreateCycle, type GateRef } from "../engine/models";
import { populationTreeOrder } from "../engine/populations";
import { pickFilesOrInput } from "../engine/fsAccess";

/** Picker types for the CSV/TSV tables the dialogs import. */
const TABLE_ACCEPT = { "text/csv": [".csv", ".tsv", ".txt"] };
import {
  passesPopulationFcsExportThreshold,
  type FcsExportAssay,
} from "../engine/fcsExport";
import { analyzeGatingMLQuadrantOmissions, type GatingMLFormat } from "../engine/gatingmlExport";
import type { GatingImportMode } from "../engine/gatingMerge";
import {
  parsePopulationEditTable,
  serializePopulationEditTemplate,
  type PopulationBulkEditPreview,
  type PopulationBulkEditUpdate,
} from "../engine/populationTable";
import { useI18n } from "./i18n";
import { gateRefLabel, EXCLUDE_HINT } from "./gateRefLabel";

function ModalShell({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="gl-modal-backdrop">
      <div className="gl-modal">
        <div className="gl-modal-title">{t(title)}</div>
        {children}
      </div>
    </div>
  );
}

/** Gating-ML import summary and explicit replace/merge strategy choice. */
export function GatingMlImportModal({
  nGates,
  nPopulations,
  sourceLabel,
  currentRootName,
  hasExistingStrategy,
  mergeBlockedReason,
  compensationNote,
  compensationNeedsConfirmation,
  matrixChoice,
  onMatrixChoice,
  onCancel,
  onImport,
}: {
  nGates: number;
  nPopulations: number;
  sourceLabel: string;
  currentRootName: string;
  hasExistingStrategy: boolean;
  mergeBlockedReason: string | null;
  compensationNote: string | null;
  compensationNeedsConfirmation: boolean;
  /**
   * Offered when the loaded FCS and the workspace each carry a spillover matrix and they are not
   * the same. Both are legitimate — the file's is what the instrument recorded, the workspace's
   * is what the analysis used — so this is a choice, not a correction.
   */
  matrixChoice: { workspaceLabel: string; maxDelta: number; value: "workspace" | "file" } | null;
  onMatrixChoice: (value: "workspace" | "file") => void;
  onCancel: () => void;
  onImport: (mode: GatingImportMode) => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<GatingImportMode>(
    hasExistingStrategy && !mergeBlockedReason ? "merge" : "replace",
  );

  return (
    <ModalShell title="Import GatingML">
      <div className="gl-modal-note">{t("Parsed {gates} gates and {populations} populations from {source}.", { gates: nGates, populations: nPopulations, source: sourceLabel })}</div>
      {compensationNote && (
        <div className={compensationNeedsConfirmation ? "gl-modal-warning" : "gl-modal-note"} role={compensationNeedsConfirmation ? "alert" : undefined}>
          {compensationNote}
        </div>
      )}
      {matrixChoice && (
        <div className="gl-modal-field">
          <span>
            {t("This FCS and the workspace each carry a spillover matrix, and they differ by up to {delta}. Which should the gates be evaluated with?", { delta: matrixChoice.maxDelta.toFixed(4) })}
          </span>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
            <input
              type="radio"
              name="gatingml-import-matrix"
              value="workspace"
              checked={matrixChoice.value === "workspace"}
              onChange={() => onMatrixChoice("workspace")}
            />
            <span>{t("The workspace's — {name}. This is the compensation in force when the gates were drawn.", { name: matrixChoice.workspaceLabel })}</span>
          </label>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
            <input
              type="radio"
              name="gatingml-import-matrix"
              value="file"
              checked={matrixChoice.value === "file"}
              onChange={() => onMatrixChoice("file")}
            />
            <span>{t("The file's — the matrix stored in the FCS, typically the one recorded at acquisition.")}</span>
          </label>
        </div>
      )}
      <div className="gl-modal-field">
        <span>{t("How should the imported strategy be applied?")}</span>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
          <input
            type="radio"
            name="gatingml-import-mode"
            value="merge"
            checked={mode === "merge"}
            disabled={mergeBlockedReason !== null}
            onChange={() => setMode("merge")}
          />
          <span>
            <strong>{t(hasExistingStrategy ? "Merge with current strategy (recommended)" : "Merge with current strategy")}</strong><br />
            <span className="gl-modal-note">
              {t("Keep current gates and populations; add imported top-level populations beneath {root}. Scientific labels are preserved.", { root: currentRootName })}
            </span>
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
          <input
            type="radio"
            name="gatingml-import-mode"
            value="replace"
            checked={mode === "replace"}
            onChange={() => setMode("replace")}
          />
          <span>
            <strong>{t("Replace current strategy")}</strong><br />
            <span className="gl-modal-note">{t("Remove the current gates and populations and use the imported hierarchy.")}</span>
          </span>
        </label>
      </div>
      {mergeBlockedReason && <div className="gl-modal-warning" role="alert">{mergeBlockedReason}</div>}
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
        <button className="gl-btn" onClick={() => onImport(mode)}>{t("Import")}</button>
      </div>
    </ModalShell>
  );
}

/** Gating-ML export options plus explicit warnings for formats that cannot be lossless. */
export function GatingMlExportModal({
  state,
  onCancel,
  onExport,
}: {
  state: CoreState;
  onCancel: () => void;
  onExport: (format: GatingMLFormat) => void;
}) {
  const { t } = useI18n();
  const [format, setFormat] = useState<GatingMLFormat>("standard");
  const quadrantOmissions = analyzeGatingMLQuadrantOmissions(state.gates, state.populations);
  const nestedOrPopulations = Object.values(state.populations).filter(
    (p) =>
      p.gate_logic === "or" &&
      p.gate_refs.length > 1 &&
      p.parent_id !== null &&
      p.parent_id !== state.root_population_id,
  );
  const cytobankBlocked = format === "cytobank" && nestedOrPopulations.length > 0;

  return (
    <ModalShell title="Export GatingML">
      <label className="gl-modal-field">
        <span>{t("Format")}</span>
        <select value={format} onChange={(e) => setFormat(e.target.value as GatingMLFormat)}>
          <option value="standard">{t("Standard — GateLab / GateLabR interchange")}</option>
          <option value="cytobank">{t("Cytobank-compatible")}</option>
        </select>
      </label>
      <div className="gl-modal-note">
        {format === "standard"
          ? t("Preserves the population hierarchy and AND/OR logic for GateLab and GateLabR.")
          : t("Uses Cytobank channel names and Boolean-gate metadata for Cytobank import.")}
      </div>
      {quadrantOmissions.gateIds.length > 0 && (
        <div className="gl-modal-warning" role="alert">
          This workspace contains {quadrantOmissions.gateIds.length} quadrant gate{quadrantOmissions.gateIds.length === 1 ? "" : "s"}.
          Quadrant gates and {quadrantOmissions.populationIds.length} dependent population{quadrantOmissions.populationIds.length === 1 ? "" : "s"},
          including all descendants, will not be included in this GatingML file.
          The saved .gatelab workspace remains complete.
        </div>
      )}
      {cytobankBlocked && (
        <div className="gl-modal-warning" role="alert">
          Cytobank-compatible export cannot safely represent nested OR logic for: {nestedOrPopulations.map((p) => p.name).join(", ")}.
          Choose the standard format to preserve these populations.
        </div>
      )}
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
        <button className="gl-btn" disabled={cytobankBlocked} onClick={() => onExport(format)}>{t("Export")}</button>
      </div>
    </ModalShell>
  );
}

/** FCS export dialog: pick populations, an explicit value space, and sample scope. */
export interface FcsExportSampleOption {
  id: string;
  name: string;
  eventCount: number;
  active: boolean;
  checked: boolean;
  populationEventCounts: Readonly<Record<string, number | null>> | null;
}

export function FcsExportModal({
  state,
  samples,
  combinedCompatibility,
  initialPopIds,
  initialAssay,
  initialScope,
  initialMinimumEvents,
  hierarchy,
  onCancel,
  onExport,
}: {
  state: CoreState;
  samples: readonly FcsExportSampleOption[];
  /** The active hierarchy (1-based position and total); exports read the active one. */
  hierarchy?: { name: string; index: number; count: number };
  combinedCompatibility: { compatible: boolean; reason: string | null };
  initialPopIds: string[];
  initialAssay: FcsExportAssay;
  initialScope: "active" | "combined" | "split";
  initialMinimumEvents: number;
  onCancel: () => void;
  onExport: (
    popIds: string[],
    assay: FcsExportAssay,
    scope: "active" | "combined" | "split",
    minimumEvents: number,
  ) => void;
}) {
  const { t } = useI18n();
  const order = populationTreeOrder(state.populations, state.root_population_id ?? null);
  const allIds = order.map((o) => o.popId);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initialPopIds));
  const [assay, setAssay] = useState(initialAssay);
  const activeSample = samples.find((sample) => sample.active) ?? samples[0] ?? null;
  const checkedSamples = samples.filter((sample) => sample.checked);
  const [scope, setScope] = useState<"active" | "combined" | "split">(() => {
    if (initialScope === "combined" && !combinedCompatibility.compatible) return "split";
    if (initialScope !== "active" && checkedSamples.length === 0) return "active";
    return initialScope;
  });
  const [minimumEvents, setMinimumEvents] = useState(() =>
    Math.max(0, Math.floor(initialMinimumEvents)),
  );
  const [confirmingSplitExport, setConfirmingSplitExport] = useState(false);
  const toggle = (id: string) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const splitCombinations = useMemo(() => {
    const selectedPopulationIds = [...checked];
    return checkedSamples.flatMap((sample) =>
      selectedPopulationIds.map((popId) => {
        const count = sample.populationEventCounts?.[popId];
        const eventCount =
          typeof count === "number" && Number.isFinite(count) ? count : null;
        return {
          key: `${sample.id}:${popId}`,
          sampleName: sample.name,
          populationName: state.populations[popId]?.name ?? popId,
          eventCount,
          writable: passesPopulationFcsExportThreshold(eventCount, minimumEvents),
        };
      }),
    );
  }, [checked, checkedSamples, minimumEvents, state.populations]);
  const splitCombinationSummary = useMemo(() => {
    const writable = splitCombinations.filter((combination) => combination.writable).length;
    return {
      ready: splitCombinations.every((combination) => combination.eventCount !== null),
      writable,
      skipped: splitCombinations.length - writable,
    };
  }, [splitCombinations]);
  if (confirmingSplitExport) {
    return (
      <ModalShell title="Confirm separate FCS export">
        <div className="gl-fcs-export-confirm-summary">
          <strong>
            {t("FCS outputs to write: {written}", {
              written: splitCombinationSummary.writable,
            })}
          </strong>
          <span>
            {t("{skipped} population × file combinations will be skipped (≤ {threshold} events)", {
              skipped: splitCombinationSummary.skipped,
              threshold: minimumEvents,
            })}
          </span>
        </div>
        <div className="gl-fcs-export-combinations">
          <div className="gl-fcs-export-combination header" aria-hidden="true">
            <span>{t("FCS file")}</span>
            <span>{t("Population")}</span>
            <span>{t("Events")}</span>
            <span>{t("Result")}</span>
          </div>
          {splitCombinations.map((combination) => (
            <div
              key={combination.key}
              className={`gl-fcs-export-combination${combination.writable ? " included" : " skipped"}`}
            >
              <span title={combination.sampleName}>{combination.sampleName}</span>
              <span title={combination.populationName}>{combination.populationName}</span>
              <span>{combination.eventCount?.toLocaleString() ?? "…"}</span>
              <strong>{combination.writable ? t("Write") : t("Skip")}</strong>
            </div>
          ))}
        </div>
        <div className="gl-modal-actions">
          <button className="gl-btn-ghost" onClick={() => setConfirmingSplitExport(false)}>
            {t("Back")}
          </button>
          <button
            className="gl-btn"
            disabled={splitCombinationSummary.writable === 0}
            onClick={() => onExport([...checked], assay, scope, minimumEvents)}
          >
            {t("Export {count} FCS", { count: splitCombinationSummary.writable })}
          </button>
        </div>
      </ModalShell>
    );
  }
  return (
    <ModalShell title="Export FCS">
      {hierarchy && hierarchy.count > 1 && (
        <div className="gl-modal-note">
          {t("Hierarchy: {name} ({n} of {count}). Populations are exported from the active hierarchy; switch hierarchies to export the others.", {
            name: hierarchy.name,
            n: hierarchy.index,
            count: hierarchy.count,
          })}
        </div>
      )}
      <div className="gl-modal-field">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span>{t("Populations")}</span>
          <button className="gl-btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setChecked(new Set(allIds))}>{t("Select all")}</button>
          <button className="gl-btn-ghost" onClick={() => setChecked(new Set())}>{t("None")}</button>
          <span style={{ opacity: 0.7, minWidth: 66, textAlign: "right" }}>{t("{count} selected", { count: checked.size })}</span>
        </div>
        <div style={{ maxHeight: 260, overflow: "auto", border: "1px solid var(--gl-border, #ccc)", borderRadius: 4, padding: "4px 6px" }}>
          {allIds.length === 0 && <em style={{ opacity: 0.6 }}>{t("No populations.")}</em>}
          {order.map(({ popId, depth }) => (
            <label key={popId} style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: depth * 14, cursor: "pointer" }}>
              <input type="checkbox" checked={checked.has(popId)} onChange={() => toggle(popId)} />
              {state.populations[popId]?.name ?? popId}
            </label>
          ))}
        </div>
      </div>
      <label className="gl-modal-field">
        <span>{t("Values")}</span>
        <select value={assay} onChange={(e) => setAssay(e.target.value as FcsExportAssay)}>
          <option value="original">{t("Original measurements (uncompensated)")}</option>
          <option value="compensated">{t("Compensated linear measurements")}</option>
          <option value="display">{t("Transformed display values")}</option>
        </select>
      </label>
      <div className="gl-modal-note">
        {assay === "original" && "Exports the measurements stored in the source FCS before spillover compensation or display transforms. This matches GateLabR's counts export."}
        {assay === "compensated" && "Applies each sample's current spillover-compensation setting, but does not apply logicle or arcsinh display transforms."}
        {assay === "display" && "Exports the values currently used for display after compensation (when enabled) and logicle/arcsinh transformation."}
        {" "}The output file is FCS 3.0 with 32-bit floating-point values.
      </div>
      <div className="gl-modal-field">
        <span>{t("FCS source and packaging")}</span>
        <div className="gl-fcs-scope-options">
          <label className={`gl-fcs-scope-option${scope === "active" ? " selected" : ""}`}>
            <input
              type="radio"
              name="fcs-export-scope"
              value="active"
              checked={scope === "active"}
              disabled={!activeSample}
              onChange={() => setScope("active")}
            />
            <span>
              <strong>
                {t("Active file only — {name}", { name: activeSample?.name ?? t("none") })}
              </strong>
              <small>{t("The blue row is exported; other checked files are ignored.")}</small>
            </span>
          </label>
          <label className={`gl-fcs-scope-option${scope === "split" ? " selected" : ""}`}>
            <input
              type="radio"
              name="fcs-export-scope"
              value="split"
              checked={scope === "split"}
              disabled={checkedSamples.length === 0}
              onChange={() => setScope("split")}
            />
            <span>
              <strong>
                {t("Checked files, kept separate — {count} FCS", {
                  count: checkedSamples.length,
                })}
                {checkedSamples.length > 1 && <em>{t("Recommended")}</em>}
              </strong>
              <small>{t("Preserves each source filename and sample identity; multiple outputs are placed in one ZIP.")}</small>
            </span>
          </label>
          <label className={`gl-fcs-scope-option${scope === "combined" ? " selected" : ""}`}>
            <input
              type="radio"
              name="fcs-export-scope"
              value="combined"
              checked={scope === "combined"}
              disabled={!combinedCompatibility.compatible}
              onChange={() => setScope("combined")}
            />
            <span>
              <strong>{t("Pool checked files into one FCS — advanced")}</strong>
              <small>
                {combinedCompatibility.compatible
                  ? t("Events are concatenated into one file. Source-file identity is not retained.")
                  : combinedCompatibility.reason}
              </small>
            </span>
          </label>
        </div>
      </div>
      {scope === "split" && (
        <div className="gl-fcs-threshold">
          <label>
            <span>{t("Only write population × file combinations with more than")}</span>
            <input
              type="number"
              min={0}
              step={1}
              value={minimumEvents}
              aria-label={t("Minimum events for each population and FCS combination")}
              onChange={(event) => {
                const next = Number(event.target.value);
                setMinimumEvents(Number.isFinite(next) ? Math.max(0, Math.floor(next)) : 0);
              }}
            />
            <span>{t("events")}</span>
          </label>
          <small>
            {t("A value of 0 skips empty outputs. This filter only affects separate-file export; pooled data are never filtered this way.")}
          </small>
        </div>
      )}
      <div className="gl-fcs-export-summary" role="status">
        <strong>{t("Export summary")}</strong>
        <span>
          {scope === "active"
            ? t("{populations} populations from {name}", {
                populations: checked.size,
                name: activeSample?.name ?? t("none"),
              })
            : scope === "split"
              ? t("{populations} populations × {files} checked files, kept separate", {
                  populations: checked.size,
                  files: checkedSamples.length,
                })
              : t("{populations} pooled population files from {files} checked files", {
                  populations: checked.size,
                  files: checkedSamples.length,
                })}
        </span>
        {scope === "split" && (
          <span>
            {splitCombinationSummary.ready
              ? t("FCS outputs to write: {written} · skipped: {skipped} (≤ {threshold} events)", {
                  written: splitCombinationSummary.writable,
                  skipped: splitCombinationSummary.skipped,
                  threshold: minimumEvents,
                })
              : t("Calculating population × file event counts…")}
          </span>
        )}
        {scope !== "active" && checkedSamples.length > 0 && (
          <span title={checkedSamples.map((sample) => sample.name).join("\n")}>
            {t("Sources: {names}", {
              names: checkedSamples.map((sample) => sample.name).join(", "),
            })}
          </span>
        )}
      </div>
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
        <button
          className="gl-btn"
          disabled={
            checked.size === 0 ||
            (scope === "active" && !activeSample) ||
            (scope === "split" && (
              checkedSamples.length === 0 ||
              !splitCombinationSummary.ready
            )) ||
            (scope === "combined" && !combinedCompatibility.compatible)
          }
          onClick={() => {
            if (scope === "split") setConfirmingSplitExport(true);
            else onExport([...checked], assay, scope, minimumEvents);
          }}
        >
          {scope === "split"
            ? t("Review export")
            : `${t("Export")}${checked.size > 1 ? ` (${checked.size})` : ""}`}
        </button>
      </div>
    </ModalShell>
  );
}

/** Atomic, previewed bulk edits of population names and positive AND gate definitions. */
export function BulkRenameModal({
  state,
  onCancel,
  onConfirm,
}: {
  state: CoreState;
  onCancel: () => void;
  onConfirm: (updates: PopulationBulkEditUpdate[]) => void;
}) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<PopulationBulkEditPreview | null>(null);
  const tableState = useMemo(() => ({
    populations: state.populations,
    gates: state.gates,
    rootPopulationId: state.root_population_id,
  }), [state.populations, state.gates, state.root_population_id]);

  const downloadTemplate = () => {
    setErr(null);
    let csv: string;
    try {
      csv = serializePopulationEditTemplate(tableState);
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "population_edit_template.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const onFile = async (f: File) => {
    try {
      setPreview(parsePopulationEditTable(await f.text(), tableState));
      setErr(null);
    } catch (e) {
      setPreview(null);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <ModalShell title="Bulk-edit populations">
      <p style={{ fontSize: 12, color: "#555", margin: "2px 0 12px", lineHeight: 1.4 }}>
        {t("Download the template, edit new_population and gate_names, then upload it. Gate names are a comma-separated positive AND list; quadrant references use Gate name [Q1]. Population IDs keep rows unambiguous.")}
      </p>
      {err && <p style={{ fontSize: 12, color: "#d64545" }}>{err}</p>}
      {preview && (
        <div className="gl-modal-note" role="status">
          <strong>{t("Validated — no changes have been applied yet.")}</strong>
          <br />
          {t("{rows} rows · {renames} renames · {definitions} gate definitions changed · {unchanged} unchanged", {
            rows: preview.rowCount,
            renames: preview.renameCount,
            definitions: preview.gateDefinitionCount,
            unchanged: preview.unchangedCount,
          })}
          {preview.omittedCount > 0
            ? ` · ${t("{count} omitted populations will be left unchanged", { count: preview.omittedCount })}`
            : ""}
          {preview.legacyRenameOnly ? ` · ${t("legacy rename-only file")}` : ""}
        </div>
      )}
      <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.target.value = "";
        }} />
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={downloadTemplate}>{t("Template ↧")}</button>
        <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
        <button className="gl-btn-ghost" onClick={() => void pickFilesOrInput(fileRef.current, TABLE_ACCEPT, "Population edit table").then((files) => { if (files?.[0]) void onFile(files[0]); })}>{t("Choose CSV/TSV…")}</button>
        <button
          className="gl-btn"
          disabled={!preview || (preview.renameCount === 0 && preview.gateDefinitionCount === 0)}
          onClick={() => preview && onConfirm(preview.updates)}
        >
          {t("Apply changes")}
        </button>
      </div>
    </ModalShell>
  );
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <ModalShell title={t(title)}>
      <p style={{ fontSize: 13, color: "#555", margin: "2px 0 14px", lineHeight: 1.4 }}>{message}</p>
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
        <button className="gl-btn gl-btn-danger" onClick={onConfirm}>{t(confirmLabel)}</button>
      </div>
    </ModalShell>
  );
}

export function RenameModal({
  title,
  initial,
  onConfirm,
  onCancel,
}: {
  title: string;
  initial: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial);
  const commit = () => {
    if (name.trim()) onConfirm(name.trim());
  };
  return (
    <ModalShell title={t(title)}>
      <label className="gl-modal-field">
        {t("New name:")}
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
      </label>
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button className="gl-btn" onClick={commit}>
          {t("Rename")}
        </button>
      </div>
    </ModalShell>
  );
}

export function EditPopModal({
  state,
  popId,
  onConfirm,
  onCancel,
}: {
  state: CoreState;
  popId: string;
  onConfirm: (a: Action) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const pop = state.populations[popId];
  const orderedGateIds = state.gate_order.length ? state.gate_order : Object.keys(state.gates);
  const gateIds = orderedGateIds.filter((gid) => state.gates[gid]?.gate_type !== "quadrant");
  const lockedQuadrantRefs = (pop?.gate_refs ?? []).filter(
    (ref) => state.gates[ref.gate_id]?.gate_type === "quadrant",
  );

  const [name, setName] = useState(pop?.name ?? "");
  const [parentId, setParentId] = useState(pop?.parent_id ?? state.root_population_id ?? "");
  const [checked, setChecked] = useState<Set<string>>(
    new Set((pop?.gate_refs ?? []).filter((r) => state.gates[r.gate_id]?.gate_type !== "quadrant").map((r) => r.gate_id)),
  );
  // NOT is per gate reference, not per population: gate_logic is one value for the
  // whole population, so a reference is either intersected or complemented.
  const [excluded, setExcluded] = useState<Set<string>>(
    new Set((pop?.gate_refs ?? []).filter((r) => !r.include).map((r) => r.gate_id)),
  );

  // Valid parents: any population that isn't this one or a descendant of it.
  const parentChoices = useMemo(
    () =>
      Object.keys(state.populations)
        .filter((pid) => pid !== popId && !wouldCreateCycle(state.populations, popId, pid))
        .map((pid) => ({ id: pid, name: state.populations[pid].name })),
    [state.populations, popId],
  );

  // Gates inherited from the parent chain (read-only).
  const inherited = useMemo(() => {
    const out: { gateId: string; include: boolean; from: string }[] = [];
    let walk = pop?.parent_id ?? null;
    const seen = new Set<string>();
    while (walk && state.populations[walk] && !seen.has(walk)) {
      seen.add(walk);
      const anc = state.populations[walk];
      for (const ref of anc.gate_refs) out.push({ gateId: ref.gate_id, include: ref.include, from: anc.name });
      walk = anc.parent_id;
    }
    return out;
  }, [pop, state.populations]);

  if (!pop) return null;

  const commit = () => {
    const gateRefs: GateRef[] = [
      ...lockedQuadrantRefs.map((ref) => ({ ...ref })),
      ...[...checked].map((gid) => ({ gate_id: gid, include: !excluded.has(gid) })),
    ];
    onConfirm({ type: "editPopulation", popId, name, parentId, gateRefs });
  };

  return (
    <ModalShell title={t("Edit Population")}>
      <label className="gl-modal-field">
        {t("Name:")}
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="gl-modal-field">
        {t("Parent population:")}
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          {parentChoices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {inherited.length > 0 && (
        <div className="gl-modal-field" style={{ gap: 4 }}>
          {t("Inherited from parent chain:")}
          <div className="gl-inherited">
            {inherited.map((ir, i) => {
              const g = state.gates[ir.gateId];
              if (!g) return null;
              return (
                <span
                  key={i}
                  className={"gate-ref-badge" + (ir.include ? "" : " exclude")}
                  style={{ background: g.color, opacity: 0.75 }}
                >
                  {gateRefLabel(g.name, ir.include) + " ← " + ir.from}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="gl-modal-field" style={{ gap: 6 }}>
        {t("Gates for this population:")}
        {lockedQuadrantRefs.length > 0 && (
          <div className="gl-inherited">
            {lockedQuadrantRefs.map((ref) => {
              const gate = state.gates[ref.gate_id];
              return (
                <span key={`${ref.gate_id}:${ref.quadrant}`} className="gate-ref-badge" style={{ background: gate.color, opacity: 0.75 }}>
                  {gate.name} · quadrant {ref.quadrant} (locked)
                </span>
              );
            })}
          </div>
        )}
        <div className="gl-gateref-list">
          {gateIds.length === 0 && <em style={{ color: "var(--muted)" }}>{t("No gates yet.")}</em>}
          {gateIds.map((gid) => {
            const g = state.gates[gid];
            if (!g) return null;
            return (
              <div key={gid} className="gl-gateref-row">
                <label className="gl-gateref-pick">
                  <input
                    type="checkbox"
                    checked={checked.has(gid)}
                    onChange={(e) => {
                      const next = new Set(checked);
                      if (e.target.checked) next.add(gid);
                      else next.delete(gid);
                      setChecked(next);
                      // Dropping a gate drops its exclusion too, so an unrelated
                      // NOT cannot reappear if the gate is ticked again later.
                      if (!e.target.checked && excluded.has(gid)) {
                        const stillExcluded = new Set(excluded);
                        stillExcluded.delete(gid);
                        setExcluded(stillExcluded);
                      }
                    }}
                  />
                  <span className="gate-color-swatch" style={{ background: g.color, width: 10, height: 10 }} />
                  <span>{g.name}</span>
                </label>
                <label
                  className={"gl-gateref-not" + (checked.has(gid) ? "" : " is-disabled")}
                  title={t(EXCLUDE_HINT)}
                >
                  <input
                    type="checkbox"
                    checked={excluded.has(gid)}
                    disabled={!checked.has(gid)}
                    onChange={(e) => {
                      const next = new Set(excluded);
                      if (e.target.checked) next.add(gid);
                      else next.delete(gid);
                      setExcluded(next);
                    }}
                  />
                  {t("NOT")}
                </label>
              </div>
            );
          })}
        </div>
      </div>

      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button className="gl-btn" onClick={commit}>
          {t("Save")}
        </button>
      </div>
    </ModalShell>
  );
}

export function CreatePopModal({
  state,
  onConfirm,
  onCancel,
}: {
  state: CoreState;
  onConfirm: (a: Action) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const parentChoices = useMemo(
    () => Object.keys(state.populations).map((id) => ({ id, name: state.populations[id].name })),
    [state.populations],
  );
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState(
    state.active_population_id && state.populations[state.active_population_id]
      ? state.active_population_id
      : state.root_population_id ?? "",
  );
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const ids = (state.gate_order.length ? state.gate_order : Object.keys(state.gates))
    .filter((gid) => state.gates[gid]?.gate_type !== "quadrant");

  const commit = () => {
    const popName = name.trim() || `Pop_${Object.keys(state.populations).length}`;
    const gateRefs: GateRef[] = [...checked].map((gid) => ({ gate_id: gid, include: !excluded.has(gid) }));
    onConfirm({ type: "addPopulation", name: popName, parentId, gateRefs });
  };

  return (
    <ModalShell title={t("Create Population")}>
      <label className="gl-modal-field">
        {t("Population name:")}
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="gl-modal-field">
        {t("Parent population:")}
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          {parentChoices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <div className="gl-modal-field" style={{ gap: 6 }}>
        {t("Gate references (AND logic; tick NOT to exclude):")}
        <div className="gl-gateref-list">
          {ids.length === 0 && <em style={{ color: "var(--muted)" }}>{t("No gates yet.")}</em>}
          {ids.map((gid) => {
            const g = state.gates[gid];
            if (!g) return null;
            return (
              <div key={gid} className="gl-gateref-row">
                <label className="gl-gateref-pick">
                  <input
                    type="checkbox"
                    checked={checked.has(gid)}
                    onChange={(e) => {
                      const next = new Set(checked);
                      if (e.target.checked) next.add(gid);
                      else next.delete(gid);
                      setChecked(next);
                      // Dropping a gate drops its exclusion too, so an unrelated
                      // NOT cannot reappear if the gate is ticked again later.
                      if (!e.target.checked && excluded.has(gid)) {
                        const stillExcluded = new Set(excluded);
                        stillExcluded.delete(gid);
                        setExcluded(stillExcluded);
                      }
                    }}
                  />
                  <span className="gate-color-swatch" style={{ background: g.color, width: 10, height: 10 }} />
                  <span>{g.name}</span>
                </label>
                <label
                  className={"gl-gateref-not" + (checked.has(gid) ? "" : " is-disabled")}
                  title={t(EXCLUDE_HINT)}
                >
                  <input
                    type="checkbox"
                    checked={excluded.has(gid)}
                    disabled={!checked.has(gid)}
                    onChange={(e) => {
                      const next = new Set(excluded);
                      if (e.target.checked) next.add(gid);
                      else next.delete(gid);
                      setExcluded(next);
                    }}
                  />
                  {t("NOT")}
                </label>
              </div>
            );
          })}
        </div>
      </div>
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button className="gl-btn" onClick={commit}>
          {t("Create")}
        </button>
      </div>
    </ModalShell>
  );
}
