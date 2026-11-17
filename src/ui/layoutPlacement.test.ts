// Where plots sent from the Illustration tab land on a Layout sheet. Synthetic sheets and items:
// files D1 and D2, populations P1 to P8; an A4 landscape page is 1123 x 794 px with a 57 px margin.
import { describe, expect, it } from "vitest";
import { applyLayoutPage, createLayoutSheet, DEFAULT_LAYOUT_STYLE, MAX_PAGE_GRID, type LayoutItem, type LayoutSheet } from "../engine/layout";
import { addItemOnPage, addPagesToHoldItems, alignOnTheirPage, fitItemsToTheirPages, fitPageToShownContent, itemsOffPages, nextItemFrame, pageOriginAt, placeBlockOnPage, styleBeyondSheet } from "./layoutPlacement";

const PAGE_H = 794, MARGIN = 57;

function plot(id: string, x: number, y: number, width = 260, height = 280): LayoutItem {
  return { id, x, y, width, height, z: 1, recipe: { kind: "biplot", sampleId: "D1", populationId: id, xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor" } };
}

function text(id: string, x: number, y: number, width: number, height = 28): LayoutItem {
  return { id, x, y, width, height, z: 1, recipe: { kind: "text", text: id, fontSize: 14 } };
}

/** A grid as addPlotsToLayout lays it out: column headings, then rows of two plots each with a heading. */
function grid(rows: number, top = 24): LayoutItem[] {
  const items = [text("D1", 186, top, 260), text("D2", 458, top, 260)];
  for (let row = 0; row < rows; row++) {
    const y = top + 34 + row * 292;
    items.push(text(`P${row + 1}`, 24, y, 150), plot(`P${row + 1}-D1`, 186, y), plot(`P${row + 1}-D2`, 458, y));
  }
  return items;
}

function sheetWith(existing: LayoutItem[], block: LayoutItem[]): LayoutSheet {
  const sheet = createLayoutSheet();
  sheet.items.push(...existing, ...block);
  return sheet;
}

/** The page row an item's top sits on, and whether the item lies inside that page's margin. */
function onPage(item: LayoutItem): { row: number; inside: boolean } {
  const row = Math.floor(item.y / PAGE_H);
  return { row, inside: item.y >= row * PAGE_H + MARGIN - 1 && item.y + item.height <= (row + 1) * PAGE_H - MARGIN + 1 && item.x >= MARGIN - 1 && item.x + item.width <= 1123 - MARGIN + 1 };
}

describe("placeBlockOnPage", () => {
  it("leaves a block that already sits inside the page's margin where it is", () => {
    const block = grid(1, 80).map((item) => ({ ...item, x: item.x + 40 }));
    const before = JSON.stringify(block);
    const sheet = sheetWith([], block);
    placeBlockOnPage(sheet, block);
    expect(JSON.stringify(block)).toBe(before);
    expect(sheet.page.rows).toBe(1);
  });

  it("scales a block a little too tall for the page to fit it, as a zoom, so each plot is drawn as it came", () => {
    const block = grid(3);
    const sheet = sheetWith([], block);
    placeBlockOnPage(sheet, block);
    expect(block.every((item) => onPage(item).row === 0 && onPage(item).inside)).toBe(true);
    const plots = block.filter((item) => item.recipe.kind !== "text");
    const zoom = plots[0].zoom!;
    expect(zoom).toBeLessThan(1);
    // Every item carries the one zoom, and its frame is its drawn size times it: what is drawn
    // inside (260 x 280, the axes and fonts as they were) is unchanged.
    expect(block.every((item) => item.zoom === zoom)).toBe(true);
    expect(plots[0].width / zoom).toBeCloseTo(260, -1);
    expect(plots[0].height / zoom).toBeCloseTo(280, -1);
    // The headings' words are drawn at their size and zoomed with the rest.
    const heading = block.find((item) => item.id === "P1")!;
    expect(heading.recipe.kind === "text" && heading.recipe.fontSize).toBe(14);
    expect(sheet.page.rows).toBe(1);
  });

  it("runs a block too tall to shrink readably onto further pages, a whole row at a time", () => {
    const block = grid(8);
    const sheet = sheetWith([], block);
    placeBlockOnPage(sheet, block);
    // Scaled no further than half its size.
    const plots = block.filter((item) => item.recipe.kind !== "text");
    expect(plots[0].zoom).toBe(0.5);
    // Nothing crosses a page's margin, and the sheet has the pages the rows run on to.
    expect(block.every((item) => onPage(item).inside)).toBe(true);
    const lastRow = Math.max(...block.map((item) => onPage(item).row));
    expect(lastRow).toBeGreaterThan(0);
    expect(sheet.page.rows).toBe(lastRow + 1);
    expect(sheet.height).toBeGreaterThanOrEqual(sheet.page.rows * PAGE_H);
    // A row's heading and plots stay on one page together.
    for (let row = 1; row <= 8; row++) {
      const members = block.filter((item) => item.id === `P${row}` || item.id.startsWith(`P${row}-`));
      expect(new Set(members.map((item) => onPage(item).row)).size).toBe(1);
    }
    // The column headings stay with the first row.
    expect(onPage(block.find((item) => item.id === "D1")!).row).toBe(onPage(block.find((item) => item.id === "P1-D1")!).row);
  });

  it("goes below what the page holds when there is room, and to the next page when there is not", () => {
    const small = grid(1);
    const sheet = sheetWith([plot("existing", 57, 57, 260, 120)], small);
    placeBlockOnPage(sheet, small);
    expect(Math.min(...small.map((item) => item.y))).toBeGreaterThanOrEqual(57 + 120 + 12);
    expect(small.every((item) => onPage(item).row === 0 && onPage(item).inside)).toBe(true);

    const tall = grid(2, 900);
    const full = sheetWith([plot("existing", 57, 57, 260, 600)], tall);
    placeBlockOnPage(full, tall);
    expect(tall.every((item) => onPage(item).row === 1 && onPage(item).inside)).toBe(true);
    expect(full.page.rows).toBe(2);
  });

  it("scales a block wider than the page to the page's width", () => {
    const block = [plot("wide-1", 24, 24, 600, 280), plot("wide-2", 636, 24, 600, 280)];
    const sheet = sheetWith([], block);
    placeBlockOnPage(sheet, block);
    expect(Math.max(...block.map((item) => item.x + item.width))).toBeLessThanOrEqual(1123 - MARGIN + 1);
    expect(block.every((item) => onPage(item).inside)).toBe(true);
  });

  it("never enlarges, and fits a block to a narrow page's width", () => {
    const small = [plot("tiny", 2000, 2000, 150, 150)];
    const sheet = sheetWith([], small);
    placeBlockOnPage(sheet, small);
    expect(small[0]).toMatchObject({ width: 150, height: 150 });
    expect(small[0].zoom).toBeUndefined();
    expect(onPage(small[0]).inside).toBe(true);

    // A one-column journal page, with no margin: the pair is zoomed to the page's width.
    const journal = createLayoutSheet("J", { preset: "journal-1", orientation: "portrait", widthMm: 85, heightMm: 110, marginMm: 0, dpi: 300, columns: 1, rows: 1 });
    const pair = [plot("j1", 24, 24), plot("j2", 296, 24)];
    journal.items.push(...pair);
    placeBlockOnPage(journal, pair);
    expect(Math.max(...pair.map((item) => item.x + item.width))).toBeLessThanOrEqual(Math.round(85 * 96 / 25.4) + 1);
  });

  it("adds no more page rows than a sheet may have", () => {
    const block = grid(60);
    const sheet = sheetWith([], block);
    placeBlockOnPage(sheet, block);
    expect(sheet.page.rows).toBe(MAX_PAGE_GRID);
  });

  it("puts a block that would run past the last page of a full grid on that last page, scaled to fit it", () => {
    const block = grid(60);
    const sheet = sheetWith([], block);
    placeBlockOnPage(sheet, block);
    const last = MAX_PAGE_GRID - 1;
    for (const item of block) expect(onPage(item)).toEqual({ row: last, inside: true });
    expect(itemsOffPages(sheet)).toEqual([]);
  });

  it("puts a new item on the last page when every page of a full grid is taken", () => {
    const sheet = createLayoutSheet();
    sheet.page = { ...sheet.page, rows: MAX_PAGE_GRID };
    for (let row = 0; row < MAX_PAGE_GRID; row++) sheet.items.push(plot(`full${row}`, MARGIN, row * PAGE_H + MARGIN, 1123 - 2 * MARGIN, PAGE_H - 2 * MARGIN));
    const item = addItemOnPage(sheet, { kind: "text", text: "late", fontSize: 14 }, { width: 200, height: 60 });
    expect(onPage(item)).toEqual({ row: MAX_PAGE_GRID - 1, inside: true });
    expect(sheet.page.rows).toBe(MAX_PAGE_GRID);
    expect(itemsOffPages(sheet)).toEqual([]);
  });

  it("scales a zoomed item's frame no further than its zoom goes, so what is drawn keeps its size", () => {
    // 4000 px across into the page's 1009: a scale of 0.25, but a zoom of 0.15 goes only to 0.1.
    const block = [{ ...plot("zoomed", 24, 2000, 4000, 300), zoom: 0.15 }];
    const sheet = sheetWith([], block);
    placeBlockOnPage(sheet, block);
    expect(block[0].zoom).toBe(0.1);
    expect(block[0].width / block[0].zoom!).toBeCloseTo(4000 / 0.15, -1);
    expect(block[0].height / block[0].zoom!).toBeCloseTo(300 / 0.15, -1);
  });
});

describe("placeBlockOnPage, the page a block goes on", () => {
  it("starts the next page when the room left would show the block smaller than a fresh page does", () => {
    // 400 px of the page's 680 are taken; a 400 px block would have to shrink to fit the rest.
    const block = [plot("new", 24, 2000, 400, 400)];
    const sheet = sheetWith([plot("existing", 57, 57, 400, 400)], block);
    placeBlockOnPage(sheet, block);
    expect(block[0]).toMatchObject({ x: 57, y: 794 + 57, width: 400, height: 400 });
    expect(block[0].zoom).toBeUndefined();
    expect(sheet.page.rows).toBe(2);
  });

  it("keeps the sheet the size of its pages", () => {
    const block = grid(8);
    const sheet = sheetWith([], block);
    placeBlockOnPage(sheet, block);
    expect([sheet.width, sheet.height]).toEqual([1123, sheet.page.rows * PAGE_H]);
  });

  it("leaves a block inside the margin of a page in another column where it is", () => {
    const sheet = createLayoutSheet();
    sheet.page = { ...sheet.page, columns: 2 };
    const block = [plot("second", 1123 + 100, 100)];
    sheet.items.push(...block);
    placeBlockOnPage(sheet, block);
    expect(block[0]).toMatchObject({ x: 1223, y: 100 });
  });
});

describe("nextItemFrame and addItemOnPage", () => {
  it("takes a free place on a later page before going below everything", () => {
    const sheet = createLayoutSheet();
    sheet.page = { ...sheet.page, rows: 2 };
    sheet.items.push(plot("full", 57, 57, 1009, 680), plot("second", 57, 794 + 57, 400, 400));
    const frame = nextItemFrame(sheet, 400, 400);
    // Beside the plot on the second page, not under it.
    expect(frame).toMatchObject({ x: 477, y: 794 + 57 });
  });

  it("puts each new item on a page, adding pages as they fill", () => {
    const sheet = createLayoutSheet();
    const recipe = plot("P1", 0, 0).recipe;
    for (let n = 0; n < 9; n++) addItemOnPage(sheet, recipe, { width: 480, height: 300 });
    // Two across and two down fit inside the margin of an A4 landscape page.
    expect(sheet.items.map((item) => Math.floor(item.y / PAGE_H))).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2]);
    expect(sheet.items.every((item) => onPage(item).inside)).toBe(true);
    expect(sheet.page.rows).toBe(3);
    expect(itemsOffPages(sheet)).toHaveLength(0);
  });
});

