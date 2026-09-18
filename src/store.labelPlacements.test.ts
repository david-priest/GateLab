// A gate label's placement is the gate's own: moved on any tree, it reaches every tree whose
// gate descends from the same original, so the Gating, Illustration and Layout tabs agree.
// Synthetic state throughout.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "./store";
import { cloneHierarchyTree, storeHierarchy, type StoredHierarchy } from "./engine/hierarchies";
import type { QuadrantGate } from "./engine/models";

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
  for (const name of ["Cells", "CD4_positive"]) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name,
      xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [100, 100]],
      createPop: { name, parentId: state.active_population_id! } });
  }
  state = coreReducer(state, { type: "addQuadrant", xChannel: "FSC-A", yChannel: "SSC-A", center: [50, 50], prefix: "", parentId: state.root_population_id! });
  const template = storeHierarchy(state.hierarchies[0], state);
  const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
  const makeCopy = (id: string, owner: string, source = template): StoredHierarchy => {
    const c = cloneHierarchyTree(source.populations, source.root_population_id!, source.gates, source.gate_order);
    return { id, name: `${owner} · Main`, owner_sample_id: owner, structure_locked: true, source_hierarchy_id: source.id,
      source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
      gates: c.gates, gate_order: c.gate_order, populations: c.populations, root_population_id: c.root_population_id,
      active_population_id: c.root_population_id, selected_pop_ids: [] };
  };
  // D1's copy of the template, and D2's copy of D1's copy: a chain, plus a tree of its own.
  const c1 = makeCopy("c1", "D1");
  const c2 = makeCopy("c2", "D2", c1);
  const other = makeCopy("other", "D3");
  delete other.source_hierarchy_id;
  delete other.source_gate_ids;
  delete other.source_population_ids;
  state = coreReducer(state, { type: "addHierarchyCopies", copies: [c1, c2, other], activeHierarchyId: "c1" });
  const byName = (tree: StoredHierarchy, name: string) => Object.values(tree.gates).find((g) => g.name === name)!.gate_id;
  return { state, template, c1, c2, other, byName };
}
const tree = (s: CoreState, id: string): StoredHierarchy =>
  id === s.active_hierarchy_id ? storeHierarchy(s.hierarchies.find((h) => h.id === id)!, s) : s.stored_hierarchies[id];

describe("gate label placements across trees", () => {
  it("a move on the active copy reaches the original, the copy's copy, and not an unrelated tree", () => {
    const { state, c1, c2, template, other, byName } = fixture();
    expect(state.active_hierarchy_id).toBe("c1");
    const undoDepth = state.undo.length;
    const next = coreReducer(state, { type: "moveGateLabel", gateId: byName(c1, "Cells"), labelOffset: [3, 4] });
    expect(next.gates[byName(c1, "Cells")].label_offset).toEqual([3, 4]);
    expect(next.stored_hierarchies.main.gates[byName(template, "Cells")].label_offset).toEqual([3, 4]);
    expect(next.stored_hierarchies.c2.gates[byName(c2, "Cells")].label_offset).toEqual([3, 4]);
    expect(next.stored_hierarchies.other.gates[byName(other, "Cells")].label_offset).toBe(other.gates[byName(other, "Cells")].label_offset);
    // The other gate of each tree is untouched, and the move is cosmetic: no undo entry, no version bump.
    expect(next.gates[byName(c1, "CD4_positive")]).toBe(state.gates[byName(c1, "CD4_positive")]);
    expect(next.stored_hierarchies.main.gates[byName(template, "CD4_positive")]).toBe(state.stored_hierarchies.main.gates[byName(template, "CD4_positive")]);
    expect(next.undo).toHaveLength(undoDepth);
    expect(next.gate_version).toBe(state.gate_version);
  });

  it("a move named on a parked tree reaches the active tree, quadrant labels included", () => {
    const { state, c1, c2, template, byName } = fixture();
    const quadrant = (t: StoredHierarchy) => Object.values(t.gates).find((g) => g.gate_type === "quadrant")!.gate_id;
    let next = coreReducer(state, { type: "moveGateLabel", hierarchyId: "main", gateId: byName(template, "CD4_positive"), labelOffset: [-1, 2] });
    expect(next.gates[byName(c1, "CD4_positive")].label_offset).toEqual([-1, 2]);
    expect(next.stored_hierarchies.c2.gates[byName(c2, "CD4_positive")].label_offset).toEqual([-1, 2]);
    next = coreReducer(next, { type: "moveGateLabel", hierarchyId: "c2", gateId: quadrant(c2), labelOffset: [5, 6], quadrant: 2 });
    expect((next.gates[quadrant(c1)] as QuadrantGate).quadrant_label_offsets).toEqual([null, null, [5, 6], null]);
    expect((next.stored_hierarchies.main.gates[quadrant(template)] as QuadrantGate).quadrant_label_offsets).toEqual([null, null, [5, 6], null]);
    expect(next.gates[quadrant(c1)].label_offset).toBe(state.gates[quadrant(c1)].label_offset);
    expect(tree(next, "c2").gates[quadrant(c2)].label_offset).toBe(c2.gates[quadrant(c2)].label_offset);
  });

  it("refuses a tree or gate it does not know, and a quadrant index on a rectangle", () => {
    const { state, c1, byName } = fixture();
    expect(coreReducer(state, { type: "moveGateLabel", hierarchyId: "nope", gateId: byName(c1, "Cells"), labelOffset: [1, 1] })).toBe(state);
    expect(coreReducer(state, { type: "moveGateLabel", gateId: "nope", labelOffset: [1, 1] })).toBe(state);
    expect(coreReducer(state, { type: "moveGateLabel", gateId: byName(c1, "Cells"), labelOffset: [1, 1], quadrant: 1 })).toBe(state);
  });
});
