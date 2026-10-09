// @vitest-environment jsdom
//
// A quadrant gate on the Strategy tab. It has no vertices, and the strategy code drew a gate
// from its vertices, so a panel gated by a quadrant showed its events and no gate at all
// (reported on a pooled strategy to four quadrant populations). One crosshair makes four
// populations: the panel draws it once, with each quadrant's share of the parent.

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import type { FcsFile } from "./fcs";
import { figureHierarchies, prepareFigureSource } from "./figure";
import { newGateRef, newPopulation, newQuadrantGate, newRootPopulation } from "./models";
import { Sample } from "./sample";
import { initialCoreState } from "../store";
import { buildStrategyPayload, computeGatingStrategy } from "./strategy";
import { buildMultiStrategyPayload, computeMultiPopStrategy } from "./multiStrategy";
import { computePooledMultiPopStrategy, type StrategyMember } from "./pooledStrategy";
import { loadMiniPlots } from "../plots/loadPlots";

/**
 * Two files of five events on FSC-A × SSC-A and one quadrant gate centred at 20, 20: one event
 * in each of the top-left, bottom-right and bottom-left quadrants and two in the top-right.
 */
function fixture() {
  const state = initialCoreState();
  const root = newRootPopulation();
  const gate = newQuadrantGate("CD4_CD8", "FSC-A", "SSC-A", [20, 20]);
  const quadrants = ["CD4_negative_CD8_positive", "CD4_positive_CD8_positive", "CD4_positive_CD8_negative", "CD4_negative_CD8_negative"]
    .map((name, index) => newPopulation(name, [newGateRef(gate.gate_id, true, index + 1)], root.population_id));
  root.children = quadrants.map((population) => population.population_id);
  Object.assign(state, {
    gates: { [gate.gate_id]: gate },
    gate_order: [gate.gate_id],
    populations: Object.fromEntries([root, ...quadrants].map((population) => [population.population_id, population])),
    root_population_id: root.population_id,
    active_population_id: root.population_id,
    active_hierarchy_id: DEFAULT_HIERARCHY_ID,
  });
  const fcs = (): FcsFile => ({
    version: "FCS3.1",
    nEvents: 5,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([10, 30, 30, 10, 30]), Float32Array.from([10, 10, 30, 30, 30])],
  });
  const trees = figureHierarchies(state);
  const member = (id: string): StrategyMember => {
    const source = prepareFigureSource({ id, name: `${id}.fcs`, sample: new Sample(fcs()), hierarchyId: DEFAULT_HIERARCHY_ID }, trees[DEFAULT_HIERARCHY_ID], state);
    return { id, name: source.name, sample: source.sample, tree: source.tree, gating: source.gating, populationId: quadrants[1].population_id };
  };
  return { state, trees, root, gate, quadrants, D1: member("D1"), D2: member("D2") };
}

const fontSizes = { tick: 10, axis_label: 12, gate_label: 10, title: 12 };
const look = { displayMode: "scatter", plotSize: 240, contourThreshold: 5, pointAlpha: 0.35, densityColorPower: 1.6, pointSize: 1.2, kdeBandwidth: 0, pubStyle: false, gateLineWidth: 1.5, fontSizes };

