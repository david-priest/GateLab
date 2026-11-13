// @vitest-environment jsdom
// Turned text blocks and placed images in the Layout export: the item's own group carries a rotate
// transform about the frame's centre, and its content is written upright in the frame turned back
// (width and height swapped for a quarter turn): a text block as one <text> per line, a placed SVG
// as a nested vector <svg>. The PDF writer draws both under the turn. Synthetic identifiers only.

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeLayoutSVG } from "./layoutExport";
import { pdfVectorPage } from "./exportSvg";
import { unturnedBox } from "./layoutRotationExport";
import { createLayoutSheet } from "../engine/layout";
import type { LayoutPlacedImageRecipe } from "../engine/placedImageBlock";
import { LayoutPlacedImageView } from "../ui/layout/LayoutPlacedImage";

vi.mock("./gridExport", () => ({ cellDataUrlAtDpi: () => "data:", rasterizeSvg: async () => ({}) }));
// @ts-expect-error -- the ES build has no declaration file of its own; the package's types describe it.
vi.mock("svg2pdf.js", () => import("svg2pdf.js/dist/svg2pdf.es.min.js"));

function rect(el: Element, left: number, top: number, width: number, height: number) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

const SCHEMATIC = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect fill="#336699" x="0" y="0" width="40" height="10"/></svg>';
const schematic: LayoutPlacedImageRecipe = { kind: "image", fileName: "schematic_D1.svg", mediaType: "image/svg+xml", naturalWidth: 40, naturalHeight: 20, content: SCHEMATIC };

/** An item as the Layout tab draws it, turned: the article upright at the frame, the content in a turned box. */
function item(canvas: Element, turn: number, frame: [number, number, number, number], z: number) {
  const article = document.createElement("article");
  article.className = "gl-layout-item";
  article.style.zIndex = String(z);
  article.dataset.rotation = String(turn);
  const body = document.createElement("div");
  body.className = "gl-layout-item-body";
  const box = document.createElement("div");
  box.className = "gl-layout-turned";
  body.appendChild(box);
  article.appendChild(body);
  canvas.appendChild(article);
  rect(article, ...frame);
  return { article, box };
}

