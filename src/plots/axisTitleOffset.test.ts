// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { loadMiniPlots } from "./loadPlots";

// The scatter path draws its points on a canvas; jsdom has none, so every call on the context
// is a no-op and the axes, which are SVG, are what the test reads.
beforeEach(() => {
  document.body.innerHTML = '<div id="plot"></div>';
  const noop = new Proxy({}, { get: (_target, key) => (key === "measureText" ? () => ({ width: 0 }) : () => undefined), set: () => true });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => noop });
});

function render(cfg: Record<string, unknown>) {
  const container = document.getElementById("plot") as HTMLDivElement;
  loadMiniPlots().renderMiniPlot(container, {
    x: [1, 2, 3, 4],
    y: [1, 2, 3, 4],
    n_events: 4,
    x_range: [0, 6],
    y_range: [0, 6],
    x_label: "x",
    y_label: "y",
    plot_size: 280,
    display_mode: "scatter",
    font_sizes: { tick: 10, axis_label: 12, title: 12, gate_label: 10 },
    gates: [],
    ...cfg,
  });
  const titles = Array.from(container.querySelectorAll("svg text")).filter((t) => t.textContent === "y" || t.textContent === "x");
  const yTitle = titles.find((t) => t.textContent === "y") as SVGTextElement;
  const xTitle = titles.find((t) => t.textContent === "x") as SVGTextElement;
  return { y: -Number(yTitle.getAttribute("y")), x: Number(xTitle.getAttribute("y")) };
}

describe("axis title distance", () => {
  it("sits a CyTOF (linear-tick) title just past its one-character tick labels", () => {
    // D3's ticks over 0 … 6 are 0, 2, 4, 6: one character at 10 px is 6.2 px wide, plus the
    // tick and inset, a pad and the title's descent.
    const { y } = render({});
    expect(y).toBe(Math.ceil(1 * 10 * 0.62 + 14 + 0.25 * 12));
    expect(y).toBeLessThan(32);
  });

  it("gives a flow axis with listed labels the room its widest label needs", () => {
    const { y } = render({
      y_is_logicle: true,
      y_logicle_ticks: { major_pos: [0, 2, 4, 6], major_labels: ["0", "1K", "10K", "100K"], minor_pos: [], tick_mode: "logicle" },
    });
    expect(y).toBe(Math.ceil(4 * 10 * 0.62 + 14 + 0.25 * 12));
  });

  it("places the x title below the tick labels' descent by the same rule for both", () => {
    const { x: cytof } = render({});
    const { x: flow } = render({
      x_is_logicle: true,
      x_logicle_ticks: { major_pos: [0, 2, 4, 6], major_labels: ["0", "1K", "10K", "100K"], minor_pos: [], tick_mode: "logicle" },
    });
    // H + offset: the renderer adds the inner height, so compare the two, which share it.
    expect(cytof).toBe(flow);
  });

  it("uses a set distance as it is", () => {
    const { y } = render({ y_axis_label_offset: 60 });
    expect(y).toBe(60);
  });
});
