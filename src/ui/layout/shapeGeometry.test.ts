// The geometry of Layout lines and shapes: a line along each diagonal of its frame and each
// arrowhead setting, a bracket for each side, the frames a drag draws (with Shift), a line held
// to 45° steps when resized, and the inspector's changes kept to the fields a kind has.

import { describe, expect, it } from "vitest";
import { defaultShapeRecipe, type LayoutShapeRecipe } from "../../engine/shapeBlock";
import {
  applyShapePatch,
  arrowheadSize,
  bracketPath,
  constrainLineResize,
  constrainToAngle,
  lineEnds,
  shapeAtPoint,
  shapeDashArray,
  shapeElements,
  shapeFromDrag,
  shapeHitElement,
} from "./shapeGeometry";

const line = (extra: Partial<LayoutShapeRecipe> = {}): LayoutShapeRecipe => ({ ...defaultShapeRecipe("line"), ...extra });
const numbers = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe("a line", () => {
  it.each([
    ["top-left", { x: 0, y: 0 }, { x: 100, y: 40 }],
    ["bottom-right", { x: 100, y: 40 }, { x: 0, y: 0 }],
    ["bottom-left", { x: 0, y: 40 }, { x: 100, y: 0 }],
    ["top-right", { x: 100, y: 0 }, { x: 0, y: 40 }],
  ] as const)("starting %s runs to the opposite corner", (from, start, end) => {
    expect(lineEnds(from, 100, 40)).toEqual({ start, end });
    const [drawn] = shapeElements(line({ from }), 100, 40);
    expect(drawn.tag).toBe("line");
    expect([drawn.attrs.x1, drawn.attrs.y1, drawn.attrs.x2, drawn.attrs.y2].map(Number)).toEqual([start.x, start.y, end.x, end.y]);
  });

  it("with no height is level, and with no width upright", () => {
    expect(lineEnds("top-left", 120, 0)).toEqual({ start: { x: 0, y: 0 }, end: { x: 120, y: 0 } });
    expect(lineEnds("bottom-left", 0, 50)).toEqual({ start: { x: 0, y: 50 }, end: { x: 0, y: 0 } });
  });

  it.each([
    ["none", 0, false, false],
    ["end", 1, false, true],
    ["start", 1, true, false],
    ["both", 2, true, true],
  ] as const)("with arrowheads %s draws %i heads, the line shortened under each", (arrows, heads, atStart, atEnd) => {
    const strokeWidth = 2;
    const elements = shapeElements(line({ arrows, strokeWidth }), 100, 0);
    expect(elements.filter((element) => element.tag === "path")).toHaveLength(heads);
    const [drawn] = elements;
    const { length } = arrowheadSize(strokeWidth);
    expect(Number(drawn.attrs.x1)).toBeCloseTo(atStart ? length * 0.8 : 0);
    expect(Number(drawn.attrs.x2)).toBeCloseTo(atEnd ? 100 - length * 0.8 : 100);
    // Each head is a filled triangle whose tip is at the line's end, pointing outward.
    for (const head of elements.slice(1)) {
      expect(head.attrs).toMatchObject({ fill: "#000000", stroke: "none" });
      const [tipX, tipY, ax, ay, bx, by] = numbers(head.attrs.d);
      expect(tipY).toBe(0);
      expect([0, 100]).toContain(tipX);
      const inward = tipX === 0 ? 1 : -1;
      expect((ax - tipX) * inward).toBeCloseTo(length);
      expect((bx - tipX) * inward).toBeCloseTo(length);
      expect(Math.abs(ay - by)).toBeCloseTo(2 * arrowheadSize(strokeWidth).halfWidth);
    }
  });

  it("scales its arrowhead with the stroke, and draws none where it has no length", () => {
    expect(arrowheadSize(3).length).toBeGreaterThan(arrowheadSize(1).length);
    expect(shapeElements(line({ arrows: "both" }), 0, 0)).toHaveLength(1);
  });

  it("is taken by a line over its whole length, whatever its heads", () => {
    expect(shapeHitElement(line({ arrows: "both", from: "bottom-left" }), 80, 30)).toEqual({ tag: "line", attrs: { x1: "0", y1: "30", x2: "80", y2: "0" } });
  });

  it("is dashed and dotted in proportion to its width", () => {
    expect(shapeDashArray("solid", 2)).toBeNull();
    expect(shapeDashArray("dashed", 2)).toBe("8 6");
    expect(shapeDashArray("dotted", 2)).toBe("2 3");
    expect(shapeElements(line({ dash: "dashed", strokeWidth: 0.5, stroke: "#123456" }), 10, 0)[0].attrs).toMatchObject({ stroke: "#123456", "stroke-width": "0.5", "stroke-dasharray": "2 1.5" });
  });
});

describe("a bracket", () => {
  it.each([
    ["down", [0, 8, 0, 0, 100, 0, 100, 8]],
    ["up", [0, 32, 0, 40, 100, 40, 100, 32]],
    ["right", [8, 0, 0, 0, 0, 40, 8, 40]],
    ["left", [92, 0, 100, 0, 100, 40, 92, 40]],
  ] as const)("with its ends pointing %s lies along the opposite side", (side, points) => {
    expect(numbers(bracketPath(side, 8, 100, 40))).toEqual(points);
    const [drawn] = shapeElements({ ...defaultShapeRecipe("bracket"), side, ends: 8 }, 100, 40);
    expect(drawn).toMatchObject({ tag: "path", attrs: { fill: "none" } });
    expect(numbers(drawn.attrs.d)).toEqual(points);
  });
});

