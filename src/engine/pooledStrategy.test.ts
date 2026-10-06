import { describe, expect, it } from "vitest";
import { cloneHierarchyTree, DEFAULT_HIERARCHY_ID, storeHierarchy } from "./hierarchies";
import type { FcsFile } from "./fcs";
import { figureHierarchies, prepareFigureSource } from "./figure";
import { newGate, newPopulation, newRootPopulation } from "./models";
import { Sample } from "./sample";
import { initialCoreState } from "../store";
import { buildPooledStrategyPayload } from "./strategy";
import { computePooledGatingStrategy, computePooledMultiPopStrategy, type StrategyMember } from "./pooledStrategy";

/**
 * Three files of three events each on FSC-A × SSC-A: D1 and D3 on the workspace tree, whose
 * Lymphocytes rectangle 0..15 × 0..35 holds one event of each; D2 on its own copy of the tree
 * with the rectangle widened to 0..25 × 0..35, holding two.
 */
function fixture() {
  const state = initialCoreState();
  const root = newRootPopulation();
  const child = newPopulation("Lymphocytes", [], root.population_id);
  const gate = newGate("Lymph_gate", "rectangle", "FSC-A", "SSC-A", [[0, 0], [15, 35]]);
  child.gate_refs = [{ gate_id: gate.gate_id, include: true }];
  root.children = [child.population_id];
  Object.assign(state, {
    gates: { [gate.gate_id]: gate },
    gate_order: [gate.gate_id],
    populations: { [root.population_id]: root, [child.population_id]: child },
    root_population_id: root.population_id,
    active_population_id: child.population_id,
    active_hierarchy_id: DEFAULT_HIERARCHY_ID,
  });
  const copy = cloneHierarchyTree(state.populations, root.population_id, state.gates, state.gate_order);
  const leaf = {
    ...storeHierarchy({ id: "leaf", name: "D2 copy" }, { ...state, ...copy }),
    source_hierarchy_id: DEFAULT_HIERARCHY_ID,
    source_population_ids: Object.fromEntries(Object.entries(copy.idMap).map(([a, b]) => [b, a])),
    source_gate_ids: Object.fromEntries(Object.entries(copy.gateIdMap).map(([a, b]) => [b, a])),
    owner_sample_id: "D2",
    structure_locked: true,
  };
  const copiedGateId = copy.gateIdMap[gate.gate_id];
  const copied = leaf.gates[copiedGateId];
  if (copied.gate_type !== "rectangle") throw new Error("the fixture's gate is a rectangle");
  leaf.gates[copiedGateId] = { ...copied, vertices: [[0, 0], [25, 35]] };
  state.hierarchies.push(leaf);
  state.stored_hierarchies.leaf = leaf;
  const fcs = (): FcsFile => ({
    version: "FCS3.1",
    nEvents: 3,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([10, 20, 30]), Float32Array.from([30, 20, 10])],
  });
  const trees = figureHierarchies(state);
  const member = (id: string, hierarchyId: string, populationId: string): StrategyMember => {
    const source = prepareFigureSource({ id, name: `${id}.fcs`, sample: new Sample(fcs()), hierarchyId }, trees[hierarchyId], state);
    return { id, name: source.name, sample: source.sample, tree: source.tree, gating: source.gating, populationId };
  };
  const D1 = member("D1", DEFAULT_HIERARCHY_ID, child.population_id);
  const D3 = member("D3", DEFAULT_HIERARCHY_ID, child.population_id);
  const D2 = member("D2", "leaf", copy.idMap[child.population_id]);
  return { state, trees, root, child, gate, D1, D2, D3 };
}

const options = {
  gateView: ["forward"] as ("forward" | "back")[],
  displayMode: "scatter",
  maxEvents: 0,
  nColumns: 4,
  plotSize: 200,
  fitToColumns: true,
  contourThreshold: 5,
  pointAlpha: 0.35,
  densityColorPower: 1.6,
  pointSize: 1.2,
  kdeBandwidth: 0,
  pubStyle: false,
  gateLineWidth: 1.5,
  fontSizes: { tick: 12, axis_label: 12, gate_label: 12, title: 12 },
};

