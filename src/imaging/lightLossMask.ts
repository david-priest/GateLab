// lightLossMask.ts — the cell's outline on its LightLoss (transmitted light) picture, for its size.
//
// The SSC mask (objectCount.ts) is a threshold on scattered light, so it measures how far a cell
// scatters, which grows with how bright it is. The LightLoss picture is the beam the cell stands
// in: decoded with every row scaled to a background of 1 (cvwDecode.ts lightLossPlane), a cell
// reads as a dark ring, its edge, often broken, around a paler middle, as a cell does in
// brightfield. Its outline is the cell's own, whatever it scatters.
//
// The steps: the shadow (1 − the plane), its noise read from the empty columns at the picture's
// edges (and nothing at all when the edges hold no beam), a cut at several times that noise (and never below a floor), the dark patches found as
// the object count finds them (smoothed, closed, holes filled, specks, bands and streaks left
// out), then the patches of one cell gathered (the one at the cell's centre, from the SSC mask
// when there is one, and those close around it) and their convex hull filled, so a broken ring
// still gives the whole disc. Pure and small, so the worker runs it on every imaged event and
// the tests can draw rings for it.

import { countObjectsWithMask, maskFeatures, type MaskFeatures } from "./objectCount";

export interface LightLossOptions {
  /** The shadow is cut at this many robust standard deviations of the edge noise; 4 by default. */
  readonly noiseCut?: number;
  /** ... and never below this depth (a fraction of the background); 0.08 by default. */
  readonly minDepth?: number;
  /** Dark patches with fewer pixels than this are specks; 6 by default. */
  readonly minArea?: number;
}

export interface LightLossMeasure extends MaskFeatures {
  /** Pixels in the filled outline; 0 when no cell was found. */
  readonly area: number;
  /** The light the cell takes from the beam: the shadow summed over the outline, in background pixels. */
  readonly lightLost: number;
  /** The filled outline, row-major, for drawing. */
  readonly mask: Uint8Array;
}

/** The measures the count keeps per event from the LightLoss outline, keyed as the derived channels are (engine/derivedChannels.ts). */
export const LIGHT_LOSS_FEATURE_KEYS = ["llDiameter", "llMajorAxis", "llMinorAxis", "llCircularity", "llLightLost"] as const;

/** A measure as those keys hold it; 0 throughout for an event with no outline. */
export function lightLossFeatures(measure: Omit<LightLossMeasure, "mask">): Record<(typeof LIGHT_LOSS_FEATURE_KEYS)[number], number> {
  return {
    llDiameter: measure.diameter,
    llMajorAxis: measure.majorAxis,
    llMinorAxis: measure.minorAxis,
    llCircularity: measure.circularity,
    llLightLost: measure.lightLost,
  };
}

const NONE: Omit<LightLossMeasure, "mask"> = {
  perimeter: 0, circularity: 0, majorAxis: 0, minorAxis: 0, axisRatio: 0, diameter: 0, meanIntensity: 0, sdIntensity: 0, area: 0, lightLost: 0,
};

/** The centre of a mask's pixels in row units (columns × aspect), or null for an empty mask. */
export function maskCentre(mask: Uint8Array, rows: number, cols: number, aspect: number): { r: number; c: number } | null {
  let n = 0;
  let sr = 0;
  let sc = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!mask[r * cols + c]) continue;
      n++;
      sr += r;
      sc += c * aspect;
    }
  }
  return n > 0 ? { r: sr / n, c: sc / n } : null;
}

/** Robust standard deviation (1.4826 × MAD) of the plane over the outer tenth of columns on each side. */
export function edgeNoise(plane: Float32Array, rows: number, cols: number): number {
  const edge = Math.min(Math.max(1, Math.floor(cols * 0.1)), Math.floor(cols / 2));
  if (rows === 0 || edge === 0) return 0;
  // Typed arrays sort numerically and fast: this runs on every imaged event of a file.
  const values = new Float32Array(rows * edge * 2);
  let k = 0;
  for (let r = 0; r < rows; r++) {
    const row = r * cols;
    for (let c = 0; c < edge; c++) values[k++] = plane[row + c];
    for (let c = cols - edge; c < cols; c++) values[k++] = plane[row + c];
  }
  values.sort();
  const median = values[values.length >> 1];
  for (let i = 0; i < values.length; i++) values[i] = Math.abs(values[i] - median);
  values.sort();
  return 1.4826 * values[values.length >> 1];
}

/** The median of the plane over the same edge columns: about 1 where the beam is, near 0 where there is none. */
export function edgeLevel(plane: Float32Array, rows: number, cols: number): number {
  const edge = Math.min(Math.max(1, Math.floor(cols * 0.1)), Math.floor(cols / 2));
  if (rows === 0 || edge === 0) return 0;
  const values = new Float32Array(rows * edge * 2);
  let k = 0;
  for (let r = 0; r < rows; r++) {
    const row = r * cols;
    for (let c = 0; c < edge; c++) values[k++] = plane[row + c];
    for (let c = cols - edge; c < cols; c++) values[k++] = plane[row + c];
  }
  values.sort();
  return values[values.length >> 1];
}

