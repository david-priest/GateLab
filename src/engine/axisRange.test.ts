import { describe, expect, it } from "vitest";
import { includePlotGatesInAxisRange, robustAxisRange } from "./axisRange";

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

describe("includePlotGatesInAxisRange", () => {
  it("reaches a spider quadrant's arm ends, where its handles are", () => {
    const spider = {
      gate_type: "quadrant", center: [5, 5],
      arms: { spider: true, h: [[5, 5], [14, 6]], v: [[5, 5], [4, 12]], l: [[5, 5], [-3, 5]], d: [[5, 5], [6, -2]] },
    };
    const [xlo, xhi] = includePlotGatesInAxisRange([0, 10], [spider], "x");
    const [ylo, yhi] = includePlotGatesInAxisRange([0, 10], [spider], "y");
    expect(xlo).toBeLessThan(-3);
    expect(xhi).toBeGreaterThan(14);
    expect(ylo).toBeLessThan(-2);
    expect(yhi).toBeGreaterThan(12);
    // A curly quadrant's arms run to the plot's edge already; they do not move it.
    expect(includePlotGatesInAxisRange([0, 10], [{ ...spider, arms: { ...spider.arms, spider: undefined } }], "x")).toEqual([0, 10]);
  });

  it("leaves an auto range unchanged when all gate geometry is already visible", () => {
    const range: [number, number] = [0, 10];
    expect(includePlotGatesInAxisRange(range, [{
      vertices: [[2, 3], [8, 7]],
      label_offset: [0, 1],
    }], "x")).toBe(range);
  });

  it("expands only the edges needed to retain transformed gate vertices and labels", () => {
    const x = includePlotGatesInAxisRange([0, 10], [{
      vertices: [[-2, 3], [8, 7]],
      label_offset: [0, 5],
    }], "x");
    const y = includePlotGatesInAxisRange([0, 10], [{
      vertices: [[-2, 3], [8, 7]],
      label_offset: [0, 5],
    }], "y");

    expect(x[0]).toBeLessThan(-2);
    expect(x[1]).toBe(10);
    expect(y[0]).toBe(0);
    expect(y[1]).toBeGreaterThan(10);
  });

  it("keeps a quadrant centre within both automatically fitted axes", () => {
    expect(includePlotGatesInAxisRange([0, 10], [{ center: [12, -3] }], "x")[1])
      .toBeGreaterThan(12);
    expect(includePlotGatesInAxisRange([0, 10], [{ center: [12, -3] }], "y")[0])
      .toBeLessThan(-3);
  });

  it("ignores malformed and non-finite gate payload values", () => {
    const range: [number, number] = [0, 10];
    expect(includePlotGatesInAxisRange(range, [{
      vertices: [[NaN, 4], [Infinity, 6], "bad"],
      center: [undefined, null],
    }], "x")).toBe(range);
  });
});
