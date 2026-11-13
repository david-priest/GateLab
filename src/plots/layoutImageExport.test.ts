// @vitest-environment jsdom
// Placed images in the Layout export: a placed SVG is a nested <svg> with its viewBox, vector art
// made safe (no script, foreignObject, handler or outside reference), its ids prefixed and its
// style rules confined to it; a PNG is an <image> of its data URL; each at its item's place and
// size. The PDF writer (svg2pdf, as the export calls it) draws the SVG as vector paths in its own
// colours and embeds the PNG as an image.

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { composeLayoutSVG } from "./layoutExport";
import { pdfVectorPage } from "./exportSvg";
import { createLayoutSheet } from "../engine/layout";
import type { LayoutPlacedImageRecipe } from "../engine/placedImageBlock";
import { LayoutPlacedImageView } from "../ui/layout/LayoutPlacedImage";
import { HOSTILE_SVG } from "../ui/layout/placedImage.fixtures";

vi.mock("./gridExport", () => ({ cellDataUrlAtDpi: () => "data:", rasterizeSvg: async () => ({}) }));
// The PDF writer's ES build, as the app's bundle takes it; the test runner would otherwise load its UMD build.
// @ts-expect-error -- the ES build has no declaration file of its own; the package's types describe it.
vi.mock("svg2pdf.js", () => import("svg2pdf.js/dist/svg2pdf.es.min.js"));

function rect(el: Element, left: number, top: number, width: number, height: number) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

