// File-to-tree assignments live in the store, so that Undo restores them together with the
// copies they point at, and so that pointing a file elsewhere drops the copy it leaves behind.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "./store";
import { cloneHierarchyTree, emptyHierarchyTree, storeHierarchy, type StoredHierarchy } from "./engine/hierarchies";
import { copyTailoring } from "./engine/copyTailoring";

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
  for (const name of ["Cells", "CD4_positive"]) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name,
      xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [100, 100]],
      createPop: { name, parentId: state.active_population_id! } });
  }
  const template = storeHierarchy(state.hierarchies[0], state);
  const makeCopy = (id: string, owner: string, source = template): StoredHierarchy => {
    const c = cloneHierarchyTree(source.populations, source.root_population_id!, source.gates, source.gate_order);
    const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
    return { id, name: `${owner} · Main`, owner_sample_id: owner, structure_locked: true, source_hierarchy_id: source.id,
      source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
      gates: c.gates, gate_order: c.gate_order, populations: c.populations, root_population_id: c.root_population_id,
      active_population_id: c.root_population_id, selected_pop_ids: [] };
  };
  return { state, template, makeCopy };
}
const live = (s: CoreState) => storeHierarchy(s.hierarchies.find((h) => h.id === s.active_hierarchy_id)!, s);
const ids = (s: CoreState) => s.hierarchies.map((h) => h.id);

