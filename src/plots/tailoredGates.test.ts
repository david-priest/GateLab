// The tags on tailored gates (viewedFileGates, pooledFileVersions) name exactly the gates the file
// list's badge names (tailoredGateIds against what the copy follows), for the gates FlowJo
// imports bring: rectangles with open sides, as an adjusted quadrant arrives, and a copy on
// channels of its own. Synthetic files f1 to f3; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { cloneHierarchyTree, storeHierarchy, type StoredHierarchy } from "../engine/hierarchies";
import { onChannels } from "../engine/tailoredImport";
import { tailoredGateIds } from "../engine/templateSync";
import { UNBOUNDED, type Gate } from "../engine/models";
import { noFileFollowsTree, pooledVersions, viewedFileGates } from "./tailoredGates";
import { fileHierarchyId } from "../engine/hierarchies";

const U = UNBOUNDED;
/** Four rectangles, open on their outer sides, meeting at (x, y): a quadrant as FlowJo exports it. */
function quadrantRectangles(x: number, y: number): [number, number][][] {
  return [
    [[-U, y], [x, U]],
    [[x, y], [U, U]],
    [[-U, -U], [x, y]],
    [[x, -U], [U, y]],
  ];
}

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
  state = coreReducer(state, { type: "addGate", gateType: "polygon", name: "Cells", xChannel: "FSC-A", yChannel: "SSC-A",
    vertices: [[0, 0], [100, 0], [50, 100]], createPop: { name: "Cells", parentId: state.active_population_id! } });
  const parent = state.active_population_id!;
  quadrantRectangles(500, 800).forEach((vertices, i) => {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name: `Q${i + 1}`, xChannel: "CD4-A", yChannel: "CD8-A",
      vertices, createPop: { name: `Q${i + 1}`, parentId: parent } });
  });
  const template = storeHierarchy(state.hierarchies[0], state);
  const makeCopy = (id: string, owner: string, edit: (g: Gate) => Gate = (g) => g): StoredHierarchy => {
    const c = cloneHierarchyTree(template.populations, template.root_population_id!, template.gates, template.gate_order);
    const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
    const gates = Object.fromEntries(Object.entries(c.gates).map(([gid, g]) => [gid, edit(g)]));
    return { id, name: `${owner} · Main`, owner_sample_id: owner, structure_locked: true, source_hierarchy_id: "main",
      source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
      gates, gate_order: c.gate_order, populations: c.populations, root_population_id: c.root_population_id,
      active_population_id: c.root_population_id, selected_pop_ids: [] };
  };
  // f1 moved the quadrant's crosshair (its arms adjusted) and its Cells polygon.
  const moved = quadrantRectangles(620, 700);
  const f1 = makeCopy("c1", "f1", (g) => {
    if (g.gate_type === "rectangle") return { ...g, vertices: moved[Number(g.name.slice(1)) - 1] };
    if (g.gate_type === "polygon") return { ...g, vertices: [[5, 5], [100, 0], [50, 100]] };
    return g;
  });
  // f2 labels the CD4 detector differently: same coordinates, its own channel key.
  const f2 = makeCopy("c2", "f2", (g) => (g.x_channel === "CD4-A" ? onChannels(g, "CD4 own-A", g.y_channel) : g));
  // f3 follows the tree through a copy with nothing tailored.
  const f3 = makeCopy("c3", "f3");
  state = coreReducer(state, { type: "addHierarchyCopies", copies: [f1, f2, f3], activeHierarchyId: "main", assignments: { f1: "c1", f2: "c2", f3: "c3" } });
  return state;
}

const names = (state: CoreState, ids: Iterable<string>) => [...ids].map((id) => state.gates[id]?.name).sort();
const badge = (state: CoreState, copyId: string) => {
  const copy = state.stored_hierarchies[copyId];
  const tree = storeHierarchy(state.hierarchies.find((h) => h.id === "main")!, state);
  return [...tailoredGateIds(copy, { ...tree, root_population_id: tree.root_population_id! })].map((id) => copy.gates[id].name).sort();
};
const tagged = (state: CoreState, copyId: string) =>
  names(state, [...viewedFileGates(state, copyId)].filter(([, drawn]) => drawn.tailored).map(([gid]) => gid));

