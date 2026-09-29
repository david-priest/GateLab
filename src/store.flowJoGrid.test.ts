// @vitest-environment jsdom
//
// A FlowJo grid polygon (engine/flowjoGrid.ts) in the store: an edit keeps it a grid gate with
// its vertices on channels and FlowJo's own vertices one per vertex, through a moved, an added
// and a deleted vertex; undo gives back the gate as it was; a saved workspace still opens after
// the vertex count changed; a merge keeps the grid and never fuses a grid gate with the same
// polygon evaluated continuously; a group's tailored copy and a group edit carry the grid. A new
// gate is never on the grid. Synthetic file, gate and channel names.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "./store";
import { flowJoWorkspaceToGatingML } from "./engine/flowjoWorkspace";
import { importGatingML } from "./engine/gatingml";
import { exportFlowJoWorkspace } from "./engine/flowjoExport";
import { mergeGatingStrategies } from "./engine/gatingMerge";
import { onChannels, tailoredCopy } from "./engine/tailoredImport";
import { cloneHierarchyTree, storeHierarchy, type StoredHierarchy } from "./engine/hierarchies";
import { computeGateMasks } from "./engine/populations";
import { withGeometryOf } from "./engine/templateSync";
import { packWorkspaceReference, readWorkspaceBytes, type WorkspaceFile } from "./engine/workspace";
import { flowJoGridScale, isFlowJoGridGate, realignFlowJoVertices, type FlowJoGridSpec } from "./engine/flowjoGrid";
import { Sample } from "./engine/sample";
import type { FcsFile } from "./engine/fcs";
import type { PolyRectGate, Vertex } from "./engine/models";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";

