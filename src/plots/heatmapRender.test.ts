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
      font_sizes: { tick: 9, axis_label: 12, title: 12, gate_label: 10 },
      scale_fonts_with_plot: true,
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
    const gradientStops = [...document.querySelectorAll("stop")];
    expect(gradientStops).toHaveLength(11);
    expect(gradientStops[0]?.getAttribute("stop-color")).toBe("#313695");
    expect(gradientStops.at(-1)?.getAttribute("stop-color")).toBe("#a50026");
    const filledCells = [...document.querySelectorAll("g.heatmap-cell-group rect")];
    expect(filledCells[0]?.getAttribute("fill")).toBe("rgb(49, 54, 149)");
    expect(filledCells[1]?.getAttribute("fill")).toBe("rgb(165, 0, 38)");
    expect((document.querySelector(".heatmap-row-labels text") as SVGTextElement).style.fontSize).toBe("12px");
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

  it("scales base typography with heatmap size and allows exact manual fonts", () => {
    const payload = (scaleFontsWithPlot: boolean) => ({
      containerId: "illustration-grid-container",
      plot_type: "heatmap",
      font_sizes: { tick: 9, axis_label: 12, title: 12, gate_label: 10 },
      scale_fonts_with_plot: scaleFontsWithPlot,
      heatmap: {
        rows: [{ id: "p1", name: "Population 1", count: 20, values: [0.5], raw_values: [3] }],
        channels: [{ id: "bc1", label: "Barcode 1" }],
        summary_stat: "median",
        scale_mode: "column_minmax",
        palette: "blue_white_yellow_red",
        cell_size: 60,
        show_values: false,
        legend_min: 0,
        legend_max: 1,
      },
    });

    loadMiniPlots().renderIllustrationGrid("illustration-grid-container", payload(true));
    expect((document.querySelector(".heatmap-row-labels text") as SVGTextElement).style.fontSize).toBe("17px");
    expect((document.querySelector(".tick text") as SVGTextElement | null)?.style.fontSize).toBe("12.5px");

    loadMiniPlots().renderIllustrationGrid("illustration-grid-container", payload(false));
    expect((document.querySelector(".heatmap-row-labels text") as SVGTextElement).style.fontSize).toBe("12px");
  });
});
