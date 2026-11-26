// layoutGeometry.ts — item geometry on a Layout sheet in millimetres, matching sizes, and
// arranging a selection in a grid or at a typed spacing. Items are stored in CSS pixels; the page
// is drawn at SCREEN_PX_PER_MM, so a length in mm is that many px divided by it. Pure functions
// over the sheet's items, so the tab's controls are thin and the geometry is tested here. Panel
// letters are left out of every operation: the tab's commit puts each back beside its item.

import { SCREEN_PX_PER_MM, layoutItemMinimum, layoutItemZoom, zoomField, type LayoutItem, type LayoutRecipe, type LayoutSheet } from "../../engine/layout";
import { arrangeUnits, contentBounds, type Box } from "../../engine/layoutArrange";
import { isPanelLetter, readingOrder } from "./panelLetters";

export type LengthUnit = "mm" | "px";
export type FrameField = "x" | "y" | "width" | "height";
export type MatchHow = "width" | "height" | "size";
export type GridOrder = "across" | "down";
export type SpaceDirection = "across" | "down";

/** A position or size in px rounded to 0.01 px: fine enough that a length typed in mm reads back as typed. */
function roundPx(px: number): number {
  return Math.round(px * 100) / 100;
}

/** A length in px shown in the unit: mm to 0.1 mm, px to 0.01 px. */
export function pxToUnit(px: number, unit: LengthUnit): number {
  return unit === "mm" ? Math.round((px / SCREEN_PX_PER_MM) * 10) / 10 : roundPx(px);
}

/** A length typed in the unit, in px. */
export function unitToPx(value: number, unit: LengthUnit): number {
  return roundPx(unit === "mm" ? value * SCREEN_PX_PER_MM : value);
}

/** The smallest panel the plot renderer draws (px): a side asked smaller is drawn at this. */
export const SMALLEST_PANEL = 120;

/** How one kind of block follows its frame. */
export interface BlockSizing {
  /** What the frame keeps round the block's drawing, both sides of a direction together (px). */
  inset: number;
  /** The smallest area the block is drawn in (px): its frame less the inset, when that is larger. */
  drawn: { width: number; height: number };
  /** In a frame too small for `drawn` the block is drawn at that size and shown scaled (the item's zoom). */
  scaledBelowDrawn: boolean;
  /** Drawn at one size and scaled as a whole to its frame, which keeps its proportions when resized. */
  scaledWhole: boolean;
  /** The smallest frame a typed or matched size gives the block. */
  minimum: { width: number; height: number };
}

/**
 * The sizing of a block, by its recipe: the one place that says how small each kind is drawn, how
 * small its frame can be made and whether it is scaled, read by the tab's drawing, the drag and
 * typed sizes (resizedFrame) and the match tools.
 */
export function blockSizing(recipe: LayoutRecipe): BlockSizing {
  const plot = recipe.kind === "biplot" || recipe.kind === "histogram";
  // A multi-population strategy grid; a single population's is a strip of steps.
  const grid = recipe.kind === "strategy" && !!recipe.populationIds?.length;
  // Text, a shape and a placed image fill their frames.
  const fills = recipe.kind === "text" || recipe.kind === "shape" || recipe.kind === "image";
  return {
    inset: fills ? 0 : 8,
    // A strip lays its panels out in the frame as it is, and is shown scaled when they would be
    // under the smallest panel; a plot or a grid is never fitted to less than that panel.
    drawn: plot || grid ? { width: SMALLEST_PANEL, height: SMALLEST_PANEL }
      : fills ? { width: 0, height: 0 }
      : recipe.kind === "strategy" ? { width: 1, height: 1 }
      : { width: 120, height: 80 },
    scaledBelowDrawn: plot,
    scaledWhole: grid,
    // A plot made smaller than it is drawn is shown scaled, so its only floor is a pixel.
    minimum: plot ? { width: 1, height: 1 } : layoutItemMinimum(recipe.kind),
  };
}

/** The area a block is drawn in, for its frame (a zoomed item's is its frame divided by its zoom). */
export function drawingArea(item: Pick<LayoutItem, "width" | "height" | "recipe">): { width: number; height: number } {
  const { inset, drawn } = blockSizing(item.recipe);
  return { width: Math.max(drawn.width, item.width - inset), height: Math.max(drawn.height, item.height - inset) };
}

