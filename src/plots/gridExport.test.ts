// @vitest-environment jsdom
// The Illustration and Strategy grid export: one group per cell, named by its title, the data
// layer as an image and the cell's own vector overlay, finished for an editor.

import { describe, expect, it, vi } from "vitest";
import { composeGridSVG } from "./gridExport";

vi.mock("./loadPlots", () => ({
  loadMiniPlots: () => ({
    renderMiniPlot: (host: HTMLElement) => {
      const canvas = document.createElement("canvas");
      canvas.toDataURL = () => "data:image/png;base64,export";
      host.appendChild(canvas);
    },
    renderRidgelinePanel: () => {},
  }),
}));

const SVG_NS = "http://www.w3.org/2000/svg";

function rect(el: Element, left: number, top: number, width: number, height: number) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

function cell(title: string, left: number) {
  const node = document.createElement("div");
  node.className = "mini-plot-cell";
  (node as unknown as { __miniPlotCfg: object }).__miniPlotCfg = { plot_size: 200 };
  const canvas = document.createElement("canvas");
  canvas.toDataURL = () => "data:image/png;base64,screen";
  const svg = document.createElementNS(SVG_NS, "svg");
  const text = document.createElementNS(SVG_NS, "text");
  text.textContent = title;
  svg.appendChild(text);
  node.append(canvas, svg);
  rect(node, left, 10, 200, 200);
  return node;
}

describe("composeGridSVG", () => {
  it("names each cell by its title and finishes the page for an editor", () => {
    const grid = document.createElement("div");
    grid.id = "grid-under-test";
    grid.append(cell("Lymphocytes · D1", 10), cell("Singlets · D1", 220));
    rect(grid, 10, 10, 410, 200);
    document.body.appendChild(grid);
    try {
      const composed = composeGridSVG("grid-under-test", 300)!;
      expect([composed.width, composed.height]).toEqual([410, 200]);
      const root = composed.root;
      expect(root.getAttribute("viewBox")).toBe("0 0 410 200");
      expect(root.getAttribute("width")).toBe(`${Number((410 / (96 / 25.4)).toFixed(3))}mm`);
      const cells = [...root.querySelectorAll(":scope > g")];
      expect(cells.map((g) => g.getAttribute("id"))).toEqual(["panel-1-Lymphocytes-D1", "panel-2-Singlets-D1"]);
      expect(cells[1].getAttribute("transform")).toBe("translate(210,0)");
      const image = cells[0].querySelector("image")!;
      expect(image.getAttribute("id")).toBe("panel-1-Lymphocytes-D1-events");
      // The data layer is re-rendered at the export resolution, not the screen's canvas.
      expect(image.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe("data:image/png;base64,export");
      expect(cells[0].querySelector("svg > text")!.getAttribute("id")).toBe("panel-1-Lymphocytes-D1-title");
      expect(cells[0].querySelector("svg > text")!.getAttribute("font-family")).toBe("Arial, Helvetica, sans-serif");
    } finally {
      grid.remove();
    }
  });
});
