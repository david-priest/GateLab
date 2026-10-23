// GateModals.tsx — the "Name this gate" / "Create quadrant gate" dialogs shown when a
// gate is drawn (input$new_gate). Ported from app.R observeEvent(input$new_gate) +
// confirm_gate_btn / confirm_quadrant_btn. On confirm, the drawn DISPLAY-space vertices are
// converted into the space the new gate will live in, and — for a display-space gate — the
// transform each axis was drawn under is snapshotted onto it. That snapshot is what keeps the
// gate's membership fixed afterwards; without it the gate would follow the view, as FlowJo's do.

import { useMemo, useState } from "react";
import { ModalEscape } from "./useModalEscape";
import type { NewGate } from "../plots/GatingPlot";
import type { Sample } from "../engine/sample";
import type { Action } from "../store";
import { flowJoCurlForDisplay, UNBOUNDED, type GateSpace, type PopulationMap, type QuadrantArms, type Vertex } from "../engine/models";
import {
  quadrantPopulationNames,
  rememberQuadrantNaming,
  rememberedQuadrantNaming,
  shortChannelLabel,
  type QuadrantNaming,
} from "../engine/quadrantNames";
import { useI18n } from "./i18n";

interface Props {
  pending: NewGate;
  sample: Sample;
  populations: PopulationMap;
  activePopId: string | null;
  rootPopId: string;
  nGates: number;
  /**
   * Space new gates are created in; the gate records it permanently. `null` records nothing and
   * leaves the gate on this sample's legacy default — which is what CyTOF still does, since
   * migrating its gates to an explicit snapshot touches saved workspaces and is its own change.
   */
  gateSpace: GateSpace | null;
  onCancel: () => void;
  onConfirm: (a: Action) => void;
}

function appendSuffix(x: string, suffix: string): string {
  const t = x.trim();
  if (t.length === 0) return suffix;
  if (new RegExp(`\\s*${suffix}$`, "i").test(t)) return t;
  return `${t} ${suffix}`;
}

