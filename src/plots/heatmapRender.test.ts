// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { composeGridSVG } from "./gridExport";
import { loadMiniPlots } from "./loadPlots";

beforeEach(() => {
  document.body.innerHTML = '<div id="illustration-grid-container"></div>';
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (text: string) => ({ width: text.length * 6 }),
    }),
  });
});

describe("shared Illustration heatmap renderer", () => {
  it("renders labelled cells, missing values, a legend, and tooltips", () => {
    loadMiniPlots().renderIllustrationGrid("illustration-grid-container", {
      containerId: "illustration-grid-container",
      plot_type: "heatmap",
      font_sizes: { tick: 8, axis_label: 10, title: 10, gate_label: 8 },
      heatmap: {
        rows: [
          { id: "p1", name: "Barcode population 1", count: 20, values: [0, 1], raw_values: [2, 8] },
          { id: "p2", name: "Barcode population 2", count: 0, values: [null, null], raw_values: [null, null] },
        ],
        channels: [
          { id: "bc1", label: "Pd102 barcode" },
          { id: "bc2", label: "Pd104 barcode" },
        ],
        summary_stat: "median",
        scale_mode: "column_minmax",
        palette: "blue_white_yellow_red",
        cell_size: 30,
        show_values: true,
        legend_min: 0,
        legend_max: 1,
      },
    });

    expect(document.querySelectorAll("g.heatmap-cell-group")).toHaveLength(4);
    expect(document.querySelectorAll(".heatmap-row-labels text")).toHaveLength(2);
    expect(document.querySelectorAll(".heatmap-column-labels text")).toHaveLength(2);
    expect(document.querySelector(".heatmap-row-labels")?.textContent).toContain("Barcode population 1");
    expect(document.querySelector(".heatmap-column-labels")?.textContent).toContain("Pd102 barcode");
    expect(document.querySelector("g.heatmap-cell-group title")?.textContent).toContain("Median: 2.00");
    expect(document.querySelector("linearGradient")).not.toBeNull();
    expect(document.getElementById("illustration-grid-container-grid")).not.toBeNull();

    const grid = document.getElementById("illustration-grid-container-grid") as HTMLElement;
    const cell = grid.querySelector(".mini-plot-cell") as HTMLElement;
    grid.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 240,
      width: 400, height: 240, toJSON: () => ({}),
    });
    cell.getBoundingClientRect = () => ({
      x: 4, y: 4, left: 4, top: 4, right: 396, bottom: 236,
      width: 392, height: 232, toJSON: () => ({}),
    });
    const composed = composeGridSVG("illustration-grid-container-grid", 300);
    expect(composed).not.toBeNull();
    expect(composed?.width).toBe(400);
    expect(composed?.height).toBe(240);
    expect(composed?.root.querySelectorAll("g.heatmap-cell-group")).toHaveLength(4);
    expect(composed?.root.textContent).toContain("Barcode population 1");
    expect(composed?.root.textContent).toContain("Pd102 barcode");
  });
});
