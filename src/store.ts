// store.ts — gate/population state (a useReducer core) + derived-stats recompute.
// Mirrors GateLabR's rv$ reactive values and the app.R handlers:
//   gate_list_click → selected_gate_id ; pop_tree_click → active_population_id
//   *_toggle_select → selected_gate_ids / selected_pop_ids (no re-render / scroll reset)
// Counts/percentages come from applyGatingStrategy (gate_engine.R) on gating-space data.

import {
  newGate,
  newQuadrantGate,
  newGateRef,
  newPopulation,
  newRootPopulation,
  linkChildToParent,
  sortPopulationTree,
  sortPopulationTreeAlpha,
  nextGateColor,
  removePopulationReparentChildren,
  wouldCreateCycle,
  type Gate,
  type GateRef,
  type PopulationMap,
  type Vertex,
  type GateSpace,
  type GateTransforms,
  type QuadrantCurl,
} from "./engine/models";
import {
  applyGatingStrategy,
  computeGateCounts,
  computeGateMasks,
  createGateMaskMemo,
  pickPopColorSlot,
  ensurePopColorSlots,
  type GateMaskMemo,
  type MaskMap,
  type GateCount,
  type GateMaskCache,
} from "./engine/populations";
import { mergeGatingStrategies, type GatingImportMode } from "./engine/gatingMerge";
import { populationTreeOrder } from "./engine/populations";
import { DEFAULT_HIERARCHY_ID, DEFAULT_HIERARCHY_NAME, storeHierarchy, selectionAcrossHierarchies, correspondingHierarchyId, type HierarchyRef, type StoredHierarchy, isCopyRef, fileHierarchyId, cloneHierarchyTree, newHierarchyId } from "./engine/hierarchies";
import { syncLockedCopy, gateGeometryEquals, copyInStep, withGeometryOf, type TemplateTree } from "./engine/templateSync";
import type { Sample } from "./engine/sample";

export interface CoreState {
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string | null;
  active_population_id: string | null;
  selected_gate_id: string | null;
  selected_pop_ids: string[];
  selected_gate_ids: string[];
  gate_version: number;
  /** Persisted population names/order changed without changing any event memberships. */
  tree_version: number;
  /**
   * Every population hierarchy in menu order. The active one's tree is the live
   * `populations` / `root_population_id` / `active_population_id` / `selected_pop_ids`; the
   * others are parked in `stored_hierarchies`. Every hierarchy owns its gate table.
   */
  hierarchies: HierarchyRef[];
  active_hierarchy_id: string;
  stored_hierarchies: Record<string, StoredHierarchy>;
  /**
   * Which tree each file is gated under, by file id. A file with no entry, or one naming a tree
   * that no longer exists, is gated under the first hierarchy. Kept here rather than beside the
   * sample list so that Undo restores it together with the copies it points at.
   */
  file_hierarchies: Record<string, string>;
  /** Named sets of files, each with a working tree of its own between the tree and the files. */
  groups: WorkspaceGroup[];
  /** File id → group id, for files in a group. */
  file_groups: Record<string, string>;
  undo: Snapshot[];
  redo: Snapshot[];
}

export interface WorkspaceGroup {
  id: string;
  name: string;
}

interface Snapshot {
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string | null;
  active_population_id: string | null;
  selected_gate_id: string | null;
  selected_gate_ids: string[];
  selected_pop_ids: string[];
  hierarchies: HierarchyRef[];
  active_hierarchy_id: string;
  stored_hierarchies: Record<string, StoredHierarchy>;
  file_hierarchies: Record<string, string>;
  /** Named sets of files, each with a working tree of its own between the tree and the files. */
  groups: WorkspaceGroup[];
  /** File id → group id, for files in a group. */
  file_groups: Record<string, string>;
  /** Whether moving between this snapshot and the adjacent history state changes memberships. */
  affects_gating: boolean;
}

const MAX_UNDO = 20;

export function initialCoreState(): CoreState {
  return {
    gates: {},
    gate_order: [],
    populations: {},
    root_population_id: null,
    active_population_id: null,
    selected_gate_id: null,
    selected_pop_ids: [],
    selected_gate_ids: [],
    gate_version: 0,
    tree_version: 0,
    hierarchies: [{ id: DEFAULT_HIERARCHY_ID, name: DEFAULT_HIERARCHY_NAME }],
    active_hierarchy_id: DEFAULT_HIERARCHY_ID,
    stored_hierarchies: {},
    file_hierarchies: {},
    groups: [],
    file_groups: {},
    undo: [],
    redo: [],
  };
}

/** Only assignments that name a listed hierarchy mean anything; the rest read as unassigned. */
function knownAssignments(assignments: Record<string, string>, hierarchies: readonly HierarchyRef[]): Record<string, string> {
  const known = new Set(hierarchies.map((h) => h.id));
  return Object.fromEntries(Object.entries(assignments).filter(([, id]) => known.has(id)));
}

/** `after`, built from `before` through several steps, recorded as one undo entry. */
function withOneUndoEntry(before: CoreState, after: CoreState): CoreState {
  return {
    ...after,
    ...pushUndo(before),
    gate_version: Math.max(after.gate_version, before.gate_version + 1),
  };
}

function snapshot(s: CoreState, affectsGating = true): Snapshot {
  return {
    gates: s.gates,
    gate_order: s.gate_order,
    populations: s.populations,
    root_population_id: s.root_population_id,
    active_population_id: s.active_population_id,
    selected_gate_id: s.selected_gate_id,
    selected_gate_ids: s.selected_gate_ids,
    selected_pop_ids: s.selected_pop_ids,
    hierarchies: s.hierarchies,
    active_hierarchy_id: s.active_hierarchy_id,
    stored_hierarchies: s.stored_hierarchies,
    file_hierarchies: s.file_hierarchies,
    groups: s.groups,
    file_groups: s.file_groups,
    affects_gating: affectsGating,
  };
}

/** The active hierarchy as a stored record, for parking it before another becomes live. */
function parkActiveHierarchy(s: CoreState): StoredHierarchy {
  const ref = s.hierarchies.find((h) => h.id === s.active_hierarchy_id) ?? { id: s.active_hierarchy_id, name: DEFAULT_HIERARCHY_NAME };
  return storeHierarchy(ref, s);
}

/** The same hierarchy with no owner, lock or source: a tree of its own. */
function unlinkedRef<T extends HierarchyRef>(hierarchy: T): T {
  const { owner_sample_id: _o, owner_group_id: _og, structure_locked: _l, source_hierarchy_id: _s, source_gate_ids: _g, source_population_ids: _p, ...rest } = hierarchy;
  void _o; void _og; void _l; void _s; void _g; void _p;
  return rest as T;
}

function hierarchyRefFromStored(hierarchy: StoredHierarchy): HierarchyRef {
  return {
    id: hierarchy.id,
    name: hierarchy.name,
    ...(hierarchy.owner_sample_id ? { owner_sample_id: hierarchy.owner_sample_id } : {}),
    ...(hierarchy.owner_group_id ? { owner_group_id: hierarchy.owner_group_id } : {}),
    ...(hierarchy.structure_locked !== undefined ? { structure_locked: hierarchy.structure_locked } : {}),
    ...(hierarchy.source_hierarchy_id ? { source_hierarchy_id: hierarchy.source_hierarchy_id } : {}),
    ...(hierarchy.source_gate_ids ? { source_gate_ids: { ...hierarchy.source_gate_ids } } : {}),
    ...(hierarchy.source_population_ids ? { source_population_ids: { ...hierarchy.source_population_ids } } : {}),
  };
}

/** Push an undo snapshot, clear redo (call before a structural change). */
function pushUndo(s: CoreState, affectsGating = true): Pick<CoreState, "undo" | "redo"> {
  return { undo: [snapshot(s, affectsGating), ...s.undo].slice(0, MAX_UNDO), redo: [] };
}

