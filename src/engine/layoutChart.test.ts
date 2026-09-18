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
    // wilcox.test(c(1.1, 2.2, 3.3, 4.4), c(5.5, 6.6, 7.7, 8.8)): W = 0, p = 0.02857 exact;
    // the normal approximation with continuity correction gives 0.0304.
    const w = wilcoxonRankSum([1.1, 2.2, 3.3, 4.4], [5.5, 6.6, 7.7, 8.8])!;
    expect(w.statistic).toBe(0);
    expect(w.p).toBeCloseTo(0.0304, 3);
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
});
