// gates.ts — per-event boolean masks for polygon / rectangle / quadrant gates.
// Ported from GateLabR inst/app/R/gate_engine.R (gate_mask_* + get_gate_mask).
// Masks are Uint8Array (1 = in-gate, 0 = out) over display-space channel columns.

import { UNBOUNDED, type EllipseGate, type Gate, type QuadrantCurl, type RectangleBounds, type Vertex } from "./models";
import { ellipseQuadraticForm } from "./ellipse";

/** Column accessor for the currently-displayed (transformed) assay data. */
export interface AssayData {
  n: number;
  column(channel: string): ArrayLike<number> | undefined;
}

/**
 * Columns resolved PER GATE, because a workspace can hold gates in different coordinate spaces
 * and each must be evaluated in its own. Passing one AssayData for every gate is what made a
 * display-space gate report zero events: its arcsinh vertices were tested against raw values.
 */
export interface GateAssayData {
  n: number;
  forGate(gate: Gate): AssayData;
}

/** Accepts either form: a plain AssayData means "the same columns for every gate". */
export function columnsForGate(data: AssayData | GateAssayData, gate: Gate): AssayData {
  return "forGate" in data ? data.forGate(gate) : data;
}

// ---------------------------------------------------------------------------
// Point-in-polygon (inside OR on boundary, matching sp::point.in.polygon >= 1)
//
// Gating-ML 2.0 section 5.2.1: "The events in the interior of the polygon and the events on the
// boundary are considered to be in the gate". Two widely used implementations do not follow it:
//   - FlowKit's polygon test (flowutils 1.2.2 points_in_polygon) keeps an event on a left or lower
//     edge and drops one on a right or upper edge, whatever its docstring says (measured on
//     synthetic points with FlowKit 1.3.1).
//   - cytolib's in_polygon, which flowCore's polygonGate and CytoML's re-gating of a FlowJo
//     workspace both call, keeps an event on a sloping or vertical edge but not every event on
//     a horizontal one. An event at the polygon's greatest y is kept only if it lies on the edge
//     from the first vertex to the second, so whether the top edge holds its events depends on
//     vertex order; and an event on any other horizontal edge with the inside of the polygon
//     below it is dropped (read from cytolib src/in_polygon.cpp and measured with flowCore
//     2.16.0 on synthetic points, 2026-09-24: a square listed from (0, 0) drops its 11 top-edge
//     events, the same square listed from its top edge keeps them).
// Either can therefore differ from GateLab by the events lying exactly on those edges.
// ---------------------------------------------------------------------------

/** The least magnitude, per axis, at which a polygon is tested in its own units (polygonTestScale). */
const POLYGON_TEST_UNIT = 1 / 16;

/**
 * Per axis, the power of two a polygon's vertices and the events tested against it are multiplied
 * by before the boundary test: 1 wherever the vertices reach 1/16 in magnitude on that axis, or one
 * event in a hundred does, as they do on every scale GateLab draws on, and otherwise the least power
 * of two that brings the vertices there. Multiplying by a power of two rounds nothing, so the test
 * is the same test, but for its tolerances.
 *
 * The test holds an event within 1e-9 of an edge, a distance in the gate's own units, which assumes
 * those units are not small. Single precision, in which GateLab holds each event's value in a gate's
 * space (Sample.pinnedColumn), separates values of 1/16 by 7.5e-9, so there an event within 1e-9 of
 * an edge lies on it; at 1e-4 by 7e-12, so 1e-9 reaches across a hundred values. A fasinh with a
 * small M is such a scale, held as GateLab's asinh through v → v (M + A) ln 10 − A ln 10, and so is
 * one whose T lies far above the data: at M = 1e-4 a FlowKit-written polygon on the public PBMC file
 * held 136 events FlowKit leaves out, at M = 1e-9 its whole bounding box, and at T = 1e12 with M = 1,
 * 12,405 events too many.
 *
 * The events count because a polygon can be small on an axis whose events are not, and there the
 * tolerance is what GateLab has always held: a strip along a FlowJo log floor, whose events beyond
 * a nearly flat edge's end GateLab holds within 1e-9 of it, and whose export follows that. One in a
 * hundred rather than any, since a few events far out do not make the scale wider where the polygon
 * is: at M = 0.01, 2 of the public PBMC file's 121,000 PE-Cy7-A events reach 1/16. The events are
 * all those the caller tests; one that evaluates part of a gate's events passes the scale of the
 * whole (gateMaskPolygon's `scale`). A vertex or value at 1e14 or beyond, a skirt's, does not count,
 * as it does not for the bands below, nor does one that is not finite.
 */
