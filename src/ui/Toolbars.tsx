// Toolbars.tsx — gate-list and population-tree action toolbars (app.R section-header
// button rows). Gate: sort / rename / undo / redo / clear-select / delete. Population:
// add / rename / clear-select / delete.

import type { CoreState, Action } from "../store";

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
  const hasSelected = !!state.selected_gate_id;
  const nChecked = state.selected_gate_ids.length;
  const canDelete = nChecked > 0 || hasSelected;
  return (
    <div className="gl-tools">
      <Tool label="A↓" title="Sort gates alphabetically" onClick={() => dispatch({ type: "sortGatesAlpha" })} disabled={state.gate_order.length < 2} />
      <Tool label="✎" title="Rename selected gate" onClick={onRename} disabled={!hasSelected} />
      <Tool label="↶" title="Undo" onClick={() => dispatch({ type: "undo" })} disabled={state.undo.length === 0} />
      <Tool label="↷" title="Redo" onClick={() => dispatch({ type: "redo" })} disabled={state.redo.length === 0} />
      <Tool label="✕" title="Clear gate selection" onClick={() => dispatch({ type: "clearGateSelection" })} disabled={nChecked === 0} />
      <Tool
        label="🗑"
        title="Delete checked gates (or selected gate if none checked)"
        danger
        disabled={!canDelete}
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
  onMove,
  onBulkRename,
}: {
  state: CoreState;
  dispatch: (a: Action) => void;
  onAdd: () => void;
  onRename: () => void;
  onDelete: (popIds: string[]) => void;
  onDuplicate: (popIds: string[]) => void;
  onMove: (popIds: string[]) => void;
  onBulkRename: () => void;
}) {
  const active = state.active_population_id;
  const canRename = !!active && active !== state.root_population_id;
  const nChecked = state.selected_pop_ids.length;
  return (
    <div className="gl-tools">
      <Tool label="＋" title="Create population" onClick={onAdd} disabled={Object.keys(state.gates).length === 0} />
      <Tool label="✎" title="Edit active population (name, parent, gates)" onClick={onRename} disabled={!canRename} />
      <Tool label="⧉" title="Duplicate checked populations" onClick={() => onDuplicate(state.selected_pop_ids)} disabled={nChecked === 0} />
      <Tool label="⇄" title="Move checked populations to a new parent" onClick={() => onMove(state.selected_pop_ids)} disabled={nChecked === 0} />
      <Tool label="⇞" title="Bulk-rename populations via CSV (upload / template)" onClick={onBulkRename} disabled={Object.keys(state.populations).length < 2} />
      <Tool label="✕" title="Clear population selection" onClick={() => dispatch({ type: "clearPopSelection" })} disabled={nChecked === 0} />
      <Tool
        label="🗑"
        title="Delete checked populations"
        danger
        disabled={nChecked === 0}
        onClick={() => onDelete(state.selected_pop_ids)}
      />
    </div>
  );
}
