// gatingStates.ts — gating states the user saves by name in the workspace, to return to later:
// the whole gating as it was (every tree with its gates and populations, the groups, and the tree
// and group each file was under), kept in the workspace file under GATING_STATES_FIELD.
//
// A saved state is the gating in the form the workspace file itself keeps it
// (workspaceRecords.ts), and restoring one installs it through the reducer's own loadWorkspace
// on a copy of the state, as one undo entry: what opening a workspace does to the gating, and no
// more. Nothing here evaluates a gate.
//
// Outside src/engine on purpose: it composes exported functions and changes none of them, so the
// engine freeze is not touched. A GateLab without this field ignores it, and drops it if it saves.

import { gateChannelKeys, remapGateChannels } from "./engine/workspaceChannelKeys";
import type { StoredHierarchy } from "./engine/hierarchies";
import type { Gate, PopulationMap } from "./engine/models";
import type { WorkspaceFile } from "./engine/workspace";
import { coreReducer, type CoreState } from "./store";
import { workspaceGatingRecord } from "./workspaceRecords";

/** The top-level workspace JSON field the saved states are written under. */
export const GATING_STATES_FIELD = "gatingStates";

type GatingRecord = WorkspaceFile["gating"];

export interface SavedGatingState {
  id: string;
  name: string;
  /** When it was saved, or last updated from the current gating; an ISO date. */
  savedAt: string;
  /** The gating as the workspace file keeps it, every tree with its own gates. */
  gating: GatingRecord;
  /** The ids of the files loaded when it was saved. */
  files: string[];
  /** File id → the tree it was gated under; a file without an entry was on the first tree. */
  file_hierarchies: Record<string, string>;
  /** File id → its group, for files in a group. */
  file_groups: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const stringMap = (value: unknown): Record<string, string> =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};

/** The current gating as a saved state. A copy: later edits to the gating do not reach it. */
export function captureGatingState(
  state: CoreState,
  loadedFileIds: readonly string[],
  name: string,
  now = new Date(),
  id: string = crypto.randomUUID(),
): SavedGatingState {
  const loaded = new Set(loadedFileIds);
  const ofLoaded = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).filter(([fileId]) => loaded.has(fileId)));
  // Through JSON, as a save and a reopening would take it: a state restored in this session and
  // one restored after reopening the workspace are the same.
  return JSON.parse(JSON.stringify({
    id,
    name,
    savedAt: now.toISOString(),
    gating: workspaceGatingRecord(state),
    files: [...loadedFileIds],
    file_hierarchies: ofLoaded(state.file_hierarchies),
    file_groups: ofLoaded(state.file_groups),
  })) as SavedGatingState;
}

/**
 * The state with `saved` restored, for the reducer's adoptStrategy to install as one undo entry.
 * A file loaded when the state was saved goes back under the tree and into the group it had; a
 * file added since stays where it is while that tree or group is in the saved state, and is
 * otherwise on the first tree; a file removed since is left out.
 */
export function restoredGatingState(state: CoreState, saved: SavedGatingState, loadedFileIds: readonly string[]): CoreState {
  const gating = structuredClone(saved.gating);
  const known = new Set(saved.files);
  const assignments = (then: Record<string, string>, now: Record<string, string>) =>
    Object.fromEntries(loadedFileIds.flatMap((fileId) => {
      const to = known.has(fileId) ? then[fileId] : now[fileId];
      return to ? [[fileId, to]] : [];
    }));
  return coreReducer(state, {
    type: "loadWorkspace",
    gates: gating.gates,
    gate_order: gating.gate_order,
    populations: gating.populations,
    root_population_id: gating.root_population_id,
    active_population_id: gating.active_population_id,
    selected_gate_id: gating.selected_gate_id,
    hierarchies: gating.hierarchies,
    active_hierarchy_id: gating.active_hierarchy_id,
    stored_hierarchies: gating.stored_hierarchies?.map((tree) => ({
      ...tree,
      gates: tree.gates ?? {},
      gate_order: tree.gate_order ?? Object.keys(tree.gates ?? {}),
      selected_pop_ids: [],
    }) as StoredHierarchy),
    // The reducer drops an assignment naming a tree or a group the saved state does not hold.
    file_hierarchies: assignments(saved.file_hierarchies, state.file_hierarchies),
    groups: gating.groups ?? [],
    file_groups: assignments(saved.file_groups, state.file_groups),
  });
}

