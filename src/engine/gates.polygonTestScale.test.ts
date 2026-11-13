// The polygon test scales each axis by a power of two chosen from the data and the vertices:
// which power is chosen, and that each axis is scaled on its own.
import { describe, expect, it } from "vitest";
import { gateMaskPolygon, polygonTestScale } from "./gates";
import type { Vertex } from "./models";

const tri = (s: number): [number, number][] => [[0, 0], [s, 0], [s, s]];

describe("polygonTestScale", () => {
  it("brings vertices below 1/16 up to 1/16 by the least power of two", () => {
    // 0.01 * 8 = 0.08 >= 1/16; 0.01 * 4 = 0.04 is not.
    expect(polygonTestScale(tri(0.01))).toEqual([8, 8]);
  });

  it("leaves a polygon whose vertices are all zero at scale 1", () => {
    expect(polygonTestScale([[0, 0], [0, 0], [0, 0]])).toEqual([1, 1]);
  });

  it("stays at 1 when one event in a hundred reaches 1/16, and needs that many", () => {
    const hundred = new Array(100).fill(1);
    expect(polygonTestScale(tri(0.01), hundred, hundred)).toEqual([1, 1]);
    // 200 events need two that reach 1/16; one is not enough.
    const one = new Array(200).fill(0.001);
    one[0] = 1;
    expect(polygonTestScale(tri(0.01), one, one)).toEqual([8, 8]);
  });

  it("counts the first event", () => {
    expect(polygonTestScale(tri(0.01), [1, 0.001], [1, 0.001])).toEqual([1, 1]);
  });

  it("does not count an event at 1e14 (a skirt's value)", () => {
    expect(polygonTestScale(tri(0.01), [1e14], [1e14])).toEqual([8, 8]);
  });

  it("stops at 2^1000 for vertices too small to reach 1/16", () => {
    const [fx] = polygonTestScale(tri(1e-310));
    expect(fx).toBe(2 ** 1000);
  });
});

describe("gateMaskPolygon at a scale on one axis only", () => {
  // x extent 0.01 (scaled by 8), y extent 10 (scale 1); and the transpose.
  const poly: Vertex[] = [[0, 0], [0.01, 0], [0.01, 10], [0, 10]];
  it("holds an event inside a polygon small on x", () => {
    expect(Array.from(gateMaskPolygon([0.005, 0.02], [5, 5], poly))).toEqual([1, 0]);
  });
  it("holds an event inside a polygon small on y", () => {
    const t: Vertex[] = poly.map(([x, y]) => [y, x]);
    expect(Array.from(gateMaskPolygon([5, 5], [0.005, 0.02], t))).toEqual([1, 0]);
  });
  it("holds an event inside a polygon scaled by 2 on x", () => {
    // 0.05 * 2 = 0.1 >= 1/16, so fx = 2.
    const p2: Vertex[] = [[0, 0], [0.05, 0], [0.05, 10], [0, 10]];
    expect(polygonTestScale(p2, [0.03], [5])).toEqual([2, 1]);
    expect(Array.from(gateMaskPolygon([0.03, 0.06], [5, 5], p2))).toEqual([1, 0]);
  });
  it("holds an event inside a polygon scaled by 2 on y", () => {
    const p2: Vertex[] = [[0, 0], [10, 0], [10, 0.05], [0, 0.05]];
    expect(polygonTestScale(p2, [5], [0.03])).toEqual([1, 2]);
    expect(Array.from(gateMaskPolygon([5, 5], [0.03, 0.06], p2))).toEqual([1, 0]);
  });
  it("leaves out an event 5e-10 past the edge of a polygon 1e-4 across, which the 1e-9 tolerance would hold unscaled", () => {
    const p: Vertex[] = [[0, 0], [1e-4, 0], [1e-4, 1e-4], [0, 1e-4]];
    expect(Array.from(gateMaskPolygon([1e-4 + 5e-10, 5e-5], [5e-5, 5e-5], p))).toEqual([0, 1]);
  });
});
