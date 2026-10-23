// An edit of a gate in a tree that is not live (editGateIn): the viewed file's own copy is edited
// while the tree stays live, as the Gating tab does for a gate the file tailors with the edit
// target on the tree. Synthetic files f1 to f3; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "./store";
import { cloneHierarchyTree, storeHierarchy, type StoredHierarchy } from "./engine/hierarchies";

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
  for (const name of ["Cells", "CD4_positive"]) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name,
      xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [100, 100]],
      createPop: { name, parentId: state.active_population_id! } });
  }
  const template = storeHierarchy(state.hierarchies[0], state);
  const makeCopy = (id: string, owner: string): StoredHierarchy => {
    const c = cloneHierarchyTree(template.populations, template.root_population_id!, template.gates, template.gate_order);
    const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
    return { id, name: `${owner} · Main`, owner_sample_id: owner, structure_locked: true, source_hierarchy_id: "main",
      source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
      gates: c.gates, gate_order: c.gate_order, populations: c.populations, root_population_id: c.root_population_id,
      active_population_id: c.root_population_id, selected_pop_ids: [] };
  };
  const a = makeCopy("c1", "f1"), b = makeCopy("c2", "f2");
  state = coreReducer(state, { type: "addHierarchyCopies", copies: [a, b], activeHierarchyId: "c1", assignments: { f1: "c1", f2: "c2", f3: "main" } });
  // f1 tailors its first gate; then the tree is live again, as with the edit target on the tree.
  state = coreReducer(state, { type: "editGate", gateId: a.gate_order[0], vertices: [[5, 5], [50, 50]] });
  state = coreReducer(state, { type: "switchHierarchy", id: "main" });
  state = coreReducer(state, { type: "selectGate", gateId: state.gate_order[1] });
  return { state, a, b };
}
const verts = (g: unknown) => (g as { vertices: number[][] }).vertices;

describe("editGateIn", () => {
  it("moves the copy's gate and nothing else, keeps the tree live and the selection, as one undo entry", () => {
    const { state: before, a, b } = fixture();
    const treeGate = before.gate_order[0];
    const after = coreReducer(before, { type: "editGateIn", hierarchyId: "c1", edit: { type: "editGate", gateId: a.gate_order[0], vertices: [[10, 10], [60, 60]] } });
    expect(verts(after.stored_hierarchies.c1.gates[a.gate_order[0]])).toEqual([[10, 10], [60, 60]]);
    expect(verts(after.gates[treeGate])).toEqual([[0, 0], [100, 100]]);
    expect(verts(after.stored_hierarchies.c2.gates[b.gate_order[0]])).toEqual([[0, 0], [100, 100]]);
    expect(after.active_hierarchy_id).toBe("main");
    expect(after.selected_gate_id).toBe(before.selected_gate_id);
    expect(after.active_population_id).toBe(before.active_population_id);
    expect(after.gate_version).toBeGreaterThan(before.gate_version);
    expect(after.undo.length).toBe(before.undo.length + 1);
    const undone = coreReducer(after, { type: "undo" });
    expect(verts(undone.stored_hierarchies.c1.gates[a.gate_order[0]])).toEqual([[5, 5], [50, 50]]);
    expect(undone.active_hierarchy_id).toBe("main");
  });

  it("reverts the copy's gate to the tree's coordinates without making the copy live", () => {
    const { state, a } = fixture();
    const after = coreReducer(state, { type: "editGateIn", hierarchyId: "c1", edit: { type: "revertGateToGroup", gateId: a.gate_order[0] } });
    expect(verts(after.stored_hierarchies.c1.gates[a.gate_order[0]])).toEqual([[0, 0], [100, 100]]);
    expect(after.active_hierarchy_id).toBe("main");
    expect(after.undo.length).toBe(state.undo.length + 1);
  });

  it("gives the tree the copy's coordinates, and the copies that followed follow, the tree still live", () => {
    const { state, a, b } = fixture();
    const after = coreReducer(state, { type: "editGateIn", hierarchyId: "c1", edit: { type: "applyGateToGroup", gateId: a.gate_order[0] } });
    expect(after.active_hierarchy_id).toBe("main");
    expect(verts(after.gates[after.gate_order[0]])).toEqual([[5, 5], [50, 50]]);
    expect(verts(after.stored_hierarchies.c2.gates[b.gate_order[0]])).toEqual([[5, 5], [50, 50]]);
    expect(after.gates[after.gate_order[0]].name).toBe("Cells");
    expect(after.undo.length).toBe(state.undo.length + 1);
  });

  it("is the edit itself on the live tree, and nothing on a tree that is not there", () => {
    const { state } = fixture();
    const direct = coreReducer(state, { type: "editGate", gateId: state.gate_order[1], vertices: [[1, 1], [2, 2]] });
    const wrapped = coreReducer(state, { type: "editGateIn", hierarchyId: "main", edit: { type: "editGate", gateId: state.gate_order[1], vertices: [[1, 1], [2, 2]] } });
    expect(verts(wrapped.gates[state.gate_order[1]])).toEqual(verts(direct.gates[state.gate_order[1]]));
    const missing: CoreState = coreReducer(state, { type: "editGateIn", hierarchyId: "nowhere", edit: { type: "editGate", gateId: "g", vertices: [[1, 1], [2, 2]] } });
    expect(missing).toBe(state);
  });
});