describe("tailored gate tags agree with the file list's badge", () => {
  it("tags every rectangle of an adjusted quadrant, open sides and all, and the moved polygon", () => {
    const state = fixture();
    expect(state.active_hierarchy_id).toBe("main");
    expect(badge(state, "c1")).toEqual(["Cells", "Q1", "Q2", "Q3", "Q4"]);
    expect(tagged(state, "c1")).toEqual(badge(state, "c1"));
    // Each is drawn as f1 has it, with the tree's version as its reference.
    const drawn = viewedFileGates(state, "c1");
    const q1 = Object.values(state.gates).find((g) => g.name === "Q1")!;
    expect((drawn.get(q1.gate_id)!.gate as { vertices: number[][] }).vertices).toEqual([[-U, 700], [620, U]]);
    expect((drawn.get(q1.gate_id)!.tailored!.reference as { vertices: number[][] }).vertices).toEqual([[-U, 800], [500, U]]);
  });

  it("tags a copy's gates on channels of its own as the badge counts them, and nothing on a copy that follows", () => {
    const state = fixture();
    expect(badge(state, "c2")).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(tagged(state, "c2")).toEqual(badge(state, "c2"));
    expect(badge(state, "c3")).toEqual([]);
    expect(tagged(state, "c3")).toEqual([]);
  });

  it("tags the same gates with the file's copy live, and the pool names the same files per gate", () => {
    let state = fixture();
    const pooled = pooledVersions(state, [{ fileId: "f1", treeId: "c1" }, { fileId: "f2", treeId: "c2" }, { fileId: "f3", treeId: "c3" }]);
    const q1 = Object.values(state.gates).find((g) => g.name === "Q1")!;
    const cells = Object.values(state.gates).find((g) => g.name === "Cells")!;
    expect(pooled.get(q1.gate_id)!.map((v) => v.fileIds)).toEqual([["f1"], ["f2"]]);
    expect(pooled.get(cells.gate_id)!.map((v) => v.fileIds)).toEqual([["f1"]]);
    // f3 follows the tree, so the tree's Q1 is still in use.
    expect(noFileFollowsTree(pooled.get(q1.gate_id), ["f1", "f2", "f3"])).toBe(false);
    expect(noFileFollowsTree(pooled.get(q1.gate_id), ["f1", "f2"])).toBe(true);
    state = coreReducer(state, { type: "switchHierarchy", id: "c1" });
    expect(names(state, [...viewedFileGates(state, "c1")].filter(([, d]) => d.tailored).map(([gid]) => gid))).toEqual(["Cells", "Q1", "Q2", "Q3", "Q4"]);
  });
});

/**
 * The ten-file case: D1 tailors Cells on its own, group A (five files) and group B (four) tailor it
 * in their groups' trees, so no file uses the tree's Cells.
 */
function tenFiles() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
  state = coreReducer(state, { type: "addGate", gateType: "polygon", name: "Cells", xChannel: "FSC-A", yChannel: "SSC-A",
    vertices: [[0, 0], [100, 0], [50, 100]], createPop: { name: "Cells", parentId: state.active_population_id! } });
  const groupA = ["A1", "A2", "A3", "A4", "A5"], groupB = ["B1", "B2", "B3", "B4"];
  state = coreReducer(state, { type: "addGroup", id: "gA", name: "Group A", fileIds: groupA });
  state = coreReducer(state, { type: "addGroup", id: "gB", name: "Group B", fileIds: groupB });
  const copyOf = (groupId: string) => state.hierarchies.find((h) => h.owner_group_id === groupId)!.id;
  const tailor = (treeId: string, vertices: [number, number][]) => {
    state = coreReducer(state, { type: "switchHierarchy", id: treeId });
    state = coreReducer(state, { type: "editGate", gateId: state.gate_order[0], vertices });
    state = coreReducer(state, { type: "switchHierarchy", id: "main" });
  };
  tailor(copyOf("gA"), [[10, 0], [100, 0], [50, 100]]);
  tailor(copyOf("gB"), [[20, 0], [100, 0], [50, 100]]);
  // D1's own copy of the tree, with its own Cells.
  const tree = storeHierarchy(state.hierarchies.find((h) => h.id === "main")!, state);
  const own = (id: string, owner: string, from: StoredHierarchy, vertices: [number, number][]): StoredHierarchy => {
    const c = cloneHierarchyTree(from.populations, from.root_population_id!, from.gates, from.gate_order);
    const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
    const gates = Object.fromEntries(Object.entries(c.gates).map(([gid, g]) => [gid, { ...g, vertices } as Gate]));
    return { id, name: `${owner} · ${from.name}`, owner_sample_id: owner, structure_locked: true, source_hierarchy_id: from.id,
      source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
      gates, gate_order: c.gate_order, populations: c.populations, root_population_id: c.root_population_id,
      active_population_id: c.root_population_id, selected_pop_ids: [] };
  };
  state = coreReducer(state, { type: "addHierarchyCopies", copies: [own("cD1", "D1", tree, [[30, 0], [100, 0], [50, 100]])], activeHierarchyId: "main", assignments: { D1: "cD1" } });
  const files = ["D1", ...groupA, ...groupB];
  const treeOf = (s: CoreState, fileId: string) => fileHierarchyId(s.file_hierarchies[fileId], s.hierarchies);
  return { state, files, groupA, groupB, copyOf, own, treeOf };
}

