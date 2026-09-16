// GateModals.tsx — the "Name this gate" / "Create quadrant gate" dialogs shown when a
// gate is drawn (input$new_gate). Ported from app.R observeEvent(input$new_gate) +
// confirm_gate_btn / confirm_quadrant_btn. On confirm, the drawn DISPLAY-space vertices are
// converted into the space the new gate will live in, and — for a display-space gate — the
// transform each axis was drawn under is snapshotted onto it. That snapshot is what keeps the
// gate's membership fixed afterwards; without it the gate would follow the view, as FlowJo's do.

import { useMemo, useState } from "react";
import type { NewGate } from "../plots/GatingPlot";
import type { Sample } from "../engine/sample";
import type { Action } from "../store";
import { flowJoCurlForDisplay, type GateSpace, type PopulationMap, type Vertex } from "../engine/models";
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
    // carried into these axes' spans, and the arm handles take it from there.
    const curlySpaceFields = gateSpace
      ? sample.newGateSpaceFields("display", pending.x_channel, pending.y_channel)
      : {};
    const spanOf = (channel: string): number => {
      const idx = sample.index(channel);
      if (idx === undefined) return 1;
      const [lo, hi] = sample.displayRange(idx);
      return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? hi - lo : 1;
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
        onConfirm={(prefix, parentId, curly, naming) => {
          const fields = curly ? curlySpaceFields : spaceFields;
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
    <ModalShell title={t("Name this gate")}>
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
        {pending.gate_type} · {pending.x_channel} / {pending.y_channel}
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
  onConfirm: (prefix: string, parentId: string, curly: boolean, naming: QuadrantNaming) => void;
}) {
  const { t } = useI18n();
  const [prefix, setPrefix] = useState("");
  const [parentId, setParentId] = useState(defaultParent);
  const [curly, setCurly] = useState(false);
  // The scheme chosen last time holds until it is changed; each option reads as the names it gives.
  const [naming, setNaming] = useState<QuadrantNaming>(rememberedQuadrantNaming);
  return (
    <ModalShell title={t("Create quadrant gate")}>
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
        <input type="checkbox" checked={curly} onChange={(e) => setCurly(e.target.checked)} />
        {t("Curly arms (FlowJo-style)")}
      </label>
      {curly && (
        <div className="gl-modal-note">
          {t("Beyond the crosshair the dividers bend toward the upper right, following photon-counting spread; drag the handle at the end of either arm to set the bend.")}
        </div>
      )}
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button className="gl-btn" onClick={() => onConfirm(prefix, parentId, curly, naming)}>
          {t("Create 4 populations")}
        </button>
      </div>
    </ModalShell>
  );
}
