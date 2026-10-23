// A GatingSet's hierarchy, as GateLabR describes it, becomes display-space gates carrying their
// transforms and one population per node. The fixture has every node kind flowWorkspace
// returns (gh_pop_get_gate): a range gate, a rectangle, a polygon, an ellipse, a quadrant set,
// a negated node and a boolean of node names, under every transform kind the host maps.
import { describe, expect, it } from "vitest";
import { getGateMask } from "../engine/gates";
import { fileHierarchyId, type StoredHierarchy } from "../engine/hierarchies";
import { UNBOUNDED } from "../engine/models";
import type { EllipseGate, PolyRectGate, QuadrantGate } from "../engine/models";
import { coreReducer, initialCoreState, recomputeGating } from "../store";
import type { GateLabHostDatasetDescriptor, GateLabHostDatasetPort } from "./datasetContract";
import { tailoredHierarchyId, translateGatingSetHierarchy, type HostedHierarchy } from "./hostedHierarchy";
import { gatingStateForTree, hostedMembershipReader, type HierarchyTree, type HostedMembershipSample } from "./hostedMemberships";
import { loadHostedDataset } from "./hostedSample";
import { readHostedWorkspace, transformSpec } from "./hostedWorkspace";

const dataset: GateLabHostDatasetDescriptor = {
  contractVersion: 1,
  id: "gs",
  label: "gatelabr_gs",
  instrument: "flow",
  eventCount: 6,
  channels: [
    { id: "FSC-A", label: "FSC-A", pnn: "FSC-A" },
    { id: "SSC-A", label: "SSC-A", pnn: "SSC-A" },
    { id: "FL1-A", label: "CD3", pnn: "FL1-A", pns: "CD3", transform: { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 } },
    { id: "FL2-A", label: "CD19", pnn: "FL2-A", pns: "CD19", transform: { kind: "asinh", cofactor: 150 } },
    { id: "FL3-A", label: "CD4", pnn: "FL3-A", pns: "CD4", transform: { kind: "biex", maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -10, channelRange: 4096, tableChannels: 4096 } },
  ],
  assays: [{ id: "compensated", label: "compensated", role: "compensated", coordinateSpace: "linear", revision: 0, encoding: "channel-major-float32-le" }],
  defaultAssayId: "compensated",
  samples: [
    { id: "D1", label: "D1", eventCount: 3, metadata: { group: "treated" }, assayByteLength: 60, eventIndexEncoding: "uint32-le", eventIndexByteLength: 12 },
    { id: "D2", label: "D2", eventCount: 3, metadata: { group: "control" }, assayByteLength: 60, eventIndexEncoding: "uint32-le", eventIndexByteLength: 12 },
  ],
  colDataColumns: ["group"],
};

const logicle = { kind: "logicle" as const, T: 262144, W: 0.5, M: 4.5, A: 0 };
const asinh = { kind: "asinh" as const, cofactor: 150 };

