// Reference values are from R 4.x's wilcox.test (paired = TRUE), pairwise.wilcox.test
// (p.adjust.method = "holm") and p.adjust(p, "holm"), two-sided, taken 2026-11-10.

import { describe, expect, it } from "vitest";
import { holmAdjust, pairwiseWilcoxon, wilcoxonSignedRank } from "./rankTests";

const relative = (actual: number, expected: number) => Math.abs(actual - expected) / Math.abs(expected);

describe("holmAdjust", () => {
  it("matches p.adjust(p, \"holm\")", () => {
    const adjusted = holmAdjust([0.01, 0.04, 0.03, 0.2]);
    [0.04, 0.09, 0.09, 0.2].forEach((e, i) => expect(adjusted[i]).toBeCloseTo(e, 12));
  });

  it("keeps nulls and leaves them out of n", () => {
    const adjusted = holmAdjust([0.01, null, 0.03]);
    expect(adjusted[0]).toBeCloseTo(0.02, 12);
    expect(adjusted[1]).toBeNull();
    expect(adjusted[2]).toBeCloseTo(0.03, 12);
  });
});

describe("pairwiseWilcoxon", () => {
  it("tests every pair exactly and Holm-adjusts across them", () => {
    const control = [1.1, 2.3, 1.9, 2.8, 1.5];
    const low = [3.2, 2.9, 4.1, 3.7, 2.6, 3.9];
    const high = [5.2, 6.1, 4.8, 5.9, 6.6];
    const pairs = pairwiseWilcoxon([control, low, high]);
    expect(pairs.map((c) => [c.a, c.b])).toEqual([[0, 1], [0, 2], [1, 2]]);
    const p = [0.00865800865800866, 0.00793650793650794, 0.00432900432900433];
    const holm = [0.0158730158730159, 0.0158730158730159, 0.012987012987013];
    pairs.forEach((c, i) => {
      expect(relative(c.p!, p[i])).toBeLessThan(1e-9);
      expect(relative(c.pAdjusted!, holm[i])).toBeLessThan(1e-9);
    });
  });

  it("uses the normal approximation for tied values", () => {
    const pairs = pairwiseWilcoxon([
      [1, 2, 2, 3, 1],
      [3, 3, 4, 4, 2, 4],
      [5, 6, 4, 6, 6],
    ]);
    for (const c of pairs) expect(Math.abs(c.pAdjusted! - 0.0319868241435441)).toBeLessThan(1e-6);
  });

  it("matches four groups of three", () => {
    const pairs = pairwiseWilcoxon([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [2.5, 5.5, 8.5],
    ]);
    const holm = [0.6, 0.6, 0.6, 0.6, 1.0, 0.8];
    pairs.forEach((c, i) => expect(relative(c.pAdjusted!, holm[i])).toBeLessThan(1e-9));
  });

  it("leaves a pair with fewer than two values on a side untested and out of the adjustment", () => {
    const pairs = pairwiseWilcoxon([[1, 2, 3], [4, 5, 6], [7]]);
    expect(pairs[0].p).toBeCloseTo(0.1, 12);
    expect(pairs[0].pAdjusted).toBeCloseTo(0.1, 12);
    expect(pairs[1]).toEqual({ a: 0, b: 2, statistic: null, p: null, pAdjusted: null });
    expect(pairs[2]).toEqual({ a: 1, b: 2, statistic: null, p: null, pAdjusted: null });
  });

  it("returns every pair untested when none can be tested", () => {
    const pairs = pairwiseWilcoxon([[1], [2], []]);
    expect(pairs).toHaveLength(3);
    for (const c of pairs) expect(c).toMatchObject({ statistic: null, p: null, pAdjusted: null });
  });
});

