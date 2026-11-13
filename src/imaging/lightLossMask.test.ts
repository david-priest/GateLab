import { describe, expect, it } from "vitest";
import { LIGHT_LOSS_FEATURE_KEYS, edgeNoise, lightLossFeatures, lightLossMeasure, maskCentre } from "./lightLossMask";

const ROWS = 104;
const COLS = 70;

/** A LightLoss plane: background 1 with a little deterministic noise. */
function background(seed = 1): Float32Array {
  const plane = new Float32Array(ROWS * COLS);
  let x = seed;
  for (let i = 0; i < plane.length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    plane[i] = 1 + ((x / 2147483648) - 0.5) * 0.06;
  }
  return plane;
}

/**
 * Draw a dark ring (the cell's edge) of radius `radius` around (r0, c0), in row units with
 * columns × `aspect`, `width` thick and `depth` deep, missing the arcs `gaps` (radian ranges).
 */
function ring(plane: Float32Array, r0: number, c0: number, radius: number, aspect: number, depth = 0.4, width = 2.5, gaps: [number, number][] = []): void {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const dy = r - r0;
      const dx = c * aspect - c0;
      const d = Math.hypot(dy, dx);
      if (Math.abs(d - radius) > width / 2) continue;
      const angle = Math.atan2(dy, dx);
      if (gaps.some(([a, b]) => angle >= a && angle <= b)) continue;
      plane[r * COLS + c] -= depth;
    }
  }
}

describe("lightLossMeasure", () => {
  it("reads the diameter of a ring as the whole disc it bounds, at true shape", () => {
    const plane = background();
    ring(plane, 50, 40, 12, 1.2);
    const m = lightLossMeasure(plane, ROWS, COLS, 1.2, { r: 50, c: 40 });
    // The outline is the ring's outer edge: radius 12 + half the width.
    expect(m.diameter).toBeGreaterThan(24);
    expect(m.diameter).toBeLessThan(28.5);
    expect(m.axisRatio).toBeGreaterThan(0.9);
    expect(m.lightLost).toBeGreaterThan(0);
    // The filled outline covers the paler middle too.
    expect(m.mask[50 * COLS + Math.round(40 / 1.2)]).toBe(1);
  });

  it("still gives the whole disc when the ring is broken in two places", () => {
    const whole = background(2);
    ring(whole, 50, 40, 12, 1.2);
    const broken = background(2);
    ring(broken, 50, 40, 12, 1.2, 0.4, 2.5, [[-0.5, 0.5], [2.4, 3.2]]);
    const a = lightLossMeasure(whole, ROWS, COLS, 1.2, { r: 50, c: 40 });
    const b = lightLossMeasure(broken, ROWS, COLS, 1.2, { r: 50, c: 40 });
    expect(Math.abs(b.diameter - a.diameter)).toBeLessThan(1.5);
  });

  it("measures the cell at the given centre, not a speck elsewhere in the picture", () => {
    const plane = background(3);
    ring(plane, 50, 40, 8, 1.2);
    // A larger dark blot near the top edge, far from the cell.
    for (let r = 4; r < 12; r++) for (let c = 4; c < 16; c++) plane[r * COLS + c] -= 0.5;
    const m = lightLossMeasure(plane, ROWS, COLS, 1.2, { r: 50, c: 40 });
    expect(m.diameter).toBeGreaterThan(15);
    expect(m.diameter).toBeLessThan(21);
    expect(m.mask[8 * COLS + 10]).toBe(0);
  });

  it("finds no cell in an empty beam", () => {
    const m = lightLossMeasure(background(4), ROWS, COLS, 1.2, null);
    expect(m.area).toBe(0);
    expect(m.diameter).toBe(0);
    expect(Object.values(lightLossFeatures(m)).every((v) => v === 0)).toBe(true);
  });

  it("reads nothing from a picture with no beam in it", () => {
    const dark = new Float32Array(ROWS * COLS);
    expect(lightLossMeasure(dark, ROWS, COLS, 1.2, { r: 50, c: 40 }).area).toBe(0);
  });

  it("keys its measures as the derived channels do", () => {
    expect(LIGHT_LOSS_FEATURE_KEYS).toEqual(["llDiameter", "llMajorAxis", "llMinorAxis", "llCircularity", "llLightLost"]);
  });
});

describe("edgeNoise and maskCentre", () => {
  it("reads the noise from the edge columns, whatever sits in the middle", () => {
    const plane = background(5);
    const before = edgeNoise(plane, ROWS, COLS);
    ring(plane, 50, 40, 10, 1.2);
    expect(edgeNoise(plane, ROWS, COLS)).toBeCloseTo(before, 6);
    // Uniform noise of width 0.06 has a robust SD of about 0.022.
    expect(before).toBeGreaterThan(0.015);
    expect(before).toBeLessThan(0.03);
  });

  it("gives the centre of a mask in row units, columns scaled by the aspect", () => {
    const mask = new Uint8Array(10 * 10);
    mask[3 * 10 + 4] = 1;
    mask[5 * 10 + 6] = 1;
    expect(maskCentre(mask, 10, 10, 1.5)).toEqual({ r: 4, c: 7.5 });
    expect(maskCentre(new Uint8Array(100), 10, 10, 1)).toBeNull();
  });
});