describe("ten files, every one off the tree's Cells", () => {
  it("pools one version per owner: one per group with its files, one for the file of its own", () => {
    const { state, files, treeOf, copyOf } = tenFiles();
    const cells = state.gate_order[0];
    const versions = pooledVersions(state, files.map((fileId) => ({ fileId, treeId: treeOf(state, fileId) })));
    const list = versions.get(cells)!;
    expect(list).toHaveLength(3);
    expect(list.map((v) => [v.owner.kind === "group" ? v.owner.name : (v.owner as { fileId: string }).fileId, v.fileIds.length, v.hierarchyId])).toEqual([
      ["D1", 1, "cD1"], ["Group A", 5, copyOf("gA")], ["Group B", 4, copyOf("gB")],
    ]);
    expect((list[1].gate as { vertices: number[][] }).vertices[0]).toEqual([10, 0]);
    // No pooled file uses the tree's Cells; with one ungrouped file that follows it, one would.
    expect(noFileFollowsTree(list, files)).toBe(true);
    expect(noFileFollowsTree(list, [...files, "C1"])).toBe(false);
  });

  it("on one file, the dashed outline is the version the gate reverts to: the group's for a file of a group that tailors it too", () => {
    const ten = tenFiles();
    const { copyOf, treeOf, own } = ten;
    let { state } = ten;
    // A1, in group A, tailors Cells on its own as well.
    const groupTree = state.stored_hierarchies[copyOf("gA")];
    state = coreReducer(state, { type: "addHierarchyCopies", copies: [own("cA1", "A1", groupTree, [[40, 0], [100, 0], [50, 100]])], activeHierarchyId: "main", assignments: { A1: "cA1" } });
    const cells = state.gate_order[0];
    const a1 = viewedFileGates(state, treeOf(state, "A1")).get(cells)!;
    expect(a1.tailored!.owner).toEqual({ kind: "file" });
    expect((a1.gate as { vertices: number[][] }).vertices[0]).toEqual([40, 0]);
    expect((a1.tailored!.reference as { vertices: number[][] }).vertices[0]).toEqual([10, 0]);
    // A2 follows its group: the group's version, reverting to the tree's.
    const a2 = viewedFileGates(state, treeOf(state, "A2")).get(cells)!;
    expect(a2.tailored!.owner).toEqual({ kind: "group", name: "Group A" });
    expect((a2.tailored!.reference as { vertices: number[][] }).vertices[0]).toEqual([0, 0]);
    // D1, of no group: the tree's.
    expect((viewedFileGates(state, "cD1").get(cells)!.tailored!.reference as { vertices: number[][] }).vertices[0]).toEqual([0, 0]);
    // Pooled, A1 has its own version and group A's keeps four files.
    const files = ["D1", "A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4"];
    const list = pooledVersions(state, files.map((fileId) => ({ fileId, treeId: treeOf(state, fileId) }))).get(cells)!;
    expect(list.map((v) => v.fileIds.length).sort()).toEqual([1, 1, 4, 4]);
  });
});
