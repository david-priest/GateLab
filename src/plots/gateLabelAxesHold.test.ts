// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { loadMiniPlots } from "./loadPlots";

// The scatter path draws its points on a canvas; jsdom has none, so every call on the context is
// a no-op and the gate overlay, which is SVG, is what the test reads.
beforeEach(() => {
  document.body.innerHTML = '<div id="plot"></div>';
  const noop = new Proxy({}, { get: (_target, key) => (key === "measureText" ? () => ({ width: 0 }) : () => undefined), set: () => true });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => noop });
});

/** Where the gate's label is drawn, in the plot's own pixels (0 at the top axis, downwards). */
function labelY(gate: Record<string, unknown>): { y: number; height: number } {
  const container = document.getElementById("plot") as HTMLDivElement;
  loadMiniPlots().renderMiniPlot(container, {
    x: [1, 2, 3, 4],
    y: [1, 2, 3, 4],
    n_events: 4,
    x_range: [0, 6],
    y_range: [0, 6],
    x_label: "x",
    y_label: "y",
    title: "Lymphocytes (4)",
    plot_size: 280,
    display_mode: "scatter",
    font_sizes: { tick: 10, axis_label: 12, title: 12, gate_label: 10 },
    gates: [{
      gate_id: "g1", name: "CD4_positive", gate_type: "polygon", color: "#e41a1c", percent_of_parent: 50,
      // A gate against the top of the plot.
      vertices: [[1, 5], [3, 5], [3, 5.8], [1, 5.8]],
      ...gate,
    }],
  });
  const label = container.querySelector<SVGGElement>('.gate-overlay-labels [data-gate-id="g1"]')!;
  const [, y] = /translate\(([-\d.]+),([-\d.]+)\)/.exec(label.getAttribute("transform") ?? "")!.slice(1).map(Number);
  const domain = container.querySelector(".y-axis .domain")!.getAttribute("d") ?? "";
  const height = Math.max(...(domain.match(/[-\d.]+/g) ?? []).map(Number));
  return { y, height };
}

describe("where a gate's label may sit on a mini plot", () => {
  // Let past the axes for every label, one above a gate at the top of a plot sat on the panel's
  // title. A label at its automatic place is held inside the axes, as it was before labels could
  // be dragged out.
  it("keeps a label at its automatic place inside the axes, under the title", () => {
    const { y } = labelY({ label_offset: [0, 2] }); // two units above a gate already at the top
    expect(y).toBe(10);
  });

  it("lets a label the user placed sit above the top axis or below the bottom one", () => {
    const above = labelY({ label_offset: [0, 2], label_placed: true });
    expect(above.y).toBeLessThan(0);
    const below = labelY({ label_offset: [0, -9], label_placed: true });
    expect(below.y).toBeGreaterThan(below.height);
    // The same offset, not placed: held at the bottom edge.
    const held = labelY({ label_offset: [0, -9] });
    expect(held.y).toBeLessThanOrEqual(held.height);
  });
});
