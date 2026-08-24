// gatePayload.ts — convert stored (gating-space) gates into cytof_plot.js render
// gates for the current display axes. Mirrors GateLabR get_plot_gates + gate_to_display_space:
// only gates on the current axes are drawn, vertices/center are forward-transformed to
// display space, and per-gate counts (within the active population) become labels.

import type { Sample } from "../engine/sample";
import type { Gate } from "../engine/models";
import { gateSpaceBadge } from "../engine/gateSpaceBadge";
import type { GateCount } from "../engine/populations";

export interface PlotGate {
  gate_id: string;
  gate_type: string;
  x_channel: string; // cytof_plot.js matches gates to the current axes on these
  y_channel: string;
  color: string;
  name: string;
  label_offset: [number, number] | null;
  vertices?: [number, number][];
  /**
   * The gate's true boundary in display space, for drawing.
   *
   * A polygon's edges are straight in GATING space, which is where membership is decided. Under
   * a non-linear axis their image is a curve, so joining the transformed vertices with straight
   * lines draws something that is not the gate: on an arcsinh SSC-A axis crossing zero the drawn
   * edge misses the real boundary by hundreds of pixels, and events appear on the wrong side of
   * it. Only the outline is densified -- `vertices` stays the editable set, so the drag handles
   * are unchanged and nothing about the stored gate or its export moves.
   */
  outline?: [number, number][];
  percent_of_parent?: number | null;
  center?: [number, number];
  quadrant_counts?: number[];
  quadrant_pcts?: number[];
}

/** A small label offset above the gate, in DISPLAY space (mirrors defaultLabelOffset
 *  but computed from the display-space vertices so labels sit just above the gate).
 *  Exported so Strategy/Illustration place auto labels identically to the main plot. */
export function displayLabelOffset(displayVerts: [number, number][]): [number, number] {
  const ys = displayVerts.map((v) => v[1]).filter(Number.isFinite);
  if (ys.length === 0) return [0, 0];
  const yc = ys.reduce((s, y) => s + y, 0) / ys.length;
  const yMax = Math.max(...ys);
  const yMin = Math.min(...ys);
  const h = Math.max(0, yMax - yMin);
  return [0, yMax - yc + Math.max(0.15, h * 0.08)];
}

/**
 * Subdivide one edge until the drawn chord is within `tol` of the true transformed curve.
 *
 * Recursive rather than a fixed count, because the curvature is not spread evenly: asinh
 * compresses hardest near zero, so an edge crossing zero needs its points concentrated there.
 * Uniform subdivision converges far too slowly to be usable -- on a real SSC gate spanning zero,
 * 32 evenly spaced points still left a 113 px error, where adaptive reaches half a pixel in 116
 * points for the whole polygon.
 */
