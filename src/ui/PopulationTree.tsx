// PopulationTree.tsx — reproduced from GateLabR output$population_tree_ui.
// Recursive rows with SVG ├/└ tree connectors (make_tree_connectors), multi-select
// checkbox (selected_pop_ids), gate-ref badges (coloured by gate, "-name" when excluded,
// .selected-gate ring when that gate is selected), count and "% pnt, % tot".
// Row click → setActivePopulation (pop_tree_click) + focus the container for arrow nav.

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CoreState, Derived, Action } from "../store";
import { wouldCreateCycle, type Gate, type GateRef } from "../engine/models";
import { TreeConnectors } from "./TreeConnectors";
import { useI18n } from "./i18n";

interface Props {
  state: CoreState;
  derived: Derived;
  dispatch: (a: Action) => void;
}

function focusTreeContainer() {
  const c = document.getElementById("population_tree_container");
  if (c) c.focus({ preventScroll: true });
}

type DropPlacement = "before" | "inside" | "after";

interface DropTarget {
  popId: string;
  placement: DropPlacement;
  valid: boolean;
}

interface PointerDrag {
  popId: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  dropTarget: DropTarget | null;
}

interface GateChoice {
  key: string;
  gateRef: GateRef;
  gate: Gate;
  shortLabel: string;
  label: string;
}

interface GatePickerState {
  popId: string;
  refIndex: number | null;
  left: number;
  top: number;
}

function gateRefKey(ref: GateRef): string {
  return `${ref.gate_id}:${ref.quadrant ?? ""}`;
}

function gateChoices(state: CoreState): GateChoice[] {
  const orderedIds = [
    ...state.gate_order,
    ...Object.keys(state.gates).filter((gateId) => !state.gate_order.includes(gateId)),
  ];
  return orderedIds.flatMap((gateId): GateChoice[] => {
    const gate = state.gates[gateId];
    if (!gate) return [];
    const suffix = `${gate.x_channel} / ${gate.y_channel}`;
    if (gate.gate_type !== "quadrant") {
      const gateRef: GateRef = { gate_id: gateId, include: true };
      return [{
        key: gateRefKey(gateRef),
        gateRef,
        gate,
        shortLabel: gate.name,
        label: `${gate.name} — ${suffix}`,
      }];
    }
    return [1, 2, 3, 4].map((quadrant) => {
      const gateRef: GateRef = { gate_id: gateId, include: true, quadrant };
      return {
        key: gateRefKey(gateRef),
        gateRef,
        gate,
        shortLabel: `${gate.name} [Q${quadrant}]`,
        label: `${gate.name} [Q${quadrant}] — ${suffix}`,
      };
    });
  });
}

