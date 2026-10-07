// @vitest-environment jsdom
// The Layout sheet export composes the page from the live DOM: items in stacking order, plot
// cells as an image plus their own vector overlay, text blocks as <text>, at any on-screen zoom.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { composeLayoutSVG, writeComposedPages } from "./layoutExport";
import { createLayoutSheet, pageForPreset } from "../engine/layout";

const pdfSpy = vi.hoisted(() => ({
  documents: [] as unknown[],
  pages: [] as unknown[][],
  images: [] as unknown[][],
  saved: [] as string[],
  svg: vi.fn(),
  rasters: [] as unknown[],
}));
vi.mock("./gridExport", () => ({
  cellDataUrlAtDpi: (_cell: HTMLElement, dpi: number, size: number) => `data:cell/${dpi}/${size}`,
  rasterizeSvg: async (page: { root: Element }) => { const raster = { canvasFor: page.root }; pdfSpy.rasters.push(raster); return raster; },
}));
vi.mock("jspdf", () => ({
  jsPDF: class {
    constructor(options: unknown) { pdfSpy.documents.push(options); }
    addPage(...args: unknown[]) { pdfSpy.pages.push(args); }
    addImage(...args: unknown[]) { pdfSpy.images.push(args); }
    save(name: string) { pdfSpy.saved.push(name); }
  },
}));
vi.mock("svg2pdf.js", () => ({ svg2pdf: (...args: unknown[]) => pdfSpy.svg(...args) }));

/** jsdom has no layout; every element reports the rectangle it is told to. */
function rect(el: Element, left: number, top: number, width: number, height: number) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

function page(zoom: number) {
  const canvas = document.createElement("section");
  canvas.className = "gl-layout-canvas";
  rect(canvas, 100, 50, 1123 * zoom, 794 * zoom);

  const text = document.createElement("article");
  text.className = "gl-layout-item is-text";
  text.style.zIndex = "2";
  const area = document.createElement("textarea");
  area.className = "gl-layout-text-surface";
  area.value = "Donor D1\nday 7";
  area.style.fontSize = "20px";
  area.style.padding = "2px";
  text.appendChild(area);
  rect(text, 100 + 400 * zoom, 50 + 30 * zoom, 200 * zoom, 60 * zoom);
  rect(area, 100 + 400 * zoom, 50 + 30 * zoom, 200 * zoom, 60 * zoom);

  const plot = document.createElement("article");
  plot.className = "gl-layout-item has-frame";
  plot.style.zIndex = "1";
  plot.dataset.title = "Lymphocytes · D1";
  const host = document.createElement("div");
  host.className = "gl-layout-plot-host";
  (host as unknown as { __miniPlotCfg: object }).__miniPlotCfg = { plot_size: 252 };
  const plotCanvas = document.createElement("canvas");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "path"));
  const hidden = document.createElementNS("http://www.w3.org/2000/svg", "text");
  hidden.setAttribute("style", "display: none; font-size: 9px;");
  svg.appendChild(hidden);
  host.append(plotCanvas, svg);
  plot.appendChild(host);
  rect(plot, 100 + 24 * zoom, 50 + 24 * zoom, 260 * zoom, 280 * zoom);
  rect(host, 100 + 28 * zoom, 50 + 28 * zoom, 252 * zoom, 252 * zoom);
  rect(plotCanvas, 100 + 28 * zoom, 50 + 28 * zoom, 252 * zoom, 252 * zoom);

  // Text first in the DOM, but on top: the composition must order by z.
  canvas.append(text, plot);
  return canvas;
}

