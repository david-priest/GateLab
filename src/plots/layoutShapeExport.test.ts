// @vitest-environment jsdom
// Lines and shapes in the Layout export: the page's SVG holds each shape's own vector elements
// (<line>, <path>, <rect>, <ellipse>, a filled <path> per arrowhead) with their stroke, dash and
// fill, at the item's place, and not the invisible outline the page selects it by; and the PDF
// writer (svg2pdf, as the export calls it) draws them as vector paths with the dash pattern.

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { composeLayoutSVG } from "./layoutExport";
import { pdfVectorPage } from "./exportSvg";
import { createLayoutSheet } from "../engine/layout";
import { defaultShapeRecipe, type LayoutShapeRecipe } from "../engine/shapeBlock";
import { LayoutShapeSvg } from "../ui/layout/LayoutShape";

vi.mock("./gridExport", () => ({ cellDataUrlAtDpi: () => "data:", rasterizeSvg: async () => ({}) }));
// The PDF writer's ES build, as the app's bundle takes it; the test runner would otherwise load its UMD build.
// @ts-expect-error -- the ES build has no declaration file of its own; the package's types describe it.
vi.mock("svg2pdf.js", () => import("svg2pdf.js/dist/svg2pdf.es.min.js"));

function rect(el: Element, left: number, top: number, width: number, height: number) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

/** A page of shapes as the Layout tab draws them: an item each, its SVG inside its body. */
function page(shapes: { recipe: LayoutShapeRecipe; x: number; y: number; width: number; height: number; title: string }[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const canvas = document.createElement("section");
  rect(canvas, 0, 0, 1123, 794);
  shapes.forEach((shape, z) => {
    const item = document.createElement("article");
    item.className = "gl-layout-item";
    item.style.zIndex = String(z);
    item.dataset.title = shape.title;
    const body = document.createElement("div");
    body.className = "gl-layout-item-body";
    item.appendChild(body);
    canvas.appendChild(item);
    rect(item, shape.x, shape.y, shape.width, shape.height);
    act(() => createRoot(body).render(createElement(LayoutShapeSvg, { recipe: shape.recipe, width: shape.width, height: shape.height })));
  });
  document.body.appendChild(canvas);
  return canvas;
}

const SHAPES = [
  { title: "Arrow", x: 300, y: 150, width: 120, height: 0, recipe: { ...defaultShapeRecipe("arrow"), strokeWidth: 1.5, dash: "dashed" as const } },
  { title: "Bracket", x: 57, y: 30, width: 260, height: 12, recipe: { ...defaultShapeRecipe("bracket"), stroke: "#336699", ends: 12 } },
  { title: "Rectangle", x: 40, y: 40, width: 300, height: 320, recipe: { ...defaultShapeRecipe("rectangle"), fill: "#eeeeee", cornerRadius: 6, dash: "dotted" as const } },
  { title: "Ellipse", x: 500, y: 300, width: 100, height: 60, recipe: { ...defaultShapeRecipe("ellipse"), stroke: "#ff0000", strokeWidth: 2 } },
];

describe("The Layout export of lines and shapes", () => {
  it("writes each shape's vector elements with its stroke, dash and fill, at its place, without the outline it is selected by", () => {
    const canvas = page(SHAPES);
    const { root } = composeLayoutSVG(canvas, createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    const groups = [...root.querySelectorAll("g[id^='shape-']")];
    expect(groups.map((g) => g.getAttribute("id"))).toEqual(["shape-1-Arrow", "shape-2-Bracket", "shape-3-Rectangle", "shape-4-Ellipse"]);
    expect(groups.map((g) => g.getAttribute("transform"))).toEqual(["translate(300,150)", "translate(57,30)", "translate(40,40)", "translate(500,300)"]);
    const [arrow, bracket, rectangle, ellipse] = groups;
    const line = arrow.querySelector("line")!;
    expect([line.getAttribute("x1"), line.getAttribute("y1"), line.getAttribute("y2"), line.getAttribute("stroke"), line.getAttribute("stroke-width"), line.getAttribute("stroke-dasharray")]).toEqual(["0", "0", "0", "#000000", "1.5", "6 4.5"]);
    expect(Number(line.getAttribute("x2"))).toBeLessThan(120);
    const head = arrow.querySelector("path")!;
    expect([head.getAttribute("fill"), head.getAttribute("stroke")]).toEqual(["#000000", "none"]);
    expect(head.getAttribute("d")).toMatch(/^M120 0 L/);
    expect(bracket.querySelector("path")!.getAttribute("d")).toBe("M0 12 L0 0 L260 0 L260 12");
    expect(bracket.querySelector("path")!.getAttribute("stroke")).toBe("#336699");
    const r = rectangle.querySelector("rect")!;
    expect([r.getAttribute("width"), r.getAttribute("height"), r.getAttribute("rx"), r.getAttribute("fill"), r.getAttribute("stroke-dasharray")]).toEqual(["300", "320", "6", "#eeeeee", "1 1.5"]);
    const e = ellipse.querySelector("ellipse")!;
    expect([e.getAttribute("cx"), e.getAttribute("rx"), e.getAttribute("ry"), e.getAttribute("fill"), e.getAttribute("stroke"), e.getAttribute("stroke-width")]).toEqual(["50", "50", "30", "none", "#ff0000", "2"]);
    // Only the art: no outline, no classes, no pointer settings.
    expect(root.querySelector(".gl-layout-shape-hit, [pointer-events], [class]")).toBeNull();
    expect(groups.map((g) => g.children.length)).toEqual([2, 1, 1, 1]);
    canvas.remove();
  });

  it("scales a zoomed item's shape as the page does", () => {
    const canvas = page([SHAPES[3]]);
    canvas.querySelector<HTMLElement>(".gl-layout-item")!.dataset.zoom = "0.5";
    const { root } = composeLayoutSVG(canvas, createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    expect(root.querySelector("g[id^='shape-']")!.getAttribute("transform")).toBe("translate(500,300) scale(0.5)");
    canvas.remove();
  });

  it("is drawn by the PDF writer as vector paths, the dash pattern and fill kept", async () => {
    const canvas = page(SHAPES);
    const { root } = composeLayoutSVG(canvas, createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: [842, 595], compress: false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await pdfVectorPage(pdf, root, { width: 842, height: 595 })).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    const content = pdf.output();
    // The arrow: a stroked line with its dash pattern, and its head a filled triangle with its tip at the line's end.
    expect(content).toContain("[6. 4.5] 0. d");
    expect(content).toMatch(/120\. 0\. m\n110\. 4\.5 l\n110\. -4\.5 l\nh\nf\n/);
    // The bracket's path in its colour, the rectangle's rounded corners filled #eeeeee and stroked dotted, the ellipse in red curves.
    expect(content).toMatch(/0\.2 0\.4 0\.6 RG\n[^\n]* cm\n0\. 12\. m\n0\. 0\. l\n260\. 0\. l\n260\. 12\. l\nS\n/);
    expect(content).toMatch(/0\.93 g\n0\. G\n\[1\. 1\.5\] 0\. d\n[\s\S]*? c\n[\s\S]*?\nB\n/);
    expect(content).toMatch(/2\. w\n1\. 0\. 0\. RG\n[^\n]* cm\n100\. 30\. m\n[^\n]* c\n/);
    canvas.remove();
  });
});
