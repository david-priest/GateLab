// fitGate.ts — a gate fitted to the events it holds.
//
// Asked for from a gate's right-click menu: the boundary is redrawn around the gate's own events
// on the plotted population, as tight as the settings say. The densest events are kept (a share
// of them, by a histogram over the gate's events), the boundary wraps them with a margin, and
// the gate keeps its kind: a polygon becomes the convex hull of the kept events, a rectangle
// their bounding box, an ellipse their covariance ellipse scaled to hold them. The kept events
// are chosen in DISPLAY space, where "dense" and "convex" mean what the user sees; a polygon's or
// rectangle's vertices are then mapped into the gate's own space, and an ellipse's mean and
// covariance are taken from the kept events' coordinates in that space directly, so the fitted
// gate evaluates exactly where it is drawn.

import { getGateMask } from "./gates";
import type { EllipseGate, Gate, PolyRectGate, Vertex } from "./models";
import type { Sample } from "./sample";

export interface FitGateSettings {
  /** Share of the gate's events the fit wraps, by density: 1 wraps every one of them. */
  keep: number;
  /** How far past the kept events the boundary sits, as a share of its own size. */
  margin: number;
  /** Polygons only: the most vertices the fitted polygon keeps. */
  maxVertices: number;
}

export const FIT_GATE_DEFAULTS: Readonly<FitGateSettings> = { keep: 0.98, margin: 0.03, maxVertices: 24 };
/** How far past an axis's floor a pile of events there takes the boundary, as a share of the axis's range. */
export const FLOOR_SPILL = 0.05;
export const FIT_GATE_RANGES = {
  keep: { min: 0.5, max: 1 },
  margin: { min: 0, max: 0.3 },
  maxVertices: { min: 3, max: 48 },
} as const;

export function clampFitSettings(s: FitGateSettings): FitGateSettings {
  const clamp = (v: number, lo: number, hi: number, fallback: number) =>
    Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
  return {
    keep: clamp(s.keep, FIT_GATE_RANGES.keep.min, FIT_GATE_RANGES.keep.max, FIT_GATE_DEFAULTS.keep),
    margin: clamp(s.margin, FIT_GATE_RANGES.margin.min, FIT_GATE_RANGES.margin.max, FIT_GATE_DEFAULTS.margin),
    maxVertices: Math.round(clamp(s.maxVertices, FIT_GATE_RANGES.maxVertices.min, FIT_GATE_RANGES.maxVertices.max, FIT_GATE_DEFAULTS.maxVertices)),
  };
}

/**
 * The densest `keep` of the given events: a histogram over their extent, its bins taken from
 * the fullest down until they hold at least `keep` of the events, and every event in a taken
 * bin kept. With keep = 1 every event is kept. The bin count follows the event count, so a
 * small population is not cut by a grid finer than its own scatter.
 */
export function densestEvents(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  indices: ArrayLike<number>,
  keep: number,
): number[] {
  const n = indices.length;
  if (n === 0) return [];
  if (!(keep < 1)) return Array.from(indices);
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (let k = 0; k < n; k++) {
    const i = indices[k];
    const vx = x[i], vy = y[i];
    if (vx < xMin) xMin = vx;
    if (vx > xMax) xMax = vx;
    if (vy < yMin) yMin = vy;
    if (vy > yMax) yMax = vy;
  }
  if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) return Array.from(indices);
  const bins = Math.max(12, Math.min(96, Math.round(Math.sqrt(n) / 4)));
  const xSpan = xMax > xMin ? xMax - xMin : 1;
  const ySpan = yMax > yMin ? yMax - yMin : 1;
  const binOf = new Int32Array(n);
  const counts = new Int32Array(bins * bins);
  for (let k = 0; k < n; k++) {
    const i = indices[k];
    const bx = Math.min(bins - 1, Math.floor(((x[i] - xMin) / xSpan) * bins));
    const by = Math.min(bins - 1, Math.floor(((y[i] - yMin) / ySpan) * bins));
    const b = by * bins + bx;
    binOf[k] = b;
    counts[b]++;
  }
  const order: number[] = [];
  for (let b = 0; b < counts.length; b++) if (counts[b] > 0) order.push(b);
  order.sort((a, b) => counts[b] - counts[a] || a - b);
  const taken = new Uint8Array(counts.length);
  let held = 0;
  const target = keep * n;
  for (const b of order) {
    if (held >= target) break;
    taken[b] = 1;
    held += counts[b];
  }
  const out: number[] = [];
  for (let k = 0; k < n; k++) if (taken[binOf[k]]) out.push(indices[k]);
  return out;
}

