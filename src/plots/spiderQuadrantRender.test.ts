// @vitest-environment jsdom
//
// A spider quadrant on the gating plot, drawn by the real renderer (cytof_plot.js with GateLab's
// patches): where its end handles sit when an end lies past the plotted range, and where its
// labels go. Synthetic gate and ranges.

import { beforeEach, describe, expect, it } from "vitest";
import { loadPlots } from "./loadPlots";

beforeEach(() => {
  document.body.innerHTML = '<div style="width:800px"><div id="cytof-plot-container"></div></div>';
  const noop = new Proxy({}, { get: (_t, key) => (key === "measureText" ? () => ({ width: 0 }) : () => undefined), set: () => true });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => noop });
  // jsdom lays out no SVG text; a label measures as 60 by 12 about its anchor.
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: -30, y: -10, width: 60, height: 12 }) });
});

function render(gate: Record<string, unknown>, xRange: [number, number], yRange: [number, number]) {
  const { CytofD3 } = loadPlots();
  CytofD3.render({
    x: [], y: [], n_events: 0, x_range: xRange, y_range: yRange, x_label: "FSC-A", y_label: "SSC-A",
    gates: [gate], selected_gate_id: gate.gate_id, plot_seq: Math.random(), force_full: true,
  }, "navigate");
  return document.getElementById("cytof-plot-container")!;
}

const seg = (a: [number, number], b: [number, number], n = 32): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);

describe("a spider quadrant's handles on the gating plot", () => {
  // Centre (40, 40); the box runs 0-100 on both axes; the up arm leans right to (70, 100).
  const c: [number, number] = [40, 40];
  const gate = {
    gate_id: "q1", name: "D1 spider", gate_type: "quadrant", x_channel: "FSC-A", y_channel: "SSC-A", color: "#377eb8", center: c,
    arms: { spider: true, h: seg(c, [100, 45]), v: seg(c, [70, 100]), l: seg(c, [0, 35]), d: seg(c, [30, 0]) },
    quadrant_counts: [1, 2, 3, 4], quadrant_pcts: [10, 20, 30, 40],
  };

  it("sits on its end where the end is in view", () => {
    const el = render(gate, [-10, 110], [-10, 110]);
    const up = el.querySelector<SVGCircleElement>('circle.q-spider-handle[data-arm="up"]')!;
    expect(up.getAttribute("data-pinned")).toBeNull();
    const path = el.querySelector("path.q-arm-v")!.getAttribute("d")!;
    const end = path.split(/[ML]/).filter(Boolean).pop()!.split(",").map(Number);
    expect(Number(up.getAttribute("cx"))).toBeCloseTo(end[0], 1);
    expect(Number(up.getAttribute("cy"))).toBeCloseTo(end[1], 1);
  });

  it("sits where its arm crosses the frame when the end lies past the plotted range", () => {
    // Stretched so the top of the box (y 100) is out of view: the up arm leaves the frame at y 80,
    // where it has come 30 * 40/60 = 20 to the right of the centre, at x 60, not at the end's x 70.
    const el = render(gate, [0, 100], [0, 80]);
    const up = el.querySelector<SVGCircleElement>('circle.q-spider-handle[data-arm="up"]')!;
    expect(up.getAttribute("data-pinned")).toBe("1");
    const plot = el.querySelector("rect.plot-bg")!;
    const W = Number(plot.getAttribute("width"));
    expect(Number(up.getAttribute("cy"))).toBeCloseTo(0, 6);
    expect(Number(up.getAttribute("cx")) / W).toBeCloseTo(0.6, 2);
    // An end in view is not pinned.
    expect(el.querySelector('circle.q-spider-handle[data-arm="down"]')!.getAttribute("data-pinned")).toBeNull();
  });
});
