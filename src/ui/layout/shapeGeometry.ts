// shapeGeometry.ts — what a Layout shape draws, in page px from its frame's top-left corner: the
// SVG elements of its art (the same on the page and in the export), the element a pointer takes
// it by, a line's ends and arrowheads, a bracket's path, and the frames a drag on the page makes.

import {
  defaultShapeRecipe,
  normalizeShapeRecipe,
  type LayoutShapeCorner,
  type LayoutShapeKind,
  type LayoutShapeRecipe,
} from "../../engine/shapeBlock";

/** What "+ Shape" offers: the four kinds, and an arrow (a line with an arrowhead at its end). */
export type ShapeTool = LayoutShapeKind | "arrow";
export const SHAPE_TOOLS: readonly ShapeTool[] = ["line", "arrow", "bracket", "rectangle", "ellipse"];

/** One SVG element: its tag and its attributes, by their SVG names. */
export interface ShapeElement {
  tag: "line" | "path" | "rect" | "ellipse";
  attrs: Record<string, string>;
}

export interface Point {
  x: number;
  y: number;
}

export interface ShapeFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A number written for SVG: at most three decimals, no trailing zeros. */
export const num = (value: number): string => String(Math.round(value * 1000) / 1000 || 0);

/** The dash pattern of a stroke, scaled with its width; null for a solid line. */
export function shapeDashArray(dash: LayoutShapeRecipe["dash"], strokeWidth: number): string | null {
  if (dash === "dashed") return `${num(4 * strokeWidth)} ${num(3 * strokeWidth)}`;
  if (dash === "dotted") return `${num(strokeWidth)} ${num(1.5 * strokeWidth)}`;
  return null;
}

/** A line's two ends: from the corner it starts at to the opposite corner of its frame. */
export function lineEnds(from: LayoutShapeCorner | undefined, width: number, height: number): { start: Point; end: Point } {
  const corner = from ?? "top-left";
  const left = corner.endsWith("left");
  const top = corner.startsWith("top");
  return {
    start: { x: left ? 0 : width, y: top ? 0 : height },
    end: { x: left ? width : 0, y: top ? height : 0 },
  };
}

/** An arrowhead's length and half its width; it grows with the stroke. */
export function arrowheadSize(strokeWidth: number): { length: number; halfWidth: number } {
  const length = 4 + 4 * strokeWidth;
  return { length, halfWidth: length * 0.45 };
}

/**
 * An arrowhead at `tip`, pointing away from `from`, as a closed path (a filled triangle draws the
 * same in a browser and in the PDF writer, which a <marker> does not reliably); null when the
 * two points coincide and the line has no direction.
 */
export function arrowheadPath(tip: Point, from: Point, strokeWidth: number): string | null {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return null;
  const ux = dx / length, uy = dy / length;
  const { length: head, halfWidth } = arrowheadSize(strokeWidth);
  const bx = tip.x - ux * head, by = tip.y - uy * head;
  return `M${num(tip.x)} ${num(tip.y)} L${num(bx - uy * halfWidth)} ${num(by + ux * halfWidth)} L${num(bx + uy * halfWidth)} ${num(by - ux * halfWidth)} Z`;
}

/** A bracket's path: its bar along one side of the frame and its two ends pointing `side`. */
export function bracketPath(side: LayoutShapeRecipe["side"], ends: number, width: number, height: number): string {
  const e = Math.max(0, ends);
  switch (side ?? "down") {
    case "up":
      return `M0 ${num(height - e)} L0 ${num(height)} L${num(width)} ${num(height)} L${num(width)} ${num(height - e)}`;
    case "right":
      return `M${num(e)} 0 L0 0 L0 ${num(height)} L${num(e)} ${num(height)}`;
    case "left":
      return `M${num(width - e)} 0 L${num(width)} 0 L${num(width)} ${num(height)} L${num(width - e)} ${num(height)}`;
    default:
      return `M0 ${num(e)} L0 0 L${num(width)} 0 L${num(width)} ${num(e)}`;
  }
}

function strokeAttrs(recipe: LayoutShapeRecipe): Record<string, string> {
  const dash = shapeDashArray(recipe.dash, recipe.strokeWidth);
  return {
    stroke: recipe.stroke,
    "stroke-width": num(recipe.strokeWidth),
    ...(dash ? { "stroke-dasharray": dash } : {}),
  };
}

