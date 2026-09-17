import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT_STYLE,
  applyLayoutPage,
  cloneLayoutWorkspace,
  createDefaultLayoutWorkspace,
  effectiveLayoutStyle,
  normalizeLayoutStyle,
  normalizeLayoutWorkspace,
  nextLayoutItemPosition,
  pageForPreset,
  pageSizeMm,
  pageSizePx,
} from "./layout";

describe("layout workspace persistence", () => {
  it("creates a renameable blank sheet with a stable active identity", () => {
    const workspace = createDefaultLayoutWorkspace();
    expect(workspace.version).toBe(2);
    expect(workspace.sheets).toHaveLength(1);
    expect(workspace.activeSheetId).toBe(workspace.sheets[0].id);
    expect(workspace.sheets[0].items).toEqual([]);
  });

  it("normalizes persisted recipes while retaining sample and population bindings", () => {
    const normalized = normalizeLayoutWorkspace({
      version: 1,
      activeSheetId: "sheet-b",
      sheets: [
        {
          id: "sheet-a",
          name: "Overview",
          width: 900,
          height: 700,
          items: [],
        },
        {
          id: "sheet-b",
          name: "B cells",
          width: 1200,
          height: 800,
          items: [{
            id: "plot-1",
            x: 32,
            y: 40,
            width: 280,
            height: 300,
            z: 2,
            recipe: {
              kind: "biplot",
              sampleId: "sample-stable-id",
              populationId: "pop-stable-id",
              xChannel: "FSC-A",
              yChannel: "SSC-A",
              displayMode: "contour",
            },
          }],
        },
      ],
    });
    expect(normalized.activeSheetId).toBe("sheet-b");
    expect(normalized.sheets[1].items[0].recipe).toEqual({
      kind: "biplot",
      sampleId: "sample-stable-id",
      populationId: "pop-stable-id",
      xChannel: "FSC-A",
      yChannel: "SSC-A",
      displayMode: "contour",
      title: undefined,
    });
  });

  it("recovers malformed presentation state without touching scientific workspace data", () => {
    const normalized = normalizeLayoutWorkspace({ version: 99, sheets: "broken" });
    expect(normalized.version).toBe(2);
    expect(normalized.sheets).toHaveLength(1);
    expect(normalized.sheets[0].items).toEqual([]);
  });

  it("clones recipes deeply and places new items without overlap in the initial row", () => {
    const workspace = createDefaultLayoutWorkspace();
    const first = nextLayoutItemPosition(workspace.sheets[0]);
    workspace.sheets[0].items.push({
      id: "one",
      ...first,
      recipe: {
        kind: "histogram",
        sampleId: "sample",
        populationId: "pop",
        xChannel: "CD3",
        yChannel: null,
        displayMode: "pseudocolor",
      },
    });
    const second = nextLayoutItemPosition(workspace.sheets[0]);
    expect(second.x).toBeGreaterThan(first.x);

    const cloned = cloneLayoutWorkspace(workspace);
    const clonedRecipe = cloned.sheets[0].items[0].recipe;
    if (clonedRecipe.kind !== "histogram") throw new Error("Expected histogram recipe");
    clonedRecipe.xChannel = "CD19";
    expect(workspace.sheets[0].items[0].recipe).toMatchObject({ xChannel: "CD3" });
  });
});