describe("a rectangle and an ellipse", () => {
  it("fill their frame, with the fill, corner radius and stroke set", () => {
    const [rect] = shapeElements({ ...defaultShapeRecipe("rectangle"), fill: "#eeeeee", cornerRadius: 50, dash: "dotted" }, 100, 40);
    expect(rect).toEqual({ tag: "rect", attrs: { x: "0", y: "0", width: "100", height: "40", rx: "20", ry: "20", fill: "#eeeeee", stroke: "#000000", "stroke-width": "1", "stroke-dasharray": "1 1.5" } });
    const [ellipse] = shapeElements(defaultShapeRecipe("ellipse"), 100, 40);
    expect(ellipse).toEqual({ tag: "ellipse", attrs: { cx: "50", cy: "20", rx: "50", ry: "20", fill: "none", stroke: "#000000", "stroke-width": "1" } });
  });
});

describe("drawing by drag", () => {
  it("spans the box from the press to the release, a line starting where it was pressed", () => {
    expect(shapeFromDrag("line", { x: 100, y: 100 }, { x: 40, y: 160 }, false)).toEqual({
      frame: { x: 40, y: 100, width: 60, height: 60 },
      recipe: { ...defaultShapeRecipe("line"), from: "top-right" },
    });
    expect(shapeFromDrag("arrow", { x: 10, y: 50 }, { x: 90, y: 20 }, false).recipe).toMatchObject({ arrows: "end", from: "bottom-left" });
    expect(shapeFromDrag("rectangle", { x: 50, y: 50 }, { x: 10, y: 20 }, false).frame).toEqual({ x: 10, y: 20, width: 40, height: 30 });
  });

  it("with Shift holds a line to 0°, 45° or 90° and a rectangle or ellipse to a square", () => {
    expect(shapeFromDrag("line", { x: 0, y: 0 }, { x: 100, y: 12 }, true).frame).toEqual({ x: 0, y: 0, width: 100, height: 0 });
    expect(shapeFromDrag("line", { x: 0, y: 0 }, { x: 10, y: -100 }, true)).toMatchObject({ frame: { x: 0, y: -100, width: 0, height: 100 }, recipe: { from: "bottom-left" } });
    expect(shapeFromDrag("arrow", { x: 0, y: 0 }, { x: -80, y: 70 }, true)).toMatchObject({ frame: { x: -80, y: 0, width: 80, height: 80 }, recipe: { from: "top-right" } });
    expect(shapeFromDrag("ellipse", { x: 0, y: 0 }, { x: 30, y: -70 }, true).frame).toEqual({ x: 0, y: -70, width: 70, height: 70 });
    expect(constrainToAngle(100, 41)).toEqual({ dx: 100, dy: 0 });
    expect(constrainToAngle(100, 42)).toEqual({ dx: 100, dy: 100 });
  });

  it("draws a bracket whose ends reach across the box, pointing right when the box is tall", () => {
    expect(shapeFromDrag("bracket", { x: 0, y: 0 }, { x: 200, y: 14 }, false).recipe).toMatchObject({ side: "down", ends: 14 });
    expect(shapeFromDrag("bracket", { x: 0, y: 0 }, { x: 10, y: 200 }, false).recipe).toMatchObject({ side: "right", ends: 10 });
    expect(shapeFromDrag("bracket", { x: 0, y: 0 }, { x: 200, y: 0 }, false).recipe).toMatchObject({ side: "down", ends: 8 });
  });

  it("places a shape of the kind's size at a click", () => {
    expect(shapeAtPoint("arrow", { x: 40.4, y: 60 })).toEqual({ frame: { x: 40, y: 60, width: 120, height: 0 }, recipe: defaultShapeRecipe("arrow") });
    expect(shapeAtPoint("rectangle", { x: 0, y: 0 }).frame).toEqual({ x: 0, y: 0, width: 120, height: 80 });
  });
});

describe("resizing a line with Shift", () => {
  it("holds it to 0°, 45° or 90°, the edge opposite the handle staying put", () => {
    const recipe = line();
    expect(constrainLineResize(recipe, { width: 100, height: 20, direction: [1, 1], drag: { left: 10, top: 10 } }, true)).toEqual({ width: 100, height: 0, left: 10, top: 10 });
    // The top-left handle: the bottom-right corner (110, 70) stays.
    expect(constrainLineResize(recipe, { width: 50, height: 60, direction: [-1, -1], drag: { left: 60, top: 10 } }, true)).toEqual({ width: 60, height: 60, left: 50, top: 10 });
    expect(constrainLineResize(recipe, { width: 100, height: 20, direction: [1, 1], drag: { left: 10, top: 10 } }, false)).toBeNull();
    expect(constrainLineResize(defaultShapeRecipe("rectangle"), { width: 100, height: 20, drag: { left: 0, top: 0 } }, true)).toBeNull();
  });
});

describe("a change from the inspector", () => {
  it("reaches only the fields the shape's kind has, kept within range", () => {
    const patch = { stroke: "#ff0000", strokeWidth: 2.1, arrows: "both" as const, fill: "#00ff00", cornerRadius: 4 };
    expect(applyShapePatch(line(), patch)).toEqual({ ...line(), stroke: "#ff0000", strokeWidth: 2, arrows: "both" });
    expect(applyShapePatch(defaultShapeRecipe("rectangle"), patch)).toEqual({ ...defaultShapeRecipe("rectangle"), stroke: "#ff0000", strokeWidth: 2, fill: "#00ff00", cornerRadius: 4 });
    expect(applyShapePatch(defaultShapeRecipe("ellipse"), patch)).toEqual({ ...defaultShapeRecipe("ellipse"), stroke: "#ff0000", strokeWidth: 2, fill: "#00ff00" });
    expect(applyShapePatch({ ...defaultShapeRecipe("ellipse"), fill: "#00ff00" }, { fill: null })).not.toHaveProperty("fill");
  });
});
