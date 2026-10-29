// GateList.tsx — the gate list panel, reproduced from GateLabR output$gate_list_ui.
// Cards ordered by gate_order: colour swatch, name, channels, count. The highlight is the list's one
// selection (David, 2026-10-23; it replaced a column of ticks): a click selects one gate, Shift-click
// the range from the selected gate, Cmd/Ctrl-click adds or removes one, Cmd/Ctrl-A every gate, and
// Escape or a click on empty space goes back to the selected gate alone. The highlighted gates stay
// drawn when the plot shows only the branch's, and are what Delete and Close gaps act on. They are
// the store's selected_gate_ids (with selected_gate_id).

import type { CoreState, Derived, Action } from "../store";
import type { Gate } from "../engine/models";
import type { GateSpaceBadge } from "../engine/gateSpaceBadge";
import { useI18n } from "./i18n";
import { useId, useRef, useState } from "react";
import { StrategyProposalDetails } from "./StrategyProposalDetails";
import { proposalSourceLabel } from "./StrategyProposalReview";
import { provenanceSource } from "../proposals/strategyProposal";
import { BranchIcon, MoreIcon } from "./icons";
import { MenuButton, type MenuEntry } from "./MenuButton";
import { useGateSwatch } from "../plots/gateInk";

/**
 * A gate's tailoring switch for the viewed file. `on` while the file uses a version of its own or
 * its group's; `colour` is the group's when the version, or a pending tailoring, is the group's
 * (blue otherwise). A click asks for `next`: the switch always means this file. The other choices
 * (tailor for the group, revert, use for) are in the row's ⋯ menu, under Tailoring.
 */
export interface TailorSwitch {
  on: boolean;
  next?: boolean;
  colour?: string | null;
  pending?: boolean;
  label: string | null;
  title: string;
}

interface Props {
  state: CoreState;
  derived: Derived;
  dispatch: (a: Action) => void;
  /** Map a channel identity key → its Panel display label (identity if omitted). */
  labelForKey?: (key: string) => string;
  /** Two-letter gating-space badge for a gate; null or omitted shows nothing (CyTOF). */
  badgeFor?: (gate: Gate) => GateSpaceBadge | null;
  /** Whether the badge is shown on the row: only when it is unusual. Otherwise it is in the name's tooltip. All shown when omitted. */
  badgeShown?: (gate: Gate, badge: GateSpaceBadge | null) => boolean;
  /** The population the counts are taken in, named over the count column; no header when null. */
  countHeader?: string | null;
  /** A row's ⋯ menu: its tailoring, Rename and Delete. "Proposed by…" is added here for a proposed gate. */
  rowMenuOf?: (gateId: string) => MenuEntry[];
  /** What the counts were taken over when not the blue file alone, e.g. "pooled · 3 FCS". */
  countScope?: string | null;
  /**
   * A gate's one chip, kept for what the switch cannot say: a group tailoring asked for and not
   * dragged yet (`pending`), or, in a pool, how many other versions are drawn dashed ("+2
   * versions"). Null for none, which is every gate that follows the tree. `menu` says whether a
   * click opens the gate's scope menu.
   */
  scopeChipOf?: (gateId: string) => { label: string; title: string; pending?: boolean; menu: boolean } | null;
  /**
   * A gate's tailoring switch for the viewed file: on while the file holds its own version, with
   * a label ("this file", or "follows Group A" for a version of its group's) and a tooltip.
   */
  tailorSwitchOf?: (gateId: string) => TailorSwitch | null;
  onTailorSwitch?: (gateId: string, on: boolean) => void;
  /** The gate's scope menu (Tailor for…, Revert, Use for…), opened at `client`: from its chip, or a right-click on its row. */
  onScopeMenu?: (gateId: string, client: [number, number]) => void;
}

