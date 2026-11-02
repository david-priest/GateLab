// Renaming a tree renames its copies that are still named after it: an imported tree's copies were
// left as "D2.fcs · Imported strategy" after the tree was renamed.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState } from "./store";
import { cloneHierarchyTree, storeHierarchy, type StoredHierarchy } from "./engine/hierarchies";

function fixture(names: Record<string, string>) {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
  state = coreReducer(state, { type: "addGate", gateType: "rectangle", name: "Cells",
    xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [100, 100]],
    createPop: { name: "Cells", parentId: state.active_population_id! } });
  state = coreReducer(state, { type: "renameHierarchy", id: "main", name: "Imported strategy" });
  const template = storeHierarchy(state.hierarchies[0], state);
  const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
  const copies: StoredHierarchy[] = Object.entries(names).map(([fileId, name], i) => {
    const c = cloneHierarchyTree(template.populations, template.root_population_id!, template.gates, template.gate_order);
    return { id: `c${i + 1}`, name, owner_sample_id: fileId, structure_locked: true, source_hierarchy_id: "main",
      source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
      gates: c.gates, gate_order: c.gate_order, populations: c.populations, root_population_id: c.root_population_id,
      active_population_id: c.root_population_id, selected_pop_ids: [] };
  });
  const assignments = Object.fromEntries(copies.map((c) => [c.owner_sample_id!, c.id]));
  return coreReducer(state, { type: "addHierarchyCopies", copies, activeHierarchyId: "main", assignments });
}

const names = (s: ReturnType<typeof fixture>) => Object.fromEntries(s.hierarchies.map((h) => [h.id, h.name]));

describe("renameHierarchy", () => {
  it("renames the copies still named after the tree, and keeps a name the user gave", () => {
    const before = fixture({
      f1: "D1.fcs · Imported strategy",
      f2: "D2.fcs · Imported strategy 2",
      f3: "D3.fcs · copy of Imported strategy",
      f4: "Donor 4 adjusted",
      f5: "D5.fcs · Imported strategy (old)",
    });
    const after = coreReducer(before, { type: "renameHierarchy", id: "main", name: "Panel (S8)" });
    expect(names(after)).toEqual({
      main: "Panel (S8)",
      c1: "D1.fcs · Panel (S8)",
      c2: "D2.fcs · Panel (S8) 2",
      c3: "D3.fcs · copy of Panel (S8)",
      c4: "Donor 4 adjusted",
      c5: "D5.fcs · Imported strategy (old)",
    });
    // A parked copy's stored tree carries the name too, so a save writes it.
    expect(after.stored_hierarchies.c1.name).toBe("D1.fcs · Panel (S8)");
    // One undo takes the tree and its copies back together.
    expect(names(coreReducer(after, { type: "undo" }))).toEqual(names(before));
  });

  it("reads the old name as text, not as a pattern", () => {
    const before = fixture({ f1: "D1.fcs · Imported strategy" });
    const odd = coreReducer(before, { type: "renameHierarchy", id: "main", name: "Tree (A+B)*" });
    expect(names(odd).c1).toBe("D1.fcs · Tree (A+B)*");
    const again = coreReducer(odd, { type: "renameHierarchy", id: "main", name: "Tree 2" });
    expect(names(again).c1).toBe("D1.fcs · Tree 2");
  });
});
