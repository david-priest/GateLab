// A file's tree can become the group's: one gate (FlowJo's "apply to group") or the whole tree,
// after which every file of the group follows the template again and nothing is tailored.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "./store";
import { cloneHierarchyTree, storeHierarchy, type StoredHierarchy } from "./engine/hierarchies";
import { gateGeometryEquals, tailoredGateIds } from "./engine/templateSync";

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
  return { state, template, a, b };
}
const live = (s: CoreState) => storeHierarchy(s.hierarchies.find((h) => h.id === s.active_hierarchy_id)!, s);
const verts = (g: unknown) => (g as { vertices: number[][] }).vertices;
const tmpl = (s: CoreState) => {
  const t = s.active_hierarchy_id === "main" ? live(s) : s.stored_hierarchies.main;
  return { ...t, root_population_id: t.root_population_id! };
};

describe("apply one gate to the group", () => {
  it("gives the template this copy's geometry and every following copy along with it, undoably", () => {
    let { state, a, b } = fixture();
    const gateA = a.gate_order[0];
    state = coreReducer(state, { type: "editGate", gateId: gateA, vertices: [[5, 5], [50, 50]] });
    expect(tailoredGateIds(live(state), tmpl(state)).has(gateA)).toBe(true);
    const before = state;
    state = coreReducer(state, { type: "applyGateToGroup", gateId: gateA });
    expect(state.undo.length).toBe(before.undo.length + 1);
    // The template's gate moved; this copy is no longer tailored; the other copy followed.
    const sourceId = a.source_gate_ids![gateA];
    expect(verts(state.stored_hierarchies.main.gates[sourceId])).toEqual([[5, 5], [50, 50]]);
    expect(state.stored_hierarchies.main.gates[sourceId].name).toBe("Cells");
    expect(tailoredGateIds(live(state), tmpl(state)).size).toBe(0);
    expect(verts(state.stored_hierarchies.c2.gates[b.gate_order[0]])).toEqual([[5, 5], [50, 50]]);
    expect(state.active_hierarchy_id).toBe("c1");
    const undone = coreReducer(state, { type: "undo" });
    expect(verts(undone.stored_hierarchies.main.gates[sourceId])).toEqual([[0, 0], [100, 100]]);
    expect(verts(undone.stored_hierarchies.c2.gates[b.gate_order[0]])).toEqual([[0, 0], [100, 100]]);
  });

  it("does nothing for a gate that already matches, or when the live tree is a template", () => {
    const { state, a } = fixture();
    expect(coreReducer(state, { type: "applyGateToGroup", gateId: a.gate_order[0] })).toBe(state);
    const onMain = coreReducer(state, { type: "switchHierarchy", id: "main" });
    expect(coreReducer(onMain, { type: "applyGateToGroup", gateId: onMain.gate_order[0] })).toBe(onMain);
  });

  it("leaves a copy that tailored the same gate its own way alone", () => {
    let { state, a, b } = fixture();
    state = coreReducer(state, { type: "editGate", gateId: a.gate_order[0], vertices: [[5, 5], [50, 50]] });
    state = coreReducer(state, { type: "switchHierarchy", id: "c2" });
    state = coreReducer(state, { type: "editGate", gateId: b.gate_order[0], vertices: [[9, 9], [90, 90]] });
    state = coreReducer(state, { type: "switchHierarchy", id: "c1" });
    state = coreReducer(state, { type: "applyGateToGroup", gateId: a.gate_order[0] });
    expect(verts(state.stored_hierarchies.c2.gates[b.gate_order[0]])).toEqual([[9, 9], [90, 90]]);
  });
});

describe("promote a copy to the group's template", () => {
  it("moves every gate's geometry to the template and puts every file back on it, as one undo entry", () => {
    let { state, a, b } = fixture();
    state = coreReducer(state, { type: "editGate", gateId: a.gate_order[0], vertices: [[5, 5], [50, 50]] });
    state = coreReducer(state, { type: "editGate", gateId: a.gate_order[1], vertices: [[7, 7], [70, 70]] });
    state = coreReducer(state, { type: "switchHierarchy", id: "c2" });
    state = coreReducer(state, { type: "editGate", gateId: b.gate_order[0], vertices: [[9, 9], [90, 90]] });
    state = coreReducer(state, { type: "switchHierarchy", id: "c1" });
    const before = state;
    state = coreReducer(state, { type: "promoteCopyToTemplate", copyId: "c1" });
    expect(state.undo.length).toBe(before.undo.length + 1);
    // One tree for everyone: the template, with c1's geometry, and no copies left.
    expect(state.hierarchies.map((h) => h.id)).toEqual(["main"]);
    expect(state.active_hierarchy_id).toBe("main");
    expect(state.file_hierarchies).toEqual({ f1: "main", f2: "main", f3: "main" });
    const [gA, gB] = state.gate_order;
    expect(verts(state.gates[gA])).toEqual([[5, 5], [50, 50]]);
    expect(verts(state.gates[gB])).toEqual([[7, 7], [70, 70]]);
    expect(state.gates[gA].name).toBe("Cells");
    const undone = coreReducer(state, { type: "undo" });
    expect(undone.hierarchies.map((h) => h.id)).toEqual(["main", "c1", "c2"]);
    expect(undone.active_hierarchy_id).toBe("c1");
    expect(undone.file_hierarchies).toEqual({ f1: "c1", f2: "c2", f3: "main" });
    expect(verts(undone.stored_hierarchies.main.gates[gA])).toEqual([[0, 0], [100, 100]]);
    expect(verts(undone.stored_hierarchies.c2.gates[b.gate_order[0]])).toEqual([[9, 9], [90, 90]]);
  });

  it("promotes a parked copy too, and refuses a template, an unlinked tree or a copy of a copy", () => {
    let { state, a } = fixture();
    state = coreReducer(state, { type: "editGate", gateId: a.gate_order[0], vertices: [[5, 5], [50, 50]] });
    state = coreReducer(state, { type: "switchHierarchy", id: "main" });
    const promoted = coreReducer(state, { type: "promoteCopyToTemplate", copyId: "c1" });
    expect(promoted.hierarchies.map((h) => h.id)).toEqual(["main"]);
    expect(verts(promoted.gates[promoted.gate_order[0]])).toEqual([[5, 5], [50, 50]]);
    expect(gateGeometryEquals(promoted.gates[promoted.gate_order[1]], state.gates[state.gate_order[1]])).toBe(true);
    expect(coreReducer(state, { type: "promoteCopyToTemplate", copyId: "main" })).toBe(state);
    const unlinked = coreReducer(state, { type: "unlinkHierarchy", id: "c2" });
    expect(coreReducer(unlinked, { type: "promoteCopyToTemplate", copyId: "c2" })).toBe(unlinked);
  });
});
