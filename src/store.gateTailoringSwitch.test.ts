// A gate's tailoring switch for one file (setGateTailored): stored on the file's copy, not on the
// gate, so a gate is tailored from the moment it is switched on, before a drag has moved it.
// Synthetic files f1 and f2; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, switchedOnGateIds, type CoreState } from "./store";
import { cloneHierarchyTree, fileHierarchyId, storeHierarchy, type StoredHierarchy } from "./engine/hierarchies";

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
  for (const name of ["Cells", "CD4_positive"]) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name,
      xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [100, 100]],
      createPop: { name, parentId: state.active_population_id! } });
  }
  const template = storeHierarchy(state.hierarchies[0], state);
  const c = cloneHierarchyTree(template.populations, template.root_population_id!, template.gates, template.gate_order);
  const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
  const copy: StoredHierarchy = { id: "c1", name: "f1 · Main", owner_sample_id: "f1", structure_locked: true, source_hierarchy_id: "main",
    source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
    gates: c.gates, gate_order: c.gate_order, populations: c.populations, root_population_id: c.root_population_id,
    active_population_id: c.root_population_id, selected_pop_ids: [] };
  // f1's copy, made as the switch makes it: the tree stays live.
  state = coreReducer(state, { type: "addHierarchyCopies", copies: [copy], activeHierarchyId: "main", assignments: { f1: "c1", f2: "main" } });
  const cells = state.gate_order[0];
  return { state, cells, copyCells: copy.gate_order[0] };
}
const treeOfFile = (s: CoreState, fileId: string) => fileHierarchyId(s.file_hierarchies[fileId], s.hierarchies);
const verts = (g: unknown) => (g as { vertices: number[][] }).vertices;

describe("a gate's tailoring switch", () => {
  it("is on for the file at once, as one undo entry, and on the copy's record rather than the gate", () => {
    const { state, cells, copyCells } = fixture();
    const on = coreReducer(state, { type: "setGateTailored", fileId: "f1", gateId: cells, on: true });
    expect(switchedOnGateIds(on.hierarchies.find((h) => h.id === "c1"))).toEqual([copyCells]);
    expect(switchedOnGateIds(on.stored_hierarchies.c1)).toEqual([copyCells]);
    expect(on.stored_hierarchies.c1.gates[copyCells]).toEqual(state.stored_hierarchies.c1.gates[copyCells]);
    expect(on.active_hierarchy_id).toBe("main");
    expect(on.undo.length).toBe(state.undo.length + 1);
  });

  it("switched off with no drag leaves no copy and nothing switched on", () => {
    const { state, cells } = fixture();
    const on = coreReducer(state, { type: "setGateTailored", fileId: "f1", gateId: cells, on: true });
    const off = coreReducer(on, { type: "setGateTailored", fileId: "f1", gateId: cells, on: false });
    expect(treeOfFile(off, "f1")).toBe("main");
    expect(off.hierarchies.some((h) => h.id === "c1")).toBe(false);
    expect(off.stored_hierarchies.c1).toBeUndefined();
    // One Undo brings the switch, and the copy, back.
    const undone = coreReducer(off, { type: "undo" });
    expect(switchedOnGateIds(undone.hierarchies.find((h) => h.id === "c1"))).toHaveLength(1);
  });

  it("keeps a switched-on gate where it is when the tree moves; a gate not switched on follows", () => {
    const { state, cells, copyCells } = fixture();
    let next = coreReducer(state, { type: "setGateTailored", fileId: "f1", gateId: cells, on: true });
    next = coreReducer(next, { type: "editGate", gateId: cells, vertices: [[10, 10], [90, 90]] });
    expect(verts(next.stored_hierarchies.c1.gates[copyCells])).toEqual([[0, 0], [100, 100]]);
    const other = next.gate_order[1];
    next = coreReducer(next, { type: "editGate", gateId: other, vertices: [[20, 20], [80, 80]] });
    const copyOther = state.stored_hierarchies.c1.gate_order[1];
    expect(verts(next.stored_hierarchies.c1.gates[copyOther])).toEqual([[20, 20], [80, 80]]);
    expect(switchedOnGateIds(next.stored_hierarchies.c1)).toEqual([copyCells]);
  });

  it("switched off after a drag takes the tree's coordinates again, and the copy goes", () => {
    const { state, cells, copyCells } = fixture();
    let next = coreReducer(state, { type: "setGateTailored", fileId: "f1", gateId: cells, on: true });
    next = coreReducer(next, { type: "editGateIn", hierarchyId: "c1", edit: { type: "editGate", gateId: copyCells, vertices: [[5, 5], [50, 50]] } });
    next = coreReducer(next, { type: "setGateTailored", fileId: "f1", gateId: cells, on: false });
    expect(treeOfFile(next, "f1")).toBe("main");
    expect(next.hierarchies.some((h) => h.id === "c1")).toBe(false);
  });

  it("switched off with share gives the tree the file's coordinates first", () => {
    const { state, cells, copyCells } = fixture();
    let next = coreReducer(state, { type: "setGateTailored", fileId: "f1", gateId: cells, on: true });
    next = coreReducer(next, { type: "editGateIn", hierarchyId: "c1", edit: { type: "editGate", gateId: copyCells, vertices: [[5, 5], [50, 50]] } });
    next = coreReducer(next, { type: "setGateTailored", fileId: "f1", gateId: cells, on: false, share: true });
    expect(verts(next.gates[cells])).toEqual([[5, 5], [50, 50]]);
    expect(treeOfFile(next, "f1")).toBe("main");
  });

  it("goes with the file into a group, and is cleared when the file follows its tree again", () => {
    const { state, cells, copyCells } = fixture();
    let next = coreReducer(state, { type: "setGateTailored", fileId: "f1", gateId: cells, on: true });
    next = coreReducer(next, { type: "addGroup", id: "g1", name: "Treated", fileIds: ["f1"] });
    const tree = treeOfFile(next, "f1");
    expect(tree).toBe("c1");
    expect(switchedOnGateIds(next.hierarchies.find((h) => h.id === "c1"))).toEqual([copyCells]);
    next = coreReducer(next, { type: "revertCopyToSource", id: "c1" });
    expect(switchedOnGateIds(next.hierarchies.find((h) => h.id === "c1"))).toEqual([]);
  });
});
