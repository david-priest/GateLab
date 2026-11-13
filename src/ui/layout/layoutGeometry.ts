// layoutGeometry.ts — item geometry on a Layout sheet in millimetres, matching sizes, and
// arranging a selection in a grid or at a typed spacing. Items are stored in CSS pixels; the page
// is drawn at SCREEN_PX_PER_MM, so a length in mm is that many px divided by it. Pure functions
// over the sheet's items, so the tab's controls are thin and the geometry is tested here. Panel
// letters are left out of every operation: the tab's commit puts each back beside its item.

import { SCREEN_PX_PER_MM, layoutItemMinimum, type LayoutItem, type LayoutSheet } from "../../engine/layout";
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

/**
 * The frame fields a typed value sets. With the proportions kept, a width sets the height too
 * (and the reverse) so the item keeps its ratio; neither goes under the item's minimum.
 */
export function framePatch(
  item: Pick<LayoutItem, "width" | "height" | "recipe">,
  field: FrameField,
  px: number,
  keepRatio: boolean,
): Partial<Record<FrameField, number>> {
  if (field === "x" || field === "y") return { [field]: Math.max(0, px) };
  const minimum = layoutItemMinimum(item.recipe.kind);
  const value = Math.max(minimum[field], px);
  if (!keepRatio || item.width <= 0 || item.height <= 0) return { [field]: value };
  if (field === "width") {
    const height = roundPx(Math.max(minimum.height, (value * item.height) / item.width));
    return { width: value, height };
  }
  const width = roundPx(Math.max(minimum.width, (value * item.width) / item.height));
  return { width, height: value };
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
 * corner. Locked items and panel letters are not changed. Returns the reference's id, or null when
 * there was nothing to match.
 */
export function matchSizes(sheet: LayoutSheet, ids: readonly string[], how: MatchHow): string | null {
  const reference = matchReference(sheet, ids);
  if (!reference) return null;
  for (const item of arrangeable(sheet, ids)) {
    if (item.id === reference.id) continue;
    const minimum = layoutItemMinimum(item.recipe.kind);
    if (how !== "height") item.width = Math.max(minimum.width, reference.width);
    if (how !== "width") item.height = Math.max(minimum.height, reference.height);
  }
  return reference.id;
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