function subdivideEdge(
  a: [number, number],
  b: [number, number],
  toDisplay: (p: [number, number]) => [number, number],
  tol: number,
  /**
   * Display extent of each axis, used to measure the error per axis.
   *
   * The two axes can be in wildly different units -- a linear scatter axis spans hundreds of
   * thousands while an arcsinh one spans about fourteen -- so a single distance in display space
   * is dominated by whichever is larger and says nothing about the other. With X linear and Y
   * arcsinh that made the tolerance ~530 against a largest-possible Y error of ~14: no edge ever
   * exceeded it and nothing subdivided, while both-arcsinh worked purely because its axes happen
   * to be commensurate.
   */
  span: [number, number],
  out: [number, number][],
  t0 = 0,
  t1 = 1,
  depth = 0,
): void {
  const at = (t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const p0 = toDisplay(at(t0));
  const p1 = toDisplay(at(t1));
  const tm = (t0 + t1) / 2;
  const mid = toDisplay(at(tm));
  const chordX = (p0[0] + p1[0]) / 2;
  const chordY = (p0[1] + p1[1]) / 2;
  const off = Math.hypot((mid[0] - chordX) / span[0], (mid[1] - chordY) / span[1]);
  // The depth cap bounds the work: 2^9 segments per edge is far past visually exact, and stops
  // a pathological transform from subdividing forever.
  if (depth >= 9 || !Number.isFinite(off) || off <= tol) {
    out.push(p1);
    return;
  }
  subdivideEdge(a, b, toDisplay, tol, span, out, t0, tm, depth + 1);
  subdivideEdge(a, b, toDisplay, tol, span, out, tm, t1, depth + 1);
}

/**
 * The polygon's boundary in display space, densified only where the transform bends it.
 *
 * The tolerance is a fraction of the gate's own display extent rather than a pixel count, so it
 * holds at any plot size without this module needing to know one: 0.2% of the bounding-box
 * diagonal is well under a pixel for a gate covering most of a plot.
 */
export function polygonOutline(
  gatingVerts: [number, number][],
  toDisplay: (p: [number, number]) => [number, number],
  displayVerts: [number, number][],
  opts?: {
    /** Override the 0.2% default. The EXPORTER passes half of it and spends the other half on
     *  Douglas-Peucker collapse, so its two-stage boundary keeps the same total bound. */
    tol?: number;
    /** Out-param: filled with { span, edgeBreaks } so a caller can post-process per edge.
     *  edgeBreaks[i] is the index in the returned ring where edge i's appended points begin;
     *  edge i's endpoint (an ORIGINAL vertex, which must survive any simplification) is the
     *  last appended point, at edgeBreaks[i+1] - 1 (ring length for the final edge). */
    detail?: { span?: [number, number]; edgeBreaks?: number[] };
  },
): [number, number][] | undefined {
  if (gatingVerts.length < 3) return undefined;
  const xs = displayVerts.map((v) => v[0]).filter(Number.isFinite);
  const ys = displayVerts.map((v) => v[1]).filter(Number.isFinite);
  if (xs.length < 3 || ys.length < 3) return undefined;
  // Per-axis spans, not a diagonal: see subdivideEdge. A zero span means the gate is degenerate
  // on that axis and cannot bend along it, so it is neutralised rather than dividing by zero.
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  if (!(spanX > 0) && !(spanY > 0)) return undefined;
  const span: [number, number] = [spanX > 0 ? spanX : Infinity, spanY > 0 ? spanY : Infinity];
  // 0.2% of the gate's own extent on the axis that bends, which is sub-pixel at any plot size.
  const tol = opts?.tol ?? 0.002;

  const out: [number, number][] = [toDisplay(gatingVerts[0])];
  const breaks: number[] = [];
  for (let i = 0; i < gatingVerts.length; i++) {
    breaks.push(out.length);
    subdivideEdge(
      gatingVerts[i], gatingVerts[(i + 1) % gatingVerts.length], toDisplay, tol, span, out,
    );
  }
  if (opts?.detail) {
    opts.detail.span = span;
    opts.detail.edgeBreaks = breaks;
  }
  // A straight-in-display gate needs no outline; leaving it off keeps the payload small and the
  // renderer on its existing path.
  return out.length > gatingVerts.length + 1 ? out : undefined;
}


/** The display extent of the data on each axis, or null where a channel has no spread. */
type AxisFrames = [[number, number] | null, [number, number] | null];

/**
 * How far outside the data's own extent a label may still sit before it counts as lost.
 *
 * Not zero: a label placed just beyond the cloud is a normal, deliberate thing to do, and the
 * axis fit leaves room for exactly that.
 */
const OFF_PLOT_MARGIN = 0.35;

/**
 * A user-dragged label offset, but only while it still means something on these axes.
 *
 * `label_offset` is a delta in DISPLAY units, so it silently changes meaning whenever the axis
 * transform does. A label dragged on an arcsinh axis spanning about -4 to 9 carries an offset of
 * several units; read on a logicle axis, which spans 0 to 1, that same offset throws the label
 * several axis-widths away.
 *
 * The rule: a label that would land off the plot goes back to the position it would have had
 * when its gate was made. Nothing is lost in the nether, and nothing has to be hunted for.
 *
 * The reference frame is the AXIS, not the gate. Judging against the gate's own extent looks
 * equivalent and is not: a QUADRANT is a single point, so its extent is zero, the limit collapsed
 * to a constant and every stale quadrant offset survived. That is what flung a quadrant label
 * into the far corner after switching a fluorescence channel from arcsinh to logicle — and,
 * because includePlotGatesInAxisRange() also considered label positions, dragged the axis out to
 * reach it and shrank the data into a corner.
 *
 * Self-correcting: an unusable offset is dropped, the label auto-places beside its gate, and
 * dragging it again records an offset in the units now in force.
 */
function usableLabelOffset(
  stored: [number, number] | null | undefined,
  displayVerts: [number, number][],
  axisFrames: AxisFrames,
): [number, number] | null {
  if (!stored || !stored.every(Number.isFinite)) return null;
  const finite = displayVerts.filter((v) => v.every(Number.isFinite));
  if (finite.length === 0) return null;

  for (const axis of [0, 1] as const) {
    const frame = axisFrames[axis];
    const vs = finite.map((v) => v[axis]);
    if (frame) {
      // Where the label would actually END UP, judged against the data's own display extent
      // with a margin. Deliberately NOT the current zoom: zooming in would otherwise throw away
      // every label placement on the plot, which is destructive and fights the user.
      const anchor = vs.reduce((sum, v) => sum + v, 0) / vs.length;
      const position = anchor + stored[axis];
      const margin = (frame[1] - frame[0]) * OFF_PLOT_MARGIN;
      if (position < frame[0] - margin || position > frame[1] + margin) return null;
      continue;
    }
    // No usable axis frame (a channel with no spread). Fall back to the gate's own extent.
    const span = Math.max(...vs) - Math.min(...vs);
    const room = span > 0 ? span * 20 : Math.abs(vs[0]) * 20 + 1;
    if (Math.abs(stored[axis]) > room) return null;
  }
  return stored;
}

/** Gates drawn on (xChannel, yChannel) in normal orientation, in display space. */
export function buildPlotGates(
  sample: Sample,
  gates: Record<string, Gate>,
  gateOrder: string[],
  gateCounts: Record<string, GateCount>,
  xChannel: string,
  yChannel: string,
): PlotGate[] {
  const out: PlotGate[] = [];
  // The display extent of the DATA on each axis — the frame a label has to land inside.
  // Cached on Sample, so this costs nothing per gate.
  const frameOf = (channel: string): [number, number] | null => {
    const idx = sample.index(channel);
    if (idx === undefined) return null;
    const [lo, hi] = sample.displayRange(idx);
    return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? [lo, hi] : null;
  };
  const axisFrames: AxisFrames = [frameOf(xChannel), frameOf(yChannel)];
  const ids = gateOrder.length ? gateOrder : Object.keys(gates);
  for (const gid of ids) {
    const gate = gates[gid];
    if (!gate) continue;
    if (gate.x_channel !== xChannel || gate.y_channel !== yChannel) continue; // normal orientation only

    const counts = gateCounts[gid];
    const toDisplay = ([vx, vy]: [number, number]): [number, number] => [
      sample.gateToDisplay(gate, xChannel, vx),
      sample.gateToDisplay(gate, yChannel, vy),
    ];
    // Two-letter space badge, drawn under the label. Null on CyTOF, where it would read the
    // same on every gate forever.
    const badge = gateSpaceBadge(sample, gate);
    const common = {
      gate_id: gid,
      x_channel: xChannel,
      y_channel: yChannel,
      color: gate.color,
      name: gate.name,
      space_badge: badge?.text,
      space_hint: badge?.hint,
    };

    if (gate.gate_type === "quadrant") {
      out.push({
        ...common,
        gate_type: "quadrant",
        label_offset: usableLabelOffset(gate.label_offset, [toDisplay(gate.center)], axisFrames),
        center: toDisplay(gate.center),
        quadrant_counts: counts?.quadrants?.map((q) => q.event_count),
        quadrant_pcts: counts?.quadrants?.map((q) => q.percent_of_parent),
      });
    } else if (gate.gate_type === "rectangle") {
      // Render as the axis-aligned box (mask uses min/max), so 2- or 4-corner
      // stored rectangles both draw correctly.
      let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
      for (const [vx, vy] of gate.vertices) {
        if (vx < xmin) xmin = vx;
        if (vx > xmax) xmax = vx;
        if (vy < ymin) ymin = vy;
        if (vy > ymax) ymax = vy;
      }
      const displayVerts: [number, number][] = [
        [xmin, ymin],
        [xmax, ymin],
        [xmax, ymax],
        [xmin, ymax],
      ].map((c) => toDisplay(c as [number, number]));
      out.push({
        ...common,
        gate_type: "rectangle",
        vertices: displayVerts,
        // Label offset must be in DISPLAY space (cytof applies it to display coords).
        label_offset: usableLabelOffset(gate.label_offset, displayVerts, axisFrames)
          ?? displayLabelOffset(displayVerts),
        percent_of_parent: counts?.percent_of_parent ?? null,
      });
    } else {
      const displayVerts = gate.vertices.map(toDisplay);
      out.push({
        ...common,
        gate_type: gate.gate_type,
        vertices: displayVerts,
        outline: polygonOutline(gate.vertices, toDisplay, displayVerts),
        label_offset: usableLabelOffset(gate.label_offset, displayVerts, axisFrames)
          ?? displayLabelOffset(displayVerts),
        percent_of_parent: counts?.percent_of_parent ?? null,
      });
    }
  }
  return out;
}