describe("itemsOffPages and addPagesToHoldItems", () => {
  it("names what an export would cut or leave out, and adds the pages that hold it without moving anything", () => {
    const sheet = createLayoutSheet();
    const inside = plot("inside", 57, 57), below = plot("below", 57, 900), wide = plot("wide", 900, 100, 400, 200);
    sheet.items.push(inside, below, wide, { ...plot("hidden", 57, 5000), hidden: true });
    expect(itemsOffPages(sheet).map((item) => item.id)).toEqual(["below", "wide"]);
    const before = JSON.stringify(sheet.items);
    addPagesToHoldItems(sheet);
    expect(JSON.stringify(sheet.items)).toBe(before);
    expect([sheet.page.columns, sheet.page.rows]).toEqual([2, 2]);
    expect([sheet.width, sheet.height]).toEqual([2 * 1123, 2 * PAGE_H]);
    expect(itemsOffPages(sheet)).toHaveLength(0);
  });
});

describe("pageOriginAt", () => {
  it("gives the corner of the page a point is on, a point beyond the pages taken to the nearest", () => {
    const page = { ...createLayoutSheet().page, columns: 2, rows: 2 };
    expect(pageOriginAt(page, 10, 10)).toEqual({ x: 0, y: 0 });
    expect(pageOriginAt(page, 1123, 10)).toEqual({ x: 1123, y: 0 });
    expect(pageOriginAt(page, 1122.9, PAGE_H + 1)).toEqual({ x: 0, y: PAGE_H });
    expect(pageOriginAt(page, -50, 5000)).toEqual({ x: 0, y: PAGE_H });
    expect(pageOriginAt(page, 9999, -1)).toEqual({ x: 1123, y: 0 });
    expect(pageOriginAt({ ...page, columns: 1, rows: 1 }, 2000, 2000)).toEqual({ x: 0, y: 0 });
  });
});

