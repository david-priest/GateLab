import { describe, expect, it } from "vitest";
import { axisTicks, chiSquareUpperTail, formatP, groupPoints, kruskalWallis, normalUpperTail, quantile, testGroups, wilcoxonRankSum, type ChartPoint } from "./layoutChart";

const point = (name: string, group: string, value: number): ChartPoint => ({ sampleId: name, name, group, value });

describe("layout chart statistics", () => {
  it("summarises groups in order of first appearance with R's quantiles", () => {
    const groups = groupPoints([point("a", "treated", 10), point("b", "control", 4), point("c", "treated", 20), point("d", "control", 6), point("e", "treated", 30)]);
    expect(groups.map((g) => [g.label, g.n, g.mean, g.median])).toEqual([["treated", 3, 20, 20], ["control", 2, 5, 5]]);
    expect(groups[0].sd).toBe(10);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75); // type 7
  });

  it("matches R for the rank-sum and Kruskal–Wallis tests", () => {
    // wilcox.test(c(1.1, 2.2, 3.3, 4.4), c(5.5, 6.6, 7.7, 8.8)): W = 0, p = 0.02857 exact (no ties,
    // fewer than 50 a side); the normal approximation would give 0.0304.
    const w = wilcoxonRankSum([1.1, 2.2, 3.3, 4.4], [5.5, 6.6, 7.7, 8.8])!;
    expect(w.statistic).toBe(0);
    expect(w.p).toBeCloseTo(0.0285714285714286, 12);
    expect(w.label).toBe("Wilcoxon p = 0.03");
    // Ties: wilcox.test(c(1, 2, 2, 3), c(2, 3, 3, 4), correct = TRUE) → W = 3, p = 0.172 by the corrected normal approximation.
    const tied = wilcoxonRankSum([1, 2, 2, 3], [2, 3, 3, 4])!;
    expect(tied.statistic).toBe(3);
    expect(tied.p).toBeCloseTo(0.172, 2);
    // kruskal.test(list(c(1, 2, 3), c(4, 5, 6), c(7, 8, 9))): H = 7.2, df = 2, p = 0.02732.
    const k = kruskalWallis([[1, 2, 3], [4, 5, 6], [7, 8, 9]])!;
    expect(k.statistic).toBeCloseTo(7.2, 6);
    expect(k.p).toBeCloseTo(0.02732, 4);
    expect(wilcoxonRankSum([1], [2, 3])).toBeNull();
    expect(kruskalWallis([[1, 2], [3]])).toBeNull();
  });

  it("gives R's exact p without ties below 50 a side, and the corrected normal approximation otherwise", () => {
    // R 4.4 wilcox.test(x, y) with its defaults; W and p as R prints them.
    const cases: { x: number[]; y: number[]; w: number; p: number }[] = [
      { x: [1, 3], y: [2, 4], w: 1, p: 0.666666666666667 },
      { x: [5, 7, 9, 11, 13], y: [1, 2, 4, 6], w: 19, p: 0.0317460317460317 },
      {
        x: Array.from({ length: 20 }, (_, i) => (((i + 1) * 37) % 101) + 0.5),
        y: Array.from({ length: 25 }, (_, i) => (((i + 1) * 53) % 103) + 0.25),
        w: 274,
        p: 0.59488068491644,
      },
      { x: Array.from({ length: 49 }, (_, i) => i + 1), y: Array.from({ length: 49 }, (_, i) => i + 50), w: 0, p: 7.85002919296329e-29 },
      // Ties, then 50 values on one side: the normal approximation with continuity correction.
      { x: [1, 2, 2, 3], y: [2, 3, 3, 4], w: 3, p: 0.172033708921823 },
      {
        x: Array.from({ length: 50 }, (_, i) => (((i + 1) * 37) % 101) + 0.5),
        y: Array.from({ length: 10 }, (_, i) => (((i + 1) * 53) % 103) + 0.25),
        w: 337,
        p: 0.0862057812595168,
      },
    ];
    // The exact cases to 1e-9 of R's p; the approximate ones to the 1.5e-7 of the erfc used.
    cases.forEach(({ x, y, w, p }, index) => {
      const test = wilcoxonRankSum(x, y)!;
      expect(test.statistic).toBe(w);
      if (index < 4) expect(Math.abs(test.p - p) / p).toBeLessThan(1e-9);
      else expect(Math.abs(test.p - p)).toBeLessThan(1e-6);
    });
  });

  it("gives the same exact p whichever group is the higher one", () => {
    // Fully separated, 49 a side: p = 2 / choose(98, 49) in either order (R: 7.85002919296329e-29).
    const low = Array.from({ length: 49 }, (_, i) => i + 1);
    const high = Array.from({ length: 49 }, (_, i) => i + 50);
    const lowFirst = wilcoxonRankSum(low, high)!;
    const highFirst = wilcoxonRankSum(high, low)!;
    expect(lowFirst.statistic).toBe(0);
    expect(highFirst.statistic).toBe(49 * 49);
    expect(Math.abs(highFirst.p - 7.85002919296329e-29) / 7.85002919296329e-29).toBeLessThan(1e-9);
    expect(Math.abs(highFirst.p - lowFirst.p) / lowFirst.p).toBeLessThan(1e-12);
    // wilcox.test(c(5, 7, 9, 11, 13), c(1, 2, 4, 6)) and the reverse: W = 19 and 1, p = 0.0317460317460317.
    expect(wilcoxonRankSum([1, 2, 4, 6], [5, 7, 9, 11, 13])!.p).toBeCloseTo(0.0317460317460317, 14);
  });

  it("chooses the test by the number of groups and formats p", () => {
    const two = groupPoints([point("a", "x", 1), point("b", "x", 2), point("c", "y", 5), point("d", "y", 6)]);
    expect(testGroups(two)?.name).toBe("Wilcoxon rank-sum");
    const three = groupPoints([point("a", "x", 1), point("b", "x", 2), point("c", "y", 5), point("d", "y", 6), point("e", "z", 9), point("f", "z", 10)]);
    expect(testGroups(three)?.name).toBe("Kruskal–Wallis");
    expect(testGroups(groupPoints([point("a", "", 1)]))).toBeNull();
    expect(formatP(0.0004)).toBe("p < 0.001");
    expect(formatP(0.0042)).toBe("p = 0.004");
    expect(formatP(0.3)).toBe("p = 0.30");
  });

  it("has the tail functions right", () => {
    expect(normalUpperTail(1.96)).toBeCloseTo(0.025, 3);
    expect(normalUpperTail(-1.96)).toBeCloseTo(0.975, 3);
    expect(chiSquareUpperTail(3.841, 1)).toBeCloseTo(0.05, 3);
    expect(chiSquareUpperTail(9.21, 2)).toBeCloseTo(0.01, 3);
  });

  it("lays out round axis ticks from zero", () => {
    expect(axisTicks([12, 47, 88])).toEqual({ min: 0, max: 100, ticks: [0, 20, 40, 60, 80, 100] });
    expect(axisTicks([0.2, 0.9]).max).toBeGreaterThan(0.9);
    expect(axisTicks([-3, 5]).min).toBeLessThanOrEqual(-3);
  });

  it("gives a usable scale when every value is the same", () => {
    expect(axisTicks([0, 0, 0])).toEqual({ min: 0, max: 1, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] });
    expect(axisTicks([])).toEqual(axisTicks([0]));
    const positive = axisTicks([7, 7]);
    expect(positive.min).toBe(0);
    expect(positive.max).toBeGreaterThan(7);
    const negative = axisTicks([-7, -7]);
    expect(negative.min).toBeLessThanOrEqual(-7);
    expect(negative.max).toBeGreaterThanOrEqual(0);
    for (const scale of [positive, negative]) {
      expect(scale.ticks.length).toBeGreaterThanOrEqual(3);
      expect(scale.ticks.length).toBeLessThanOrEqual(8);
    }
  });
});
