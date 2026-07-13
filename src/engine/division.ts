// division.ts — Division Profiler helpers, ported from GateLabR (workspace.R seed/assign +
// app.R division_palette + data_utils.R compute_axis_range + the send_division_plot payload).
// A 1-D histogram of one dye channel is partitioned by N draggable boundaries into division
// generations Div0..DivN (Div0 = brightest = undivided). Levels become a per-event categorical
// (usable as a Proportions Category). Rendered through the reused window.DivisionD3.render.

import { encodeFloat32Base64 } from "./encode";
import { paletteColors } from "./palettes";
import { quantile } from "./proportions";

/** N+1 Paired-palette colours (Div0..DivN); matches app.R division_palette / the Proportions "paired". */
export function divisionPalette(nLevels: number): string[] {
  return paletteColors("paired", Math.max(1, nLevels));
}

/** Division level for a value: Div0 = brightest (above the top boundary). `bounds` sorted ascending. */
export function assignDivisionLevel(x: number, bounds: number[]): number {
  // findInterval(x, b) = number of boundaries ≤ x; level = N - that (workspace.R:184).
  let count = 0;
  for (let i = 0; i < bounds.length; i++) if (bounds[i] <= x) count++;
  return bounds.length - count;
}

/** Per-level event counts (length N+1) for a value array. */
export function divisionLevelCounts(values: ArrayLike<number>, bounds: number[]): number[] {
  const sorted = [...bounds].sort((a, b) => a - b);
  const counts = new Array(sorted.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) counts[assignDivisionLevel(v, sorted)]++;
  }
  return counts;
}

/** Axis range: 0.1% / 99.9% quantiles + 5% pad (data_utils.R compute_axis_range). */
export function computeAxisRange(values: ArrayLike<number>): [number, number] {
  const finite: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) finite.push(values[i] as number);
  if (finite.length === 0) return [0, 1];
  finite.sort((a, b) => a - b);
  const lo = quantile(finite, 0.001);
  const hi = quantile(finite, 0.999);
  let span = hi - lo;
  if (span < 1e-10) span = 1;
  const pad = span * 0.05;
  return [lo - pad, hi + pad];
}

// Silverman nrd0 bandwidth (R stats::bw.nrd0).
function nrd0(sorted: number[]): number {
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  let lo = Math.min(sd, iqr / 1.349);
  if (!(lo > 0)) lo = sd || Math.abs(sorted[0]) || 1;
  return 0.9 * lo * Math.pow(n, -0.2);
}

/** Binned Gaussian KDE evaluated on `grid` points over [from,to]; returns the density at each grid point. */
function kde(values: number[], bw: number, from: number, to: number, ngrid = 512): { x: number[]; y: number[] } {
  const x = new Array(ngrid);
  const y = new Array(ngrid).fill(0);
  const step = (to - from) / (ngrid - 1);
  for (let i = 0; i < ngrid; i++) x[i] = from + i * step;
  // Bin into a fine histogram, then convolve with a Gaussian kernel (truncated at ±4σ).
  const hist = new Array(ngrid).fill(0);
  for (const v of values) {
    const b = Math.round((v - from) / step);
    if (b >= 0 && b < ngrid) hist[b]++;
  }
  const sigmaBins = bw / step;
  const half = Math.max(1, Math.ceil(sigmaBins * 4));
  const kernel: number[] = [];
  let ksum = 0;
  for (let k = -half; k <= half; k++) { const w = Math.exp(-0.5 * (k / sigmaBins) ** 2); kernel.push(w); ksum += w; }
  for (let i = 0; i < ngrid; i++) {
    if (hist[i] === 0) continue;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < ngrid) y[j] += hist[i] * kernel[k + half];
    }
  }
  const norm = values.length * ksum * step;
  if (norm > 0) for (let i = 0; i < ngrid; i++) y[i] /= norm;
  return { x, y };
}

