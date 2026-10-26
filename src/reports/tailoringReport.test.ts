// The tailoring report lists the gates files are gated with at coordinates of their own or their
// group's, as the file list's badge counts them, with each one's shift from what it follows.
// Synthetic files D1, A1 to A5 and B1 to B4; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { cloneHierarchyTree, fileHierarchyId, storeHierarchy, type StoredHierarchy } from "../engine/hierarchies";
import { UNBOUNDED, type Gate } from "../engine/models";
import { gateShift, readTailoringReasons, savedTailoringReasons, tailoredFileIds, tailoringCsv, tailoringReport, TAILORING_REASONS_FIELD, type NamedTailoredGate } from "./tailoringReport";
import { workspaceTrees } from "../plots/tailoredGates";

/** D1 tailors Cells in a copy of its own; group A (five files) and group B (four) in their groups' trees. */
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
  // Group A moves the whole gate 10 along x; group B moves one vertex 20.
  tailor(copyOf("gA"), [[10, 0], [110, 0], [60, 100]]);
  tailor(copyOf("gB"), [[20, 0], [100, 0], [50, 100]]);
  const own = (id: string, owner: string, from: StoredHierarchy, vertices: [number, number][]): StoredHierarchy => {
    const c = cloneHierarchyTree(from.populations, from.root_population_id!, from.gates, from.gate_order);
    const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
    const gates = Object.fromEntries(Object.entries(c.gates).map(([gid, g]) => [gid, { ...g, vertices } as Gate]));
    return { id, name: `${owner} · ${from.name}`, owner_sample_id: owner, structure_locked: true, source_hierarchy_id: from.id,
      source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
      gates, gate_order: c.gate_order, populations: c.populations, root_population_id: c.root_population_id,
      active_population_id: c.root_population_id, selected_pop_ids: [] };
  };
  const tree = storeHierarchy(state.hierarchies.find((h) => h.id === "main")!, state);
  state = coreReducer(state, { type: "addHierarchyCopies", copies: [own("cD1", "D1", tree, [[0, -5], [100, -5], [50, 95]])], activeHierarchyId: "main", assignments: { D1: "cD1" } });
  const files = ["D1", ...groupA, ...groupB, "C1"];
  const filesOf = (s: CoreState) => files.map((fileId) => ({ fileId, treeId: fileHierarchyId(s.file_hierarchies[fileId], s.hierarchies) }));
  return { state, copyOf, own, filesOf };
}

describe("tailoringReport", () => {
  it("lists one row per version with the files gated with it and its shift", () => {
    const { state, copyOf, filesOf } = tenFiles();
    const report = tailoringReport(state, filesOf(state));
    expect(report.map((row) => [
      row.owner.kind === "group" ? row.owner.name : row.owner.fileId,
      row.treeId, row.gateName, row.fileIds.length, row.follows.kind, row.shift,
    ])).toEqual([
      ["D1", "cD1", "Cells", 1, "tree", { kind: "moved", dx: 0, dy: -5, reshaped: false, space: "raw" }],
      ["Group A", copyOf("gA"), "Cells", 5, "tree", { kind: "moved", dx: 10, dy: 0, reshaped: false, space: "raw" }],
      ["Group B", copyOf("gB"), "Cells", 4, "tree", { kind: "moved", dx: 20, dy: 0, reshaped: true, space: "raw" }],
    ]);
    // C1 follows the tree.
    expect(tailoredFileIds(report, filesOf(state))).toEqual(["D1", "A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4"]);
  });

  it("gives a file of a group that tailors the gate again a row of its own, against the group's version", () => {
    const ten = tenFiles();
    let { state } = ten;
    const groupTree = state.stored_hierarchies[ten.copyOf("gA")];
    state = coreReducer(state, { type: "addHierarchyCopies", copies: [ten.own("cA1", "A1", groupTree, [[10, 0], [110, 0], [60, 120]])], activeHierarchyId: "main", assignments: { A1: "cA1" } });
    const report = tailoringReport(state, ten.filesOf(state));
    const a1 = report.find((row) => row.treeId === "cA1")!;
    expect(a1.follows).toEqual({ kind: "group", name: "Group A" });
    expect(a1.shift).toEqual({ kind: "moved", dx: 0, dy: 20, reshaped: true, space: "raw" });
    expect(report.find((row) => row.treeId === ten.copyOf("gA"))!.fileIds).toEqual(["A2", "A3", "A4", "A5"]);
  });

  it("is empty when every file follows the tree", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name: "Cells", xChannel: "FSC-A", yChannel: "SSC-A",
      vertices: [[0, 0], [100, 100]], createPop: { name: "Cells", parentId: state.active_population_id! } });
    expect(tailoringReport(state, [{ fileId: "D1", treeId: "main" }])).toEqual([]);
  });
});

