// PopulationTree.tsx — reproduced from GateLabR output$population_tree_ui.
// Recursive rows with SVG ├/└ tree connectors (make_tree_connectors), multi-select
// checkbox (selected_pop_ids), gate-ref badges (coloured by gate, "-name" when excluded,
// .selected-gate ring when that gate is selected), count and "% pnt, % tot".
// Row click → setActivePopulation (pop_tree_click) + focus the container for arrow nav.
// The blue highlight is the move selection: a click highlights one row (the active population),
// Shift-click highlights the range from the active row to the clicked one, Cmd/Ctrl-click adds or
// removes a row, and Shift-drag moves every highlighted row together. The checkboxes are separate:
// they pool the display and feed the toolbar's duplicate / move / delete actions.

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CoreState, Derived, Action } from "../store";
import { wouldCreateCycle, type Gate, type GateRef } from "../engine/models";
import { TreeConnectors } from "./TreeConnectors";
import { useI18n } from "./i18n";
import { gateRefLabel, EXCLUDE_HINT } from "./gateRefLabel";

export type HierarchyMenuAction = "new" | "duplicate" | "rename" | "delete";

interface Props {
  state: CoreState;
  derived: Derived;
  dispatch: (a: Action) => void;
  /** The hierarchy menu's actions that need a dialog; switching is dispatched directly. */
  onHierarchyAction?: (action: HierarchyMenuAction) => void;
  statsPending?: boolean;
  statsSampleCount?: number;
  displayContributorCount?: number;
  displayContributorNames?: readonly string[];
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
  /** The rows being moved: the dragged row, or every checked row when it is checked. */
  popIds: string[];
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
  /** Pending NOT state for the reference being added or changed. */
  exclude: boolean;
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

export function PopulationTree({
  state,
  derived,
  dispatch,
  statsPending = false,
  statsSampleCount = 1,
  displayContributorCount,
  displayContributorNames,
  onHierarchyAction,
}: Props) {
  const { t } = useI18n();
  const { populations, root_population_id, active_population_id, selected_gate_id, selected_pop_ids, gates } = state;
  const stats = derived.stats;
  const checkedPops = new Set(selected_pop_ids);
  const choices = useMemo(() => gateChoices(state), [state.gate_order, state.gates]);
  const [editingName, setEditingName] = useState<{ popId: string; value: string } | null>(null);
  const [draggingPopIds, setDraggingPopIds] = useState<readonly string[]>([]);
  /** Rows highlighted besides the active population; cleared whenever the active row changes. */
  const [extraHighlight, setExtraHighlight] = useState<readonly string[]>([]);
  useEffect(() => {
    setExtraHighlight((ids) => (ids.length ? [] : ids));
  }, [active_population_id]);
  const highlighted = new Set<string>(
    [active_population_id, ...extraHighlight].filter((id): id is string => !!id && !!populations[id]),
  );
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
    const closeOnViewportChange = (event: Event) => {
      // The gate catalogue owns its scroll position. Only scrolling elsewhere in the app should
      // dismiss the fixed-position picker.
      if (
        event.type === "scroll" &&
        event.target instanceof Node &&
        gatePickerRef.current?.contains(event.target)
      ) return;
      setGatePicker(null);
    };
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
  /** Every rendered row in display order; filled by the walk below, read by the handlers. */
  const orderedPopIds: string[] = [];

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
    const existing =
      refIndex === null ? null : populations[popId]?.gate_refs[refIndex] ?? null;
    setGatePicker({
      popId,
      refIndex,
      exclude: existing ? !existing.include : false,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)),
    });
  };

  const chooseGate = (choice: GateChoice) => {
    if (!gatePicker) return;
    const population = populations[gatePicker.popId];
    if (!population) return;
    const gateRefs = population.gate_refs.map((ref) => ({ ...ref }));
    const picked = { ...choice.gateRef, include: !gatePicker.exclude };
    if (gatePicker.refIndex === null) gateRefs.push(picked);
    else if (gatePicker.refIndex >= 0 && gatePicker.refIndex < gateRefs.length) {
      gateRefs[gatePicker.refIndex] = picked;
    } else {
      return;
    }
    dispatch({ type: "setPopulationGateRefs", popId: gatePicker.popId, gateRefs });
    setGatePicker(null);
  };

  const setPickerExclude = (exclude: boolean) => {
    if (!gatePicker) return;
    setGatePicker({ ...gatePicker, exclude });
    if (gatePicker.refIndex === null) return; // adding: applied when a gate is chosen
    const population = populations[gatePicker.popId];
    const current = population?.gate_refs[gatePicker.refIndex];
    if (!population || !current) return;
    const gateRefs = population.gate_refs.map((ref, index) =>
      index === gatePicker.refIndex ? { ...ref, include: !exclude } : { ...ref },
    );
    dispatch({ type: "setPopulationGateRefs", popId: gatePicker.popId, gateRefs });
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
    sourceIds: readonly string[],
    targetId: string,
    placement: DropPlacement,
  ): boolean => {
    if (!sourceIds.length || !populations[targetId]) return false;
    const destinationParentId =
      placement === "inside" ? targetId : populations[targetId].parent_id;
    if (!destinationParentId || !populations[destinationParentId]) return false;
    return sourceIds.every(
      (sourceId) =>
        sourceId !== root_population_id &&
        sourceId !== targetId &&
        !!populations[sourceId] &&
        !wouldCreateCycle(populations, sourceId, destinationParentId),
    );
  };

  /** The rows a drag starting on `popId` carries: the highlighted rows when it is one of them. */
  const dragSetFor = (popId: string): string[] => {
    if (!highlighted.has(popId)) return [popId];
    const ids = orderedPopIds.filter((id) => highlighted.has(id) && id !== root_population_id);
    return ids.length ? ids : [popId];
  };

  const resetPointerDrag = (row: HTMLDivElement, pointerId: number): void => {
    if (row.hasPointerCapture?.(pointerId)) row.releasePointerCapture(pointerId);
    pointerDragRef.current = null;
    setDraggingPopIds([]);
    setDropTarget(null);
  };

  /**
   * Highlight the rows from the active population to `popId`, in the order the tree shows,
   * replacing the previous range so a shorter one un-highlights.
   */
  const highlightRangeTo = (popId: string): void => {
    const anchor = active_population_id && orderedPopIds.includes(active_population_id) ? active_population_id : popId;
    const a = orderedPopIds.indexOf(anchor);
    const b = orderedPopIds.indexOf(popId);
    if (a < 0 || b < 0) return;
    if (!active_population_id || anchor !== active_population_id) dispatch({ type: "setActivePopulation", popId: anchor });
    setExtraHighlight(
      orderedPopIds.slice(Math.min(a, b), Math.max(a, b) + 1).filter((id) => id !== root_population_id && id !== anchor),
    );
  };

  /** Add or remove one row from the highlight; the active row itself stays highlighted. */
  const toggleHighlight = (popId: string): void => {
    if (popId === active_population_id) return;
    setExtraHighlight((ids) => (ids.includes(popId) ? ids.filter((id) => id !== popId) : [...ids, popId]));
  };

  const updatePointerDropTarget = (
    sourceIds: readonly string[],
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
      valid: validDrop(sourceIds, targetId, placement),
    };
  };

  const appendRows = (popId: string, depth: number, isLastPath: boolean[]) => {
    if (visited.has(popId)) return;
    visited.add(popId);
    const pop = populations[popId];
    if (!pop) return;
    orderedPopIds.push(popId);

    const isActive = popId === active_population_id;
    const isRoot = popId === root_population_id;
    const countVal = stats.event_count[popId] ?? pop.event_count;
    const pctParent = stats.percent_of_parent[popId] ?? pop.percent_of_parent;
    const pctTotal = stats.percent_of_total[popId];
    const countText = statsPending
      ? "…"
      : countVal != null
        ? countVal.toLocaleString()
        : "?";
    let pctText = "";
    if (!isRoot && !statsPending) {
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
          (isActive ? " active" : highlighted.has(popId) ? " highlighted" : "") +
          (draggingPopIds.includes(popId) ? " dragging" : "") +
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
          const target = event.target instanceof Element ? event.target : null;
          const onControl = !!target?.closest("button, input, .pop-tree-gate-badge");
          if (!isRoot && !onControl && event.shiftKey) {
            highlightRangeTo(popId);
            focusTreeContainer();
            return;
          }
          if (!isRoot && !onControl && (event.metaKey || event.ctrlKey)) {
            toggleHighlight(popId);
            focusTreeContainer();
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
            popIds: dragSetFor(popId),
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
            setDraggingPopIds(drag.popIds);
          }
          event.preventDefault();
          const nextTarget = updatePointerDropTarget(drag.popIds, event.clientX, event.clientY);
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
            dispatch(
              drag.popIds.length === 1
                ? { type: "movePopulation", popId: drag.popIds[0], targetId: drag.dropTarget.popId, placement: drag.dropTarget.placement }
                : { type: "movePopulations", popIds: drag.popIds, targetId: drag.dropTarget.popId, placement: drag.dropTarget.placement },
            );
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
                  title={t("Click to select; Shift-click to change, exclude (NOT), or remove")}
                >
                  {gateRefLabel(gate.name, ref.include, ref.quadrant)}
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
  const checkable = Object.keys(populations).filter((id) => id !== root_population_id);

  const hierarchies = state.hierarchies ?? [];
  const activeHierarchyId = state.active_hierarchy_id ?? hierarchies[0]?.id ?? "";

  return (
    <div className="population-tree-panel">
      <div className="population-tree-hierarchy">
        <span title={t("Every hierarchy shares the same gates; only the populations differ. Switch here, or create another for a second layout over the same gates.")}>
          {t("Hierarchy")}
        </span>
        <select
          aria-label={t("Hierarchy")}
          value={activeHierarchyId}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("__")) onHierarchyAction?.(v.slice(2) as HierarchyMenuAction);
            else if (v !== activeHierarchyId) dispatch({ type: "switchHierarchy", id: v });
          }}
        >
          {hierarchies.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          <optgroup label={t("Actions")}>
            <option value="__new">{t("New empty hierarchy…")}</option>
            <option value="__duplicate">{t("Duplicate this hierarchy…")}</option>
            <option value="__rename">{t("Rename this hierarchy…")}</option>
            <option value="__delete" disabled={hierarchies.length < 2}>{t("Delete this hierarchy…")}</option>
          </optgroup>
        </select>
        {hierarchies.length > 1 && (
          <span className="population-tree-hierarchy-count">{t("{n} of {total}", { n: hierarchies.findIndex((h) => h.id === activeHierarchyId) + 1, total: hierarchies.length })}</span>
        )}
      </div>
      <div className="population-tree-hint">
        <span>
          {t("Double-click a name to rename · Shift-click to highlight a range, Cmd/Ctrl-click to add or remove a row · Shift-drag to move the highlighted rows · Shift-click a gate to change/remove · + adds a gate")}
        </span>
        {checkable.length > 0 && (
          <span className="gl-sample-inclusion-actions population-tree-check-actions" aria-label={t("Checked populations")}>
            <button
              type="button"
              title={t("Check every population")}
              disabled={selected_pop_ids.length === checkable.length}
              onClick={() => dispatch({ type: "setPopSelection", popIds: checkable })}
            >
              {t("All")}
            </button>
            <button
              type="button"
              title={t("Uncheck every population")}
              disabled={selected_pop_ids.length === 0}
              onClick={() => dispatch({ type: "clearPopSelection" })}
            >
              {t("None")}
            </button>
          </span>
        )}
        {statsSampleCount > 1 && (
          <strong
            title={
              displayContributorNames
                ? t("Selected display contributors: {files}", {
                    files: displayContributorNames.length
                      ? displayContributorNames.join(", ")
                      : t("None"),
                  })
                : undefined
            }
          >
            {statsPending
              ? t("Pooling {count} checked FCS…", { count: statsSampleCount })
              : displayContributorCount === undefined
                ? t("Counts pooled across {count} checked FCS", { count: statsSampleCount })
                : t("Pooled counts: {count} FCS · selected display: {contributing} contribute", {
                    count: statsSampleCount,
                    contributing: displayContributorCount,
                  })}
          </strong>
        )}
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
          <label className="pop-gate-picker-not" title={t(EXCLUDE_HINT)}>
            <input
              type="checkbox"
              checked={gatePicker.exclude}
              onChange={(event) => setPickerExclude(event.target.checked)}
            />
            <span>
              <strong>{t("NOT")}</strong> — {t("keep events outside this gate")}
            </span>
          </label>
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
