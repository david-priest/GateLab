// Clear gates and populations: start gating again on the same files. Everything gating goes,
// hierarchies and assignments included; the undo entry brings it all back.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState } from "./store";
import { cloneHierarchyTree, storeHierarchy, type StoredHierarchy } from "./engine/hierarchies";

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
  const copy: StoredHierarchy = { id: "c1", name: "D1 · Main", owner_sample_id: "f1", structure_locked: true, source_hierarchy_id: "main",
    source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
    gates: c.gates, gate_order: c.gate_order, populations: c.populations, root_population_id: c.root_population_id,
    active_population_id: c.root_population_id, selected_pop_ids: [] };
  state = coreReducer(state, { type: "addHierarchyCopies", copies: [copy], activeHierarchyId: "c1", assignments: { f1: "c1", f2: "main" } });
  return state;
}

describe("clearGating", () => {
  it("leaves one empty hierarchy and no assignments, and one Undo restores everything", () => {
    const before = fixture();
    expect(Object.keys(before.gates)).toHaveLength(2);
    expect(before.hierarchies.map((h) => h.id)).toEqual(["main", "c1"]);

    const cleared = coreReducer(before, { type: "clearGating", nEvents: 250 });
    expect(cleared.gates).toEqual({});
    expect(cleared.gate_order).toEqual([]);
    expect(cleared.hierarchies.map((h) => h.id)).toEqual(["main"]);
    expect(cleared.stored_hierarchies).toEqual({});
    expect(cleared.file_hierarchies).toEqual({});
    expect(Object.keys(cleared.populations)).toHaveLength(1);
    const root = cleared.populations[cleared.root_population_id!];
    expect(root.name).toBe("All Events");
    expect(cleared.active_population_id).toBe(cleared.root_population_id);
    expect(cleared.gate_version).toBe(before.gate_version + 1);
    expect(cleared.undo).toHaveLength(before.undo.length + 1);

    const restored = coreReducer(cleared, { type: "undo" });
    expect(restored.gates).toEqual(before.gates);
    expect(restored.hierarchies).toEqual(before.hierarchies);
    expect(restored.stored_hierarchies).toEqual(before.stored_hierarchies);
    expect(restored.file_hierarchies).toEqual(before.file_hierarchies);
    expect(restored.active_hierarchy_id).toBe("c1");
    expect(coreReducer(restored, { type: "redo" }).gates).toEqual({});
  });
});
