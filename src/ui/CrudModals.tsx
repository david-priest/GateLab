// CrudModals.tsx — rename prompt + "Create Population" dialog (add_pop_btn).
// Create Population mirrors app.R: name, parent select, per-gate Include (AND) checkboxes.

import { useMemo, useRef, useState } from "react";
import type { CoreState, Action } from "../store";
import { wouldCreateCycle, type GateRef } from "../engine/models";
import { populationTreeOrder } from "../engine/populations";
import type { FcsExportAssay } from "../engine/fcsExport";
import { analyzeGatingMLQuadrantOmissions, type GatingMLFormat } from "../engine/gatingmlExport";

function ModalShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="gl-modal-backdrop">
      <div className="gl-modal">
        <div className="gl-modal-title">{title}</div>
        {children}
      </div>
    </div>
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
        <span>Format</span>
        <select value={format} onChange={(e) => setFormat(e.target.value as GatingMLFormat)}>
          <option value="standard">Standard — GateLab / GateLabR interchange</option>
          <option value="cytobank">Cytobank-compatible</option>
        </select>
      </label>
      <div className="gl-modal-note">
        {format === "standard"
          ? "Preserves the population hierarchy and AND/OR logic for GateLab and GateLabR."
          : "Uses Cytobank channel names and Boolean-gate metadata for Cytobank import."}
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
        <button className="gl-btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="gl-btn" disabled={cytobankBlocked} onClick={() => onExport(format)}>Export</button>
      </div>
    </ModalShell>
  );
}

/** Move the checked populations to a new parent (cycle-guarded). */
export function MovePopsModal({
  state,
  ids,
  onCancel,
  onConfirm,
}: {
  state: CoreState;
  ids: string[];
  onCancel: () => void;
  onConfirm: (parentId: string) => void;
}) {
  const order = populationTreeOrder(state.populations, state.root_population_id ?? null);
  const moving = new Set(ids);
  const candidates = order.filter(({ popId }) => !moving.has(popId) && ids.every((id) => !wouldCreateCycle(state.populations, id, popId)));
  const [parentId, setParentId] = useState(candidates[0]?.popId ?? "");
  return (
    <ModalShell title={`Move ${ids.length} population${ids.length === 1 ? "" : "s"}`}>
      <label className="gl-modal-field">
        <span>New parent</span>
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          {candidates.map(({ popId, depth }) => (
            <option key={popId} value={popId}>{" ".repeat(depth * 2)}{state.populations[popId]?.name ?? popId}</option>
          ))}
        </select>
      </label>
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="gl-btn" disabled={!parentId} onClick={() => parentId && onConfirm(parentId)}>Move</button>
      </div>
    </ModalShell>
  );
}

/** FCS export dialog: pick populations, an explicit value space, and sample scope. */
export function FcsExportModal({
  state,
  samplesCount,
  initialPopIds,
  initialAssay,
  initialScope,
  onCancel,
  onExport,
}: {
  state: CoreState;
  samplesCount: number;
  initialPopIds: string[];
  initialAssay: FcsExportAssay;
  initialScope: "active" | "combined" | "split";
  onCancel: () => void;
  onExport: (popIds: string[], assay: FcsExportAssay, scope: "active" | "combined" | "split") => void;
}) {
  const order = populationTreeOrder(state.populations, state.root_population_id ?? null);
  const allIds = order.map((o) => o.popId);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initialPopIds));
  const [assay, setAssay] = useState(initialAssay);
  const [scope, setScope] = useState(initialScope);
  const toggle = (id: string) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <ModalShell title="Export FCS">
      <div className="gl-modal-field">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span>Populations</span>
          <button className="gl-btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setChecked(new Set(allIds))}>Select all</button>
          <button className="gl-btn-ghost" onClick={() => setChecked(new Set())}>None</button>
          <span style={{ opacity: 0.7, minWidth: 66, textAlign: "right" }}>{checked.size} selected</span>
        </div>
        <div style={{ maxHeight: 260, overflow: "auto", border: "1px solid var(--gl-border, #ccc)", borderRadius: 4, padding: "4px 6px" }}>
          {allIds.length === 0 && <em style={{ opacity: 0.6 }}>No populations.</em>}
          {order.map(({ popId, depth }) => (
            <label key={popId} style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: depth * 14, cursor: "pointer" }}>
              <input type="checkbox" checked={checked.has(popId)} onChange={() => toggle(popId)} />
              {state.populations[popId]?.name ?? popId}
            </label>
          ))}
        </div>
      </div>
      <label className="gl-modal-field">
        <span>Values</span>
        <select value={assay} onChange={(e) => setAssay(e.target.value as FcsExportAssay)}>
          <option value="original">Original measurements (uncompensated)</option>
          <option value="compensated">Compensated linear measurements</option>
          <option value="display">Transformed display values</option>
        </select>
      </label>
      <div className="gl-modal-note">
        {assay === "original" && "Exports the measurements stored in the source FCS before spillover compensation or display transforms. This matches GateLabR's counts export."}
        {assay === "compensated" && "Applies each sample's current spillover-compensation setting, but does not apply logicle or arcsinh display transforms."}
        {assay === "display" && "Exports the values currently used for display after compensation (when enabled) and logicle/arcsinh transformation."}
        {" "}The output file is FCS 3.0 with 32-bit floating-point values.
      </div>
      {samplesCount > 1 && (
        <label className="gl-modal-field">
          <span>Samples</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="active">this sample</option>
            <option value="combined">all (combined)</option>
            <option value="split">all (split zip)</option>
          </select>
        </label>
      )}
      {samplesCount > 1 && scope === "combined" && (
        <div className="gl-modal-note">
          Combined export requires every sample containing selected events to have the same channels
          (channel order may differ). If panels differ, choose “all (split zip)”; GateLab will not omit
          samples or channels from a combined file.
        </div>
      )}
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="gl-btn" disabled={checked.size === 0} onClick={() => onExport([...checked], assay, scope)}>
          Export{checked.size > 1 ? ` (${checked.size})` : ""}
        </button>
      </div>
    </ModalShell>
  );
}