export type Action =
  | { type: "newWorkspace" }
  | { type: "loadSample"; nEvents: number }
  /** Every gate, population and hierarchy goes, as one undo entry; the files stay. */
  | { type: "clearGating"; nEvents: number }
  | {
      type: "addGate";
      gateType: "polygon" | "rectangle";
      xChannel: string;
      yChannel: string;
      /** vertices already in the gate's own space (see `space`) */
      vertices: Vertex[];
      labelOffset?: [number, number];
      name: string;
      createPop?: { name: string; parentId: string };
      /** Coordinate space the vertices are straight in; omitted = the sample's legacy default. */
      space?: GateSpace;
      /** Transform each axis was drawn under. Required when `space` is "display". */
      transforms?: GateTransforms;
    }
  | {
      type: "addEllipse";
      xChannel: string;
      yChannel: string;
      /** Centre and per-axis radii, already in the gate's own space (see `space`). */
      mean: [number, number];
      radii: [number, number];
      labelOffset?: [number, number];
      name: string;
      createPop?: { name: string; parentId: string };
      space?: GateSpace;
      transforms?: GateTransforms;
    }
  | {
      type: "addQuadrant";
      xChannel: string;
      yChannel: string;
      /** center already in the gate's own space (see `space`) */
      center: [number, number];
      prefix: string;
      parentId: string;
      space?: GateSpace;
      transforms?: GateTransforms;
      /** Bent arms beyond the crosshair; absent for a straight one. */
      curl?: QuadrantCurl;
      /** Short axis labels for the four population names, e.g. the marker rather than "Marker (Detector)". */
      xLabel?: string;
      yLabel?: string;
      /** The four population names in quadrant order, Q1 to Q4; built from the labels when absent. */
      names?: [string, string, string, string];
    }
  | { type: "setQuadrantCurl"; gateId: string; curl: QuadrantCurl | null } // bend or straighten the arms
  | { type: "addPopulation"; name: string; parentId: string; gateRefs: GateRef[] }
  | { type: "setActivePopulation"; popId: string }
  | { type: "selectGate"; gateId: string | null }
  | { type: "toggleGateSelect"; gateId: string; checked: boolean }
  | { type: "togglePopSelect"; popId: string; checked: boolean }
  | { type: "renameGate"; gateId: string; name: string }
  /** `quadrant` (0 to 3, Q1 to Q4) moves one of a quadrant gate's four labels instead of the gate label. */
  | { type: "moveGateLabel"; gateId: string; labelOffset: [number, number]; quadrant?: number }
  | { type: "editGate"; gateId: string; vertices: [number, number][] } // dragged poly/rect vertices (gating space)
  | { type: "moveEllipse"; gateId: string; mean: [number, number] } // ellipse translation (gate space)
  | { type: "reshapeEllipse"; gateId: string; mean: [number, number]; covariance: [[number, number], [number, number]] } // handle drag (gate space)
  | { type: "moveQuadrantCenter"; gateId: string; center: [number, number] } // dragged crosshair (gating space)
  | { type: "renamePopulation"; popId: string; name: string }
  /** Several populations renamed at once, by id, as one undo step. */
  | { type: "renamePopulations"; names: Record<string, string> }
  | { type: "setPopulationGateRefs"; popId: string; gateRefs: GateRef[] }
  | {
      type: "movePopulation";
      popId: string;
      targetId: string;
      placement: "before" | "inside" | "after";
    }
  | {
      /** Move several populations together, keeping their relative tree order. */
      type: "movePopulations";
      popIds: string[];
      targetId: string;
      placement: "before" | "inside" | "after";
    }
  /** Option-drag: the same populations, subtrees and gate references included, copied where a move would put them. */
  | { type: "copyPopulations"; popIds: string[]; targetId: string; placement: "before" | "inside" | "after" }
  | {
      type: "editPopulation";
      popId: string;
      name: string;
      parentId: string;
      gateRefs: GateRef[];
    }
  | { type: "deletePopulations"; popIds: string[] }
  | { type: "bulkRenamePopulations"; mapping: Record<string, string> } // by current name → new name
  | {
      type: "bulkEditPopulations";
      updates: { popId: string; name: string; gateRefs: GateRef[] }[];
    }
  | { type: "moveSelectedPopulations"; popIds: string[]; parentId: string }
  | { type: "setPopSelection"; popIds: string[] }
  | {
      /** Add a hierarchy holding this tree and make it the active one. */
      type: "addHierarchy";
      id: string;
      name: string;
      populations: PopulationMap;
      root_population_id: string;
      /** The hierarchy's own gates, which every reference in the tree must resolve in; none by default. */
      gates?: Record<string, Gate>;
      gate_order?: string[];
      owner_sample_id?: string;
      structure_locked?: boolean;
      source_hierarchy_id?: string;
      source_gate_ids?: Record<string, string>;
      source_population_ids?: Record<string, string>;
    }
  | {
      /** Add several complete hierarchy copies atomically and make one of them active. */
      type: "addHierarchyCopies";
      copies: StoredHierarchy[];
      activeHierarchyId: string;
      keepBrowsingPosition?: boolean;
      /** Files to gate under the new copies, in the same undo entry. */
      assignments?: Record<string, string>;
      /** Record no undo entry: a copy made only to view a file in "this file only" mode. */
      silent?: boolean;
    }
  /** `silent` records no undo entry: viewing a file is navigation, not an edit. */
  | { type: "switchHierarchy"; id: string; silent?: boolean }
  | { type: "revertGateToGroup"; gateId: string }
  /** The group's template takes this gate's geometry from the live copy; every other copy that
   *  followed the template's gate follows the new geometry. FlowJo's "apply to group", one gate. */
  | { type: "applyGateToGroup"; gateId: string }
  /** The template takes every gate's geometry from this copy, and every file of the group goes
   *  back on the template: one tree for everyone, nothing tailored. One undo entry. */
  | { type: "promoteCopyToTemplate"; copyId: string }
  | {
      type: "replaceHierarchyCopies";
      copies: StoredHierarchy[];
      /** Copies that do not exist yet, added before the replacement, in the same undo entry. */
      added?: StoredHierarchy[];
      assignments?: Record<string, string>;
    }
  /**
   * Which tree each file is gated under: a merge, null unassigning a file. A copy whose owner
   * this moves to another tree, and that no tree derives from, has no purpose and is dropped
   * in the same step; if it was live, the owner's new tree becomes live. `silent` records no
   * undo entry, for bookkeeping such as removing files.
   */
  | { type: "assignFileHierarchies"; assignments: Record<string, string | null>; silent?: boolean }
  | { type: "setHierarchyStructureLocked"; id: string; locked: boolean }
  /** A file's copy leaves its group: a tree of its own, structure editable, provenance dropped. */
  | { type: "unlinkHierarchy"; id: string }
  | { type: "renameHierarchy"; id: string; name: string }
  | { type: "deleteHierarchy"; id: string }
  | { type: "duplicateSelectedPopulations"; popIds: string[] }
  | { type: "deleteGates"; gateIds: string[] }
  | { type: "clearGateSelection" }
  | { type: "clearPopSelection" }
  | { type: "sortGatesAlpha" }
  | { type: "sortPopulationsAlpha" }
  | {
      type: "importGating";
      gates: Record<string, Gate>;
      gate_order: string[];
      populations: PopulationMap;
      root_population_id: string;
      mode?: GatingImportMode;
      /** In merge mode, the current population the imported root's children attach under. */
      attachTo?: string;
      /** Compensation lives outside CoreState; discard unsafe gate-only undo when its space changed. */
      clearHistory?: boolean;
    }
  | {
      type: "loadWorkspace";
      gates: Record<string, Gate>;
      gate_order: string[];
      populations: PopulationMap;
      root_population_id: string | null;
      active_population_id: string | null;
      selected_gate_id: string | null;
      /** Absent in a workspace saved before hierarchies existed: it holds the one default. */
      hierarchies?: HierarchyRef[];
      active_hierarchy_id?: string;
      stored_hierarchies?: StoredHierarchy[];
      file_hierarchies?: Record<string, string>;
      groups?: WorkspaceGroup[];
      file_groups?: Record<string, string>;
    }
  /** A group with its working tree (a locked copy of the live template), and its first files. */
  | { type: "addGroup"; id: string; name: string; fileIds: string[] }
  | { type: "renameGroup"; id: string; name: string }
  /** Files into a group, or out of every group (null). A tailored copy keeps its coordinates; a copy with nothing tailored goes. */
  | { type: "setFileGroup"; fileIds: string[]; groupId: string | null }
  /** The group goes; its files follow the tree, their own tailoring kept. */
  | { type: "deleteGroup"; id: string }
  /** Every gate of a copy takes its source's coordinates again; copies following it follow along. */
  | { type: "revertCopyToSource"; id: string }
  | { type: "undo" }
  | { type: "redo" };

const LOCKED_STRUCTURE_ACTIONS = new Set<Action["type"]>([
  "addGate", "addEllipse", "addQuadrant", "addPopulation",
  "renameGate", "renamePopulation", "renamePopulations", "setPopulationGateRefs",
  "movePopulation", "movePopulations", "copyPopulations", "editPopulation",
  "deletePopulations", "bulkRenamePopulations", "bulkEditPopulations",
  "moveSelectedPopulations", "duplicateSelectedPopulations", "deleteGates",
  "importGating",
]);

/**
 * Edits to a hierarchy that reach its structure-locked copies: everything that changes the
 * tree's structure, and every change of a gate's geometry. Cosmetic moves of a label stay local.
 */
const PROPAGATED_ACTIONS = new Set<Action["type"]>([
  ...LOCKED_STRUCTURE_ACTIONS,
  "editGate", "moveEllipse", "reshapeEllipse", "moveQuadrantCenter", "setQuadrantCurl",
  "sortGatesAlpha", "sortPopulationsAlpha",
]);

export function coreReducer(state: CoreState, action: Action): CoreState {
  const next = reduceCore(state, action);
  if (next === state || !PROPAGATED_ACTIONS.has(action.type)) return next;
  return propagateToLockedCopies(state, next);
}

/**
 * Group-gate propagation. After an edit to the active hierarchy, every file-owned copy that is
 * locked to it and was in step with it before the edit is brought in step with it after: the
 * structure follows, and each gate's geometry follows unless that copy had tailored it
 * (engine/templateSync.ts). Editing a copy never reaches its template or its siblings.
 */
function propagateToLockedCopies(before: CoreState, after: CoreState): CoreState {
  if (after.active_hierarchy_id !== before.active_hierarchy_id || !before.root_population_id || !after.root_population_id) return after;
  if (after.gates === before.gates && after.gate_order === before.gate_order && after.populations === before.populations) return after;
  const was = { gates: before.gates, gate_order: before.gate_order, populations: before.populations, root_population_id: before.root_population_id };
  const now = { gates: after.gates, gate_order: after.gate_order, populations: after.populations, root_population_id: after.root_population_id };
  const stored_hierarchies = { ...after.stored_hierarchies };
  let touched = false;
  // A group's tree follows the template, and the group's files' copies follow the group's tree in
  // turn: each synced copy is a source in its own right, so the sync runs down the chain.
  const follow = (sourceId: string, sourceWas: TemplateTree, sourceNow: TemplateTree): void => {
    for (const ref of after.hierarchies) {
      if (ref.source_hierarchy_id !== sourceId || ref.structure_locked !== true || !isCopyRef(ref)) continue;
      const stored = stored_hierarchies[ref.id];
      if (!stored) continue;
      const synced = syncLockedCopy(stored, sourceWas, sourceNow);
      if (!synced) continue;
      stored_hierarchies[ref.id] = synced;
      touched = true;
      if (stored.root_population_id && synced.root_population_id) {
        follow(ref.id, { ...stored, root_population_id: stored.root_population_id }, { ...synced, root_population_id: synced.root_population_id });
      }
    }
  };
  follow(after.active_hierarchy_id, was, now);
  if (!touched) return after;
  const hierarchies = after.hierarchies.map((h) => (stored_hierarchies[h.id] && stored_hierarchies[h.id] !== after.stored_hierarchies[h.id] ? hierarchyRefFromStored(stored_hierarchies[h.id]) : h));
  return { ...after, stored_hierarchies, hierarchies, tree_version: after.tree_version + 1 };
}

/**
 * Drop every copy whose owner file is now assigned to another tree and that no tree derives
 * from: a tailored copy nobody is gated under has no purpose, and left behind it showed in the
 * menu as a file's second tree. A copy still being someone's source is kept. When the live tree
 * is one of them, the owner's new tree becomes live first. History is the caller's business.
 */
function dropOrphanCopies(state: CoreState): CoreState {
  const assigned = state.file_hierarchies;
  const orphans = state.hierarchies.filter((h) =>
    h.owner_sample_id !== undefined &&
    assigned[h.owner_sample_id] !== undefined &&
    assigned[h.owner_sample_id] !== h.id &&
    !state.hierarchies.some((other) => other.source_hierarchy_id === h.id));
  if (!orphans.length) return state;
  const orphanIds = new Set(orphans.map((h) => h.id));
  let next = state;
  if (orphanIds.has(next.active_hierarchy_id)) {
    const owner = next.hierarchies.find((h) => h.id === next.active_hierarchy_id)?.owner_sample_id;
    const wanted = owner ? assigned[owner] : undefined;
    const to = wanted && !orphanIds.has(wanted) && next.hierarchies.some((h) => h.id === wanted)
      ? wanted
      : next.hierarchies.find((h) => !orphanIds.has(h.id))?.id;
    if (to) next = reduceCore(next, { type: "switchHierarchy", id: to });
  }
  for (const id of orphanIds) next = reduceCore(next, { type: "deleteHierarchy", id });
  return next;
}

/** Every tree stored, then `activeId` made live again, selections trimmed to what it holds. */
function withTrees(state: CoreState, all: Record<string, StoredHierarchy>, activeId: string): CoreState {
  const live = all[activeId];
  const stored_hierarchies = { ...all };
  delete stored_hierarchies[activeId];
  return {
    ...state,
    hierarchies: state.hierarchies.map((h) => (all[h.id] ? hierarchyRefFromStored(all[h.id]) : h)),
    active_hierarchy_id: activeId,
    stored_hierarchies,
    gates: live.gates,
    gate_order: live.gate_order,
    populations: live.populations,
    root_population_id: live.root_population_id,
    active_population_id: live.active_population_id && live.populations[live.active_population_id]
      ? live.active_population_id
      : live.root_population_id,
    selected_pop_ids: live.selected_pop_ids.filter((id) => live.populations[id]),
    selected_gate_id: state.selected_gate_id && live.gates[state.selected_gate_id] ? state.selected_gate_id : null,
    selected_gate_ids: state.selected_gate_ids.filter((id) => live.gates[id]),
  };
}

