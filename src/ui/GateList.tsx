// GateList.tsx — the gate list panel, reproduced from GateLabR output$gate_list_ui.
// Cards ordered by gate_order; each has a multi-select checkbox (tracked in
// selected_gate_ids, does not affect selection), colour swatch, name, channels, count.
// Card click → selectGate (gate_list_click). Checkbox → toggleGateSelect.

import type { CoreState, Derived, Action } from "../store";
import type { Gate } from "../engine/models";
import type { GateSpaceBadge } from "../engine/gateSpaceBadge";
import { useI18n } from "./i18n";

interface Props {
  state: CoreState;
  derived: Derived;
  dispatch: (a: Action) => void;
  /** Map a channel identity key → its Panel display label (identity if omitted). */
  labelForKey?: (key: string) => string;
  /** Two-letter gating-space badge for a gate; null or omitted shows nothing (CyTOF). */
  badgeFor?: (gate: Gate) => GateSpaceBadge | null;
}

export function GateList({ state, derived, dispatch, labelForKey = (k) => k, badgeFor }: Props) {
  const { t } = useI18n();
  const { gates, gate_order, selected_gate_id, selected_gate_ids } = state;
  const checked = new Set(selected_gate_ids);
  const ids = gate_order.length ? gate_order : Object.keys(gates);

  if (ids.length === 0) {
    return (
      <div className="gate-list-panel">
        <em style={{ color: "#999", fontSize: 12 }}>{t("No gates. Draw one using the toolbar.")}</em>
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
          ? t("4 populations")
          : counts && counts.event_count != null
            ? `${counts.event_count.toLocaleString()} (${counts.percent_of_parent}%)`
            : "";
        const chText = `${labelForKey(gate.x_channel)} / ${labelForKey(gate.y_channel)}${isQuad ? `  · ${t("quadrant")}` : ""}`;
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
            <div className="gate-card-name">
              {gate.name}
              {(() => {
                // Which space this gate lives in, beside its name — a raw and a display gate are
                // otherwise indistinguishable in this list.
                const badge = badgeFor?.(gate);
                return badge ? (
                  <span
                    title={badge.hint}
                    style={{
                      marginLeft: 6, fontSize: 9, letterSpacing: "0.09em", opacity: 0.65,
                      border: "1px solid currentColor", borderRadius: 3, padding: "0 3px",
                      verticalAlign: "middle", whiteSpace: "nowrap",
                    }}
                  >
                    {badge.text}
                  </span>
                ) : null;
              })()}
            </div>
            <div className="gate-card-channels">{chText}</div>
            <div className="gate-card-info">{countText}</div>
          </div>
        );
      })}
    </div>
  );
}
