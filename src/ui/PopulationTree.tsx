// PopulationTree.tsx — reproduced from GateLabR output$population_tree_ui.
// Recursive rows with SVG ├/└ tree connectors (make_tree_connectors), multi-select
// checkbox (selected_pop_ids), gate-ref badges (coloured by gate, "-name" when excluded,
// .selected-gate ring when that gate is selected), count and "% pnt, % tot".
// Row click → setActivePopulation (pop_tree_click) + focus the container for arrow nav.

import React from "react";
import type { CoreState, Derived, Action } from "../store";
import { TreeConnectors } from "./TreeConnectors";

interface Props {
  state: CoreState;
  derived: Derived;
  dispatch: (a: Action) => void;
}

function focusTreeContainer() {
  const c = document.getElementById("population_tree_container");
  if (c) c.focus({ preventScroll: true });
}

export function PopulationTree({ state, derived, dispatch }: Props) {
  const { populations, root_population_id, active_population_id, selected_gate_id, selected_pop_ids, gates } = state;
  const stats = derived.stats;
  const checkedPops = new Set(selected_pop_ids);

  if (!root_population_id || Object.keys(populations).length === 0) {
    return (
      <div className="population-tree-panel">
        <em style={{ color: "#999", fontSize: 12 }}>No data loaded.</em>
      </div>
    );
  }

  const rows: React.ReactNode[] = [];
  const visited = new Set<string>();

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
        className={"pop-row" + (isActive ? " active" : "")}
        data-pop-id={popId}
        onClick={() => {
          dispatch({ type: "setActivePopulation", popId });
          focusTreeContainer();
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
          <span className="pop-row-name">{pop.name}</span>
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
                    dispatch({ type: "selectGate", gateId: ref.gate_id });
                  }}
                >
                  {ref.include ? gate.name : `-${gate.name}`}
                </span>
              );
            })}
          </span>
        </span>
        <span className="pop-row-count">{countText}</span>
        <span className="pop-row-pct">{pctText}</span>
      </div>,
    );

    let childIds = [...new Set(pop.children)].filter((c) => c in populations);
    if (childIds.length > 1) {
      childIds = childIds.sort((a, b) => {
        const na = (populations[a].name || a).toLowerCase();
        const nb = (populations[b].name || b).toLowerCase();
        return na < nb ? -1 : na > nb ? 1 : a < b ? -1 : a > b ? 1 : 0;
      });
    }
    childIds.forEach((cid, i) => appendRows(cid, depth + 1, [...isLastPath, i === childIds.length - 1]));
  };

  appendRows(root_population_id, 0, []);

  return <div className="population-tree-panel">{rows}</div>;
}
