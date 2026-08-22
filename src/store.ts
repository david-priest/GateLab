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
} from "./engine/models";
import {
  applyGatingStrategy,
  computeGateCounts,
  computeGateMasks,
  pickPopColorSlot,
  ensurePopColorSlots,
  type MaskMap,
  type GateCount,
  type GateMaskCache,
} from "./engine/populations";
import { mergeGatingStrategies, type GatingImportMode } from "./engine/gatingMerge";
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
  undo: Snapshot[];
  redo: Snapshot[];
}

interface Snapshot {
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string | null;
  active_population_id: string | null;
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
    undo: [],
    redo: [],
  };
}

function snapshot(s: CoreState, affectsGating = true): Snapshot {
  return {
    gates: s.gates,
    gate_order: s.gate_order,
    populations: s.populations,
    root_population_id: s.root_population_id,
    active_population_id: s.active_population_id,
    affects_gating: affectsGating,
  };
}

/** Push an undo snapshot, clear redo (call before a structural change). */
function pushUndo(s: CoreState, affectsGating = true): Pick<CoreState, "undo" | "redo"> {
  return { undo: [snapshot(s, affectsGating), ...s.undo].slice(0, MAX_UNDO), redo: [] };
}

export type Action =
  | { type: "newWorkspace" }
  | { type: "loadSample"; nEvents: number }
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
      type: "addQuadrant";
      xChannel: string;
      yChannel: string;
      /** center already in the gate's own space (see `space`) */
      center: [number, number];
      prefix: string;
      parentId: string;
      space?: GateSpace;
      transforms?: GateTransforms;
    }
  | { type: "addPopulation"; name: string; parentId: string; gateRefs: GateRef[] }
  | { type: "setActivePopulation"; popId: string }
  | { type: "selectGate"; gateId: string | null }
  | { type: "toggleGateSelect"; gateId: string; checked: boolean }
  | { type: "togglePopSelect"; popId: string; checked: boolean }
  | { type: "renameGate"; gateId: string; name: string }
  | { type: "moveGateLabel"; gateId: string; labelOffset: [number, number] }
  | { type: "editGate"; gateId: string; vertices: [number, number][] } // dragged poly/rect vertices (gating space)
  | { type: "moveQuadrantCenter"; gateId: string; center: [number, number] } // dragged crosshair (gating space)
  | { type: "renamePopulation"; popId: string; name: string }
  | { type: "setPopulationGateRefs"; popId: string; gateRefs: GateRef[] }
  | {
      type: "movePopulation";
      popId: string;
      targetId: string;
      placement: "before" | "inside" | "after";
    }
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
    }
  | { type: "undo" }
  | { type: "redo" };

export function coreReducer(state: CoreState, action: Action): CoreState {
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
      const gates = { ...state.gates, [qgate.gate_id]: qgate };
      const gate_order = [...state.gate_order, qgate.gate_id];
      const populations: PopulationMap = clonePops(state.populations);
      const parentId = populations[action.parentId] ? action.parentId : state.root_population_id!;
      // Quadrant 1=x-/y+, 2=x+/y+, 3=x+/y-, 4=x-/y- ; name each by channel signs.
      const sgn: [string, string][] = [["-", "+"], ["+", "+"], ["+", "-"], ["-", "-"]];
      let lastPop = parentId;
      for (let q = 1; q <= 4; q++) {
        let qn = `${action.xChannel}${sgn[q - 1][0]} ${action.yChannel}${sgn[q - 1][1]}`;
        if (action.prefix) qn = `${action.prefix}: ${qn}`;
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

    case "renameGate": {
      if (!state.gates[action.gateId]) return state;
      const gates = { ...state.gates, [action.gateId]: { ...state.gates[action.gateId], name: action.name } };
      return { ...state, ...pushUndo(state), gates, gate_version: state.gate_version + 1 };
    }

    case "moveGateLabel": {
      const g = state.gates[action.gateId];
      if (!g) return state;
      // Cosmetic — no undo/version bump; new gates ref so the plot payload re-renders.
      return {
        ...state,
        gates: { ...state.gates, [action.gateId]: { ...g, label_offset: action.labelOffset } },
      };
    }

    case "editGate": {
      const g = state.gates[action.gateId];
      if (!g || g.gate_type === "quadrant") return state; // only poly/rect have vertices
      const gates = { ...state.gates, [action.gateId]: { ...g, vertices: action.vertices } };
      return { ...state, ...pushUndo(state), gates, gate_version: state.gate_version + 1 };
    }

    case "moveQuadrantCenter": {
      const g = state.gates[action.gateId];
      if (!g || g.gate_type !== "quadrant") return state;
      const gates = { ...state.gates, [action.gateId]: { ...g, center: action.center } };
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

    case "movePopulation": {
      const source = state.populations[action.popId];
      const target = state.populations[action.targetId];
      if (
        !source ||
        !target ||
        action.popId === state.root_population_id ||
        action.popId === action.targetId
      ) {
        return state;
      }

      const destinationParentId =
        action.placement === "inside" ? action.targetId : target.parent_id;
      if (
        !destinationParentId ||
        !state.populations[destinationParentId] ||
        wouldCreateCycle(state.populations, action.popId, destinationParentId)
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
      const oldParentId = source.parent_id;
      if (oldParentId && populations[oldParentId]) {
        populations[oldParentId].children = populations[oldParentId].children.filter(
          (childId) => childId !== action.popId,
        );
      }

      const destination = populations[destinationParentId];
      const destinationChildren = destination.children.filter(
        (childId) => childId !== action.popId,
      );
      let insertionIndex = destinationChildren.length;
      if (action.placement !== "inside") {
        const targetIndex = destinationChildren.indexOf(action.targetId);
        if (targetIndex < 0) return state;
        insertionIndex = targetIndex + (action.placement === "after" ? 1 : 0);
      }
      destinationChildren.splice(insertionIndex, 0, action.popId);
      destination.children = destinationChildren;
      populations[action.popId].parent_id = destinationParentId;
      if (state.root_population_id) sortPopulationTree(populations, state.root_population_id);

      const parentChanged = oldParentId !== destinationParentId;
      if (
        !parentChanged &&
        oldParentId &&
        sameStringArray(
          state.populations[oldParentId].children,
          populations[oldParentId].children,
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
          )
        : action;
      // GatingML populations carry no colorSlot — backfill so imported pops get stable, frozen colours.
      const importedPops = clonePops(graph.populations);
      ensurePopColorSlots(importedPops, graph.root_population_id);
      const activePopulationId = shouldMerge && state.active_population_id && importedPops[state.active_population_id]
        ? state.active_population_id
        : graph.root_population_id;
      return {
        ...state,
        ...(action.clearHistory ? { undo: [], redo: [] } : pushUndo(state)),
        gates: graph.gates,
        gate_order: graph.gate_order,
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
        gate_version: state.gate_version + 1,
        undo: [],
        redo: [],
      };
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

/** Recompute full-data gate masks, population masks, and tree stats. */
export function recomputeGating(sample: Sample | null, state: CoreState): GatingDerived {
  if (!sample || !state.root_population_id || Object.keys(state.populations).length === 0) {
    return EMPTY_GATING_DERIVED;
  }
  const data = sample.gateAssayData();
  const gateMasks = computeGateMasks(state.gates, data);
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
