import { applyLayoutPage, effectiveLayoutStyle, layoutItemZoom, MAX_PAGE_GRID, mmToPx, pageOrigins, pageSizePx, pxToMm, zoomField, type LayoutItem, type LayoutItemFrame, type LayoutPage, type LayoutPlotStyle, type LayoutRecipe, type LayoutSheet } from "../engine/layout";
import { alignItems, arrangeUnits, contentBounds, type AlignHow } from "../engine/layoutArrange";

/** A block of several rows is scaled down to fit its page no further than this; past it, its rows run on to further pages. */
const SMALLEST_SCALE = 0.5;
/** The space kept between a block and what the page already holds. */
const GAP = 12;

/**
 * How far an item's frame is scaled when it is shrunk by `by` as a zoom: no further than its zoom
 * can go (0.1 to 4), so the frame stays the drawn size times the zoom and what is drawn keeps its
 * size; past that, the item is left larger than asked. Never more than 1.
 */
function frameShrink(item: LayoutItem, by: number): number {
  const zoom = layoutItemZoom(item);
  return Math.min(1, Math.min(4, Math.max(0.1, zoom * by)) / zoom);
}

/**
 * Items just added together, as one block, onto the pages of the sheet's first column of pages:
 * below what the sheet already holds, inside the page's margin, scaled down as a whole to fit.
 *
 * The scale is each item's zoom: a plot is still drawn at the size it came with, its axes, fonts
 * and gates as they were, and shown smaller, as a picture is; resizing it later scales it the same
 * way. A block of several rows is scaled no smaller than half its size: a block taller than that
 * runs on to the next pages a whole row at a time (the items whose spans overlap down the page),
 * and a row of headings alone goes with the row below it; a block of one row, which cannot be
 * divided, is scaled until a page holds it. A block that does not fit in the room left on the
 * page, at the size a fresh page would show it, starts the next page. The sheet gains rows of
 * pages as the block needs them, and its size stays that of its pages, so what is on the sheet is
 * on a page and is exported. A block that would run past the most pages a sheet may have goes, whole,
 * on the last page of its first column, scaled to fit that page. A block already inside a page's
 * margin is left where it is, and nothing is ever enlarged.
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
  const startRow = Math.max(0, Math.floor(top / page.height)), startColumn = Math.max(0, Math.floor(left / page.width));
  if (
    startRow < sheet.page.rows && startColumn < sheet.page.columns &&
    left >= startColumn * page.width + margin && left + width <= (startColumn + 1) * page.width - margin &&
    top >= startRow * page.height + margin && top + height <= (startRow + 1) * page.height - margin
  ) return;

  const inBlock = new Set(block);
  const others = sheet.items.filter((item) => !inBlock.has(item));
  const othersBottom = others.length ? Math.max(...others.map((item) => item.y + item.height)) : null;
  // This page: the one the sheet's content ends on, below that content.
  const row = othersBottom === null ? 0 : Math.max(0, Math.floor((othersBottom - 1) / page.height));
  const hereTop = othersBottom === null ? margin : Math.max(row * page.height + margin, othersBottom + GAP);
  const hereRoom = (row + 1) * page.height - margin - hereTop;
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

  const widthScale = Math.min(1, contentWidth / width);
  const hereScale = hereRoom > 0 ? Math.min(widthScale, hereRoom / height) : 0;
  const freshScale = Math.min(widthScale, contentHeight / height);
  // Rows can run on to further pages, so several of them are scaled no further than the floor;
  // one row cannot, and is scaled until the page holds it.
  const floor = units.length > 1 ? Math.min(widthScale, SMALLEST_SCALE) : 0;
  const nextPage = othersBottom !== null && row + 1 < MAX_PAGE_GRID && Math.max(floor, hereScale) < Math.max(floor, freshScale) - 1e-6;
  const scale = Math.min(1, Math.max(floor, nextPage ? freshScale : hereScale));
  const frames = new Map(block.map((item) => [item, { x: item.x, y: item.y, width: item.width, height: item.height, zoom: item.zoom }]));
  // `whole`: the frame takes the full scale even past what the zoom can follow (the plot is then
  // drawn smaller), for a block that must fit the last page the grid may have.
  const put = (item: LayoutItem, x: number, y: number, by: number, whole = false) => {
    item.x = Math.round(x);
    item.y = Math.round(y);
    if (by < 1) {
      // The frame is the drawn size times the zoom, so what is drawn inside is unchanged.
      const frameBy = whole ? by : frameShrink(item, by);
      const zoom = zoomField(layoutItemZoom(item) * frameBy);
      item.width = Math.max(1, Math.round(item.width * frameBy));
      item.height = Math.max(1, Math.round(item.height * frameBy));
      if (zoom.zoom === undefined) delete item.zoom;
      else item.zoom = zoom.zoom;
    }
  };
  // The grid has no page left below for the block: it goes, whole, on the last page of the first
  // column, scaled to fit that page as a fresh page would show it, over what that page holds.
  const onLastPage = () => {
    const lastRow = MAX_PAGE_GRID - 1;
    for (const item of block) {
      const frame = frames.get(item)!;
      Object.assign(item, frame);
      if (frame.zoom === undefined) delete item.zoom;
      put(item, margin + (frame.x - left) * freshScale, lastRow * page.height + margin + (frame.y - top) * freshScale, freshScale, true);
    }
    applyLayoutPage(sheet, { ...sheet.page, rows: MAX_PAGE_GRID });
  };
  // The next page the block would start is beyond the grid.
  const pastGrid = othersBottom !== null && row + 1 >= MAX_PAGE_GRID && Math.max(floor, hereScale) < Math.max(floor, freshScale) - 1e-6;
  if (row >= MAX_PAGE_GRID || pastGrid) return onLastPage();
  if (!(scale > 0)) return;

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
    // Past the last page the grid may have, nothing is a page.
    if (pageRow + 1 >= MAX_PAGE_GRID && y + unitHeight > (pageRow + 1) * page.height - margin + 0.5) return onLastPage();
    for (const band of unit) {
      for (const item of band.items) put(item, margin + (item.x - left) * scale, y + (item.y - unitTop) * scale, scale);
    }
    cursor = y + unitHeight;
    previousBottom = unitBottom;
  }
  applyLayoutPage(sheet, sheet.page.rows < pageRow + 1 ? { ...sheet.page, rows: pageRow + 1 } : sheet.page);
}

const PLACEMENT_STEP = 20;

/**
 * Where a new item of this size goes: the first place inside a page's margin where it overlaps
 * nothing, the pages taken in order and each scanned row by row on a 20 px lattice; when no page
 * has room, below everything the sheet holds, where placeBlockOnPage puts it on a page.
 */