function page() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const canvas = document.createElement("section");
  rect(canvas, 0, 0, 1123, 794);
  // A row label turned 90°: a tall narrow frame at 100, 50, its two lines laid out along the frame's height.
  const label = item(canvas, 90, [100, 50, 32, 160], 0);
  label.article.classList.add("is-text");
  label.article.dataset.title = "CD4_positive";
  const surface = document.createElement("div");
  surface.className = "gl-layout-text-surface is-static";
  Object.assign(surface.style, { fontSize: "10px", padding: "2px" });
  surface.textContent = "CD4_positive\nD1";
  label.box.appendChild(surface);
  // As measured on the page, the turned surface covers the frame.
  rect(surface, 100, 50, 32, 160);
  // A placed SVG turned 90°, its frame 40 × 80 at 300, 50.
  const art = item(canvas, 90, [300, 50, 40, 80], 1);
  art.article.dataset.title = "schematic_D1.svg";
  act(() => createRoot(art.box).render(createElement(LayoutPlacedImageView, { recipe: schematic })));
  document.body.appendChild(canvas);
  return canvas;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("Turned items in the Layout export", () => {
  it("turns a box drawn in a turned frame back about the frame's centre", () => {
    const frame = { left: 100, top: 50, width: 32, height: 160 };
    expect(unturnedBox(frame, frame, 0)).toBe(frame);
    expect(unturnedBox(frame, frame, 90)).toEqual({ left: 36, top: 114, width: 160, height: 32 });
    expect(unturnedBox(frame, frame, 270)).toEqual({ left: 36, top: 114, width: 160, height: 32 });
    expect(unturnedBox(frame, frame, 180)).toEqual(frame);
    // A box off the centre: the right end of a frame turned 90° is the top of the upright content.
    expect(unturnedBox({ left: 122, top: 50, width: 10, height: 160 }, frame, 90)).toEqual({ left: 36, top: 114, width: 160, height: 10 });
  });

  it("writes a turned text block as one <text> per line under a rotate transform on its group", () => {
    const { root } = composeLayoutSVG(page(), createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    const block = root.querySelector(":scope > g[id^='text-']")!;
    expect(block.getAttribute("transform")).toBe("rotate(90 116 130)");
    const lines = [...block.querySelectorAll(":scope > text")];
    expect(lines.map((t) => t.textContent)).toEqual(["CD4_positive", "D1"]);
    // Upright in the frame turned back: 160 wide and 32 high, from 36, 114, inside its 2 px padding.
    expect(lines.map((t) => [t.getAttribute("x"), Number(t.getAttribute("y")).toFixed(2)])).toEqual([["38", (116 + 8.2).toFixed(2)], ["38", (116 + 13 + 8.2).toFixed(2)]]);
  });

  it("keeps a turned block's formatting: a superscript stays a raised tspan, centred alignment anchors in the upright box", () => {
    const canvas = page();
    const surface = canvas.querySelector<HTMLElement>(".gl-layout-text-surface")!;
    surface.innerHTML = "<b>CD4</b><sup>+</sup>";
    surface.style.textAlign = "center";
    const { root } = composeLayoutSVG(canvas, createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    const block = root.querySelector(":scope > g[id^='text-']")!;
    expect(block.getAttribute("transform")).toBe("rotate(90 116 130)");
    const lines = block.querySelectorAll(":scope > text");
    expect(lines).toHaveLength(1);
    // The centre of the upright box, 36 + 2 + 156 / 2.
    expect([lines[0].getAttribute("x"), lines[0].getAttribute("text-anchor")]).toEqual(["116", "middle"]);
    expect([...lines[0].querySelectorAll("tspan")].map((s) => [s.textContent, s.getAttribute("dy")])).toEqual([["CD4", null], ["+", "-3.3"]]);
  });

  it("writes a turned placed SVG as a nested vector <svg> under a rotate transform on its group", () => {
    const { root } = composeLayoutSVG(page(), createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    const group = root.querySelector(":scope > g[id^='image-']")!;
    expect(group.getAttribute("transform")).toBe("rotate(90 320 90)");
    const nested = group.querySelector(":scope > svg")!;
    expect(["x", "y", "width", "height", "viewBox"].map((name) => nested.getAttribute(name))).toEqual(["280", "70", "80", "40", "0 0 40 20"]);
    expect(nested.querySelector("rect")).not.toBeNull();
    expect(root.querySelector("image")).toBeNull();
  });

  it("is drawn by the PDF writer under the turn, text as text and the SVG as paths", async () => {
    const { root } = composeLayoutSVG(page(), createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    // The writer measures text with getBBox, which the test runner's document lacks: one that measures 5 px a character.
    Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value(this: SVGElement) { return { x: 0, y: 0, width: (this.textContent ?? "").length * 5, height: 10 }; } });
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: [842, 595], compress: false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await pdfVectorPage(pdf, root, { width: 842, height: 595 })).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    const content = pdf.output();
    // A quarter turn: each line's text matrix and the SVG's drawing matrix have no diagonal, only the turn.
    expect(content).toMatch(/\n0\. [\d.]+ [\d.]+ -0\. [\d.]+ [\d.]+ Tm\n\(CD4_positive\) Tj/);
    expect(content).toMatch(/\n0\. [\d.]+ [\d.]+ -0\. [\d.]+ [\d.]+ Tm\n\(D1\) Tj/);
    expect(content).toMatch(/0\. [\d.]+ -[\d.]+ 0\. [-\d.]+ [-\d.]+ cm\n[\s\S]*?0\.2 0\.4 0\.6 rg/);
    warn.mockRestore();
    delete (SVGElement.prototype as { getBBox?: unknown }).getBBox;
  });
});