describe("composeLayoutSVG", () => {
  it.each([1, 0.5])("composes the page in page pixels at zoom %s", (zoom) => {
    const sheet = createLayoutSheet("Figure 1");
    const { root, width, height } = composeLayoutSVG(page(zoom), sheet, { dpi: 300, zoom });
    expect([width, height]).toEqual([1123, 794]);
    expect(root.getAttribute("viewBox")).toBe("0 0 1123 794");
    const children = [...root.children];
    expect(children[0].tagName).toBe("rect"); // the white page
    // The plot (z = 1) comes before the text (z = 2): its frame, then its cell group.
    const frame = children[1];
    expect(frame.tagName).toBe("rect");
    expect(frame.getAttribute("x")).toBe("24.5");
    expect(frame.getAttribute("width")).toBe("259");
    const group = children[2];
    expect(group.tagName).toBe("g");
    expect(group.getAttribute("transform")).toBe("translate(28,28)");
    const image = group.querySelector("image")!;
    expect(image.getAttribute("width")).toBe("252");
    expect(image.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe("data:cell/300/252");
    expect(image.getAttribute("href")).toBeNull();
    // Finished for an editor: the page in millimetres, the plot and its parts named, one font on every text.
    expect([root.getAttribute("width"), root.getAttribute("height")]).toEqual(["297mm", "210mm"]);
    expect(group.getAttribute("id")).toBe("plot-1-Lymphocytes-D1");
    expect(image.getAttribute("id")).toBe("plot-1-Lymphocytes-D1-events");
    expect(frame.getAttribute("id")).toBe("frame-1-Lymphocytes-D1");
    expect(root.querySelector("g#text-2-Donor-D1-day-7")).not.toBeNull();
    expect(new Set([...root.querySelectorAll("text")].map((t) => t.getAttribute("font-family")))).toEqual(new Set(["Arial, Helvetica, sans-serif"]));
    // The renderer's hidden tick label came along in the clone and is dropped.
    expect(group.querySelectorAll("text")).toHaveLength(0);
    expect(group.querySelector("svg path")).not.toBeNull();
    const texts = [...root.querySelectorAll("text")].map((t) => [t.textContent, t.getAttribute("x"), t.getAttribute("y"), t.getAttribute("font-size")]);
    expect(texts).toEqual([
      ["Donor D1", "402", String(32 + 20 * 0.82), "20"],
      ["day 7", "402", String(32 + 26 + 20 * 0.82), "20"],
    ]);
  });

  it("sizes the page from the sheet, not from the DOM", () => {
    const sheet = createLayoutSheet("Panel", pageForPreset("journal-1", "portrait"));
    const { width, height, widthMm, heightMm } = composeLayoutSVG(page(1), sheet, { dpi: 300, zoom: 1 });
    expect([width, height]).toEqual([321, 416]);
    expect([widthMm, heightMm]).toEqual([85, 110]);
  });

  it.each([1, 0.5])("cropped, is the items plus the padding, with every coordinate moved up by the crop, at zoom %s", (zoom) => {
    const sheet = createLayoutSheet("Figure 1");
    // The plot frame spans 24..284 × 24..304 and the text 400..600 × 30..90: the union is
    // 24..600 × 24..304, and 3 mm of padding is 11.34 px on each side, to whole pixels outward.
    const { root, width, height, widthMm, heightMm } = composeLayoutSVG(page(zoom), sheet, { dpi: 300, zoom, crop: { paddingMm: 3 } });
    expect([width, height]).toEqual([600, 304]);
    expect(root.getAttribute("viewBox")).toBe("0 0 600 304");
    expect(widthMm).toBeCloseTo(600 / (96 / 25.4), 6);
    expect(heightMm).toBeCloseTo(304 / (96 / 25.4), 6);
    expect(root.getAttribute("width")).toBe("158.75mm");
    const frame = root.querySelector("rect#frame-1-Lymphocytes-D1")!;
    expect([frame.getAttribute("x"), frame.getAttribute("y")]).toEqual(["12.5", "12.5"]);
    expect(root.querySelector("g#plot-1-Lymphocytes-D1")!.getAttribute("transform")).toBe("translate(16,16)");
    const texts = [...root.querySelectorAll("text")].map((t) => [t.textContent, t.getAttribute("x"), t.getAttribute("y")]);
    expect(texts[0]).toEqual(["Donor D1", "390", String(20 + 20 * 0.82)]);
  });

  it("cropped, stops at the page's edge and writes the page whole when nothing is on it", () => {
    const sheet = createLayoutSheet("Figure 1");
    const canvas = page(1);
    // An item in the top-left corner: the padding cannot go beyond the page.
    const plot = canvas.querySelector<HTMLElement>(".gl-layout-item.has-frame")!;
    rect(plot, 100 + 2, 50 + 2, 260, 280);
    const cropped = composeLayoutSVG(canvas, sheet, { dpi: 300, zoom: 1, crop: { paddingMm: 10 } });
    expect(cropped.root.querySelector("rect#frame-1-Lymphocytes-D1")!.getAttribute("x")).toBe("2.5");
    expect(cropped.width).toBe(600 + Math.ceil(10 * 96 / 25.4));
    sheet.page = { ...sheet.page, columns: 1, rows: 2 };
    const empty = composeLayoutSVG(canvas, sheet, { dpi: 300, zoom: 1, pageIndex: 1, crop: { paddingMm: 3 } });
    expect([empty.width, empty.height]).toEqual([1123, 794]);
    expect(empty.root.querySelectorAll("g, text")).toHaveLength(0);
  });
});

describe("writeComposedPages as PDF", () => {
  const svgNs = "http://www.w3.org/2000/svg";
  const composed = () => [1, 2].map(() => ({ root: document.createElementNS(svgNs, "svg") as SVGSVGElement, width: 1123, height: 794, widthMm: 297, heightMm: 210 }));
  const a4 = { width: 297 * (72 / 25.4), height: 210 * (72 / 25.4) };
  beforeEach(() => {
    pdfSpy.documents = []; pdfSpy.pages = []; pdfSpy.images = []; pdfSpy.saved = []; pdfSpy.rasters = [];
    pdfSpy.svg.mockReset();
  });

  it("writes every page as vector art at the sheet's physical size in points, one PDF page each", async () => {
    pdfSpy.svg.mockResolvedValue(undefined);
    const sheet = createLayoutSheet("Figure 1");
    const pages = composed();
    await writeComposedPages(pages, sheet, "pdf");
    expect(pdfSpy.svg).toHaveBeenCalledTimes(2);
    expect(pdfSpy.svg.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      [pages[0].root, { x: 0, y: 0, ...a4 }],
      [pages[1].root, { x: 0, y: 0, ...a4 }],
    ]);
    // The document is in points: in millimetres the writer scales an em offset by the unit's
    // factor, and D3's tick labels, 0.71 em under the axis, land on the axis title.
    expect(pdfSpy.documents).toEqual([{ orientation: "landscape", unit: "pt", format: [a4.width, a4.height], compress: true }]);
    expect(pdfSpy.pages).toEqual([[[a4.width, a4.height], "landscape"]]);
    expect(pdfSpy.images).toEqual([]);
    expect(pdfSpy.saved).toEqual(["Figure_1.pdf"]);
    // The writer measures the page attached to the document, and leaves nothing behind.
    expect(document.body.querySelector("svg")).toBeNull();
  });

  it("gives each cropped page its own size", async () => {
    pdfSpy.svg.mockResolvedValue(undefined);
    const pages = composed();
    pages[1] = { ...pages[1], width: 400, height: 500, widthMm: 100, heightMm: 125 };
    await writeComposedPages(pages, createLayoutSheet("Figure 1"), "pdf");
    const second = { width: 100 * (72 / 25.4), height: 125 * (72 / 25.4) };
    expect(pdfSpy.pages).toEqual([[[second.width, second.height], "portrait"]]);
    expect(pdfSpy.svg.mock.calls[1][2]).toEqual({ x: 0, y: 0, ...second });
  });

  it("draws a page the writer cannot take as one deflated raster instead", async () => {
    pdfSpy.svg.mockRejectedValueOnce(new Error("no")).mockResolvedValueOnce(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeComposedPages(composed(), createLayoutSheet("Figure 1"), "pdf");
    } finally {
      warn.mockRestore();
    }
    expect(pdfSpy.images).toEqual([[pdfSpy.rasters[0], "PNG", 0, 0, a4.width, a4.height, undefined, "FAST"]]);
    expect(pdfSpy.rasters).toHaveLength(1);
  });
});