export function GateModals({
  pending,
  sample,
  populations,
  activePopId,
  rootPopId,
  nGates,
  gateSpace,
  onCancel,
  onConfirm,
}: Props) {
  const parentChoices = useMemo(
    () => Object.keys(populations).map((id) => ({ id, name: populations[id].name })),
    [populations],
  );
  const defaultParent = activePopId && populations[activePopId] ? activePopId : rootPopId;

  // The space fields the new gate will carry, and the conversion that matches them. Computed
  // once here so the vertices and the snapshot can never disagree about which space they mean.
  const spaceFields = gateSpace
    ? sample.newGateSpaceFields(gateSpace, pending.x_channel, pending.y_channel)
    : {};
  const toGating = (v: Vertex): Vertex => [
    sample.displayToGate(spaceFields, pending.x_channel, v[0]),
    sample.displayToGate(spaceFields, pending.y_channel, v[1]),
  ];

  if (pending.gate_type === "quadrant") {
    // A curly quadrant bends in the space it is drawn in, so like an ellipse it is created in
    // DISPLAY space with the axes' transforms captured, whatever the new-gate space selector
    // says; a straight crosshair follows the selector as before. The bend starts as FlowJo's,
    // carried into these axes' spans, and the arm handles take it from there. A spider
    // quadrant's arms are straight in the display they are drawn on, so it is created there too,
    // its arms on their axes out to a box around every event until their handles lean them.
    const curlySpaceFields = gateSpace
      ? sample.newGateSpaceFields("display", pending.x_channel, pending.y_channel)
      : {};
    const rangeOf = (channel: string): [number, number] | null => {
      const idx = sample.index(channel);
      if (idx === undefined) return null;
      const [lo, hi] = sample.displayRange(idx);
      return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? [lo, hi] : null;
    };
    const spanOf = (channel: string): number => {
      const r = rangeOf(channel);
      return r ? r[1] - r[0] : 1;
    };
    /**
     * Where a spider's box starts on one axis: past every event of this file (an event outside the
     * box is in no quadrant) and at least as wide as the plotted range, which drops the tails.
     */
    const boxOf = (channel: string): [number, number] | null => {
      const idx = sample.index(channel);
      const r = rangeOf(channel);
      if (idx === undefined || !r) return r;
      let lo = r[0];
      let hi = r[1];
      for (const v of sample.displayColumn(idx)) {
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        else if (v > hi) hi = v;
      }
      const pad = (hi - lo) * 0.01;
      return [lo - pad, hi + pad];
    };
    /** Arms on their axes from a display-space centre, each end on the box's edge or beyond the centre. */
    const axisArms = (fields: typeof curlySpaceFields, v: Vertex): QuadrantArms => {
      const [xr, yr] = [boxOf(pending.x_channel), boxOf(pending.y_channel)];
      const sx = spanOf(pending.x_channel);
      const sy = spanOf(pending.y_channel);
      const lo = (r: [number, number] | null, c: number, span: number) => Math.min(r ? r[0] : c - span, c - span / 2);
      const hi = (r: [number, number] | null, c: number, span: number) => Math.max(r ? r[1] : c + span, c + span / 2);
      const at = (dx: number, dy: number): [number, number] => [
        sample.displayToGate(fields, pending.x_channel, dx),
        sample.displayToGate(fields, pending.y_channel, dy),
      ];
      return {
        down: at(v[0], lo(yr, v[1], sy)),
        right: at(hi(xr, v[0], sx), v[1]),
        up: at(v[0], hi(yr, v[1], sy)),
        left: at(lo(xr, v[0], sx), v[1]),
      };
    };
    // The population names take the marker alone where the channel has one, else the
    // detector: "CD4+ CD8-" rather than "CD4 (FITC-A)+ CD8 (PE-A)-".
    const shortLabel = (key: string) => {
      const idx = sample.index(key);
      return shortChannelLabel(idx === undefined ? undefined : sample.channels[idx], key);
    };
    const xLabel = shortLabel(pending.x_channel);
    const yLabel = shortLabel(pending.y_channel);
    return (
      <QuadrantModal
        pending={pending}
        xLabel={xLabel}
        yLabel={yLabel}
        parentChoices={parentChoices}
        defaultParent={defaultParent}
        onCancel={onCancel}
        onConfirm={(prefix, parentId, armStyle, naming) => {
          const curly = armStyle === "curly";
          const fields = armStyle !== "straight" ? curlySpaceFields : spaceFields;
          const v = pending.vertices[0];
          const c: Vertex = [
            sample.displayToGate(fields, pending.x_channel, v[0]),
            sample.displayToGate(fields, pending.y_channel, v[1]),
          ];
          rememberQuadrantNaming(naming);
          onConfirm({
            type: "addQuadrant",
            xChannel: pending.x_channel,
            yChannel: pending.y_channel,
            xLabel,
            yLabel,
            names: quadrantPopulationNames(naming, xLabel, yLabel),
            center: c,
            prefix,
            parentId,
            ...fields,
            ...(curly
              ? { curl: flowJoCurlForDisplay(spanOf(pending.x_channel), spanOf(pending.y_channel)) }
              : {}),
            ...(armStyle === "spider" ? { arms: axisArms(fields, v) } : {}),
          });
        }}
      />
    );
  }

  if (pending.gate_type === "ellipse") {
    // A drawn ellipse is an ellipse ON SCREEN, so it is created in DISPLAY space with the
    // current axes' transforms captured — regardless of the new-gate space selector. Converting
    // the drag to raw through a nonlinear axis would warp it into something that is not an
    // ellipse, silently. On linear axes display and raw coincide, so nothing is lost there
    // either. (CyTOF keeps its legacy space: gateSpace is null and the fields stay absent.)
    const ellipseSpaceFields = gateSpace
      ? sample.newGateSpaceFields("display", pending.x_channel, pending.y_channel)
      : {};
    return (
      <GateModal
        pending={pending}
        parentChoices={parentChoices}
        defaultParent={defaultParent}
        onCancel={onCancel}
        onConfirm={(nameInput, createPop, popNameInput, parentId) => {
          let gateName = nameInput.trim() || `Gate_${nGates + 1}`;
          if (createPop) gateName = appendSuffix(gateName, "gate");
          // The plot emits the ellipse as its bounding-box corners (which also places the
          // label correctly); centre and radii are recovered from them.
          const [p0, p1] = pending.vertices;
          onConfirm({
            type: "addEllipse",
            xChannel: pending.x_channel,
            yChannel: pending.y_channel,
            mean: [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2],
            radii: [Math.abs(p1[0] - p0[0]) / 2, Math.abs(p1[1] - p0[1]) / 2],
            labelOffset: pending.label_offset,
            name: gateName,
            ...ellipseSpaceFields,
            createPop: createPop
              ? { name: popNameInput.trim() || gateName, parentId }
              : undefined,
          });
        }}
      />
    );
  }

  return (
    <GateModal
      pending={pending}
      parentChoices={parentChoices}
      defaultParent={defaultParent}
      onCancel={onCancel}
      onConfirm={(nameInput, createPop, popNameInput, parentId) => {
        let gateName = nameInput.trim() || `Gate_${nGates + 1}`;
        if (createPop) gateName = appendSuffix(gateName, "gate");
        const vertices = pending.vertices.map(toGating);
        onConfirm({
          type: "addGate",
          gateType: pending.gate_type as "polygon" | "rectangle",
          xChannel: pending.x_channel,
          yChannel: pending.y_channel,
          vertices,
          labelOffset: pending.label_offset,
          name: gateName,
          ...spaceFields,
          createPop: createPop
            ? { name: popNameInput.trim() || gateName, parentId }
            : undefined,
        });
      }}
    />
  );
}

