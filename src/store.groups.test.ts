// Groups: a named set of files with a working tree of its own between the tree and the files'
// copies. Synthetic files D1 to D4 and gates Cells / CD4_positive throughout.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "./store";
import { storeHierarchy, type StoredHierarchy } from "./engine/hierarchies";
import { gateGeometryEquals, tailoredGateIds } from "./engine/templateSync";
import type { Gate } from "./engine/models";

function fixture(): CoreState {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
  for (const name of ["Cells", "CD4_positive"]) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name,
      xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [100, 100]],
      createPop: { name, parentId: state.active_population_id! } });
  }
  return state;
}
const live = (s: CoreState) => storeHierarchy(s.hierarchies.find((h) => h.id === s.active_hierarchy_id)!, s);
const treeOf = (s: CoreState, id: string): StoredHierarchy => (id === s.active_hierarchy_id ? live(s) : s.stored_hierarchies[id]);
const groupCopy = (s: CoreState, groupId: string) => s.hierarchies.find((h) => h.owner_group_id === groupId)!;
const fileTree = (s: CoreState, fileId: string) => s.hierarchies.find((h) => h.id === s.file_hierarchies[fileId]) ?? s.hierarchies[0];
const gateNamed = (t: StoredHierarchy, name: string): Gate => Object.values(t.gates).find((g) => g.name === name)!;
const moved = (gate: Gate, x: number): Gate => ({ ...gate, vertices: [[x, 0], [100 + x, 100]] } as Gate);
const verts = (gate: Gate): [number, number][] => (gate as unknown as { vertices: [number, number][] }).vertices;
const asTree = (t: StoredHierarchy) => ({ ...t, root_population_id: t.root_population_id! });
/** Tailor a file's Cells gate: its copy is made from whatever it follows, then edited. */
function tailorCells(state: CoreState, fileId: string, x: number): CoreState {
  const sourceId = state.file_hierarchies[fileId] ?? "main";
  const source = treeOf(state, sourceId);
  // A copy of the source, the way the app makes one, sourced from what the file follows.
  const ids = Object.fromEntries(Object.keys(source.gates).map((id) => [id, `${fileId}-${id.slice(0, 4)}`]));
  const pids = Object.fromEntries(Object.keys(source.populations).map((id) => [id, `${fileId}-p-${id.slice(0, 4)}`]));
  const copy: StoredHierarchy = {
    id: `copy-${fileId}`, name: `${fileId} · Main`, owner_sample_id: fileId, structure_locked: true, source_hierarchy_id: sourceId,
    source_gate_ids: Object.fromEntries(Object.entries(ids).map(([a, b]) => [b, a])),
    source_population_ids: Object.fromEntries(Object.entries(pids).map(([a, b]) => [b, a])),
    gates: Object.fromEntries(Object.entries(source.gates).map(([id, g]) => [ids[id], { ...structuredClone(g), gate_id: ids[id] }])),
    gate_order: source.gate_order.map((id) => ids[id]),
    populations: Object.fromEntries(Object.entries(source.populations).map(([id, p]) => [pids[id], {
      ...structuredClone(p), population_id: pids[id], parent_id: p.parent_id ? pids[p.parent_id] : null,
      children: p.children.map((c) => pids[c]), gate_refs: p.gate_refs.map((r) => ({ ...r, gate_id: ids[r.gate_id] })),
    }])),
    root_population_id: pids[source.root_population_id!], active_population_id: pids[source.root_population_id!], selected_pop_ids: [],
  };
  let next = coreReducer(state, { type: "addHierarchyCopies", copies: [copy], activeHierarchyId: copy.id, assignments: { [fileId]: copy.id } });
  const cells = gateNamed(live(next), "Cells");
  next = coreReducer(next, { type: "editGate", gateId: cells.gate_id, vertices: verts(moved(cells, x)) });
  return coreReducer(next, { type: "switchHierarchy", id: "main", silent: true });
}

