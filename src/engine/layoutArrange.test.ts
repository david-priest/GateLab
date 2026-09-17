import { describe, expect, it } from "vitest";
import { createLayoutSheet, layoutItemMinimum, pageForPreset, type LayoutItem } from "./layout";
import { alignItems, contentBounds, distributeItems, fitContentToPage, fitPageToContent, pageContentBox } from "./layoutArrange";

function item(id: string, x: number, y: number, width = 100, height = 80): LayoutItem {
  return { id, x, y, width, height, z: 0, recipe: { kind: "text", text: id, fontSize: 12 } };
}
function sheetWith(...items: LayoutItem[]) {
  const sheet = createLayoutSheet("S"); // A4 landscape: 1123 × 794 px, 15 mm (57 px) margin
  sheet.items = items;
  return sheet;
}
const frames = (sheet: { items: LayoutItem[] }) => sheet.items.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }));

describe("alignment", () => {
  it("aligns several items to the edges or centre of their own bounds", () => {
    const sheet = sheetWith(item("a", 100, 100), item("b", 300, 250, 50, 40), item("c", 200, 400, 200, 20));
    alignItems(sheet, ["a", "b", "c"], "left");
    expect(sheet.items.map((i) => i.x)).toEqual([100, 100, 100]);
    alignItems(sheet, ["a", "b", "c"], "right"); // right edge of the bounds: 300 (c: 100 + 200)
    expect(sheet.items.map((i) => i.x)).toEqual([200, 250, 100]);
    alignItems(sheet, ["a", "b", "c"], "top");
    expect(sheet.items.map((i) => i.y)).toEqual([100, 100, 100]);
    alignItems(sheet, ["a", "b"], "centerY"); // a and b: bounds 100..180, both centred on 140
    expect(sheet.items.slice(0, 2).map((i) => i.y)).toEqual([100, 120]);
  });

  it("aligns a single item to the page's content box", () => {
    const sheet = sheetWith(item("a", 500, 500));
    const box = pageContentBox(sheet);
    expect(box).toEqual({ x: 57, y: 57, width: 1009, height: 680 });
    alignItems(sheet, ["a"], "centerX");
    alignItems(sheet, ["a"], "bottom");
    expect(frames(sheet)[0]).toMatchObject({ x: 57 + Math.round((1009 - 100) / 2), y: 57 + 680 - 80 });
  });

  it("distributes three or more items with equal gaps between the outermost two", () => {
    const sheet = sheetWith(item("a", 0, 0, 100), item("b", 130, 0, 60), item("c", 500, 0, 100));
    distributeItems(sheet, ["a", "b", "c"], "horizontal");
    // span 0..600, occupied 260, two gaps of 170
    expect(sheet.items.map((i) => i.x)).toEqual([0, 270, 500]);
    distributeItems(sheet, ["a", "b"], "horizontal"); // fewer than three: nothing
    expect(sheet.items.map((i) => i.x)).toEqual([0, 270, 500]);
  });
});

describe("fitting", () => {
  it("fits the page to the content as one custom page with the margin around it", () => {
    const sheet = sheetWith(item("a", 300, 200), item("b", 700, 500, 200, 100));
    fitPageToContent(sheet);
    expect(sheet.page).toMatchObject({ preset: "custom", columns: 1, rows: 1 });
    // content 300..900 × 200..600 → 600 × 400 px plus 57 px each side
    expect(frames(sheet)).toEqual([
      { id: "a", x: 57, y: 57, width: 100, height: 80 },
      { id: "b", x: 457, y: 357, width: 200, height: 100 },
    ]);
    expect(sheet.page.widthMm).toBeCloseTo(188.9, 0);
    expect(sheet.page.heightMm).toBeCloseTo(136, 0);
    expect(sheet.width).toBe(714);
  });

  it("fits the content to the page by scaling the group into the content box", () => {
    const sheet = sheetWith(item("a", 0, 0, 100, 100), item("b", 100, 100, 100, 100));
    sheet.page = pageForPreset("journal-1", "portrait", sheet.page); // 321 × 416, no margin
    fitContentToPage(sheet, (i) => layoutItemMinimum(i.recipe.kind));
    // content 200 × 200 scales by 321/200 = 1.605 and sits centred vertically
    expect(frames(sheet)).toEqual([
      { id: "a", x: 0, y: 48, width: 161, height: 161 },
      { id: "b", x: 161, y: 208, width: 161, height: 161 },
    ]);
  });

  it("reports the bounds of nothing as null", () => {
    expect(contentBounds([])).toBeNull();
  });
});