/**
 * 2-D Gaussian KDE on an `ngrid`x`ngrid` grid spanning `xRange` x `yRange`, built by binning the
 * (x,y) points to grid nodes then convolving separably with a Gaussian kernel per axis (a diagonal-
 * covariance 2-D Gaussian factorises into row-then-column 1-D convolutions — same binning idea as
 * the 1-D kde() above). Returns the grid coords and the density surface `z[i*ngrid + j]`
 * (i = x index, j = y index). Density is un-normalised — only relative levels matter for contours.
 */
function kde2d(
  xs: number[], ys: number[], xRange: [number, number], yRange: [number, number], ngrid = 64,
): { gx: number[]; gy: number[]; z: Float64Array; zmax: number } {
  const [xlo, xhi] = xRange;
  const [ylo, yhi] = yRange;
  const stepx = (xhi - xlo) / (ngrid - 1);
  const stepy = (yhi - ylo) / (ngrid - 1);
  const gx = new Array(ngrid);
  const gy = new Array(ngrid);
  for (let i = 0; i < ngrid; i++) gx[i] = xlo + i * stepx;
  for (let j = 0; j < ngrid; j++) gy[j] = ylo + j * stepy;

  // Bin points to nearest grid node.
  const hist = new Float64Array(ngrid * ngrid);
  for (let p = 0; p < xs.length; p++) {
    const bi = Math.round((xs[p] - xlo) / stepx);
    const bj = Math.round((ys[p] - ylo) / stepy);
    if (bi >= 0 && bi < ngrid && bj >= 0 && bj < ngrid) hist[bi * ngrid + bj]++;
  }

  const sortedX = [...xs].sort((a, b) => a - b);
  const sortedY = [...ys].sort((a, b) => a - b);
  const bwx = nrd0(sortedX) || (stepx * ngrid) / 20;
  const bwy = nrd0(sortedY) || (stepy * ngrid) / 20;
  const gaussKernel = (sigmaBins: number): number[] => {
    const s = sigmaBins > 0 ? sigmaBins : 1e-6;
    const half = Math.max(1, Math.ceil(s * 4));
    const k: number[] = [];
    for (let t = -half; t <= half; t++) k.push(Math.exp(-0.5 * (t / s) ** 2));
    return k;
  };
  const kx = gaussKernel(bwx / stepx);
  const ky = gaussKernel(bwy / stepy);
  const halfx = (kx.length - 1) / 2;
  const halfy = (ky.length - 1) / 2;

  // Convolve along x (rows of fixed j), then along y.
  const tmp = new Float64Array(ngrid * ngrid);
  for (let i = 0; i < ngrid; i++) {
    for (let j = 0; j < ngrid; j++) {
      const src = hist[i * ngrid + j];
      if (src === 0) continue;
      for (let t = -halfx; t <= halfx; t++) {
        const ii = i + t;
        if (ii >= 0 && ii < ngrid) tmp[ii * ngrid + j] += src * kx[t + halfx];
      }
    }
  }
  const z = new Float64Array(ngrid * ngrid);
  let zmax = 0;
  for (let i = 0; i < ngrid; i++) {
    for (let j = 0; j < ngrid; j++) {
      const src = tmp[i * ngrid + j];
      if (src === 0) continue;
      for (let t = -halfy; t <= halfy; t++) {
        const jj = j + t;
        if (jj >= 0 && jj < ngrid) z[i * ngrid + jj] += src * ky[t + halfy];
      }
    }
  }
  for (let k = 0; k < z.length; k++) if (z[k] > zmax) zmax = z[k];
  return { gx, gy, z, zmax };
}

