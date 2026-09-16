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
  /** What the counts were taken over when not the blue file alone, e.g. "pooled · 3 FCS". */
  countScope?: string | null;
  /** Gates of this copy whose geometry differs from the template's: FlowJo's tailored marks. */
  tailoredGateIds?: ReadonlySet<string>;
  /** On a template: the files whose copy has tailored each gate, by the template's gate id. */
  tailoredInFiles?: ReadonlyMap<string, readonly string[]>;
}

export function GateList({ state, derived, dispatch, labelForKey = (k) => k, badgeFor, countScope, tailoredGateIds, tailoredInFiles }: Props) {
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
        const hierarchy = state.hierarchies.find((h) => h.id === state.active_hierarchy_id);
        const sourceId = hierarchy?.source_gate_ids?.[gid];
        const canRevert = hierarchy && (hierarchy.owner_sample_id || hierarchy.owner_group_id) && hierarchy.structure_locked && sourceId &&
          state.stored_hierarchies[hierarchy.source_hierarchy_id ?? ""]?.gates[sourceId];
        const sourceRef = hierarchy?.source_hierarchy_id ? state.hierarchies.find((h) => h.id === hierarchy.source_hierarchy_id) : undefined;
        const applyTarget = sourceRef?.owner_group_id ? sourceRef.name : t("the tree");
        const isSel = gid === selected_gate_id;
        const isQuad = gate.gate_type === "quadrant";
        const counts = derived.gateCounts[gid];
        const countText = isQuad
          ? t("4 populations")
          : counts && counts.event_count != null
            ? `${counts.event_count.toLocaleString()} (${counts.percent_of_parent}%)` +
              (countScope ? ` · ${countScope}` : "")
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
              {(tailoredInFiles?.get(gid)?.length ?? 0) > 0 && (
                <span className="gate-tailored-badge gate-tailored-in" title={tailoredInFiles!.get(gid)!.join(", ")}>
                  {t("tailored in {count} files", { count: tailoredInFiles!.get(gid)!.length })}
                </span>
              )}
              {tailoredGateIds?.has(gid) && (
                <span className="gate-tailored-badge" title={t("Tailored for this file: its coordinates differ from the tree's and no longer follow it")}>
                  {t("tailored")}
                </span>
              )}
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
            <span className="gate-card-actions">
            {tailoredGateIds?.has(gid) && canRevert && (
              <button
                type="button"
                className="gl-mini-btn gate-revert-group"
                aria-label={t("Revert {name} to {target}", { name: gate.name, target: applyTarget })}
                title={t("This gate takes the coordinates it follows again; other tailored gates stay unchanged. Undo is available.")}
                onClick={(event) => { event.stopPropagation(); dispatch({ type: "revertGateToGroup", gateId: gid }); }}
              >
                {t("Revert gate")}
              </button>
            )}
            {tailoredGateIds?.has(gid) && canRevert && (
              <button
                type="button"
                className="gl-mini-btn gate-apply-group"
                aria-label={t("Apply {name} to {target}", { name: gate.name, target: applyTarget })}
                title={t("{target} takes this gate's coordinates, and every file that followed its gate follows the new ones. Undo is available.", { target: applyTarget })}
                onClick={(event) => { event.stopPropagation(); dispatch({ type: "applyGateToGroup", gateId: gid }); }}
              >
                {t("Apply to {target}", { target: applyTarget })}
              </button>
            )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
