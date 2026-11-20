import { describe, expect, it } from "vitest";
import { fromScale, histogramCounts, histogramScale, scaleTicks, toScale } from "./controlHistogram";

describe("the histogram scale", () => {
  it("goes there and back", () => {
    for (const value of [-500, 0, 3, 150, 40_000]) expect(fromScale(toScale(value, 130), 130)).toBeCloseTo(value, 6);
  });

  it("covers the columns given, with a margin, and ignores a missing one", () => {
    const control = Float32Array.from({ length: 1000 }, (_, k) => (k < 500 ? k - 250 : 40_000 + k));
    const scale = histogramScale([control, null], 130)!;
    expect(fromScale(scale.lo, 130)).toBeLessThan(-250);
    expect(fromScale(scale.hi, 130)).toBeGreaterThan(41_000);
    // A second column widens it.
    const wider = histogramScale([control, Float32Array.from([-5000, -4000, -4500])], 130)!;
    expect(wider.lo).toBeLessThan(scale.lo);
    expect(histogramScale([Float32Array.from([7, 7, 7])], 130)).toBeNull();
    expect(histogramScale([null], 130)).toBeNull();
  });

  it("counts every finite event once, those outside the extent in the end bins", () => {
    const column = [0, 10, 100, 1000, 10_000, NaN, 1e9, -1e9];
    const scale = { cofactor: 100, lo: toScale(-50, 100), hi: toScale(20_000, 100) };
    const counts = histogramCounts(column, scale, 20);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(7);
    expect(counts[0]).toBeGreaterThanOrEqual(1);
    expect(counts[19]).toBeGreaterThanOrEqual(1);
    // Only the events asked for.
    expect(histogramCounts(column, scale, 20, [1, 2]).reduce((sum, count) => sum + count, 0)).toBe(2);
  });

  it("puts ticks at zero and at the decades outside the linear part, in order", () => {
    const scale = { cofactor: 130, lo: toScale(-300, 130), hi: toScale(200_000, 130) };
    const ticks = scaleTicks(scale);
    expect(ticks.map((tick) => tick.label)).toEqual(["0", "10³", "10⁴", "10⁵"]);
    expect(ticks.map((tick) => tick.value)).toEqual([0, 1000, 10_000, 100_000]);
    for (let k = 1; k < ticks.length; k++) expect(ticks[k].at).toBeGreaterThan(ticks[k - 1].at);
    // With negative values far below zero, negative decades too.
    const negative = scaleTicks({ cofactor: 130, lo: toScale(-5000, 130), hi: toScale(2000, 130) });
    expect(negative.map((tick) => tick.label)).toEqual(["-10³", "0", "10³"]);
  });
});
