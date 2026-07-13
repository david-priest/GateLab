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
        label_offset: gate.label_offset ?? displayLabelOffset(displayVerts),
        percent_of_parent: counts?.percent_of_parent ?? null,
      });
    }
  }
  return out;
}