const hierarchy: HostedHierarchy = {
  contractVersion: 1,
  nodes: [
    { path: "/cells", name: "cells", parent: "root", gate: { kind: "rectangle", axes: [{ channel: "FSC-A", transform: null }], min: [20000], max: [null] } },
    {
      path: "/cells/singlets", name: "singlets", parent: "/cells",
      gate: { kind: "polygon", axes: [{ channel: "FSC-A", transform: null }, { channel: "SSC-A", transform: null }], vertices: [[0, 0], [100000, 0], [100000, 100000], [0, 100000]] },
    },
    {
      path: "/cells/singlets/T", name: "T", parent: "/cells/singlets",
      gate: { kind: "rectangle", axes: [{ channel: "FL1-A", transform: logicle }, { channel: "FL2-A", transform: asinh }], min: [1.5, null], max: [3.5, 4] },
    },
    {
      path: "/cells/singlets/blob", name: "blob", parent: "/cells/singlets",
      gate: { kind: "ellipse", axes: [{ channel: "FL1-A", transform: logicle }, { channel: "FL3-A", transform: dataset.channels[4].transform! }], mean: [2, 2000], covariance: [[0.25, 0], [0, 40000]], distance: 2 },
    },
    {
      path: "/cells/singlets/quadrants", name: "quadrants", parent: "/cells/singlets",
      gate: {
        kind: "quadrant", axes: [{ channel: "FL1-A", transform: logicle }, { channel: "FL2-A", transform: asinh }], center: [2, 3],
        members: [
          { path: "/cells/singlets/CD3-CD19+", name: "CD3-CD19+", quadrant: 1 },
          { path: "/cells/singlets/CD3+CD19+", name: "CD3+CD19+", quadrant: 2 },
          { path: "/cells/singlets/CD3+CD19-", name: "CD3+CD19-", quadrant: 3 },
          { path: "/cells/singlets/CD3-CD19-", name: "CD3-CD19-", quadrant: 4 },
        ],
      },
    },
    {
      path: "/cells/singlets/not T", name: "not T", parent: "/cells/singlets", negated: true,
      gate: { kind: "rectangle", axes: [{ channel: "FL1-A", transform: logicle }, { channel: "FL2-A", transform: asinh }], min: [1.5, null], max: [3.5, 4] },
    },
    {
      path: "/cells/singlets/T not blob", name: "T not blob", parent: "/cells/singlets",
      boolean: { operator: "and", refs: [{ path: "/cells/singlets/T", include: true }, { path: "/cells/singlets/blob", include: false }] },
    },
    {
      path: "/cells/singlets/either", name: "either", parent: "/cells/singlets",
      boolean: { operator: "or", refs: [{ path: "/cells/singlets/T", include: true }, { path: "/cells/singlets/blob", include: true }] },
    },
    { path: "/cells/singlets/either/child", name: "child", parent: "/cells/singlets/either", gate: { kind: "rectangle", axes: [{ channel: "FSC-A", transform: null }], min: [0], max: [1] } },
  ],
  leftOut: [{ path: "/cells/table", reason: "FL4-A is on a FlowJo calibration table, whose parameters the object does not hold" }],
};

