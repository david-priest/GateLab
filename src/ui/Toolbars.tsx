// Toolbars.tsx — gate-list and population-tree action toolbars (app.R section-header
// button rows). Gate: sort / rename / undo / redo / clear-select / delete. Population:
// add / rename / clear-select / delete.

import type { CoreState, Action } from "../store";
import { useI18n } from "./i18n";

function Tool({
  label,
  title,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      className={"gl-tool" + (danger ? " danger" : "")}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </button>
  );
}

export function GateToolbar({
  state,
  dispatch,
  onRename,
  onDelete,
}: {
  state: CoreState;
  dispatch: (a: Action) => void;
  onRename: () => void;
  onDelete: (gateIds: string[]) => void;
}) {
  const { t } = useI18n();
  const hasSelected = !!state.selected_gate_id;
  const nChecked = state.selected_gate_ids.length;
  const canDelete = nChecked > 0 || hasSelected;
  const structureLocked = state.hierarchies.some(
    (hierarchy) => hierarchy.id === state.active_hierarchy_id && hierarchy.structure_locked === true,
  );
  return (
    <div className="gl-tools">
      <Tool label="A↓" title={t("Sort gates alphabetically")} onClick={() => dispatch({ type: "sortGatesAlpha" })} disabled={state.gate_order.length < 2} />
      <Tool label="✎" title={structureLocked ? t("Unlock structure to rename gates") : t("Rename selected gate")} onClick={onRename} disabled={!hasSelected || structureLocked} />
      <Tool label="↶" title={t("Undo")} onClick={() => dispatch({ type: "undo" })} disabled={state.undo.length === 0} />
      <Tool label="↷" title={t("Redo")} onClick={() => dispatch({ type: "redo" })} disabled={state.redo.length === 0} />
      <Tool label="✕" title={t("Clear gate selection")} onClick={() => dispatch({ type: "clearGateSelection" })} disabled={nChecked === 0} />
      <Tool
        label="🗑"
        title={structureLocked ? t("Unlock structure to delete gates") : t("Delete checked gates (or selected gate if none checked)")}
        danger
        disabled={!canDelete || structureLocked}
        onClick={() => onDelete(nChecked > 0 ? state.selected_gate_ids : hasSelected ? [state.selected_gate_id!] : [])}
      />
    </div>
  );
}

export function PopToolbar({
  state,
  dispatch,
  onAdd,
  onRename,
  onDelete,
  onDuplicate,
  onBulkRename,
}: {
  state: CoreState;
  dispatch: (a: Action) => void;
  onAdd: () => void;
  onRename: () => void;
  onDelete: (popIds: string[]) => void;
  onDuplicate: (popIds: string[]) => void;
  onBulkRename: () => void;
}) {
  const { t } = useI18n();
  const active = state.active_population_id;
  const canRename = !!active && active !== state.root_population_id;
  const nChecked = state.selected_pop_ids.length;
  const structureLocked = state.hierarchies.some(
    (hierarchy) => hierarchy.id === state.active_hierarchy_id && hierarchy.structure_locked === true,
  );
  return (
    <div className="gl-tools">
      <Tool label="A↓" title={t("Sort populations alphabetically")} onClick={() => dispatch({ type: "sortPopulationsAlpha" })} disabled={Object.keys(state.populations).length < 3} />
      <Tool label="＋" title={structureLocked ? t("Unlock structure to create populations") : t("Create population")} onClick={onAdd} disabled={Object.keys(state.gates).length === 0 || structureLocked} />
      <Tool label="✎" title={structureLocked ? t("Unlock structure to edit populations") : t("Edit active population (name, parent, gates)")} onClick={onRename} disabled={!canRename || structureLocked} />
      <Tool label="⧉" title={structureLocked ? t("Unlock structure to duplicate populations") : t("Duplicate checked populations")} onClick={() => onDuplicate(state.selected_pop_ids)} disabled={nChecked === 0 || structureLocked} />
      <Tool label="⇞" title={structureLocked ? t("Unlock structure to bulk-edit populations") : t("Bulk-edit population names and gate definitions via CSV")} onClick={onBulkRename} disabled={Object.keys(state.populations).length < 2 || structureLocked} />
      <Tool
        label="🗑"
        title={structureLocked ? t("Unlock structure to delete populations") : t("Delete checked populations")}
        danger
        disabled={nChecked === 0 || structureLocked}
        onClick={() => onDelete(state.selected_pop_ids)}
      />
    </div>
  );
}
