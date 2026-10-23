// A gate's colour from its menu (setGateColour): the tree's gate and every copy's version of it,
// as one undo entry, display only. Synthetic files f1 and f2; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState } from "./store";
import { cloneHierarchyTree, storeHierarchy, type StoredHierarchy } from "./engine/hierarchies";

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
  for (const name of ["Cells", "CD4_positive"]) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name, xChannel: "FSC-A", yChannel: "SSC-A",
      vertices: [[0, 0], [100, 100]], createPop: { name, parentId: state.active_population_id! } });
  }
  const template = storeHierarchy(state.hierarchies[0], state);
  const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
  // f1's copy of the tree, and f2's copy of f1's copy: a copy of a copy, as a file under a group has.
  const a = cloneHierarchyTree(template.populations, template.root_population_id!, template.gates, template.gate_order);
  const c1: StoredHierarchy = { id: "c1", name: "f1 · Main", owner_sample_id: "f1", structure_locked: true, source_hierarchy_id: "main",
    source_gate_ids: invert(a.gateIdMap), source_population_ids: invert(a.idMap),
    gates: a.gates, gate_order: a.gate_order, populations: a.populations, root_population_id: a.root_population_id,
    active_population_id: a.root_population_id, selected_pop_ids: [] };
  const b = cloneHierarchyTree(c1.populations, c1.root_population_id!, c1.gates, c1.gate_order);
  const c2: StoredHierarchy = { ...c1, id: "c2", name: "f2 · Main", owner_sample_id: "f2", source_hierarchy_id: "c1",
    source_gate_ids: invert(b.gateIdMap), source_population_ids: invert(b.idMap),
    gates: b.gates, gate_order: b.gate_order, populations: b.populations, root_population_id: b.root_population_id, active_population_id: b.root_population_id };
  state = coreReducer(state, { type: "addHierarchyCopies", copies: [c1, c2], activeHierarchyId: "main", assignments: { f1: "c1", f2: "c2" } });
  return { state, cells: state.gate_order[0], other: state.gate_order[1] };
}

describe("a gate's colour", () => {
  it("recolours the tree's gate and every copy's version of it, through a copy of a copy, as one undo entry", () => {
    const { state, cells, other } = fixture();
    const next = coreReducer(state, { type: "setGateColour", gateId: cells, colour: "#4DAF4A" });
    expect(next.gates[cells].color).toBe("#4daf4a");
    expect(next.gates[other].color).toBe(state.gates[other].color);
    for (const id of ["c1", "c2"]) {
      const tree = next.stored_hierarchies[id];
      const own = Object.entries(tree.gates).map(([, g]) => g.color);
      expect(own.filter((c) => c === "#4daf4a")).toHaveLength(1);
    }
    // Geometry and gating are untouched.
    expect(JSON.stringify({ ...next.gates[cells], color: null })).toBe(JSON.stringify({ ...state.gates[cells], color: null }));
    expect(next.undo.length).toBe(state.undo.length + 1);
    const undone = coreReducer(next, { type: "undo" });
    expect(undone.gates[cells].color).toBe(state.gates[cells].color);
    expect(Object.values(undone.stored_hierarchies.c2.gates).some((g) => g.color === "#4daf4a")).toBe(false);
  });

  it("refuses anything but #rrggbb, and the colour it already has", () => {
    const { state, cells } = fixture();
    expect(coreReducer(state, { type: "setGateColour", gateId: cells, colour: "green" })).toBe(state);
    expect(coreReducer(state, { type: "setGateColour", gateId: cells, colour: state.gates[cells].color })).toBe(state);
    expect(coreReducer(state, { type: "setGateColour", gateId: "missing", colour: "#4daf4a" })).toBe(state);
  });
});
