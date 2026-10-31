// gatePayload.ts — convert stored (gating-space) gates into cytof_plot.js render
// gates for the current display axes. Mirrors GateLabR get_plot_gates + gate_to_display_space:
// only gates on the current axes are drawn, vertices/center are forward-transformed to
// display space, and per-gate counts (within the active population) become labels.

import type { Sample } from "../engine/sample";
import { axesFromCovariance, ellipseBoundary } from "../engine/ellipse";
import { isUnbounded, type Gate } from "../engine/models";
import { } from "../engine/gates";
import { gateSpaceBadge } from "../engine/gateSpaceBadge";
import { spiderOverlayShape, type QuadrantArms } from "../engine/quadrantOverlay";
import type { GateCount } from "../engine/populations";

export interface PlotGate {
  gate_id: string;
  gate_type: string;
  x_channel: string; // cytof_plot.js matches gates to the current axes on these
  y_channel: string;
  color: string;
  name: string;
  label_offset: [number, number] | null;
  /** A quadrant gate's four label positions, Q1 to Q4, as dragged deltas in display units. */
  quadrant_label_offsets?: ([number, number] | null)[];
  vertices?: [number, number][];
  /**
   * A rectangle's sides with no bound (UNBOUNDED), [low, high] per axis. They are drawn past every
   * event (drawnRaw); the axis fit leaves them out, and the label sits among the data instead.
   */
  unbounded?: { x: [boolean, boolean]; y: [boolean, boolean] };
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
  /** Rendered as a polygon but backed by an EllipseGate; vertex edits must never come back. */
  ellipse_source?: boolean;
  /**
   * Display-space handle geometry for a selected ellipse, present only when the gate-space →
   * display map is affine on both axes (checked numerically, not assumed) — under a nonlinear
   * axis the on-screen shape is not an ellipse and axis-end handles would lie.
   */
  ellipse?: { mean: [number, number]; major: number; minor: number; angle: number };
  /** false suppresses vertex handles: body select/move stays, per-vertex reshaping is denied. */
  editable?: boolean;
  percent_of_parent?: number | null;
  /**
   * Word drawn after the percentage naming what it was counted over ("pooled"), with a hint for
   * the tooltip. Absent when the count is the plotted file's own, which needs no qualifier.
   */
  percent_scope?: string;
  percent_scope_hint?: string;
  /**
   * A small orange tag after the label, on a gate the viewed file holds at coordinates of its own
   * ("this file") or its group's (the group's name); a click on it offers revert and use for the
   * tree. The hint is its tooltip.
   */
  tailored_tag?: string;
  tailored_tag_hint?: string;
  center?: [number, number];
  /**
   * A curly quadrant's bent dividers, in display coordinates: the horizontal arm from the
   * crosshair rightwards and the vertical arm upwards. For a spider quadrant whose arms lean,
   * all four from the centre (`l` left, `d` down) with `spider` set. Absent for a straight crosshair.
   */
  arms?: QuadrantArms;
  /** A spider quadrant's label places, Q1 to Q4, inside each sector, in display coordinates. */
  quadrant_anchors?: [number, number][];
  quadrant_counts?: number[];
  quadrant_pcts?: number[];
  /** Drawn with the plot's axes the other way round, and given in its own orientation (buildPlotGates). */
  flipped?: boolean;
}