/** Extract iso-density contour polylines from a `kde2d` surface via marching squares. */
function marchingSquares(
  gx: number[], gy: number[], z: Float64Array, ngrid: number, level: number,
): { x: number[]; y: number[] }[] {
  // Crossing point on a grid edge, keyed by a stable edge id so segments from neighbouring cells
  // that share the edge reference the exact same point and link up.
  const pointOf = new Map<string, [number, number]>();
  const at = (i: number, j: number) => z[i * ngrid + j];
  const cross = (
    id: string, ax: number, ay: number, bx: number, by: number, a: number, b: number,
  ): string => {
    if (!pointOf.has(id)) {
      const t = (level - a) / (b - a);
      pointOf.set(id, [ax + t * (bx - ax), ay + t * (by - ay)]);
    }
    return id;
  };
  const segments: [string, string][] = [];
  for (let i = 0; i < ngrid - 1; i++) {
    for (let j = 0; j < ngrid - 1; j++) {
      const c00 = at(i, j), c10 = at(i + 1, j), c11 = at(i + 1, j + 1), c01 = at(i, j + 1);
      const idx = (c00 > level ? 1 : 0) | (c10 > level ? 2 : 0) | (c11 > level ? 4 : 0) | (c01 > level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      // Edge crossings — B(bottom), R(right), T(top), L(left).
      const B = () => cross(`h_${i}_${j}`, gx[i], gy[j], gx[i + 1], gy[j], c00, c10);
      const R = () => cross(`v_${i + 1}_${j}`, gx[i + 1], gy[j], gx[i + 1], gy[j + 1], c10, c11);
      const T = () => cross(`h_${i}_${j + 1}`, gx[i], gy[j + 1], gx[i + 1], gy[j + 1], c01, c11);
      const L = () => cross(`v_${i}_${j}`, gx[i], gy[j], gx[i], gy[j + 1], c00, c01);
      const center = (c00 + c10 + c11 + c01) / 4;
      const push = (pairs: [() => string, () => string][]) => {
        for (const [p, q] of pairs) segments.push([p(), q()]);
      };
      switch (idx) {
        case 1: case 14: push([[L, B]]); break;
        case 2: case 13: push([[B, R]]); break;
        case 3: case 12: push([[L, R]]); break;
        case 4: case 11: push([[R, T]]); break;
        case 6: case 9: push([[B, T]]); break;
        case 7: case 8: push([[L, T]]); break;
        case 5: push(center > level ? [[L, T], [B, R]] : [[L, B], [R, T]]); break;
        case 10: push(center > level ? [[L, B], [R, T]] : [[B, R], [L, T]]); break;
      }
    }
  }
  // Link segments end-to-end into polylines by shared edge id.
  const adj = new Map<string, { seg: number; other: string }[]>();
  segments.forEach((s, k) => {
    for (const [a, b] of [[s[0], s[1]], [s[1], s[0]]] as [string, string][]) {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a)!.push({ seg: k, other: b });
    }
  });
  const used = new Array(segments.length).fill(false);
  const nextUnused = (id: string) => adj.get(id)?.find((e) => !used[e.seg]);
  const polylines: { x: number[]; y: number[] }[] = [];
  for (let k = 0; k < segments.length; k++) {
    if (used[k]) continue;
    used[k] = true;
    const ids = [segments[k][0], segments[k][1]];
    for (let cur = ids[ids.length - 1], nb = nextUnused(cur); nb; nb = nextUnused(cur)) {
      used[nb.seg] = true; cur = nb.other; ids.push(cur);
    }
    for (let cur = ids[0], nb = nextUnused(cur); nb; nb = nextUnused(cur)) {
      used[nb.seg] = true; cur = nb.other; ids.unshift(cur);
    }
    const x = ids.map((id) => Math.round(pointOf.get(id)![0] * 1000) / 1000);
    const y = ids.map((id) => Math.round(pointOf.get(id)![1] * 1000) / 1000);
    polylines.push({ x, y });
  }
  return polylines;
}

/**
 * 2-D KDE iso-density contour polylines over (x,y) for the Division biplot overlay. Mirrors
 * GateLabR app.R:4104-4120 (MASS::kde2d then grDevices::contourLines): filter to finite pairs,
 * estimate a density surface on a ~64x64 grid spanning `xRange` x `yRange`, then trace contours at
 * 5 levels between 10% and 90% of peak density. Returns [] if too few points or a flat surface.
 */
/** R-style pretty() interior levels strictly between lo and hi (~n intervals). */
function prettyLevels(lo: number, hi: number, n: number): number[] {
  if (!(hi > lo) || n < 1) return [];
  const rawStep = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  const start = Math.ceil(lo / step) * step;
  for (let v = start; v < hi - 1e-9; v += step) if (v > lo) out.push(v);
  return out;
}

