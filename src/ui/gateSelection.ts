import type { CoreState } from "../store";

/** What the Gates menu's Delete and the Delete key delete: the highlighted gates (the selected one among them); none while the structure is locked. */
export function gateIdsToDelete(state: CoreState): string[] {
  const locked = state.hierarchies.some(
    (hierarchy) => hierarchy.id === state.active_hierarchy_id && hierarchy.structure_locked === true,
  );
  if (locked) return [];
  if (state.selected_gate_ids.length > 0) return state.selected_gate_ids;
  return state.selected_gate_id ? [state.selected_gate_id] : [];
}

/** The gates highlighted in the gate list: the selected gate, with the others highlighted with it. */
export function highlightedGateIds(state: CoreState): string[] {
  if (state.selected_gate_ids.length > 0) return state.selected_gate_ids;
  return state.selected_gate_id ? [state.selected_gate_id] : [];
}

/**
 * The populations highlighted in the tree, in the tree's order of selection: the active population,
 * with the others highlighted with it. The root is never one: it cannot be duplicated, moved or
 * deleted, and drawing it is drawing everything.
 */
export function highlightedPopIds(state: CoreState): string[] {
  if (state.selected_pop_ids.length > 0) return state.selected_pop_ids;
  const active = state.active_population_id;
  return active && active !== state.root_population_id && state.populations[active] ? [active] : [];
}