/** Keys sorted, so two records holding the same values read the same whatever built them. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) => (isRecord(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : entry));

/** What a gating holds, whatever is selected or shown: its trees, groups and file assignments. */
function gatingGraph(state: CoreState, loadedFileIds: readonly string[]): string {
  const record = workspaceGatingRecord(state);
  const tree = (t: { gates?: Record<string, Gate>; gate_order?: string[]; populations: PopulationMap; root_population_id: string | null }) => ({
    gates: t.gates,
    gate_order: t.gate_order,
    // Counts are results, not gating.
    populations: Object.fromEntries(Object.entries(t.populations).map(([id, { event_count: _count, percent_of_parent: _percent, ...population }]) => [id, population])),
    root_population_id: t.root_population_id,
  });
  const loaded = new Set(loadedFileIds);
  const ofLoaded = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).filter(([fileId]) => loaded.has(fileId)));
  return stable({
    hierarchies: record.hierarchies,
    groups: record.groups ?? [],
    trees: {
      ...Object.fromEntries((record.stored_hierarchies ?? []).map((stored) => [stored.id, tree(stored)])),
      [record.active_hierarchy_id ?? ""]: tree(record),
    },
    file_hierarchies: ofLoaded(state.file_hierarchies),
    file_groups: ofLoaded(state.file_groups),
  });
}

/** Whether restoring `saved` would change no gate, population, tree, group or file assignment. */
export function gatingStateIsCurrent(state: CoreState, saved: SavedGatingState, loadedFileIds: readonly string[]): boolean {
  return gatingGraph(state, loadedFileIds) === gatingGraph(restoredGatingState(state, saved, loadedFileIds), loadedFileIds);
}

/** What a saved state holds, for the list: the gates and populations of the tree that was shown, and the trees. */
export function gatingStateSummary(saved: SavedGatingState): { gates: number; populations: number; trees: number } {
  const root = saved.gating.root_population_id;
  return {
    gates: Object.keys(saved.gating.gates).length,
    // The root is every event of the file, not a population the user made.
    populations: Object.keys(saved.gating.populations).filter((id) => id !== root).length,
    trees: saved.gating.hierarchies?.length ?? 1,
  };
}

/** "State 1", "State 2", …: the first not taken. */
export function nextGatingStateName(states: readonly SavedGatingState[]): string {
  const taken = new Set(states.map((saved) => saved.name));
  for (let n = states.length + 1; ; n++) if (!taken.has(`State ${n}`)) return `State ${n}`;
}

/** `name`, or `name 2`, `name 3`, … when another state has it. */
export function uniqueGatingStateName(states: readonly SavedGatingState[], name: string, exceptId?: string): string {
  const taken = new Set(states.filter((saved) => saved.id !== exceptId).map((saved) => saved.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
}

/** The saved states a workspace JSON object holds. One that is not a whole gating is left out; nothing throws. */
export function readGatingStates(workspace: unknown): SavedGatingState[] {
  if (!isRecord(workspace)) return [];
  const raw = workspace[GATING_STATES_FIELD];
  if (!Array.isArray(raw)) return [];
  const out: SavedGatingState[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id || seen.has(entry.id)) continue;
    const gating = entry.gating;
    if (!isRecord(gating) || !isRecord(gating.gates) || !Array.isArray(gating.gate_order) || !isRecord(gating.populations)) continue;
    const root = gating.root_population_id;
    if (typeof root !== "string" || !isRecord(gating.populations[root])) continue;
    const trees = gating.hierarchies;
    if (trees !== undefined && !(Array.isArray(trees) && trees.every((tree) => isRecord(tree) && typeof tree.id === "string"))) continue;
    const stored = gating.stored_hierarchies;
    if (stored !== undefined && !(Array.isArray(stored) && stored.every((tree) => isRecord(tree) && typeof tree.id === "string" && isRecord(tree.gates) && isRecord(tree.populations)))) continue;
    seen.add(entry.id);
    out.push({
      id: entry.id,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name : `State ${out.length + 1}`,
      savedAt: typeof entry.savedAt === "string" ? entry.savedAt : "",
      gating: gating as unknown as GatingRecord,
      files: Array.isArray(entry.files) ? entry.files.filter((fileId): fileId is string => typeof fileId === "string") : [],
      file_hierarchies: stringMap(entry.file_hierarchies),
      file_groups: stringMap(entry.file_groups),
    });
  }
  return out;
}

/** Every channel key the saved states' gates name, for the restating a reopened workspace's own gates get. */
export function gatingStatesChannelKeys(states: readonly SavedGatingState[]): string[] {
  return states.flatMap((saved) => [
    ...gateChannelKeys(saved.gating.gates),
    ...(saved.gating.stored_hierarchies ?? []).flatMap((tree) => [...gateChannelKeys(tree.gates ?? {})]),
  ]);
}

/** The saved states with their gates on the channel keys the files have now (workspaceChannelKeys.ts). */
export function gatingStatesOnChannels(states: readonly SavedGatingState[], remap: ReadonlyMap<string, string>): SavedGatingState[] {
  if (remap.size === 0) return [...states];
  return states.map((saved) => ({
    ...saved,
    gating: {
      ...saved.gating,
      gates: remapGateChannels(saved.gating.gates, remap),
      stored_hierarchies: saved.gating.stored_hierarchies?.map((tree) => (tree.gates ? { ...tree, gates: remapGateChannels(tree.gates, remap) } : tree)),
    },
  }));
}