describe("translateGatingSetHierarchy", () => {
  const translation = translateGatingSetHierarchy(hierarchy, dataset, transformSpec);
  const { gates, populations, gate_order: order, root_population_id: root } = translation.workspace.gating;

  it("makes one display-space gate per geometric node, in the object's order", () => {
    expect(order).toEqual(["/cells", "/cells/singlets", "/cells/singlets/T", "/cells/singlets/blob", "/cells/singlets/quadrants", "/cells/singlets/not T"]);
    for (const id of order) expect(gates[id].space).toBe("display");
  });

  it("holds a range gate as a closed rectangle on its channel with no bound on the other side", () => {
    const cells = gates["/cells"] as PolyRectGate;
    expect(cells.gate_type).toBe("rectangle");
    expect(cells.bounds).toBe("closed");
    expect(cells.x_channel).toBe("FSC-A");
    expect(cells.y_channel).toBe("FSC-A");
    expect(cells.vertices).toEqual([[20000, -UNBOUNDED], [UNBOUNDED, -UNBOUNDED], [UNBOUNDED, UNBOUNDED], [20000, UNBOUNDED]]);
    expect(cells.transforms).toEqual({ "FSC-A": { kind: "identity" } });
    // The interval, evaluated: 20000 is in, 19999 out, and the second axis never excludes.
    const mask = getGateMask(cells, { n: 3, column: () => Float32Array.from([19999, 20000, 1e9]) });
    expect(Array.from(mask)).toEqual([0, 1, 1]);
  });

  it("keeps each axis's transform on the gate, as the object evaluates it", () => {
    const t = gates["/cells/singlets/T"] as PolyRectGate;
    expect(t.transforms).toEqual({ "FL1-A": logicle, "FL2-A": asinh });
    expect(t.vertices).toEqual([[1.5, -UNBOUNDED], [3.5, -UNBOUNDED], [3.5, 4], [1.5, 4]]);
    // The mask is tested on values in the gate's own space, which is what a Sample hands a
    // display-space gate (sample.ts, gatingDataFor): logicle(x) in [1.5, 3.5], asinh(y/150) <= 4.
    const mask = getGateMask(t, {
      n: 3,
      column: (ch) => ch === "FL1-A" ? Float32Array.from([2.5, 2.5, 0.5]) : Float32Array.from([3.9, 4.1, 0]),
    });
    expect(Array.from(mask)).toEqual([1, 0, 0]);
  });

  it("holds an ellipse with the Mahalanobis distance squared", () => {
    const blob = gates["/cells/singlets/blob"] as EllipseGate;
    expect(blob.gate_type).toBe("ellipse");
    expect(blob.mean).toEqual([2, 2000]);
    expect(blob.covariance).toEqual([[0.25, 0], [0, 40000]]);
    expect(blob.distance_square).toBe(4);
    expect(blob.transforms?.["FL3-A"]).toEqual(dataset.channels[4].transform);
  });

  it("holds a quadrant set as one gate with four populations, numbered as the app numbers quadrants", () => {
    const quad = gates["/cells/singlets/quadrants"] as QuadrantGate;
    expect(quad.gate_type).toBe("quadrant");
    expect(quad.center).toEqual([2, 3]);
    expect(populations["/cells/singlets/quadrants"]).toBeUndefined();
    for (const [path, quadrant] of [["/cells/singlets/CD3-CD19+", 1], ["/cells/singlets/CD3+CD19+", 2], ["/cells/singlets/CD3+CD19-", 3], ["/cells/singlets/CD3-CD19-", 4]] as const) {
      expect(populations[path].gate_refs).toEqual([{ gate_id: "/cells/singlets/quadrants", include: true, quadrant }]);
      expect(populations[path].parent_id).toBe("/cells/singlets");
    }
  });

  it("makes a negated node a population excluding its gate, and a boolean a population over the named nodes' gates", () => {
    expect(populations["/cells/singlets/not T"].gate_refs).toEqual([{ gate_id: "/cells/singlets/not T", include: false }]);
    expect(populations["/cells/singlets/T not blob"].gate_refs).toEqual([
      { gate_id: "/cells/singlets/T", include: true },
      { gate_id: "/cells/singlets/blob", include: false },
    ]);
    expect(populations["/cells/singlets/T not blob"].gate_logic).toBe("and");
  });

  it("nests populations as the paths say, under a root named All Events", () => {
    expect(root).toBe("root");
    expect(populations.root.name).toBe("All Events");
    expect(populations.root.children).toEqual(["/cells"]);
    expect(populations["/cells"].children).toEqual(["/cells/singlets"]);
    expect(populations["/cells/singlets"].children).toEqual([
      "/cells/singlets/T", "/cells/singlets/blob",
      "/cells/singlets/CD3-CD19+", "/cells/singlets/CD3+CD19+", "/cells/singlets/CD3+CD19-", "/cells/singlets/CD3-CD19-",
      "/cells/singlets/not T", "/cells/singlets/T not blob",
    ]);
  });

  it("leaves out an OR node and its descendants, and what the host left out, each with its reason", () => {
    expect(populations["/cells/singlets/either"]).toBeUndefined();
    expect(populations["/cells/singlets/either/child"]).toBeUndefined();
    expect(translation.leftOut).toEqual([
      "/cells/table: FL4-A is on a FlowJo calibration table, whose parameters the object does not hold",
      "/cells/singlets/either: an OR of other nodes, which GateLab does not hold",
      "/cells/singlets/either/child: under '/cells/singlets/either', which was left out",
    ]);
  });

  it("binds the workspace to the dataset's samples", () => {
    expect(translation.workspace.samples.map((sample) => sample.sampleId)).toEqual(["gs:D1", "gs:D2"]);
    expect(translation.workspace.samples[0].instrumentMode).toBe("flow");
  });

  it("refuses a malformed node rather than restoring the rest without it", () => {
    const broken: HostedHierarchy = { contractVersion: 1, nodes: [{ path: "/x", name: "x", parent: "root", gate: { kind: "polygon", axes: [{ channel: "FSC-A", transform: null }, { channel: "SSC-A", transform: null }], vertices: [[0, 0], [1, "a" as unknown as number], [1, 1]] } }] };
    expect(() => translateGatingSetHierarchy(broken, dataset, transformSpec)).toThrow(/vertex 2 of node '\/x'/);
    expect(() => translateGatingSetHierarchy({ contractVersion: 3, nodes: [] }, dataset, transformSpec)).toThrow(/contract 3/);
    const withTransform = (transform: unknown): HostedHierarchy => ({ contractVersion: 1, nodes: [{ path: "/x", name: "x", parent: "root", gate: { kind: "rectangle", axes: [{ channel: "FSC-A", transform: transform as never }], min: [0], max: [1] } }] });
    expect(() => translateGatingSetHierarchy(withTransform({ kind: "hyperlog" }), dataset, transformSpec)).toThrow(/invalid transform/);
    expect(() => translateGatingSetHierarchy(withTransform({ kind: "future-transform" }), dataset, transformSpec)).toThrow(/unsupported/);
  });

  it("names a node on a channel the dataset lacks, and a boolean naming a node without a gate, as left out", () => {
    const stray: HostedHierarchy = {
      contractVersion: 1,
      nodes: [
        { path: "/x", name: "x", parent: "root", gate: { kind: "rectangle", axes: [{ channel: "FL9-A", transform: null }], min: [0], max: [1] } },
        { path: "/y", name: "y", parent: "root", boolean: { operator: "and", refs: [{ path: "/x", include: true }] } },
      ],
    };
    const out = translateGatingSetHierarchy(stray, dataset, transformSpec);
    expect(out.leftOut).toEqual([
      "/x: on channel 'FL9-A', which the dataset does not have",
      "/y: names '/x', which was left out",
    ]);
    expect(Object.keys(out.workspace.gating.populations)).toEqual(["root"]);
  });
});