describe("file assignments in the store", () => {
  it("merges, drops unknown trees, and comes back with Undo and Redo", () => {
    const { state } = fixture();
    const next = coreReducer(state, { type: "assignFileHierarchies", assignments: { f1: "main", f2: "nope" } });
    expect(next.file_hierarchies).toEqual({ f1: "main" });
    expect(next.undo.length).toBe(state.undo.length + 1);
    expect(coreReducer(next, { type: "assignFileHierarchies", assignments: { f1: "main" } })).toBe(next);
    const undone = coreReducer(next, { type: "undo" });
    expect(undone.file_hierarchies).toEqual({});
    expect(coreReducer(undone, { type: "redo" }).file_hierarchies).toEqual({ f1: "main" });
    const cleared = coreReducer(next, { type: "assignFileHierarchies", assignments: { f1: null } });
    expect(cleared.file_hierarchies).toEqual({});
  });

  it("adds copies and their assignments as one undo entry", () => {
    const { state, makeCopy } = fixture();
    const copy = makeCopy("c1", "f1");
    const next = coreReducer(state, { type: "addHierarchyCopies", copies: [copy], activeHierarchyId: "c1", assignments: { f1: "c1" } });
    expect(ids(next)).toEqual(["main", "c1"]);
    expect(next.active_hierarchy_id).toBe("c1");
    expect(next.file_hierarchies).toEqual({ f1: "c1" });
    expect(next.undo.length).toBe(state.undo.length + 1);
    const undone = coreReducer(next, { type: "undo" });
    expect(ids(undone)).toEqual(["main"]);
    expect(undone.file_hierarchies).toEqual({});
    expect(undone.active_hierarchy_id).toBe("main");
  });

  it("drops a copy whose file moves to another tree, making the file's new tree live, in one entry", () => {
    const { state, makeCopy } = fixture();
    const copy = makeCopy("c1", "f1");
    let next = coreReducer(state, { type: "addHierarchyCopies", copies: [copy], activeHierarchyId: "c1", assignments: { f1: "c1" } });
    next = coreReducer(next, { type: "editGate", gateId: copy.gate_order[0], vertices: [[5, 5], [50, 50]] });
    const before = next;
    // Revert to group: the file follows the template again; its copy, now nobody's, goes.
    next = coreReducer(next, { type: "assignFileHierarchies", assignments: { f1: "main" } });
    expect(ids(next)).toEqual(["main"]);
    expect(next.active_hierarchy_id).toBe("main");
    expect(next.file_hierarchies).toEqual({ f1: "main" });
    expect(next.undo.length).toBe(before.undo.length + 1);
    const undone = coreReducer(next, { type: "undo" });
    expect(ids(undone)).toEqual(["main", "c1"]);
    expect(undone.active_hierarchy_id).toBe("c1");
    expect(undone.file_hierarchies).toEqual({ f1: "c1" });
    const tailored = undone.gates[copy.gate_order[0]];
    expect(tailored && "vertices" in tailored ? tailored.vertices : null).toEqual([[5, 5], [50, 50]]);
  });

  it("keeps a copy that another tree derives from, and a copy whose file was merely removed", () => {
    const { state, makeCopy } = fixture();
    const copy = makeCopy("c1", "f1");
    const child = makeCopy("c2", "f2", copy);
    let next = coreReducer(state, { type: "addHierarchyCopies", copies: [copy, child], activeHierarchyId: "main", assignments: { f1: "c1", f2: "c2" } });
    next = coreReducer(next, { type: "assignFileHierarchies", assignments: { f1: "main" } });
    expect(ids(next)).toEqual(["main", "c1", "c2"]); // c1 is c2's source
    const removed = coreReducer(next, { type: "assignFileHierarchies", assignments: { f2: null }, silent: true });
    expect(ids(removed)).toEqual(["main", "c1", "c2"]); // no assignment at all is not "assigned elsewhere"
    expect(removed.file_hierarchies).toEqual({ f1: "main" });
    expect(removed.undo).toEqual(next.undo); // bookkeeping, no history
  });

  it("replaces copies, adds the missing ones and assigns, as one undo entry", () => {
    const { state, template, makeCopy } = fixture();
    const source = makeCopy("c1", "f1");
    let next = coreReducer(state, { type: "addHierarchyCopies", copies: [source], activeHierarchyId: "c1", assignments: { f1: "c1" } });
    next = coreReducer(next, { type: "editGate", gateId: source.gate_order[0], vertices: [[20, 0], [120, 100]] });
    const before = next;
    const tailoredSource = live(next);
    const fresh = makeCopy("c2", "f2");
    const trees = { ...next.stored_hierarchies, c1: tailoredSource, c2: fresh };
    const replacement = copyTailoring(tailoredSource, fresh, template, trees);
    next = coreReducer(next, { type: "replaceHierarchyCopies", copies: [replacement], added: [fresh], assignments: { f2: "c2" } });
    expect(ids(next)).toEqual(["main", "c1", "c2"]);
    expect(next.file_hierarchies).toEqual({ f1: "c1", f2: "c2" });
    const moved = next.stored_hierarchies.c2.gates[replacement.gate_order[0]];
    expect(moved && "vertices" in moved ? moved.vertices : null).toEqual([[20, 0], [120, 100]]);
    expect(next.undo.length).toBe(before.undo.length + 1);
    const undone = coreReducer(next, { type: "undo" });
    expect(ids(undone)).toEqual(["main", "c1"]);
    expect(undone.file_hierarchies).toEqual({ f1: "c1" });
  });

  it("moves assignments with a deleted tree and keeps them on unlinked copies", () => {
    const { state, makeCopy } = fixture();
    const copy = makeCopy("c1", "f1");
    let next = coreReducer(state, { type: "addHierarchy", id: "other", name: "Other", ...emptyHierarchyTree(100) });
    next = coreReducer(next, { type: "switchHierarchy", id: "main" });
    next = coreReducer(next, { type: "addHierarchyCopies", copies: [copy], activeHierarchyId: "main", assignments: { f1: "c1", f2: "main", f3: "other" } });
    const gone = coreReducer(next, { type: "deleteHierarchy", id: "main" });
    expect(gone.file_hierarchies).toEqual({ f1: "c1", f3: "other" }); // f2 falls back; c1 is unlinked but keeps f1
    expect(gone.hierarchies.find((h) => h.id === "c1")?.source_hierarchy_id).toBeUndefined();
    expect(coreReducer(gone, { type: "undo" }).file_hierarchies).toEqual({ f1: "c1", f2: "main", f3: "other" });
  });

  it("loads only assignments that name a listed hierarchy", () => {
    const { state } = fixture();
    const loaded = coreReducer(state, {
      type: "loadWorkspace",
      gates: state.gates, gate_order: state.gate_order, populations: state.populations,
      root_population_id: state.root_population_id, active_population_id: state.active_population_id,
      selected_gate_id: null,
      hierarchies: [{ id: "main", name: "Main" }, { id: "h2", name: "Second" }],
      active_hierarchy_id: "main",
      stored_hierarchies: [{ ...live(state), id: "h2", name: "Second" }],
      file_hierarchies: { f1: "h2", f2: "gone" },
    });
    expect(loaded.file_hierarchies).toEqual({ f1: "h2" });
    expect(loaded.undo).toEqual([]);
    expect(coreReducer(loaded, { type: "newWorkspace" }).file_hierarchies).toEqual({});
  });
});
