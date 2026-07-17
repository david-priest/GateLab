import { describe, expect, it } from "vitest";
import { robustAxisRange } from "./axisRange";

describe("robustAxisRange", () => {
  it("uses a safe fallback for an empty or non-finite column", () => {
    expect(robustAxisRange([])).toEqual([0, 1]);
    expect(robustAxisRange([NaN, Infinity, -Infinity])).toEqual([0, 1]);
  });

  it("gives a constant channel a small non-zero display span", () => {
    const [lo, hi] = robustAxisRange([4, 4, 4]);
    expect(lo).toBeCloseTo(3.95, 12);
    expect(hi).toBeCloseTo(4.05, 12);
  });

  it("frames the central 99.8% instead of allowing isolated tails to set the view", () => {
    const values = new Float32Array(10_002);
    values[0] = -1_000_000;
    for (let i = 0; i < 10_000; i++) values[i + 1] = i;
    values[10_001] = 1_000_000;

    const [lo, hi] = robustAxisRange(values);
    expect(lo).toBeGreaterThan(-1_000);
    expect(hi).toBeLessThan(11_000);
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(9_999);
  });

  it("keeps large-file quantiles deterministic without sorting every event", () => {
    const values = new Float32Array(250_000);
    for (let i = 0; i < values.length; i++) values[i] = i % 1_000;
    values[0] = -1_000_000;
    values[values.length - 1] = 1_000_000;

    expect(robustAxisRange(values)).toEqual(robustAxisRange(values));
    const [lo, hi] = robustAxisRange(values);
    expect(lo).toBeGreaterThan(-100);
    expect(hi).toBeLessThan(1_100);
  });
});
