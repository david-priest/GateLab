// thumbnailSpread.ts — which cells to show as thumbnails over a plot. Imaged events spread across
// the plotted area, so the picture of the biplot is representative rather than a pile in the
// densest corner, and never on top of each other: the data area is cut into a grid of cells half
// a thumbnail footprint wide, each occupied cell offers one of its imaged points (drawn by a seeded
// generator, so a seed reproduces a spread and a new seed shows other cells), and the offers are
// taken by farthest-point sampling (the fullest cell first, then whichever is farthest from
// everything taken so far) until the count is reached, skipping any whose footprint would overlap
// one already taken. Half-footprint cells give more offers than can fit, so the overlap rule, not
// the grid, decides how closely thumbnails pack. The count is a ceiling: a small plot shows fewer.

import type { PlottedPoints } from "../engine/sample";

export interface SpreadFootprint {
  /** The data area, in pixels. */
  readonly width: number;
  readonly height: number;
  /** One thumbnail's footprint in pixels, gap included. */
  readonly cell: number;
}

/** A small deterministic generator (mulberry32): the same seed draws the same sequence. */
export function seededRandom(seed: number): () => number {
  let a = (Math.floor(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Plot positions (indices into the plotted arrays) of the cells to show. */
export function chooseSpread(
  plotted: PlottedPoints,
  include: (k: number) => boolean,
  count: number,
  xr: readonly [number, number],
  yr: readonly [number, number],
  footprint: SpreadFootprint,
  seed = 1,
): Int32Array {
  const n = Math.min(plotted.xd.length, plotted.yd.length);
  if (n === 0 || count <= 0) return new Int32Array(0);
  const spanX = xr[1] - xr[0];
  const spanY = yr[1] - yr[0];
  if (!(spanX > 0) || !(spanY > 0)) return new Int32Array(0);
  const { width, height, cell } = footprint;
  if (!(width > 0) || !(height > 0) || !(cell > 0)) return new Int32Array(0);
  const pitch = cell / 2;
  const nx = Math.max(1, Math.floor(width / pitch));
  const ny = Math.max(1, Math.floor(height / pitch));
  const cellW = width / nx;
  const cellH = height / ny;

  // Per grid cell: one imaged point drawn uniformly from its members (reservoir sampling), where
  // it sits in pixels, and how full the cell is.
  const cells = nx * ny;
  const pick = new Int32Array(cells).fill(-1);
  const px = new Float64Array(cells);
  const py = new Float64Array(cells);
  const members = new Uint32Array(cells);
  const rand = seededRandom(seed);
  for (let k = 0; k < n; k++) {
    const x = plotted.xd[k];
    const y = plotted.yd[k];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < xr[0] || x > xr[1] || y < yr[0] || y > yr[1]) continue;
    if (!include(k)) continue;
    const sx = ((x - xr[0]) / spanX) * width;
    const sy = ((yr[1] - y) / spanY) * height;
    const cx = Math.min(nx - 1, Math.floor(sx / cellW));
    const cy = Math.min(ny - 1, Math.floor(sy / cellH));
    const c = cy * nx + cx;
    members[c]++;
    if (rand() * members[c] < 1) {
      pick[c] = k;
      px[c] = sx;
      py[c] = sy;
    }
  }
  const occupied: number[] = [];
  for (let c = 0; c < cells; c++) if (pick[c] >= 0) occupied.push(c);
  if (occupied.length === 0) return new Int32Array(0);

  // Farthest-point sampling over the offers, from the fullest cell.
  const m = occupied.length;
  const used = new Uint8Array(m);
  const minDist = new Float64Array(m).fill(Infinity);
  const taken: number[] = [];
  let next = 0;
  for (let i = 1; i < m; i++) if (members[occupied[i]] > members[occupied[next]]) next = i;
  while (taken.length < count) {
    const c = occupied[next];
    used[next] = 1;
    let overlaps = false;
    for (const t of taken) {
      if (Math.abs(px[c] - px[t]) < cell && Math.abs(py[c] - py[t]) < cell) { overlaps = true; break; }
    }
    if (!overlaps) {
      taken.push(c);
      for (let i = 0; i < m; i++) {
        if (used[i]) continue;
        const o = occupied[i];
        const d = (px[o] - px[c]) ** 2 + (py[o] - py[c]) ** 2;
        if (d < minDist[i]) minDist[i] = d;
      }
    }
    next = -1;
    for (let i = 0; i < m; i++) if (!used[i] && (next < 0 || minDist[i] > minDist[next])) next = i;
    if (next < 0) break;
  }
  return Int32Array.from(taken, (c) => pick[c]);
}