describe("wilcoxonSignedRank", () => {
  it("is exact without ties or zeroes", () => {
    const test = wilcoxonSignedRank(
      [1.83, 0.5, 1.62, 2.48, 1.68, 1.88, 1.55, 3.06, 1.3],
      [0.878, 0.647, 0.598, 2.05, 1.06, 1.29, 1.06, 3.14, 1.29],
    )!;
    expect(test.name).toBe("Wilcoxon signed-rank");
    expect(test.statistic).toBe(40);
    expect(test.n).toBe(9);
    expect(relative(test.p, 0.0390625)).toBeLessThan(1e-9);
    expect(test.label).toBe("Wilcoxon signed-rank p = 0.04");
  });

  it("gives the same p for either direction", () => {
    const a = [10, 12, 14, 16, 18, 20];
    const b = [1, 2, 3, 4, 5, 6.5];
    const forward = wilcoxonSignedRank(a, b)!;
    expect(forward.statistic).toBe(21);
    expect(relative(forward.p, 0.03125)).toBeLessThan(1e-9);
    const back = wilcoxonSignedRank(b, a)!;
    expect(back.statistic).toBe(0);
    expect(relative(back.p, 0.03125)).toBeLessThan(1e-9);
  });

  it("drops a zero difference and uses the corrected normal approximation for ties", () => {
    const test = wilcoxonSignedRank([5, 7, 9, 11, 13, 15, 17], [4, 5, 9, 8, 15, 12, 13])!;
    expect(test.statistic).toBe(18.5);
    expect(test.n).toBe(6);
    expect(Math.abs(test.p - 0.113846298006658)).toBeLessThan(1e-6);
  });

  it("matches three pairs", () => {
    const test = wilcoxonSignedRank([3.1, 4.7, 2.2], [2.0, 4.1, 2.9])!;
    expect(test.statistic).toBe(4);
    expect(relative(test.p, 0.75)).toBeLessThan(1e-9);
  });

  it("uses the normal approximation from 50 differences on", () => {
    const a = [8.747, 10.367, 8.329, 13.191, 10.659, 8.359, 10.975, 11.477, 11.152, 9.389, 13.024, 10.78, 8.758, 5.571, 12.25, 9.91, 9.968, 11.888, 11.642, 11.188, 11.838, 11.564, 10.149, 6.021, 11.24, 9.888, 9.688, 7.058, 9.044, 10.836, 12.717, 9.794, 10.775, 9.892, 7.246, 9.17, 9.211, 9.881, 12.2, 11.526, 9.671, 9.493, 11.394, 11.113, 8.622, 8.585, 10.729, 11.537, 9.775, 11.762, 10.796, 8.776, 10.682, 7.741, 12.866, 13.961, 9.266, 7.912, 11.139, 9.73];
    const b = [4.545, 9.826, 6.694, 12.549, 11.174, 7.476, 13.082, 8.679, 10.322, 5.53, 11.711, 11.245, 7.242, 6.372, 13.53, 8.873, 10.033, 11.286, 10.93, 11.472, 12.091, 11.167, 7.782, 7.706, 9.749, 8.789, 7.493, 6.914, 7.889, 9.835, 12.931, 7.382, 8.434, 8.242, 4.266, 7.732, 10.526, 10.141, 13.437, 11.636, 10.002, 8.83, 12.16, 10.276, 9.004, 5.334, 9.054, 9.572, 8.599, 8.639, 11.15, 8.868, 7.934, 8.117, 12.577, 13.95, 9.146, 7.731, 9.798, 9.396];
    const test = wilcoxonSignedRank(a, b)!;
    expect(test.n).toBe(60);
    expect(test.statistic).toBe(1422);
    expect(Math.abs(test.p - 0.000192506840408991)).toBeLessThan(1e-6);
    expect(test.label).toBe("Wilcoxon signed-rank p < 0.001");
  });

  it("counts a far tail instead of rounding it to 0", () => {
    const a = Array.from({ length: 49 }, (_, i) => i + 1);
    const zeros = a.map(() => 0);
    const below = wilcoxonSignedRank(zeros, a)!;
    expect(below.statistic).toBe(0);
    expect(below.p).toBe(2 / 2 ** 49);
    const above = wilcoxonSignedRank(a, zeros)!;
    expect(above.statistic).toBe((49 * 50) / 2);
    expect(above.p).toBe(2 / 2 ** 49);
  });

  it("declines unequal lengths and fewer than two non-zero differences", () => {
    expect(wilcoxonSignedRank([1, 2, 3], [1, 2])).toBeNull();
    expect(wilcoxonSignedRank([1, 2, 3], [1, 2, 0])).toBeNull();
    expect(wilcoxonSignedRank([], [])).toBeNull();
  });
});