/** A 2 × 2 PNG, red. */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";
const SCHEMATIC = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><style>.cls-1 { fill: #336699; }</style><rect id="bar" class="cls-1" fill="#336699" x="0" y="0" width="40" height="10"/><use href="#bar" y="10"/></svg>';

const XLINK = "http://www.w3.org/1999/xlink";
const image = (content: string, mediaType: LayoutPlacedImageRecipe["mediaType"], naturalWidth: number, naturalHeight: number, fileName: string): LayoutPlacedImageRecipe =>
  ({ kind: "image", fileName, mediaType, naturalWidth, naturalHeight, content });

/** A page of placed images as the Layout tab draws them: an item each, the <img> inside its body. */
function page(images: { recipe: LayoutPlacedImageRecipe; x: number; y: number; width: number; height: number; name?: string }[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const canvas = document.createElement("section");
  rect(canvas, 0, 0, 1123, 794);
  images.forEach((placed, z) => {
    const item = document.createElement("article");
    item.className = "gl-layout-item";
    item.style.zIndex = String(z);
    item.dataset.title = placed.recipe.fileName;
    if (placed.name) item.dataset.objectName = placed.name;
    const body = document.createElement("div");
    body.className = "gl-layout-item-body";
    item.appendChild(body);
    canvas.appendChild(item);
    rect(item, placed.x, placed.y, placed.width, placed.height);
    act(() => createRoot(body).render(createElement(LayoutPlacedImageView, { recipe: placed.recipe })));
  });
  document.body.appendChild(canvas);
  return canvas;
}

describe("The Layout export of placed images", () => {
  it("writes a placed SVG as a nested vector <svg> with its viewBox and a bitmap as an <image>, each at its place", () => {
    const canvas = page([
      { recipe: image(SCHEMATIC, "image/svg+xml", 40, 20, "schematic_D1.svg"), x: 100, y: 50, width: 200, height: 100 },
      { recipe: image(PNG, "image/png", 2, 2, "control.png"), x: 400, y: 60, width: 50, height: 40 },
    ]);
    const { root } = composeLayoutSVG(canvas, createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    const groups = [...root.querySelectorAll(":scope > g[id^='image-']")];
    expect(groups.map((g) => g.getAttribute("id"))).toEqual(["image-1-schematic_D1-svg", "image-2-control-png"]);
    const nested = groups[0].querySelector(":scope > svg")!;
    expect(["x", "y", "width", "height", "viewBox", "preserveAspectRatio"].map((name) => nested.getAttribute(name))).toEqual(["100", "50", "200", "100", "0 0 40 20", "none"]);
    expect(nested.querySelector("rect")!.getAttribute("id")).toBe("image-1-schematic_D1-svg-bar");
    expect(nested.querySelector("use")!.getAttribute("href")).toBe("#image-1-schematic_D1-svg-bar");
    expect(nested.getAttribute("id")).toBe("image-1-schematic_D1-svg-art");
    expect(nested.querySelector("style")!.textContent).toContain("#image-1-schematic_D1-svg-art .cls-1 {");
    // No <img>, nothing of the page's markup: only the drawing.
    expect(root.querySelector("img, [class*='gl-']")).toBeNull();
    const bitmap = groups[1].querySelector(":scope > image")!;
    expect(["x", "y", "width", "height", "preserveAspectRatio"].map((name) => bitmap.getAttribute(name))).toEqual(["400", "60", "50", "40", "none"]);
    expect(bitmap.getAttributeNS(XLINK, "href") ?? bitmap.getAttribute("href")).toBe(PNG);
    canvas.remove();
  });

  it("takes an item's name from the objects list as its id", () => {
    const canvas = page([{ recipe: image(PNG, "image/png", 2, 2, "control.png"), x: 0, y: 0, width: 20, height: 20, name: "Micrograph D1" }]);
    const { root } = composeLayoutSVG(canvas, createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    expect(root.querySelector(":scope > g > image")!.parentElement!.getAttribute("id")).toBe("Micrograph-D1");
    canvas.remove();
  });

  it("exports a hostile SVG without script, foreignObject, handlers or outside references, and the page draws it only through <img>", () => {
    const canvas = page([{ recipe: image(HOSTILE_SVG, "image/svg+xml", 120, 60, "hostile.svg"), x: 10, y: 10, width: 120, height: 60 }]);
    // On the page: one <img> of a data URL, and none of the file's markup in the page's DOM.
    const item = canvas.querySelector(".gl-layout-item")!;
    expect(item.querySelectorAll("img")).toHaveLength(1);
    expect(item.querySelector("img")!.getAttribute("src")!.startsWith("data:image/svg+xml")).toBe(true);
    expect(item.querySelector("svg, script, foreignObject, rect")).toBeNull();
    const { root } = composeLayoutSVG(canvas, createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    const markup = new XMLSerializer().serializeToString(root);
    expect(root.querySelectorAll("script, foreignObject, set, animate")).toHaveLength(0);
    expect(markup).not.toMatch(/<script|foreignObject|javascript:|alert\(|example\.org|other\.svg|@import/i);
    expect([...root.querySelectorAll("*")].flatMap((el) => [...el.attributes].map((a) => a.name)).filter((name) => /^on/i.test(name))).toEqual([]);
    expect([...root.querySelectorAll("image")].map((el) => el.getAttributeNS(XLINK, "href") ?? el.getAttribute("href"))).toEqual([null, "data:image/png;base64,iVBORw0KGgo="]);
    canvas.remove();
  });

  it("is drawn by the PDF writer: the SVG as vector paths in its own colours, the PNG embedded as an image", async () => {
    const canvas = page([
      { recipe: image(SCHEMATIC, "image/svg+xml", 40, 20, "schematic_D1.svg"), x: 100, y: 50, width: 200, height: 100 },
      { recipe: image(PNG, "image/png", 2, 2, "control.png"), x: 400, y: 60, width: 50, height: 40 },
    ]);
    const { root } = composeLayoutSVG(canvas, createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    // The writer measures a bitmap with an Image, which loads nothing in the test runner: one that reports the PNG's 2 × 2.
    vi.stubGlobal("Image", class {
      width = 2;
      height = 2;
      onload: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: [842, 595], compress: false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await pdfVectorPage(pdf, root, { width: 842, height: 595 })).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    const content = pdf.output();
    // The bar, filled #336699, drawn as a path and again through its <use>. (The writer applies a file's
    // style sheet through the browser's CSS parser, which the test runner's document does not have,
    // so the colour here comes from the presentation attribute.)
    expect(content.match(/0\.2 0\.4 0\.6 rg/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(content).toMatch(/0\. 0\. m\n40\. 0\. l\n40\. 10\. l\n0\. 10\. l\nh\nf\n/);
    // The PNG: an image XObject of its 2 × 2 pixels, drawn once.
    expect(content).toMatch(/\/Subtype \/Image\n\/Width 2\n\/Height 2/);
    expect(content).toMatch(/\/I\d+ Do/);
    warn.mockRestore();
    vi.unstubAllGlobals();
    canvas.remove();
  });
});