describe("gateShift", () => {
  const rect = (vertices: [number, number][], extra: Partial<Gate> = {}): Gate => ({
    gate_id: "g", name: "Cells", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A", vertices, color: "#000", label_offset: null, ...extra,
  } as Gate);

  it("reports a translation, a reshaping and an unchanged gate", () => {
    const base = rect([[0, 0], [100, 100]]);
    expect(gateShift(rect([[10, -3], [110, 97]]), base)).toEqual({ kind: "moved", dx: 10, dy: -3, reshaped: false, space: "raw" });
    expect(gateShift(rect([[0, 0], [130, 100]]), base)).toEqual({ kind: "moved", dx: 30, dy: 0, reshaped: true, space: "raw" });
    expect(gateShift(rect([[0, 0], [100, 100]], { color: "#f00" }), base)).toEqual({ kind: "same" });
    expect(gateShift(base, null)).toEqual({ kind: "no-source" });
  });

  it("says why a gate cannot be compared vertex by vertex", () => {
    const base = rect([[0, 0], [100, 100]]);
    expect(gateShift(rect([[0, 0], [100, UNBOUNDED]]), base)).toEqual({ kind: "reshaped", why: "bound opened or closed" });
    expect(gateShift({ ...base, gate_type: "polygon", vertices: [[0, 0], [100, 0], [50, 100]] } as Gate, base)).toEqual({ kind: "reshaped", why: "rectangle to polygon" });
    expect(gateShift(rect([[0, 0], [100, 100]], { x_channel: "FSC-H" }), base)).toEqual({ kind: "reshaped", why: "other axes" });
  });

  it("compares display gates in raw values through the transforms they record, else in display units", () => {
    const asinh = { kind: "asinh", cofactor: 5 } as const;
    const display = (vertices: [number, number][], transforms?: Record<string, typeof asinh>) =>
      rect(vertices, { space: "display", ...(transforms ? { transforms } : {}) } as Partial<Gate>);
    const both = { "FSC-A": asinh, "SSC-A": asinh };
    const shift = gateShift(display([[1, 1], [3, 3]], both), display([[1, 1], [2, 3]], both));
    expect(shift.kind).toBe("moved");
    const moved = shift as Extract<typeof shift, { kind: "moved" }>;
    expect(moved.space).toBe("raw");
    expect(moved.dx).toBeCloseTo(5 * (Math.sinh(3) - Math.sinh(2)), 6);
    expect(moved.dy).toBe(0);
    expect(gateShift(display([[2, 1], [3, 2]]), display([[1, 1], [2, 2]]))).toEqual({ kind: "moved", dx: 1, dy: 0, reshaped: false, space: "display" });
    expect(gateShift(display([[2, 1], [3, 2]]), rect([[1, 1], [2, 2]]))).toEqual({ kind: "reshaped", why: "other space" });
  });

  it("moves an ellipse and a quadrant by their centres, and notes a change of size or arms", () => {
    const ellipse = { gate_id: "e", name: "E", gate_type: "ellipse", x_channel: "FSC-A", y_channel: "SSC-A", mean: [10, 10], covariance: [[4, 0], [0, 9]], distance_square: 1, color: "#000", label_offset: null } as Gate;
    expect(gateShift({ ...ellipse, mean: [12, 10] } as Gate, ellipse)).toEqual({ kind: "moved", dx: 2, dy: 0, reshaped: false, space: "raw" });
    expect(gateShift({ ...ellipse, distance_square: 2 } as Gate, ellipse)).toEqual({ kind: "moved", dx: 0, dy: 0, reshaped: true, space: "raw" });
    const arms = { down: [10, 0], right: [20, 10], up: [10, 20], left: [0, 10] };
    const quadrant = { gate_id: "q", name: "Q", gate_type: "quadrant", x_channel: "FSC-A", y_channel: "SSC-A", center: [10, 10], arms, color: "#000", label_offset: null } as unknown as Gate;
    const shifted = { down: [15, 0], right: [25, 10], up: [15, 20], left: [5, 10] };
    expect(gateShift({ ...quadrant, center: [15, 10], arms: shifted } as unknown as Gate, quadrant)).toEqual({ kind: "moved", dx: 5, dy: 0, reshaped: false, space: "raw" });
    expect(gateShift({ ...quadrant, arms: { ...arms, up: [12, 20] } } as unknown as Gate, quadrant)).toEqual({ kind: "moved", dx: 0, dy: 0, reshaped: true, space: "raw" });
  });
});

describe("the table's CSV and reasons", () => {
  it("writes one record per version, the shift's numbers only for a move, and quotes what needs it", () => {
    const { state, filesOf } = tenFiles();
    const rows: NamedTailoredGate[] = tailoringReport(state, filesOf(state)).map((row) => ({
      ...row,
      ownerName: row.owner.kind === "group" ? row.owner.name : row.owner.fileId,
      fileNames: row.fileIds,
      reason: row.owner.kind === "file" ? "Shifted, after the stimulation" : "",
    }));
    const lines = tailoringCsv(rows, (channel) => channel).split("\r\n");
    expect(lines[0]).toBe("owner_kind,owner,files,gate,x_channel,y_channel,follows,dx,dy,units,reshaped,shift,reason");
    expect(lines[1]).toBe('file,D1,D1,Cells,FSC-A,SSC-A,tree,0,-5,raw,false,"FSC-A 0, SSC-A -5","Shifted, after the stimulation"');
    expect(lines[3]).toBe('group,Group B,B1; B2; B3; B4,Cells,FSC-A,SSC-A,tree,20,0,raw,true,"FSC-A +20, SSC-A 0; reshaped",');
    expect(lines).toHaveLength(5);
  });

  it("reads reasons defensively and saves only those of gates the workspace still holds", () => {
    const { state, copyOf } = tenFiles();
    const cells = state.stored_hierarchies[copyOf("gA")].gate_order[0];
    expect(readTailoringReasons({ [TAILORING_REASONS_FIELD]: { [copyOf("gA")]: { [cells]: "Shifted", other: 3, blank: " " }, bad: "x" } }))
      .toEqual({ [copyOf("gA")]: { [cells]: "Shifted" } });
    expect(readTailoringReasons({ [TAILORING_REASONS_FIELD]: ["x"] })).toEqual({});
    expect(savedTailoringReasons({ [copyOf("gA")]: { [cells]: "Shifted", gone: "Old" }, removedTree: { g: "Old" } }, workspaceTrees(state)))
      .toEqual({ [copyOf("gA")]: { [cells]: "Shifted" } });
  });
});
