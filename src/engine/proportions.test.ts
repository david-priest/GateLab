import { describe, it, expect } from "vitest";
import { perUnitProps, computeStackedBars, computeBoxes, quantile, nestedBarLayout, type SampleComposition } from "./proportions";
import type { PopulationMap } from "./models";

const S: SampleComposition[] = [
  { unit: "u1", group: "stim", facet: null, catCounts: [3, 1] },
  { unit: "u2", group: "stim", facet: null, catCounts: [1, 3] },
  { unit: "u3", group: "ctrl", facet: null, catCounts: [2, 2] },
];

describe("quantile (type 7)", () => {
  it("matches R quantile()", () => {
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 10);
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
    expect(quantile([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25, 10);
    expect(quantile([5], 0.5)).toBe(5);
  });
});

describe("perUnitProps", () => {
  it("pools by unit within its group, normalises to sum 1", () => {
    const rows = perUnitProps(S, 2).sort((a, b) => a.unit < b.unit ? -1 : 1);
    expect(rows.map((r) => r.unit)).toEqual(["u1", "u2", "u3"]);
    expect(rows[0].props).toEqual([0.75, 0.25]);
    expect(rows[1].props).toEqual([0.25, 0.75]);
    expect(rows[2].props).toEqual([0.5, 0.5]);
    expect(rows[0].group).toBe("stim");
    rows.forEach((r) => expect(r.props.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10));
  });

  it("a unit with files in two groups is one row in each, never the two pooled", () => {
    const rows = perUnitProps([
      { unit: "u", group: "a", facet: null, catCounts: [1, 0] }, // 1 event
      { unit: "u", group: "b", facet: null, catCounts: [5, 5] }, // 10 events
      { unit: "u", group: "b", facet: "f2", catCounts: [0, 2] },
    ], 2);
    expect(rows.map((r) => [r.unit, r.group, r.facet, r.props, r.nEvents])).toEqual([
      ["u", "a", null, [1, 0], 1],
      ["u", "b", null, [0.5, 0.5], 10],
      ["u", "b", "f2", [0, 1], 2],
    ]);
  });
});

describe("a unit with no events in the parent", () => {
  it("is left out of the average and the boxes rather than counted as 0%", () => {
    const samples: SampleComposition[] = [
      { unit: "u1", group: "g", facet: null, catCounts: [50, 50] },
      { unit: "u2", group: "g", facet: null, catCounts: [0, 0] },
    ];
    expect(perUnitProps(samples, 2).map((row) => row.unit)).toEqual(["u1"]);
    const bar = computeStackedBars(samples, 2, { averagePerUnit: true, hasUnit: true, hasFacet: false })[0];
    expect(bar.segments.map((segment) => segment.value)).toEqual([0.5, 0.5]);
    expect(computeBoxes(perUnitProps(samples, 2), 2, false).map((box) => box.values)).toEqual([[0.5], [0.5]]);
  });
});

describe("computeStackedBars", () => {
  it("pooled: sums counts per group then normalises within the group", () => {
    const bars = computeStackedBars(S, 2, { averagePerUnit: false, hasUnit: true, hasFacet: false });
    const stim = bars.find((b) => b.group === "stim")!;
    const ctrl = bars.find((b) => b.group === "ctrl")!;
    expect(stim.segments.map((s) => s.value)).toEqual([0.5, 0.5]); // (3+1)/8, (1+3)/8
    expect(stim.total).toBe(8);
    expect(ctrl.segments.map((s) => s.value)).toEqual([0.5, 0.5]);
    expect(ctrl.total).toBe(4);
  });

  it("averagePerUnit: mean of per-unit fractions within each group", () => {
    const bars = computeStackedBars(S, 2, { averagePerUnit: true, hasUnit: true, hasFacet: false });
    const stim = bars.find((b) => b.group === "stim")!;
    expect(stim.segments.map((s) => s.value)).toEqual([0.5, 0.5]); // mean([.75,.25]), mean([.25,.75])
    expect(stim.total).toBe(1);
  });

  it("pooled-per-facet: normalises within each group×facet", () => {
    const withFacet: SampleComposition[] = [
      { unit: "u1", group: "stim", facet: "d0", catCounts: [4, 0] },
      { unit: "u2", group: "stim", facet: "d7", catCounts: [0, 4] },
    ];
    const bars = computeStackedBars(withFacet, 2, { averagePerUnit: false, hasUnit: true, hasFacet: true });
    expect(bars).toHaveLength(2);
    expect(bars.find((b) => b.facet === "d0")!.segments.map((s) => s.value)).toEqual([1, 0]);
    expect(bars.find((b) => b.facet === "d7")!.segments.map((s) => s.value)).toEqual([0, 1]);
  });
});

describe("box whiskers (Tukey)", () => {
  it("reach the furthest value within 1.5 × IQR of each quartile, the rest left as points", () => {
    // Values 1..8 and 30: q1 = 3, q3 = 7, IQR 4, so the upper fence is 13 and 30 lies beyond it.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 30];
    const units = values.map((v, i) => ({ unit: `D${i}`, group: "g", facet: null, props: [v / 100, 1 - v / 100], shares: [v / 100, 1 - v / 100], nEvents: 100 }));
    const box = computeBoxes(units, 2, false).find((b) => b.cat === 0)!;
    expect(box.stats.q1).toBeCloseTo(0.03, 12);
    expect(box.stats.q3).toBeCloseTo(0.07, 12);
    expect(box.stats.lo).toBeCloseTo(0.01, 12);
    expect(box.stats.hi).toBeCloseTo(0.08, 12);
    expect(box.stats.max).toBeCloseTo(0.3, 12);
    expect(box.values).toHaveLength(9);
  });
});

describe("computeBoxes", () => {
  it("collects per-unit fractions per (cat, group)", () => {
    const units = perUnitProps(S, 2);
    const boxes = computeBoxes(units, 2, false);
    const stimCat0 = boxes.find((b) => b.cat === 0 && b.group === "stim")!;
    expect(stimCat0.values.sort()).toEqual([0.25, 0.75]);
    expect(stimCat0.stats.med).toBeCloseTo(0.5, 10);
    const ctrlCat0 = boxes.find((b) => b.cat === 0 && b.group === "ctrl")!;
    expect(ctrlCat0.values).toEqual([0.5]);
  });

  it("names the unit of each value, in the same order", () => {
    const boxes = computeBoxes(perUnitProps(S, 2), 2, false);
    const stimCat0 = boxes.find((b) => b.cat === 0 && b.group === "stim")!;
    expect(stimCat0.units.map((unit, i) => [unit, stimCat0.values[i]])).toEqual([["u1", 0.75], ["u2", 0.25]]);
  });
});

describe("nestedBarLayout — daughters nested inside parents", () => {
  // Tree: root → A → B (leaf); root → C (leaf). Selected: A, B, C.
  const pops = {
    root: { population_id: "root", parent_id: null },
    A: { population_id: "A", parent_id: "root" },
    B: { population_id: "B", parent_id: "A" },
    C: { population_id: "C", parent_id: "root" },
  } as unknown as PopulationMap;
  const levels = [ { popId: "A", depth: 1 }, { popId: "B", depth: 2 }, { popId: "C", depth: 1 } ];
  // deepest-wins OWN fractions: A=0.2 (in A but not B), B=0.3, C=0.5  → sum 1.0
  const segments = [ { cat: 0, value: 0.2 }, { cat: 1, value: 0.3 }, { cat: 2, value: 0.5 } ];

  it("stacks each child within its parent's subtree extent", () => {
    const nodes = nestedBarLayout(levels, segments, pops);
    const byPop = Object.fromEntries(nodes.map((n) => [n.popId, n]));
    // A's subtree = own 0.2 + B 0.3 = 0.5 → [0, 0.5]; C → [0.5, 1.0]
    expect(byPop.A.y0).toBeCloseTo(0, 9);
    expect(byPop.A.y1).toBeCloseTo(0.5, 9);
    expect(byPop.C.y0).toBeCloseTo(0.5, 9);
    expect(byPop.C.y1).toBeCloseTo(1.0, 9);
    // B nests INSIDE A, above A's own slice (0.2): [0.2, 0.5], one level deeper
    expect(byPop.B.y0).toBeCloseTo(0.2, 9);
    expect(byPop.B.y1).toBeCloseTo(0.5, 9);
    expect(byPop.B.depth).toBe(byPop.A.depth + 1);
    // shallow-first ordering (parents before children) so the chart paints parents first
    expect(nodes[nodes.length - 1].popId).toBe("B");
  });
});
