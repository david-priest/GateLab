// The pairwise and paired rank tests on a population counted through a drawn gate: each file's
// share as the gate list counts it, compared between three conditions pair by pair and between
// conditions within donors. Synthetic files, donors D1 to D5 in control, low and high; nothing
// here is a real experiment. The expected p values are exact fractions of R's null distributions.

import { describe, expect, it } from "vitest";
import { newGate, newGateRef, newPopulation, newRootPopulation, type Population } from "./models";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { pairwiseWilcoxon, wilcoxonSignedRank } from "./rankTests";

// Gate A holds FSC below 55, in raw units.
function tree() {
  const state = initialCoreState();
  const root = newRootPopulation();
  const gate = newGate("A", "rectangle", "FSC-A", "SSC-A", [[0, 0], [55, 1000]]);
  const a = newPopulation("A", [newGateRef(gate.gate_id)], root.population_id);
  root.children = [a.population_id];
  const populations: Record<string, Population> = { [root.population_id]: root, [a.population_id]: a };
  Object.assign(state, {
    gates: { [gate.gate_id]: gate },
    gate_order: [gate.gate_id],
    populations,
    root_population_id: root.population_id,
    active_population_id: root.population_id,
  });
  return { state: state as CoreState, a: a.population_id };
}

// Twenty events a file, `inside` of them in A (FSC 10 to 44) and the rest outside it (FSC 60 to 98).
function file(inside: number): Sample {
  const fsc = Array.from({ length: 20 }, (_, i) => (i < inside ? 10 + 2 * i : 60 + 2 * (i - inside)));
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: fsc.length,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from(fsc), Float32Array.from(fsc.map(() => 10))],
  };
  return new Sample(fcs);
}

// Events in A per donor and condition.
const DONORS = [
  { id: "D1", control: 18, low: 9, high: 4 },
  { id: "D2", control: 17, low: 14, high: 6 },
  { id: "D3", control: 16, low: 12, high: 5 },
  { id: "D4", control: 15, low: 10, high: 8 },
  { id: "D5", control: 11, low: 13, high: 7 },
];
const CONDITIONS = ["control", "low", "high"] as const;

function counted(): Record<(typeof CONDITIONS)[number], number[]> {
  const { state, a } = tree();
  const share = (inside: number) => {
    const count = recompute(file(inside), state).populations[a].event_count ?? 0;
    expect(count).toBe(inside);
    return (count * 100) / 20;
  };
  return {
    control: DONORS.map((d) => share(d.control)),
    low: DONORS.map((d) => share(d.low)),
    high: DONORS.map((d) => share(d.high)),
  };
}

describe("Pairwise and paired rank tests on a drawn gate", () => {
  it("compares every pair of conditions with Holm-adjusted exact p", () => {
    const shares = counted();
    expect(shares.control).toEqual([90, 85, 80, 75, 55]);
    expect(shares.low).toEqual([45, 70, 60, 50, 65]);
    expect(shares.high).toEqual([20, 30, 25, 40, 35]);
    const pairs = pairwiseWilcoxon(CONDITIONS.map((c) => shares[c]));
    // control against low: U = 22 of 25, P(U >= 22) = 7 / 252, p = 14 / 252. The other two pairs
    // are separated: p = 2 / 252. Holm: 3 * 2 / 252 for both separated pairs, 14 / 252 unchanged.
    expect(pairs.map((c) => [c.a, c.b, c.statistic])).toEqual([[0, 1, 22], [0, 2, 25], [1, 2, 25]]);
    expect(pairs[0].p).toBeCloseTo(14 / 252, 12);
    expect(pairs[1].p).toBeCloseTo(2 / 252, 12);
    expect(pairs[2].p).toBeCloseTo(2 / 252, 12);
    expect(pairs[0].pAdjusted).toBeCloseTo(14 / 252, 12);
    expect(pairs[1].pAdjusted).toBeCloseTo(6 / 252, 12);
    expect(pairs[2].pAdjusted).toBeCloseTo(6 / 252, 12);
  });

  it("compares conditions within donors with the exact signed-rank p", () => {
    const shares = counted();
    // control − low: 45, 15, 20, 25, −10; ranks 5, 2, 3, 4 positive and 1 negative, V = 14,
    // P(V >= 14) = P(V <= 1) = 2 / 32, p = 4 / 32.
    const controlLow = wilcoxonSignedRank(shares.control, shares.low)!;
    expect(controlLow.statistic).toBe(14);
    expect(controlLow.n).toBe(5);
    expect(controlLow.p).toBeCloseTo(4 / 32, 12);
    expect(controlLow.label).toBe("Wilcoxon signed-rank p = 0.13");
    // low − high: 25, 40, 35, 10, 30, all positive, V = 15, p = 2 / 32.
    const lowHigh = wilcoxonSignedRank(shares.low, shares.high)!;
    expect(lowHigh.statistic).toBe(15);
    expect(lowHigh.p).toBeCloseTo(2 / 32, 12);
  });
});
