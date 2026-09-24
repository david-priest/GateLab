// layoutArrange.ts — arranging items on a Layout sheet: alignment, distribution, and fitting the
// page to the content or the content to the page. Pure functions over the sheet's items, so the
// tab's buttons and keyboard are thin and the geometry is tested here.

import {
  applyLayoutPage,
  mmToPx,
  pageSizePx,
  pxToMm,
  layoutItemZoom,
  zoomField,
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

/** The units the arrange tools move: a group's members together, by their union bounds, else the item alone. */
export function arrangeUnits(items: readonly LayoutItem[]): LayoutItem[][] {
  const units: LayoutItem[][] = [];
  const byGroup = new Map<string, LayoutItem[]>();
  for (const item of items) {
    if (!item.group) { units.push([item]); continue; }
    const members = byGroup.get(item.group);
    if (members) members.push(item);
    else {
      const unit = [item];
      byGroup.set(item.group, unit);
      units.push(unit);
    }
  }
  return units;
}

/**
 * Align the chosen items to one another (two or more: to the edges or the centre of the
 * selection's bounds), or a single item to the page's content box. A group moves as one, its
 * members keeping their places in it. Positions are rounded to whole pixels.
 */
export function alignItems(sheet: LayoutSheet, ids: readonly string[], how: AlignHow): void {
  const chosen = sheet.items.filter((item) => ids.includes(item.id));
  if (!chosen.length) return;
  const units = arrangeUnits(chosen);
  const reference = units.length > 1 ? contentBounds(chosen)! : pageContentBox(sheet);
  for (const unit of units) {
    const bounds = contentBounds(unit)!;
    let dx = 0, dy = 0;
    switch (how) {
      case "left": dx = reference.x - bounds.x; break;
      case "right": dx = reference.x + reference.width - (bounds.x + bounds.width); break;
      case "centerX": dx = Math.round(reference.x + (reference.width - bounds.width) / 2) - bounds.x; break;
      case "top": dy = reference.y - bounds.y; break;
      case "bottom": dy = reference.y + reference.height - (bounds.y + bounds.height); break;
      case "centerY": dy = Math.round(reference.y + (reference.height - bounds.height) / 2) - bounds.y; break;
    }
    for (const item of unit) {
      item.x += dx;
      item.y += dy;
    }
  }
}

/**
 * Space three or more items, or groups, evenly between the two outermost, in the order they sit:
 * the gaps between them come out equal and the outer two stay where they are.
 */
export function distributeItems(sheet: LayoutSheet, ids: readonly string[], how: DistributeHow): void {
  const chosen = sheet.items.filter((item) => ids.includes(item.id));
  const units = arrangeUnits(chosen).map((unit) => ({ unit, bounds: contentBounds(unit)! }));
  if (units.length < 3) return;
  const size = (bounds: Box) => (how === "horizontal" ? bounds.width : bounds.height);
  const position = (bounds: Box) => (how === "horizontal" ? bounds.x : bounds.y);
  const ordered = [...units].sort((a, b) => position(a.bounds) - position(b.bounds));
  const first = ordered[0].bounds, last = ordered[ordered.length - 1].bounds;
  const span = position(last) + size(last) - position(first);
  const occupied = ordered.reduce((sum, { bounds }) => sum + size(bounds), 0);
  const gap = (span - occupied) / (ordered.length - 1);
  let cursor = position(first);
  for (const { unit, bounds } of ordered) {
    const delta = Math.round(cursor) - position(bounds);
    for (const item of unit) {
      if (how === "horizontal") item.x += delta;
      else item.y += delta;
    }
    cursor += size(bounds) + gap;
  }
}

/**
 * Make the items one group. A group among them is taken in whole, so grouping a member with
 * anything merges its group into the new one. Returns the new group's id.
 */
export function groupItems(sheet: LayoutSheet, ids: readonly string[], groupId: string = crypto.randomUUID()): string {
  const merged = new Set(sheet.items.filter((item) => ids.includes(item.id) && item.group).map((item) => item.group as string));
  for (const item of sheet.items) {
    if (ids.includes(item.id) || (item.group && merged.has(item.group))) item.group = groupId;
  }
  return groupId;
}

/** Dissolve every group the items belong to; the items stay where they are. */
export function ungroupItems(sheet: LayoutSheet, ids: readonly string[]): void {
  const dissolved = new Set(sheet.items.filter((item) => ids.includes(item.id) && item.group).map((item) => item.group as string));
  for (const item of sheet.items) if (item.group && dissolved.has(item.group)) delete item.group;
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
export function fitContentToPage(sheet: LayoutSheet): void {
  const bounds = contentBounds(sheet.items);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
  const box = pageContentBox(sheet);
  const scale = Math.min(box.width / bounds.width, box.height / bounds.height);
  const scaledWidth = bounds.width * scale, scaledHeight = bounds.height * scale;
  const originX = box.x + (box.width - scaledWidth) / 2;
  const originY = box.y + (box.height - scaledHeight) / 2;
  for (const item of sheet.items) {
    item.x = Math.round(originX + (item.x - bounds.x) * scale);
    item.y = Math.round(originY + (item.y - bounds.y) * scale);
    item.width = Math.max(1, Math.round(item.width * scale));
    item.height = Math.max(1, Math.round(item.height * scale));
    // Shrinking zooms the item as a whole: it is still drawn at the size it had, so a plot's
    // fonts, gates and margins shrink with it instead of a smaller plot being drawn. Growing
    // undoes that zoom first and then draws larger, so nothing is ever a raster scaled up.
    const zoom = zoomField(Math.min(1, layoutItemZoom(item) * scale));
    if (zoom.zoom === undefined) delete item.zoom;
    else item.zoom = zoom.zoom;
  }
}