/**
 * The frame fields a typed value sets. With the proportions kept, a width sets the height too
 * (and the reverse) so the item keeps its ratio; neither goes under the item's typed minimum.
 */
export function framePatch(
  item: Pick<LayoutItem, "width" | "height" | "recipe">,
  field: FrameField,
  px: number,
  keepRatio: boolean,
): Partial<Record<FrameField, number>> {
  if (field === "x" || field === "y") return { [field]: Math.max(0, px) };
  const { minimum } = blockSizing(item.recipe);
  const value = Math.max(minimum[field], px);
  if (!keepRatio || item.width <= 0 || item.height <= 0) return { [field]: value };
  if (field === "width") {
    const height = roundPx(Math.max(minimum.height, (value * item.height) / item.width));
    return { width: value, height };
  }
  const width = roundPx(Math.max(minimum.width, (value * item.width) / item.height));
  return { width, height: value };
}

/**
 * An item's zoom once resized to a frame. The zoom is kept, so a plot is drawn again to fill the
 * frame with its fonts the size they look; but a plot is never drawn smaller than it can be, so
 * one made smaller than that is drawn at that size and shown scaled to the frame. A plot held at
 * that size (`item` is its frame before the resize) is scaled back up as its frame grows, to
 * unscaled once the frame is that size again, so making it larger undoes making it smaller.
 */
export function resizedFrame(item: Pick<LayoutItem, "width" | "height" | "zoom" | "recipe">, width: number, height: number): { zoom?: number } {
  const zoom = layoutItemZoom(item);
  const { inset, drawn, scaledBelowDrawn } = blockSizing(item.recipe);
  if (!scaledBelowDrawn) return zoomField(zoom);
  // The smallest frame side the plot is drawn at: its smallest panel inside the inset.
  const smallest = Math.min(drawn.width, drawn.height) + inset;
  const fits = Math.min(width, height) / smallest;
  const held = zoom < 1 && Math.min(item.width, item.height) / zoom <= smallest + 1;
  return zoomField(held ? Math.min(1, fits) : Math.min(zoom, fits));
}

/**
 * Give an item a frame: the fields named, and the zoom that frame shows it at (resizedFrame).
 * Every way of sizing an item goes through here (a drag, a typed size, a matched size), so a
 * plot made small is shown scaled whichever way it was made small.
 */
export function applyFrame(item: LayoutItem, frame: Partial<Record<FrameField, number>>): void {
  const { zoom } = resizedFrame(item, frame.width ?? item.width, frame.height ?? item.height);
  Object.assign(item, frame);
  if (zoom === undefined) delete item.zoom;
  else item.zoom = zoom;
}

/** The items an arrange or match acts on: those named, not locked, and not panel letters. */
function arrangeable(sheet: Pick<LayoutSheet, "items">, ids: readonly string[]): LayoutItem[] {
  return sheet.items.filter((item) => ids.includes(item.id) && !item.locked && !isPanelLetter(item));
}

/**
 * The item the others match: the one whose top-left corner is nearest the top-left corner of the
 * selection's bounds (the tab does not keep the order items were selected in). Locked items can
 * be the reference; they are not changed. Null with fewer than two items.
 */
export function matchReference(sheet: Pick<LayoutSheet, "items">, ids: readonly string[]): LayoutItem | null {
  const chosen = sheet.items.filter((item) => ids.includes(item.id) && !isPanelLetter(item));
  if (chosen.length < 2) return null;
  const bounds = contentBounds(chosen)!;
  const distance = (item: LayoutItem) => Math.hypot(item.x - bounds.x, item.y - bounds.y);
  return [...chosen].sort((a, b) => distance(a) - distance(b) || a.y - b.y || a.x - b.x)[0];
}

/**
 * Give each chosen item the width, height or both of the reference item, keeping its top-left
 * corner; no side goes under the item's typed minimum, so a plot matched to a small one is shown
 * scaled as a typed or dragged one is. Locked items and panel letters are not changed. Returns
 * the reference's id, or null when there was nothing to match.
 */
export function matchSizes(sheet: LayoutSheet, ids: readonly string[], how: MatchHow): string | null {
  const reference = matchReference(sheet, ids);
  if (!reference) return null;
  for (const item of arrangeable(sheet, ids)) {
    if (item.id === reference.id) continue;
    const { minimum } = blockSizing(item.recipe);
    applyFrame(item, {
      ...(how !== "height" && { width: Math.max(minimum.width, reference.width) }),
      ...(how !== "width" && { height: Math.max(minimum.height, reference.height) }),
    });
  }
  return reference.id;
}

