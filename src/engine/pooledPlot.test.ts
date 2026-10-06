// The data here is synthetic: two three-event files, D1 and D2, on one tree and a copy of it.
import { describe, expect, it } from "vitest";
import { initialCoreState } from "../store";
import type { FcsFile } from "./fcs";
import { figureHierarchies, prepareFigureSource, resolvePopulationInTree } from "./figure";
import { defaultIllustrationConfig, figureStyle } from "./figureDefaults";
import { cloneHierarchyTree, storeHierarchy, type StoredHierarchy } from "./hierarchies";
import type { GateOverlay } from "./illustration";
import { newGate, newPopulation, newRootPopulation } from "./models";
import { buildPooledPlotPayload, gateGeometryKey, poolCompatibility, pooledGateAgreement, pooledGateOverlays, type PooledMember } from "./pooledPlot";
import { Sample } from "./sample";

function fcs(scale: number, marker: string | null = null): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: 3,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([10, 100, 200].map((x) => x * scale)), Float32Array.from([10, 100, 200])],
  };
}

/** The tree `main` with one rectangle, CD4_positive [0,0]–[150,150], under All Events, and the copy `leaf` D2 follows. */
function fixture() {
  const state = initialCoreState();
  const root = newRootPopulation();
  const gate = newGate("CD4_positive", "rectangle", "FSC-A", "SSC-A", [[0, 0], [150, 150]]);
  const pop = newPopulation("Singlets", [], root.population_id);
  pop.gate_refs = [{ gate_id: gate.gate_id, include: true }];
  root.children = [pop.population_id];
  Object.assign(state, {
    gates: { [gate.gate_id]: gate },
    gate_order: [gate.gate_id],
    populations: { [root.population_id]: root, [pop.population_id]: pop },
    root_population_id: root.population_id,
    active_population_id: root.population_id,
  });
  const copy = cloneHierarchyTree(state.populations, root.population_id, state.gates, state.gate_order);
  const leaf: StoredHierarchy = {
    ...storeHierarchy({ id: "leaf", name: "D2 copy" }, { ...state, ...copy }),
    source_hierarchy_id: "main",
    source_population_ids: Object.fromEntries(Object.entries(copy.idMap).map(([a, b]) => [b, a])),
    source_gate_ids: Object.fromEntries(Object.entries(copy.gateIdMap).map(([a, b]) => [b, a])),
    owner_sample_id: "D2",
    structure_locked: true,
  };
  state.hierarchies.push(leaf);
  state.stored_hierarchies.leaf = leaf;
  const trees = figureHierarchies(state);
  // A member's population is All Events as its own tree names it, as the Layout tab resolves a
  // plot's population into each pooled file's tree.
  const member = (id: string, scale: number, treeId: string): PooledMember => {
    const sample = new Sample(fcs(scale));
    const source = prepareFigureSource({ id, name: `${id}.fcs`, sample, hierarchyId: treeId }, trees[treeId], state);
    const populationId = resolvePopulationInTree(root.population_id, source.tree, trees, "main").id;
    return { id, name: `${id}.fcs`, sample, tree: source.tree, gating: source.gating, populationId };
  };
  /** The trees with the copy's rectangle moved: D2 no longer holds the gate alike. */
  const tailoredTrees = (): Record<string, StoredHierarchy> => {
    const leafGateId = copy.gateIdMap[gate.gate_id];
    const original = trees.leaf.gates[leafGateId];
    if (original.gate_type !== "rectangle") throw new Error("the fixture's gate is a rectangle");
    return { ...trees, leaf: { ...trees.leaf, gates: { ...trees.leaf.gates, [leafGateId]: { ...original, vertices: [[0, 0], [500, 500]] } } } };
  };
  return { state, trees, root, gate, leafGateId: copy.gateIdMap[gate.gate_id], member, tailoredTrees };
}

describe("pooledGateAgreement", () => {
  it("agrees on one tree, on an equal copy, and not on a tailored or deleted gate", () => {
    const f = fixture();
    const canonical = f.gate.gate_id;
    expect(pooledGateAgreement(f.trees, ["main", "main"], "FSC-A", "SSC-A")).toEqual({ agreed: [canonical], omitted: [] });
    expect(pooledGateAgreement(f.trees, ["main", "leaf"], "SSC-A", "FSC-A").agreed).toEqual([canonical]);
    expect(pooledGateAgreement(f.tailoredTrees(), ["main", "leaf"], "FSC-A", "SSC-A")).toEqual({ agreed: [], omitted: [{ gateId: canonical, name: "CD4_positive" }] });
    const deleted = { ...f.trees, leaf: { ...f.trees.leaf, gates: {}, gate_order: [] } };
    expect(pooledGateAgreement(deleted, ["main", "leaf"], "FSC-A", "SSC-A").omitted.map((g) => g.name)).toEqual(["CD4_positive"]);
    // A moved label is not a different gate; a histogram has no gates.
    expect(gateGeometryKey({ ...f.gate, label_offset: [5, 5], color: "#f00" })).toBe(gateGeometryKey(f.gate));
    expect(pooledGateAgreement(f.trees, ["main", "leaf"], "FSC-A", null)).toEqual({ agreed: [], omitted: [] });
  });
});