export function GateList({ state, derived, dispatch, labelForKey = (k) => k, badgeFor, badgeShown, countScope, countHeader, scopeChipOf, tailorSwitchOf, onTailorSwitch, onScopeMenu, rowMenuOf }: Props) {
  const { t } = useI18n();
  const gateSwatch = useGateSwatch();
  const [detailsGateId, setDetailsGateId] = useState<string | null>(null);
  const detailsPanelId = useId();
  /** The row whose proposal details are open: focus goes back to its ⋯ when they close. */
  const detailsRow = useRef<HTMLElement | null>(null);
  const { gates, gate_order, selected_gate_id, selected_gate_ids } = state;
  const ids = gate_order.length ? gate_order : Object.keys(gates);
  /** The highlighted gates: the selected one and the others selected with it. */
  const highlighted = new Set([...(selected_gate_id ? [selected_gate_id] : []), ...selected_gate_ids]);
  const shown = ids.filter((id) => gates[id]);
  const pick = (gid: string, event: React.MouseEvent) => {
    if (event.shiftKey && selected_gate_id && shown.includes(selected_gate_id)) {
      const a = shown.indexOf(selected_gate_id), b = shown.indexOf(gid);
      dispatch({ type: "selectGates", gateId: selected_gate_id, gateIds: shown.slice(Math.min(a, b), Math.max(a, b) + 1) });
    } else if ((event.metaKey || event.ctrlKey) && selected_gate_id && gid !== selected_gate_id) {
      const next = highlighted.has(gid) ? [...highlighted].filter((id) => id !== gid) : [...highlighted, gid];
      dispatch({ type: "selectGates", gateId: selected_gate_id, gateIds: next });
    } else {
      dispatch({ type: "selectGates", gateId: gid, gateIds: [] });
    }
  };

  if (ids.length === 0) {
    return (
      <div className="gate-list-panel">
        <em style={{ display: "block", padding: "6px var(--gl-pane-padding)", color: "#999", fontSize: 12 }}>{t("No gates. Draw one using the toolbar.")}</em>
      </div>
    );
  }

  return (
    <div
      className="gate-list-panel"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (!selected_gate_id || (event.target as Element).closest("input, select, textarea, [role=menu]")) return;
        if (event.key === "Escape" && highlighted.size > 1) {
          event.preventDefault();
          event.stopPropagation();
          dispatch({ type: "selectGates", gateId: selected_gate_id, gateIds: [] });
        } else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "a") {
          event.preventDefault();
          dispatch({ type: "selectGates", gateId: selected_gate_id, gateIds: shown });
        }
      }}
      onClick={(event) => {
        // A click on empty space below the rows goes back to the selected gate alone.
        if (event.target === event.currentTarget && selected_gate_id && highlighted.size > 1) {
          dispatch({ type: "selectGates", gateId: selected_gate_id, gateIds: [] });
        }
      }}
    >
      {countHeader && (
        // Each heading sits in the same column, with the same classes, as the rows' cells, so it
        // lines up with them at every pane width; the ⋯ column holds an invisible ⋯ for its width.
        <div className="gate-list-head" aria-hidden="true">
          {ids.some((gid) => gates[gid] && gateSwatch(gates[gid].color)) && <span className="gate-list-head-swatch" />}
          <span className="gate-card-name gate-list-head-name">{t("Gate")}</span>
          <span className="gate-card-channels">{t("Channels")}</span>
          {/* At the root, just "Events": "Events in All Events" said the same thing twice. */}
          <span className="gate-card-info gate-list-head-count" title={t("Events in {population}", { population: countHeader })}>
            {!state.active_population_id || state.active_population_id === state.root_population_id
              ? t("Events")
              : t("Events in {population}", { population: countHeader })}
          </span>
          {tailorSwitchOf && <span className="gate-tailor-col"><span className="gate-list-head-tailor">{t("Tailoring")}</span></span>}
          <span className="gate-card-menu gate-list-head-menu">
            <span className="gl-menu-trigger gl-menu-trigger-icon"><MoreIcon /></span>
          </span>
        </div>
      )}
      {ids.map((gid) => {
        const gate = gates[gid];
        if (!gate) return null;
        const chip = scopeChipOf?.(gid) ?? null;
        const tailorSwitch = tailorSwitchOf?.(gid) ?? null;
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
        // Which space this gate lives in: on the row only when unusual; always in the name's tooltip.
        const badge = badgeFor?.(gate) ?? null;
        const showBadge = !!badge && (badgeShown ? badgeShown(gate, badge) : true);
        const proposal = gate.provenance;
        const rowMenu: MenuEntry[] = [
          ...(rowMenuOf?.(gid) ?? []),
          ...(proposal
            ? [
                ...(rowMenuOf ? ["separator" as const] : []),
                {
                  label: t("Proposed by {source}…", { source: t(proposalSourceLabel(provenanceSource(proposal))) }),
                  className: "gate-proposal-item",
                  title: t("Proposed by {by}: {rationale}", { by: proposal.by, rationale: proposal.rationale }),
                  onClick: () => setDetailsGateId(detailsGateId === gid ? null : gid),
                },
              ]
            : []),
        ];
        return (
          <div
            key={gid}
            ref={detailsGateId === gid ? (el) => { detailsRow.current = el; } : undefined}
            className={"gate-card" + (isSel ? " selected" : highlighted.has(gid) ? " highlighted" : "")}
            onClick={(event) => { pick(gid, event); event.currentTarget.parentElement?.focus({ preventScroll: true }); }}
            onContextMenu={onScopeMenu ? (event) => { event.preventDefault(); onScopeMenu(gid, [event.clientX, event.clientY]); } : undefined}
          >
            {gateSwatch(gate.color) && <div className="gate-color-swatch" style={{ background: gateSwatch(gate.color)! }} />}
            {/* The channels are in the tooltip too: a narrow pane drops their column (styles.css). */}
            <div className="gate-card-name" title={`${gate.name}\n${chText}${badge && !showBadge ? `\n${badge.text} · ${badge.hint}` : ""}`}>
              {gate.name}
              {chip && (
                <button
                  type="button"
                  className={"gate-scope-chip" + (chip.pending ? " is-pending" : "")}
                  title={chip.title}
                  aria-label={t("{name}: {scope}", { name: gate.name, scope: chip.label })}
                  aria-haspopup={chip.menu ? "menu" : undefined}
                  disabled={!chip.menu}
                  onClick={(event) => {
                    event.stopPropagation();
                    const box = event.currentTarget.getBoundingClientRect();
                    onScopeMenu?.(gid, [box.left, box.bottom + 2]);
                  }}
                >
                  <BranchIcon size={10} />
                  {chip.label}
                </button>
              )}
              {showBadge && badge && (
                <span className="gate-space-badge" title={badge.hint}>{badge.text}</span>
              )}
            </div>
            <div className="gate-card-channels">{chText}</div>
            <div className="gate-card-info">{countText}</div>
            {/* The switch has its own column at the same x on every row, its label truncated in a
                fixed width after it, so neither the name before it nor the label changes the row. */}
            {tailorSwitchOf && (
              <span className="gate-tailor-col">
                {tailorSwitch && (
                  <label
                    className={"gate-tailor-switch" + (tailorSwitch.on ? " is-on" : "") + (tailorSwitch.pending ? " is-pending" : "") + (tailorSwitch.colour ? " is-group" : "")}
                    style={tailorSwitch.colour ? ({ "--gl-switch-on": tailorSwitch.colour } as React.CSSProperties) : undefined}
                    title={tailorSwitch.title}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      role="switch"
                      checked={tailorSwitch.on}
                      aria-label={tailorSwitch.title}
                      onChange={(event) => onTailorSwitch?.(gid, tailorSwitch.next ?? event.target.checked)}
                    />
                    <span className="gate-tailor-switch-track" aria-hidden="true" />
                    {tailorSwitch.label && <span className="gate-tailor-switch-label" title={tailorSwitch.label}>{tailorSwitch.label}</span>}
                  </label>
                )}
              </span>
            )}
            {rowMenu.length > 0 && (
              <span className="gate-card-menu" onClick={(event) => event.stopPropagation()}>
                <MenuButton
                  label={proposal ? t("{name}: actions; it was proposed", { name: gate.name }) : t("{name}: actions", { name: gate.name })}
                  items={rowMenu}
                  icon={<MoreIcon />}
                  className={"gate-row-menu" + (proposal ? " has-proposal" : "")}
                />
              </span>
            )}
          </div>
        );
      })}
      {detailsGateId && gates[detailsGateId]?.provenance && (
        <StrategyProposalDetails key={detailsGateId} id={detailsPanelId} gate={gates[detailsGateId]} state={state}
          labelForKey={labelForKey} countScope={countScope}
          onClose={() => { setDetailsGateId(null); detailsRow.current?.querySelector<HTMLButtonElement>(".gate-row-menu .gl-menu-trigger")?.focus(); }} />
      )}
    </div>
  );
}
