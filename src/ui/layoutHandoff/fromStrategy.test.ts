import { describe, expect, it } from "vitest";
import { createDefaultLayoutWorkspace, type LayoutStrategyRecipe, type LayoutWorkspace } from "../../engine/layout";
import { addStrategyBlock } from "./fromStrategy";

const strip: LayoutStrategyRecipe = { kind: "strategy", sampleId: "f1", populationId: "p1", fullPath: true, displayMode: "scatter" };

describe("addStrategyBlock", () => {
  // An A4 landscape page is 1123 x 794 px with a 57 px margin: 1009 x 680 inside it.
  it("scales a block wider than the page to the page's width, as a zoom, and leaves the sheet the size of its pages", () => {
    const before = createDefaultLayoutWorkspace();
    const after = addStrategyBlock(before, strip, { width: 1208, height: 544 });
    expect(before.sheets[0].items).toHaveLength(0);
    const sheet = after.sheets[0];
    const [item] = sheet.items;
    expect(item.recipe).toEqual(strip);
    expect([item.x, item.y]).toEqual([57, 57]);
    expect(item.x + item.width).toBeLessThanOrEqual(1123 - 57);
    // The frame is the size it was drawn at times the zoom, so what is drawn inside is unchanged.
    expect(item.zoom).toBeCloseTo(1009 / 1208, 3);
    expect(item.width / item.zoom!).toBeCloseTo(1208, -1);
    expect(item.height / item.zoom!).toBeCloseTo(544, -1);
    expect([sheet.width, sheet.height, sheet.page.rows, sheet.page.columns]).toEqual([1123, 794, 1, 1]);
  });

  it("scales a block taller than the page until the page holds it", () => {
    const [item] = addStrategyBlock(createDefaultLayoutWorkspace(), strip, { width: 900, height: 2000 }).sheets[0].items;
    expect([item.width, item.height]).toEqual([306, 680]);
    expect(item.zoom).toBeCloseTo(0.34, 3);
  });

  it("starts a new page for a block the page has no room for, and the sheet gains that page", () => {
    let workspace = createDefaultLayoutWorkspace();
    for (let n = 0; n < 3; n++) workspace = addStrategyBlock(workspace, strip, { width: 900, height: 500 });
    const sheet = workspace.sheets[0];
    // One 500 px block to a 680 px page: each is on a page of its own, at its own size.
    expect(sheet.items.map((item) => Math.floor(item.y / 794))).toEqual([0, 1, 2]);
    expect(sheet.items.every((item) => item.zoom === undefined && item.width === 900 && item.height === 500)).toBe(true);
    expect(sheet.items.map((item) => item.y % 794)).toEqual([57, 57, 57]);
    expect(sheet.page.rows).toBe(3);
    expect([sheet.width, sheet.height]).toEqual([1123, 3 * 794]);
  });

  it("takes 600 by 320 when no size is given", () => {
    const [item] = addStrategyBlock(createDefaultLayoutWorkspace(), strip, undefined).sheets[0].items;
    expect([item.width, item.height]).toEqual([600, 320]);
  });

  it("returns the workspace unchanged when it has no sheet", () => {
    const empty: LayoutWorkspace = { ...createDefaultLayoutWorkspace(), sheets: [] };
    expect(addStrategyBlock(empty, strip, undefined)).toBe(empty);
  });
});