interface Patch { readonly pixels: number[]; readonly r: number; readonly c: number }

/** The 8-connected patches of a mask, with their pixels and centres (in row units, columns × aspect). */
function patchesOf(mask: Uint8Array, rows: number, cols: number, aspect: number): Patch[] {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const out: Patch[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const pixels: number[] = [];
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let sr = 0;
    let sc = 0;
    while (top > 0) {
      const at = stack[--top];
      pixels.push(at);
      const r = Math.floor(at / cols);
      const c = at - r * cols;
      sr += r;
      sc += c * aspect;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          const j = rr * cols + cc;
          if (mask[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
        }
      }
    }
    out.push({ pixels, r: sr / pixels.length, c: sc / pixels.length });
  }
  return out;
}

/** Fill the convex hull of the given pixels (Andrew's monotone chain over pixel centres). */
function fillHull(pixels: readonly number[], rows: number, cols: number): Uint8Array {
  const out = new Uint8Array(rows * cols);
  const points = pixels.map((at) => { const r = Math.floor(at / cols); return [at - r * cols, r] as const; });
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: (readonly [number, number])[] = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: (readonly [number, number])[] = [];
  for (let k = points.length - 1; k >= 0; k--) {
    const p = points[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  for (const at of pixels) out[at] = 1;
  if (hull.length < 3) return out;
  let cMin = cols;
  let cMax = -1;
  let rMin = rows;
  let rMax = -1;
  for (const [c, r] of hull) { cMin = Math.min(cMin, c); cMax = Math.max(cMax, c); rMin = Math.min(rMin, r); rMax = Math.max(rMax, r); }
  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      // Inside (or on) a counter-clockwise hull: never to the right of an edge.
      let inside = true;
      for (let k = 0; k < hull.length && inside; k++) {
        const a = hull[k];
        const b = hull[(k + 1) % hull.length];
        if ((b[0] - a[0]) * (r - a[1]) - (b[1] - a[1]) * (c - a[0]) < -1e-9) inside = false;
      }
      if (inside) out[r * cols + c] = 1;
    }
  }
  return out;
}

/**
 * The cell's outline on its LightLoss plane (background 1, the cell darker) and what it measures,
 * in row-pixel units as maskFeatures gives them. `centre` is where the cell is, in row units
 * (columns × aspect), from the SSC mask; without it the largest dark patch is the cell.
 */
export function lightLossMeasure(
  plane: Float32Array,
  rows: number,
  cols: number,
  aspect: number,
  centre: { r: number; c: number } | null = null,
  options: LightLossOptions = {},
): LightLossMeasure {
  const empty = { ...NONE, mask: new Uint8Array(rows * cols) };
  if (rows === 0 || cols === 0) return empty;
  // No beam (a picture without a transmitted carrier) has no shadow to read.
  const level = edgeLevel(plane, rows, cols);
  if (!(level > 0.5 && level < 1.5)) return empty;
  const shadow = new Float32Array(plane.length);
  for (let i = 0; i < plane.length; i++) shadow[i] = 1 - plane[i];
  const noise = edgeNoise(plane, rows, cols);
  const cut = Math.max((options.noiseCut ?? 4) * noise, options.minDepth ?? 0.08);
  const dark = countObjectsWithMask(shadow, rows, cols, 1, { fraction: cut, minArea: options.minArea ?? 6 });
  if (dark.count === 0) return empty;
  const patches = patchesOf(dark.mask, rows, cols, aspect);
  if (patches.length === 0) return empty;
  // The patch the cell is: the one nearest its centre, else the largest.
  const distance = (p: Patch, at: { r: number; c: number }) => Math.hypot(p.r - at.r, p.c - at.c);
  let seed = patches[0];
  for (const p of patches) {
    if (centre ? distance(p, centre) < distance(seed, centre) : p.pixels.length > seed.pixels.length) seed = p;
  }
  // Gather the rest of a broken ring: patches whose centre lies within the cell's reach of its middle.
  let members = [seed];
  for (let round = 0; round < 2; round++) {
    const pixels = members.flatMap((m) => m.pixels);
    const mid = { r: members.reduce((s, m) => s + m.r * m.pixels.length, 0) / pixels.length, c: members.reduce((s, m) => s + m.c * m.pixels.length, 0) / pixels.length };
    let reach = 0;
    for (const at of pixels) {
      const r = Math.floor(at / cols);
      reach = Math.max(reach, Math.hypot(r - mid.r, (at - r * cols) * aspect - mid.c));
    }
    const at = centre ?? mid;
    // A broken ring's other arcs sit about a radius from the middle; the reach is at least a few pixels.
    const limit = Math.max(reach, 4) * 1.6 + 2;
    members = patches.filter((p) => p === seed || distance(p, at) <= limit || distance(p, mid) <= limit);
  }
  const mask = fillHull(members.flatMap((m) => m.pixels), rows, cols);
  let area = 0;
  let lightLost = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    area++;
    lightLost += Math.max(0, shadow[i]);
  }
  const features = maskFeatures(mask, shadow, rows, cols, aspect, 1);
  return { ...features, area, lightLost, mask };
}