export function nextItemFrame(sheet: LayoutSheet, width = 260, height = 280): Pick<LayoutItemFrame, "x" | "y" | "width" | "height" | "z"> {
  const z = Math.max(0, ...sheet.items.map((item) => item.z)) + 1;
  const page = pageSizePx(sheet.page);
  const inset = Math.max(24, mmToPx(sheet.page.marginMm));
  const gap = 12;
  const overlaps = (x: number, y: number) =>
    sheet.items.some((item) =>
      x < item.x + item.width + gap && x + width + gap > item.x &&
      y < item.y + item.height + gap && y + height + gap > item.y);
  for (const origin of pageOrigins(sheet.page)) {
    for (let y = origin.y + inset; y + height <= origin.y + page.height - inset; y += PLACEMENT_STEP) {
      for (let x = origin.x + inset; x + width <= origin.x + page.width - inset; x += PLACEMENT_STEP) {
        if (!overlaps(x, y)) return { x, y, width, height, z };
      }
    }
  }
  const bottom = Math.max(inset - gap, ...sheet.items.map((item) => item.y + item.height));
  return { x: inset, y: bottom + gap, width, height, z };
}

/**
 * A new item on the sheet, on a page: in the first free place a page has for it, else below what
 * the sheet holds, scaled as a whole to the page's width and height when it is larger than the
 * page, on a new page when the room left on the last one does not hold it. Returns the item.
 */
export function addItemOnPage(sheet: LayoutSheet, recipe: LayoutRecipe, size?: { width: number; height: number }, id: string = crypto.randomUUID()): LayoutItem {
  const item: LayoutItem = { id, ...nextItemFrame(sheet, size?.width, size?.height), recipe };
  sheet.items.push(item);
  placeBlockOnPage(sheet, [item]);
  return item;
}

/** The items that lie, in whole or in part, outside every page of the sheet: what an export leaves out or cuts. */
export function itemsOffPages(sheet: LayoutSheet): LayoutItem[] {
  const size = pageSizePx(sheet.page);
  const right = size.width * sheet.page.columns, bottom = size.height * sheet.page.rows;
  return sheet.items.filter((item) => !item.hidden && (item.x < 0 || item.y < 0 || item.x + item.width > right + 0.5 || item.y + item.height > bottom + 0.5));
}

/**
 * Give the sheet the pages its items reach: rows and columns of pages are added, up to the most a
 * sheet may have, until every item's right and bottom edges are on a page. No item moves, and no
 * page is taken away.
 */
