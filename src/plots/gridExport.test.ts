// @vitest-environment jsdom
// The Illustration and Strategy grid export: one group per cell, named by its title, the data
// layer as an image and the cell's own vector overlay, finished for an editor.

import { describe, expect, it, vi } from "vitest";
import { composeGridSVG, maxRasterDpi, rasterizeSvg } from "./gridExport";

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

describe("rasterizeSvg", () => {
  /** jsdom draws nothing: an image loads as soon as it is given a source, and a canvas has a context that records nothing. */
  function stubDrawing() {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:page", revokeObjectURL: () => {} }));
    vi.stubGlobal("Image", class { onload: (() => void) | null = null; set src(_url: string) { setTimeout(() => this.onload?.()); } });
    const context = { fillStyle: "", fillRect: () => {}, scale: () => {}, drawImage: () => {} };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  }

  it("draws a page below 96 dpi at that dpi, so the image is the page's size at the dpi written into it", async () => {
    stubDrawing();
    try {
      const root = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
      // An A4 landscape page, 1123 by 794 CSS pixels, at 72 dpi: 842 by 595 pixels.
      const canvas = await rasterizeSvg({ root, width: 1123, height: 794 }, 72);
      expect([canvas.width, canvas.height]).toEqual([842, 595]);
      const at300 = await rasterizeSvg({ root, width: 1123, height: 794 }, 300);
      expect([at300.width, at300.height]).toEqual([3509, 2481]);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});

describe("maxRasterDpi", () => {
  it("is the highest dpi a browser draws a page of this size at as one image", () => {
    // A4 landscape, A3 landscape and A1 landscape at 96 CSS pixels to the inch.
    expect(maxRasterDpi(1123, 794)).toBe(813);
    expect(maxRasterDpi(1587, 1123)).toBe(575);
    expect(maxRasterDpi(3179, 2245)).toBe(287);
    // A long strip is held by its side rather than its area; a small page by the field's 1200.
    expect(maxRasterDpi(8000, 100)).toBe(196);
    expect(maxRasterDpi(200, 200)).toBe(1200);
    for (const [width, height] of [[1587, 1123], [3179, 2245], [8000, 100]]) {
      const scale = maxRasterDpi(width, height) / 96;
      expect(width * scale <= 16384 && height * scale <= 16384 && width * height * scale * scale <= 64_000_000).toBe(true);
    }
  });
});
