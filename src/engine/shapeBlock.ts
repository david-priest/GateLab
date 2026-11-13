// shapeBlock.ts — lines and shapes on a Layout sheet: a line (with arrowheads or none), a bracket,
// a rectangle and an ellipse. Each is an item like the others, its frame the box it is drawn in:
// a line lies along a diagonal of its frame (a frame of no height or no width is a horizontal or
// vertical line), a bracket's bar lies along one side of it, and a rectangle or ellipse fills it.
// A shape draws no data, follows no iteration and has no title, frame or sheet style.

export type LayoutShapeKind = "line" | "bracket" | "rectangle" | "ellipse";
export const LAYOUT_SHAPE_KINDS: readonly LayoutShapeKind[] = ["line", "bracket", "rectangle", "ellipse"];

export type LayoutShapeDash = "solid" | "dashed" | "dotted";
export const LAYOUT_SHAPE_DASHES: readonly LayoutShapeDash[] = ["solid", "dashed", "dotted"];

/** A line's arrowheads: at its end, its start, both, or none. */
export type LayoutShapeArrows = "none" | "end" | "start" | "both";
export const LAYOUT_SHAPE_ARROWS: readonly LayoutShapeArrows[] = ["none", "end", "start", "both"];

/** The corner of the frame a line starts at; it ends at the opposite corner. */
export type LayoutShapeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export const LAYOUT_SHAPE_CORNERS: readonly LayoutShapeCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

/** The way a bracket's ends point: "down" is a bar along the frame's top with its ends pointing down. */
export type LayoutBracketSide = "down" | "up" | "left" | "right";
export const LAYOUT_BRACKET_SIDES: readonly LayoutBracketSide[] = ["down", "up", "left", "right"];

export interface LayoutShapeRecipe {
  kind: "shape";
  shape: LayoutShapeKind;
  /** The stroke's colour, #rrggbb. */
  stroke: string;
  /** The stroke's width in page px, in steps of 0.25. */
  strokeWidth: number;
  dash: LayoutShapeDash;
  /** A rectangle's or an ellipse's fill, #rrggbb; absent, none. */
  fill?: string;
  /** A rectangle's corner radius, px. */
  cornerRadius?: number;
  /** A line's arrowheads. */
  arrows?: LayoutShapeArrows;
  /** The corner a line starts at. */
  from?: LayoutShapeCorner;
  /** The way a bracket's ends point. */
  side?: LayoutBracketSide;
  /** The length of a bracket's ends, px. */
  ends?: number;
  /** A shape has no title; named so that code reading any block's title reads none. */
  title?: never;
}

export const SHAPE_STROKE_DEFAULT = "#000000";
export const SHAPE_STROKE_WIDTH_DEFAULT = 1;
export const SHAPE_STROKE_WIDTH_RANGE: readonly [number, number] = [0.25, 24];
export const SHAPE_BRACKET_ENDS_DEFAULT = 8;
export const SHAPE_BRACKET_ENDS_RANGE: readonly [number, number] = [0, 400];
export const SHAPE_CORNER_RADIUS_RANGE: readonly [number, number] = [0, 400];

/** A colour as saved: #rgb or #rrggbb, written #rrggbb in lower case; null for anything else. */
export function shapeColour(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text)) return `#${[...text.slice(1)].map((c) => c + c).join("")}`;
  return null;
}

/** A stroke width within its range, in steps of 0.25. */
export function shapeStrokeWidth(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : SHAPE_STROKE_WIDTH_DEFAULT;
  const [lo, hi] = SHAPE_STROKE_WIDTH_RANGE;
  return Math.min(hi, Math.max(lo, Math.round(raw * 4) / 4));
}

function between(value: unknown, [lo, hi]: readonly [number, number], fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(hi, Math.max(lo, Math.round(value * 4) / 4)) : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * A shape as saved: its kind, the stroke, and the fields its kind uses, each within range; a field
 * another kind uses is dropped. Null when the kind is not one of the four.
 */
export function normalizeShapeRecipe(candidate: Record<string, unknown>): LayoutShapeRecipe | null {
  if (!LAYOUT_SHAPE_KINDS.includes(candidate.shape as LayoutShapeKind)) return null;
  const shape = candidate.shape as LayoutShapeKind;
  const base: LayoutShapeRecipe = {
    kind: "shape",
    shape,
    stroke: shapeColour(candidate.stroke) ?? SHAPE_STROKE_DEFAULT,
    strokeWidth: shapeStrokeWidth(candidate.strokeWidth),
    dash: oneOf(candidate.dash, LAYOUT_SHAPE_DASHES, "solid"),
  };
  if (shape === "line") {
    return { ...base, arrows: oneOf(candidate.arrows, LAYOUT_SHAPE_ARROWS, "none"), from: oneOf(candidate.from, LAYOUT_SHAPE_CORNERS, "top-left") };
  }
  if (shape === "bracket") {
    return { ...base, side: oneOf(candidate.side, LAYOUT_BRACKET_SIDES, "down"), ends: between(candidate.ends, SHAPE_BRACKET_ENDS_RANGE, SHAPE_BRACKET_ENDS_DEFAULT) };
  }
  const fill = shapeColour(candidate.fill);
  return {
    ...base,
    ...(fill ? { fill } : {}),
    ...(shape === "rectangle" ? { cornerRadius: between(candidate.cornerRadius, SHAPE_CORNER_RADIUS_RANGE, 0) } : {}),
  };
}

/** A new shape of a kind with every field at its default; "arrow" is a line with an arrowhead at its end. */
export function defaultShapeRecipe(kind: LayoutShapeKind | "arrow"): LayoutShapeRecipe {
  if (kind === "arrow") return normalizeShapeRecipe({ shape: "line", arrows: "end" })!;
  return normalizeShapeRecipe({ shape: kind })!;
}
