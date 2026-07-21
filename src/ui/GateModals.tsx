// GateModals.tsx — the "Name this gate" / "Create quadrant gate" dialogs shown when a
// gate is drawn (input$new_gate). Ported from app.R observeEvent(input$new_gate) +
// confirm_gate_btn / confirm_quadrant_btn. On confirm, drawn DISPLAY-space vertices are
// converted to gating space (sample.displayToGating) before the gate is stored.

import { useMemo, useState } from "react";
import type { NewGate } from "../plots/GatingPlot";
import type { Sample } from "../engine/sample";
import type { Action } from "../store";
import type { PopulationMap, Vertex } from "../engine/models";
import { useI18n } from "./i18n";

interface Props {
  pending: NewGate;
  sample: Sample;
  populations: PopulationMap;
  activePopId: string | null;
  rootPopId: string;
  nGates: number;
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
  onCancel,
  onConfirm,
}: Props) {
  const parentChoices = useMemo(
    () => Object.keys(populations).map((id) => ({ id, name: populations[id].name })),
    [populations],
  );
  const defaultParent = activePopId && populations[activePopId] ? activePopId : rootPopId;

  const toGating = (v: Vertex): Vertex => [
    sample.displayToGating(pending.x_channel, v[0]),
    sample.displayToGating(pending.y_channel, v[1]),
  ];

  if (pending.gate_type === "quadrant") {
    return (
      <QuadrantModal
        pending={pending}
        parentChoices={parentChoices}
        defaultParent={defaultParent}
        onCancel={onCancel}
        onConfirm={(prefix, parentId) => {
          const c = toGating(pending.vertices[0]);
          onConfirm({
            type: "addQuadrant",
            xChannel: pending.x_channel,
            yChannel: pending.y_channel,
            center: c,
            prefix,
            parentId,
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
  parentChoices,
  defaultParent,
  onCancel,
  onConfirm,
}: {
  pending: NewGate;
  parentChoices: ParentChoice[];
  defaultParent: string;
  onCancel: () => void;
  onConfirm: (prefix: string, parentId: string) => void;
}) {
  const { t } = useI18n();
  const [prefix, setPrefix] = useState("");
  const [parentId, setParentId] = useState(defaultParent);
  return (
    <ModalShell title={t("Create quadrant gate")}>
      <div className="gl-modal-note">
        {t("Splits {x} × {y} into four quadrant populations at the crosshair.", { x: pending.x_channel, y: pending.y_channel })}
      </div>
      <label className="gl-modal-field">
        {t("Name prefix (optional):")}
        <input autoFocus value={prefix} onChange={(e) => setPrefix(e.target.value)} />
      </label>
      <ParentSelect choices={parentChoices} value={parentId} onChange={setParentId} />
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button className="gl-btn" onClick={() => onConfirm(prefix, parentId)}>
          {t("Create 4 populations")}
        </button>
      </div>
    </ModalShell>
  );
}
