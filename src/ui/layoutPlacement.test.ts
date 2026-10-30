// Where plots sent from the Illustration tab land on a Layout sheet. Synthetic sheets and items:
// files D1 and D2, populations P1 to P8; an A4 landscape page is 1123 x 794 px with a 57 px margin.
import { describe, expect, it } from "vitest";
import { createLayoutSheet, DEFAULT_LAYOUT_STYLE, MAX_PAGE_GRID, type LayoutItem, type LayoutSheet } from "../engine/layout";
import { placeBlockOnPage, styleBeyondSheet } from "./layoutPlacement";

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