export function polygonTestScale(
  vertices: readonly (readonly [number, number])[],
  xVals?: ArrayLike<number>,
  yVals?: ArrayLike<number>,
): [number, number] {
  const scale = (k: 0 | 1, vals: ArrayLike<number> | undefined): number => {
    let s = 0;
    for (const v of vertices) {
      const a = Math.abs(v[k]);
      if (a < 1e14 && a > s) s = a;
    }
    if (!(s > 0) || s >= POLYGON_TEST_UNIT) return 1;
    if (vals) {
      const need = Math.max(1, Math.ceil(vals.length / 100));
      let reach = 0;
      for (let i = 0; i < vals.length; i++) {
        const a = Math.abs(vals[i]);
        if (a >= POLYGON_TEST_UNIT && a < 1e14 && ++reach >= need) return 1;
      }
    }
    let f = 1;
    while (s * f < POLYGON_TEST_UNIT && f < 2 ** 1000) f *= 2;
    return f;
  };
  return [scale(0, xVals), scale(1, yVals)];
}

function onSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): boolean {
  // A zero-length edge (a repeated vertex) holds its one point and no other, as gateMaskPolygon
  // reads it. Measured as one of length 1, it held every point: cross and dot are both zero.
  if (ax === bx && ay === by) return px === ax && py === ay;
  const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const segLen = Math.hypot(bx - ax, by - ay) || 1;
  if (Math.abs(cross) > 1e-9 * segLen) return false;
  const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
  const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
  return dot >= -1e-12 && dot <= len2 + 1e-12;
}

