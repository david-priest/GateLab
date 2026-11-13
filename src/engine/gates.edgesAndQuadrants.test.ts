// The banded polygon test agrees with the plain crossing test; a half-open rectangle on each axis;
// the bound moved for a reader of the other edge rule on a float32 bound; a curl of power 1; and a
// quadrant gate asked for no quadrant gives Q1.
import { describe, expect, it } from "vitest";
import { gateMaskPolygon, gateMaskQuadrant, gateMaskRectangle, getGateMask, pointInPolygon, quadrantArmPoints, upperBoundForReader } from "./gates";
import { newQuadrantGate, type Vertex } from "./models";

function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("gateMaskPolygon on a polygon of many edges (banded)", () => {
  it("agrees with the plain crossing test on random events, seed 7", () => {
    const rand = mulberry32(7);
    // A 300-point star, so the bands are used (more than 64 edges).
    const poly: Vertex[] = Array.from({ length: 300 }, (_, i) => {
      const a = (2 * Math.PI * i) / 300, r = i % 2 ? 40 : 100;
      return [500 + r * Math.cos(a), 500 + r * Math.sin(a)];
    });
    const n = 20000;
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = 380 + 240 * rand(); ys[i] = 380 + 240 * rand(); }
    // Events on vertices and at the polygon's lowest and highest y.
    for (let i = 0; i < 300; i++) { xs[i] = poly[i][0]; ys[i] = poly[i][1]; }
    const mask = gateMaskPolygon(xs, ys, poly);
    const px = poly.map((v) => v[0]), py = poly.map((v) => v[1]);
    let differ = 0;
    for (let i = 0; i < n; i++) if (mask[i] !== (pointInPolygon(xs[i], ys[i], px, py) ? 1 : 0)) differ++;
    expect(differ).toBe(0);
    expect(Array.from(mask.subarray(0, 300)).every((v) => v === 1)).toBe(true);
  });
});

describe("gateMaskRectangle, half-open", () => {
  const box: Vertex[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  it("leaves out an event outside on x alone, outside on y alone, and at +Infinity on a bounded side of either axis", () => {
    const xs = [5, -1, 5, 5, Infinity, 0, 10, 5];
    const ys = [5, 5, -1, 11, 5, 0, 5, Infinity];
    expect(Array.from(gateMaskRectangle(xs, ys, box, "half-open"))).toEqual([1, 0, 0, 0, 0, 1, 0, 0]);
  });
});

describe("upperBoundForReader on a bound that is a float32 value", () => {
  it("moves a half-open gate's bound strictly below it for a closed reader", () => {
    const b = upperBoundForReader(1000, "half-open", "closed");
    expect(b).toBeLessThan(1000);
    expect(b).toBeGreaterThan(Math.fround(1000 - 6e-5));
  });
  it("moves a closed gate's bound by the edge-rule shift for a half-open reader", () => {
    expect(upperBoundForReader(1000, "closed", "half-open")).toBe(1000 + 1000 * 1e-13);
  });
});

describe("quadrants", () => {
  it("bends the horizontal divider for a curl of power 1", () => {
    // ydiv = 0 + 1 * x for x > 0: the event (2, 1) lies below it, in Q3.
    expect(Array.from(gateMaskQuadrant([2], [1], [0, 0], 3, { kx: 1, ky: 0, power: 1 }))).toEqual([1]);
  });
  it("reads a quadrant gate with no quadrant named as Q1", () => {
    const g = newQuadrantGate("Q", "FL1-A", "FL2-A", [0, 0]);
    const cols: Record<string, number[]> = { "FL1-A": [-1, 1], "FL2-A": [1, 1] };
    expect(Array.from(getGateMask(g, { n: 2, column: (c) => cols[c] }))).toEqual([1, 0]);
  });
  it("samples a bent arm at 33 points by default, and none where it has no length", () => {
    const curl = { kx: 1, ky: 0, power: 2 };
    expect(quadrantArmPoints([0, 0], curl, "h", 10)).toHaveLength(33);
    expect(quadrantArmPoints([0, 0], curl, "h", 0)).toEqual([]);
  });
});