export function computeDivisionContours(
  bx: ArrayLike<number>, by: ArrayLike<number>, xRange: [number, number], yRange: [number, number],
  ngrid = 60, // R uses ngrid = 60
): { x: number[]; y: number[] }[] {
  const xs: number[] = [];
  const ys: number[] = [];
  const n = Math.min(bx.length, by.length);
  for (let i = 0; i < n; i++) {
    const x = bx[i], y = by[i];
    if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x as number); ys.push(y as number); }
  }
  if (xs.length < 20) return [];
  if (!(xRange[1] > xRange[0]) || !(yRange[1] > yRange[0])) return [];
  const { gx, gy, z, zmax } = kde2d(xs, ys, xRange, yRange, ngrid);
  if (!(zmax > 0)) return [];
  const contours: { x: number[]; y: number[] }[] = [];
  // R-'pretty' ~8 levels over the z range, dropping the near-zero background (<= 2% of the peak),
  // matching app.R:4104-4120 instead of a fixed 5 fractional levels.
  const levels = prettyLevels(0, zmax, 8).filter((lv) => lv > zmax * 0.02);
  for (const lv of levels) {
    for (const poly of marchingSquares(gx, gy, z, ngrid, lv)) contours.push(poly);
  }
  return contours;
}

/**
 * Seed N division boundaries (port of seed_division_boundaries, workspace.R:144-176). Models dye
 * dilution as evenly-spaced peaks: find the brightest prominent KDE peak p0 and the median peak gap;
 * place boundaries in the valleys below p0. Returns sorted-ascending. The user drags afterwards.
 */
export function seedDivisionBoundaries(rawValues: ArrayLike<number>, n: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < rawValues.length; i++) if (Number.isFinite(rawValues[i])) values.push(rawValues[i] as number);
  n = Math.floor(n);
  if (values.length < 10 || n < 1) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const lo = quantile(sorted, 0.01);
  const hi = quantile(sorted, 0.99);
  const span = hi - lo;
  let p0 = hi;
  let detected = NaN;
  if (Number.isFinite(span) && span > 0) {
    const dmin = sorted[0];
    const dmax = sorted[sorted.length - 1];
    const bw = nrd0(sorted) || span / 20;
    const { x: gx, y: dy } = kde(values, bw, dmin - 3 * bw, dmax + 3 * bw);
    const peaksX: number[] = [];
    const peaksY: number[] = [];
    const ymax = Math.max(...dy);
    for (let i = 1; i < dy.length - 1; i++) {
      if (dy[i] > dy[i - 1] && dy[i] > dy[i + 1] && dy[i] >= 0.05 * ymax) { peaksX.push(gx[i]); peaksY.push(dy[i]); }
    }
    if (peaksX.length) p0 = Math.max(...peaksX);
    if (peaksX.length >= 2) {
      const px = [...peaksX].sort((a, b) => a - b);
      const gaps = px.slice(1).map((v, i) => v - px[i]).filter((g) => g > 0.04 * span);
      if (gaps.length) { gaps.sort((a, b) => a - b); detected = quantile(gaps, 0.5); }
    }
  }
  if (!(Number.isFinite(span) && span > 0)) {
    return Array.from({ length: n }, (_, i) => p0 - 0.5 * (i + 1 - 0.5)).sort((a, b) => a - b);
  }
  let fitSp = (p0 - lo) / n;
  if (!(Number.isFinite(fitSp) && fitSp > 0)) fitSp = span / (n + 2);
  const spacing = Number.isFinite(detected) && detected > 0 && detected <= fitSp ? detected : fitSp;
  return Array.from({ length: n }, (_, i) => p0 - spacing * (i + 1 - 0.5)).sort((a, b) => a - b);
}

