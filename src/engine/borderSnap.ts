// borderSnap.ts — after a pan or stretch commits, a gate side that ends within the snap distance
// of a plot border lands on it. Snap only, never glue: a side the view left further away stays
// exactly where the view put it, and a side that was on the border before the drag follows the
// data, not the border. Sides facing another gate cannot be that close to a border in between.

import type { Gate, PolyRectGate } from "./models";

export interface BorderSnapSample {
  gateToDisplay(gate: PolyRectGate, channel: string, v: number): number;
  displayToGate(gate: PolyRectGate, channel: string, v: number): number;
}

export interface BorderSnapView {
  /** The plot's channels and committed display ranges. */
  xKey: string;
  yKey: string;
  xRange: [number, number];
  yRange: [number, number];
  /** The plot's data area in pixels, so the snap distance is a distance on screen. */
  widthPx: number;
  heightPx: number;
}

export const BORDER_SNAP_PX = 6;

/** A display value within the snap distance of either end of the range lands on that end. */
function snapValue(v: number, range: [number, number], pxPerUnit: number, tolPx: number): number {
  const lo = Math.min(range[0], range[1]), hi = Math.max(range[0], range[1]);
  if (Math.abs(v - lo) * pxPerUnit <= tolPx) return lo;
  if (Math.abs(v - hi) * pxPerUnit <= tolPx) return hi;
  return v;
}

/**
 * The polygon and rectangle gates drawn on the view's axes whose vertices end within `tolPx` of
 * a plot border, each with the vertices that put them on it (gating space). A rectangle keeps
 * its shape: its bounds snap, not its corners one by one.
 */
export function snapGatesToBorders(
  gates: Record<string, Gate>,
  sample: BorderSnapSample,
  view: BorderSnapView,
  tolPx: number = BORDER_SNAP_PX,
): { gateId: string; vertices: [number, number][] }[] {
  const spanX = Math.abs(view.xRange[1] - view.xRange[0]), spanY = Math.abs(view.yRange[1] - view.yRange[0]);
  if (!(spanX > 0) || !(spanY > 0) || !(view.widthPx > 0) || !(view.heightPx > 0)) return [];
  const pxX = view.widthPx / spanX, pxY = view.heightPx / spanY;
  const edits: { gateId: string; vertices: [number, number][] }[] = [];
  for (const gate of Object.values(gates)) {
    if (gate.gate_type !== "polygon" && gate.gate_type !== "rectangle") continue;
    const normal = gate.x_channel === view.xKey && gate.y_channel === view.yKey;
    const flipped = gate.x_channel === view.yKey && gate.y_channel === view.xKey;
    if (!normal && !flipped) continue;
    // The gate's own first axis is the plot's x axis when drawn normally, else the plot's y axis.
    const rangeA = flipped ? view.yRange : view.xRange, rangeB = flipped ? view.xRange : view.yRange;
    const pxA = flipped ? pxY : pxX, pxB = flipped ? pxX : pxY;
    const display = gate.vertices.map(([a, b]) => [sample.gateToDisplay(gate, gate.x_channel, a), sample.gateToDisplay(gate, gate.y_channel, b)] as [number, number]);
    let snapped: [number, number][];
    if (gate.gate_type === "rectangle") {
      const as = display.map((p) => p[0]), bs = display.map((p) => p[1]);
      const a0 = snapValue(Math.min(...as), rangeA, pxA, tolPx), a1 = snapValue(Math.max(...as), rangeA, pxA, tolPx);
      const b0 = snapValue(Math.min(...bs), rangeB, pxB, tolPx), b1 = snapValue(Math.max(...bs), rangeB, pxB, tolPx);
      snapped = display.map(([a, b]) => [a === Math.min(...as) ? a0 : a === Math.max(...as) ? a1 : a, b === Math.min(...bs) ? b0 : b === Math.max(...bs) ? b1 : b]);
    } else {
      snapped = display.map(([a, b]) => [snapValue(a, rangeA, pxA, tolPx), snapValue(b, rangeB, pxB, tolPx)]);
    }
    if (snapped.every((p, i) => p[0] === display[i][0] && p[1] === display[i][1])) continue;
    edits.push({
      gateId: gate.gate_id,
      vertices: snapped.map(([a, b]) => [sample.displayToGate(gate, gate.x_channel, a), sample.displayToGate(gate, gate.y_channel, b)] as [number, number]),
    });
  }
  return edits;
}