/** Boundary-inclusive point-in-polygon (crossing number + edge test), at polygonTestScale. */
export function pointInPolygon(px0: number, py0: number, vx0: number[], vy0: number[]): boolean {
  const [fx, fy] = polygonTestScale(vx0.map((x, i) => [x, vy0[i]] as [number, number]), [px0], [py0]);
  const [px, py] = [px0 * fx, py0 * fy];
  const vx = vx0.map((v) => v * fx);
  const vy = vy0.map((v) => v * fy);
  const n = vx.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (onSegment(px, py, vx[j], vy[j], vx[i], vy[i])) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = vy[i];
    const yj = vy[j];
    if (yi > py !== yj > py) {
      const xCross = ((vx[j] - vx[i]) * (py - yi)) / (yj - yi) + vx[i];
      if (px < xCross) inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

export function gateMaskPolygon(
  xVals: ArrayLike<number>,
  yVals: ArrayLike<number>,
  given: Vertex[],
  /**
   * polygonTestScale of the gate on all of its events, for a caller that tests some of them, as
   * the exporter does to model GateLab's decision; by default, of these events.
   */
  scale?: readonly [number, number],
): Uint8Array {
  const n = xVals.length;
  const out = new Uint8Array(n);
  if (given.length === 0) return out;
  // Tested at the polygon's own magnitude on each axis where it and its events are small
  // (polygonTestScale), which is 1 for nearly every polygon.
  const [fx, fy] = scale ?? polygonTestScale(given, xVals, yVals);
  const vertices: Vertex[] = fx === 1 && fy === 1 ? given : given.map(([x, y]) => [x * fx, y * fy]);

  // Compile polygon geometry once. The previous implementation called pointInPolygon
  // for every event, which recalculated edge lengths with Math.hypot and traversed all
  // edges twice. On multi-million-event FCS files that dominated GatingML import time.
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  const edges = vertices.map(([bx, by], i) => {
    const [ax, ay] = vertices[(i + vertices.length - 1) % vertices.length];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (ax < xMin) xMin = ax;
    if (ax > xMax) xMax = ax;
    if (ay < yMin) yMin = ay;
    if (ay > yMax) yMax = ay;
    return {
      ax, ay, bx, by, dx, dy, len2,
      boundaryTolerance: 1e-9 * (Math.sqrt(len2) || 1),
    };
  });

  // Horizontal bands over the vertices' extent, each listing the edges an event in it can meet:
  // an edge it can cross, or lie on within the boundary tolerance. A polygon exported to be exact
  // in raw space carries thousands of short edges (a biex polygon is split at every table entry
  // it crosses), and testing every event against every edge made gating such a re-imported gate
  // twenty times slower. Which edges are tested changes nothing else: an event's result is the
  // parity of the edges it crosses, or inside if it lies on any, whatever their order, and every
  // edge that can do either is in its band. A small polygon keeps the single band it always had.
  const B = edges.length > 64 ? Math.min(1024, edges.length >> 2) : 1;
  const finite = (v: number) => Math.abs(v) < 1e14;
  let bLo = Infinity, bHi = -Infinity;
  for (const e of edges) {
    if (finite(e.ay)) { bLo = Math.min(bLo, e.ay); bHi = Math.max(bHi, e.ay); }
  }
  if (!(bHi > bLo)) { bLo = yMin; bHi = yMax; }
  const bandW = (bHi - bLo) / B;
  // Band 0 is below bLo and band B + 1 at or above bHi, where a skirt's far vertices lie.
  const bandOf = (v: number): number =>
    B === 1 || !(bandW > 0) ? 1 : v < bLo ? 0 : v >= bHi ? B + 1 : 1 + Math.min(B - 1, Math.floor((v - bLo) / bandW));
  const bands: (typeof edges)[] = Array.from({ length: B + 2 }, () => []);
  for (const e of edges) {
    // Padded well past the boundary tolerance, which is a distance of 1e-9 from the edge's line.
    const pad = 1e-6 * (1 + Math.abs(e.ay) + Math.abs(e.by));
    const k0 = bandOf(Math.min(e.ay, e.by) - pad);
    const k1 = bandOf(Math.max(e.ay, e.by) + pad);
    for (let k = k0; k <= k1; k++) bands[k].push(e);
  }

  for (let i = 0; i < n; i++) {
    const px = xVals[i] * fx;
    const py = yVals[i] * fy;
    if (px < xMin || px > xMax || py < yMin || py > yMax) continue;
    // NaN fails every test below, so it is outside, as it always was.
    if (py !== py) continue;

    let inside = false;
    for (const edge of bands[bandOf(py)]) {
      // A zero-length edge — a repeated vertex — has no direction, so nothing can lie *along* it
      // and it cannot be crossed. It must be skipped, not evaluated: with dx = dy = 0 both the
      // cross product and the dot product are identically zero for EVERY point, so
      // |cross| <= tolerance and dot <= len2 + 1e-12 both held for every event and the
      // on-boundary branch marked the whole BOUNDING BOX inside. One biex polygon went from 790
      // events to 899, which is precisely its bounding-box count.
      //
      // Repeated vertices are routine, not exotic: polygonOutline closes its ring by repeating
      // the first vertex, so every densified polygon GateLab exports carries one, and Gating-ML
      // written elsewhere often closes rings explicitly too. The crossing test below is already
      // inert for such an edge (ay === by), so only the boundary test needed the guard.
      //
      // The edge still holds its one point, the vertex itself, as every edge holds its own points.
      // That changes nothing where the vertex lies on another edge too, which is every polygon
      // but one whose vertices all coincide; that one holds the point, which is what the closed
      // integer test of FlowJo's grid (flowjoGrid.ts) does with a polygon all on one channel.
      if (edge.len2 > 0) {
        const cross = edge.dx * (py - edge.ay) - edge.dy * (px - edge.ax);
        if (Math.abs(cross) <= edge.boundaryTolerance) {
          const dot = (px - edge.ax) * edge.dx + (py - edge.ay) * edge.dy;
          if (dot >= -1e-12 && dot <= edge.len2 + 1e-12) {
            inside = true;
            break;
          }
        }
      } else if (px === edge.ax && py === edge.ay) {
        inside = true;
        break;
      }

      if ((edge.ay > py) !== (edge.by > py)) {
        const xCross = edge.ax + ((py - edge.ay) * edge.dx) / edge.dy;
        if (px < xCross) inside = !inside;
      }
    }
    out[i] = inside ? 1 : 0;
  }
  return out;
}

/**
 * Ellipse membership: (p−μ)ᵀ Σ⁻¹ (p−μ) ≤ D², boundary-inclusive as Gating-ML 2.0 defines it
 * (section 5.3.1) — the quadratic form at the boundary equals D² exactly, and ≤ keeps it inside.
 * A degenerate covariance admits no interior (ellipseQuadraticForm returns valid: false), so a
 * malformed file selects nothing rather than everything.
 */
export function gateMaskEllipse(
  xVals: ArrayLike<number>,
  yVals: ArrayLike<number>,
  gate: EllipseGate,
): Uint8Array {
  const n = xVals.length;
  const out = new Uint8Array(n);
  const { ia, ib, ic, valid } = ellipseQuadraticForm(gate);
  if (!valid) return out;
  const [mx, my] = gate.mean;
  const d2 = gate.distance_square;
  if (!(d2 > 0)) return out;
  for (let i = 0; i < n; i++) {
    const dx = xVals[i] - mx;
    const dy = yVals[i] - my;
    if (ia * dx * dx + 2 * ib * dx * dy + ic * dy * dy <= d2) out[i] = 1;
  }
  return out;
}

/**
 * Rectangle membership, under the gate's edge rule (models.ts, RectangleBounds). Closed, the
 * default, holds both edges: min <= x <= max. Half-open, Gating-ML 2.0's rule (section 5.1.1),
 * holds the lower edge and not the upper one, so rectangles sharing an edge partition the events
 * lying on it. A degenerate half-open rectangle (min equal to max) selects nothing.
 *
 * An edge with no bound (isUnbounded: the ±UNBOUNDED a Gating-ML import holds for a bound the file
 * leaves out) holds every value on its side, −Infinity and +Infinity included, under either rule.
 * Gating-ML's flog puts an event at 0 at −Infinity, and a range with no lower bound holds it: a
 * bound that is absent is not tested, in FlowKit 1.3.1 and flowCore 2.16.0 alike. Held as the
 * finite −UNBOUNDED, the edge left every such event out (FlowKit 37,390 events, GateLab 17,200, on
 * the public FACSCalibur FL2-A). NaN, which flog gives below 0, is in no rectangle.
 */
export function gateMaskRectangle(
  xVals: ArrayLike<number>,
  yVals: ArrayLike<number>,
  vertices: Vertex[],
  bounds?: RectangleBounds,
): Uint8Array {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const [vx, vy] of vertices) {
    if (vx < xMin) xMin = vx;
    if (vx > xMax) xMax = vx;
    if (vy < yMin) yMin = vy;
    if (vy > yMax) yMax = vy;
  }
  if (xMin <= -UNBOUNDED) xMin = -Infinity;
  if (xMax >= UNBOUNDED) xMax = Infinity;
  if (yMin <= -UNBOUNDED) yMin = -Infinity;
  if (yMax >= UNBOUNDED) yMax = Infinity;
  const n = xVals.length;
  const out = new Uint8Array(n);
  if (bounds === "half-open") {
    // An upper edge with no bound is not tested, so it holds +Infinity too.
    const xTop = xMax === Infinity;
    const yTop = yMax === Infinity;
    for (let i = 0; i < n; i++) {
      const x = xVals[i];
      const y = yVals[i];
      out[i] = x >= xMin && (x < xMax || (xTop && x === Infinity)) && y >= yMin && (y < yMax || (yTop && y === Infinity)) ? 1 : 0;
    }
    return out;
  }
  for (let i = 0; i < n; i++) {
    const x = xVals[i];
    const y = yVals[i];
    out[i] = x >= xMin && x <= xMax && y >= yMin && y <= yMax ? 1 : 0;
  }
  return out;
}

/**
 * How far past a rectangle's upper bound, relative to it, to write the bound for a reader whose
 * edge rule is not the gate's. GateLab writes the moved bound in full (gatingmlExport.ts,
 * fmtNum); the shift is twenty times what 15 significant digits, as files were written before
 * 2026-09, can round away (at most 5e-15 of the value), and a hundred times the error of a
 * reader's conversion through a transform and back, or of a rescale of the axis (FlowJo's Time
 * units, a $PnG), on the way in.
 *
 * Float32 values, which cytometry columns and GateLab's gate columns are, lie at least 2^-24
 * (6e-8) of their size apart, so none lies within the shift of a bound that is itself a float32
 * value, as a bound drawn on an event is. A bound a few doubles off a float32 value is not so
 * placed: upperBoundForReader then stops the move at that value (float32Side), and holds it or
 * leaves it out as the gate does. On float64 data an event can lie within the shift of any bound,
 * and only the exporters' placement among the exporting file's own events (gatingmlExport.ts,
 * tieBreak) decides it.
 *
 * It serves another program's reader, evaluating raw values. GateLab reading its own file back
 * does not depend on it: the file records GateLab's own rectangle (gatingmlExport.ts,
 * flowjoExport.ts), because a bound moved into a float32 display space can land on either side
 * of an event by far more than this.
 */
const EDGE_RULE_SHIFT = 1e-13;

const F32 = new Float32Array(1);
const F32_BITS = new Int32Array(F32.buffer);

/** The float32 value next to float32 `f`, above it (dir 1) or below it (dir -1). */
function stepFloat32(f: number, dir: 1 | -1): number {
  if (f === 0) return dir * 1.401298464324817e-45;
  F32[0] = f;
  F32_BITS[0] += (f > 0) === (dir > 0) ? 1 : -1;
  return F32[0];
}

/** The nearest float32 value strictly below x (dir -1) or strictly above it (dir 1). */
function float32Beyond(x: number, dir: 1 | -1): number {
  const f = Math.fround(x);
  return (dir < 0 ? f < x : f > x) ? f : stepFloat32(f, dir);
}

/**
 * A moved bound kept on GateLab's side of the nearest float32 value it would cross. `max` is the
 * gate's own bound and `moved` the bound EDGE_RULE_SHIFT puts beyond it for a reader of the other
 * rule, below it (dir -1, a half-open gate for a closed reader, which holds a value v <= moved and
 * must hold every v < max) or above it (dir 1, a closed gate for a half-open reader, which holds
 * v < moved and must hold every v <= max and no other). Where a float32 value lies strictly
 * between max and moved, the bound is put halfway between max and that value instead, or on the
 * value itself where no double lies between: a closed reader then holds it (it lies below max, and
 * the gate holds it), a half-open one leaves it out (it lies above max, and the gate does not).
 */
function float32Side(max: number, moved: number, dir: 1 | -1): number {
  const f = float32Beyond(max, dir);
  if (!(dir < 0 ? f > moved : f < moved)) return moved;
  const mid = max + (f - max) / 2;
  return mid !== max && mid !== f ? mid : f;
}

/**
 * Whether a rectangle coordinate stands for no bound: the importer holds a bound a Gating-ML file
 * leaves out as ±1e9 (gatingml.ts), the Gating-ML hardening branch as the largest finite double,
 * and Infinity is none either.
 */
function isOpenBound(v: number): boolean {
  return !(Math.abs(v) < Number.MAX_VALUE) || Math.abs(v) === 1e9;
}

/**
 * A rectangle's upper bound as it should be written for a reader with the given edge rule, so
 * that the reader selects exactly the events GateLab does, those lying on the edge included.
 *
 * A half-open gate written for a closed reader (FlowJo, flowCore) moves its bound just below the
 * edge; a closed gate written for a half-open reader (the Gating-ML standard, FlowKit) moves it
 * just above; in either case never past a float32 value the rules decide alike (float32Side). The
 * same rule on both sides writes the bound unchanged, and so does an edge with no bound
 * (isOpenBound), which an exporter writes as no bound again: moved, it would become a bound.
 */
export function upperBoundForReader(max: number, gate: RectangleBounds, reader: RectangleBounds): number {
  if (gate === reader || isOpenBound(max)) return max;
  const shift = max === 0 ? 1e-300 : Math.abs(max) * EDGE_RULE_SHIFT;
  return gate === "closed" ? float32Side(max, max + shift, 1) : float32Side(max, max - shift, -1);
}

/**
 * A rectangle's [min, max] on one axis as it should be written for a reader with the given edge
 * rule: the upper bound moved by upperBoundForReader, and the lower bound following an upper one
 * moved below it, so that min is never above max. A zero-width half-open rectangle, which holds
 * nothing, is then written as one whose single value no event holds.
 */
export function rangeForReader(min: number, max: number, gate: RectangleBounds, reader: RectangleBounds): [number, number] {
  const top = upperBoundForReader(max, gate, reader);
  return [Math.min(min, top), top];
}

/** The edge rule a rectangle does not follow. */
export function otherRectangleRule(rule: RectangleBounds): RectangleBounds {
  return rule === "closed" ? "half-open" : "closed";
}

/**
 * One quadrant of a quadrant gate. Numbering (matching gate_engine.R):
 *   1 = x-/y+, 2 = x+/y+, 3 = x+/y-, 4 = x-/y-  (>= on the positive side;
 *   a point exactly on the crosshair falls in quadrant 2). That is Gating-ML 2.0's rule
 *   (section 5.4.1): a value equal to a divider lies on the divider's upper side.
 *
 * With `curl`, the two dividers bend beyond the crosshair (see QuadrantCurl): an event is to
 * the right of the vertical divider where its x is at or beyond the divider's position AT ITS
 * OWN y, and above the horizontal divider where its y is at or beyond the divider's position
 * at its own x. The straight case is the same test with both dividers flat.
 */
export function gateMaskQuadrant(
  xVals: ArrayLike<number>,
  yVals: ArrayLike<number>,
  center: [number, number],
  quadrant: number,
  curl?: QuadrantCurl,
): Uint8Array {
  const cx = center[0];
  const cy = center[1];
  let q = Math.trunc(quadrant);
  if (!Number.isFinite(q)) q = 1;
  const n = xVals.length;
  const out = new Uint8Array(n);
  const bent = !!curl && curl.power > 0 && (curl.kx !== 0 || curl.ky !== 0);
  for (let i = 0; i < n; i++) {
    const x = xVals[i];
    const y = yVals[i];
    let xdiv = cx;
    let ydiv = cy;
    if (bent) {
      if (y > cy) xdiv = cx + curl!.ky * Math.pow(y - cy, curl!.power);
      if (x > cx) ydiv = cy + curl!.kx * Math.pow(x - cx, curl!.power);
    }
    const right = x >= xdiv;
    const up = y >= ydiv;
    let inq: boolean;
    switch (q) {
      case 1: inq = !right && up; break;
      case 2: inq = right && up; break;
      case 3: inq = right && !up; break;
      case 4: inq = !right && !up; break;
      default: inq = false;
    }
    out[i] = inq ? 1 : 0;
  }
  return out;
}

/**
 * Points along one bent arm of a quadrant gate, in the gate's own coordinates, from the
 * crosshair to `end` on that axis: the horizontal arm as (x, ydiv(x)) for `arm` "h", the
 * vertical one as (xdiv(y), y) for "v". For drawing; membership uses gateMaskQuadrant.
 */
export function quadrantArmPoints(
  center: [number, number],
  curl: QuadrantCurl,
  arm: "h" | "v",
  end: number,
  steps = 32,
): [number, number][] {
  const [cx, cy] = center;
  const from = arm === "h" ? cx : cy;
  if (!(end > from)) return [];
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const d = ((end - from) * i) / steps;
    const bend = Math.pow(d, curl.power);
    out.push(arm === "h" ? [cx + d, cy + curl.kx * bend] : [cx + curl.ky * bend, cy + d]);
  }
  return out;
}

/** Mask for any gate type against display-space assay data. */
export function getGateMask(gate: Gate, data: AssayData, quadrant?: number): Uint8Array {
  const x = data.column(gate.x_channel);
  const y = data.column(gate.y_channel);
  if (!x || !y) return new Uint8Array(data.n); // missing channel → all-false

  if (gate.gate_type === "polygon") return gateMaskPolygon(x, y, gate.vertices);
  if (gate.gate_type === "rectangle") return gateMaskRectangle(x, y, gate.vertices, gate.bounds);
  if (gate.gate_type === "quadrant") return gateMaskQuadrant(x, y, gate.center, quadrant ?? 1, gate.curl);
  if (gate.gate_type === "ellipse") return gateMaskEllipse(x, y, gate);
  return new Uint8Array(data.n);
}