describe("readHostedWorkspace and a GatingSet hierarchy", () => {
  it("restores the hierarchy as a workspace with no source space to convert", async () => {
    const restored = await readHostedWorkspace(
      { contractVersion: 1, datasetId: "gs", sourceFormat: "gatingset-hierarchy", revision: 0, workspaceJson: JSON.stringify(hierarchy) },
      dataset,
    );
    expect(restored.sourceFormat).toBe("gatingset-hierarchy");
    expect(restored.sourceGateSpace).toBeNull();
    expect(restored.workspace.gating.gate_order).toHaveLength(6);
    expect(restored.leftOut).toHaveLength(3);
  });

  it("accepts R's auto-unboxed one-item lists", async () => {
    const one = { contractVersion: 1, nodes: { path: "/a", name: "a", parent: "root", gate: { kind: "rectangle", axes: { channel: "FSC-A", transform: null }, min: 1, max: null } } };
    const restored = await readHostedWorkspace(
      { contractVersion: 1, datasetId: "gs", sourceFormat: "gatingset-hierarchy", revision: 0, workspaceJson: JSON.stringify(one) },
      dataset,
    );
    expect((restored.workspace.gating.gates["/a"] as PolyRectGate).vertices[0]).toEqual([1, -UNBOUNDED]);
  });
});