describe("pooledGateOverlays", () => {
  it("labels the agreed gates with the percentage over every file, and sums quadrant counts", () => {
    const f = fixture();
    const overlay = (gateId: string, count: number): GateOverlay => ({ gate_id: gateId, name: "CD4_positive", percent_of_parent: null, event_count: count, gate_type: "rectangle", color: "#000", label_offset: null });
    const parts = [
      { tree: f.trees.main, gates: [overlay(f.gate.gate_id, 2)], populationCount: 3 },
      { tree: f.trees.leaf, gates: [overlay(f.leafGateId, 1)], populationCount: 3 },
    ];
    const pooled = pooledGateOverlays(parts, f.trees, new Set([f.gate.gate_id]));
    expect(pooled.map((g) => [g.gate_id, g.event_count, g.percent_of_parent])).toEqual([[f.gate.gate_id, 3, 50]]);
    expect(pooledGateOverlays(parts, f.trees, new Set())).toEqual([]);
    const quadrant = (gateId: string, counts: number[]): GateOverlay => ({ gate_id: gateId, name: "Q", percent_of_parent: null, gate_type: "quadrant", center: [1, 1], quadrant_counts: counts, quadrant_pcts: [0, 0, 0, 0], color: "#000", label_offset: null });
    const quadrants = pooledGateOverlays(
      [{ tree: f.trees.main, gates: [quadrant(f.gate.gate_id, [1, 1, 0, 1])], populationCount: 3 }, { tree: f.trees.leaf, gates: [quadrant(f.leafGateId, [0, 2, 1, 0])], populationCount: 3 }],
      f.trees,
      new Set([f.gate.gate_id]),
    );
    expect(quadrants[0].quadrant_counts).toEqual([1, 3, 1, 1]);
    expect(quadrants[0].quadrant_pcts).toEqual([16.67, 50, 16.67, 16.67]);
  });
});

describe("poolCompatibility", () => {
  it("names a different marker under the same key, a missing channel, and nothing when the files match", () => {
    // The plot's channels are keys; two files can share a key while naming different markers.
    const file = (marker: string): FcsFile => {
      const base = fcs(1, marker);
      return { ...base, channels: [{ ...base.channels[0], appKey: "CD3" }, { ...base.channels[1], appKey: "SSC-A" }] };
    };
    const reference = new Sample(file("CD3"));
    expect(poolCompatibility(reference, new Sample(file("CD3")), "CD3", "SSC-A")).toBeNull();
    expect(poolCompatibility(reference, new Sample(file("CD4")), "CD3", "SSC-A")).toBe("different channel identities");
    expect(poolCompatibility(reference, new Sample(file("CD3")), "CD3", "CD8")).toBe("channel CD8 unavailable");
  });
});

describe("buildPooledPlotPayload", () => {
  it("pools the events, sums the count and draws the shared gate with its pooled percentage", () => {
    const f = fixture();
    const members = [f.member("D1", 1, "main"), f.member("D2", 2, "leaf")];
    const payload = buildPooledPlotPayload(members, "FSC-A", "SSC-A", {}, figureStyle(defaultIllustrationConfig()), f.trees)!;
    // D1 holds (10,10) and (100,100) inside the rectangle, D2 holds (20,10): 3 of the 6 events.
    expect(payload.count).toBe(6);
    expect(payload.config.n_events).toBe(6);
    expect(payload.config.x).toHaveLength(6);
    expect(payload.config.y).toHaveLength(6);
    expect(payload.gates.map((g) => [g.name, g.event_count, g.percent_of_parent])).toEqual([["CD4_positive", 3, 50]]);
    expect(payload.omittedGates).toEqual([]);
  });

  it("shares the cap out and names a gate the copy tailored", () => {
    const f = fixture();
    const members = [f.member("D1", 1, "main"), f.member("D2", 2, "leaf")];
    const capped = buildPooledPlotPayload(members, "FSC-A", "SSC-A", {}, { ...figureStyle(defaultIllustrationConfig()), maxEvents: 3 }, f.trees)!;
    expect(capped.config.x).toHaveLength(3);
    expect(capped.count).toBe(6);
    // A cap of 0 is every event, as on the Gating tab.
    const every = buildPooledPlotPayload(members, "FSC-A", "SSC-A", {}, { ...figureStyle(defaultIllustrationConfig()), maxEvents: 0 }, f.trees)!;
    expect(every.config.x).toHaveLength(6);
    const tailored = f.tailoredTrees();
    const differing = [members[0], { ...members[1], tree: tailored.leaf }];
    const payload = buildPooledPlotPayload(differing, "FSC-A", "SSC-A", {}, figureStyle(defaultIllustrationConfig()), tailored)!;
    expect(payload.gates).toEqual([]);
    expect(payload.omittedGates).toEqual(["CD4_positive"]);
    expect(buildPooledPlotPayload([], "FSC-A", "SSC-A", {}, figureStyle(defaultIllustrationConfig()), f.trees)).toBeNull();
  });
});