describe("fitItemsToTheirPages", () => {
  /** Two pages down: a plot on each, and a small one beside the first. */
  function twoPages(): LayoutSheet {
    const sheet = createLayoutSheet();
    sheet.page = { ...sheet.page, rows: 2 };
    sheet.height = 2 * PAGE_H;
    sheet.items.push(plot("first", 100, 100, 200, 100), plot("beside", 600, 400, 100, 100), plot("second", 100, PAGE_H + 100, 200, 400));
    return sheet;
  }

  it("fits a selected item to the page it is on and moves nothing else", () => {
    const sheet = twoPages();
    const others = JSON.stringify([sheet.items[0], sheet.items[1]]);
    fitItemsToTheirPages(sheet, ["second"]);
    // 200 x 400 into the second page's 1009 x 680: scaled by 1.7 and centred across.
    expect(sheet.items[2]).toMatchObject({ x: Math.round(57 + (1009 - 340) / 2), y: PAGE_H + 57, width: 340, height: 680 });
    expect(JSON.stringify([sheet.items[0], sheet.items[1]])).toBe(others);
  });

  it("fits items selected on several pages each to their own page", () => {
    const sheet = twoPages();
    fitItemsToTheirPages(sheet, ["first", "second"]);
    // 200 x 100 fills the first page's width: scaled by 5.045, centred down the page.
    expect(sheet.items[0]).toMatchObject({ x: 57, width: 1009, height: 505 });
    expect(Math.floor(sheet.items[0].y / PAGE_H)).toBe(0);
    expect(sheet.items[2]).toMatchObject({ y: PAGE_H + 57, width: 340, height: 680 });
    expect(sheet.items[1]).toMatchObject({ x: 600, y: 400, width: 100, height: 100 });
  });

  it("with nothing chosen fits each page's items to that page, as one group a page", () => {
    const sheet = twoPages();
    fitItemsToTheirPages(sheet);
    // Page one: first and beside span 100..700 x 100..500, scaled by 1009 / 600.
    const scale = 1009 / 600;
    expect(sheet.items[0]).toMatchObject({ x: 57, width: Math.round(200 * scale) });
    expect(sheet.items[1].x + sheet.items[1].width).toBe(57 + 1009);
    expect(sheet.items.slice(0, 2).every((item) => onPage(item).row === 0 && onPage(item).inside)).toBe(true);
    expect(onPage(sheet.items[2])).toEqual({ row: 1, inside: true });
    expect(sheet.page.rows).toBe(2);
  });

  it("shrinks as a zoom, so a plot is drawn as it was and shown smaller", () => {
    const sheet = createLayoutSheet();
    sheet.items.push(plot("big", 0, 0, 2018, 680));
    fitItemsToTheirPages(sheet, ["big"]);
    expect(sheet.items[0]).toMatchObject({ x: 57, width: 1009, height: 340, zoom: 0.5 });
  });

  it("shrinks a zoomed item's frame no further than its zoom goes, so what is drawn keeps its size", () => {
    const sheet = createLayoutSheet();
    sheet.items.push({ ...plot("zoomed", 60, 60, 4000, 400), zoom: 0.15 });
    fitItemsToTheirPages(sheet, ["zoomed"]);
    const item = sheet.items[0];
    expect(item).toMatchObject({ x: 57, zoom: 0.1 });
    expect(item.width / item.zoom!).toBeCloseTo(4000 / 0.15, -1);
    expect(item.height / item.zoom!).toBeCloseTo(400 / 0.15, -1);
  });

  it("leaves a locked item as it is", () => {
    const sheet = createLayoutSheet();
    sheet.items.push({ ...plot("locked", 100, 100), locked: true }, plot("free", 500, 100, 200, 100));
    fitItemsToTheirPages(sheet);
    expect(sheet.items[0]).toMatchObject({ x: 100, y: 100, width: 260, height: 280 });
    expect(sheet.items[1]).toMatchObject({ x: 57, width: 1009 });
  });

  it("does nothing on a page whose margin leaves no room", () => {
    const sheet = createLayoutSheet();
    sheet.page = { ...sheet.page, marginMm: 120 };
    sheet.items.push(plot("P1", 100, 100));
    const before = JSON.stringify(sheet.items);
    fitItemsToTheirPages(sheet);
    expect(JSON.stringify(sheet.items)).toBe(before);
  });
});