// A FlowJo workspace tailors a gate per sample, and a GatingSet parsed from it keeps each
// sample's own. Two samples of four events on linear scatter, one value apart, so every
// membership below is a count of known events: "cells" is FSC-A in [0, 60] on D1 (the tree's)
// and [40, 100] on D2 (its own), and "core", under it, is the polygon both share.
describe("a GatingSet hierarchy whose gates differ between samples", () => {
  const scatter: GateLabHostDatasetDescriptor = {
    contractVersion: 1,
    id: "gs",
    label: "gatelabr_gs",
    instrument: "flow",
    eventCount: 8,
    channels: [
      { id: "FSC-A", label: "FSC-A", pnn: "FSC-A" },
      { id: "SSC-A", label: "SSC-A", pnn: "SSC-A" },
    ],
    assays: [{ id: "counts", label: "counts", role: "counts", coordinateSpace: "linear", revision: 0, encoding: "channel-major-float32-le" }],
    defaultAssayId: "counts",
    samples: [
      { id: "D1", label: "D1", eventCount: 4, metadata: {}, assayByteLength: 32, eventIndexEncoding: "uint32-le", eventIndexByteLength: 16 },
      { id: "D2", label: "D2", eventCount: 4, metadata: {}, assayByteLength: 32, eventIndexEncoding: "uint32-le", eventIndexByteLength: 16 },
    ],
  };
  const axes = [{ channel: "FSC-A", transform: null }, { channel: "SSC-A", transform: null }];
  const range = (lo: number, hi: number) => ({ kind: "rectangle" as const, axes: [axes[0]], min: [lo], max: [hi] });
  const tailoredHierarchy: HostedHierarchy = {
    contractVersion: 2,
    nodes: [
      { path: "/cells", name: "cells", parent: "root", gate: range(0, 60), tailored: [{ sample: "D2", gate: range(40, 100) }] },
      { path: "/cells/core", name: "core", parent: "/cells", gate: { kind: "polygon", axes, vertices: [[45, 0], [200, 0], [200, 10], [45, 10]] } },
    ],
  };
  // FSC-A then SSC-A, channel-major, the same events on both samples.
  const values = new Float32Array([10, 50, 90, 130, 5, 5, 5, 5]);
  const port: GateLabHostDatasetPort = {
    async listDatasets() { return [scatter]; },
    async readAssay() { return values.slice().buffer as ArrayBuffer; },
    async readEventIndex() { return new Uint32Array([0, 1, 2, 3]).buffer as ArrayBuffer; },
  };

  it("opens the tree with the reference gate and gives the differing sample a tailored copy carrying its own", () => {
    const { workspace, tailoring, leftOut } = translateGatingSetHierarchy(tailoredHierarchy, scatter, transformSpec);
    expect(leftOut).toEqual([]);
    expect(tailoring).toEqual([{ sample: "D2", gates: 1 }]);
    const tree = workspace.gating;
    expect((tree.gates["/cells"] as PolyRectGate).vertices[0]).toEqual([0, -UNBOUNDED]);
    expect((tree.gates["/cells"] as PolyRectGate).vertices[1]).toEqual([60, -UNBOUNDED]);
    expect(tree.hierarchies).toEqual([
      { id: "main", name: "Main" },
      expect.objectContaining({ id: tailoredHierarchyId("D2"), name: "D2 · Main", owner_sample_id: "gs:D2", structure_locked: true, source_hierarchy_id: "main" }),
    ]);
    expect(tree.active_hierarchy_id).toBe("main");
    expect(tree.perFileHierarchies).toBe(true);
    // D1 follows the tree; D2 is gated under its copy.
    expect(workspace.samples.map((sample) => sample.hierarchyId)).toEqual([undefined, tailoredHierarchyId("D2")]);
    const copy = tree.stored_hierarchies![0];
    expect(copy.root_population_id).toBe("D2:root");
    expect(copy.source_population_ids).toEqual({ "D2:root": "root", "D2:/cells": "/cells", "D2:/cells/core": "/cells/core" });
    expect(copy.source_gate_ids).toEqual({ "D2:/cells": "/cells", "D2:/cells/core": "/cells/core" });
    const own = copy.gates!["D2:/cells"] as PolyRectGate;
    expect(own.vertices[0]).toEqual([40, -UNBOUNDED]);
    expect(own.vertices[1]).toEqual([100, -UNBOUNDED]);
    expect(own.name).toBe("cells");
    expect(own.color).toBe(tree.gates["/cells"].color);
    // The shared polygon is the tree's on the copy too.
    expect((copy.gates!["D2:/cells/core"] as PolyRectGate).vertices).toEqual((tree.gates["/cells/core"] as PolyRectGate).vertices);
    expect(copy.populations["D2:/cells/core"].parent_id).toBe("D2:/cells");
    expect(copy.populations["D2:/cells"].gate_refs).toEqual([{ gate_id: "D2:/cells", include: true }]);
  });

  it("gates each sample by its own gate: D2's events are its own rectangle's, under the tree's population ids", async () => {
    const { workspace } = translateGatingSetHierarchy(tailoredHierarchy, scatter, transformSpec);
    const hosted = await loadHostedDataset(port, scatter);
    const ids = hosted.map((entry) => `${entry.datasetId}:${entry.sampleId}`);
    // As the app opens a hosted workspace (App.tsx): the hierarchies, the copies, each file's tree.
    const state = coreReducer(initialCoreState(), {
      type: "loadWorkspace",
      gates: workspace.gating.gates,
      gate_order: workspace.gating.gate_order,
      populations: workspace.gating.populations,
      root_population_id: workspace.gating.root_population_id,
      active_population_id: workspace.gating.active_population_id,
      selected_gate_id: workspace.gating.selected_gate_id,
      hierarchies: workspace.gating.hierarchies,
      active_hierarchy_id: workspace.gating.active_hierarchy_id,
      stored_hierarchies: workspace.gating.stored_hierarchies?.map((h) => ({ ...h, gates: h.gates!, gate_order: h.gate_order!, selected_pop_ids: [] }) as StoredHierarchy),
      file_hierarchies: Object.fromEntries(workspace.samples.flatMap((sample, i) => (sample.hierarchyId ? [[ids[i], sample.hierarchyId]] : []))),
      groups: [],
      file_groups: {},
    });
    expect(state.file_hierarchies).toEqual({ "gs:D2": tailoredHierarchyId("D2") });
    const samples: HostedMembershipSample[] = hosted.map((entry, i) => ({
      sampleId: entry.sampleId,
      eventCount: 4,
      name: entry.name,
      hierarchyId: fileHierarchyId(state.file_hierarchies[ids[i]], state.hierarchies),
      gatingFor: (tree: HierarchyTree) => recomputeGating(entry.sample, gatingStateForTree(state, tree)),
    }));
    const reader = hostedMembershipReader(state, samples);
    const main = reader.trees.find((tree) => tree.id === "main")!;
    const mask = (index: number, population: string) => Array.from(reader.mask(index, main, population) ?? []);
    // D1, the tree's gate: FSC-A 10 and 50 are in [0, 60].
    expect(mask(0, "/cells")).toEqual([1, 1, 0, 0]);
    // D2, its own: 50 and 90 are in [40, 100]. Under the tree's gate it would have held 10 and 50.
    expect(mask(1, "/cells")).toEqual([0, 1, 1, 0]);
    // The polygon both share is evaluated within each sample's own cells.
    expect(mask(0, "/cells/core")).toEqual([0, 1, 0, 0]);
    expect(mask(1, "/cells/core")).toEqual([0, 1, 1, 0]);
    // And each sample's own tree, gated directly, counts the same.
    const copy = reader.trees.find((tree) => tree.id === tailoredHierarchyId("D2"))!;
    expect(recomputeGating(hosted[1].sample, gatingStateForTree(state, copy)).stats.event_count["D2:/cells"]).toBe(2);
  });

  it("reads a contract-1 hierarchy, which tailors nothing, as before", () => {
    const old = { contractVersion: 1, nodes: [tailoredHierarchy.nodes[0]] };
    const { workspace, tailoring } = translateGatingSetHierarchy({ ...old, nodes: [{ ...old.nodes[0], tailored: undefined }] }, scatter, transformSpec);
    expect(tailoring).toEqual([]);
    expect(workspace.gating.hierarchies).toBeUndefined();
    expect(workspace.samples.every((sample) => sample.hierarchyId === undefined)).toBe(true);
  });

  it("leaves out a node whose tailored gate it cannot hold, or a quadrant set whose members differ, naming the sample", () => {
    const quadrant = (center: [number, number], second: string) => ({
      kind: "quadrant" as const, axes, center,
      members: [
        { path: "/q1", name: "q1", quadrant: 1 }, { path: second, name: "x", quadrant: 2 },
        { path: "/q3", name: "q3", quadrant: 3 }, { path: "/q4", name: "q4", quadrant: 4 },
      ],
    });
    const out = translateGatingSetHierarchy({
      contractVersion: 2,
      nodes: [
        { path: "/a", name: "a", parent: "root", gate: range(0, 60), tailored: [{ sample: "D2", gate: { kind: "polygon", axes, vertices: [[0, 0], [1, 1]] } }] },
        { path: "/a/b", name: "b", parent: "/a", gate: range(0, 1) },
        { path: "/FSC-A x SSC-A quadrants", name: "FSC-A x SSC-A quadrants", parent: "root", gate: quadrant([50, 5], "/q2"), tailored: [{ sample: "D2", gate: quadrant([60, 5], "/elsewhere") }] },
      ],
    }, scatter, transformSpec);
    expect(out.leftOut).toEqual([
      "/a: a polygon of 2 vertices (on sample 'D2')",
      "/a/b: under '/a', which was left out",
      "/q1: a quadrant set on some samples and not on sample 'D2'",
      "/q2: a quadrant set on some samples and not on sample 'D2'",
      "/q3: a quadrant set on some samples and not on sample 'D2'",
      "/q4: a quadrant set on some samples and not on sample 'D2'",
    ]);
    expect(out.tailoring).toEqual([]);
    expect(() => translateGatingSetHierarchy({
      contractVersion: 2,
      nodes: [{ path: "/a", name: "a", parent: "root", gate: range(0, 60), tailored: [{ sample: "D9", gate: range(0, 1) }] }],
    }, scatter, transformSpec)).toThrow(/sample 'D9', which the dataset does not have/);
  });

  it("tailors a quadrant set by its centre, its members kept", () => {
    const quadrant = (center: [number, number]) => ({
      kind: "quadrant" as const, axes, center,
      members: [1, 2, 3, 4].map((quadrant) => ({ path: `/q${quadrant}`, name: `q${quadrant}`, quadrant })),
    });
    const out = translateGatingSetHierarchy({
      contractVersion: 2,
      nodes: [{ path: "/FSC-A x SSC-A quadrants", name: "FSC-A x SSC-A quadrants", parent: "root", gate: quadrant([50, 5]), tailored: [{ sample: "D2", gate: quadrant([60, 4]) }] }],
    }, scatter, transformSpec);
    const copy = out.workspace.gating.stored_hierarchies![0];
    expect((copy.gates!["D2:/FSC-A x SSC-A quadrants"] as QuadrantGate).center).toEqual([60, 4]);
    expect(copy.populations["D2:/q2"].gate_refs).toEqual([{ gate_id: "D2:/FSC-A x SSC-A quadrants", include: true, quadrant: 2 }]);
  });
});