/** The convex hull of the points, counter-clockwise, with no three collinear (monotone chain). */
export function convexHull(points: Vertex[]): Vertex[] {
  const pts = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 3) return pts.slice();
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Vertex, a: Vertex, b: Vertex) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vertex[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vertex[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * The hull with at most `maxVertices` vertices: the vertex whose removal loses the least area
 * (the triangle it makes with its neighbours) goes first, until the count fits.
 */
export function simplifyConvex(hull: Vertex[], maxVertices: number): Vertex[] {
  const out = hull.slice();
  const limit = Math.max(3, Math.round(maxVertices));
  const area = (a: Vertex, b: Vertex, c: Vertex) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  while (out.length > limit) {
    let worst = -1, least = Infinity;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length], c = out[(i + 1) % out.length];
      const lost = area(a, out[i], c);
      if (lost < least) { least = lost; worst = i; }
    }
    out.splice(worst, 1);
  }
  return out;
}

/** The points scaled about a centre by a factor: the margin, applied the same on every side. */
export function scaleAbout(points: Vertex[], centre: Vertex, factor: number): Vertex[] {
  return points.map(([px, py]) => [centre[0] + (px - centre[0]) * factor, centre[1] + (py - centre[1]) * factor]);
}

function centroid(x: ArrayLike<number>, y: ArrayLike<number>, kept: ArrayLike<number>): Vertex {
  let sx = 0, sy = 0;
  for (let k = 0; k < kept.length; k++) { sx += x[kept[k]]; sy += y[kept[k]]; }
  return [sx / kept.length, sy / kept.length];
}

/**
 * Where kept events sit on an axis's floor (the data's lowest value, which on a mass cytometry
 * axis is the pile of zero counts on the axis line), the boundary is taken out past the floor by
 * `pad`, as a hand-drawn gate is, so it does not run through the pile. Returned as points for the
 * hull or the box to include: the pile's extent on the other axis, set `pad` past the floor.
 */