describe("layout pages", () => {
  it("opens a new sheet as an A4 landscape page drawn at 96 px per inch", () => {
    const sheet = createDefaultLayoutWorkspace().sheets[0];
    expect(sheet.page).toMatchObject({ preset: "a4", orientation: "landscape", marginMm: 15, dpi: 300 });
    expect(pageSizeMm(sheet.page)).toEqual({ widthMm: 297, heightMm: 210 });
    expect([sheet.width, sheet.height]).toEqual([1123, 794]);
  });

  it("keeps a version 1 sheet, which had a pixel size only, at that size as a custom page", () => {
    const normalized = normalizeLayoutWorkspace({
      version: 1,
      activeSheetId: "s",
      sheets: [{ id: "s", name: "Old", width: 900, height: 700, items: [] }],
    });
    const sheet = normalized.sheets[0];
    expect(sheet.page).toMatchObject({ preset: "custom", orientation: "portrait", marginMm: 0, dpi: 300 });
    expect(sheet.page.widthMm).toBeCloseTo(238.1, 1);
    expect(sheet.page.heightMm).toBeCloseTo(185.2, 1);
    expect([sheet.width, sheet.height]).toEqual([900, 700]);
  });

  it("applies a preset, an orientation and the pixel size that follows", () => {
    const sheet = createDefaultLayoutWorkspace().sheets[0];
    applyLayoutPage(sheet, pageForPreset("journal-1", "portrait", sheet.page));
    expect(pageSizeMm(sheet.page)).toEqual({ widthMm: 85, heightMm: 110 });
    expect(sheet.page.marginMm).toBe(0);
    expect(pageSizePx(sheet.page)).toEqual({ width: 321, height: 416 });
    expect([sheet.width, sheet.height]).toEqual([321, 416]);
    applyLayoutPage(sheet, { ...sheet.page, orientation: "landscape" });
    expect([sheet.width, sheet.height]).toEqual([416, 321]);
    // Custom keeps the size it is given; the resolution carries over.
    applyLayoutPage(sheet, { ...pageForPreset("custom", "portrait", { ...sheet.page, dpi: 600 }), widthMm: 50, heightMm: 60 });
    expect(sheet.page).toMatchObject({ preset: "custom", dpi: 600 });
    expect([sheet.width, sheet.height]).toEqual([189, 227]);
  });

  it("drops an unknown preset or an out-of-range size to the fallback", () => {
    const normalized = normalizeLayoutWorkspace({
      sheets: [{ id: "s", name: "S", width: 500, height: 400, items: [], page: { preset: "b5", orientation: "sideways", widthMm: 5, heightMm: 99999, marginMm: -3, dpi: 10 } }],
    });
    // Out-of-range numbers are clamped to the range, not dropped.
    expect(normalized.sheets[0].page).toMatchObject({ preset: "custom", orientation: "portrait", widthMm: 40, heightMm: 2000, marginMm: 0, dpi: 72 });
  });

  it("places new items inside the page margin", () => {
    const sheet = createDefaultLayoutWorkspace().sheets[0];
    const first = nextLayoutItemPosition(sheet);
    expect(first).toMatchObject({ x: 57, y: 57 }); // 15 mm at 96 px per inch
  });
});

describe("plot style", () => {
  it("keeps known fields within range and drops the rest", () => {
    expect(normalizeLayoutStyle(undefined)).toEqual({});
    expect(normalizeLayoutStyle({ pointSize: 99, pointAlpha: -1, maxEvents: 1234.6, contourLevels: 0, pubStyle: true, histFill: "yes", colour: "red" }))
      .toEqual({ pointSize: 6, pointAlpha: 0.05, maxEvents: 1235, contourLevels: 2, pubStyle: true });
  });

  it("layers the item's own values over the sheet's over the defaults", () => {
    expect(effectiveLayoutStyle(null)).toEqual(DEFAULT_LAYOUT_STYLE);
    const sheet = { style: { pointSize: 2, pubStyle: true } };
    const recipe = { kind: "biplot" as const, sampleId: "a", populationId: "p", xChannel: "x", yChannel: "y", displayMode: "scatter" as const, style: { pointSize: 3 } };
    expect(effectiveLayoutStyle(sheet, recipe)).toMatchObject({ pointSize: 3, pubStyle: true, contourLevels: 10 });
    expect(effectiveLayoutStyle(sheet, { kind: "text", text: "t", fontSize: 12 })).toMatchObject({ pointSize: 2, pubStyle: true });
  });

  it("survives a save and a load on the sheet and on an item", () => {
    const workspace = createDefaultLayoutWorkspace();
    const sheet = workspace.sheets[0];
    sheet.style = { pointSize: 2.5, histFill: false };
    sheet.items.push({ id: "i1", x: 60, y: 60, width: 260, height: 260, z: 0, recipe: { kind: "biplot", sampleId: "a", populationId: "p", xChannel: "x", yChannel: "y", displayMode: "contour", style: { contourLevels: 4, kdeBandwidth: 0.5 } } });
    const loaded = normalizeLayoutWorkspace(JSON.parse(JSON.stringify(workspace)));
    expect(loaded.sheets[0].style).toEqual({ pointSize: 2.5, histFill: false });
    expect(loaded.sheets[0].items[0].recipe).toMatchObject({ style: { contourLevels: 4, kdeBandwidth: 0.5 } });
    // A record that sets nothing carries no style field at all.
    delete sheet.style;
    delete (sheet.items[0].recipe as { style?: unknown }).style;
    const again = normalizeLayoutWorkspace(JSON.parse(JSON.stringify(workspace)));
    expect("style" in again.sheets[0]).toBe(false);
    expect("style" in again.sheets[0].items[0].recipe).toBe(false);
  });
});

