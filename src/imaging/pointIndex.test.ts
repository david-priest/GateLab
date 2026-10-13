import { describe, expect, it } from "vitest";
import { buildPointIndex } from "./pointIndex";

describe("buildPointIndex", () => {
  it("finds the nearest point within the radius, in the anisotropic metric", () => {
    const xd = Float32Array.from([0, 10, 20, 30]);
    const yd = Float32Array.from([0, 0, 100, 100]);
    const index = buildPointIndex(xd, yd)!;
    expect(index.size).toBe(4);
    expect(index.nearest(9, 1, 2, 5)).toBe(1);
    expect(index.nearest(21, 99, 2, 5)).toBe(2);
    expect(index.nearest(15, 50, 2, 5)).toBeNull();
    // A wide radius in y but narrow in x: the point directly below is in, the one beside is not.
    expect(index.nearest(10, 60, 1, 70)).toBe(1);
    expect(index.nearest(10, 60, 1, 50)).toBeNull();
    expect(index.nearest(15, 0, 1, 50)).toBeNull();
    expect(index.nearest(15, 0, 6, 1)).toBe(1);
  });

  it("prefers the closest of several candidates", () => {
    const xd = Float32Array.from([0, 1, 2, 3, 4]);
    const yd = Float32Array.from([0, 0, 0, 0, 0]);
    const index = buildPointIndex(xd, yd, { cells: 4 })!;
    expect(index.nearest(2.4, 0, 3, 3)).toBe(2);
    expect(index.nearest(2.6, 0, 3, 3)).toBe(3);
  });

  it("ignores non-finite points and refuses empty or oversized sets", () => {
    const index = buildPointIndex(Float32Array.from([NaN, 1, Infinity]), Float32Array.from([0, 1, 2]))!;
    expect(index.size).toBe(1);
    expect(index.nearest(1, 1, 1, 1)).toBe(1);
    expect(buildPointIndex(new Float32Array(0), new Float32Array(0))).toBeNull();
    expect(buildPointIndex(new Float32Array(10), new Float32Array(10), { maxPoints: 5 })).toBeNull();
    expect(buildPointIndex(Float32Array.from([NaN]), Float32Array.from([NaN]))).toBeNull();
  });

  it("leaves out the points the filter refuses, so the nearest is the nearest included", () => {
    const xd = Float32Array.from([0, 1, 2]);
    const yd = Float32Array.from([0, 0, 0]);
    const index = buildPointIndex(xd, yd, { include: (k) => k !== 1 })!;
    expect(index.size).toBe(2);
    expect(index.nearest(1, 0, 0.6, 1)).toBeNull();
    expect(index.nearest(1.1, 0, 1, 1)).toBe(2);
    expect(buildPointIndex(xd, yd, { include: () => false })!.size).toBe(0);
  });

  it("handles points that all share one coordinate", () => {
    const index = buildPointIndex(Float32Array.from([5, 5, 5]), Float32Array.from([1, 2, 3]))!;
    expect(index.nearest(5, 2.1, 1, 0.5)).toBe(1);
    expect(index.nearest(5, 2.6, 1, 0.5)).toBe(2);
  });

  it("answers a query outside the bounding box without error", () => {
    const index = buildPointIndex(Float32Array.from([0, 1]), Float32Array.from([0, 1]))!;
    expect(index.nearest(100, 100, 1, 1)).toBeNull();
    expect(index.nearest(-100, -100, 1, 1)).toBeNull();
    expect(index.nearest(1.5, 1.5, 1, 1)).toBe(1);
  });
});
