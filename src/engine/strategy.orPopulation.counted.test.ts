// The strategy steps of a population that ORs its references: each reference is shown on the
// events the population started from, and the last step's count is the population's.
import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { linkChildToParent, newGateRef, newPopulation, newRootPopulation, type Gate, type PolyRectGate } from "./models";
import { applyGatingStrategy } from "./populations";
import { Sample } from "./sample";
import { strategyStepMasks } from "./strategy";

// Three events on FL1-A: 50 is in G1, 250 in G2, 500 in neither.
function fixture(logic: "and" | "or") {
  const fcs = {
    version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {}, spillover: null,
    channels: [{ index: 0, name: "FL1-A", marker: null, bits: 64, range: 262144 }, { index: 1, name: "FL2-A", marker: null, bits: 64, range: 262144 }],
    columns: [Float64Array.from([50, 250, 500]), Float64Array.from([1, 1, 1])],
  } as unknown as FcsFile;
  const sample = new Sample(fcs);
  const rect = (id: string, lo: number, hi: number): PolyRectGate => ({
    gate_id: id, name: id, gate_type: "rectangle", x_channel: "FL1-A", y_channel: "FL2-A",
    vertices: [[lo, -1e9], [hi, -1e9], [hi, 1e9], [lo, 1e9]], color: "#000000", label_offset: null, space: "raw", bounds: "half-open",
  } as PolyRectGate);
  const gates: Record<string, Gate> = { G1: rect("G1", 10, 100), G2: rect("G2", 200, 300), G3: rect("G3", 0, 400) };
  const root = newRootPopulation();
  let pops = { [root.population_id]: root };
  const parent = newPopulation("Cells", [newGateRef("G3", true)], root.population_id);
  pops[parent.population_id] = parent;
  pops = linkChildToParent(pops, parent.population_id, root.population_id);
  const pop = newPopulation("Either", [newGateRef("G1", true), newGateRef("G2", true)], parent.population_id, logic);
  pops[pop.population_id] = pop;
  pops = linkChildToParent(pops, pop.population_id, parent.population_id);
  const { masks } = applyGatingStrategy(gates, pops, root.population_id, sample.gateAssayData());
  const steps = strategyStepMasks(sample, gates, pops, root.population_id, pop.population_id, true);
  return { mask: Array.from(masks[pop.population_id]), steps: steps.map((s) => [s.gate.gate_id, Array.from(s.before), s.nBefore, s.nAfter]) };
}

describe("the strategy steps of an OR population", () => {
  it("end on the population's own count (2 of 3 events)", () => {
    const { mask, steps } = fixture("or");
    expect(mask).toEqual([1, 1, 0]);
    expect(steps).toEqual([
      ["G3", [1, 1, 1], 3, 2],
      ["G1", [1, 1, 0], 2, 1],
      ["G2", [1, 1, 0], 2, 2],
    ]);
  });

  it("leave an AND population's steps as they were", () => {
    const { mask, steps } = fixture("and");
    expect(mask).toEqual([0, 0, 0]);
    expect(steps).toEqual([
      ["G3", [1, 1, 1], 3, 2],
      ["G1", [1, 1, 0], 2, 1],
      ["G2", [1, 0, 0], 1, 0],
    ]);
  });
});