describe("a negated boolean of several nodes", () => {
  it("is left out: NOT (A AND B) is no population of GateLab's, and NOT A AND NOT B holds other events", () => {
    const negatedAnd: HostedHierarchy = {
      contractVersion: 2,
      nodes: [
        hierarchy.nodes[0], hierarchy.nodes[1], hierarchy.nodes[2], hierarchy.nodes[3],
        {
          path: "/cells/singlets/not both", name: "not both", parent: "/cells/singlets", negated: true,
          boolean: { operator: "and", refs: [{ path: "/cells/singlets/T", include: true }, { path: "/cells/singlets/blob", include: true }] },
        },
        {
          path: "/cells/singlets/not T bool", name: "not T bool", parent: "/cells/singlets", negated: true,
          boolean: { operator: "and", refs: [{ path: "/cells/singlets/T", include: true }] },
        },
      ],
    };
    const out = translateGatingSetHierarchy(negatedAnd, dataset, transformSpec);
    expect(out.workspace.gating.populations["/cells/singlets/not both"]).toBeUndefined();
    expect(out.leftOut).toEqual(["/cells/singlets/not both: a NOT of an AND of several nodes, which a GateLab population cannot hold"]);
    // A NOT of one node is that node's gate, excluded: the one form a population holds exactly.
    expect(out.workspace.gating.populations["/cells/singlets/not T bool"].gate_refs).toEqual([{ gate_id: "/cells/singlets/T", include: false }]);
  });
});
