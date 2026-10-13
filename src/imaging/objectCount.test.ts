import { describe, expect, it } from "vitest";
import { OBJECT_CLASSES, countObjects, objectClassOf, sscSlotOf } from "./objectCount";

/** An SSC picture: dark field at a noise level, with bright discs where the objects are. */
function picture(
  rows: number,
  cols: number,
  discs: { r: number; c: number; radius: number; level?: number; ring?: boolean }[],
  noise = 0,
  lines: { col?: number; row?: number; level?: number; from?: number; to?: number }[] = [],
): Float32Array {
  const plane = new Float32Array(rows * cols);
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let v = noise * rand();
      for (const d of discs) {
        const dist2 = (r - d.r) ** 2 + (c - d.c) ** 2;
        if (dist2 <= d.radius ** 2 && (!d.ring || dist2 >= (d.radius - 2) ** 2)) v = d.level ?? 0.6;
      }
      for (const line of lines) {
        const from = line.from ?? 0;
        const to = line.to ?? Infinity;
        if (line.col !== undefined && c === line.col && r >= from && r <= to) v = line.level ?? 0.6;
        if (line.row !== undefined && r === line.row && c >= from && c <= to) v = line.level ?? 0.6;
      }
      plane[r * cols + c] = v;
    }
  }
  return plane;
}

const SCALE = 1;

describe("countObjects", () => {
  it("counts one disc, two discs, and none", () => {
    expect(countObjects(picture(60, 60, [{ r: 30, c: 30, radius: 8 }]), 60, 60, SCALE).count).toBe(1);
    expect(countObjects(picture(60, 60, [{ r: 20, c: 20, radius: 7 }, { r: 42, c: 44, radius: 7 }]), 60, 60, SCALE).count).toBe(2);
    expect(countObjects(picture(60, 60, []), 60, 60, SCALE)).toEqual({ count: 0, largestArea: 0, totalArea: 0 });
  });

  it("treats touching discs as one object and separated ones as two", () => {
    expect(countObjects(picture(60, 80, [{ r: 30, c: 30, radius: 8 }, { r: 30, c: 44, radius: 8 }]), 60, 80, SCALE).count).toBe(1);
    expect(countObjects(picture(60, 80, [{ r: 30, c: 20, radius: 8 }, { r: 30, c: 60, radius: 8 }]), 60, 80, SCALE).count).toBe(2);
  });

  it("ignores specks, noise below the threshold, and thin bands or streaks", () => {
    const specks = picture(60, 60, [{ r: 30, c: 30, radius: 8 }, { r: 10, c: 10, radius: 1 }, { r: 50, c: 50, radius: 1 }]);
    expect(countObjects(specks, 60, 60, SCALE).count).toBe(1);
    const noisy = picture(60, 60, [{ r: 30, c: 30, radius: 8 }], 0.1);
    expect(countObjects(noisy, 60, 60, SCALE).count).toBe(1);
    expect(countObjects(picture(60, 60, [], 0.1), 60, 60, SCALE).count).toBe(0);
    // A full-height band two columns wide, and a streak across half the width that does not touch it.
    const banded = picture(60, 60, [{ r: 30, c: 30, radius: 8 }], 0, [{ col: 50 }, { col: 51 }, { row: 5, from: 0, to: 40 }]);
    expect(countObjects(banded, 60, 60, SCALE).count).toBe(1);
    expect(countObjects(banded, 60, 60, SCALE, { bandWidth: 0, streakHeight: 0 }).count).toBe(3);
  });

  it("fills a ring into one object and reports the areas", () => {
    const ring = picture(60, 60, [{ r: 30, c: 30, radius: 10, ring: true }]);
    const result = countObjects(ring, 60, 60, SCALE);
    expect(result.count).toBe(1);
    expect(result.largestArea).toBeGreaterThan(250);
    const two = countObjects(picture(60, 60, [{ r: 30, c: 30, radius: 6 }, { r: 12, c: 12, radius: 4 }]), 60, 60, SCALE);
    expect(two.count).toBe(2);
    expect(two.totalArea).toBeGreaterThan(two.largestArea);
  });

  it("thresholds as a fraction of full scale, and does nothing without a scale", () => {
    const dim = picture(60, 60, [{ r: 30, c: 30, radius: 8, level: 0.1 }]);
    expect(countObjects(dim, 60, 60, SCALE).count).toBe(0);
    expect(countObjects(dim, 60, 60, SCALE, { fraction: 0.05 }).count).toBe(1);
    expect(countObjects(dim, 60, 60, 0.5).count).toBe(1);
    expect(countObjects(dim, 60, 60, 0).count).toBe(0);
  });

  it("classes counts as none, one, two, or three or more, and finds the SSC slot by name", () => {
    expect([0, 1, 2, 3, 9].map(objectClassOf)).toEqual([0, 1, 2, 3, 3]);
    expect(OBJECT_CLASSES).toHaveLength(4);
    expect(sscSlotOf(new Map([[2, "LightLoss (Imaging)"], [3, "FSC"], [6, "SSC (Imaging)"]]))).toBe(6);
    expect(sscSlotOf(new Map([[2, "LightLoss (Imaging)"]]))).toBe(4);
  });
});
