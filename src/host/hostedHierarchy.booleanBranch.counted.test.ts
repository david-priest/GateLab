// A GatingSet boolean node names populations by path; cytolib evaluates it on those populations'
// full membership (their ancestors' gates included), intersected with the boolean node's parent.
import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recomputeGating } from "../store";
import type { GateLabHostDatasetDescriptor, GateLabHostDatasetPort } from "./datasetContract";
import { translateGatingSetHierarchy, type HostedHierarchy } from "./hostedHierarchy";
import { loadHostedDataset } from "./hostedSample";
import { transformSpec } from "./hostedWorkspace";

const ds: GateLabHostDatasetDescriptor = {
  contractVersion: 1, id: "gs", label: "gs", instrument: "flow", eventCount: 4,
  channels: [{ id: "FSC-A", label: "FSC-A", pnn: "FSC-A" }, { id: "SSC-A", label: "SSC-A", pnn: "SSC-A" }],
  assays: [{ id: "counts", label: "counts", role: "counts", coordinateSpace: "linear", revision: 0, encoding: "channel-major-float32-le" }],
  defaultAssayId: "counts",
  samples: [{ id: "S1", label: "S1", eventCount: 4, metadata: {}, assayByteLength: 32, eventIndexEncoding: "uint32-le", eventIndexByteLength: 16 }],
};
const axes = [{ channel: "FSC-A", transform: null }, { channel: "SSC-A", transform: null }];
const hierarchy = (extra: HostedHierarchy["nodes"]): HostedHierarchy => ({
  contractVersion: 2,
  nodes: [
    { path: "/cells", name: "cells", parent: "root", gate: { kind: "rectangle", axes: [axes[0]], min: [0], max: [60] } },
    { path: "/cells/CD4_positive", name: "CD4_positive", parent: "/cells", gate: { kind: "polygon", axes, vertices: [[45, 0], [200, 0], [200, 10], [45, 10]] } },
    { path: "/cells/low", name: "low", parent: "/cells", gate: { kind: "rectangle", axes: [axes[0]], min: [0], max: [30] } },
    ...extra,
  ],
});
const values = new Float32Array([10, 50, 90, 130, 5, 5, 5, 5]);
const port: GateLabHostDatasetPort = {
  async listDatasets() { return [ds]; },
  async readAssay() { return values.slice().buffer as ArrayBuffer; },
  async readEventIndex() { return new Uint32Array([0, 1, 2, 3]).buffer as ArrayBuffer; },
};

async function masks(h: HostedHierarchy) {
  const translation = translateGatingSetHierarchy(h, ds, transformSpec);
  const { workspace } = translation;
  const [hosted] = await loadHostedDataset(port, ds);
  const state = coreReducer(initialCoreState(), {
    type: "loadWorkspace",
    gates: workspace.gating.gates, gate_order: workspace.gating.gate_order, populations: workspace.gating.populations,
    root_population_id: workspace.gating.root_population_id, active_population_id: workspace.gating.active_population_id,
    selected_gate_id: null, hierarchies: workspace.gating.hierarchies, active_hierarchy_id: workspace.gating.active_hierarchy_id,
    stored_hierarchies: [], file_hierarchies: {}, groups: [], file_groups: {},
  } as never);
  const gating = recomputeGating(hosted.sample, state);
  return { translation, mask: (id: string) => Array.from(gating.masks[id]) };
}

// Events 10, 50, 90, 130 on FSC-A. The gate of cells holds the first two, the polygon of
// CD4_positive the last three, so the population CD4_positive holds the second alone; low holds
// the first.
describe("a GatingSet boolean naming a node outside its own branch", () => {
  it("holds the named population, its parents' gates included", async () => {
    const { mask } = await masks(hierarchy([
      { path: "/CD4_bool", name: "CD4_bool", parent: "root", boolean: { operator: "and", refs: [{ path: "/cells/CD4_positive", include: true }] } },
    ]));
    expect(mask("/cells/CD4_positive")).toEqual([0, 1, 0, 0]);
    expect(mask("/CD4_bool")).toEqual([0, 1, 0, 0]);
  });

  it("adds nothing for a node under the boolean's own parent", async () => {
    const { translation, mask } = await masks(hierarchy([
      { path: "/cells/not_low", name: "not_low", parent: "/cells", boolean: { operator: "and", refs: [{ path: "/cells/CD4_positive", include: true }, { path: "/cells/low", include: false }] } },
    ]));
    expect(translation.workspace.gating.populations["/cells/not_low"].gate_refs).toEqual([
      { gate_id: "/cells/CD4_positive", include: true },
      { gate_id: "/cells/low", include: false },
    ]);
    expect(mask("/cells/not_low")).toEqual([0, 1, 0, 0]);
  });

  it("leaves out a boolean excluding a node of another branch, which is an OR", async () => {
    const { translation } = await masks(hierarchy([
      { path: "/no_CD4", name: "no_CD4", parent: "root", boolean: { operator: "and", refs: [{ path: "/cells/CD4_positive", include: false }] } },
      { path: "/not_CD4", name: "not_CD4", parent: "root", negated: true, boolean: { operator: "and", refs: [{ path: "/cells/CD4_positive", include: true }] } },
    ]));
    expect(translation.workspace.gating.populations["/no_CD4"]).toBeUndefined();
    expect(translation.workspace.gating.populations["/not_CD4"]).toBeUndefined();
    expect(translation.leftOut.filter((line) => line.startsWith("/no_CD4") || line.startsWith("/not_CD4"))).toEqual([
      "/no_CD4: excludes '/cells/CD4_positive', which lies under '/cells' and not under this node's own parents; that is an OR, which GateLab does not hold",
      "/not_CD4: a NOT of a node with the gates of the nodes above it, which a GateLab population cannot hold",
    ]);
  });
});