describe("alignOnTheirPage", () => {
  /** A sheet of two pages across and two down, with the items given. */
  function twoByTwo(...items: LayoutItem[]): LayoutSheet {
    const sheet = createLayoutSheet();
    applyLayoutPage(sheet, { ...sheet.page, columns: 2, rows: 2 });
    sheet.items.push(...items);
    return sheet;
  }

  it("aligns one item to the content box of the page it is on", () => {
    const item = plot("a", 1123 + 300, PAGE_H + 200);
    const sheet = twoByTwo(item);
    alignOnTheirPage(sheet, ["a"], "left");
    expect(item.x).toBe(1123 + MARGIN);
    alignOnTheirPage(sheet, ["a"], "bottom");
    expect(item.y + item.height).toBe(2 * PAGE_H - MARGIN);
    alignOnTheirPage(sheet, ["a"], "centerX");
    expect(item.x).toBe(1123 + Math.round(MARGIN + (1123 - 2 * MARGIN - 260) / 2));
  });

  it("aligns a group to the page its centre is on, its members keeping their places", () => {
    const a = { ...plot("a", 300, PAGE_H + 100), group: "g" }, b = { ...plot("b", 600, PAGE_H + 300), group: "g" };
    const sheet = twoByTwo(a, b);
    alignOnTheirPage(sheet, ["a", "b"], "top");
    expect([a.y, b.y]).toEqual([PAGE_H + MARGIN, PAGE_H + MARGIN + 200]);
  });

  it("moves nothing on a page whose margin leaves no room", () => {
    const item = plot("a", 40, 40, 100, 100);
    const sheet = createLayoutSheet("J", { preset: "journal-1", orientation: "landscape", widthMm: 85, heightMm: 110, marginMm: 60, dpi: 300, columns: 1, rows: 1 });
    sheet.items.push(item);
    for (const how of ["left", "right", "centerX", "top", "bottom", "centerY"] as const) alignOnTheirPage(sheet, ["a"], how);
    expect([item.x, item.y]).toEqual([40, 40]);
  });

  it("aligns several items to one another as before", () => {
    const a = plot("a", 300, 100), b = plot("b", 1123 + 300, PAGE_H + 300);
    const sheet = twoByTwo(a, b);
    alignOnTheirPage(sheet, ["a", "b"], "top");
    expect([a.y, b.y]).toEqual([100, 100]);
  });
});

