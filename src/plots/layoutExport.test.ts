// @vitest-environment jsdom
// The Layout sheet export composes the page from the live DOM: items in stacking order, plot
// cells as an image plus their own vector overlay, text blocks as <text>, at any on-screen zoom.

import { describe, expect, it, vi } from "vitest";
import { composeLayoutSVG } from "./layoutExport";
import { createLayoutSheet, pageForPreset } from "../engine/layout";

vi.mock("./gridExport", () => ({
  cellDataUrlAtDpi: (_cell: HTMLElement, dpi: number, size: number) => `data:cell/${dpi}/${size}`,
  rasterizeSvg: vi.fn(),
}));

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
  const host = document.createElement("div");
  host.className = "gl-layout-plot-host";
  (host as unknown as { __miniPlotCfg: object }).__miniPlotCfg = { plot_size: 252 };
  const plotCanvas = document.createElement("canvas");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "path"));
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
    expect(image.getAttribute("href")).toBe("data:cell/300/252");
    expect(group.querySelector("svg path")).not.toBeNull();
    const texts = [...root.querySelectorAll("text")].map((t) => [t.textContent, t.getAttribute("x"), t.getAttribute("y"), t.getAttribute("font-size")]);
    expect(texts).toEqual([
      ["Donor D1", "402", String(32 + 20 * 0.82), "20"],
      ["day 7", "402", String(32 + 26 + 20 * 0.82), "20"],
    ]);
  });

  it("sizes the page from the sheet, not from the DOM", () => {
    const sheet = createLayoutSheet("Panel", pageForPreset("journal-1", "portrait"));
    const { width, height } = composeLayoutSVG(page(1), sheet, { dpi: 300, zoom: 1 });
    expect([width, height]).toEqual([321, 416]);
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