/** Bulk-rename populations from a CSV (old_population,new_population) with a template download. */
export function BulkRenameModal({
  state,
  onCancel,
  onConfirm,
}: {
  state: CoreState;
  onCancel: () => void;
  onConfirm: (mapping: Record<string, string>) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const names = populationTreeOrder(state.populations, state.root_population_id ?? null)
    .map(({ popId }) => state.populations[popId]?.name ?? popId)
    .filter((n, i, a) => a.indexOf(n) === i);

  const downloadTemplate = () => {
    const csv = "old_population,new_population\n" + names.map((n) => `${JSON.stringify(n)},${JSON.stringify(n)}`).join("\n") + "\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "population_rename_template.csv";
    a.click();
  };
  const onFile = async (f: File) => {
    try {
      const lines = (await f.text()).split(/\r\n|\r|\n/).filter((l) => l.trim());
      const mapping: Record<string, string> = {};
      for (let i = 1; i < lines.length; i++) {
        const cells = lines[i].match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim()) ?? [];
        if (cells[0] && cells[1] && cells[0] !== cells[1]) mapping[cells[0]] = cells[1];
      }
      if (Object.keys(mapping).length === 0) { setErr("No renames found (need old_population,new_population columns)."); return; }
      onConfirm(mapping);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <ModalShell title="Bulk-rename populations">
      <p style={{ fontSize: 12, color: "#555", margin: "2px 0 12px", lineHeight: 1.4 }}>
        Download the template, edit the <code>new_population</code> column, and upload it. Rows are matched by current name.
      </p>
      {err && <p style={{ fontSize: 12, color: "#d64545" }}>{err}</p>}
      <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={downloadTemplate}>Template ↧</button>
        <button className="gl-btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="gl-btn" onClick={() => fileRef.current?.click()}>Upload CSV…</button>
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
  return (
    <ModalShell title={title}>
      <p style={{ fontSize: 13, color: "#555", margin: "2px 0 14px", lineHeight: 1.4 }}>{message}</p>
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="gl-btn gl-btn-danger" onClick={onConfirm}>{confirmLabel}</button>
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
  const [name, setName] = useState(initial);
  const commit = () => {
    if (name.trim()) onConfirm(name.trim());
  };
  return (
    <ModalShell title={title}>
      <label className="gl-modal-field">
        New name:
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
          Cancel
        </button>
        <button className="gl-btn" onClick={commit}>
          Rename
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
      ...[...checked].map((gid) => ({ gate_id: gid, include: true })),
    ];
    onConfirm({ type: "editPopulation", popId, name, parentId, gateRefs });
  };

  return (
    <ModalShell title="Edit Population">
      <label className="gl-modal-field">
        Name:
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="gl-modal-field">
        Parent population:
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
          Inherited from parent chain:
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
                  {(ir.include ? g.name : `-${g.name}`) + " ← " + ir.from}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="gl-modal-field" style={{ gap: 6 }}>
        Gates for this population:
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
          {gateIds.length === 0 && <em style={{ color: "var(--muted)" }}>No gates yet.</em>}
          {gateIds.map((gid) => {
            const g = state.gates[gid];
            if (!g) return null;
            return (
              <label key={gid} className="gl-gateref-row">
                <input
                  type="checkbox"
                  checked={checked.has(gid)}
                  onChange={(e) => {
                    const next = new Set(checked);
                    if (e.target.checked) next.add(gid);
                    else next.delete(gid);
                    setChecked(next);
                  }}
                />
                <span className="gate-color-swatch" style={{ background: g.color, width: 10, height: 10 }} />
                <span>{g.name}</span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="gl-btn" onClick={commit}>
          Save
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
  const ids = (state.gate_order.length ? state.gate_order : Object.keys(state.gates))
    .filter((gid) => state.gates[gid]?.gate_type !== "quadrant");

  const commit = () => {
    const popName = name.trim() || `Pop_${Object.keys(state.populations).length}`;
    const gateRefs: GateRef[] = [...checked].map((gid) => ({ gate_id: gid, include: true }));
    onConfirm({ type: "addPopulation", name: popName, parentId, gateRefs });
  };

  return (
    <ModalShell title="Create Population">
      <label className="gl-modal-field">
        Population name:
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="gl-modal-field">
        Parent population:
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          {parentChoices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <div className="gl-modal-field" style={{ gap: 6 }}>
        Gate references (AND logic):
        <div className="gl-gateref-list">
          {ids.length === 0 && <em style={{ color: "var(--muted)" }}>No gates yet.</em>}
          {ids.map((gid) => {
            const g = state.gates[gid];
            if (!g) return null;
            return (
              <label key={gid} className="gl-gateref-row">
                <input
                  type="checkbox"
                  checked={checked.has(gid)}
                  onChange={(e) => {
                    const next = new Set(checked);
                    if (e.target.checked) next.add(gid);
                    else next.delete(gid);
                    setChecked(next);
                  }}
                />
                <span className="gate-color-swatch" style={{ background: g.color, width: 10, height: 10 }} />
                <span>{g.name}</span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="gl-btn" onClick={commit}>
          Create
        </button>
      </div>
    </ModalShell>
  );
}