export function addPagesToHoldItems(sheet: LayoutSheet): void {
  const shown = sheet.items.filter((item) => !item.hidden);
  if (!shown.length) return;
  const size = pageSizePx(sheet.page);
  const right = Math.max(...shown.map((item) => item.x + item.width)), bottom = Math.max(...shown.map((item) => item.y + item.height));
  const columns = Math.min(MAX_PAGE_GRID, Math.max(sheet.page.columns, Math.ceil((right - 0.5) / size.width)));
  const rows = Math.min(MAX_PAGE_GRID, Math.max(sheet.page.rows, Math.ceil((bottom - 0.5) / size.height)));
  if (columns !== sheet.page.columns || rows !== sheet.page.rows) applyLayoutPage(sheet, { ...sheet.page, columns, rows });
}

/**
 * Fit items to the pages they are on: the items on each page are scaled and moved, as one group,
 * to fill that page inside its margin as far as their proportions allow, centred there. `ids`
 * are the chosen items; with none, every item that is not hidden is taken, each page's with its
 * own page. An item belongs to the page its centre is on, a group to the page the centre of its
 * members' bounds is on, and one lying beyond the sheet's pages to the nearest of them. A locked
 * item stays as it is, nothing on another page moves, and the pages are unchanged.
 */
export function fitItemsToTheirPages(sheet: LayoutSheet, ids: readonly string[] = []): void {
  const page = pageSizePx(sheet.page);
  const margin = mmToPx(sheet.page.marginMm);
  const boxWidth = page.width - 2 * margin, boxHeight = page.height - 2 * margin;
  if (boxWidth <= 0 || boxHeight <= 0) return;
  const chosen = sheet.items.filter((item) => !item.locked && (ids.length ? ids.includes(item.id) : !item.hidden));
  const byPage = new Map<string, { column: number; row: number; items: LayoutItem[] }>();
  for (const unit of arrangeUnits(chosen)) {
    const bounds = contentBounds(unit)!;
    const column = Math.min(sheet.page.columns - 1, Math.max(0, Math.floor((bounds.x + bounds.width / 2) / page.width)));
    const row = Math.min(sheet.page.rows - 1, Math.max(0, Math.floor((bounds.y + bounds.height / 2) / page.height)));
    const key = `${row},${column}`;
    const there = byPage.get(key);
    if (there) there.items.push(...unit);
    else byPage.set(key, { column, row, items: [...unit] });
  }
  for (const { column, row, items } of byPage.values()) {
    const bounds = contentBounds(items);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue;
    const scale = Math.min(boxWidth / bounds.width, boxHeight / bounds.height);
    const originX = column * page.width + margin + (boxWidth - bounds.width * scale) / 2;
    const originY = row * page.height + margin + (boxHeight - bounds.height * scale) / 2;
    for (const item of items) {
      item.x = Math.round(originX + (item.x - bounds.x) * scale);
      item.y = Math.round(originY + (item.y - bounds.y) * scale);
      // A shrink goes no further than the item's zoom can follow.
      const frameBy = scale < 1 ? frameShrink(item, scale) : scale;
      item.width = Math.max(1, Math.round(item.width * frameBy));
      item.height = Math.max(1, Math.round(item.height * frameBy));
      // Shrinking zooms the item as a whole: it is still drawn at the size it had, so a plot's
      // fonts, gates and margins shrink with it instead of a smaller plot being drawn. Growing
      // undoes that zoom first and then draws larger, so nothing is ever a raster scaled up.
      const zoom = zoomField(Math.min(1, layoutItemZoom(item) * frameBy));
      if (zoom.zoom === undefined) delete item.zoom;
      else item.zoom = zoom.zoom;
    }
  }
}

/**
 * Align the chosen items as alignItems does, except that one item, or one group, aligns to the
 * content box of the page it is on (the page its centre is on, as fitItemsToTheirPages decides
 * it) rather than the first page's. Several items or groups align to one another, as before.
 */
export function alignOnTheirPage(sheet: LayoutSheet, ids: readonly string[], how: AlignHow): void {
  const units = arrangeUnits(sheet.items.filter((item) => ids.includes(item.id)));
  if (units.length !== 1) return alignItems(sheet, ids, how);
  const page = pageSizePx(sheet.page);
  // A margin of half the page or more leaves no box to align to.
  if (2 * mmToPx(sheet.page.marginMm) >= Math.min(page.width, page.height)) return;
  const bounds = contentBounds(units[0])!;
  const column = Math.min(sheet.page.columns - 1, Math.max(0, Math.floor((bounds.x + bounds.width / 2) / page.width)));
  const row = Math.min(sheet.page.rows - 1, Math.max(0, Math.floor((bounds.y + bounds.height / 2) / page.height)));
  // alignItems aligns a lone unit to the first page's box: move it there by whole pages, align, and move it back.
  const dx = column * page.width, dy = row * page.height;
  for (const item of units[0]) { item.x -= dx; item.y -= dy; }
  alignItems(sheet, ids, how);
  for (const item of units[0]) { item.x += dx; item.y += dy; }
}