describe("fitPageToShownContent", () => {
  it("sizes the page to the items that are shown, and moves the guides with the content", () => {
    const a = plot("a", 300, 200, 100, 100), b = plot("b", 700, 500, 100, 100), hidden = { ...plot("h", 2000, 2000, 100, 100), hidden: true };
    const sheet = createLayoutSheet();
    sheet.items.push(a, b, hidden);
    sheet.guides = [{ axis: "x", at: 350 }, { axis: "y", at: 600 }];
    expect(fitPageToShownContent(sheet)).toBe(false);
    expect([a.x, a.y, b.x, b.y]).toEqual([MARGIN, MARGIN, MARGIN + 400, MARGIN + 300]);
    expect([hidden.x, hidden.y]).toEqual([MARGIN + 1700, MARGIN + 1800]); // moved with the rest
    expect(sheet.guides).toEqual([{ axis: "x", at: MARGIN + 50 }, { axis: "y", at: MARGIN + 400 }]);
    expect(sheet.page).toMatchObject({ preset: "custom", columns: 1, rows: 1, widthMm: 162.5, heightMm: 136 });
  });

  it("stops at the largest page a sheet keeps, with the content scaled down to stay on it", () => {
    const a = plot("a", 0, 0, 260, 280), b = plot("b", 9000, 100, 260, 280);
    const sheet = createLayoutSheet();
    sheet.items.push(a, b);
    sheet.guides = [{ axis: "x", at: 9000 }];
    expect(fitPageToShownContent(sheet)).toBe(true);
    expect(sheet.page.widthMm).toBeLessThanOrEqual(2000);
    expect(itemsOffPages(sheet)).toEqual([]);
    expect(b.x + b.width).toBeLessThanOrEqual(sheet.width - MARGIN + 1);
    expect(b.zoom).toBeLessThan(1);
    expect(sheet.guides![0].at).toBeCloseTo(b.x, 0);
  });

  it("scales a zoomed item's frame no further than its zoom goes, so what is drawn keeps its size", () => {
    const a = { ...plot("a", 0, 0, 30000, 300), zoom: 0.15 };
    const sheet = createLayoutSheet();
    sheet.items.push(a);
    expect(fitPageToShownContent(sheet)).toBe(true);
    expect(a.zoom).toBe(0.1);
    expect(a.width / a.zoom!).toBeCloseTo(30000 / 0.15, -1);
    expect(a.height / a.zoom!).toBeCloseTo(300 / 0.15, -1);
  });
});

describe("styleBeyondSheet", () => {
  it("keeps only the fields the sheet would draw otherwise", () => {
    const sheet = createLayoutSheet();
    sheet.style = { pubStyle: true };
    expect(styleBeyondSheet(sheet, { pubStyle: true, pointSize: DEFAULT_LAYOUT_STYLE.pointSize, fontAxis: 13 })).toEqual({ fontAxis: 13 });
    expect(styleBeyondSheet(sheet, { pubStyle: true })).toBeUndefined();
    expect(styleBeyondSheet(sheet, undefined)).toBeUndefined();
  });
});