/**
 * Re-space the EXISTING boundaries uniformly (Space-evenly button) — port of app.R:3889-3900:
 * anchor at the brightest boundary (max), step = median inter-gate gap (fallback (max-min)/(n-1)),
 * emit anchor - step*(0..n-1). Needs >= 2 boundaries; the caller reseeds otherwise.
 */
export function spaceEvenly(boundaries: number[]): number[] {
  const b = [...boundaries].sort((x, y) => x - y);
  if (b.length < 2) return b;
  const anchor = b[b.length - 1];
  const diffs = b.slice(1).map((v, i) => v - b[i]);
  diffs.sort((x, y) => x - y);
  let sp = quantile(diffs, 0.5);
  if (!(Number.isFinite(sp) && sp > 0)) sp = (b[b.length - 1] - b[0]) / (b.length - 1);
  return Array.from({ length: b.length }, (_, i) => anchor - sp * i).sort((x, y) => x - y);
}

/**
 * Grow/shrink an existing boundary set to `target` count IN PLACE — port of the change-N logic
 * (app.R:3859-3886): keep the manual fits, extend at the dim (low) end using the median inter-gate
 * gap (fallback span/(target+2)), drop the dimmest boundary when shrinking. Reseeds (via
 * seedFallback) only when there are no boundaries yet.
 */
export function resizeBoundaries(prev: number[], target: number, seedFallback: () => number[]): number[] {
  target = Math.max(0, Math.floor(target));
  if (prev.length === 0) return seedFallback();
  if (target === 0) return [];
  const b = [...prev].sort((x, y) => x - y);
  if (b.length === target) return b;
  let gap = NaN;
  if (b.length >= 2) {
    const diffs = b.slice(1).map((v, i) => v - b[i]).filter((d) => d > 0);
    if (diffs.length) { diffs.sort((x, y) => x - y); gap = quantile(diffs, 0.5); }
  }
  if (!(Number.isFinite(gap) && gap > 0)) {
    const span = b[b.length - 1] - b[0];
    gap = span > 0 ? span / (target + 2) : 1;
  }
  while (b.length < target) b.unshift(b[0] - gap); // prepend a new dimmest boundary
  while (b.length > target) b.shift(); // drop the dimmest
  return b;
}

export interface DivisionPayloadOpts {
  dyeValues: ArrayLike<number>; // subsampled display-space dye values (histogram)
  xLabel: string;
  xRange: [number, number];
  bins: number;
  boundaries: number[];
  seq: number;
  biplotDye?: Float32Array | number[];
  markerValues?: Float32Array | number[];
  yLabel?: string;
  yRange?: [number, number];
  pointAlpha?: number;
}

/** Assemble the object for window.DivisionD3.render (port of send_division_plot). */
export function buildDivisionPayload(o: DivisionPayloadOpts): Record<string, unknown> {
  const nLevels = o.boundaries.length + 1;
  const payload: Record<string, unknown> = {
    x: Array.from(o.dyeValues),
    x_label: o.xLabel,
    x_range: o.xRange,
    bins: o.bins,
    boundaries: [...o.boundaries].sort((a, b) => a - b),
    palette: divisionPalette(nLevels),
    bin_labels: Array.from({ length: nLevels }, (_, i) => `Div${i}`),
    point_alpha: o.pointAlpha ?? 0.4,
    _div_seq: o.seq,
  };
  if (o.biplotDye && o.markerValues) {
    payload.bx_b64 = encodeFloat32Base64(o.biplotDye instanceof Float32Array ? o.biplotDye : Float32Array.from(o.biplotDye));
    payload.y_b64 = encodeFloat32Base64(o.markerValues instanceof Float32Array ? o.markerValues : Float32Array.from(o.markerValues));
    payload.y_label = o.yLabel ?? "marker";
    const yRange = o.yRange ?? computeAxisRange(o.markerValues);
    if (o.yRange) payload.y_range = o.yRange;
    // 2-D KDE iso-density contour overlay (app.R:4104-4120).
    const contours = computeDivisionContours(o.biplotDye, o.markerValues, o.xRange, yRange);
    if (contours.length) payload.contours = contours;
  }
  return payload;
}
