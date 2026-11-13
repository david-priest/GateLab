// The rank test of a Layout chart block on a population counted through a drawn gate: each file's
// share as the gate list counts it, compared between conditions with R's exact Wilcoxon p.
// Synthetic files D1 to D6, three control and three treated; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { newGate, newGateRef, newPopulation, newRootPopulation, type Population } from "./models";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { groupPoints, testGroups, type ChartPoint } from "./layoutChart";

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

// Twenty events a file, `inside` of them in A (FSC 10 to 50) and the rest outside it (FSC 60 to 99).
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

const FILES = [
  { id: "D1", condition: "control", inside: 10 },
  { id: "D2", condition: "control", inside: 8 },
  { id: "D3", condition: "control", inside: 9 },
  { id: "D4", condition: "treated", inside: 6 },
  { id: "D5", condition: "treated", inside: 4 },
  { id: "D6", condition: "treated", inside: 5 },
];

describe("A Layout chart's rank test on a drawn gate", () => {
  it("compares the files' shares as the gate list counts them, with R's exact p", () => {
    const { state, a } = tree();
    const points: ChartPoint[] = FILES.map(({ id, condition, inside }) => {
      const count = recompute(file(inside), state).populations[a].event_count ?? 0;
      expect(count).toBe(inside);
      return { sampleId: id, name: `${id}.fcs`, group: condition, value: (count / 20) * 100 };
    });
    expect(points.map((p) => p.value)).toEqual([50, 40, 45, 30, 20, 25]);
    const test = testGroups(groupPoints(points))!;
    // wilcox.test(c(50, 40, 45), c(30, 20, 25)): W = 9, p = 0.1 (exact); the normal approximation
    // with continuity correction, used before, gave 0.081.
    expect(test.name).toBe("Wilcoxon rank-sum");
    expect(test.statistic).toBe(9);
    expect(test.p).toBeCloseTo(0.1, 12);
    expect(test.label).toBe("Wilcoxon p = 0.10");
  });

  it("gives the same exact p when the first group is the higher one and far apart", () => {
    // Twenty files a condition: control's shares (55% to 100%) all above treated's (0% to 45%).
    // wilcox.test(control, treated): W = 400, p = 2 / choose(40, 20) = 1.45038e-11 (exact).
    const { state, a } = tree();
    const share = (inside: number) => {
      const count = recompute(file(inside), state).populations[a].event_count ?? 0;
      expect(count).toBe(inside);
      return (count / 20) * 100;
    };
    const points: ChartPoint[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ sampleId: `D${i + 1}`, name: `D${i + 1}.fcs`, group: "control", value: share(11 + (i % 10)) + (i < 10 ? 0 : 0.5) })),
      ...Array.from({ length: 20 }, (_, i) => ({ sampleId: `D${i + 21}`, name: `D${i + 21}.fcs`, group: "treated", value: share(i % 10) + (i < 10 ? 0 : 0.5) })),
    ];
    const higherFirst = testGroups(groupPoints(points))!;
    const lowerFirst = testGroups(groupPoints([...points.slice(20), ...points.slice(0, 20)]))!;
    expect(higherFirst.statistic).toBe(400);
    expect(lowerFirst.statistic).toBe(0);
    const expected = 2 / 137846528820;
    expect(Math.abs(higherFirst.p - expected) / expected).toBeLessThan(1e-9);
    expect(Math.abs(lowerFirst.p - expected) / expected).toBeLessThan(1e-9);
    expect(higherFirst.label).toBe("Wilcoxon p < 0.001");
  });
});
