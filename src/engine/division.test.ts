import { describe, it, expect } from "vitest";
import {
  assignDivisionLevel, divisionLevelCounts, divisionPalette, computeAxisRange,
  seedDivisionBoundaries, spaceEvenly, resizeBoundaries, computeDivisionContours, buildDivisionPayload,
} from "./division";

describe("assignDivisionLevel — Div0 = brightest", () => {
  const b = [2, 4, 6]; // 3 boundaries → levels 0..3
  it("assigns higher values to lower (brighter) levels", () => {
    expect(assignDivisionLevel(7, b)).toBe(0); // above all → Div0 (undivided)
    expect(assignDivisionLevel(5, b)).toBe(1);
    expect(assignDivisionLevel(3, b)).toBe(2);
    expect(assignDivisionLevel(1, b)).toBe(3); // below all → most divided
  });
  it("no boundaries → everything is Div0", () => {
    expect(assignDivisionLevel(42, [])).toBe(0);
  });
});

describe("divisionLevelCounts", () => {
  it("counts events per level (length N+1)", () => {
    expect(divisionLevelCounts([7, 5, 3, 1], [2, 4, 6])).toEqual([1, 1, 1, 1]);
    expect(divisionLevelCounts([7, 7, 1], [4])).toEqual([2, 1]); // 2 boundaries? no: 1 boundary → levels 0,1
  });
});

describe("divisionPalette", () => {
  it("returns N+1 Paired colours", () => {
    expect(divisionPalette(3)).toEqual(["#a6cee3", "#1f78b4", "#b2df8a"]);
    expect(divisionPalette(7)).toHaveLength(7);
  });
});

describe("computeAxisRange", () => {
  it("uses 0.1/99.9 pct + 5% pad", () => {
    const vals = Array.from({ length: 1000 }, (_, i) => i / 100); // 0..9.99
    const [lo, hi] = computeAxisRange(vals);
    expect(lo).toBeLessThan(0.1);
    expect(hi).toBeGreaterThan(9.8);
    expect(lo).toBeLessThan(0); // padded below the min
  });
  it("empty → [0,1]", () => {
    expect(computeAxisRange([])).toEqual([0, 1]);
  });
});

describe("seedDivisionBoundaries", () => {
  it("returns n sorted boundaries inside the data range", () => {
    // two clear peaks near 2 and 6 (a clean 'ladder')
    const vals: number[] = [];
    for (let i = 0; i < 500; i++) vals.push(2 + (Math.sin(i) * 0.05));
    for (let i = 0; i < 500; i++) vals.push(6 + (Math.cos(i) * 0.05));
    const b = seedDivisionBoundaries(vals, 4);
    expect(b).toHaveLength(4);
    for (let i = 1; i < b.length; i++) expect(b[i]).toBeGreaterThanOrEqual(b[i - 1]);
    expect(Math.min(...b)).toBeGreaterThan(-5);
    expect(Math.max(...b)).toBeLessThan(8);
  });
  it("too few values → empty", () => {
    expect(seedDivisionBoundaries([1, 2, 3], 6)).toEqual([]);
  });
});

describe("spaceEvenly — respace existing boundaries uniformly (anchored at max)", () => {
  it("uses the median gap anchored at the brightest boundary", () => {
    expect(spaceEvenly([2, 5, 8])).toEqual([2, 5, 8]); // already uniform (gap 3) → unchanged
    expect(spaceEvenly([1, 5, 8])).toEqual([1, 4.5, 8]); // median gap 3.5, anchor 8
  });
  it("returns as-is with fewer than 2 boundaries (caller reseeds)", () => {
    expect(spaceEvenly([5])).toEqual([5]);
    expect(spaceEvenly([])).toEqual([]);
  });
});

describe("resizeBoundaries — change # divisions in place", () => {
  const seed = () => [1, 2, 3];
  it("seeds when there are no boundaries yet", () => {
    expect(resizeBoundaries([], 3, seed)).toEqual([1, 2, 3]);
  });
  it("keeps fits and extends at the dim end using the median gap", () => {
    expect(resizeBoundaries([10, 14, 18], 4, seed)).toEqual([6, 10, 14, 18]); // gap 4 → prepend 6
  });
  it("drops the dimmest boundary when shrinking", () => {
    expect(resizeBoundaries([6, 10, 14, 18], 2, seed)).toEqual([14, 18]);
  });
  it("is a no-op at the target count", () => {
    expect(resizeBoundaries([10, 14], 2, seed)).toEqual([10, 14]);
  });
});

describe("computeDivisionContours — 2-D KDE overlay", () => {
  // A tight 2-D Gaussian-ish cluster centred at (5, 5) plus a bit of spread.
  const bx: number[] = [];
  const by: number[] = [];
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < 2000; i++) {
    // Box-Muller-ish jitter around (5,5)
    const r = Math.sqrt(-2 * Math.log(rnd() + 1e-9));
    const a = 2 * Math.PI * rnd();
    bx.push(5 + r * Math.cos(a) * 0.6);
    by.push(5 + r * Math.sin(a) * 0.6);
  }

  it("yields non-empty {x,y} polylines with finite coords", () => {
    const contours = computeDivisionContours(bx, by, [2, 8], [2, 8]);
    expect(contours.length).toBeGreaterThan(0);
    for (const c of contours) {
      expect(c.x.length).toBeGreaterThanOrEqual(2);
      expect(c.x.length).toBe(c.y.length);
      for (let i = 0; i < c.x.length; i++) {
        expect(Number.isFinite(c.x[i])).toBe(true);
        expect(Number.isFinite(c.y[i])).toBe(true);
        // coords stay within the requested grid span
        expect(c.x[i]).toBeGreaterThanOrEqual(2 - 1e-6);
        expect(c.x[i]).toBeLessThanOrEqual(8 + 1e-6);
        expect(c.y[i]).toBeGreaterThanOrEqual(2 - 1e-6);
        expect(c.y[i]).toBeLessThanOrEqual(8 + 1e-6);
      }
    }
  });

  it("guards: <20 finite pairs → empty", () => {
    expect(computeDivisionContours([1, 2, 3], [1, 2, 3], [0, 4], [0, 4])).toEqual([]);
  });

  it("degenerate (non-positive) axis range → empty", () => {
    const vals = Array.from({ length: 100 }, (_, i) => i / 10);
    expect(computeDivisionContours(vals, vals, [5, 5], [0, 10])).toEqual([]);
    expect(computeDivisionContours(vals, vals, [0, 10], [8, 2])).toEqual([]);
  });

  it("buildDivisionPayload sets contours only when biplot data is present", () => {
    const base = {
      dyeValues: [1, 2, 3], xLabel: "CTV", xRange: [2, 8] as [number, number],
      bins: 64, boundaries: [4], seq: 1,
    };
    expect(buildDivisionPayload(base).contours).toBeUndefined();
    const withBiplot = buildDivisionPayload({
      ...base, biplotDye: Float32Array.from(bx), markerValues: Float32Array.from(by),
      yLabel: "CD38", yRange: [2, 8] as [number, number],
    });
    expect(Array.isArray(withBiplot.contours)).toBe(true);
    expect((withBiplot.contours as unknown[]).length).toBeGreaterThan(0);
  });
});