/** A template went from `before` to `after`: store it, and bring every copy that followed it along. */
function resyncGroup(
  all: Record<string, StoredHierarchy>,
  before: StoredHierarchy,
  after: StoredHierarchy,
): Record<string, StoredHierarchy> {
  let next = { ...all, [after.id]: after };
  if (!before.root_population_id || !after.root_population_id) return next;
  const was = { gates: before.gates, gate_order: before.gate_order, populations: before.populations, root_population_id: before.root_population_id };
  const now = { gates: after.gates, gate_order: after.gate_order, populations: after.populations, root_population_id: after.root_population_id };
  for (const tree of Object.values(all)) {
    if (tree.source_hierarchy_id !== before.id || !tree.structure_locked || !isCopyRef(tree)) continue;
    const synced = syncLockedCopy(tree, was, now);
    // A group's tree that moved is a source in its own right: its files' copies follow it.
    if (synced) next = resyncGroup(next, tree, synced);
  }
  return next;
}

/** The live copy and the template it follows directly, when the live tree is such a copy. */
function liveCopyAndTemplate(state: CoreState): { copy: StoredHierarchy; template: StoredHierarchy; all: Record<string, StoredHierarchy> } | null {
  const ref = state.hierarchies.find((h) => h.id === state.active_hierarchy_id);
  if (!ref || !isCopyRef(ref) || !ref.structure_locked || !ref.source_hierarchy_id) return null;
  const templateRef = state.hierarchies.find((h) => h.id === ref.source_hierarchy_id);
  if (!templateRef || templateRef.owner_sample_id) return null;
  const parked = parkActiveHierarchy(state);
  const all = { ...state.stored_hierarchies, [parked.id]: parked };
  const template = all[templateRef.id];
  if (!template?.root_population_id || !parked.root_population_id) return null;
  return { copy: parked, template, all };
}

function invertMap(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));
}

/** The template a tree belongs to, walking up through copies of either kind. */
function templateOfRef(state: CoreState, id: string): HierarchyRef | null {
  let cur = state.hierarchies.find((h) => h.id === id) ?? null;
  const seen = new Set<string>();
  while (cur && isCopyRef(cur) && cur.source_hierarchy_id && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = state.hierarchies.find((h) => h.id === cur!.source_hierarchy_id) ?? null;
  }
  return cur;
}

/** A hierarchy's tree, live or parked. */
function treeOfId(state: CoreState, id: string): StoredHierarchy | null {
  const ref = state.hierarchies.find((h) => h.id === id);
  if (!ref) return null;
  if (id === state.active_hierarchy_id) return storeHierarchy(ref, state);
  return state.stored_hierarchies[id] ?? null;
}

/** Whether a copy's every gate still has its source's coordinates. */
function copyFollows(copy: StoredHierarchy, source: StoredHierarchy): boolean {
  return Object.entries(copy.source_gate_ids ?? {}).every(([own, src]) => {
    const a = copy.gates[own], b = source.gates[src];
    return !a || !b || gateGeometryEquals(a, b);
  });
}

/**
 * Files into a group, or out of every group. A file with no copy of its own is pointed at its
 * new source: the group's tree, or the template. A file's copy is kept where it has tailored
 * something, re-based onto the new source with its ids intact (the provenance maps are rewritten
 * through the template, which every group's tree is in step with); a copy with nothing tailored
 * goes, and the file follows the new source. Membership is recorded alongside.
 */
function moveFilesToGroup(state: CoreState, fileIds: readonly string[], groupId: string | null): CoreState {
  const groupCopyRef = groupId ? state.hierarchies.find((h) => h.owner_group_id === groupId) : undefined;
  if (groupId && !groupCopyRef) return state;
  let next = state;
  const assignments: Record<string, string> = {};
  const file_groups = { ...state.file_groups };
  let hierarchies = [...state.hierarchies];
  const stored_hierarchies = { ...state.stored_hierarchies };
  let touched = false;
  for (const fileId of new Set(fileIds)) {
    const currentId = fileHierarchyId(state.file_hierarchies[fileId], state.hierarchies);
    const current = state.hierarchies.find((h) => h.id === currentId);
    const templateRef = templateOfRef(state, currentId);
    if (!current || !templateRef) continue;
    const newSource = groupCopyRef ?? templateRef;
    if (groupId) file_groups[fileId] = groupId; else delete file_groups[fileId];
    if (current.owner_sample_id !== fileId) {
      // On a source directly: point it at the new one.
      if (currentId !== newSource.id) assignments[fileId] = newSource.id;
      continue;
    }
    const copy = treeOfId(state, currentId);
    const oldSource = current.source_hierarchy_id ? treeOfId(state, current.source_hierarchy_id) : null;
    if (!copy || !oldSource || current.source_hierarchy_id === newSource.id) continue;
    if (copyFollows(copy, oldSource)) {
      // Nothing tailored: the copy goes with the move; the file follows its new source.
      assignments[fileId] = newSource.id;
      continue;
    }
    // Re-base: old source gate id → template gate id → new source gate id, ids of the copy kept.
    const toTemplateGate = (id: string) => (oldSource.owner_group_id ? oldSource.source_gate_ids?.[id] ?? id : id);
    const toTemplatePop = (id: string) => (oldSource.owner_group_id ? oldSource.source_population_ids?.[id] ?? id : id);
    const newTree = treeOfId(state, newSource.id);
    const fromTemplateGate = newTree?.owner_group_id ? invertMap(newTree.source_gate_ids ?? {}) : null;
    const fromTemplatePop = newTree?.owner_group_id ? invertMap(newTree.source_population_ids ?? {}) : null;
    const source_gate_ids = Object.fromEntries(Object.entries(copy.source_gate_ids ?? {}).map(([own, src]) => {
      const t = toTemplateGate(src);
      return [own, fromTemplateGate ? fromTemplateGate[t] ?? t : t];
    }));
    const source_population_ids = Object.fromEntries(Object.entries(copy.source_population_ids ?? {}).map(([own, src]) => {
      const t = toTemplatePop(src);
      return [own, fromTemplatePop ? fromTemplatePop[t] ?? t : t];
    }));
    const rebased = { source_hierarchy_id: newSource.id, source_gate_ids, source_population_ids };
    hierarchies = hierarchies.map((h) => (h.id === copy.id ? { ...h, ...rebased } : h));
    if (stored_hierarchies[copy.id]) stored_hierarchies[copy.id] = { ...stored_hierarchies[copy.id], ...rebased };
    touched = true;
  }
  if (touched) next = { ...next, hierarchies, stored_hierarchies };
  next = { ...next, file_groups };
  if (Object.keys(assignments).length) next = reduceCore(next, { type: "assignFileHierarchies", assignments, silent: true });
  if (next === state) return state;
  return { ...next, gate_version: state.gate_version + 1, tree_version: state.tree_version + 1 };
}