/**
 * Each unlocked item of `ids` drawn unscaled: its zoom dropped and its frame the size it is drawn
 * at (the frame divided by the zoom, as the page draws it), its top-left corner kept.
 */
export function resetScale(sheet: LayoutSheet, ids: readonly string[]): void {
  for (const item of sheet.items) {
    const zoom = layoutItemZoom(item);
    if (!ids.includes(item.id) || item.locked || zoom === 1) continue;
    item.width = Math.max(1, Math.round(item.width / zoom));
    item.height = Math.max(1, Math.round(item.height / zoom));
    delete item.zoom;
  }
}

/** The default number of columns for a grid of this many units: the ceiling of the square root. */
export function defaultGridColumns(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count))));
}

/** How many units the arrange tools would move for these ids: groups count once; locked items and letters not at all. */
export function arrangeUnitCount(sheet: Pick<LayoutSheet, "items">, ids: readonly string[]): number {
  return arrangeUnits(arrangeable(sheet, ids)).length;
}

function moveUnit(unit: readonly LayoutItem[], dx: number, dy: number): void {
  for (const item of unit) {
    item.x = roundPx(item.x + dx);
    item.y = roundPx(item.y + dy);
  }
}

/**
 * Place the chosen items, or groups, in a grid: taken in reading order, filled across then down
 * or down then across, with the grid's top-left corner at the selection's. Each column is as wide
 * as its widest unit and each row as tall as its tallest; a unit sits at the top left of its cell.
 * Locked items and panel letters stay where they are.
 */
export function arrangeInGrid(
  sheet: LayoutSheet,
  ids: readonly string[],
  options: { columns: number; gapPx: number; order: GridOrder },
): void {
  const units = arrangeUnits(arrangeable(sheet, ids)).map((unit, index) => ({ unit, ...contentBounds(unit)!, id: String(index) }));
  if (units.length < 2) return;
  const ordered = readingOrder(units);
  const columns = Math.max(1, Math.min(ordered.length, Math.round(options.columns)));
  const rows = Math.ceil(ordered.length / columns);
  const gap = Math.max(0, options.gapPx);
  const cellOf = (index: number) =>
    options.order === "across"
      ? { row: Math.floor(index / columns), column: index % columns }
      : { row: index % rows, column: Math.floor(index / rows) };
  const widths = new Array<number>(columns).fill(0);
  const heights = new Array<number>(rows).fill(0);
  ordered.forEach((unit, index) => {
    const { row, column } = cellOf(index);
    widths[column] = Math.max(widths[column], unit.width);
    heights[row] = Math.max(heights[row], unit.height);
  });
  const origin = contentBounds(units)!;
  const left = (column: number) => origin.x + widths.slice(0, column).reduce((sum, w) => sum + w + gap, 0);
  const top = (row: number) => origin.y + heights.slice(0, row).reduce((sum, h) => sum + h + gap, 0);
  ordered.forEach((unit, index) => {
    const { row, column } = cellOf(index);
    moveUnit(unit.unit, left(column) - unit.x, top(row) - unit.y);
  });
}

/**
 * Space the chosen items, or groups, at a typed gap across or down: the first in that direction
 * stays, and each next one is put at the previous one's far edge plus the gap. Only that one
 * coordinate changes. Locked items and panel letters stay where they are.
 */
export function spaceItems(sheet: LayoutSheet, ids: readonly string[], gapPx: number, direction: SpaceDirection): void {
  const units = arrangeUnits(arrangeable(sheet, ids)).map((unit) => ({ unit, bounds: contentBounds(unit)! as Box }));
  if (units.length < 2) return;
  const across = direction === "across";
  const ordered = [...units].sort((a, b) =>
    across ? a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y : a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  let cursor = across ? ordered[0].bounds.x + ordered[0].bounds.width : ordered[0].bounds.y + ordered[0].bounds.height;
  for (const { unit, bounds } of ordered.slice(1)) {
    const at = cursor + Math.max(0, gapPx);
    if (across) moveUnit(unit, at - bounds.x, 0);
    else moveUnit(unit, 0, at - bounds.y);
    cursor = at + (across ? bounds.width : bounds.height);
  }
}