describe("composeLayoutSVG on a grid of pages", () => {
  it("writes the second page with the sheet's coordinates shifted by one page width, leaving items on other pages out", () => {
    const sheet = createLayoutSheet("Grid");
    sheet.page = { ...sheet.page, columns: 2, rows: 1 };
    const canvas = page(1);
    // Move the text item onto the second page (x = 1123 + 100).
    const text = canvas.querySelector<HTMLElement>(".gl-layout-item.is-text")!;
    const area = text.querySelector<HTMLElement>(".gl-layout-text-surface")!;
    rect(text, 100 + 1223, 50 + 30, 200, 60);
    rect(area, 100 + 1223, 50 + 30, 200, 60);
    const first = composeLayoutSVG(canvas, sheet, { dpi: 300, zoom: 1, pageIndex: 0 });
    expect(first.root.querySelectorAll("text")).toHaveLength(0);
    expect(first.root.querySelector("image")).not.toBeNull();
    const second = composeLayoutSVG(canvas, sheet, { dpi: 300, zoom: 1, pageIndex: 1 });
    expect(second.root.querySelector("image")).toBeNull();
    const texts = [...second.root.querySelectorAll("text")].map((t) => [t.textContent, t.getAttribute("x")]);
    expect(texts).toEqual([["Donor D1", "102"], ["day 7", "102"]]);
  });
});