function reduceCore(state: CoreState, action: Action): CoreState {
  const activeHierarchy = state.hierarchies.find((hierarchy) => hierarchy.id === state.active_hierarchy_id);
  if (activeHierarchy?.structure_locked === true && LOCKED_STRUCTURE_ACTIONS.has(action.type)) return state;
  switch (action.type) {
    case "newWorkspace":
      return {
        ...initialCoreState(),
        // Consumers key expensive derived state to this revision. Keep it monotonic so an
        // empty replacement workspace cannot reuse plot/gating state from the previous one.
        gate_version: state.gate_version + 1,
      };

    case "loadSample": {
      const root = newRootPopulation(action.nEvents);
      return {
        ...initialCoreState(),
        populations: { [root.population_id]: root },
        root_population_id: root.population_id,
        active_population_id: root.population_id,
        gate_version: state.gate_version + 1,
      };
    }

    case "clearGating": {
      // Start gating again on the same files: one root, one hierarchy, no assignments. Unlike
      // loadSample this records an undo entry, so a slip brings everything back.
      const root = newRootPopulation(action.nEvents);
      return {
        ...initialCoreState(),
        populations: { [root.population_id]: root },
        root_population_id: root.population_id,
        active_population_id: root.population_id,
        gate_version: state.gate_version + 1,
        tree_version: state.tree_version + 1,
        ...pushUndo(state),
      };
    }

    case "addGate": {
      const color = nextGateColor(Object.keys(state.gates).length);
      // label_offset starts null (auto-positioned); it becomes concrete only when the
      // user drags the label (moveGateLabel), so it then persists across re-renders.
      const gate = newGate(
        action.name,
        action.gateType,
        action.xChannel,
        action.yChannel,
        action.vertices,
        color,
        null,
      );
      // Recorded at creation and never rewritten: the gate's space is part of its identity.
      if (action.space) gate.space = action.space;
      if (action.transforms) gate.transforms = action.transforms;
      const gates = { ...state.gates, [gate.gate_id]: gate };
      const gate_order = [...state.gate_order, gate.gate_id];
      const base = { ...pushUndo(state), gates, gate_order, selected_gate_id: gate.gate_id };

      if (action.createPop) {
        const populations: PopulationMap = clonePops(state.populations);
        const parentId =
          populations[action.createPop.parentId] ? action.createPop.parentId : state.root_population_id!;
        const pop = newPopulation(action.createPop.name, [newGateRef(gate.gate_id, true)], parentId);
        pop.colorSlot = pickPopColorSlot(populations); // stable colour, before this pop is in the map
        populations[pop.population_id] = pop;
        linkChildToParent(populations, pop.population_id, parentId);
        sortPopulationTree(populations, state.root_population_id!);
        return {
          ...state,
          ...base,
          populations,
          active_population_id: pop.population_id,
          gate_version: state.gate_version + 1,
        };
      }
      return { ...state, ...base, gate_version: state.gate_version + 1 };
    }

    case "addEllipse": {
      const gateId = crypto.randomUUID();
      // A drawn ellipse starts axis-aligned: covariance diag(rx², ry²) at distanceSquare 1, so
      // the drag radii ARE the half-axes. Rotation enters only through imports until the editor
      // grows a rotation handle.
      const gate: Gate = {
        gate_id: gateId,
        name: action.name,
        gate_type: "ellipse",
        x_channel: action.xChannel,
        y_channel: action.yChannel,
        mean: action.mean,
        covariance: [[action.radii[0] * action.radii[0], 0], [0, action.radii[1] * action.radii[1]]],
        distance_square: 1,
        color: nextGateColor(Object.keys(state.gates).length),
        label_offset: action.labelOffset ?? null,
        ...(action.space ? { space: action.space } : {}),
        ...(action.transforms ? { transforms: action.transforms } : {}),
      };
      const gates = { ...state.gates, [gateId]: gate };
      const gate_order = [...state.gate_order, gateId];
      let populations = state.populations;
      let selected_pop: string | null = null;
      if (action.createPop) {
        const pop = newPopulation(action.createPop.name, [newGateRef(gateId, true)], action.createPop.parentId);
        populations = linkChildToParent(
          { ...populations, [pop.population_id]: pop }, pop.population_id, action.createPop.parentId);
        selected_pop = pop.population_id;
      }
      return {
        ...state, ...pushUndo(state), gates, gate_order, populations,
        selected_gate_id: gateId,
        ...(selected_pop ? { active_population_id: selected_pop } : {}),
        gate_version: state.gate_version + 1,
      };
    }

    case "addQuadrant": {
      const color = nextGateColor(Object.keys(state.gates).length);
      const base = action.prefix ? action.prefix : `${action.xChannel}/${action.yChannel}`;
      const qgate = newQuadrantGate(
        `${base} quadrant`,
        action.xChannel,
        action.yChannel,
        action.center,
        color,
      );
      if (action.space) qgate.space = action.space;
      if (action.transforms) qgate.transforms = action.transforms;
      if (action.curl) qgate.curl = { ...action.curl };
      const gates = { ...state.gates, [qgate.gate_id]: qgate };
      const gate_order = [...state.gate_order, qgate.gate_id];
      const populations: PopulationMap = clonePops(state.populations);
      const parentId = populations[action.parentId] ? action.parentId : state.root_population_id!;
      // Quadrant 1=x-/y+, 2=x+/y+, 3=x+/y-, 4=x-/y- ; name each by the axes' short labels and
      // signs. The gate's name carries the prefix; the populations read "CD4+ CD8-".
      const sgn: [string, string][] = [["-", "+"], ["+", "+"], ["+", "-"], ["-", "-"]];
      const xLabel = action.xLabel?.trim() || action.xChannel;
      const yLabel = action.yLabel?.trim() || action.yChannel;
      let lastPop = parentId;
      for (let q = 1; q <= 4; q++) {
        const qn = action.names?.[q - 1]?.trim() || `${xLabel}${sgn[q - 1][0]} ${yLabel}${sgn[q - 1][1]}`;
        const np = newPopulation(qn, [newGateRef(qgate.gate_id, true, q)], parentId);
        np.colorSlot = pickPopColorSlot(populations); // distinct slot per quadrant pop
        populations[np.population_id] = np;
        linkChildToParent(populations, np.population_id, parentId);
        lastPop = np.population_id;
      }
      sortPopulationTree(populations, state.root_population_id!);
      return {
        ...state,
        ...pushUndo(state),
        gates,
        gate_order,
        populations,
        selected_gate_id: qgate.gate_id,
        active_population_id: lastPop,
        gate_version: state.gate_version + 1,
      };
    }

    case "addPopulation": {
      const populations: PopulationMap = clonePops(state.populations);
      const parentId = populations[action.parentId] ? action.parentId : state.root_population_id!;
      const pop = newPopulation(action.name, action.gateRefs, parentId);
      pop.colorSlot = pickPopColorSlot(populations); // stable colour, before this pop is in the map
      populations[pop.population_id] = pop;
      linkChildToParent(populations, pop.population_id, parentId);
      sortPopulationTree(populations, state.root_population_id!);
      return {
        ...state,
        ...pushUndo(state),
        populations,
        active_population_id: pop.population_id,
        gate_version: state.gate_version + 1,
      };
    }

    case "setActivePopulation":
      return { ...state, active_population_id: action.popId };

    case "selectGate":
      return { ...state, selected_gate_id: action.gateId };

    case "toggleGateSelect": {
      const set = new Set(state.selected_gate_ids);
      if (action.checked) set.add(action.gateId);
      else set.delete(action.gateId);
      return { ...state, selected_gate_ids: [...set] };
    }

    case "togglePopSelect": {
      const set = new Set(state.selected_pop_ids);
      if (action.checked) set.add(action.popId);
      else set.delete(action.popId);
      return { ...state, selected_pop_ids: [...set] };
    }

    case "setPopSelection": {
      const next = [...new Set(action.popIds)].filter((id) => state.populations[id] && id !== state.root_population_id);
      if (sameStringArray(next, state.selected_pop_ids)) return state;
      return { ...state, selected_pop_ids: next };
    }

    case "renameGate": {
      if (!state.gates[action.gateId]) return state;
      const gates = { ...state.gates, [action.gateId]: { ...state.gates[action.gateId], name: action.name } };
      return { ...state, ...pushUndo(state), gates, gate_version: state.gate_version + 1 };
    }

    case "moveGateLabel": {
      const g = state.gates[action.gateId];
      if (!g) return state;
      // Cosmetic — no undo/version bump; new gates ref so the plot payload re-renders.
      if (action.quadrant !== undefined) {
        if (g.gate_type !== "quadrant" || !Number.isInteger(action.quadrant) || action.quadrant < 0 || action.quadrant > 3) return state;
        const offsets = [0, 1, 2, 3].map((i) => (i === action.quadrant ? action.labelOffset : g.quadrant_label_offsets?.[i] ?? null));
        return { ...state, gates: { ...state.gates, [action.gateId]: { ...g, quadrant_label_offsets: offsets } } };
      }
      return {
        ...state,
        gates: { ...state.gates, [action.gateId]: { ...g, label_offset: action.labelOffset } },
      };
    }

    case "editGate": {
      const g = state.gates[action.gateId];
      // Only poly/rect hold editable vertices. An ellipse renders AS a sampled polygon, so a
      // stray vertex edit reaching here must be refused, not written: accepting it would
      // silently convert the covariance form into 64 fixed points.
      if (!g || g.gate_type === "quadrant" || g.gate_type === "ellipse") return state;
      const gates = { ...state.gates, [action.gateId]: { ...g, vertices: action.vertices } };
      return { ...state, ...pushUndo(state), gates, gate_version: state.gate_version + 1 };
    }

    case "moveEllipse": {
      const g = state.gates[action.gateId];
      if (!g || g.gate_type !== "ellipse") return state;
      const gates = { ...state.gates, [action.gateId]: { ...g, mean: action.mean } };
      return { ...state, ...pushUndo(state), gates, gate_version: state.gate_version + 1 };
    }

    case "reshapeEllipse": {
      const g = state.gates[action.gateId];
      if (!g || g.gate_type !== "ellipse") return state;
      const gates = {
        ...state.gates,
        [action.gateId]: { ...g, mean: action.mean, covariance: action.covariance },
      };
      return { ...state, ...pushUndo(state), gates, gate_version: state.gate_version + 1 };
    }

    case "moveQuadrantCenter": {
      const g = state.gates[action.gateId];
      if (!g || g.gate_type !== "quadrant") return state;
      const gates = { ...state.gates, [action.gateId]: { ...g, center: action.center } };
      return { ...state, ...pushUndo(state), gates, gate_version: state.gate_version + 1 };
    }

    case "setQuadrantCurl": {
      const g = state.gates[action.gateId];
      if (!g || g.gate_type !== "quadrant") return state;
      // A fresh gate object: masks are memoised on the object, so the arms move the moment
      // the curl does. Null straightens the crosshair.
      const { curl: _old, ...rest } = g;
      void _old;
      const next = action.curl ? { ...rest, curl: { ...action.curl } } : rest;
      const gates = { ...state.gates, [action.gateId]: next };
      return { ...state, ...pushUndo(state), gates, gate_version: state.gate_version + 1 };
    }

    case "renamePopulation": {
      const name = action.name.trim();
      if (!state.populations[action.popId] || !name || state.populations[action.popId].name === name) {
        return state;
      }
      const populations = clonePops(state.populations);
      populations[action.popId].name = name;
      return { ...state, ...pushUndo(state, false), populations, tree_version: state.tree_version + 1 };
    }

    case "renamePopulations": {
      const populations = clonePops(state.populations);
      let changed = false;
      for (const [popId, raw] of Object.entries(action.names)) {
        const name = raw.trim();
        const pop = populations[popId];
        if (!pop || !name || pop.name === name) continue;
        pop.name = name;
        changed = true;
      }
      if (!changed) return state;
      return { ...state, ...pushUndo(state, false), populations, tree_version: state.tree_version + 1 };
    }

    case "setPopulationGateRefs": {
      const population = state.populations[action.popId];
      if (
        !population ||
        action.popId === state.root_population_id ||
        !validPopulationGateRefs(state.gates, action.gateRefs) ||
        sameGateRefs(population.gate_refs, action.gateRefs)
      ) {
        return state;
      }
      const populations = clonePops(state.populations);
      populations[action.popId].gate_refs = action.gateRefs.map((ref) => ({ ...ref }));
      return {
        ...state,
        ...pushUndo(state),
        populations,
        gate_version: state.gate_version + 1,
      };
    }

    case "copyPopulations": {
      // The same gates under another parent: each requested population, pruned to the top-most
      // members and in tree order, is cloned with its subtree under fresh ids, every clone
      // referencing the very gates the original does, and the clones land where a move would.
      const requested = new Set(action.popIds.filter((id) => state.populations[id] && id !== state.root_population_id));
      const hasCopiedAncestor = (id: string): boolean => {
        let cur = state.populations[id]?.parent_id ?? null;
        while (cur) {
          if (requested.has(cur)) return true;
          cur = state.populations[cur]?.parent_id ?? null;
        }
        return false;
      };
      const order = state.root_population_id
        ? populationTreeOrder(state.populations, state.root_population_id).map((row) => row.popId)
        : [];
      const copying = order.filter((id) => requested.has(id) && !hasCopiedAncestor(id));
      const target = state.populations[action.targetId];
      if (!copying.length || !target) return state;
      const destinationParentId = action.placement === "inside" ? action.targetId : target.parent_id;
      if (!destinationParentId || !state.populations[destinationParentId]) return state;
      if (action.placement !== "inside" && !state.populations[destinationParentId].children.includes(action.targetId)) return state;
      const populations = clonePops(state.populations);
      const cloneSubtree = (id: string, parentId: string): string => {
        const pop = populations[id];
        const clone = newPopulation(pop.name, pop.gate_refs.map((r) => ({ ...r })), parentId, pop.gate_logic);
        clone.colorSlot = pickPopColorSlot(populations);
        populations[clone.population_id] = clone;
        clone.children = pop.children.map((childId) => cloneSubtree(childId, clone.population_id));
        return clone.population_id;
      };
      const copies = copying.map((id) => cloneSubtree(id, destinationParentId));
      const destination = populations[destinationParentId];
      let insertionIndex = destination.children.length;
      if (action.placement !== "inside") {
        const targetIndex = destination.children.indexOf(action.targetId);
        if (targetIndex < 0) return state;
        insertionIndex = targetIndex + (action.placement === "after" ? 1 : 0);
      }
      destination.children = [...destination.children];
      destination.children.splice(insertionIndex, 0, ...copies);
      if (state.root_population_id) sortPopulationTree(populations, state.root_population_id);
      return { ...state, ...pushUndo(state), populations, gate_version: state.gate_version + 1 };
    }

    case "addGroup": {
      const name = action.name.trim();
      if (!name || !action.id || state.groups.some((g) => g.id === action.id || g.name === name)) return state;
      // The group's tree is a locked copy of the live template, carrying its coordinates; the
      // group's files follow it as an ungrouped file follows the tree.
      const templateRef = templateOfRef(state, state.active_hierarchy_id);
      const template = templateRef ? treeOfId(state, templateRef.id) : null;
      if (!templateRef || !template?.root_population_id) return state;
      const clone = cloneHierarchyTree(template.populations, template.root_population_id, template.gates, template.gate_order);
      const copy: StoredHierarchy = {
        id: newHierarchyId(),
        name,
        owner_group_id: action.id,
        structure_locked: true,
        source_hierarchy_id: templateRef.id,
        source_gate_ids: invertMap(clone.gateIdMap),
        source_population_ids: invertMap(clone.idMap),
        gates: clone.gates,
        gate_order: clone.gate_order,
        populations: clone.populations,
        root_population_id: clone.root_population_id,
        active_population_id: clone.root_population_id,
        selected_pop_ids: [],
      };
      let next: CoreState = {
        ...state,
        hierarchies: [...state.hierarchies, hierarchyRefFromStored(copy)],
        stored_hierarchies: { ...state.stored_hierarchies, [copy.id]: copy },
        groups: [...state.groups, { id: action.id, name }],
      };
      if (action.fileIds.length) next = moveFilesToGroup(next, action.fileIds, action.id);
      return withOneUndoEntry(state, { ...next, tree_version: state.tree_version + 1 });
    }

    case "renameGroup": {
      const name = action.name.trim();
      const group = state.groups.find((g) => g.id === action.id);
      if (!group || !name || group.name === name || state.groups.some((g) => g.name === name)) return state;
      const copyRef = state.hierarchies.find((h) => h.owner_group_id === action.id);
      const hierarchies = state.hierarchies.map((h) => (h.owner_group_id === action.id ? { ...h, name } : h));
      const stored = copyRef ? state.stored_hierarchies[copyRef.id] : undefined;
      return {
        ...state,
        ...pushUndo(state, false),
        groups: state.groups.map((g) => (g.id === action.id ? { ...g, name } : g)),
        hierarchies,
        stored_hierarchies: stored ? { ...state.stored_hierarchies, [stored.id]: { ...stored, name } } : state.stored_hierarchies,
        tree_version: state.tree_version + 1,
      };
    }

    case "setFileGroup": {
      if (action.groupId !== null && !state.groups.some((g) => g.id === action.groupId)) return state;
      const next = moveFilesToGroup(state, action.fileIds, action.groupId);
      if (next === state) return state;
      return withOneUndoEntry(state, next);
    }

    case "revertCopyToSource": {
      const ref = state.hierarchies.find((h) => h.id === action.id);
      if (!ref || !isCopyRef(ref) || !ref.source_hierarchy_id) return state;
      const parked = parkActiveHierarchy(state);
      const all = { ...state.stored_hierarchies, [parked.id]: parked };
      const copy = all[action.id];
      const source = all[ref.source_hierarchy_id];
      if (!copy?.root_population_id || !source?.root_population_id) return state;
      const gates = { ...copy.gates };
      let changed = false;
      for (const [own, src] of Object.entries(copy.source_gate_ids ?? {})) {
        const a = gates[own], b = source.gates[src];
        if (!a || !b || gateGeometryEquals(a, b)) continue;
        gates[own] = withGeometryOf(a, b);
        changed = true;
      }
      if (!changed) return state;
      const after: StoredHierarchy = { ...copy, gates };
      const next = withTrees(state, resyncGroup(all, copy, after), state.active_hierarchy_id);
      return { ...next, ...pushUndo(state), gate_version: state.gate_version + 1, tree_version: state.tree_version + 1 };
    }

    case "deleteGroup": {
      const group = state.groups.find((g) => g.id === action.id);
      const copyRef = state.hierarchies.find((h) => h.owner_group_id === action.id);
      if (!group || !copyRef) return state;
      const members = Object.entries(state.file_groups).filter(([, gid]) => gid === action.id).map(([fileId]) => fileId);
      let next = members.length ? moveFilesToGroup(state, members, null) : state;
      if (next.active_hierarchy_id === copyRef.id) {
        const to = copyRef.source_hierarchy_id ?? next.hierarchies.find((h) => !isCopyRef(h))?.id;
        if (!to) return state;
        next = reduceCore(next, { type: "switchHierarchy", id: to, silent: true });
      }
      const stored_hierarchies = { ...next.stored_hierarchies };
      delete stored_hierarchies[copyRef.id];
      next = {
        ...next,
        hierarchies: next.hierarchies.filter((h) => h.id !== copyRef.id),
        stored_hierarchies,
        groups: next.groups.filter((g) => g.id !== action.id),
        file_groups: Object.fromEntries(Object.entries(next.file_groups).filter(([, gid]) => gid !== action.id)),
        tree_version: next.tree_version + 1,
      };
      return withOneUndoEntry(state, next);
    }

    case "movePopulation":
      return coreReducer(state, {
        type: "movePopulations",
        popIds: [action.popId],
        targetId: action.targetId,
        placement: action.placement,
      });

    case "movePopulations": {
      // The moved set is pruned to its top-most members (a population travels with its
      // subtree) and ordered as the tree shows it, so a dragged selection keeps its order.
      const requested = new Set(action.popIds.filter((id) => state.populations[id] && id !== state.root_population_id));
      const hasMovedAncestor = (id: string): boolean => {
        let cur = state.populations[id]?.parent_id ?? null;
        while (cur) {
          if (requested.has(cur)) return true;
          cur = state.populations[cur]?.parent_id ?? null;
        }
        return false;
      };
      const order = state.root_population_id
        ? populationTreeOrder(state.populations, state.root_population_id).map((row) => row.popId)
        : [];
      const moving = order.filter((id) => requested.has(id) && !hasMovedAncestor(id));
      const target = state.populations[action.targetId];
      if (!moving.length || !target || moving.includes(action.targetId)) return state;

      const destinationParentId =
        action.placement === "inside" ? action.targetId : target.parent_id;
      if (
        !destinationParentId ||
        !state.populations[destinationParentId] ||
        moving.some((id) => wouldCreateCycle(state.populations, id, destinationParentId))
      ) {
        return state;
      }
      if (
        action.placement !== "inside" &&
        !state.populations[destinationParentId].children.includes(action.targetId)
      ) {
        return state;
      }

      const populations = clonePops(state.populations);
      const movingSet = new Set(moving);
      const touchedParents = new Set<string>();
      for (const id of moving) {
        const oldParentId = populations[id].parent_id;
        if (oldParentId && populations[oldParentId]) {
          touchedParents.add(oldParentId);
          populations[oldParentId].children = populations[oldParentId].children.filter(
            (childId) => childId !== id,
          );
        }
      }

      const destination = populations[destinationParentId];
      const destinationChildren = destination.children.filter((childId) => !movingSet.has(childId));
      let insertionIndex = destinationChildren.length;
      if (action.placement !== "inside") {
        const targetIndex = destinationChildren.indexOf(action.targetId);
        if (targetIndex < 0) return state;
        insertionIndex = targetIndex + (action.placement === "after" ? 1 : 0);
      }
      destinationChildren.splice(insertionIndex, 0, ...moving);
      destination.children = destinationChildren;
      for (const id of moving) populations[id].parent_id = destinationParentId;
      if (state.root_population_id) sortPopulationTree(populations, state.root_population_id);

      const parentChanged = moving.some((id) => state.populations[id].parent_id !== destinationParentId);
      if (
        !parentChanged &&
        [...touchedParents].every((pid) =>
          sameStringArray(state.populations[pid].children, populations[pid].children),
        )
      ) {
        return state;
      }
      return {
        ...state,
        ...pushUndo(state, parentChanged),
        populations,
        gate_version: parentChanged ? state.gate_version + 1 : state.gate_version,
        tree_version: parentChanged ? state.tree_version : state.tree_version + 1,
      };
    }

    case "editPopulation": {
      const { popId, name, parentId, gateRefs } = action;
      if (!state.populations[popId] || popId === state.root_population_id) return state;
      if (!validPopulationGateRefs(state.gates, gateRefs)) return state;
      const populations = clonePops(state.populations);
      const pop = populations[popId];
      const nextName = name.trim() || pop.name;
      const nameChanged = nextName !== pop.name;
      const refsChanged = !sameGateRefs(pop.gate_refs, gateRefs);
      pop.name = nextName;
      pop.gate_refs = gateRefs.map((ref) => ({ ...ref }));
      // Re-parent (guarded against cycles; the UI already excludes invalid parents).
      const oldParent = pop.parent_id;
      let parentChanged = false;
      if (
        parentId &&
        parentId !== oldParent &&
        populations[parentId] &&
        !wouldCreateCycle(populations, popId, parentId)
      ) {
        if (oldParent && populations[oldParent]) {
          populations[oldParent].children = populations[oldParent].children.filter((c) => c !== popId);
        }
        linkChildToParent(populations, popId, parentId);
        parentChanged = true;
      }
      if (!nameChanged && !refsChanged && !parentChanged) return state;
      sortPopulationTree(populations, state.root_population_id!);
      const affectsGating = refsChanged || parentChanged;
      return {
        ...state,
        ...pushUndo(state, affectsGating),
        populations,
        gate_version: affectsGating ? state.gate_version + 1 : state.gate_version,
        tree_version: affectsGating ? state.tree_version : state.tree_version + 1,
      };
    }

    case "deletePopulations": {
      const root = state.root_population_id;
      const ids = [...new Set(action.popIds)].filter(
        (id) => id in state.populations && id !== root,
      );
      if (ids.length === 0) return state;
      const populations = clonePops(state.populations);
      for (const pid of ids) {
        if (populations[pid]) removePopulationReparentChildren(populations, pid);
      }
      const gates = pruneOrphanQuadrantGates(state.gates, populations);
      const gate_order = state.gate_order.filter((g) => g in gates);
      const active =
        state.active_population_id && populations[state.active_population_id]
          ? state.active_population_id
          : root;
      return {
        ...state,
        ...pushUndo(state),
        gates,
        gate_order,
        populations,
        active_population_id: active,
        selected_pop_ids: state.selected_pop_ids.filter((id) => populations[id]),
        gate_version: state.gate_version + 1,
      };
    }

    case "bulkRenamePopulations": {
      const populations = clonePops(state.populations);
      let changed = false;
      for (const pop of Object.values(populations)) {
        const nn = action.mapping[pop.name];
        if (nn && nn.trim() && nn.trim() !== pop.name) { pop.name = nn.trim(); changed = true; }
      }
      if (!changed) return state;
      return { ...state, ...pushUndo(state, false), populations, tree_version: state.tree_version + 1 };
    }

    case "bulkEditPopulations": {
      const seenPopulations = new Set<string>();
      for (const update of action.updates) {
        const population = state.populations[update.popId];
        if (!population || seenPopulations.has(update.popId)) return state;
        seenPopulations.add(update.popId);
        if (update.popId === state.root_population_id && update.gateRefs.length > 0) return state;
        const seenRefs = new Set<string>();
        for (const ref of update.gateRefs) {
          const gate = state.gates[ref.gate_id];
          const refKey = `${ref.gate_id}:${ref.quadrant ?? ""}`;
          if (!gate || seenRefs.has(refKey)) return state;
          seenRefs.add(refKey);
          if (
            (gate.gate_type === "quadrant" &&
              (!Number.isInteger(ref.quadrant) || ref.quadrant! < 1 || ref.quadrant! > 4)) ||
            (gate.gate_type !== "quadrant" && ref.quadrant !== undefined)
          ) return state;
        }
      }

      const populations = clonePops(state.populations);
      let changed = false;
      let refsChangedAny = false;
      for (const update of action.updates) {
        const population = populations[update.popId];
        const name = update.name.trim() || population.name;
        const refsChanged =
          population.gate_refs.length !== update.gateRefs.length ||
          population.gate_refs.some((ref, index) => {
            const next = update.gateRefs[index];
            return !next ||
              ref.gate_id !== next.gate_id ||
              ref.include !== next.include ||
              ref.quadrant !== next.quadrant;
          });
        if (name !== population.name) {
          population.name = name;
          changed = true;
        }
        if (refsChanged) {
          population.gate_refs = update.gateRefs.map((ref) => ({ ...ref }));
          changed = true;
          refsChangedAny = true;
        }
      }
      if (!changed) return state;
      return {
        ...state,
        ...pushUndo(state, refsChangedAny),
        populations,
        gate_version: refsChangedAny ? state.gate_version + 1 : state.gate_version,
        tree_version: refsChangedAny ? state.tree_version : state.tree_version + 1,
      };
    }

    case "moveSelectedPopulations": {
      const { parentId } = action;
      if (!state.populations[parentId]) return state;
      const populations = clonePops(state.populations);
      let changed = false;
      for (const id of [...new Set(action.popIds)]) {
        const pop = populations[id];
        if (!pop || id === state.root_population_id) continue;
        if (parentId === pop.parent_id || wouldCreateCycle(populations, id, parentId)) continue;
        if (pop.parent_id && populations[pop.parent_id]) {
          populations[pop.parent_id].children = populations[pop.parent_id].children.filter((c) => c !== id);
        }
        linkChildToParent(populations, id, parentId);
        changed = true;
      }
      if (!changed) return state;
      sortPopulationTree(populations, state.root_population_id!);
      return { ...state, ...pushUndo(state), populations, gate_version: state.gate_version + 1 };
    }

    case "duplicateSelectedPopulations": {
      const populations = clonePops(state.populations);
      const names = new Set(Object.values(populations).map((p) => p.name));
      const copyName = (base: string) => {
        let n = `${base} copy`;
        let i = 2;
        while (names.has(n)) n = `${base} copy ${i++}`;
        names.add(n);
        return n;
      };
      let changed = false;
      for (const id of [...new Set(action.popIds)]) {
        const pop = populations[id];
        if (!pop || id === state.root_population_id || !pop.parent_id) continue;
        const clone = newPopulation(copyName(pop.name), pop.gate_refs.map((r) => ({ ...r })), pop.parent_id);
        clone.colorSlot = pickPopColorSlot(populations); // the copy gets its own stable slot
        populations[clone.population_id] = clone;
        linkChildToParent(populations, clone.population_id, pop.parent_id);
        changed = true;
      }
      if (!changed) return state;
      sortPopulationTree(populations, state.root_population_id!);
      return { ...state, ...pushUndo(state), populations, gate_version: state.gate_version + 1 };
    }

    case "addHierarchy": {
      if (!action.id || state.hierarchies.some((h) => h.id === action.id) || !action.populations[action.root_population_id]) return state;
      // Its own gates: the ones it arrives with (a duplicate brings copies of the source's), else
      // none. A hierarchy owns its geometry, so a new one never inherits what the previous had on
      // screen, and a tree whose references point outside the table it arrives with is refused
      // rather than stored as populations no gate can satisfy -- a workspace holding such a tree
      // cannot be saved.
      const gates = action.gates ? { ...action.gates } : {};
      for (const pop of Object.values(action.populations)) {
        if (pop.gate_refs.some((r) => !gates[r.gate_id])) return state;
      }
      const gate_order = (action.gate_order ?? Object.keys(gates)).filter((id) => gates[id]);
      const populations = clonePops(action.populations);
      ensurePopColorSlots(populations, action.root_population_id);
      const parked = parkActiveHierarchy(state);
      return {
        ...state,
        ...pushUndo(state),
        hierarchies: [...state.hierarchies, {
          id: action.id,
          name: action.name.trim() || DEFAULT_HIERARCHY_NAME,
          ...(action.owner_sample_id ? { owner_sample_id: action.owner_sample_id } : {}),
          ...(action.structure_locked !== undefined ? { structure_locked: action.structure_locked } : {}),
          ...(action.source_hierarchy_id ? { source_hierarchy_id: action.source_hierarchy_id } : {}),
          ...(action.source_gate_ids ? { source_gate_ids: { ...action.source_gate_ids } } : {}),
          ...(action.source_population_ids ? { source_population_ids: { ...action.source_population_ids } } : {}),
        }],
        active_hierarchy_id: action.id,
        stored_hierarchies: { ...state.stored_hierarchies, [parked.id]: parked },
        gates,
        gate_order,
        populations,
        root_population_id: action.root_population_id,
        active_population_id: action.root_population_id,
        selected_gate_id: null,
        selected_gate_ids: [],
        selected_pop_ids: [],
        gate_version: state.gate_version + 1,
      };
    }

    case "addHierarchyCopies": {
      if (!action.copies.length) return state;
      if (action.silent) {
        const { silent: _silent, ...plain } = action;
        void _silent;
        const next = reduceCore(state, plain);
        return next === state ? state : { ...next, undo: state.undo, redo: state.redo };
      }
      if (action.assignments) {
        const { assignments, ...plain } = action;
        const added = reduceCore(state, plain);
        if (added === state) return state;
        return withOneUndoEntry(state, reduceCore(added, { type: "assignFileHierarchies", assignments }));
      }
      const knownIds = new Set(state.hierarchies.map((hierarchy) => hierarchy.id));
      const incomingIds = new Set<string>();
      const copies: StoredHierarchy[] = [];
      for (const copy of action.copies) {
        if (!copy.id || knownIds.has(copy.id) || incomingIds.has(copy.id) ||
            !copy.root_population_id || !copy.populations[copy.root_population_id]) return state;
        const gates = { ...copy.gates };
        for (const pop of Object.values(copy.populations)) {
          if (pop.gate_refs.some((ref) => !gates[ref.gate_id])) return state;
        }
        const populations = clonePops(copy.populations);
        ensurePopColorSlots(populations, copy.root_population_id);
        incomingIds.add(copy.id);
        copies.push({
          ...copy,
          name: copy.name.trim() || DEFAULT_HIERARCHY_NAME,
          gates,
          gate_order: copy.gate_order.filter((id) => gates[id]),
          populations,
          active_population_id: copy.active_population_id && populations[copy.active_population_id]
            ? copy.active_population_id
            : copy.root_population_id,
          selected_pop_ids: copy.selected_pop_ids.filter((id) => populations[id]),
        });
      }
      const active = copies.find((copy) => copy.id === action.activeHierarchyId);
      if (!active && action.activeHierarchyId !== state.active_hierarchy_id) return state;
      const parked = parkActiveHierarchy(state);
      const stored_hierarchies = { ...state.stored_hierarchies, [parked.id]: parked };
      for (const copy of copies) stored_hierarchies[copy.id] = copy;
      if (!active) {
        delete stored_hierarchies[state.active_hierarchy_id];
        return {
          ...state,
          ...pushUndo(state),
          hierarchies: [
            ...state.hierarchies,
            ...copies.map(hierarchyRefFromStored),
          ],
          stored_hierarchies,
          tree_version: state.tree_version + 1,
        };
      }
      delete stored_hierarchies[active.id];
      return {
        ...state,
        ...pushUndo(state),
        hierarchies: [
          ...state.hierarchies,
          ...copies.map(hierarchyRefFromStored),
        ],
        active_hierarchy_id: active.id,
        stored_hierarchies,
        gates: active.gates,
        gate_order: active.gate_order,
        populations: active.populations,
        root_population_id: active.root_population_id,
        active_population_id: active.active_population_id,
        selected_gate_id: null,
        selected_gate_ids: [],
        selected_pop_ids: active.selected_pop_ids,
        ...(action.keepBrowsingPosition ? selectionAcrossHierarchies(parked, active, { ...stored_hierarchies, [active.id]: active }) : {}),
        gate_version: state.gate_version + 1,
      };
    }

    case "switchHierarchy": {
      const target = state.stored_hierarchies[action.id];
      if (!target || action.id === state.active_hierarchy_id) return state;
      const parked = parkActiveHierarchy(state);
      const stored_hierarchies = { ...state.stored_hierarchies, [parked.id]: parked };
      delete stored_hierarchies[action.id];
      return {
        ...state,
        ...(action.silent ? {} : pushUndo(state)),
        active_hierarchy_id: action.id,
        stored_hierarchies,
        gates: target.gates,
        gate_order: target.gate_order,
        populations: target.populations,
        root_population_id: target.root_population_id,
        ...selectionAcrossHierarchies(parked, target, { ...stored_hierarchies, [target.id]: target }),
        selected_gate_id: state.selected_gate_id
          ? correspondingHierarchyId(parked, state.selected_gate_id, target, { ...stored_hierarchies, [target.id]: target }, "gate")
          : null,
        selected_gate_ids: [],
        gate_version: state.gate_version + 1,
      };
    }

    case "revertGateToGroup": {
      if (!activeHierarchy || !isCopyRef(activeHierarchy) || !activeHierarchy.structure_locked || !activeHierarchy.source_hierarchy_id) return state;
      const own = state.gates[action.gateId];
      const sourceId = activeHierarchy.source_gate_ids?.[action.gateId];
      const source = sourceId ? state.stored_hierarchies[activeHierarchy.source_hierarchy_id]?.gates[sourceId] : null;
      if (!own || !source || gateGeometryEquals(own, source)) return state;
      // Keep local presentation and ids; restoring scientific geometry makes subsequent group edits follow again.
      const restored: Gate = { ...structuredClone(source), gate_id: own.gate_id, name: own.name, color: own.color, label_offset: own.label_offset };
      return { ...state, ...pushUndo(state), gates: { ...state.gates, [own.gate_id]: restored }, gate_version: state.gate_version + 1 };
    }

    case "applyGateToGroup": {
      const live = liveCopyAndTemplate(state);
      if (!live) return state;
      const { copy, template, all } = live;
      const own = copy.gates[action.gateId];
      const sourceId = copy.source_gate_ids?.[action.gateId];
      const source = sourceId ? template.gates[sourceId] : undefined;
      if (!own || !sourceId || !source || gateGeometryEquals(own, source)) return state;
      const after: StoredHierarchy = { ...template, gates: { ...template.gates, [sourceId]: withGeometryOf(source, own) } };
      const next = withTrees(state, resyncGroup(all, template, after), state.active_hierarchy_id);
      return { ...next, ...pushUndo(state), gate_version: state.gate_version + 1, tree_version: state.tree_version + 1 };
    }

    case "promoteCopyToTemplate": {
      const copyRef = state.hierarchies.find((h) => h.id === action.copyId);
      if (!copyRef || !isCopyRef(copyRef) || !copyRef.structure_locked || !copyRef.source_hierarchy_id) return state;
      const templateRef = state.hierarchies.find((h) => h.id === copyRef.source_hierarchy_id);
      if (!templateRef || templateRef.owner_sample_id) return state; // a copy of a copy: flatten first
      const parked = parkActiveHierarchy(state);
      const all = { ...state.stored_hierarchies, [parked.id]: parked };
      const copy = all[action.copyId];
      const template = all[templateRef.id];
      if (!copy?.root_population_id || !template?.root_population_id) return state;
      if (!copyInStep(copy, { ...template, root_population_id: template.root_population_id })) return state;
      // The template's gates take the copy's geometry, id by id; names and paint stay the template's.
      const gates = { ...template.gates };
      for (const [copyGateId, sourceId] of Object.entries(copy.source_gate_ids ?? {})) {
        const own = copy.gates[copyGateId];
        const source = template.gates[sourceId];
        if (own && source && !gateGeometryEquals(own, source)) gates[sourceId] = withGeometryOf(source, own);
      }
      const after: StoredHierarchy = { ...template, gates };
      let next = withTrees(state, resyncGroup(all, template, after), state.active_hierarchy_id);
      // Every file of the group goes back on the template; their copies, this one included, go
      // with the move, and the template becomes live if the live tree was one of them.
      const assignments: Record<string, string> = {};
      for (const [fileId, treeId] of Object.entries(state.file_hierarchies)) {
        const ref = state.hierarchies.find((h) => h.id === treeId);
        if (ref?.owner_sample_id && ref.source_hierarchy_id === template.id) assignments[fileId] = template.id;
      }
      if (Object.keys(assignments).length) next = reduceCore(next, { type: "assignFileHierarchies", assignments });
      return withOneUndoEntry(state, next);
    }

    case "replaceHierarchyCopies": {
      if (!action.copies.length) return state;
      if (action.added?.length || action.assignments) {
        const { added, assignments, ...plain } = action;
        let next = state;
        if (added?.length) {
          next = reduceCore(next, { type: "addHierarchyCopies", copies: added, activeHierarchyId: next.active_hierarchy_id });
          if (next === state) return state;
        }
        const replaced = reduceCore(next, plain);
        if (replaced === next) return state;
        next = replaced;
        if (assignments) next = reduceCore(next, { type: "assignFileHierarchies", assignments });
        return withOneUndoEntry(state, next);
      }
      const parked = parkActiveHierarchy(state);
      const all = { ...state.stored_hierarchies, [parked.id]: parked };
      const ids = new Set<string>();
      for (const copy of action.copies) {
        const old = all[copy.id];
        if (!old?.owner_sample_id || copy.owner_sample_id !== old.owner_sample_id || ids.has(copy.id) ||
            !copy.root_population_id || !copy.populations[copy.root_population_id] ||
            Object.values(copy.populations).some((pop) => pop.gate_refs.some((ref) => !copy.gates[ref.gate_id]))) return state;
        ids.add(copy.id);
        all[copy.id] = copy;
      }
      const live = all[state.active_hierarchy_id];
      delete all[state.active_hierarchy_id];
      return {
        ...state, ...pushUndo(state),
        hierarchies: state.hierarchies.map((ref) => ids.has(ref.id) ? hierarchyRefFromStored(action.copies.find((copy) => copy.id === ref.id)!) : ref),
        stored_hierarchies: all,
        gates: live.gates, gate_order: live.gate_order, populations: live.populations,
        root_population_id: live.root_population_id, active_population_id: live.active_population_id,
        selected_pop_ids: live.selected_pop_ids,
        selected_gate_id: state.selected_gate_id && live.gates[state.selected_gate_id] ? state.selected_gate_id : null,
        selected_gate_ids: state.selected_gate_ids.filter((id) => live.gates[id]),
        gate_version: state.gate_version + 1,
      };
    }

    case "unlinkHierarchy": {
      const ref = state.hierarchies.find((hierarchy) => hierarchy.id === action.id);
      if (!ref?.owner_sample_id && !ref?.source_hierarchy_id) return state;
      const hierarchies = state.hierarchies.map((hierarchy) => (hierarchy.id === action.id ? unlinkedRef(hierarchy) : hierarchy));
      const stored = state.stored_hierarchies[action.id];
      return {
        ...state,
        ...pushUndo(state, false),
        hierarchies,
        stored_hierarchies: stored
          ? { ...state.stored_hierarchies, [action.id]: unlinkedRef(stored) }
          : state.stored_hierarchies,
        tree_version: state.tree_version + 1,
      };
    }

    case "setHierarchyStructureLocked": {
      const ref = state.hierarchies.find((hierarchy) => hierarchy.id === action.id);
      if (!ref?.owner_sample_id || ref.structure_locked === action.locked) return state;
      const hierarchies = state.hierarchies.map((hierarchy) =>
        hierarchy.id === action.id ? { ...hierarchy, structure_locked: action.locked } : hierarchy);
      const stored = state.stored_hierarchies[action.id];
      return {
        ...state,
        ...pushUndo(state, false),
        hierarchies,
        stored_hierarchies: stored
          ? { ...state.stored_hierarchies, [action.id]: { ...stored, structure_locked: action.locked } }
          : state.stored_hierarchies,
        tree_version: state.tree_version + 1,
      };
    }

    case "renameHierarchy": {
      const name = action.name.trim();
      const ref = state.hierarchies.find((h) => h.id === action.id);
      if (!ref || !name || ref.name === name) return state;
      const hierarchies = state.hierarchies.map((h) => (h.id === action.id ? { ...h, name } : h));
      const stored = state.stored_hierarchies[action.id];
      return {
        ...state,
        ...pushUndo(state, false),
        hierarchies,
        stored_hierarchies: stored ? { ...state.stored_hierarchies, [action.id]: { ...stored, name } } : state.stored_hierarchies,
        tree_version: state.tree_version + 1,
      };
    }

    case "deleteHierarchy": {
      if (state.hierarchies.length < 2 || !state.hierarchies.some((h) => h.id === action.id)) return state;
      // A template's copies lose their link rather than their tree: each becomes a hierarchy of
      // its own, still gating its file, with nothing left to follow.
      const hierarchies = state.hierarchies
        .filter((h) => h.id !== action.id)
        .map((h) => (h.source_hierarchy_id === action.id ? unlinkedRef(h) : h));
      const unlinkedStored: Record<string, StoredHierarchy> = {};
      for (const h of state.hierarchies) {
        if (h.source_hierarchy_id !== action.id) continue;
        const stored = state.stored_hierarchies[h.id];
        if (stored) unlinkedStored[h.id] = unlinkedRef(stored);
      }
      // Files gated directly under it fall back to the first hierarchy, which is what an absent
      // assignment means; files on its copies keep them, now as trees of their own.
      const file_hierarchies = Object.fromEntries(
        Object.entries(state.file_hierarchies).filter(([, id]) => id !== action.id),
      );
      if (action.id !== state.active_hierarchy_id) {
        const stored_hierarchies = { ...state.stored_hierarchies, ...unlinkedStored };
        delete stored_hierarchies[action.id];
        return { ...state, ...pushUndo(state, false), hierarchies, stored_hierarchies, file_hierarchies, tree_version: state.tree_version + 1 };
      }
      // Deleting the active hierarchy: the next one in the menu becomes live.
      const next = hierarchies[0];
      const target = { ...state.stored_hierarchies, ...unlinkedStored }[next.id];
      if (!target) return state;
      const stored_hierarchies = { ...state.stored_hierarchies, ...unlinkedStored };
      delete stored_hierarchies[next.id];
      return {
        ...state,
        ...pushUndo(state),
        hierarchies,
        active_hierarchy_id: next.id,
        stored_hierarchies,
        file_hierarchies,
        // The deleted hierarchy's gates go with it; the next one brings its own.
        gates: target.gates,
        gate_order: target.gate_order,
        populations: target.populations,
        root_population_id: target.root_population_id,
        active_population_id: target.active_population_id && target.populations[target.active_population_id]
          ? target.active_population_id
          : target.root_population_id,
        selected_gate_id: null,
        selected_gate_ids: [],
        selected_pop_ids: target.selected_pop_ids.filter((id) => target.populations[id]),
        gate_version: state.gate_version + 1,
      };
    }

    case "deleteGates": {
      const ids = [...new Set(action.gateIds)].filter((id) => id in state.gates);
      if (ids.length === 0) return state;
      const idSet = new Set(ids);
      const populations = clonePops(state.populations);
      // Cascade: quadrant gates take their populations with them (reparent children).
      for (const gid of ids) {
        if (state.gates[gid]?.gate_type !== "quadrant") continue;
        const quadPops = Object.keys(populations).filter((pid) =>
          populations[pid].gate_refs.some((r) => r.gate_id === gid),
        );
        for (const pid of quadPops) {
          if (populations[pid]) removePopulationReparentChildren(populations, pid);
        }
      }
      // Drop the gates and any remaining gate_refs pointing at them.
      const gates = { ...state.gates };
      for (const gid of ids) delete gates[gid];
      for (const pid of Object.keys(populations)) {
        const pop = populations[pid];
        if (pop.gate_refs.some((r) => idSet.has(r.gate_id))) {
          pop.gate_refs = pop.gate_refs.filter((r) => !idSet.has(r.gate_id));
        }
      }
      if (state.root_population_id) sortPopulationTree(populations, state.root_population_id);
      // Each hierarchy owns its gates, so the parked ones are untouched: a hierarchy that holds
      // a gate under the same id (a duplicate, or an old workspace's shared ids) keeps it.
      const active =
        state.active_population_id && populations[state.active_population_id]
          ? state.active_population_id
          : state.root_population_id;
      return {
        ...state,
        ...pushUndo(state),
        gates,
        gate_order: state.gate_order.filter((g) => g in gates),
        populations,
        selected_gate_id: state.selected_gate_id && idSet.has(state.selected_gate_id) ? null : state.selected_gate_id,
        selected_gate_ids: state.selected_gate_ids.filter((g) => !idSet.has(g)),
        active_population_id: active,
        selected_pop_ids: state.selected_pop_ids.filter((id) => populations[id]),
        gate_version: state.gate_version + 1,
      };
    }

    case "importGating": {
      const shouldMerge = action.mode === "merge" && state.root_population_id !== null &&
        state.populations[state.root_population_id] !== undefined;
      const graph = shouldMerge
        ? mergeGatingStrategies(
            {
              gates: state.gates,
              gate_order: state.gate_order,
              populations: state.populations,
              root_population_id: state.root_population_id!,
            },
            {
              gates: action.gates,
              gate_order: action.gate_order,
              populations: action.populations,
              root_population_id: action.root_population_id,
            },
            action.attachTo && state.populations[action.attachTo] ? action.attachTo : state.root_population_id!,
          )
        : action;
      // GatingML populations carry no colorSlot — backfill so imported pops get stable, frozen colours.
      const importedPops = clonePops(graph.populations);
      ensurePopColorSlots(importedPops, graph.root_population_id);
      // Replacing the active hierarchy no longer touches the parked ones: each owns its gates,
      // so there is nothing to retain on their behalf. This used to hold on to any gate a parked
      // hierarchy referenced, which is what made one shared table necessary in the first place.
      const gates = graph.gates;
      const gate_order = graph.gate_order;
      const activePopulationId = shouldMerge && state.active_population_id && importedPops[state.active_population_id]
        ? state.active_population_id
        : graph.root_population_id;
      return {
        ...state,
        ...(action.clearHistory ? { undo: [], redo: [] } : pushUndo(state)),
        gates,
        gate_order,
        populations: importedPops,
        root_population_id: graph.root_population_id,
        active_population_id: activePopulationId,
        selected_gate_id: shouldMerge && state.selected_gate_id && graph.gates[state.selected_gate_id]
          ? state.selected_gate_id
          : null,
        selected_pop_ids: shouldMerge
          ? state.selected_pop_ids.filter((id) => importedPops[id])
          : [],
        selected_gate_ids: shouldMerge
          ? state.selected_gate_ids.filter((id) => graph.gates[id])
          : [],
        gate_version: state.gate_version + 1,
      };
    }

    case "loadWorkspace": {
      // Restore a saved gating tree wholesale (fresh undo history). Backfill colorSlot for pops from
      // a pre-colorSlot workspace or a GatingML import (which has none), so colours are stable + frozen.
      const loadedPops = clonePops(action.populations);
      ensurePopColorSlots(loadedPops, action.root_population_id);
      const hierarchies = action.hierarchies?.length
        ? action.hierarchies.map((h) => ({ ...h }))
        : [{ id: DEFAULT_HIERARCHY_ID, name: DEFAULT_HIERARCHY_NAME }];
      // A group whose tree is missing is no group; a membership naming no listed group is dropped.
      const loadedGroups = (action.groups ?? []).filter((g) => hierarchies.some((h) => h.owner_group_id === g.id));
      const active_hierarchy_id = action.active_hierarchy_id && hierarchies.some((h) => h.id === action.active_hierarchy_id)
        ? action.active_hierarchy_id
        : hierarchies[0].id;
      const stored_hierarchies: Record<string, StoredHierarchy> = {};
      for (const h of action.stored_hierarchies ?? []) {
        if (h.id === active_hierarchy_id || !hierarchies.some((ref) => ref.id === h.id)) continue;
        const pops = clonePops(h.populations);
        ensurePopColorSlots(pops, h.root_population_id);
        stored_hierarchies[h.id] = { ...h, populations: pops, selected_pop_ids: [] };
      }
      return {
        ...state,
        gates: action.gates,
        gate_order: action.gate_order,
        populations: loadedPops,
        root_population_id: action.root_population_id,
        active_population_id: action.active_population_id,
        selected_gate_id: action.selected_gate_id,
        selected_pop_ids: [],
        selected_gate_ids: [],
        hierarchies,
        active_hierarchy_id,
        stored_hierarchies,
        file_hierarchies: knownAssignments(action.file_hierarchies ?? {}, hierarchies),
        groups: loadedGroups,
        file_groups: Object.fromEntries(Object.entries(action.file_groups ?? {}).filter(([, gid]) => loadedGroups.some((g) => g.id === gid))),
        gate_version: state.gate_version + 1,
        undo: [],
        redo: [],
      };
    }

    case "assignFileHierarchies": {
      const known = new Set(state.hierarchies.map((h) => h.id));
      const next = { ...state.file_hierarchies };
      let changed = false;
      for (const [fileId, treeId] of Object.entries(action.assignments)) {
        if (treeId === null || !known.has(treeId)) {
          if (fileId in next) { delete next[fileId]; changed = true; }
        } else if (next[fileId] !== treeId) {
          next[fileId] = treeId; changed = true;
        }
      }
      if (!changed) return state;
      const assigned = { ...state, file_hierarchies: next };
      // Silent: the same move, orphan copies dropped the same way, but history untouched; a
      // navigation that drops an untailored copy loses nothing worth an entry.
      if (action.silent) return { ...dropOrphanCopies(assigned), undo: state.undo, redo: state.redo, gate_version: state.gate_version + 1 };
      return withOneUndoEntry(state, dropOrphanCopies(assigned));
    }

    case "clearGateSelection":
      return { ...state, selected_gate_ids: [] };

    case "clearPopSelection":
      return { ...state, selected_pop_ids: [] };

    case "sortGatesAlpha": {
      const order = [...state.gate_order].sort((a, b) => {
        const na = (state.gates[a]?.name || a).toLowerCase();
        const nb = (state.gates[b]?.name || b).toLowerCase();
        return na < nb ? -1 : na > nb ? 1 : a < b ? -1 : a > b ? 1 : 0;
      });
      return { ...state, gate_order: order };
    }

    case "sortPopulationsAlpha": {
      if (!state.root_population_id || !state.populations[state.root_population_id]) return state;
      const populations = clonePops(state.populations);
      sortPopulationTreeAlpha(populations, state.root_population_id);
      const changed = Object.keys(state.populations).some((popId) =>
        !sameStringArray(
          state.populations[popId].children,
          populations[popId]?.children ?? [],
        ),
      );
      if (!changed) return state;
      return {
        ...state,
        ...pushUndo(state, false),
        populations,
        tree_version: state.tree_version + 1,
      };
    }

    case "undo": {
      if (state.undo.length === 0) return state;
      const prev = state.undo[0];
      const { affects_gating: affectsGating, ...previousGraph } = prev;
      return {
        ...state,
        ...previousGraph,
        undo: state.undo.slice(1),
        redo: [snapshot(state, affectsGating), ...state.redo].slice(0, MAX_UNDO),
        gate_version: affectsGating ? state.gate_version + 1 : state.gate_version,
        tree_version: affectsGating ? state.tree_version : state.tree_version + 1,
      };
    }

    case "redo": {
      if (state.redo.length === 0) return state;
      const next = state.redo[0];
      const { affects_gating: affectsGating, ...nextGraph } = next;
      return {
        ...state,
        ...nextGraph,
        redo: state.redo.slice(1),
        undo: [snapshot(state, affectsGating), ...state.undo].slice(0, MAX_UNDO),
        gate_version: affectsGating ? state.gate_version + 1 : state.gate_version,
        tree_version: affectsGating ? state.tree_version : state.tree_version + 1,
      };
    }

    default:
      return state;
  }
}

