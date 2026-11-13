// Layout geometry: lengths in mm and px, the proportions lock on typed values, matching sizes,
// a grid of a selection in both orders, spacing at a typed gap, and panel letters carried along.
// Synthetic items only.

import { describe, expect, it } from "vitest";
import {
  SCREEN_PX_PER_MM,
  cloneLayoutWorkspace,
  createLayoutSheet,
  defaultLayoutPage,
  pageForPreset,
  pageSizeMm,
  pageSizePx,
  type LayoutItem,
  type LayoutPage,
  type LayoutSheet,
  type LayoutWorkspace,
} from "../../engine/layout";
import {
  arrangeInGrid,
  arrangeUnitCount,
  defaultGridColumns,
  framePatch,
  matchReference,
  matchSizes,
  pxToUnit,
  spaceItems,
  unitToPx,
} from "./layoutGeometry";
import { addPanelLetters, isPanelLetter, reconcilePanelLetters } from "./panelLetters";

function plot(id: string, x: number, y: number, width = 200, height = 200, extra: Partial<LayoutItem> = {}): LayoutItem {
  return { id, x, y, width, height, z: 0, recipe: { kind: "biplot", sampleId: "D1", populationId: "CD4_positive", xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor" }, ...extra };
}
function sheetOf(items: LayoutItem[], page: LayoutPage = defaultLayoutPage()): LayoutSheet {
  const sheet = createLayoutSheet("S", page);
  sheet.items = items;
  return sheet;
}
const frame = (sheet: LayoutSheet, id: string) => {
  const { x, y, width, height } = sheet.items.find((item) => item.id === id)!;
  return { x, y, width, height };
};
const at = (sheet: LayoutSheet, id: string) => {
  const { x, y } = frame(sheet, id);
  return { x, y };
};

describe("lengths in mm and px", () => {
  it("converts both ways on an A4 sheet: the page's own size in px reads as its size in mm", () => {
    const page = pageForPreset("a4", "landscape");
    const mm = pageSizeMm(page), px = pageSizePx(page);
    expect(mm).toEqual({ widthMm: 297, heightMm: 210 });
    expect(Math.abs(unitToPx(mm.widthMm, "mm") - px.width)).toBeLessThan(1);
    expect(Math.abs(unitToPx(mm.heightMm, "mm") - px.height)).toBeLessThan(1);
    expect(pxToUnit(unitToPx(297, "mm"), "mm")).toBe(297);
    expect(pxToUnit(unitToPx(210, "mm"), "mm")).toBe(210);
    // 96 px per inch: 96 px is 25.4 mm.
    expect(pxToUnit(96, "mm")).toBe(25.4);
    expect(unitToPx(25.4, "mm")).toBe(96);
  });

  it("converts both ways on a custom page, and a length typed to 0.1 mm reads back as typed", () => {
    const page: LayoutPage = { ...defaultLayoutPage(), preset: "custom", orientation: "portrait", widthMm: 123.4, heightMm: 87.6 };
    const px = pageSizePx(page);
    expect(Math.abs(unitToPx(123.4, "mm") - px.width)).toBeLessThan(1);
    expect(Math.abs(unitToPx(87.6, "mm") - px.height)).toBeLessThan(1);
    for (const typed of [0.1, 4, 12.3, 50.1, 87.6, 123.4, 500.7]) expect(pxToUnit(unitToPx(typed, "mm"), "mm")).toBe(typed);
    expect(unitToPx(12.3, "mm")).toBeCloseTo(12.3 * SCREEN_PX_PER_MM, 2);
  });

  it("leaves px as px", () => {
    expect(pxToUnit(260, "px")).toBe(260);
    expect(unitToPx(260, "px")).toBe(260);
    expect(pxToUnit(189.354, "px")).toBe(189.35);
  });
});

describe("the proportions lock on typed values", () => {
  const item = plot("A", 10, 10, 400, 200);
  it("sets only the field typed when off", () => {
    expect(framePatch(item, "width", 300, false)).toEqual({ width: 300 });
    expect(framePatch(item, "height", 260, false)).toEqual({ height: 260 });
    expect(framePatch(item, "x", 50, true)).toEqual({ x: 50 });
  });
  it("keeps the item's ratio when on, in both directions", () => {
    expect(framePatch(item, "width", 300, true)).toEqual({ width: 300, height: 150 });
    expect(framePatch(item, "height", 160, true)).toEqual({ width: 320, height: 160 });
  });
  it("keeps each side at the item's minimum", () => {
    // A biplot is at least 140 × 140 px.
    expect(framePatch(item, "width", 200, true)).toEqual({ width: 200, height: 140 });
    expect(framePatch(item, "width", 20, false)).toEqual({ width: 140 });
  });
});

describe("match width, height and size", () => {
  const three = () => sheetOf([
    plot("A", 100, 100, 300, 200),
    plot("B", 500, 120, 180, 260),
    plot("C", 100, 400, 220, 150, { locked: true }),
  ]);
  it("takes the item nearest the selection's top left as the reference", () => {
    expect(matchReference(three(), ["A", "B", "C"])?.id).toBe("A");
    expect(matchReference(three(), ["B", "C"])?.id).toBe("C");
    expect(matchReference(three(), ["B"])).toBeNull();
  });
  it("matches width, keeping each top-left corner, and leaves a locked item alone", () => {
    const sheet = three();
    expect(matchSizes(sheet, ["A", "B", "C"], "width")).toBe("A");
    expect(frame(sheet, "B")).toEqual({ x: 500, y: 120, width: 300, height: 260 });
    expect(frame(sheet, "C")).toEqual({ x: 100, y: 400, width: 220, height: 150 });
  });
  it("matches height", () => {
    const sheet = three();
    matchSizes(sheet, ["A", "B", "C"], "height");
    expect(frame(sheet, "B")).toEqual({ x: 500, y: 120, width: 180, height: 200 });
    expect(frame(sheet, "C")).toEqual({ x: 100, y: 400, width: 220, height: 150 });
  });
  it("matches size; a locked reference is matched but not changed", () => {
    const sheet = three();
    matchSizes(sheet, ["A", "B", "C"], "size");
    expect(frame(sheet, "B")).toEqual({ x: 500, y: 120, width: 300, height: 200 });
    expect(frame(sheet, "A")).toEqual({ x: 100, y: 100, width: 300, height: 200 });
    const other = three();
    expect(matchSizes(other, ["B", "C"], "size")).toBe("C");
    expect(frame(other, "B")).toEqual({ x: 500, y: 120, width: 220, height: 150 });
  });
});

describe("arrange in grid", () => {
  // Five items of mixed sizes, read A B / C D / E, and a locked one that stays.
  const five = () => sheetOf([
    plot("A", 100, 100, 200, 150),
    plot("B", 400, 100, 150, 200),
    plot("C", 100, 400, 250, 100),
    plot("D", 400, 400, 200, 200),
    plot("E", 100, 700, 180, 120),
    plot("F", 900, 50, 160, 160, { locked: true }),
  ]);
  const ids = ["A", "B", "C", "D", "E", "F"];

  it("defaults to the ceiling of the square root of the count", () => {
    expect(defaultGridColumns(5)).toBe(3);
    expect(defaultGridColumns(4)).toBe(2);
    expect(defaultGridColumns(2)).toBe(2);
    expect(arrangeUnitCount(five(), ids)).toBe(5);
  });

  it("fills across, then down: columns as wide as their widest, rows as tall as their tallest", () => {
    const sheet = five();
    arrangeInGrid(sheet, ids, { columns: 2, gapPx: 10, order: "across" });
    // Columns 250 and 200 wide; rows 200, 200 and 120 tall; from (100, 100) with 10 px gaps.
    expect(at(sheet, "A")).toEqual({ x: 100, y: 100 });
    expect(at(sheet, "B")).toEqual({ x: 360, y: 100 });
    expect(at(sheet, "C")).toEqual({ x: 100, y: 310 });
    expect(at(sheet, "D")).toEqual({ x: 360, y: 310 });
    expect(at(sheet, "E")).toEqual({ x: 100, y: 520 });
    expect(frame(sheet, "F")).toEqual({ x: 900, y: 50, width: 160, height: 160 });
    expect(frame(sheet, "C")).toMatchObject({ width: 250, height: 100 });
  });

  it("fills down, then across", () => {
    const sheet = five();
    arrangeInGrid(sheet, ids, { columns: 2, gapPx: 10, order: "down" });
    // Three rows; A B C down the first column, D E down the second.
    expect(at(sheet, "A")).toEqual({ x: 100, y: 100 });
    expect(at(sheet, "B")).toEqual({ x: 100, y: 310 });
    expect(at(sheet, "C")).toEqual({ x: 100, y: 520 });
    expect(at(sheet, "D")).toEqual({ x: 360, y: 100 });
    expect(at(sheet, "E")).toEqual({ x: 360, y: 310 });
    expect(at(sheet, "F")).toEqual({ x: 900, y: 50 });
  });

  it("moves a group as one unit", () => {
    const sheet = sheetOf([
      plot("A", 0, 0, 200, 200, { group: "g" }),
      plot("B", 210, 0, 200, 200, { group: "g" }),
      plot("C", 0, 500, 200, 200),
    ]);
    arrangeInGrid(sheet, ["A", "B", "C"], { columns: 2, gapPx: 20, order: "across" });
    expect(at(sheet, "A")).toEqual({ x: 0, y: 0 });
    expect(at(sheet, "B")).toEqual({ x: 210, y: 0 });
    expect(at(sheet, "C")).toEqual({ x: 430, y: 0 });
  });
});

describe("space at a typed gap", () => {
  const three = () => sheetOf([
    plot("A", 50, 0, 150, 150),
    plot("B", 600, 300, 140, 160),
    plot("C", 300, 150, 160, 140),
    plot("L", 0, 900, 140, 140, { locked: true }),
  ]);
  it("across: the leftmost stays, each next at the previous right edge plus the gap", () => {
    const sheet = three();
    spaceItems(sheet, ["A", "B", "C", "L"], 10, "across");
    expect(at(sheet, "A")).toEqual({ x: 50, y: 0 });
    expect(at(sheet, "C")).toEqual({ x: 210, y: 150 });
    expect(at(sheet, "B")).toEqual({ x: 380, y: 300 });
    expect(at(sheet, "L")).toEqual({ x: 0, y: 900 });
  });
  it("down: the topmost stays, each next at the previous bottom edge plus the gap", () => {
    const sheet = three();
    spaceItems(sheet, ["A", "B", "C", "L"], unitToPx(4, "mm"), "down");
    const gap = unitToPx(4, "mm");
    expect(at(sheet, "A")).toEqual({ x: 50, y: 0 });
    expect(at(sheet, "C").y).toBeCloseTo(150 + gap, 2);
    expect(at(sheet, "B").y).toBeCloseTo(150 + gap + 140 + gap, 2);
    expect(at(sheet, "C").x).toBe(300);
    expect(at(sheet, "L")).toEqual({ x: 0, y: 900 });
  });
});

describe("panel letters follow their items", () => {
  it("through a grid, a match and a spacing, as the tab's commit brings them up to date", () => {
    const sheet = sheetOf([plot("A", 100, 100), plot("B", 600, 100), plot("C", 100, 600)]);
    addPanelLetters(sheet, null, (() => { let n = 0; return () => `letter${++n}`; })());
    let workspace: LayoutWorkspace = { version: 2, activeSheetId: sheet.id, sheets: [sheet] };
    const edit = (change: (s: LayoutSheet) => void) => {
      const next = cloneLayoutWorkspace(workspace);
      change(next.sheets[0]);
      workspace = reconcilePanelLetters(workspace, next);
    };
    const offsets = () => {
      const s = workspace.sheets[0];
      return Object.fromEntries(s.items.filter(isPanelLetter).map((letter) => {
        const target = s.items.find((item) => item.id === letter.recipe.letterFor)!;
        return [target.id, { dx: letter.x - target.x, dy: letter.y - target.y, text: letter.recipe.text }];
      }));
    };
    const before = offsets();
    // The letters are in the selection too, as a marquee would take them; they are left out and follow.
    const all = workspace.sheets[0].items.map((item) => item.id);
    edit((s) => arrangeInGrid(s, all, { columns: 3, gapPx: 12, order: "across" }));
    expect(at(workspace.sheets[0], "B")).toEqual({ x: 312, y: 100 });
    expect(at(workspace.sheets[0], "C")).toEqual({ x: 524, y: 100 });
    expect(offsets()).toEqual(before);
    edit((s) => spaceItems(s, all, 30, "across"));
    expect(at(workspace.sheets[0], "C")).toEqual({ x: 560, y: 100 });
    expect(offsets()).toEqual(before);
    edit((s) => { matchSizes(s, all, "size"); });
    expect(offsets()).toEqual(before);
  });
});
