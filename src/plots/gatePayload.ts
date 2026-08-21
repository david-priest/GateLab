// gatePayload.ts — convert stored (gating-space) gates into cytof_plot.js render
// gates for the current display axes. Mirrors GateLabR get_plot_gates + gate_to_display_space:
// only gates on the current axes are drawn, vertices/center are forward-transformed to
// display space, and per-gate counts (within the active population) become labels.

import type { Sample } from "../engine/sample";
import type { Gate } from "../engine/models";
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
function polygonOutline(
  gatingVerts: [number, number][],
  toDisplay: (p: [number, number]) => [number, number],
  displayVerts: [number, number][],
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
  const tol = 0.002;

  const out: [number, number][] = [toDisplay(gatingVerts[0])];
  for (let i = 0; i < gatingVerts.length; i++) {
    subdivideEdge(
      gatingVerts[i], gatingVerts[(i + 1) % gatingVerts.length], toDisplay, tol, span, out,
    );
  }
  // A straight-in-display gate needs no outline; leaving it off keeps the payload small and the
  // renderer on its existing path.
  return out.length > gatingVerts.length + 1 ? out : undefined;
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
  const ids = gateOrder.length ? gateOrder : Object.keys(gates);
  for (const gid of ids) {
    const gate = gates[gid];
    if (!gate) continue;
    if (gate.x_channel !== xChannel || gate.y_channel !== yChannel) continue; // normal orientation only

    const counts = gateCounts[gid];
    const toDisplay = ([vx, vy]: [number, number]): [number, number] => [
      sample.gatingToDisplay(xChannel, vx),
      sample.gatingToDisplay(yChannel, vy),
    ];
    const common = {
      gate_id: gid,
      x_channel: xChannel,
      y_channel: yChannel,
      color: gate.color,
      name: gate.name,
    };

    if (gate.gate_type === "quadrant") {
      out.push({
        ...common,
        gate_type: "quadrant",
        label_offset: gate.label_offset,
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
        label_offset: gate.label_offset ?? displayLabelOffset(displayVerts),
        percent_of_parent: counts?.percent_of_parent ?? null,
      });
    } else {
      const displayVerts = gate.vertices.map(toDisplay);
      out.push({
        ...common,
        gate_type: gate.gate_type,
        vertices: displayVerts,
        outline: polygonOutline(gate.vertices, toDisplay, displayVerts),
        label_offset: gate.label_offset ?? displayLabelOffset(displayVerts),
        percent_of_parent: counts?.percent_of_parent ?? null,
      });
    }
  }
  return out;
}