/** Drop quadrant gates once no population references them any more
 *  (.prune_orphaned_quadrant_gates). Poly/rect gates persist even if unreferenced. */
function pruneOrphanQuadrantGates(
  gates: Record<string, Gate>,
  populations: PopulationMap,
): Record<string, Gate> {
  const referenced = new Set<string>();
  for (const pid of Object.keys(populations)) {
    for (const ref of populations[pid].gate_refs) referenced.add(ref.gate_id);
  }
  let changed = false;
  const out: Record<string, Gate> = {};
  for (const gid of Object.keys(gates)) {
    if (gates[gid].gate_type === "quadrant" && !referenced.has(gid)) {
      changed = true;
      continue;
    }
    out[gid] = gates[gid];
  }
  return changed ? out : gates;
}

/** Shallow-clone each population (so applyGatingStrategy's count writes don't
 *  mutate a prior snapshot); children arrays are replaced on structural edits. */
function clonePops(pops: PopulationMap): PopulationMap {
  const out: PopulationMap = {};
  for (const k of Object.keys(pops)) out[k] = { ...pops[k], children: [...pops[k].children] };
  return out;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameGateRefs(left: readonly GateRef[], right: readonly GateRef[]): boolean {
  return left.length === right.length && left.every((ref, index) => {
    const next = right[index];
    return !!next &&
      ref.gate_id === next.gate_id &&
      ref.include === next.include &&
      ref.quadrant === next.quadrant;
  });
}

function validPopulationGateRefs(
  gates: Readonly<Record<string, Gate>>,
  refs: readonly GateRef[],
): boolean {
  const seen = new Set<string>();
  for (const ref of refs) {
    const gate = gates[ref.gate_id];
    const key = `${ref.gate_id}:${ref.quadrant ?? ""}`;
    if (!gate || seen.has(key)) return false;
    seen.add(key);
    if (
      (gate.gate_type === "quadrant" &&
        (!Number.isInteger(ref.quadrant) || ref.quadrant! < 1 || ref.quadrant! > 4)) ||
      (gate.gate_type !== "quadrant" && ref.quadrant !== undefined)
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Derived stats — apply the strategy and compute the tree's counts/percentages
// ---------------------------------------------------------------------------

export interface TreeStats {
  event_count: Record<string, number | null>;
  percent_of_parent: Record<string, number | null>;
  percent_of_total: Record<string, number | null>;
}

export interface Derived {
  masks: MaskMap;
  stats: TreeStats;
  gateCounts: Record<string, GateCount>;
  activeMask: Uint8Array | null;
  /** Events to DRAW: union of the checked populations, else the active population. */
  displayMask: Uint8Array | null;
  /** Number of checked populations contributing to displayMask (0 → just the active pop). */
  displayPopCount: number;
  populations: PopulationMap; // with event_count / percent_of_parent filled in
}

export interface PopulationDisplaySelection {
  activeMask: Uint8Array | null;
  /** Events to draw: union of checked populations, otherwise the active population. */
  displayMask: Uint8Array | null;
  displayPopCount: number;
}

/** Expensive results that depend on data/gates, but not on the active population. */
export interface GatingDerived {
  masks: MaskMap;
  stats: TreeStats;
  populations: PopulationMap;
  gateMasks: GateMaskCache;
}

const EMPTY_DERIVED: Derived = {
  masks: {},
  stats: { event_count: {}, percent_of_parent: {}, percent_of_total: {} },
  gateCounts: {},
  activeMask: null,
  displayMask: null,
  displayPopCount: 0,
  populations: {},
};

const EMPTY_GATING_DERIVED: GatingDerived = {
  masks: {},
  stats: { event_count: {}, percent_of_parent: {}, percent_of_total: {} },
  populations: {},
  gateMasks: {},
};

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * One gate-mask memo per sample, so a regate only recomputes the gates that actually changed.
 *
 * Weakly held: a sample that leaves the workspace takes its memo with it. Each pooled sample
 * keeps its own, since a mask belongs to the columns it was measured on.
 */
const gateMaskMemos = new WeakMap<Sample, GateMaskMemo>();

/** Recompute full-data gate masks, population masks, and tree stats. */
export function recomputeGating(sample: Sample | null, state: CoreState): GatingDerived {
  if (!sample || !state.root_population_id || Object.keys(state.populations).length === 0) {
    return EMPTY_GATING_DERIVED;
  }
  const data = sample.gateAssayData();
  let memo = gateMaskMemos.get(sample);
  if (!memo) {
    memo = createGateMaskMemo();
    gateMaskMemos.set(sample, memo);
  }
  const gateMasks = computeGateMasks(state.gates, data, memo);
  const pops = clonePops(state.populations);
  const { masks, populations } = applyGatingStrategy(
    state.gates,
    pops,
    state.root_population_id,
    data,
    gateMasks,
  );

  const rootCount = populations[state.root_population_id].event_count ?? 0;
  const event_count: Record<string, number | null> = {};
  const percent_of_parent: Record<string, number | null> = {};
  const percent_of_total: Record<string, number | null> = {};
  for (const pid of Object.keys(populations)) {
    const pop = populations[pid];
    event_count[pid] = pop.event_count;
    percent_of_parent[pid] = pop.percent_of_parent;
    if (pid === state.root_population_id) percent_of_total[pid] = 100;
    else percent_of_total[pid] = rootCount > 0 ? round2(((pop.event_count ?? 0) / rootCount) * 100) : 0;
  }

  return {
    masks,
    stats: { event_count, percent_of_parent, percent_of_total },
    populations,
    gateMasks,
  };
}

/**
 * Derive the cheap, selection-specific view from stable gating results. This runs
 * when the active/checked population changes without recalculating any gate geometry.
 */
export function derivePopulationView(
  sample: Sample | null,
  state: CoreState,
  gating: GatingDerived,
): Derived {
  if (!sample || !state.root_population_id || Object.keys(gating.populations).length === 0) {
    return EMPTY_DERIVED;
  }
  const { masks, stats, populations, gateMasks } = gating;
  const data = sample.gateAssayData();

  const { activeMask, displayMask, displayPopCount } =
    derivePopulationDisplaySelection(sample, state, gating);
  const gateCounts = computeGateCounts(state.gates, activeMask, data, gateMasks);

  return {
    masks,
    stats,
    gateCounts,
    activeMask,
    displayMask,
    displayPopCount,
    populations,
  };
}

/**
 * Select the active/checked-population masks without recomputing gate counts.
 * The combined-sample gating display uses this cheap path for inactive files so
 * changing populations never scans every event once per gate and per file.
 */
export function derivePopulationDisplaySelection(
  sample: Sample | null,
  state: CoreState,
  gating: GatingDerived,
): PopulationDisplaySelection {
  if (!sample || !state.root_population_id || Object.keys(gating.populations).length === 0) {
    return { activeMask: null, displayMask: null, displayPopCount: 0 };
  }

  const activeId = state.active_population_id ?? state.root_population_id;
  const activeMask = gating.masks[activeId] ?? gating.masks[state.root_population_id] ?? null;
  const selectedIds = (state.selected_pop_ids ?? [])
    .filter((id) => gating.masks[id] && id !== state.root_population_id);
  if (selectedIds.length === 0) {
    return { activeMask, displayMask: activeMask, displayPopCount: 0 };
  }

  const union = new Uint8Array(sample.fcs.nEvents);
  for (const id of selectedIds) {
    const mask = gating.masks[id];
    for (let index = 0; index < union.length; index++) {
      if (mask[index]) union[index] = 1;
    }
  }
  return { activeMask, displayMask: union, displayPopCount: selectedIds.length };
}

/** One-shot compatibility helper for non-React callers and tests. */
export function recompute(sample: Sample | null, state: CoreState): Derived {
  return derivePopulationView(sample, state, recomputeGating(sample, state));
}