/** The elements a shape draws in a frame of `width` × `height`, in drawing order. */
export function shapeElements(recipe: LayoutShapeRecipe, width: number, height: number): ShapeElement[] {
  const w = Math.max(0, width), h = Math.max(0, height);
  const stroke = strokeAttrs(recipe);
  if (recipe.shape === "rectangle") {
    const r = Math.min(recipe.cornerRadius ?? 0, w / 2, h / 2);
    return [{
      tag: "rect",
      attrs: { x: "0", y: "0", width: num(w), height: num(h), ...(r > 0 ? { rx: num(r), ry: num(r) } : {}), fill: recipe.fill ?? "none", ...stroke },
    }];
  }
  if (recipe.shape === "ellipse") {
    return [{ tag: "ellipse", attrs: { cx: num(w / 2), cy: num(h / 2), rx: num(w / 2), ry: num(h / 2), fill: recipe.fill ?? "none", ...stroke } }];
  }
  if (recipe.shape === "bracket") {
    return [{ tag: "path", attrs: { d: bracketPath(recipe.side, recipe.ends ?? 0, w, h), fill: "none", "stroke-linejoin": "miter", ...stroke } }];
  }
  // A line, shortened under each arrowhead so that its end does not show past the head's tip.
  const { start, end } = lineEnds(recipe.from, w, h);
  const arrows = recipe.arrows ?? "none";
  const atStart = arrows === "start" || arrows === "both";
  const atEnd = arrows === "end" || arrows === "both";
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const ux = length > 0 ? (end.x - start.x) / length : 0;
  const uy = length > 0 ? (end.y - start.y) / length : 0;
  const inset = arrowheadSize(recipe.strokeWidth).length * 0.8;
  const cutStart = atStart ? Math.min(inset, length / 2) : 0;
  const cutEnd = atEnd ? Math.min(inset, length / 2) : 0;
  const out: ShapeElement[] = [{
    tag: "line",
    attrs: {
      x1: num(start.x + ux * cutStart), y1: num(start.y + uy * cutStart),
      x2: num(end.x - ux * cutEnd), y2: num(end.y - uy * cutEnd),
      fill: "none", ...stroke,
    },
  }];
  for (const [tip, from] of [...(atStart ? [[start, end]] : []), ...(atEnd ? [[end, start]] : [])] as [Point, Point][]) {
    const d = arrowheadPath(tip, from, recipe.strokeWidth);
    if (d) out.push({ tag: "path", attrs: { d, fill: recipe.stroke, stroke: "none" } });
  }
  return out;
}

/**
 * The element a pointer takes a shape by: the whole line or outline (and the inside of a filled
 * rectangle or ellipse). Drawn invisible, with a stroke wide enough to take on the page.
 */
export function shapeHitElement(recipe: LayoutShapeRecipe, width: number, height: number): ShapeElement {
  const w = Math.max(0, width), h = Math.max(0, height);
  if (recipe.shape === "line") {
    const { start, end } = lineEnds(recipe.from, w, h);
    return { tag: "line", attrs: { x1: num(start.x), y1: num(start.y), x2: num(end.x), y2: num(end.y) } };
  }
  if (recipe.shape === "bracket") return { tag: "path", attrs: { d: bracketPath(recipe.side, recipe.ends ?? 0, w, h) } };
  if (recipe.shape === "ellipse") return { tag: "ellipse", attrs: { cx: num(w / 2), cy: num(h / 2), rx: num(w / 2), ry: num(h / 2) } };
  return { tag: "rect", attrs: { x: "0", y: "0", width: num(w), height: num(h) } };
}

const TAN_22_5 = Math.tan(Math.PI / 8);

/** A drag held to horizontal, vertical or 45°, as Shift holds a line. */
export function constrainToAngle(dx: number, dy: number): { dx: number; dy: number } {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ay <= ax * TAN_22_5) return { dx, dy: 0 };
  if (ax <= ay * TAN_22_5) return { dx: 0, dy };
  const side = Math.max(ax, ay);
  return { dx: Math.sign(dx) * side, dy: Math.sign(dy) * side };
}

/** A drag held to a square, as Shift holds a rectangle or an ellipse. */
export function constrainToSquare(dx: number, dy: number): { dx: number; dy: number } {
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { dx: (dx < 0 ? -1 : 1) * side, dy: (dy < 0 ? -1 : 1) * side };
}

/** The size a shape is placed at by a click on the page with no drag. */
export function defaultShapeSize(tool: ShapeTool): { width: number; height: number } {
  if (tool === "line" || tool === "arrow") return { width: 120, height: 0 };
  if (tool === "bracket") return { width: 120, height: 12 };
  return { width: 120, height: 80 };
}