describe("groups", () => {
  it("makes a locked copy of the tree for the group, and its first files follow it", () => {
    const state = fixture();
    const next = coreReducer(state, { type: "addGroup", id: "gA", name: "Group A", fileIds: ["D1", "D2"] });
    expect(next.groups).toEqual([{ id: "gA", name: "Group A" }]);
    const copy = groupCopy(next, "gA");
    expect(copy).toMatchObject({ name: "Group A", structure_locked: true, source_hierarchy_id: "main" });
    expect(copy.owner_sample_id).toBeUndefined();
    expect(next.file_groups).toEqual({ D1: "gA", D2: "gA" });
    expect(next.file_hierarchies).toEqual({ D1: copy.id, D2: copy.id });
    // The group's tree carries the tree's coordinates: nothing tailored yet.
    expect(tailoredGateIds(treeOf(next, copy.id), asTree(live(next))).size).toBe(0);
    expect(next.undo).toHaveLength(state.undo.length + 1);
    expect(coreReducer(next, { type: "undo" }).groups).toEqual([]);
    // A second group of the same name, or the same id, is refused.
    expect(coreReducer(next, { type: "addGroup", id: "gB", name: "Group A", fileIds: [] })).toBe(next);
  });

  it("adds a gate drawn while the group's tree is live to the tree for every file, the group and its files following", () => {
    const state = coreReducer(fixture(), { type: "addGroup", id: "gA", name: "Group A", fileIds: ["D1", "D2"] });
    const copy = groupCopy(state, "gA");
    const onGroup = coreReducer(state, { type: "switchHierarchy", id: copy.id, silent: true });
    const parentId = live(onGroup).root_population_id!;
    const next = coreReducer(onGroup, { type: "addGate", gateType: "rectangle", name: "CD8_positive",
      xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[10, 10], [60, 60]], createPop: { name: "CD8_positive", parentId } });
    // The edit target holds: the group's tree is still live, with the new gate selected in its own ids.
    expect(next.active_hierarchy_id).toBe(copy.id);
    const own = gateNamed(live(next), "CD8_positive");
    expect(own).toBeDefined();
    expect(next.selected_gate_id).toBe(own.gate_id);
    expect(Object.values(live(next).populations).some((p) => p.name === "CD8_positive")).toBe(true);
    // The tree has it, for every file, and the group's copy maps its own ids to the tree's.
    const inTree = gateNamed(treeOf(next, "main"), "CD8_positive");
    expect(inTree).toBeDefined();
    expect(live(next).source_gate_ids?.[own.gate_id]).toBe(inTree.gate_id);
    expect(gateGeometryEquals(own, inTree)).toBe(true);
    // One undo entry, and it puts everything back with the group's tree still live.
    expect(next.undo).toHaveLength(onGroup.undo.length + 1);
    const undone = coreReducer(next, { type: "undo" });
    expect(undone.active_hierarchy_id).toBe(copy.id);
    expect(Object.values(treeOf(undone, "main").gates).some((g) => g.name === "CD8_positive")).toBe(false);
    // Other structural edits on the copy are still refused.
    expect(coreReducer(next, { type: "renameGate", gateId: own.gate_id, name: "Renamed" })).toBe(next);
  });

  it("carries a tree edit through the group's tree to a file following the group", () => {
    let state = coreReducer(fixture(), { type: "addGroup", id: "gA", name: "Group A", fileIds: ["D1"] });
    const copyId = groupCopy(state, "gA").id;
    // D1 tailors CD4_positive only; Cells still follows the group, which follows the tree.
    state = tailorCells(state, "D1", 0); // a copy from the group's tree, Cells "moved" by 0: nothing tailored
    const d1 = fileTree(state, "D1");
    expect(d1.owner_sample_id).toBe("D1");
    expect(d1.source_hierarchy_id).toBe(copyId);
    const cells = gateNamed(live(state), "Cells");
    state = coreReducer(state, { type: "editGate", gateId: cells.gate_id, vertices: verts(moved(cells, 30)) });
    expect(verts(gateNamed(treeOf(state, copyId), "Cells"))).toEqual(verts(moved(cells, 30)));   // the group followed
    expect(verts(gateNamed(treeOf(state, d1.id), "Cells"))).toEqual(verts(moved(cells, 30)));    // and D1 followed the group
  });

  it("lets the group tailor a gate: its files follow the group, the tree is untouched", () => {
    let state = coreReducer(fixture(), { type: "addGroup", id: "gA", name: "Group A", fileIds: ["D1"] });
    const copyId = groupCopy(state, "gA").id;
    state = tailorCells(state, "D1", 0);
    const d1Id = fileTree(state, "D1").id;
    state = coreReducer(state, { type: "switchHierarchy", id: copyId, silent: true });
    const cells = gateNamed(live(state), "Cells");
    state = coreReducer(state, { type: "editGate", gateId: cells.gate_id, vertices: verts(moved(cells, 40)) });
    expect(verts(gateNamed(treeOf(state, d1Id), "Cells"))).toEqual(verts(moved(cells, 40)));
    expect(verts(gateNamed(treeOf(state, "main"), "Cells"))).not.toEqual(verts(moved(cells, 40)));
    // The group's tree is tailored against the tree; D1 follows the group.
    expect(tailoredGateIds(live(state), asTree(treeOf(state, "main"))).size).toBe(1);
    expect(tailoredGateIds(treeOf(state, d1Id), asTree(live(state))).size).toBe(0);
    // Apply to group from the group pushes it into the tree.
    state = coreReducer(state, { type: "applyGateToGroup", gateId: cells.gate_id });
    expect(verts(gateNamed(treeOf(state, "main"), "Cells"))).toEqual(verts(moved(cells, 40)));
    expect(tailoredGateIds(live(state), asTree(treeOf(state, "main"))).size).toBe(0);
  });

  it("moves a tailored file into a group with its coordinates, and out again, ids intact", () => {
    let state = tailorCells(fixture(), "D1", 25);
    const d1Id = fileTree(state, "D1").id;
    const d1Cells = gateNamed(treeOf(state, d1Id), "Cells");
    state = coreReducer(state, { type: "addGroup", id: "gA", name: "Group A", fileIds: [] });
    const copy = groupCopy(state, "gA");
    state = coreReducer(state, { type: "setFileGroup", fileIds: ["D1", "D2"], groupId: "gA" });
    expect(state.file_groups).toEqual({ D1: "gA", D2: "gA" });
    expect(state.file_hierarchies.D2).toBe(copy.id);          // no copy of its own: on the group's tree
    const d1 = fileTree(state, "D1");
    expect(d1.id).toBe(d1Id);                                  // the copy is the same copy
    expect(d1.source_hierarchy_id).toBe(copy.id);             // re-based onto the group
    expect(verts(gateNamed(treeOf(state, d1Id), "Cells"))).toEqual(verts(d1Cells));
    // Its provenance points at the group's gates now, and it still reads as tailored against them.
    const groupCells = gateNamed(treeOf(state, copy.id), "Cells");
    expect(d1.source_gate_ids?.[d1Cells.gate_id]).toBe(groupCells.gate_id);
    expect(tailoredGateIds(treeOf(state, d1Id), asTree(treeOf(state, copy.id))).size).toBe(1);
    // Out again: back onto the tree, coordinates kept; D2 simply follows the tree.
    state = coreReducer(state, { type: "setFileGroup", fileIds: ["D1", "D2"], groupId: null });
    expect(state.file_groups).toEqual({});
    expect(fileTree(state, "D1").source_hierarchy_id).toBe("main");
    expect(fileTree(state, "D1").source_gate_ids?.[d1Cells.gate_id]).toBe(gateNamed(treeOf(state, "main"), "Cells").gate_id);
    expect(verts(gateNamed(treeOf(state, d1Id), "Cells"))).toEqual(verts(d1Cells));
    expect(fileTree(state, "D2").id).toBe("main");
  });

  it("deletes a group: its tree goes, its files follow the tree, their own tailoring kept", () => {
    let state = coreReducer(fixture(), { type: "addGroup", id: "gA", name: "Group A", fileIds: ["D1", "D2"] });
    const copyId = groupCopy(state, "gA").id;
    state = tailorCells(state, "D1", 15);
    const d1Id = fileTree(state, "D1").id;
    const d1Cells = gateNamed(treeOf(state, d1Id), "Cells");
    state = coreReducer(state, { type: "switchHierarchy", id: copyId, silent: true });
    const before = state;
    state = coreReducer(state, { type: "deleteGroup", id: "gA" });
    expect(state.groups).toEqual([]);
    expect(state.hierarchies.some((h) => h.id === copyId)).toBe(false);
    expect(state.active_hierarchy_id).toBe("main");
    expect(state.file_groups).toEqual({});
    expect(fileTree(state, "D2").id).toBe("main");
    expect(fileTree(state, "D1").source_hierarchy_id).toBe("main");
    expect(gateGeometryEquals(gateNamed(treeOf(state, d1Id), "Cells"), d1Cells)).toBe(true);
    expect(state.undo).toHaveLength(before.undo.length + 1);
    const back = coreReducer(state, { type: "undo" });
    expect(back.groups).toEqual([{ id: "gA", name: "Group A" }]);
    expect(back.file_groups).toEqual({ D1: "gA", D2: "gA" });
  });

  it("renames a group and its tree; loads and drops groups with the workspace", () => {
    let state = coreReducer(fixture(), { type: "addGroup", id: "gA", name: "Group A", fileIds: ["D1"] });
    state = coreReducer(state, { type: "renameGroup", id: "gA", name: "Treated" });
    expect(state.groups[0].name).toBe("Treated");
    expect(groupCopy(state, "gA").name).toBe("Treated");
    const saved = { hierarchies: state.hierarchies, active_hierarchy_id: "main", stored_hierarchies: Object.values(state.stored_hierarchies), file_hierarchies: state.file_hierarchies, groups: state.groups, file_groups: state.file_groups };
    const t = live(state);
    const loaded = coreReducer(initialCoreState(), { type: "loadWorkspace", gates: t.gates, gate_order: t.gate_order, populations: t.populations, root_population_id: t.root_population_id, active_population_id: t.active_population_id, selected_gate_id: null, ...saved });
    expect(loaded.groups).toEqual([{ id: "gA", name: "Treated" }]);
    expect(loaded.file_groups).toEqual({ D1: "gA" });
    // A group whose tree is missing, or a membership naming no group, is dropped on load.
    const stale = coreReducer(initialCoreState(), { type: "loadWorkspace", gates: t.gates, gate_order: t.gate_order, populations: t.populations, root_population_id: t.root_population_id, active_population_id: t.active_population_id, selected_gate_id: null, groups: [{ id: "gone", name: "Gone" }], file_groups: { D1: "gone" } });
    expect(stale.groups).toEqual([]);
    expect(stale.file_groups).toEqual({});
  });
});