/** The scope a gate count was taken over, when it is not simply the plotted file's own. */
export interface GateCountScope {
  text: string;
  hint: string;
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
  /**
   * The display points at t0, t1 and halfway between, when the parent step already has them: a
   * half's ends and midpoint are its parent's ends, midpoint and quarter-point, so they are passed
   * down rather than transformed again, and each step transforms only its own two quarter-points.
   * Every t here is dyadic, so a point passed down is bit for bit the one the step would compute.
   */
  known0?: [number, number],
  known1?: [number, number],
  knownMid?: [number, number],
): void {
  const at = (t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const p0 = known0 ?? toDisplay(at(t0));
  const p1 = known1 ?? toDisplay(at(t1));
  const tm = (t0 + t1) / 2;
  const pm = knownMid ?? toDisplay(at(tm));
  const q1 = toDisplay(at(t0 + (t1 - t0) * 0.25));
  const q3 = toDisplay(at(t0 + (t1 - t0) * 0.75));
  // An edge crossing an inflection can have its midpoint exactly on the chord while both
  // halves bow away. Inspect the quarter-points too, in the same per-axis display units.
  const offAt = (point: [number, number], fraction: number): number => Math.hypot(
    (point[0] - (p0[0] + (p1[0] - p0[0]) * fraction)) / span[0],
    (point[1] - (p0[1] + (p1[1] - p0[1]) * fraction)) / span[1],
  );
  const off = Math.max(offAt(q1, 0.25), offAt(pm, 0.5), offAt(q3, 0.75));
  // The depth cap stops a transform that never settles from subdividing forever (a jump costs one
  // path down to it), but a smooth edge needs depth too: one spanning raw values to R on
  // arcsinh(x / c) bends within about c / R of its length, and takes about log2(R / c) + 3 halvings
  // to trace. 15 traces mass cytometry to 100,000 and spectral flow to 4,194,304 at cofactor 150.
  // At 9, raw triangles on mass cytometry ranges to 20,000 were drawn up to 27 times the tolerance
  // off; a wider R / c than 15 reaches can still be.
  if (depth >= 15 || !Number.isFinite(off) || off <= tol) {
    out.push(p1);
    return;
  }
  subdivideEdge(a, b, toDisplay, tol, span, out, t0, tm, depth + 1, p0, pm, q1);
  subdivideEdge(a, b, toDisplay, tol, span, out, tm, t1, depth + 1, pm, p1, q3);
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

/**
 * A rectangle's corners after a drag, in its own space, with every corner on an open side kept
 * open. The plot hands back the four corners of the box buildPlotGates drew, in its order
 * ([xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax]), and an open side is drawn past the
 * plot. Converting that drawn position back gave a finite edge, so moving a FlowJo quadrant's
 * rectangle closed it at the top of its biex axis and the clip let it run across the margins.
 */
export function keepOpenSides(sample: Sample, gate: Gate, edited: [number, number][]): [number, number][] {
  if (gate.gate_type !== "rectangle" || edited.length !== 4) return edited;
  const xs = gate.vertices.map((v) => v[0]);
  const ys = gate.vertices.map((v) => v[1]);
  const sides = {
    x: [Math.min(...xs), Math.max(...xs)] as const,
    y: [Math.min(...ys), Math.max(...ys)] as const,
  };
  const open = (ch: string, v: number) => isUnbounded(sample.gateToRaw(gate, ch, v));
  const openX = [open(gate.x_channel, sides.x[0]), open(gate.x_channel, sides.x[1])];
  const openY = [open(gate.y_channel, sides.y[0]), open(gate.y_channel, sides.y[1])];
  if (!openX.some(Boolean) && !openY.some(Boolean)) return edited;
  return edited.map(([x, y], i) => {
    const hiX = i === 1 || i === 2 ? 1 : 0;
    const hiY = i >= 2 ? 1 : 0;
    return [openX[hiX] ? sides.x[hiX] : x, openY[hiY] ? sides.y[hiY] : y];
  });
}

/**
 * Gates drawn on (xChannel, yChannel), in display space, in gate order: those drawn with these
 * axes, and those drawn with them the other way round (after Swap X and Y). A reversed gate is
 * given in its own orientation, its x_channel the plot's Y, as though the plot were drawn its
 * way; the renderer transposes it on screen, and its drags and label moves come back in the
 * gate's own terms. `flipped` marks it for code that reads the payload in the plot's terms
 * (plotGatesInPlotOrientation).
 */
export function buildPlotGates(
  sample: Sample,
  gates: Record<string, Gate>,
  gateOrder: string[],
  gateCounts: Record<string, GateCount>,
  xChannel: string,
  yChannel: string,
  countScope: GateCountScope | null = null,
  /**
   * The ranges the plot shows, when known: a curly quadrant's arms run to the edge of what is
   * on screen. Labels keep judging themselves against the data's own extent (axisFrames).
   */
  viewFrames: AxisFrames = [null, null],
): PlotGate[] {
  const normal = buildOrientedPlotGates(sample, gates, gateOrder, gateCounts, xChannel, yChannel, countScope, viewFrames);
  // One channel on both axes (a range, the histogram) has no other orientation.
  if (xChannel === yChannel) return normal;
  const reversed = buildOrientedPlotGates(sample, gates, gateOrder, gateCounts, yChannel, xChannel, countScope, [viewFrames[1], viewFrames[0]]);
  if (!reversed.length) return normal;
  const byId = new Map<string, PlotGate>(normal.map((gate) => [gate.gate_id, gate]));
  for (const gate of reversed) byId.set(gate.gate_id, { ...gate, flipped: true });
  const ids = gateOrder.length ? gateOrder : Object.keys(gates);
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * The payload's gates in the plot's terms, [X, Y], for code that reads coordinates by axis (the
 * axis fit): a reversed gate's points, offsets and open sides are swapped back.
 */
export function plotGatesInPlotOrientation(gates: readonly PlotGate[]): PlotGate[] {
  const swap = (p: [number, number]): [number, number] => [p[1], p[0]];
  const swapAll = (pts: [number, number][]) => pts.map(swap);
  return gates.map((gate) => {
    if (!gate.flipped) return gate;
    return {
      ...gate,
      x_channel: gate.y_channel,
      y_channel: gate.x_channel,
      label_offset: gate.label_offset && swap(gate.label_offset),
      ...(gate.vertices ? { vertices: swapAll(gate.vertices) } : {}),
      ...(gate.outline ? { outline: swapAll(gate.outline) } : {}),
      ...(gate.unbounded ? { unbounded: { x: gate.unbounded.y, y: gate.unbounded.x } } : {}),
      ...(gate.center ? { center: swap(gate.center) } : {}),
      ...(gate.arms
        ? { arms: Object.fromEntries(Object.entries(gate.arms).map(([key, value]) => [key, Array.isArray(value) ? swapAll(value as [number, number][]) : value])) as PlotGate["arms"] }
        : {}),
      flipped: false,
    };
  });
}

/** Gates drawn on (xChannel, yChannel) in that orientation, in display space. */
function buildOrientedPlotGates(
  sample: Sample,
  gates: Record<string, Gate>,
  gateOrder: string[],
  gateCounts: Record<string, GateCount>,
  xChannel: string,
  yChannel: string,
  countScope: GateCountScope | null,
  viewFrames: AxisFrames,
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
  // A label is kept wherever it lands within the wider of the data's extent and the plotted
  // range: zooming in does not throw placements away (the data extent still covers them), and
  // zooming out lets a label sit in the empty part of the plot rather than snapping back.
  const union = (a: [number, number] | null, b: [number, number] | null): [number, number] | null =>
    a && b ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : a ?? b;
  const labelFrames: AxisFrames = [union(axisFrames[0], viewFrames[0]), union(axisFrames[1], viewFrames[1])];
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
      ...(countScope
        ? { percent_scope: countScope.text, percent_scope_hint: countScope.hint }
        : {}),
    };

    if (gate.gate_type === "quadrant") {
      // Bent arms run from the crosshair to the far edge of what the plot shows, sampled evenly
      // ON SCREEN (a transformed axis packs most of its pixels near the crosshair, where the
      // bend starts, so sampling evenly in the gate's space drew the first segment as a chord)
      // with each point evaluated in the gate's own space, so the curve on screen is the curve
      // the mask evaluates.
      let arms: QuadrantArms | undefined;
      const [xFrame, yFrame] = axisFrames;
      const xEnd = viewFrames[0]?.[1] ?? xFrame?.[1];
      const yEnd = viewFrames[1]?.[1] ?? yFrame?.[1];
      // A spider quadrant's four arms run from its centre to their ends on its box.
      const xView = viewFrames[0] ?? xFrame;
      const yView = viewFrames[1] ?? yFrame;
      const spider = spiderOverlayShape(sample, gate, xChannel, yChannel, false, xView && yView ? { x: xView, y: yView } : undefined);
      if (spider) {
        arms = spider.arms;
      } else if (gate.curl && xEnd !== undefined && yEnd !== undefined) {
        const curl = gate.curl;
        const [cx, cy] = gate.center;
        const armTo = (arm: "h" | "v", displayEnd: number): [number, number][] => {
          const channel = arm === "h" ? xChannel : yChannel;
          const origin = arm === "h" ? cx : cy;
          const start = sample.gateToDisplay(gate, channel, origin);
          if (!(displayEnd > start)) return [];
          const steps = 48;
          const pts: [number, number][] = [];
          for (let i = 0; i <= steps; i++) {
            const along = sample.displayToGate(gate, channel, start + ((displayEnd - start) * i) / steps);
            const d = along - origin;
            if (!(d >= 0)) continue;
            const bend = Math.pow(d, curl.power);
            pts.push(toDisplay(arm === "h" ? [cx + d, cy + curl.kx * bend] : [cx + curl.ky * bend, cy + d]));
          }
          return pts;
        };
        arms = { h: armTo("h", xEnd), v: armTo("v", yEnd) };
      }
      out.push({
        ...common,
        gate_type: "quadrant",
        label_offset: usableLabelOffset(gate.label_offset, [toDisplay(gate.center)], labelFrames),
        center: toDisplay(gate.center),
        ...(arms ? { arms } : {}),
        ...(spider ? { quadrant_anchors: spider.anchors } : {}),
        quadrant_counts: counts?.quadrants?.map((q) => q.event_count),
        quadrant_pcts: counts?.quadrants?.map((q) => q.percent_of_parent),
        ...(gate.quadrant_label_offsets
          ? { quadrant_label_offsets: gate.quadrant_label_offsets.map((o, q) => usableLabelOffset(o, [spider?.anchors[q] ?? toDisplay(gate.center)], labelFrames)) }
          : {}),
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
      const open = (ch: string, v: number) => isUnbounded(sample.gateToRaw(gate, ch, v));
      const unbounded = {
        x: [open(xChannel, xmin), open(xChannel, xmax)] as [boolean, boolean],
        y: [open(yChannel, ymin), open(yChannel, ymax)] as [boolean, boolean],
      };
      const anyOpen = unbounded.x.some(Boolean) || unbounded.y.some(Boolean);
      // An open side is drawn at raw ±1e12 (drawnRaw), which on a logicle axis is a few decades
      // past the top: zoomed out far enough, it came into the plot as an edge, with the label on
      // the edge of the view outside it. It is drawn at least a whole span past the wider of the
      // plotted range and the data, so it stays off the plot however far out the view goes.
      for (const k of [0, 1] as const) {
        const frame = labelFrames[k];
        const sides = k === 0 ? unbounded.x : unbounded.y;
        if (!frame || !(sides[0] || sides[1])) continue;
        const span = frame[1] - frame[0];
        const ends = displayVerts.map((p) => p[k]);
        const lo = Math.min(...ends), hi = Math.max(...ends);
        for (const p of displayVerts) {
          if (sides[0] && p[k] === lo) p[k] = Math.min(lo, frame[0] - span);
          if (sides[1] && p[k] === hi) p[k] = Math.max(hi, frame[1] + span);
        }
      }
      // The renderer anchors a label at the mean of the vertices. With a side drawn past every
      // event that mean is far off the plot, so the automatic label is placed on the rectangle as
      // it appears within the plotted range (the data's frame when the range is not known), and
      // moved by the difference of the two means.
      let autoLabel = displayLabelOffset(displayVerts);
      if (anyOpen) {
        const seenFrame = (k: 0 | 1) => viewFrames[k] ?? labelFrames[k];
        const clip = (v: number, k: 0 | 1): number => {
          const frame = seenFrame(k);
          const sides = k === 0 ? unbounded.x : unbounded.y;
          if (!frame) return v;
          const ends = displayVerts.map((p) => p[k]);
          if (sides[0] && v === Math.min(...ends)) return frame[0];
          if (sides[1] && v === Math.max(...ends)) return frame[1];
          return v;
        };
        const seen = displayVerts.map((p) => [clip(p[0], 0), clip(p[1], 1)] as [number, number]);
        const mean = (pts: [number, number][], k: 0 | 1) => pts.reduce((sum, p) => sum + p[k], 0) / pts.length;
        const own = displayLabelOffset(seen);
        // An open top reaches the top of the plot, where a label set above the rectangle would
        // sit in the margin: it goes just inside the top instead, no lower than the middle.
        const yFrame = seenFrame(1);
        if (unbounded.y[1] && yFrame) {
          const ys = seen.map((p) => p[1]);
          const top = Math.max(...ys);
          const inside = Math.max(mean(seen, 1), top - (yFrame[1] - yFrame[0]) * 0.06);
          own[1] = inside - mean(seen, 1);
        }
        autoLabel = [own[0] + mean(seen, 0) - mean(displayVerts, 0), own[1] + mean(seen, 1) - mean(displayVerts, 1)];
      }
      out.push({
        ...common,
        gate_type: "rectangle",
        vertices: displayVerts,
        ...(anyOpen ? { unbounded } : {}),
        // Label offset must be in DISPLAY space (cytof applies it to display coords).
        label_offset: usableLabelOffset(gate.label_offset, displayVerts, labelFrames) ?? autoLabel,
        percent_of_parent: counts?.percent_of_parent ?? null,
      });
    } else if (gate.gate_type === "ellipse") {
      // The renderer receives the sampled boundary as a POLYGON: the fill/stroke/label/move
      // machinery all work unchanged, and the outline bends the curve through the display
      // transforms exactly as it does for any polygon. editable:false suppresses vertex
      // handles — dragging 64 sampled points would corrupt the covariance form, and reshaping
      // an ellipse is a dedicated editor, not a vertex tweak. Body move still works: a
      // translation applies uniformly to every boundary point, and the app maps it back to
      // the mean.
      const boundary = ellipseBoundary(gate);
      const displayVerts = boundary.map(toDisplay);
      // Handle geometry, iff the gate→display map is affine on both axes across the ellipse's
      // own extent. Checked numerically with a midpoint test rather than inferred from the
      // gate's space field: a display-space gate stops being affine the moment the axis scale
      // is changed after drawing, and a raw-space gate on linear axes is perfectly editable.
      const xs = boundary.map((v) => v[0]);
      const ys = boundary.map((v) => v[1]);
      const affine = (ch: string, lo: number, hi: number): number | null => {
        const dLo = sample.gateToDisplay(gate, ch, lo);
        const dHi = sample.gateToDisplay(gate, ch, hi);
        const dMid = sample.gateToDisplay(gate, ch, (lo + hi) / 2);
        const span = Math.abs(dHi - dLo);
        if (!(span > 0)) return null;
        if (Math.abs(dMid - (dLo + dHi) / 2) > 1e-6 * span) return null;
        return (dHi - dLo) / (hi - lo || 1);
      };
      const kx = affine(gate.x_channel, Math.min(...xs), Math.max(...xs));
      const ky = affine(gate.y_channel, Math.min(...ys), Math.max(...ys));
      let handleGeom: PlotGate["ellipse"];
      if (kx !== null && ky !== null) {
        // Σ_display = K·Σ·K with K = diag(kx, ky); axes re-derived from it, because per-axis
        // scaling does not act componentwise on (major, minor, angle).
        const c = gate.covariance;
        const covD: [[number, number], [number, number]] = [
          [c[0][0] * kx * kx, c[0][1] * kx * ky],
          [c[1][0] * ky * kx, c[1][1] * ky * ky],
        ];
        const ax = axesFromCovariance(covD, gate.distance_square);
        handleGeom = { mean: toDisplay(gate.mean), major: ax.major, minor: ax.minor, angle: ax.angle };
      }
      out.push({
        ...common,
        gate_type: "polygon",
        ellipse_source: true,
        editable: false,
        ...(handleGeom ? { ellipse: handleGeom } : {}),
        vertices: displayVerts,
        outline: polygonOutline(boundary, toDisplay, displayVerts),
        label_offset: usableLabelOffset(gate.label_offset, displayVerts, labelFrames)
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
        label_offset: usableLabelOffset(gate.label_offset, displayVerts, labelFrames)
          ?? displayLabelOffset(displayVerts),
        percent_of_parent: counts?.percent_of_parent ?? null,
      });
    }
  }
  return out;
}
