// GateList.tsx — the gate list panel, reproduced from GateLabR output$gate_list_ui.
// Cards ordered by gate_order; each has a multi-select checkbox (tracked in
// selected_gate_ids, does not affect selection), colour swatch, name, channels, count.
// Card click → selectGate (gate_list_click). Checkbox → toggleGateSelect.

import type { CoreState, Derived, Action } from "../store";

interface Props {
  state: CoreState;
  derived: Derived;
  dispatch: (a: Action) => void;
  /** Map a channel identity key → its Panel display label (identity if omitted). */
  labelForKey?: (key: string) => string;
}

export function GateList({ state, derived, dispatch, labelForKey = (k) => k }: Props) {
  const { gates, gate_order, selected_gate_id, selected_gate_ids } = state;
  const checked = new Set(selected_gate_ids);
  const ids = gate_order.length ? gate_order : Object.keys(gates);

  if (ids.length === 0) {
    return (
      <div className="gate-list-panel">
        <em style={{ color: "#999", fontSize: 12 }}>No gates. Draw one using the toolbar.</em>
      </div>
    );
  }

  return (
    <div className="gate-list-panel">
      {ids.map((gid) => {
        const gate = gates[gid];
        if (!gate) return null;
        const isSel = gid === selected_gate_id;
        const isQuad = gate.gate_type === "quadrant";
        const counts = derived.gateCounts[gid];
        const countText = isQuad
          ? "4 populations"
          : counts && counts.event_count != null
            ? `${counts.event_count.toLocaleString()} (${counts.percent_of_parent}%)`
            : "";
        const chText = `${labelForKey(gate.x_channel)} / ${labelForKey(gate.y_channel)}${isQuad ? "  · quadrant" : ""}`;
        return (
          <div
            key={gid}
            className={"gate-card" + (isSel ? " selected" : "")}
            onClick={() => dispatch({ type: "selectGate", gateId: gid })}
          >
            <span className="gate-card-select-col">
              <input
                type="checkbox"
                className="gate-card-select"
                checked={checked.has(gid)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) =>
                  dispatch({ type: "toggleGateSelect", gateId: gid, checked: e.target.checked })
                }
              />
            </span>
            <div className="gate-color-swatch" style={{ background: gate.color }} />
            <div className="gate-card-name">{gate.name}</div>
            <div className="gate-card-channels">{chText}</div>
            <div className="gate-card-info">{countText}</div>
          </div>
        );
      })}
    </div>
  );
}