export function PopulationTree({ state, derived, dispatch }: Props) {
  const { t } = useI18n();
  const { populations, root_population_id, active_population_id, selected_gate_id, selected_pop_ids, gates } = state;
  const stats = derived.stats;
  const checkedPops = new Set(selected_pop_ids);
  const choices = useMemo(() => gateChoices(state), [state.gate_order, state.gates]);
  const [editingName, setEditingName] = useState<{ popId: string; value: string } | null>(null);
  const [draggingPopId, setDraggingPopId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [gatePicker, setGatePicker] = useState<GatePickerState | null>(null);
  const [gateQuery, setGateQuery] = useState("");
  const gatePickerRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const pointerDragRef = useRef<PointerDrag | null>(null);
  const suppressRowClickRef = useRef(false);

  useEffect(() => {
    if (!editingName) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [editingName?.popId]);

  useEffect(() => {
    if (!gatePicker) return;
    const closeIfOutside = (event: PointerEvent) => {
      if (!gatePickerRef.current?.contains(event.target as Node)) setGatePicker(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setGatePicker(null);
    };
    const closeOnViewportChange = () => setGatePicker(null);
    window.addEventListener("pointerdown", closeIfOutside);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      window.removeEventListener("pointerdown", closeIfOutside);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [gatePicker]);

  useEffect(() => {
    if (editingName && !populations[editingName.popId]) setEditingName(null);
    if (gatePicker && !populations[gatePicker.popId]) setGatePicker(null);
  }, [editingName, gatePicker, populations]);

  if (!root_population_id || Object.keys(populations).length === 0) {
    return (
      <div className="population-tree-panel">
        <em style={{ color: "#999", fontSize: 12 }}>{t("No data loaded.")}</em>
      </div>
    );
  }

  const rows: React.ReactNode[] = [];
  const visited = new Set<string>();

  const startRename = (event: React.MouseEvent, popId: string) => {
    if (popId === root_population_id) return;
    event.preventDefault();
    event.stopPropagation();
    setEditingName({ popId, value: populations[popId].name });
  };

  const commitRename = () => {
    if (!editingName) return;
    const name = editingName.value.trim();
    if (name) dispatch({ type: "renamePopulation", popId: editingName.popId, name });
    setEditingName(null);
  };

  const openGatePicker = (
    event: React.MouseEvent<HTMLElement>,
    popId: string,
    refIndex: number | null,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 300;
    const height = 360;
    setGateQuery("");
    setGatePicker({
      popId,
      refIndex,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)),
    });
  };

  const chooseGate = (choice: GateChoice) => {
    if (!gatePicker) return;
    const population = populations[gatePicker.popId];
    if (!population) return;
    const gateRefs = population.gate_refs.map((ref) => ({ ...ref }));
    if (gatePicker.refIndex === null) gateRefs.push({ ...choice.gateRef });
    else if (gatePicker.refIndex >= 0 && gatePicker.refIndex < gateRefs.length) {
      gateRefs[gatePicker.refIndex] = { ...choice.gateRef };
    } else {
      return;
    }
    dispatch({ type: "setPopulationGateRefs", popId: gatePicker.popId, gateRefs });
    setGatePicker(null);
  };

  const removePickedGate = () => {
    if (!gatePicker || gatePicker.refIndex === null) return;
    const population = populations[gatePicker.popId];
    if (!population) return;
    const gateRefs = population.gate_refs
      .filter((_, index) => index !== gatePicker.refIndex)
      .map((ref) => ({ ...ref }));
    dispatch({ type: "setPopulationGateRefs", popId: gatePicker.popId, gateRefs });
    setGatePicker(null);
  };

  const validDrop = (
    sourceId: string,
    targetId: string,
    placement: DropPlacement,
  ): boolean => {
    if (
      sourceId === root_population_id ||
      sourceId === targetId ||
      !populations[sourceId] ||
      !populations[targetId]
    ) {
      return false;
    }
    const destinationParentId =
      placement === "inside" ? targetId : populations[targetId].parent_id;
    return !!destinationParentId &&
      !!populations[destinationParentId] &&
      !wouldCreateCycle(populations, sourceId, destinationParentId);
  };

  const resetPointerDrag = (row: HTMLDivElement, pointerId: number): void => {
    if (row.hasPointerCapture?.(pointerId)) row.releasePointerCapture(pointerId);
    pointerDragRef.current = null;
    setDraggingPopId(null);
    setDropTarget(null);
  };

  const updatePointerDropTarget = (
    sourceId: string,
    clientX: number,
    clientY: number,
  ): DropTarget | null => {
    const pointed = document.elementFromPoint(clientX, clientY);
    const row = pointed instanceof Element ? pointed.closest<HTMLElement>(".pop-row") : null;
    const targetId = row?.dataset.popId;
    if (!row || !targetId || !populations[targetId]) return null;
    const rect = row.getBoundingClientRect();
    const position = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
    const placement: DropPlacement = targetId === root_population_id
      ? "inside"
      : position < 0.28
        ? "before"
        : position > 0.72
          ? "after"
          : "inside";
    return {
      popId: targetId,
      placement,
      valid: validDrop(sourceId, targetId, placement),
    };
  };

  const appendRows = (popId: string, depth: number, isLastPath: boolean[]) => {
    if (visited.has(popId)) return;
    visited.add(popId);
    const pop = populations[popId];
    if (!pop) return;

    const isActive = popId === active_population_id;
    const isRoot = popId === root_population_id;
    const countVal = stats.event_count[popId] ?? pop.event_count;
    const pctParent = stats.percent_of_parent[popId] ?? pop.percent_of_parent;
    const pctTotal = stats.percent_of_total[popId];
    const countText = countVal != null ? countVal.toLocaleString() : "?";
    let pctText = "";
    if (!isRoot) {
      const parts: string[] = [];
      if (pctParent != null) parts.push(`${pctParent}% pnt`);
      if (pctTotal != null) parts.push(`${pctTotal}% tot`);
      if (parts.length) pctText = `(${parts.join(", ")})`;
    }

    rows.push(
      <div
        key={popId}
        className={
          "pop-row" +
          (isActive ? " active" : "") +
          (draggingPopId === popId ? " dragging" : "") +
          (dropTarget?.popId === popId
            ? ` drop-${dropTarget.placement}${dropTarget.valid ? "" : " drop-invalid"}`
            : "")
        }
        data-pop-id={popId}
        onClick={(event) => {
          if (suppressRowClickRef.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          dispatch({ type: "setActivePopulation", popId });
          focusTreeContainer();
        }}
        onPointerDown={(event) => {
          if (isRoot || !event.shiftKey || event.button !== 0) return;
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest("button, input, .pop-tree-gate-badge")) return;
          pointerDragRef.current = {
            popId,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            active: false,
            dropTarget: null,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const drag = pointerDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (!drag.active) {
            const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
            if (moved < 4) return;
            drag.active = true;
            setDraggingPopId(drag.popId);
          }
          event.preventDefault();
          const nextTarget = updatePointerDropTarget(drag.popId, event.clientX, event.clientY);
          drag.dropTarget = nextTarget;
          setDropTarget(nextTarget);
        }}
        onPointerUp={(event) => {
          const drag = pointerDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (drag.active) {
            event.preventDefault();
            suppressRowClickRef.current = true;
            window.setTimeout(() => {
              suppressRowClickRef.current = false;
            }, 0);
          }
          if (drag.active && drag.dropTarget?.valid) {
            dispatch({
              type: "movePopulation",
              popId: drag.popId,
              targetId: drag.dropTarget.popId,
              placement: drag.dropTarget.placement,
            });
          }
          resetPointerDrag(event.currentTarget, event.pointerId);
        }}
        onPointerCancel={(event) => {
          const drag = pointerDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          resetPointerDrag(event.currentTarget, event.pointerId);
        }}
      >
        <span className="pop-row-select-col">
          <input
            type="checkbox"
            className="pop-row-select"
            checked={checkedPops.has(popId)}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) =>
              dispatch({ type: "togglePopSelect", popId, checked: e.target.checked })
            }
          />
        </span>
        <span className="pop-row-name-col">
          <TreeConnectors depth={depth} isLastPath={isLastPath} />
          {editingName?.popId === popId ? (
            <input
              className="pop-row-name-input"
              value={editingName.value}
              aria-label={t("Population name")}
              ref={renameInputRef}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onChange={(event) => setEditingName({ popId, value: event.target.value })}
              onBlur={commitRename}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setEditingName(null);
                }
              }}
            />
          ) : (
            <span
              className="pop-row-name"
              title={isRoot ? pop.name : t("Double-click to rename")}
              onDoubleClick={(event) => startRename(event, popId)}
            >
              {pop.name}
            </span>
          )}
        </span>
        <span className="pop-row-gates-col">
          <span className="pop-row-gates">
            {pop.gate_refs.map((ref, i) => {
              const gate = gates[ref.gate_id];
              if (!gate) return null;
              const isSelGate = ref.gate_id === selected_gate_id;
              const cls =
                "gate-ref-badge pop-tree-gate-badge" +
                (!ref.include ? " exclude" : "") +
                (isSelGate ? " selected-gate" : "");
              return (
                <span
                  key={i}
                  className={cls}
                  style={{ background: gate.color }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.shiftKey && !isRoot) openGatePicker(e, popId, i);
                    else dispatch({ type: "selectGate", gateId: ref.gate_id });
                  }}
                  title={t("Click to select; Shift-click to change or remove")}
                >
                  {ref.include ? gate.name : `-${gate.name}`}
                  {ref.quadrant !== undefined ? ` [Q${ref.quadrant}]` : ""}
                </span>
              );
            })}
            {!isRoot && choices.length > 0 && (
              <button
                type="button"
                className="gate-ref-badge pop-tree-gate-add"
                aria-label={t("Add a gate to this population")}
                title={t("Add a gate to this population")}
                onClick={(event) => openGatePicker(event, popId, null)}
              >
                +
              </button>
            )}
          </span>
        </span>
        <span className="pop-row-count">{countText}</span>
        <span className="pop-row-pct">{pctText}</span>
      </div>,
    );

    const childIds = [...new Set(pop.children)].filter((c) => c in populations);
    childIds.forEach((cid, i) => appendRows(cid, depth + 1, [...isLastPath, i === childIds.length - 1]));
  };

  appendRows(root_population_id, 0, []);

  const pickerPopulation = gatePicker ? populations[gatePicker.popId] : null;
  const pickerCurrentRef =
    gatePicker?.refIndex !== null && gatePicker?.refIndex !== undefined && pickerPopulation
      ? pickerPopulation.gate_refs[gatePicker.refIndex]
      : null;
  const pickerCurrentChoice = pickerCurrentRef
    ? choices.find((choice) => choice.key === gateRefKey(pickerCurrentRef)) ?? null
    : null;
  const usedKeys = new Set(
    (pickerPopulation?.gate_refs ?? [])
      .filter((_, index) => index !== gatePicker?.refIndex)
      .map(gateRefKey),
  );
  const query = gateQuery.trim().toLocaleLowerCase();
  const availableChoices = choices.filter(
    (choice) => !usedKeys.has(choice.key) && (!query || choice.label.toLocaleLowerCase().includes(query)),
  );

  return (
    <div className="population-tree-panel">
      <div className="population-tree-hint">
        {t("Double-click a name to rename · Shift-drag to reorder or reparent · Shift-click a gate to change/remove · + adds a gate")}
      </div>
      {rows}
      {gatePicker && pickerPopulation && (
        <div
          ref={gatePickerRef}
          className="pop-gate-picker"
          role="dialog"
          aria-label={gatePicker.refIndex === null ? t("Add gate") : t("Change gate")}
          style={{ left: gatePicker.left, top: gatePicker.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="pop-gate-picker-title">
            <span>
              {gatePicker.refIndex === null
                ? t("Add gate")
                : t("Change gate: {gate}", {
                    gate: pickerCurrentChoice?.shortLabel ?? t("Unknown gate"),
                  })} · {pickerPopulation.name}
            </span>
            <button type="button" onClick={() => setGatePicker(null)} aria-label={t("Close")}>×</button>
          </div>
          {pickerCurrentChoice && (
            <div className="pop-gate-picker-current">
              <span
                className="pop-gate-picker-swatch"
                style={{ background: pickerCurrentChoice.gate.color }}
              />
              <span><strong>{t("Current gate")}:</strong> {pickerCurrentChoice.shortLabel}</span>
            </div>
          )}
          {gatePicker.refIndex !== null && (
            <button type="button" className="pop-gate-picker-remove" onClick={removePickedGate}>
              {t("Remove this gate from the population")}
            </button>
          )}
          <input
            className="pop-gate-picker-search"
            value={gateQuery}
            autoFocus
            placeholder={t("Find a gate…")}
            aria-label={t("Find a gate")}
            onChange={(event) => setGateQuery(event.target.value)}
          />
          <div className="pop-gate-picker-list">
            {availableChoices.map((choice) => (
              <button
                type="button"
                key={choice.key}
                className={
                  "pop-gate-picker-choice" +
                  (pickerCurrentRef && gateRefKey(pickerCurrentRef) === choice.key ? " current" : "")
                }
                onClick={() => chooseGate(choice)}
              >
                <span className="pop-gate-picker-swatch" style={{ background: choice.gate.color }} />
                <span className="pop-gate-picker-choice-label">{choice.label}</span>
                {pickerCurrentRef && gateRefKey(pickerCurrentRef) === choice.key && (
                  <span className="pop-gate-picker-current-badge">{t("Current")}</span>
                )}
              </button>
            ))}
            {availableChoices.length === 0 && (
              <div className="pop-gate-picker-empty">{t("No available gates match.")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
