import { effectiveLayoutStyle, layoutItemZoom, MAX_PAGE_GRID, mmToPx, pageSizePx, zoomField, type LayoutItem, type LayoutPlotStyle, type LayoutSheet } from "../engine/layout";

/** Below this share of what a fresh page would give, a block starts a new page rather than shrinking to fit the rest of this one. */
const NEW_PAGE_BELOW = 0.6;
/** A block is scaled down to fit its page no further than this; past it, its rows run on to further pages. */
const SMALLEST_SCALE = 0.5;
/** The space kept between a block and what the page already holds. */
const GAP = 12;

/**
 * Items just added together, as one block, onto the pages of the sheet's first column of pages:
 * below what the sheet already holds, inside the page's margin, scaled down as a whole to fit.
 *
 * The scale is each item's zoom: a plot is still drawn at the size it came with, its axes, fonts
 * and gates as they were, and shown smaller, as a picture is; resizing it later scales it the same
 * way. A block is scaled no smaller than half its size: a block taller than that runs on to the
 * next pages a whole row at a time (the items whose spans overlap down the page), the sheet
 * gaining rows of pages as it needs them, and a row of headings alone goes with the row below
 * it. When the room left on the page would shrink the block well below what a fresh page gives,
 * it starts the next page instead. A block already inside a page's margin is left where it is,
 * and nothing is ever enlarged.
 */
export function placeBlockOnPage(sheet: LayoutSheet, block: readonly LayoutItem[]): void {
  if (!block.length) return;
  const page = pageSizePx(sheet.page);
  const margin = mmToPx(sheet.page.marginMm);
  const contentWidth = page.width - 2 * margin, contentHeight = page.height - 2 * margin;
  if (contentWidth <= 0 || contentHeight <= 0) return;
  const left = Math.min(...block.map((item) => item.x)), top = Math.min(...block.map((item) => item.y));
  const width = Math.max(...block.map((item) => item.x + item.width)) - left;
  const height = Math.max(...block.map((item) => item.y + item.height)) - top;
  if (width <= 0 || height <= 0) return;
  const startRow = Math.max(0, Math.floor(top / page.height));
  if (left >= margin && left + width <= page.width - margin && top >= startRow * page.height + margin && top + height <= (startRow + 1) * page.height - margin) return;

  const inBlock = new Set(block);
  const others = sheet.items.filter((item) => !inBlock.has(item));
  const othersBottom = others.length ? Math.max(...others.map((item) => item.y + item.height)) : null;
  // This page: the one the sheet's content ends on, below that content.
  const row = othersBottom === null ? 0 : Math.max(0, Math.floor((othersBottom - 1) / page.height));
  const hereTop = othersBottom === null ? margin : Math.max(row * page.height + margin, othersBottom + GAP);
  const hereRoom = (row + 1) * page.height - margin - hereTop;
  const widthScale = Math.min(1, contentWidth / width);
  const hereScale = hereRoom > 0 ? Math.min(widthScale, hereRoom / height) : 0;
  const freshScale = Math.min(widthScale, contentHeight / height);
  const nextPage = othersBottom !== null && row + 1 < MAX_PAGE_GRID && hereScale < NEW_PAGE_BELOW * freshScale;
  const scale = Math.min(1, Math.max(Math.min(widthScale, SMALLEST_SCALE), nextPage ? freshScale : hereScale));
  if (!(scale > 0)) return;

  // The block's rows: items whose spans overlap down the page are one band, moved together. A band
  // of text alone (column headings) is held to the band below it, so it never ends a page.
  const ordered = [...block].sort((a, b) => a.y - b.y);
  const bands: { items: LayoutItem[]; top: number; bottom: number; textOnly: boolean }[] = [];
  for (const item of ordered) {
    const last = bands[bands.length - 1];
    if (last && item.y < last.bottom) {
      last.items.push(item);
      last.bottom = Math.max(last.bottom, item.y + item.height);
      last.textOnly &&= item.recipe.kind === "text";
    } else {
      bands.push({ items: [item], top: item.y, bottom: item.y + item.height, textOnly: item.recipe.kind === "text" });
    }
  }
  const units: (typeof bands)[] = [];
  for (const band of bands) {
    const last = units[units.length - 1];
    if (last && last[last.length - 1].textOnly) last.push(band);
    else units.push([band]);
  }

  let pageRow = nextPage ? row + 1 : row;
  let cursor = nextPage ? pageRow * page.height + margin : hereTop;
  let previousBottom: number | null = null;
  for (const unit of units) {
    const unitTop = unit[0].top, unitBottom = Math.max(...unit.map((band) => band.bottom));
    const unitHeight = (unitBottom - unitTop) * scale;
    const atPageTop = cursor <= pageRow * page.height + margin + 0.5;
    let y = previousBottom === null || atPageTop ? cursor : cursor + Math.max(0, unitTop - previousBottom) * scale;
    // A row that would cross the page's margin starts the next page, unless it already starts one.
    if (!atPageTop && y + unitHeight > (pageRow + 1) * page.height - margin && pageRow + 1 < MAX_PAGE_GRID) {
      pageRow += 1;
      y = pageRow * page.height + margin;
    }
    for (const band of unit) {
      for (const item of band.items) {
        item.x = Math.round(margin + (item.x - left) * scale);
        item.y = Math.round(y + (item.y - unitTop) * scale);
        if (scale < 1) {
          // The frame is the drawn size times the zoom, so what is drawn inside is unchanged.
          const zoom = zoomField(layoutItemZoom(item) * scale);
          item.width = Math.max(1, Math.round(item.width * scale));
          item.height = Math.max(1, Math.round(item.height * scale));
          if (zoom.zoom === undefined) delete item.zoom;
          else item.zoom = zoom.zoom;
        }
      }
    }
    cursor = y + unitHeight;
    previousBottom = unitBottom;
  }
  if (sheet.page.rows < pageRow + 1) sheet.page = { ...sheet.page, rows: pageRow + 1 };
  sheet.height = Math.max(sheet.height, sheet.page.rows * page.height);
  for (const item of block) {
    sheet.width = Math.max(sheet.width, item.x + item.width);
    sheet.height = Math.max(sheet.height, item.y + item.height);
  }
}

/**
 * A plot's own style, less what the sheet would give it anyway: a field the sheet already sets
 * alike stays the sheet's, so the sheet's Style still reaches it.
 */
export function styleBeyondSheet(sheet: LayoutSheet, style: Partial<LayoutPlotStyle> | undefined): Partial<LayoutPlotStyle> | undefined {
  if (!style) return undefined;
  const sheetStyle = effectiveLayoutStyle(sheet);
  const own = Object.fromEntries(Object.entries(style).filter(([key, value]) => value !== undefined && sheetStyle[key as keyof LayoutPlotStyle] !== value)) as Partial<LayoutPlotStyle>;
  return Object.keys(own).length ? own : undefined;
}