const RAW: Vertex[] = [[20000, -150], [200000, 40], [180000, 150000], [40000, 90000]];
const WSP = `<Workspace xmlns:transforms="${T}" xmlns:data-type="${D}" xmlns:gating="${G}"><SampleList><Sample>
  <DataSet uri="file:D1.fcs"/>
  <Transformations>
    <transforms:linear transforms:minRange="0" transforms:maxRange="262144" gain="1"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
    <transforms:biex transforms:length="256" transforms:maxRange="262144" transforms:neg="0" transforms:width="-10" transforms:pos="4.41854"><data-type:parameter data-type:name="B-A"/></transforms:biex>
  </Transformations>
  <SampleNode name="D1.fcs" count="10"><Subpopulations>
    <Population name="CD4_positive" count="5"><Gate>
      <gating:PolygonGate eventsInside="1" quadId="-1" gateResolution="256" gating:id="g1">
        <gating:dimension><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
        <gating:dimension><data-type:fcs-dimension data-type:name="B-A"/></gating:dimension>
        ${RAW.map(([x, y]) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`).join("")}
      </gating:PolygonGate></Gate></Population>
  </Subpopulations></SampleNode></Sample></SampleList></Workspace>`;

function imported(flowJoGrid = true) {
  const conv = flowJoWorkspaceToGatingML(WSP, 0, null, undefined, { flowJoGrid });
  return importGatingML(conv.gatingMl, ["FSC-A", "B-A"], {}, "flow");
}

function loaded(): { state: CoreState; id: string } {
  const res = imported();
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 10 });
  state = coreReducer(state, {
    type: "importGating", mode: "replace",
    gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id,
  });
  const id = Object.values(state.gates).find((g) => g.gate_type === "polygon")!.gate_id;
  return { state, id };
}
const polygonOf = (state: CoreState, id: string) => state.gates[id] as PolyRectGate;

function scales(gate: PolyRectGate) {
  return {
    gx: flowJoGridScale(gate.transforms!["FSC-A"] as FlowJoGridSpec),
    gy: flowJoGridScale(gate.transforms!["B-A"] as FlowJoGridSpec),
  };
}

describe("a FlowJo grid polygon edited in the store", () => {
  it("keeps FlowJo's vertex for every vertex not moved, and the channel's centre for the one moved", () => {
    const { state, id } = loaded();
    const before = polygonOf(state, id);
    expect(isFlowJoGridGate(before)).toBe(true);
    const moved = before.vertices.map((v, i) => (i === 1 ? [v[0] + 3, v[1] - 2] : v) as Vertex);
    const after = polygonOf(coreReducer(state, { type: "editGate", gateId: id, vertices: moved }), id);
    expect(after.transforms).toEqual(before.transforms);
    expect(after.flowjo_vertices).toHaveLength(4);
    expect([after.flowjo_vertices![0], after.flowjo_vertices![2], after.flowjo_vertices![3]]).toEqual([RAW[0], RAW[2], RAW[3]]);
    const { gx, gy } = scales(after);
    expect([gx.vertexCell(after.flowjo_vertices![1][0]), gy.vertexCell(after.flowjo_vertices![1][1])]).toEqual(moved[1]);
  });

  it("keeps the two lists one per vertex when a vertex is added or deleted, which used to leave them apart", () => {
    const { state, id } = loaded();
    const before = polygonOf(state, id);
    // Added between the first and second, as "Add vertex here" splices it in.
    const added = [...before.vertices];
    added.splice(1, 0, [120, 60]);
    const withFive = polygonOf(coreReducer(state, { type: "editGate", gateId: id, vertices: added }), id);
    expect(withFive.flowjo_vertices).toHaveLength(5);
    expect([withFive.flowjo_vertices![0], ...withFive.flowjo_vertices!.slice(2)]).toEqual(RAW);
    const { gx, gy } = scales(withFive);
    expect([gx.vertexCell(withFive.flowjo_vertices![1][0]), gy.vertexCell(withFive.flowjo_vertices![1][1])]).toEqual([120, 60]);
    // Deleted, as "Delete vertex" filters it out.
    const deleted = before.vertices.filter((_, i) => i !== 2);
    const withThree = polygonOf(coreReducer(state, { type: "editGates", edits: [{ gateId: id, vertices: deleted }] }), id);
    expect(withThree.flowjo_vertices).toEqual([RAW[0], RAW[1], RAW[3]]);
  });

  it("gives the gate back exactly with Undo", () => {
    const { state, id } = loaded();
    const added = [...polygonOf(state, id).vertices];
    added.splice(2, 0, [150, 120]);
    const edited = coreReducer(state, { type: "editGate", gateId: id, vertices: added });
    expect(coreReducer(edited, { type: "undo" }).gates[id]).toEqual(state.gates[id]);
  });

  it("saves a workspace that opens again after the vertex count changed", () => {
    const { state, id } = loaded();
    const added = [...polygonOf(state, id).vertices];
    added.splice(1, 0, [120, 60]);
    const edited = coreReducer(state, { type: "editGate", gateId: id, vertices: added });
    const ws = {
      format: "gatelab-workspace", version: 2, savedAt: "2026-09-25T00:00:00.000Z", app: "GateLab",
      samples: [{ fileName: "D1.fcs", dataPath: "data/0_D1.fcs", logicleW: {}, cytofCofactor: 5, compensationOn: false }],
      activeSample: 0,
      gating: {
        gates: edited.gates, gate_order: edited.gate_order, populations: edited.populations,
        root_population_id: edited.root_population_id, active_population_id: edited.root_population_id, selected_gate_id: null,
      },
      scales: { globalScales: {} },
      display: { xChannel: "FSC-A", yChannel: "B-A", mode: "dots", maxEvents: 1000, contourThreshold: 5 },
    } as unknown as WorkspaceFile;
    const back = readWorkspaceBytes(packWorkspaceReference(ws)).ws.gating.gates[id];
    expect(back).toEqual(edited.gates[id]);
  });

  it("goes to FlowJo with FlowJo's own vertices and the added one at its channel's centre", () => {
    const { state, id } = loaded();
    const added = [...polygonOf(state, id).vertices];
    added.splice(1, 0, [120, 60]);
    const edited = coreReducer(state, { type: "editGate", gateId: id, vertices: added });
    const fcs: FcsFile = {
      version: "FCS3.1", nEvents: 2, instrument: "flow", keywords: {},
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "B-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from([1000, 2000]), Float32Array.from([10, 20])],
      spillover: null,
    } as unknown as FcsFile;
    const { xml } = exportFlowJoWorkspace({
      samples: [{
        sample: new Sample(fcs), fileName: "D1.fcs",
        gates: edited.gates, gate_order: edited.gate_order, populations: edited.populations, root_population_id: edited.root_population_id!,
      }],
      now: new Date("2026-09-25T00:00:00Z"), producer: "GateLab test",
    });
    const values = [...xml.match(/<gating:PolygonGate[^>]*>[\s\S]*?<\/gating:PolygonGate>/)![0].matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]));
    const written: Vertex[] = [];
    for (let i = 0; i + 1 < values.length; i += 2) written.push([values[i], values[i + 1]]);
    expect(written).toHaveLength(5);
    expect([written[0], ...written.slice(2)]).toEqual(RAW);
    const { gx, gy } = scales(polygonOf(edited, id));
    expect([gx.vertexCell(written[1][0]), gy.vertexCell(written[1][1])]).toEqual([120, 60]);
  });

  it("realigns nothing for a gate with no FlowJo vertices or not on the grid", () => {
    const { state, id } = loaded();
    const g = polygonOf(state, id);
    expect(realignFlowJoVertices({ ...g, flowjo_vertices: undefined }, g.vertices)).toBeUndefined();
    expect(realignFlowJoVertices({ ...g, space: "raw" }, g.vertices)).toBeUndefined();
  });
});

describe("a FlowJo grid polygon merged, grouped and tailored", () => {
  it("keeps its grid through a merge, and is never fused with the same polygon evaluated continuously", () => {
    const grid = imported(true);
    const continuous = imported(false);
    const merged = mergeGatingStrategies(grid, continuous, grid.root_population_id, true);
    const polygons = Object.values(merged.gates).filter((g) => g.gate_type === "polygon") as PolyRectGate[];
    expect(polygons).toHaveLength(2);
    expect(polygons.filter(isFlowJoGridGate)).toHaveLength(1);
    // The same grid gate twice is one gate, with its grid and FlowJo's vertices.
    const twice = mergeGatingStrategies(grid, imported(true), grid.root_population_id, true);
    const kept = Object.values(twice.gates).filter((g) => g.gate_type === "polygon") as PolyRectGate[];
    expect(kept).toHaveLength(1);
    expect(isFlowJoGridGate(kept[0])).toBe(true);
    expect(kept[0].flowjo_vertices).toEqual(RAW);
  });

  it("carries the grid into a file's tailored copy and through a group edit", () => {
    const res = imported();
    const tree = { gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id };
    const copy = tailoredCopy({ id: "main", name: "Main", tree }, { fileId: "f1", fileName: "D1.fcs", tree }, []);
    const inCopy = Object.values(copy.gates).find((g) => g.gate_type === "polygon") as PolyRectGate;
    expect(isFlowJoGridGate(inCopy)).toBe(true);
    expect(inCopy.flowjo_vertices).toEqual(RAW);
    // A group edit gives the copy the template's geometry: its grid and vertices with it.
    const template = Object.values(res.gates).find((g) => g.gate_type === "polygon") as PolyRectGate;
    const edited = { ...template, vertices: template.vertices.map(([x, y]) => [x + 1, y] as Vertex) };
    const synced = withGeometryOf(inCopy, edited) as PolyRectGate;
    expect(synced.gate_id).toBe(inCopy.gate_id);
    expect(synced.transforms).toEqual(template.transforms);
    expect(synced.vertices).toEqual(edited.vertices);
  });
});

// A file whose $PnS labels a detector differently from the tree's file keeps its gates on its own
// channel for that detector. The grid lives in `transforms`, keyed by channel: carried onto the
// file's channel under the tree's keys, the axis named no transform and fell back to the display
// transform, and 3,753 events became 491 (Revert) and the tree's gate 480 (Apply to the tree).
describe("a FlowJo grid polygon on a file that labels a detector differently", () => {
  /** Two files with the same events, the second labelling the B detector "B-X". */
  function fileWith(yKey: string): Sample {
    const n = 4000;
    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    let seed = 12345;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < n; i++) { xs[i] = next() * 262144; ys[i] = next() * 200500 - 500; }
    return new Sample({
      version: "FCS3.1", nEvents: n, instrument: "flow", keywords: {},
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: yKey, marker: null, bits: 32, range: 262144 },
      ],
      columns: [xs, ys],
      spillover: null,
    } as unknown as FcsFile);
  }
  const held = (gate: PolyRectGate, sample: Sample) => {
    const mask = computeGateMasks({ [gate.gate_id]: gate }, sample.gateAssayData())[gate.gate_id];
    let n = 0;
    for (let i = 0; i < mask.length; i++) n += mask[i];
    return n;
  };

  /** The tree live with the grid polygon, and a file-owned copy whose gate is on "B-X". */
  function relabelled(shift: number) {
    const { state: tree, id } = loaded();
    const template = storeHierarchy(tree.hierarchies[0], tree);
    const c = cloneHierarchyTree(template.populations, template.root_population_id!, template.gates, template.gate_order);
    const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
    const copyGateId = c.gateIdMap[id];
    const own = polygonOf(tree, id);
    // The file's own gate: on its channel "B-X", its grid keyed there, tailored by `shift` channels.
    const tailored: PolyRectGate = {
      ...own, gate_id: copyGateId, y_channel: "B-X",
      transforms: { "FSC-A": own.transforms!["FSC-A"], "B-X": own.transforms!["B-A"] },
      vertices: own.vertices.map(([x, y]) => [x + shift, y] as Vertex),
    };
    const copy: StoredHierarchy = {
      id: "D2", name: "D2.fcs · Main", owner_sample_id: "D2", structure_locked: true, source_hierarchy_id: template.id,
      source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
      gates: { ...c.gates, [copyGateId]: tailored }, gate_order: c.gate_order, populations: c.populations,
      root_population_id: c.root_population_id, active_population_id: c.root_population_id, selected_pop_ids: [],
    };
    const state = coreReducer(tree, { type: "addHierarchyCopies", copies: [copy], activeHierarchyId: copy.id });
    return { state, template, templateGateId: id, copyGateId };
  }

  it("keeps the grid on the file's own channel when the gate is reverted to the tree", () => {
    const { state, template, templateGateId, copyGateId } = relabelled(6);
    const reverted = polygonOf(coreReducer(state, { type: "revertGateToGroup", gateId: copyGateId }), copyGateId);
    const treeGate = template.gates[templateGateId] as PolyRectGate;
    expect([reverted.x_channel, reverted.y_channel]).toEqual(["FSC-A", "B-X"]);
    expect(reverted.transforms).toEqual({ "FSC-A": treeGate.transforms!["FSC-A"], "B-X": treeGate.transforms!["B-A"] });
    expect(isFlowJoGridGate(reverted)).toBe(true);
    expect(reverted.flowjo_vertices).toEqual(RAW);
    expect(reverted.vertices).toEqual(treeGate.vertices);
    // The tree's gate holds the same events on either file.
    const expected = held(treeGate, fileWith("B-A"));
    expect(expected).toBeGreaterThan(100);
    expect(held(reverted, fileWith("B-X"))).toBe(expected);
  });

  it("puts the file's gate on the tree's channels when it is applied to the tree", () => {
    const { state, template, templateGateId, copyGateId } = relabelled(6);
    const own = polygonOf(state, copyGateId);
    const applied = coreReducer(state, { type: "applyGateToGroup", gateId: copyGateId });
    const treeGate = applied.stored_hierarchies[template.id].gates[templateGateId] as PolyRectGate;
    expect([treeGate.x_channel, treeGate.y_channel]).toEqual(["FSC-A", "B-A"]);
    expect(treeGate.transforms).toEqual({ "FSC-A": own.transforms!["FSC-A"], "B-A": own.transforms!["B-X"] });
    expect(isFlowJoGridGate(treeGate)).toBe(true);
    expect(treeGate.vertices).toEqual(own.vertices);
    const expected = held(own, fileWith("B-X"));
    expect(expected).toBeGreaterThan(100);
    expect(held(treeGate, fileWith("B-A"))).toBe(expected);
  });

  it("keeps the grid on the file's own channel when the whole file is reverted to the tree", () => {
    const { state, template, templateGateId, copyGateId } = relabelled(6);
    const reverted = coreReducer(state, { type: "revertCopyToSource", id: "D2" });
    const gate = (reverted.active_hierarchy_id === "D2" ? reverted.gates[copyGateId] : reverted.stored_hierarchies.D2.gates[copyGateId]) as PolyRectGate;
    const treeGate = template.gates[templateGateId] as PolyRectGate;
    expect(gate.transforms).toEqual({ "FSC-A": treeGate.transforms!["FSC-A"], "B-X": treeGate.transforms!["B-A"] });
    expect(isFlowJoGridGate(gate)).toBe(true);
    expect(held(gate, fileWith("B-X"))).toBe(held(treeGate, fileWith("B-A")));
  });

  /** A tree's gates as the state holds them, live or parked. */
  const treeGates = (s: CoreState, id: string) => (s.active_hierarchy_id === id ? s.gates : s.stored_hierarchies[id].gates);
  /** `relabelled`, with D2 on its copy and D3 on an in-step copy of its own (its gate tailored on the tree's channel). */
  function withFiles(shift: number) {
    const r = relabelled(shift);
    const c = cloneHierarchyTree(r.template.populations, r.template.root_population_id!, r.template.gates, r.template.gate_order);
    const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
    const own = r.template.gates[r.templateGateId] as PolyRectGate;
    const d3GateId = c.gateIdMap[r.templateGateId];
    const d3: StoredHierarchy = {
      id: "D3", name: "D3.fcs · Main", owner_sample_id: "D3", structure_locked: true, source_hierarchy_id: r.template.id,
      source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
      gates: { ...c.gates, [d3GateId]: { ...own, gate_id: d3GateId, vertices: own.vertices.map(([x, y]) => [x - 4, y] as Vertex) } },
      gate_order: c.gate_order, populations: c.populations,
      root_population_id: c.root_population_id, active_population_id: c.root_population_id, selected_pop_ids: [],
    };
    let state = coreReducer(r.state, { type: "addHierarchyCopies", copies: [d3], activeHierarchyId: "D2" });
    state = coreReducer(state, { type: "assignFileHierarchies", assignments: { D1: r.template.id, D2: "D2", D3: "D3" } });
    return { ...r, state, d3GateId };
  }

  // "Use for the tree…" on the relabelled file's copy changed nothing (its gates name its own
  // channels, so it was never in step with the tree), and the app said it had.
  it("gives the tree the relabelled file's coordinates, on the tree's channels, and keeps the file on its own copy", () => {
    const { state, template, templateGateId, copyGateId } = withFiles(6);
    const own = polygonOf(state, copyGateId);
    const promoted = coreReducer(state, { type: "promoteCopyToTemplate", copyId: "D2" });
    expect(promoted).not.toBe(state);
    const treeGate = treeGates(promoted, template.id)[templateGateId] as PolyRectGate;
    expect([treeGate.x_channel, treeGate.y_channel]).toEqual(["FSC-A", "B-A"]);
    expect(treeGate.vertices).toEqual(own.vertices);
    expect(isFlowJoGridGate(treeGate)).toBe(true);
    expect(held(treeGate, fileWith("B-A"))).toBe(held(own, fileWith("B-X")));
    // D3 follows the tree again; D2 cannot be gated under it (it has no B-A) and keeps its copy,
    // which holds the tree's coordinates on its own channel.
    expect(promoted.file_hierarchies).toMatchObject({ D1: template.id, D2: "D2", D3: template.id });
    expect(promoted.hierarchies.some((h) => h.id === "D3")).toBe(false);
    const d2 = treeGates(promoted, "D2")[copyGateId] as PolyRectGate;
    expect([d2.x_channel, d2.y_channel]).toEqual(["FSC-A", "B-X"]);
    expect(d2.vertices).toEqual(treeGate.vertices);
    expect(held(d2, fileWith("B-X"))).toBe(held(treeGate, fileWith("B-A")));
    // One undo entry brings everything back.
    const undone = coreReducer(promoted, { type: "undo" });
    expect(treeGates(undone, template.id)[templateGateId]).toEqual(template.gates[templateGateId]);
    expect(undone.file_hierarchies).toMatchObject({ D2: "D2", D3: "D3" });
  });

  // "Revert <file> to the tree" pointed the file at the tree, whose gates name channels the file
  // does not have: every gate on the relabelled detector then held no event.
  it("reverts a relabelled file to the tree's coordinates on its own channels, and puts any other file on the tree", () => {
    const { state, template, templateGateId, copyGateId } = withFiles(6);
    const reverted = coreReducer(state, { type: "followSourceAgain", assignments: { D2: template.id, D3: template.id } });
    const treeGate = template.gates[templateGateId] as PolyRectGate;
    expect(reverted.file_hierarchies).toMatchObject({ D2: "D2", D3: template.id });
    expect(reverted.hierarchies.some((h) => h.id === "D3")).toBe(false);
    const d2 = treeGates(reverted, "D2")[copyGateId] as PolyRectGate;
    expect([d2.x_channel, d2.y_channel]).toEqual(["FSC-A", "B-X"]);
    expect(d2.transforms).toEqual({ "FSC-A": treeGate.transforms!["FSC-A"], "B-X": treeGate.transforms!["B-A"] });
    expect(d2.vertices).toEqual(treeGate.vertices);
    expect(held(d2, fileWith("B-X"))).toBe(held(treeGate, fileWith("B-A")));
    expect(held(d2, fileWith("B-X"))).toBeGreaterThan(100);
    const undone = coreReducer(reverted, { type: "undo" });
    expect(undone.file_hierarchies).toMatchObject({ D2: "D2", D3: "D3" });
    expect((treeGates(undone, "D2")[copyGateId] as PolyRectGate).vertices).toEqual(polygonOf(state, copyGateId).vertices);
  });

  it("moves every field keyed by channel with the axes, x to x and y to y", () => {
    const axis = { kind: "linear" as const, minRange: 0, maxRange: 262144 };
    const rect: PolyRectGate = {
      gate_id: "r", name: "R", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "B-A",
      vertices: [[0, 0], [10, 10]], color: "#000000", label_offset: null,
      space: "display", transforms: { "FSC-A": { kind: "identity" }, "B-A": { kind: "asinh", cofactor: 150 } },
      flowjo_axes: { "FSC-A": axis, "B-A": axis }, flowjo_bounds: { "B-A": [null, 262144] },
    };
    const moved = onChannels(rect, "FSC-A", "B-X") as PolyRectGate;
    expect(moved.transforms).toEqual({ "FSC-A": { kind: "identity" }, "B-X": { kind: "asinh", cofactor: 150 } });
    expect(moved.flowjo_axes).toEqual({ "FSC-A": axis, "B-X": axis });
    expect(moved.flowjo_bounds).toEqual({ "B-X": [null, 262144] });
    // Swapped axes swap their entries; a range's one channel is renamed once.
    const swapped = onChannels(rect, "B-A", "FSC-A") as PolyRectGate;
    expect(swapped.transforms).toEqual({ "B-A": { kind: "identity" }, "FSC-A": { kind: "asinh", cofactor: 150 } });
    const range = onChannels({ ...rect, y_channel: "FSC-A", flowjo_bounds: { "FSC-A": [5, null] } }, "Q-A", "Q-A") as PolyRectGate;
    expect(range.flowjo_bounds).toEqual({ "Q-A": [5, null] });
    expect(onChannels(rect, "FSC-A", "B-A")).toBe(rect);
  });

  it("follows the tree onto the file's channel for a gate the file did not record", () => {
    const { state: tree, id } = loaded();
    const own = polygonOf(tree, id);
    // The tree labels the detector "IL-21 PE", the file "IL21 PE": one stain, spelled otherwise.
    const treeGate: PolyRectGate = { ...own, y_channel: "IL-21 PE", transforms: { "FSC-A": own.transforms!["FSC-A"], "IL-21 PE": own.transforms!["B-A"] } };
    const treeTree = { ...tree, gates: { [id]: treeGate } };
    const strategy = { gates: treeTree.gates, gate_order: tree.gate_order, populations: tree.populations, root_population_id: tree.root_population_id! };
    const copy = tailoredCopy(
      { id: "main", name: "Main", tree: strategy, detectors: { "FSC-A": "FSC-A", "IL-21 PE": "B-A" } },
      { fileId: "f2", fileName: "D2.fcs", tree: { gates: {}, gate_order: [], populations: tree.populations, root_population_id: tree.root_population_id! }, detectors: { "FSC-A": "FSC-A", "IL21 PE": "B-A" } },
      [],
    );
    const inCopy = Object.values(copy.gates).find((g) => g.gate_type === "polygon") as PolyRectGate;
    expect(inCopy.y_channel).toBe("IL21 PE");
    expect(inCopy.transforms).toEqual({ "FSC-A": own.transforms!["FSC-A"], "IL21 PE": own.transforms!["B-A"] });
    expect(isFlowJoGridGate(inCopy)).toBe(true);
  });
});

describe("a new gate", () => {
  it("is never on FlowJo's grid, whatever gates the workspace holds", () => {
    const fcs: FcsFile = {
      version: "FCS3.1", nEvents: 2, instrument: "flow", keywords: {},
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "B-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from([1000, 2000]), Float32Array.from([10, 20])],
      spillover: null,
    } as unknown as FcsFile;
    const sample = new Sample(fcs);
    const fields = sample.newGateSpaceFields("display", "FSC-A", "B-A");
    expect(Object.values(fields.transforms ?? {}).map((t) => t.kind)).not.toContain("flowjoChannels");
    const { state } = loaded();
    const drawn = coreReducer(state, {
      type: "addGate", gateType: "polygon", name: "Drawn", xChannel: "FSC-A", yChannel: "B-A",
      vertices: [[1, 1], [5, 1], [5, 5]], ...fields,
    });
    const gate = Object.values(drawn.gates).find((g) => g.name === "Drawn") as PolyRectGate;
    expect(isFlowJoGridGate(gate)).toBe(false);
    expect(gate.flowjo_vertices).toBeUndefined();
  });
});