describe("a pooled strategy", () => {
  it("draws every file's parent events on one step, sums the counts and shares out the cap", () => {
    const { trees, D1, D3 } = fixture();
    const pooled = computePooledGatingStrategy([D1, D3], trees, { fullPath: true, maxEvents: 0 });
    expect(pooled.drawn.map((m) => m.id)).toEqual(["D1", "D3"]);
    expect(pooled.leftOut).toEqual([]);
    expect(pooled.omittedGates).toEqual([]);
    expect(pooled.steps).toHaveLength(1);
    expect(pooled.steps[0]).toMatchObject({ gate_name: "Lymph_gate", n_before: 6, n_after: 2, n_total: 6, pct_pass: 33.3, pct_total: 33.3 });
    expect(pooled.steps[0].x).toHaveLength(6);
    expect(pooled.steps[0].displayVertices).toHaveLength(4);

    const capped = computePooledGatingStrategy([D1, D3], trees, { fullPath: true, maxEvents: 4 });
    expect(capped.steps[0].x).toHaveLength(4);
    expect(capped.steps[0]).toMatchObject({ n_before: 6, n_after: 2 });
  });

  it("counts a tailored copy by its own gate and leaves the boundary off, named", () => {
    const { trees, D1, D2 } = fixture();
    const pooled = computePooledGatingStrategy([D1, D2], trees, { fullPath: true, maxEvents: 0 });
    expect(pooled.drawn.map((m) => m.id)).toEqual(["D1", "D2"]);
    expect(pooled.steps[0]).toMatchObject({ n_before: 6, n_after: 3, pct_pass: 50 });
    expect(pooled.steps[0].displayVertices).toEqual([]);
    expect(pooled.steps[0].outline).toBeUndefined();
    expect(pooled.omittedGates).toEqual(["Lymph_gate"]);
  });

  it("leaves out a file without the population or the channels, and says why", () => {
    const { trees, D1, D3 } = fixture();
    const other: FcsFile = {
      ...D3.sample.fcs,
      channels: [
        { index: 0, name: "FL1-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "FL2-A", marker: null, bits: 32, range: 262144 },
      ],
    };
    const strange = { ...D3, id: "D4", name: "D4.fcs", sample: new Sample(other) };
    const pooled = computePooledGatingStrategy([D1, { ...D3, populationId: "" }, strange], trees, { fullPath: true, maxEvents: 0 });
    expect(pooled.drawn.map((m) => m.id)).toEqual(["D1"]);
    expect(pooled.leftOut).toEqual([
      { name: "D3.fcs", reason: "lacks the population" },
      { name: "D4.fcs", reason: "channel FSC-A unavailable" },
    ]);
    expect(pooled.steps[0]).toMatchObject({ n_before: 3, n_after: 1 });
  });

  it("builds the payload with every file's back-gated events and a range over all of them", () => {
    const { trees, D1, D3 } = fixture();
    const pooled = computePooledGatingStrategy([D1, D3], trees, { fullPath: true, maxEvents: 0 });
    const parts = pooled.drawn.map((member) => ({ sample: member.sample, finalMask: member.gating.masks[member.populationId] ?? null }));
    const payload = buildPooledStrategyPayload(parts, pooled.steps, {}, { ...options, gateView: ["forward", "back"] }) as { steps: Record<string, unknown>[] };
    expect(payload.steps[0].x).toHaveLength(6);
    expect(payload.steps[0].x_back).toHaveLength(2);
    expect(payload.steps[0]).toMatchObject({ n_before: 6, n_after: 2, pct_pass: 33.3 });
  });
});

describe("a pooled multi-population grid", () => {
  it("draws one node per parent and channel pair from every file, with the pooled percentage", () => {
    const { trees, child, D1, D3 } = fixture();
    const pooled = computePooledMultiPopStrategy([D1, D3], [child.population_id], DEFAULT_HIERARCHY_ID, trees, { maxEvents: 0, globalScales: {} });
    expect(pooled.drawn.map((m) => m.id)).toEqual(["D1", "D3"]);
    expect(pooled.channels).toEqual(["FSC-A", "SSC-A"]);
    expect(pooled.nodes).toHaveLength(1);
    expect(pooled.nodes[0]).toMatchObject({ n_events: 6, row: 0, col: 0 });
    expect(pooled.nodes[0].x).toHaveLength(6);
    expect(pooled.nodes[0].gates).toHaveLength(1);
    expect(pooled.nodes[0].gates[0]).toMatchObject({ name: "Lymphocytes", percent_of_parent: 33.3 });
    expect(pooled.omittedGates).toEqual([]);

    const capped = computePooledMultiPopStrategy([D1, D3], [child.population_id], DEFAULT_HIERARCHY_ID, trees, { maxEvents: 2, globalScales: {} });
    expect(capped.nodes[0].x).toHaveLength(2);
    expect(capped.nodes[0].n_events).toBe(6);
  });

  it("follows the populations into a copy, and leaves a gate the copy tailored off the node", () => {
    const { trees, child, D1, D2 } = fixture();
    const pooled = computePooledMultiPopStrategy([D1, D2], [child.population_id], DEFAULT_HIERARCHY_ID, trees, { maxEvents: 0, globalScales: {} });
    expect(pooled.drawn.map((m) => m.id)).toEqual(["D1", "D2"]);
    expect(pooled.nodes).toHaveLength(1);
    expect(pooled.nodes[0]).toMatchObject({ n_events: 6 });
    expect(pooled.nodes[0].x).toHaveLength(6);
    expect(pooled.nodes[0].gates).toEqual([]);
    expect(pooled.omittedGates).toEqual(["Lymphocytes"]);
  });
});