/**
 * The shape a drag from `start` to `end` on the page draws, both in page px: its frame, the box
 * the two points span, and its recipe. A line starts at the corner pressed; with `shift` a line
 * is held to 0°, 45° or 90° and a rectangle or ellipse to a square. A bracket drawn taller than
 * wide has its ends pointing right, and its ends are as long as the box is deep.
 */
export function shapeFromDrag(tool: ShapeTool, start: Point, end: Point, shift: boolean): { recipe: LayoutShapeRecipe; frame: ShapeFrame } {
  let dx = Math.round(end.x - start.x);
  let dy = Math.round(end.y - start.y);
  const isLine = tool === "line" || tool === "arrow";
  if (shift) ({ dx, dy } = isLine ? constrainToAngle(dx, dy) : constrainToSquare(dx, dy));
  const x = Math.round(Math.min(start.x, start.x + dx));
  const y = Math.round(Math.min(start.y, start.y + dy));
  const frame = { x, y, width: Math.abs(dx), height: Math.abs(dy) };
  const recipe = defaultShapeRecipe(tool);
  if (isLine) {
    recipe.from = `${dy < 0 ? "bottom" : "top"}-${dx < 0 ? "right" : "left"}` as LayoutShapeCorner;
  } else if (tool === "bracket") {
    const tall = frame.height > frame.width;
    const depth = tall ? frame.width : frame.height;
    return { recipe: normalizeShapeRecipe({ ...recipe, side: tall ? "right" : "down", ends: depth >= 2 ? depth : recipe.ends })!, frame };
  }
  return { recipe, frame };
}

/** A shape placed by a click: the kind's default size, its top-left corner at the point. */
export function shapeAtPoint(tool: ShapeTool, at: Point): { recipe: LayoutShapeRecipe; frame: ShapeFrame } {
  return { recipe: defaultShapeRecipe(tool), frame: { x: Math.round(at.x), y: Math.round(at.y), ...defaultShapeSize(tool) } };
}

/**
 * A line resized with Shift held: the frame held so the line lies at 0°, 45° or 90°, the edge
 * opposite the handle kept where it is. Null for anything that is not a line, or without Shift.
 */
export function constrainLineResize(
  recipe: { kind: string; shape?: string } | null | undefined,
  resize: { width: number; height: number; direction?: number[]; drag: { left: number; top: number } },
  shift: boolean,
): { width: number; height: number; left: number; top: number } | null {
  if (!shift || !recipe || recipe.kind !== "shape" || recipe.shape !== "line") return null;
  const { dx, dy } = constrainToAngle(resize.width, resize.height);
  const width = Math.abs(dx), height = Math.abs(dy);
  const [hx, hy] = resize.direction ?? [1, 1];
  return {
    width,
    height,
    // A handle on the left or the top moves that edge: the right or bottom edge stays put.
    left: hx < 0 ? resize.drag.left + resize.width - width : resize.drag.left,
    top: hy < 0 ? resize.drag.top + resize.height - height : resize.drag.top,
  };
}

/** The fields each kind of shape uses beyond its stroke. */
const SHAPE_FIELDS: Record<LayoutShapeKind, readonly (keyof LayoutShapeRecipe)[]> = {
  line: ["arrows", "from"],
  bracket: ["side", "ends"],
  rectangle: ["fill", "cornerRadius"],
  ellipse: ["fill"],
};
const STROKE_FIELDS: readonly (keyof LayoutShapeRecipe)[] = ["stroke", "strokeWidth", "dash"];

/** Whether a shape of this kind has the field. */
export function shapeHasField(shape: LayoutShapeKind, field: keyof LayoutShapeRecipe): boolean {
  return STROKE_FIELDS.includes(field) || SHAPE_FIELDS[shape].includes(field);
}

/**
 * A change from the inspector applied to one shape: only the fields its kind has, kept within
 * range. `fill: null` takes the fill away.
 */
export function applyShapePatch(recipe: LayoutShapeRecipe, patch: Partial<Omit<LayoutShapeRecipe, "fill">> & { fill?: string | null }): LayoutShapeRecipe {
  const next: Record<string, unknown> = { ...recipe };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "kind" || key === "shape" || !shapeHasField(recipe.shape, key as keyof LayoutShapeRecipe)) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return normalizeShapeRecipe(next) ?? recipe;
}
