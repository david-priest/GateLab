// computeGateMasks gives a quadrant gate's four masks in order Q1 to Q4, and applyGatingStrategy
// recomputes a mask that a supplied cache lacks or holds at another length.
import { describe, expect, it } from "vitest";
import type { AssayData } from "./gates";
import { newGate, newGateRef, newPopulation, newQuadrantGate, newRootPopulation, type PopulationMap } from "./models";
import { applyGatingStrategy, computeGateCounts, computeGateMasks, gateMaskKey } from "./populations";

// One event in each quadrant around (0, 0): Q1 x-/y+, Q2 x+/y+, Q3 x+/y-, Q4 x-/y-.
const data: AssayData = (() => {
  const cols: Record<string, Float32Array> = {
    "FL1-A": Float32Array.from([-1, 1, 1, -1]),
    "FL2-A": Float32Array.from([1, 1, -1, -1]),
  };
  return { n: 4, column: (c) => cols[c] };
})();

describe("computeGateMasks", () => {
  it("gives a quadrant gate's four masks in quadrant order Q1 to Q4", () => {
    const q = newQuadrantGate("Q", "FL1-A", "FL2-A", [0, 0]);
    const masks = computeGateMasks({ [q.gate_id]: q }, data);
    expect([1, 2, 3, 4].map((k) => Array.from(masks[gateMaskKey(q.gate_id, k)]))).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ]);
  });
});

describe("applyGatingStrategy with a supplied mask cache", () => {
  const build = () => {
    const g = newGate("R", "rectangle", "FL1-A", "FL2-A", [[0, 0], [2, 0], [2, 2], [0, 2]]);
    const root = newRootPopulation();
    const child = newPopulation("CD4_positive", [newGateRef(g.gate_id)], root.population_id);
    root.children.push(child.population_id);
    const pops: PopulationMap = { [root.population_id]: root, [child.population_id]: child };
    return { g, root, child, pops };
  };

  it("computes a gate's mask the cache does not hold", () => {
    const { g, root, child, pops } = build();
    const r = applyGatingStrategy({ [g.gate_id]: g }, pops, root.population_id, data, {});
    expect(Array.from(r.masks[child.population_id])).toEqual([0, 1, 0, 0]);
  });

  it("recomputes a cached mask whose length is not the data's", () => {
    const { g, root, child, pops } = build();
    const stale = { [gateMaskKey(g.gate_id)]: Uint8Array.from([1, 1, 1, 1, 1]) };
    const r = applyGatingStrategy({ [g.gate_id]: g }, pops, root.population_id, data, stale);
    expect(Array.from(r.masks[child.population_id])).toEqual([0, 1, 0, 0]);
    expect(r.populations[child.population_id].event_count).toBe(1);
  });
});

describe("percentages and counts at the edges", () => {
  const cols = (x: number[], y: number[]): AssayData => {
    const c: Record<string, Float32Array> = { "FL1-A": Float32Array.from(x), "FL2-A": Float32Array.from(y) };
    return { n: x.length, column: (k) => c[k] };
  };
  const rect = () => newGate("R", "rectangle", "FL1-A", "FL2-A", [[0, 0], [2, 0], [2, 2], [0, 2]]);
  const quad = () => newQuadrantGate("Q", "FL1-A", "FL2-A", [0, 0]);

  it("gives 0% of an empty parent, and 100% for the one event of a one-event parent", () => {
    for (const [d, pct] of [[cols([], []), 0], [cols([1], [1]), 100]] as const) {
      const g = rect();
      const root = newRootPopulation();
      const child = newPopulation("D1", [newGateRef(g.gate_id)], root.population_id);
      root.children.push(child.population_id);
      const r = applyGatingStrategy({ [g.gate_id]: g }, { [root.population_id]: root, [child.population_id]: child }, root.population_id, d);
      expect(r.populations[child.population_id].percent_of_parent).toBe(pct);
      const counts = computeGateCounts({ [g.gate_id]: g }, null, d);
      expect(counts[g.gate_id].percent_of_parent).toBe(pct);
      const q = quad();
      expect(computeGateCounts({ [q.gate_id]: q }, null, d)[q.gate_id].quadrants![1].percent_of_parent).toBe(pct);
    }
  });

  it("counts a gate's events within the population mask only", () => {
    const g = rect();
    const d = cols([1, 1, 5], [1, 1, 5]);
    const counts = computeGateCounts({ [g.gate_id]: g }, Uint8Array.from([1, 0, 1]), d);
    expect(counts[g.gate_id]).toEqual({ event_count: 1, percent_of_parent: 50 });
  });
});