/**
 * The top-left corner, in sheet px, of the page a point is on, by the rule fitItemsToTheirPages
 * and alignOnTheirPage use for an item's centre: a point beyond the sheet's pages is taken to the
 * nearest of them. Positions shown to the user (an item's X and Y, the rulers, a guide) are
 * measured from this corner; they are kept from the first page's.
 */
export function pageOriginAt(page: LayoutPage, x: number, y: number): { x: number; y: number } {
  const size = pageSizePx(page);
  const column = Math.min(page.columns - 1, Math.max(0, Math.floor(x / size.width)));
  const row = Math.min(page.rows - 1, Math.max(0, Math.floor(y / size.height)));
  return { x: column * size.width, y: row * size.height };
}

/** The largest page side a sheet keeps: a saved page is held to it when it is opened again. */
const LARGEST_PAGE_MM = 2000;

/**
 * Make the page a custom size that holds every shown item inside its margin, as one page, as
 * fitPageToContent does, with three differences: hidden items are left out of the size (they move
 * with the rest), the guides move with the content, and the page stops at the largest size a
 * sheet keeps, the content scaled down, as a zoom, to stay on it. Returns whether it stopped there.
 */
export function fitPageToShownContent(sheet: LayoutSheet): boolean {
  const bounds = contentBounds(sheet.items.filter((item) => !item.hidden));
  if (!bounds) return false;
  const margin = mmToPx(sheet.page.marginMm);
  const room = mmToPx(LARGEST_PAGE_MM) - 2 * margin - 1;
  const scale = Math.min(1, room / Math.max(1, bounds.width), room / Math.max(1, bounds.height));
  for (const item of sheet.items) {
    item.x = Math.round(margin + (item.x - bounds.x) * scale);
    item.y = Math.round(margin + (item.y - bounds.y) * scale);
    if (scale < 1) {
      const frameBy = frameShrink(item, scale);
      const zoom = zoomField(layoutItemZoom(item) * frameBy);
      item.width = Math.max(1, Math.round(item.width * frameBy));
      item.height = Math.max(1, Math.round(item.height * frameBy));
      if (zoom.zoom === undefined) delete item.zoom;
      else item.zoom = zoom.zoom;
    }
  }
  for (const guide of sheet.guides ?? []) {
    guide.at = Math.round((margin + (guide.at - (guide.axis === "x" ? bounds.x : bounds.y)) * scale) * 100) / 100;
  }
  const sideMm = (px: number) => Math.min(LARGEST_PAGE_MM, Math.max(40, pxToMm(px + 2 * margin)));
  applyLayoutPage(sheet, {
    ...sheet.page,
    preset: "custom",
    orientation: "portrait",
    widthMm: sideMm(bounds.width * scale),
    heightMm: sideMm(bounds.height * scale),
    columns: 1,
    rows: 1,
  });
  return scale < 1;
}

/** The largest whole-millimetre margin, up to 100 mm, that leaves the page some room inside it. */
export function largestMarginMm(page: LayoutPage): number {
  const size = pageSizePx(page);
  let margin = 100;
  while (margin > 0 && 2 * mmToPx(margin) >= Math.min(size.width, size.height)) margin -= 1;
  return margin;
}

/** The page with its margin held to largestMarginMm when it would leave no room inside it. */
export function pageWithRoom(page: LayoutPage): LayoutPage {
  const size = pageSizePx(page);
  return 2 * mmToPx(page.marginMm) >= Math.min(size.width, size.height) ? { ...page, marginMm: largestMarginMm(page) } : page;
}

/**
 * A plot's own style, less what the sheet would give it anyway: a field the sheet already sets
 * alike stays the sheet's, so the sheet's Style still reaches it. `figure` is the workspace's
 * figure style, which a sheet that follows it takes.
 */
export function styleBeyondSheet(sheet: LayoutSheet, style: Partial<LayoutPlotStyle> | undefined, figure?: Partial<LayoutPlotStyle> | null): Partial<LayoutPlotStyle> | undefined {
  if (!style) return undefined;
  const sheetStyle = effectiveLayoutStyle(sheet, null, figure);
  const own = Object.fromEntries(Object.entries(style).filter(([key, value]) => value !== undefined && sheetStyle[key as keyof LayoutPlotStyle] !== value)) as Partial<LayoutPlotStyle>;
  return Object.keys(own).length ? own : undefined;
}
