// @vitest-environment jsdom
// The Layout sheet export composes the page from the live DOM: items in stacking order, plot
// cells as an image plus their own vector overlay, text blocks as <text>, at any on-screen zoom.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { composeLayoutSVG, writeComposedPages } from "./layoutExport";
import { createLayoutSheet, pageForPreset } from "../engine/layout";
import { fillLabel, keepLayoutCanvas } from "./layoutCanvasExport";

const pdfSpy = vi.hoisted(() => ({
  documents: [] as unknown[],
  pages: [] as unknown[][],
  images: [] as unknown[][],
  saved: [] as string[],
  svg: vi.fn(),
  rasters: [] as unknown[],
  deleted: [] as number[],
}));
vi.mock("./gridExport", async (original) => ({
  maxRasterDpi: (await original<typeof import("./gridExport")>()).maxRasterDpi,
  cellDataUrlAtDpi: (_cell: HTMLElement, dpi: number, size: number) => `data:cell/${dpi}/${size}`,
  rasterizeSvg: async (page: { root: Element }, dpi: number) => { const raster = { canvasFor: page.root, dpi }; pdfSpy.rasters.push(raster); return raster; },
}));
vi.mock("jspdf", () => ({
  jsPDF: class {
    size: number[];
    constructor(options: { format: number[] }) { pdfSpy.documents.push(options); this.size = options.format; }
    addPage(...args: unknown[]) { pdfSpy.pages.push(args); this.size = args[0] as number[]; }
    // What a page the writer stopped on is replaced through.
    internal = { pageSize: { getWidth: () => this.size[0], getHeight: () => this.size[1] } };
    isAdvancedAPI() { return false; }
    getNumberOfPages() { return 1 + pdfSpy.pages.length - pdfSpy.deleted.length; }
    deletePage(page: number) { pdfSpy.deleted.push(page); }
    addImage(...args: unknown[]) { pdfSpy.images.push(args); }
    save(name: string) { pdfSpy.saved.push(name); }
  },
}));
vi.mock("svg2pdf.js", () => ({ svg2pdf: (...args: unknown[]) => pdfSpy.svg(...args) }));
const zipSpy = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock("fflate", async (original) => {
  const real = await original<typeof import("fflate")>();
  return { ...real, zipSync: (files: Record<string, Uint8Array>) => { zipSpy.names = Object.keys(files); return real.zipSync(files); } };
});

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

  it.each([1, 0.5])("measures from inside the page's edge line, where the items are placed from, at zoom %s", (zoom) => {
    const canvas = page(zoom);
    // The page's 1 px edge line lies outside what is placed on it.
    Object.defineProperty(canvas, "clientLeft", { value: 1 });
    Object.defineProperty(canvas, "clientTop", { value: 1 });
    rect(canvas, 100 - zoom, 50 - zoom, 1125 * zoom, 796 * zoom);
    const { root } = composeLayoutSVG(canvas, createLayoutSheet("Figure 1"), { dpi: 300, zoom });
    expect(root.children[2].getAttribute("transform")).toBe("translate(28,28)");
    expect(root.querySelector("text")!.getAttribute("x")).toBe("402");
  });

  it("draws the data layer of a plot shown scaled at the size the plot was drawn at, where its events sit under its gates", () => {
    // A 252 px plot shown at half size: an item's zoom, or a strategy block fitted to its frame.
    const canvas = page(1);
    const host = canvas.querySelector<HTMLElement>(".gl-layout-plot-host")!;
    const plotCanvas = host.querySelector("canvas")!;
    rect(host, 100 + 28, 50 + 28, 126, 126);
    rect(plotCanvas, 100 + 28, 50 + 28, 126, 126);
    // Layout sizes are before any zoom.
    Object.defineProperty(plotCanvas, "offsetWidth", { value: 252 });
    Object.defineProperty(host.querySelector("svg")!, "clientWidth", { value: 252 });
    const { root } = composeLayoutSVG(canvas, createLayoutSheet("Figure 1"), { dpi: 300, zoom: 1 });
    const group = root.querySelector("g#plot-1-Lymphocytes-D1")!;
    const image = group.querySelector("image")!;
    // Drawn at 252 px, as on screen, with half the pixels to the inch a 252 px image would need,
    // and placed at the 126 px it is shown at; the axes and gates are the plot's own, scaled alike.
    expect(image.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe("data:cell/150/252");
    expect([image.getAttribute("width"), image.getAttribute("height")]).toEqual(["126", "126"]);
    expect(group.querySelector("g[transform='scale(0.5)'] > svg")).not.toBeNull();
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
    pdfSpy.documents = []; pdfSpy.pages = []; pdfSpy.images = []; pdfSpy.saved = []; pdfSpy.rasters = []; pdfSpy.deleted = [];
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
    // The page the writer stopped on is replaced with an empty one of its size before the image is drawn.
    expect(pdfSpy.deleted).toEqual([1]);
    expect(pdfSpy.pages).toEqual([[[a4.width, a4.height], "landscape"], [[a4.width, a4.height], "landscape"]]);
  });

  it("reports which pages it drew as an image, for the export's message", async () => {
    pdfSpy.svg.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("no"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await writeComposedPages(composed(), createLayoutSheet("Figure 1"), "pdf")).toEqual({ loweredDpi: null, rasterPages: [2] });
    } finally {
      warn.mockRestore();
    }
  });

  it("draws a page as an image at the most a browser can draw, not failing the export, and says so", async () => {
    pdfSpy.svg.mockRejectedValue(new Error("no"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sheet = createLayoutSheet("Figure 1");
    sheet.page = { ...sheet.page, dpi: 600 };
    const a3 = { root: document.createElementNS(svgNs, "svg") as SVGSVGElement, width: 1587, height: 1123, widthMm: 420, heightMm: 297 };
    let report;
    try {
      report = await writeComposedPages([composed()[0], a3], sheet, "pdf");
    } finally {
      warn.mockRestore();
    }
    // The A4 page fits at 600 dpi; the A3 page, 1587 by 1123 CSS pixels, is drawn at 575.
    expect(pdfSpy.rasters.map((raster) => (raster as { dpi: number }).dpi)).toEqual([600, 575]);
    expect(pdfSpy.saved).toEqual(["Figure_1.pdf"]);
    expect(report).toEqual({ loweredDpi: 575, rasterPages: [1, 2] });
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

describe("composeLayoutSVG, a figure block's headings", () => {
  // jsdom lays nothing out and measures no line boxes: each heading is placed from its own box,
  // padding and alignment, as the page shows a heading on one line.
  function figure(zoom: number) {
    const canvas = document.createElement("section");
    rect(canvas, 100, 50, 1123 * zoom, 794 * zoom);
    const item = document.createElement("article");
    item.className = "gl-layout-item";
    item.style.zIndex = "1";
    item.dataset.title = "Figure";
    const host = document.createElement("div");
    host.className = "gl-layout-plot-host";
    const table = document.createElement("table");
    table.className = "gl-figure-grid";
    const column = document.createElement("th");
    column.className = "illustration-row-header";
    column.textContent = "CD4_positive";
    Object.assign(column.style, { textAlign: "center", padding: "0px 4px", fontSize: "12px" });
    const row = document.createElement("th");
    row.className = "illustration-row-header gl-figure-row-heading";
    row.textContent = "D1";
    Object.assign(row.style, { textAlign: "left", paddingTop: "20px", paddingLeft: "0px", fontSize: "12px" });
    table.append(column, row);
    host.appendChild(table);
    item.appendChild(host);
    canvas.appendChild(item);
    rect(item, 100 + 20 * zoom, 50 + 20 * zoom, 400 * zoom, 300 * zoom);
    // Laid out at 200 and 100 px wide, before the canvas zoom.
    Object.defineProperty(column, "offsetWidth", { value: 200 });
    Object.defineProperty(row, "offsetWidth", { value: 100 });
    rect(column, 100 + 140 * zoom, 50 + 30 * zoom, 200 * zoom, 20 * zoom);
    rect(row, 100 + 30 * zoom, 50 + 60 * zoom, 100 * zoom, 120 * zoom);
    return canvas;
  }

  it.each([1, 0.5])("writes a centred heading at its centre and a row heading below its padding, at zoom %s", (zoom) => {
    const { root } = composeLayoutSVG(figure(zoom), createLayoutSheet("Figure 1"), { dpi: 96, zoom });
    const texts = [...root.querySelectorAll("text")].map((t) => [t.textContent, t.getAttribute("x"), t.getAttribute("y"), t.getAttribute("text-anchor")]);
    expect(texts).toEqual([
      ["CD4_positive", "240", String(30 + 12 * 0.82), "middle"],
      ["D1", "30", String(60 + 20 + 12 * 0.82), null],
    ]);
  });
});

describe("composeLayoutSVG, a named shape", () => {
  const svgNs = "http://www.w3.org/2000/svg";
  function shape(name: string | undefined, z: number) {
    const item = document.createElement("article");
    item.className = "gl-layout-item";
    item.style.zIndex = String(z);
    if (name) item.dataset.objectName = name;
    item.dataset.title = "Line";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("class", "gl-layout-shape");
    const art = document.createElementNS(svgNs, "g");
    art.setAttribute("class", "gl-layout-shape-art");
    art.appendChild(document.createElementNS(svgNs, "line"));
    svg.appendChild(art);
    item.appendChild(svg);
    rect(item, 100 + 10 * z, 50 + 10, 40, 20);
    return item;
  }

  it("takes its name as its id, made unique within the file; an unnamed shape keeps the export's own id", () => {
    const canvas = document.createElement("section");
    rect(canvas, 100, 50, 1123, 794);
    canvas.append(shape("Arrow to CD4_positive", 1), shape("Arrow to CD4_positive", 2), shape(undefined, 3));
    const { root } = composeLayoutSVG(canvas, createLayoutSheet("Figure 1"), { dpi: 96, zoom: 1 });
    expect([...root.querySelectorAll("g")].map((g) => g.getAttribute("id"))).toEqual([
      "Arrow-to-CD4_positive",
      "Arrow-to-CD4_positive-2",
      "shape-3-Line",
    ]);
  });
});

describe("writeComposedPages as a zip", () => {
  it("names each page of an iteration by what it is drawn for", async () => {
    const svgNs = "http://www.w3.org/2000/svg";
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    const page = (label?: string) => ({ root: document.createElementNS(svgNs, "svg") as SVGSVGElement, width: 10, height: 10, widthMm: 3, heightMm: 3, ...(label ? { label } : {}) });
    await writeComposedPages([page("D1.fcs"), page("day 7 / D2"), page()], createLayoutSheet("Figure 1"), "svg");
    expect(zipSpy.names).toEqual(["Figure_1-p1-D1.fcs.svg", "Figure_1-p2-day_7___D2.svg", "Figure_1-p3.svg"]);
    vi.unstubAllGlobals();
  });
});

describe("composeLayoutSVG with an image wall or a cell panel", () => {
  const xlink = "http://www.w3.org/1999/xlink";
  /** A canvas context that records what is drawn on it; jsdom has none of its own. */
  function fakeContext() {
    const calls: string[] = [];
    const ctx = {
      font: "10px sans-serif", fillStyle: "#000000", strokeStyle: "#000000", lineWidth: 1, textAlign: "start", textBaseline: "alphabetic",
      setTransform: (...args: number[]) => calls.push(`setTransform(${args.join(",")})`),
      fillRect: (...args: number[]) => calls.push(`fillRect(${args.join(",")})`),
      fillText: (text: string) => calls.push(`fillText(${text})`),
      measureText: (text: string) => ({ width: text.length * 6 }),
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
  }

  /** A page with one image wall drawn at 400 × 300 and shown at half that, at (50, 60) on the page. */
  function wallPage(kind: "imagewall" | "cellpanel", drawn: boolean) {
    const canvas = document.createElement("section");
    rect(canvas, 0, 0, 1123, 794);
    const item = document.createElement("article");
    item.className = "gl-layout-item";
    item.dataset.title = "Cells of sample_A";
    item.dataset.zoom = "0.5";
    const host = document.createElement("div");
    host.className = `gl-layout-${kind}`;
    const wall = document.createElement("canvas");
    wall.toDataURL = () => "data:shown";
    host.appendChild(wall);
    item.appendChild(host);
    canvas.appendChild(item);
    rect(item, 46, 56, 208, 158);
    rect(wall, 50, 60, 200, 150);
    if (drawn) {
      keepLayoutCanvas(wall, {
        width: 400,
        height: 300,
        draw: (ctx, labels) => {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, 400, 300);
          ctx.fillStyle = "#1a1a1a";
          ctx.font = "600 12px Helvetica Neue, Helvetica, Arial, sans-serif";
          fillLabel(ctx, labels, "CD4_positive", 8, 20);
          ctx.fillStyle = "#333";
          ctx.font = "10px Helvetica Neue, Helvetica, Arial, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          fillLabel(ctx, labels, "D1", 100, 50);
        },
      });
    }
    return canvas;
  }

  it.each(["imagewall", "cellpanel"] as const)("writes a %s where it is shown: its tiles drawn again at the page's dpi, its words as text", (kind) => {
    const { ctx, calls } = fakeContext();
    const made: HTMLCanvasElement[] = [];
    const create = document.createElement.bind(document);
    const spy = vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const el = create(tag);
      if (tag === "canvas") {
        (el as HTMLCanvasElement).getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
        (el as HTMLCanvasElement).toDataURL = () => "data:tiles";
        made.push(el as HTMLCanvasElement);
      }
      return el;
    }) as typeof document.createElement);
    try {
      const { root } = composeLayoutSVG(wallPage(kind, true), createLayoutSheet("Figure 1"), { dpi: 300, zoom: 1 });
      const group = root.querySelector(`g#${kind}-1-Cells-of-sample_A`)!;
      expect(group.getAttribute("transform")).toBe("translate(50,60)");
      const image = group.querySelector("image")!;
      expect([image.getAttribute("width"), image.getAttribute("height")]).toEqual(["200", "150"]);
      expect(image.getAttributeNS(xlink, "href")).toBe("data:tiles");
      // Shown at half its natural size, at 300 dpi: 1.5625 pixels to the drawing's unit.
      expect([made.at(-1)!.width, made.at(-1)!.height]).toEqual([625, 469]);
      expect(calls[0]).toBe("setTransform(1.5625,0,0,1.5625,0,0)");
      expect(calls.some((call) => call.startsWith("fillText"))).toBe(false);
      // The words at the natural size, scaled with the drawing.
      const words = group.querySelector("g[transform='scale(0.5)']")!;
      const texts = [...words.querySelectorAll("text")].map((t) => [t.textContent, t.getAttribute("x"), t.getAttribute("y"), t.getAttribute("font-size"), t.getAttribute("font-weight"), t.getAttribute("text-anchor"), t.getAttribute("fill")]);
      expect(texts).toEqual([
        ["CD4_positive", "8", "20", "12", "bold", null, "#1a1a1a"],
        ["D1", "100", "53.5", "10", "normal", "middle", "#333"],
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("writes a wall not drawn yet as the canvas shows it", () => {
    const { root } = composeLayoutSVG(wallPage("imagewall", false), createLayoutSheet("Figure 1"), { dpi: 300, zoom: 1 });
    const image = root.querySelector("g#imagewall-1-Cells-of-sample_A image")!;
    expect(image.getAttributeNS(xlink, "href")).toBe("data:shown");
    expect(root.querySelectorAll("text")).toHaveLength(0);
  });
});

describe("composeLayoutSVG with a chart panel in a figure block", () => {
  it("copies a violin, box, statistic or composition panel as vector art where the zoomed grid shows it", () => {
    const svgNs = "http://www.w3.org/2000/svg";
    const canvas = document.createElement("section");
    rect(canvas, 0, 0, 1123, 794);
    const item = document.createElement("article");
    item.className = "gl-layout-item";
    item.dataset.title = "Figure";
    const host = document.createElement("div");
    host.className = "gl-layout-plot-host gl-layout-figure-host";
    const grid = document.createElement("div");
    grid.className = "gl-figure-grid";
    const chart = document.createElement("div");
    chart.className = "gl-figure-chart";
    chart.setAttribute("aria-label", "CD4_positive; 120 cells");
    const panel = document.createElementNS(svgNs, "svg");
    panel.setAttribute("class", "gl-prop-panel");
    panel.setAttribute("width", "200");
    panel.setAttribute("height", "160");
    panel.appendChild(document.createElementNS(svgNs, "path"));
    chart.appendChild(panel);
    grid.appendChild(chart);
    host.appendChild(grid);
    item.appendChild(host);
    canvas.appendChild(item);
    rect(item, 10, 10, 300, 300);
    // The grid is zoomed to half its size to fit the block's frame.
    rect(panel, 40, 30, 100, 80);
    const { root } = composeLayoutSVG(canvas, createLayoutSheet("Figure 1"), { dpi: 300, zoom: 1 });
    const group = root.querySelector("g#figure-1-Figure-chart-1")!;
    expect(group).not.toBeNull();
    expect(group.getAttribute("transform")).toBe("translate(40,30) scale(0.5)");
    expect(group.querySelector("svg path")).not.toBeNull();
  });
});