export function floorSpillPoints(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  kept: ArrayLike<number>,
  floor: { x: number | null; y: number | null },
  pad: { x: number; y: number },
): Vertex[] {
  const out: Vertex[] = [];
  const n = kept.length;
  if (n === 0) return out;
  const spill = (axis: "x" | "y") => {
    const f = floor[axis];
    if (f === null || !Number.isFinite(f) || !(pad[axis] > 0)) return;
    const along = axis === "x" ? x : y, across = axis === "x" ? y : x;
    const eps = 1e-6 * Math.max(1, Math.abs(f));
    let count = 0, lo = Infinity, hi = -Infinity;
    for (let k = 0; k < n; k++) {
      const i = kept[k];
      if (along[i] <= f + eps) { count++; const v = across[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    // A pile, not a stray: one in a hundred of the kept events, at least ten.
    if (count < Math.max(10, 0.01 * n)) return;
    const at = f - pad[axis];
    out.push(axis === "x" ? [at, lo] : [lo, at], axis === "x" ? [at, hi] : [hi, at]);
  };
  spill("x");
  spill("y");
  return out;
}

/**
 * A convex polygon around the kept events (and any extra points), in the space of x and y.
 * Null below three events.
 */
export function fitPolygonBoundary(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  kept: ArrayLike<number>,
  settings: FitGateSettings,
  extra: Vertex[] = [],
): Vertex[] | null {
  if (kept.length < 3) return null;
  const pts: Vertex[] = [];
  for (let k = 0; k < kept.length; k++) pts.push([x[kept[k]], y[kept[k]]]);
  for (const p of extra) pts.push(p);
  const hull = simplifyConvex(convexHull(pts), settings.maxVertices);
  if (hull.length < 3) return null;
  return scaleAbout(hull, centroid(x, y, kept), 1 + settings.margin);
}

/**
 * The kept events' bounding box, with the margin, as the rectangle's corners in the order the
 * gate holds them: each of the gate's vertices is matched to its corner (low or high on each
 * axis) so the handles keep their places.
 */
export function fitRectangleBoundary(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  kept: ArrayLike<number>,
  settings: FitGateSettings,
  template: Vertex[],
  extra: Vertex[] = [],
): Vertex[] | null {
  if (kept.length < 1 || template.length < 2) return null;
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  const take = (vx: number, vy: number) => {
    if (vx < xMin) xMin = vx;
    if (vx > xMax) xMax = vx;
    if (vy < yMin) yMin = vy;
    if (vy > yMax) yMax = vy;
  };
  for (let k = 0; k < kept.length; k++) take(x[kept[k]], y[kept[k]]);
  for (const [vx, vy] of extra) take(vx, vy);
  const f = 1 + settings.margin;
  const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2;
  const lo: Vertex = [cx + (xMin - cx) * f, cy + (yMin - cy) * f];
  const hi: Vertex = [cx + (xMax - cx) * f, cy + (yMax - cy) * f];
  const tx = template.map((v) => v[0]), ty = template.map((v) => v[1]);
  const midX = (Math.min(...tx) + Math.max(...tx)) / 2, midY = (Math.min(...ty) + Math.max(...ty)) / 2;
  return template.map(([vx, vy]) => [vx > midX ? hi[0] : lo[0], vy > midY ? hi[1] : lo[1]]);
}

/**
 * The kept events' covariance ellipse, scaled so its boundary at `distanceSquare` holds every
 * kept event, then by the margin. Null when the events do not span two dimensions.
 */
export function fitEllipseParameters(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  kept: ArrayLike<number>,
  settings: FitGateSettings,
  distanceSquare: number,
): { mean: [number, number]; covariance: [[number, number], [number, number]] } | null {
  const n = kept.length;
  if (n < 3 || !(distanceSquare > 0)) return null;
  const [mx, my] = centroid(x, y, kept);
  let sxx = 0, sxy = 0, syy = 0;
  for (let k = 0; k < n; k++) {
    const dx = x[kept[k]] - mx, dy = y[kept[k]] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  sxx /= n; sxy /= n; syy /= n;
  const det = sxx * syy - sxy * sxy;
  if (!(det > 0) || !Number.isFinite(det)) return null;
  // The largest Mahalanobis distance among the kept events sets the boundary.
  let m2 = 0;
  for (let k = 0; k < n; k++) {
    const dx = x[kept[k]] - mx, dy = y[kept[k]] - my;
    const d2 = (syy * dx * dx - 2 * sxy * dx * dy + sxx * dy * dy) / det;
    if (d2 > m2) m2 = d2;
  }
  if (!(m2 > 0)) return null;
  const s = (m2 / distanceSquare) * (1 + settings.margin) * (1 + settings.margin);
  return { mean: [mx, my], covariance: [[sxx * s, sxy * s], [sxy * s, syy * s]] };
}

export interface FitGateResult {
  /** The gate with its fitted boundary; its id, name, colour, label and space are unchanged. */
  gate: Gate;
  /** Events of the population inside the fitted gate. */
  held: number;
  /** Events of the population inside the gate as it was. */
  before: number;
  /** Events of the population. */
  population: number;
}

/**
 * The gate fitted to its events on `sample`, within `populationMask` (null: every event).
 * Null for a quadrant gate, or when there are too few events to fit.
 */
export function fitGateToEvents(
  gate: Gate,
  sample: Sample,
  populationMask: Uint8Array | null,
  settings: FitGateSettings,
): FitGateResult | null {
  if (gate.gate_type === "quadrant") return null;
  const s = clampFitSettings(settings);
  const xIdx = sample.index(gate.x_channel);
  const yIdx = sample.index(gate.y_channel);
  if (xIdx === undefined || yIdx === undefined) return null;
  const data = sample.gatingDataFor(gate);
  const inGate = getGateMask(gate, data);
  const indices: number[] = [];
  let population = 0;
  for (let i = 0; i < inGate.length; i++) {
    if (populationMask && !populationMask[i]) continue;
    population++;
    if (inGate[i]) indices.push(i);
  }
  const before = indices.length;
  if (before < 3) return null;
  const dx = sample.displayColumn(xIdx);
  const dy = sample.displayColumn(yIdx);
  const kept = densestEvents(dx, dy, indices, s.keep);
  // The data's floor on each axis, and how far past it a pile there takes the boundary: a
  // twentieth of the axis's range, about where a hand-drawn gate's edge sits below zero.
  const floorOf = (col: Float32Array) => { let m = Infinity; for (let i = 0; i < col.length; i++) if (col[i] < m) m = col[i]; return Number.isFinite(m) ? m : null; };
  const span = (r: [number, number]) => (r[1] > r[0] ? r[1] - r[0] : 0);
  const spill = floorSpillPoints(dx, dy, kept, { x: floorOf(dx), y: floorOf(dy) }, {
    x: FLOOR_SPILL * span(sample.displayRange(xIdx)),
    y: FLOOR_SPILL * span(sample.displayRange(yIdx)),
  });
  let fitted: Gate | null = null;
  if (gate.gate_type === "ellipse") {
    const gx = data.column(gate.x_channel), gy = data.column(gate.y_channel);
    if (!gx || !gy) return null;
    const params = fitEllipseParameters(gx, gy, kept, s, gate.distance_square);
    if (params) fitted = { ...gate, mean: params.mean, covariance: params.covariance } satisfies EllipseGate;
  } else {
    const boundary = gate.gate_type === "rectangle"
      ? fitRectangleBoundary(dx, dy, kept, s, gate.vertices, spill)
      : fitPolygonBoundary(dx, dy, kept, s, spill);
    if (boundary) {
      const vertices: Vertex[] = boundary.map(([vx, vy]) => [
        sample.displayToGate(gate, gate.x_channel, vx),
        sample.displayToGate(gate, gate.y_channel, vy),
      ]);
      if (vertices.every((v) => Number.isFinite(v[0]) && Number.isFinite(v[1]))) {
        fitted = { ...gate, vertices } satisfies PolyRectGate;
      }
    }
  }
  if (!fitted) return null;
  const after = getGateMask(fitted, data);
  let held = 0;
  for (let i = 0; i < after.length; i++) if (after[i] && (!populationMask || populationMask[i])) held++;
  return { gate: fitted, held, before, population };
}
