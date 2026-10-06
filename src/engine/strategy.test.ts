import { describe, expect, it } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import type { FcsFile } from "./fcs";
import { newGate, newPopulation, newRootPopulation } from "./models";
import { Sample } from "./sample";
import { initialCoreState } from "../store";
import { buildStrategyPayload, computeGatingStrategy, evenIndices, strategyStepMasks, thinEvenly } from "./strategy";

/** Three events on FSC-A × SSC-A, a Lymphocytes rectangle 0..15 × 0..35 holding the first. */
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
  const fcs: FcsFile = {
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
  };
  return { state, sample: new Sample(fcs), root, child, gate };
}

describe("thinning", () => {
  it("keeps every value under the cap and picks evenly over it, as R's round(seq(1, N, length.out = cap))", () => {
    expect(thinEvenly([1, 2, 3], 0)).toEqual([1, 2, 3]);
    expect(thinEvenly([1, 2, 3], Infinity)).toEqual([1, 2, 3]);
    expect(thinEvenly([1, 2, 3], 3)).toEqual([1, 2, 3]);
    expect(thinEvenly([1, 2, 3, 4, 5], 2)).toEqual([1, 5]);
    expect(thinEvenly([1, 2, 3, 4, 5], 3)).toEqual([1, 3, 5]);
    expect(thinEvenly([1, 2, 3, 4, 5], 1)).toEqual([1]);
    expect(evenIndices(Uint8Array.from([1, 0, 1, 1, 0]), 2)).toEqual([0, 3]);
    expect(evenIndices(Uint8Array.from([1, 0, 1, 1, 0]), 0)).toEqual([0, 2, 3]);
  });
});

describe("a single file's strategy", () => {
  it("traces the path with the parent events before each gate and the counts of every event", () => {
    const { state, sample, root, child, gate } = fixture();
    const masks = strategyStepMasks(sample, state.gates, state.populations, root.population_id, child.population_id, false);
    expect(masks).toHaveLength(1);
    expect(masks[0]).toMatchObject({ nBefore: 3, nAfter: 1, popName: "Lymphocytes" });
    expect([...masks[0].before]).toEqual([1, 1, 1]);

    const steps = computeGatingStrategy(sample, state.gates, state.populations, root.population_id, child.population_id, { fullPath: true, maxEvents: 0 });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      gate_id: gate.gate_id,
      gate_name: "Lymph_gate",
      x_channel: "FSC-A",
      y_channel: "SSC-A",
      n_before: 3,
      n_after: 1,
      n_total: 3,
      pct_pass: 33.3,
      pct_total: 33.3,
      include: true,
    });
    expect(steps[0].x).toEqual([...sample.displayColumn(0)]);
    expect(steps[0].y).toEqual([...sample.displayColumn(1)]);
    expect(steps[0].displayVertices).toHaveLength(4);

    // A cap thins the points drawn, never the counts.
    const thinned = computeGatingStrategy(sample, state.gates, state.populations, root.population_id, child.population_id, { fullPath: true, maxEvents: 2 });
    expect(thinned[0].x).toEqual([sample.displayColumn(0)[0], sample.displayColumn(0)[2]]);
    expect(thinned[0]).toMatchObject({ n_before: 3, n_after: 1 });
  });

  it("ends the path where the population runs out", () => {
    const { state, sample, root, child } = fixture();
    const empty = newGate("Empty", "rectangle", "FSC-A", "SSC-A", [[100, 100], [200, 200]]);
    const leaf = newPopulation("Leaf", [], child.population_id);
    leaf.gate_refs = [{ gate_id: empty.gate_id, include: true }];
    state.gates[empty.gate_id] = empty;
    state.populations[leaf.population_id] = leaf;
    child.children = [leaf.population_id];
    const deeper = newGate("Deeper", "rectangle", "FSC-A", "SSC-A", [[0, 0], [50, 50]]);
    const twig = newPopulation("Twig", [], leaf.population_id);
    twig.gate_refs = [{ gate_id: deeper.gate_id, include: true }];
    state.gates[deeper.gate_id] = deeper;
    state.populations[twig.population_id] = twig;
    leaf.children = [twig.population_id];
    const masks = strategyStepMasks(sample, state.gates, state.populations, root.population_id, twig.population_id, true);
    expect(masks.map((m) => [m.nBefore, m.nAfter])).toEqual([[3, 1], [1, 0], [0, 0]]);
    const steps = computeGatingStrategy(sample, state.gates, state.populations, root.population_id, twig.population_id, { fullPath: true, maxEvents: 0 });
    expect(steps.map((s) => s.gate_name)).toEqual(["Lymph_gate", "Empty"]);
  });

  it("builds the payload on the file's axes, with the back-gated events thinned to the cap", () => {
    const { state, sample, root, child } = fixture();
    const steps = computeGatingStrategy(sample, state.gates, state.populations, root.population_id, child.population_id, { fullPath: true, maxEvents: 0 });
    const options = {
      gateView: ["forward", "back"] as ("forward" | "back")[],
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
    const payload = buildStrategyPayload(sample, steps, Uint8Array.from([1, 0, 1]), {}, options) as { steps: Record<string, unknown>[] };
    expect(payload.steps).toHaveLength(1);
    expect(payload.steps[0]).toMatchObject({ gate_name: "Lymph_gate", n_before: 3, n_after: 1, pct_pass: 33.3 });
    expect(payload.steps[0].x_back).toEqual([sample.displayColumn(0)[0], sample.displayColumn(0)[2]]);
    const capped = buildStrategyPayload(sample, steps, Uint8Array.from([1, 1, 1]), {}, { ...options, maxEvents: 2 }) as { steps: Record<string, unknown>[] };
    expect(capped.steps[0].x_back).toEqual([sample.displayColumn(0)[0], sample.displayColumn(0)[2]]);
  });
});
