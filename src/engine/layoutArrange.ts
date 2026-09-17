// layoutArrange.ts — arranging items on a Layout sheet: alignment, distribution, and fitting the
// page to the content or the content to the page. Pure functions over the sheet's items, so the
// tab's buttons and keyboard are thin and the geometry is tested here.

import {
  applyLayoutPage,
  mmToPx,
  pageSizePx,
  pxToMm,
  type LayoutItem,
  type LayoutSheet,
} from "./layout";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AlignHow = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";
export type DistributeHow = "horizontal" | "vertical";

/** The smallest box holding every item; null with no items. */
export function contentBounds(items: readonly Box[]): Box | null {
  if (!items.length) return null;
  const left = Math.min(...items.map((b) => b.x));
  const top = Math.min(...items.map((b) => b.y));
  const right = Math.max(...items.map((b) => b.x + b.width));
  const bottom = Math.max(...items.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The first page's area inside its margin: what a lone item aligns to. */
export function pageContentBox(sheet: LayoutSheet): Box {
  const page = pageSizePx(sheet.page);
  const margin = mmToPx(sheet.page.marginMm);
  return { x: margin, y: margin, width: page.width - 2 * margin, height: page.height - 2 * margin };
}

/**
 * Align the chosen items to one another (two or more: to the edges or the centre of the group's
 * bounds), or a single item to the page's content box. Positions are rounded to whole pixels.
 */
export function alignItems(sheet: LayoutSheet, ids: readonly string[], how: AlignHow): void {
  const chosen = sheet.items.filter((item) => ids.includes(item.id));
  if (!chosen.length) return;
  const reference = chosen.length > 1 ? contentBounds(chosen)! : pageContentBox(sheet);
  for (const item of chosen) {
    switch (how) {
      case "left": item.x = reference.x; break;
      case "right": item.x = reference.x + reference.width - item.width; break;
      case "centerX": item.x = Math.round(reference.x + (reference.width - item.width) / 2); break;
      case "top": item.y = reference.y; break;
      case "bottom": item.y = reference.y + reference.height - item.height; break;
      case "centerY": item.y = Math.round(reference.y + (reference.height - item.height) / 2); break;
    }
  }
}

/** Space three or more items evenly between the two outermost, in the order they sit. */
export function distributeItems(sheet: LayoutSheet, ids: readonly string[], how: DistributeHow): void {
  const chosen = sheet.items.filter((item) => ids.includes(item.id));
  if (chosen.length < 3) return;
  const size = (item: LayoutItem) => (how === "horizontal" ? item.width : item.height);
  const position = (item: LayoutItem) => (how === "horizontal" ? item.x : item.y);
  const ordered = [...chosen].sort((a, b) => position(a) - position(b));
  const first = ordered[0], last = ordered[ordered.length - 1];
  const span = position(last) + size(last) - position(first);
  const occupied = ordered.reduce((sum, item) => sum + size(item), 0);
  const gap = (span - occupied) / (ordered.length - 1);
  let cursor = position(first);
  for (const item of ordered) {
    if (how === "horizontal") item.x = Math.round(cursor);
    else item.y = Math.round(cursor);
    cursor += size(item) + gap;
  }
}

/**
 * Make the page a custom size that holds every item inside its margin, as one page. With no
 * items the page is left as it is.
 */
export function fitPageToContent(sheet: LayoutSheet): void {
  const bounds = contentBounds(sheet.items);
  if (!bounds) return;
  const margin = mmToPx(sheet.page.marginMm);
  const shiftX = bounds.x - margin;
  const shiftY = bounds.y - margin;
  for (const item of sheet.items) {
    item.x -= shiftX;
    item.y -= shiftY;
  }
  const widthPx = bounds.width + 2 * margin;
  const heightPx = bounds.height + 2 * margin;
  applyLayoutPage(sheet, {
    ...sheet.page,
    preset: "custom",
    orientation: "portrait",
    widthMm: Math.max(40, pxToMm(widthPx)),
    heightMm: Math.max(40, pxToMm(heightPx)),
    columns: 1,
    rows: 1,
  });
}

/**
 * Scale and move every item, as one group, so the content fills the first page's content box
 * as far as its proportions allow, centred; the page is unchanged. Sizes are never made smaller
 * than an item's minimum.
 */
export function fitContentToPage(sheet: LayoutSheet, minimum: (item: LayoutItem) => { width: number; height: number }): void {
  const bounds = contentBounds(sheet.items);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
  const box = pageContentBox(sheet);
  const scale = Math.min(box.width / bounds.width, box.height / bounds.height);
  const scaledWidth = bounds.width * scale, scaledHeight = bounds.height * scale;
  const originX = box.x + (box.width - scaledWidth) / 2;
  const originY = box.y + (box.height - scaledHeight) / 2;
  for (const item of sheet.items) {
    const min = minimum(item);
    item.x = Math.round(originX + (item.x - bounds.x) * scale);
    item.y = Math.round(originY + (item.y - bounds.y) * scale);
    item.width = Math.max(min.width, Math.round(item.width * scale));
    item.height = Math.max(min.height, Math.round(item.height * scale));
  }
}