interface ParentChoice {
  id: string;
  name: string;
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="gl-modal-backdrop">
      <ModalEscape onClose={onClose} />
      <div className="gl-modal">
        <div className="gl-modal-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

function ParentSelect({
  choices,
  value,
  onChange,
}: {
  choices: ParentChoice[];
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="gl-modal-field">
      {t("Parent population:")}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function GateModal({
  pending,
  parentChoices,
  defaultParent,
  onCancel,
  onConfirm,
}: {
  pending: NewGate;
  parentChoices: ParentChoice[];
  defaultParent: string;
  onCancel: () => void;
  onConfirm: (name: string, createPop: boolean, popName: string, parentId: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [createPop, setCreatePop] = useState(false);
  const [popName, setPopName] = useState("");
  const [popNameManual, setPopNameManual] = useState(false);
  const [parentId, setParentId] = useState(defaultParent);

  const setGateName = (v: string) => {
    setName(v);
    if (!popNameManual) setPopName(v.trim());
  };

  return (
    <ModalShell title={t("Name this gate")} onClose={onCancel}>
      <label className="gl-modal-field">
        {t("Gate name:")}
        <input
          autoFocus
          value={name}
          onChange={(e) => setGateName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm(name, createPop, popName, parentId);
          }}
        />
      </label>
      <label className="gl-modal-check">
        <input type="checkbox" checked={createPop} onChange={(e) => setCreatePop(e.target.checked)} />
        {t("Also create a population from this gate")}
      </label>
      {createPop && (
        <>
          <label className="gl-modal-field">
            {t("New population name:")}
            <input
              value={popName}
              onChange={(e) => {
                setPopName(e.target.value);
                setPopNameManual(true);
              }}
            />
          </label>
          <ParentSelect choices={parentChoices} value={parentId} onChange={setParentId} />
        </>
      )}
      <div className="gl-modal-note">
        {/* A rectangle with one channel on both axes is a range, drawn on the histogram view. */}
        {pending.gate_type === "rectangle" && pending.x_channel === pending.y_channel
          ? `range · ${pending.x_channel}`
          : `${pending.gate_type} · ${pending.x_channel} / ${pending.y_channel}`}
      </div>
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button className="gl-btn" onClick={() => onConfirm(name, createPop, popName, parentId)}>
          {t("Create")}
        </button>
      </div>
    </ModalShell>
  );
}

function QuadrantModal({
  pending,
  xLabel,
  yLabel,
  parentChoices,
  defaultParent,
  onCancel,
  onConfirm,
}: {
  pending: NewGate;
  xLabel: string;
  yLabel: string;
  parentChoices: ParentChoice[];
  defaultParent: string;
  onCancel: () => void;
  onConfirm: (prefix: string, parentId: string, armStyle: "straight" | "curly" | "spider", naming: QuadrantNaming) => void;
}) {
  const { t } = useI18n();
  const [prefix, setPrefix] = useState("");
  const [parentId, setParentId] = useState(defaultParent);
  const [armStyle, setArmStyle] = useState<"straight" | "curly" | "spider">("straight");
  const curly = armStyle === "curly";
  // The scheme chosen last time holds until it is changed; each option reads as the names it gives.
  const [naming, setNaming] = useState<QuadrantNaming>(rememberedQuadrantNaming);
  return (
    <ModalShell title={t("Create quadrant gate")} onClose={onCancel}>
      <div className="gl-modal-note">
        {t("Splits {x} × {y} into four quadrant populations at the crosshair.", { x: pending.x_channel, y: pending.y_channel })}
      </div>
      <label className="gl-modal-field">
        {t("Name prefix (optional):")}
        <input autoFocus value={prefix} onChange={(e) => setPrefix(e.target.value)} />
      </label>
      <label className="gl-modal-field">
        {t("Population names:")}
        <select
          aria-label={t("Quadrant population names")}
          value={naming}
          onChange={(e) => setNaming(e.target.value === "signs" ? "signs" : "dndp")}
        >
          <option value="dndp">{quadrantPopulationNames("dndp", xLabel, yLabel).join(", ")}</option>
          <option value="signs">{quadrantPopulationNames("signs", xLabel, yLabel).join(", ")}</option>
        </select>
      </label>
      <ParentSelect choices={parentChoices} value={parentId} onChange={setParentId} />
      <label className="gl-modal-check">
        <input type="checkbox" checked={curly} onChange={(e) => setArmStyle(e.target.checked ? "curly" : "straight")} />
        {t("Curly arms")}
      </label>
      {curly && (
        <div className="gl-modal-note">
          {t("Beyond the crosshair the dividers bend toward the upper right, following photon-counting spread; drag the handle at the end of either arm to set the bend.")}
        </div>
      )}
      <label className="gl-modal-check">
        <input type="checkbox" checked={armStyle === "spider"} onChange={(e) => setArmStyle(e.target.checked ? "spider" : "straight")} />
        {t("Spider arms (each arm moves on its own)")}
      </label>
      {armStyle === "spider" && (
        <div className="gl-modal-note">
          {t("Four straight arms run from the centre to the edges of a box around the data. Drag an arm's end along its edge to lean it, or the centre to move it. Each quadrant lies between two neighbouring arms, inside the box.")}
        </div>
      )}
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button className="gl-btn" onClick={() => onConfirm(prefix, parentId, armStyle, naming)}>
          {t("Create 4 populations")}
        </button>
      </div>
    </ModalShell>
  );
}

/**
 * The dialog for a bisector placed on the histogram view: two range gates on one channel that
 * meet at the split, [−∞, split) and [split, +∞). Both are half-open, so every event is in exactly
 * one, and both are ordinary ranges (a rectangle with the channel on both axes), so they import,
 * export and count as any other range. Nothing records that they belong together: on the
 * histogram, ends that meet share a handle, which is what keeps them a bisector. They are added
 * as one Undo step.
 */
export function BisectorModal({
  channel,
  split,
  sample,
  populations,
  activePopId,
  rootPopId,
  gateSpace,
  onCancel,
  onConfirm,
}: {
  channel: string;
  /** Where the two ranges meet, in display units. */
  split: number;
  sample: Sample;
  populations: PopulationMap;
  activePopId: string | null;
  rootPopId: string;
  gateSpace: GateSpace | null;
  onCancel: () => void;
  onConfirm: (a: Action) => void;
}) {
  const { t } = useI18n();
  const idx = sample.index(channel);
  const label = shortChannelLabel(idx === undefined ? undefined : sample.channels[idx], channel);
  const [lowName, setLowName] = useState(`${label}-`);
  const [highName, setHighName] = useState(`${label}+`);
  const [createPops, setCreatePops] = useState(true);
  const parentChoices = Object.keys(populations).map((id) => ({ id, name: populations[id].name }));
  const [parentId, setParentId] = useState(activePopId && populations[activePopId] ? activePopId : rootPopId);

  const confirm = () => {
    const spaceFields = gateSpace ? sample.newGateSpaceFields(gateSpace, channel, channel) : {};
    const s = sample.displayToGate(spaceFields, channel, split);
    const range = (lo: number, hi: number): Vertex[] => [[lo, lo], [hi, lo], [hi, hi], [lo, hi]];
    const gate = (name: string, vertices: Vertex[]): Extract<Action, { type: "addGate" }> => {
      const popName = name.trim() || label;
      return {
        type: "addGate",
        gateType: "rectangle",
        xChannel: channel,
        yChannel: channel,
        vertices,
        name: createPops ? appendSuffix(popName, "gate") : popName,
        ...spaceFields,
        bounds: "half-open",
        createPop: createPops ? { name: popName, parentId } : undefined,
      };
    };
    onConfirm({
      type: "addGates",
      gates: [gate(lowName, range(-UNBOUNDED, s)), gate(highName, range(s, UNBOUNDED))],
    });
  };

  return (
    <ModalShell title={t("Create bisector")} onClose={onCancel}>
      <div className="gl-modal-note">
        {t("Splits {channel} into two ranges at the line: everything below it, and everything from it up.", { channel: label })}
      </div>
      <label className="gl-modal-field">
        {t("Lower range:")}
        <input autoFocus aria-label={t("Lower range name")} value={lowName} onChange={(e) => setLowName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") confirm(); }} />
      </label>
      <label className="gl-modal-field">
        {t("Upper range:")}
        <input aria-label={t("Upper range name")} value={highName} onChange={(e) => setHighName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") confirm(); }} />
      </label>
      <label className="gl-modal-check">
        <input type="checkbox" checked={createPops} onChange={(e) => setCreatePops(e.target.checked)} />
        {t("Also create a population from each range")}
      </label>
      {createPops && <ParentSelect choices={parentChoices} value={parentId} onChange={setParentId} />}
      <div className="gl-modal-note">{`bisector · ${channel}`}</div>
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button className="gl-btn" onClick={confirm}>
          {t("Create 2 ranges")}
        </button>
      </div>
    </ModalShell>
  );
}
