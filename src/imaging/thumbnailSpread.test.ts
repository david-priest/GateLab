import { describe, expect, it } from "vitest";
import type { PlottedPoints } from "../engine/sample";
import { chooseSpread, seededRandom, type SpreadFootprint } from "./thumbnailSpread";

function points(coords: [number, number][]): PlottedPoints {
  return { indices: null, xd: Float32Array.from(coords.map((c) => c[0])), yd: Float32Array.from(coords.map((c) => c[1])) };
}

/** A 1000 px square data area over [0, 100]², so a thumbnail of 100 px covers 10 units. */
const AREA: SpreadFootprint = { width: 1000, height: 1000, cell: 100 };
const unit = (coords: [number, number][], count: number, footprint = AREA, seed = 1) =>
  chooseSpread(points(coords), () => true, count, [0, 100], [0, 100], footprint, seed);

/** True when no two chosen thumbnails overlap in pixels. */
function noOverlap(coords: [number, number][], chosen: Int32Array, footprint = AREA): boolean {
  const px = (k: number) => [coords[k][0] * (footprint.width / 100), (100 - coords[k][1]) * (footprint.height / 100)];
  for (let i = 0; i < chosen.length; i++) {
    for (let j = i + 1; j < chosen.length; j++) {
      const [ax, ay] = px(chosen[i]);
      const [bx, by] = px(chosen[j]);
      if (Math.abs(ax - bx) < footprint.cell && Math.abs(ay - by) < footprint.cell) return false;
    }
  }
  return true;
}

const lattice = (): [number, number][] => {
  const coords: [number, number][] = [];
  for (let x = 5; x < 100; x += 10) for (let y = 5; y < 100; y += 10) coords.push([x, y]);
  return coords;
};

describe("chooseSpread", () => {
  it("takes one point per occupied cell, spread over the plot, up to the count", () => {
    // A dense pile at the origin and a few scattered points: the pile contributes one.
    const coords: [number, number][] = [];
    for (let i = 0; i < 50; i++) coords.push([1 + (i % 7) * 0.01, 1 + Math.floor(i / 7) * 0.01]);
    coords.push([50, 50], [90, 10], [10, 90], [90, 90]);
    const chosen = unit(coords, 5);
    expect(chosen.length).toBe(5);
    const picked = new Set(Array.from(chosen));
    expect(picked.has(50) && picked.has(51) && picked.has(52) && picked.has(53)).toBe(true);
    expect(Array.from(chosen).filter((k) => k < 50)).toHaveLength(1);
    // The fullest cell comes first, so the pile is always represented even at a count of one.
    expect(unit(coords, 1)[0]).toBeLessThan(50);
  });

  it("thins to the count by farthest-point sampling, and never overlaps two thumbnails", () => {
    const coords = lattice();
    const thinned = unit(coords, 10);
    expect(thinned.length).toBe(10);
    expect(new Set(Array.from(thinned)).size).toBe(10);
    expect(noOverlap(coords, thinned)).toBe(true);
    // Asking for more adds to the same set rather than reshuffling it.
    const more = unit(coords, 20);
    expect(Array.from(more).slice(0, 10)).toEqual(Array.from(thinned));
    // Neighbours whose footprints would touch are skipped, so a crowded corner shows fewer than asked.
    const crowded: [number, number][] = [[10, 10], [10, 11], [10, 12], [90, 90]];
    const few = unit(crowded, 3);
    expect(few.length).toBe(2);
    expect(Array.from(few)).toContain(3);
    expect(noOverlap(crowded, few)).toBe(true);
  });

  it("packs as many as fit: the grid is finer than a footprint, the overlap rule sets the spacing", () => {
    // 100 lattice points 100 px apart with 100 px footprints: every one fits.
    const coords = lattice();
    const all = unit(coords, 400);
    expect(all.length).toBe(100);
    expect(noOverlap(coords, all)).toBe(true);
    // Points 60 px apart: a footprint takes two lattice steps, so about a quarter fit, not one per footprint cell.
    const dense: [number, number][] = [];
    for (let x = 3; x < 100; x += 6) for (let y = 3; y < 100; y += 6) dense.push([x, y]);
    const packed = unit(dense, 400);
    expect(packed.length).toBeGreaterThanOrEqual(64);
    expect(noOverlap(dense, packed)).toBe(true);
  });

  it("fits fewer thumbnails on a smaller plot", () => {
    const coords = lattice();
    const small: SpreadFootprint = { width: 250, height: 250, cell: 100 };
    const chosen = unit(coords, 40, small);
    expect(chosen.length).toBeLessThanOrEqual(9);
    expect(chosen.length).toBeGreaterThanOrEqual(4);
    expect(noOverlap(coords, chosen, small)).toBe(true);
    expect(unit(coords, 40, { width: 0, height: 250, cell: 100 }).length).toBe(0);
  });

  it("offers only included points inside the ranges, and nothing for an empty range", () => {
    const chosen = chooseSpread(points([[10, 10], [20, 20], [500, 500]]), (k) => k !== 0, 5, [0, 100], [0, 100], AREA);
    expect(Array.from(chosen)).toEqual([1]);
    expect(chooseSpread(points([[1, 1]]), () => true, 5, [0, 0], [0, 1], AREA).length).toBe(0);
    expect(chooseSpread(points([]), () => true, 5, [0, 1], [0, 1], AREA).length).toBe(0);
  });

  it("reproduces a spread for a seed, and shows other cells for another", () => {
    // Several imaged points per grid cell, so the seed has something to choose between.
    const coords: [number, number][] = Array.from({ length: 3000 }, (_, i) => [((i * 37) % 1000) / 10, ((i * 53) % 1000) / 10]);
    const a = unit(coords, 20);
    const b = unit(coords, 20);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(20);
    expect(noOverlap(coords, a)).toBe(true);
    const other = unit(coords, 20, AREA, 2);
    expect(Array.from(other)).not.toEqual(Array.from(a));
    expect(noOverlap(coords, other)).toBe(true);
    // The generator itself: deterministic, in [0, 1).
    const r1 = seededRandom(7);
    const r2 = seededRandom(7);
    const draws = Array.from({ length: 5 }, () => r1());
    expect(draws).toEqual(Array.from({ length: 5 }, () => r2()));
    expect(draws.every((v) => v >= 0 && v < 1)).toBe(true);
  });
});