describe("a quadrant gate on the multi-population strategy", () => {
  it("is one gate on one panel, with each quadrant's count and share of the parent", () => {
    const { state, root, gate, quadrants, D1 } = fixture();
    const nodes = computeMultiPopStrategy(D1.sample, state.gates, state.populations, root.population_id, D1.gating.masks, quadrants.map((q) => q.population_id), { maxEvents: 0, globalScales: {} });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].gates).toHaveLength(1);
    expect(nodes[0].gates[0]).toMatchObject({
      gate_id: gate.gate_id, name: "CD4_CD8", gate_type: "quadrant", vertices: [], center: [20, 20],
      // Screen order: top-left, top-right, bottom-right, bottom-left.
      quadrant_events: [1, 2, 1, 1], quadrant_pcts: [20, 40, 20, 20], percent_of_parent: null,
    });
    // The counts go under a name the renderer does not print: a strategy panel labels a quadrant with its share alone.
    expect("quadrant_counts" in nodes[0].gates[0]).toBe(false);
    // The crosshair is inside the panel's ranges.
    expect(nodes[0].x_range[0]).toBeLessThanOrEqual(20);
    expect(nodes[0].x_range[1]).toBeGreaterThanOrEqual(20);
  });

  it("draws the same crosshair with all four shares when only one of its populations is traced", () => {
    const { state, root, quadrants, D1 } = fixture();
    const nodes = computeMultiPopStrategy(D1.sample, state.gates, state.populations, root.population_id, D1.gating.masks, [quadrants[2].population_id], { maxEvents: 0, globalScales: {} });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].gates[0]).toMatchObject({ gate_type: "quadrant", quadrant_events: [1, 2, 1, 1] });
  });

  it("sums each quadrant over the pooled files", () => {
    const { trees, quadrants, D1, D2 } = fixture();
    const pooled = computePooledMultiPopStrategy([D1, D2], quadrants.map((q) => q.population_id), DEFAULT_HIERARCHY_ID, trees, { maxEvents: 0, globalScales: {} });
    expect(pooled.omittedGates).toEqual([]);
    expect(pooled.nodes).toHaveLength(1);
    expect(pooled.nodes[0].n_events).toBe(10);
    expect(pooled.nodes[0].gates[0]).toMatchObject({ gate_type: "quadrant", center: [20, 20], quadrant_events: [2, 4, 2, 2], quadrant_pcts: [20, 40, 20, 20] });
  });
});

describe("a quadrant gate on the single-population strip", () => {
  it("carries the crosshair and the share of the one quadrant the population is", () => {
    const { state, root, gate, quadrants, D1 } = fixture();
    const steps = computeGatingStrategy(D1.sample, state.gates, state.populations, root.population_id, quadrants[1].population_id, { fullPath: true, maxEvents: 0 });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ gate_id: gate.gate_id, gate_type: "quadrant", n_before: 5, n_after: 2, pct_pass: 40 });
    expect(steps[0].quadrant?.index).toBe(2);
    const payload = buildStrategyPayload(D1.sample, steps, null, {}, { ...look, gateView: ["forward"], maxEvents: 0, nColumns: 4, fitToColumns: false }) as { steps: Record<string, unknown>[] };
    expect(payload.steps[0]).toMatchObject({
      gate_type: "quadrant", center: [20, 20], quadrant_pcts: [null, 40, null, null],
    });
  });
});

describe("the small plot draws it", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="strategy-grid-container"></div>';
    const noop = new Proxy({}, { get: (_target, key) => (key === "measureText" ? () => ({ width: 0 }) : () => undefined), set: () => true });
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => noop });
  });
  const labels = () => [...document.querySelectorAll(".mini-quadrant-gate .quadrant-label")].map((label) => label.textContent);

  it("as a crosshair with four labels on a multi-population panel", () => {
    const { state, root, quadrants, D1 } = fixture();
    const nodes = computeMultiPopStrategy(D1.sample, state.gates, state.populations, root.population_id, D1.gating.masks, quadrants.map((q) => q.population_id), { maxEvents: 0, globalScales: {} });
    loadMiniPlots().renderMultiStrategyGrid("strategy-grid-container", buildMultiStrategyPayload(nodes, look));
    expect(document.querySelectorAll(".mini-quadrant-gate")).toHaveLength(1);
    expect(document.querySelectorAll(".mini-quadrant-gate line")).toHaveLength(2);
    expect(labels()).toEqual(["20.0%", "40.0%", "20.0%", "20.0%"]);
  });

  it("as a crosshair with the population's own quadrant labelled on the strip", () => {
    const { state, root, quadrants, D1 } = fixture();
    const steps = computeGatingStrategy(D1.sample, state.gates, state.populations, root.population_id, quadrants[1].population_id, { fullPath: true, maxEvents: 0 });
    loadMiniPlots().renderStrategyGrid("strategy-grid-container", buildStrategyPayload(D1.sample, steps, null, {}, { ...look, gateView: ["forward"], maxEvents: 0, nColumns: 4, fitToColumns: false }));
    expect(document.querySelectorAll(".mini-quadrant-gate")).toHaveLength(1);
    expect(labels()).toEqual(["40.0%"]);
  });
});
