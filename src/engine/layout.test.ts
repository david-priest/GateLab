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
  layoutGridFrames,
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

describe("figure block", () => {
  it("keeps an Illustration figure block through a save and a load, and drops one without a figure", () => {
    const workspace = createDefaultLayoutWorkspace();
    const illustration = { popIds: [], xChannels: [], yChannel: "", displayMode: "pseudocolor", plotSize: 200, figure: { version: 1, name: "F", sampleIds: ["D1"], populations: [], plots: [], rows: [], columns: [], pages: [], composition: "separate", scalePolicy: "gating", transforms: {}, showGates: true, panelSize: 200 } };
    workspace.sheets[0].items.push({ id: "f", x: 0, y: 0, width: 400, height: 300, z: 0, recipe: { kind: "figure", illustration: illustration as never, page: 2 } });
    workspace.sheets[0].items.push({ id: "g", x: 0, y: 0, width: 400, height: 300, z: 1, recipe: { kind: "figure", illustration: { popIds: [] } as never, page: 0 } });
    const loaded = normalizeLayoutWorkspace(JSON.parse(JSON.stringify(workspace)));
    expect(loaded.sheets[0].items).toHaveLength(1);
    expect(loaded.sheets[0].items[0].recipe).toMatchObject({ kind: "figure", page: 2, illustration: { figure: { name: "F" } } });
  });
});

describe("plots added as a grid", () => {
  it("keeps rows as rows below the sheet's content, however wide the page, and steps plots sharing a cell", () => {
    const workspace = createDefaultLayoutWorkspace();
    const sheet = workspace.sheets[0];
    sheet.items.push({ id: "t", x: 57, y: 57, width: 100, height: 40, z: 3, recipe: { kind: "text", text: "a", fontSize: 12 } });
    const frames = layoutGridFrames(sheet, [
      { row: 0, column: 0 }, { row: 0, column: 1 }, { row: 0, column: 2 }, { row: 0, column: 3 }, { row: 0, column: 4 },
      { row: 1, column: 0 }, { row: 1, column: 0 },
    ]);
    const top = 57 + 40 + 12;
    expect(frames.slice(0, 5).map((f) => [f.x, f.y])).toEqual([[57, top], [329, top], [601, top], [873, top], [1145, top]]);
    expect(frames[5]).toMatchObject({ x: 57, y: top + 292, z: 9 });
    expect(frames[6]).toMatchObject({ x: 77, y: top + 312, z: 10 });
    expect(frames[0].z).toBe(4);
  });
});

describe("placing a block nothing on the page holds", () => {
  it("puts it below everything rather than over the last item", () => {
    const workspace = createDefaultLayoutWorkspace();
    const sheet = workspace.sheets[0];
    // Wider than half the page and most of its height: only one fits, and the next has no slot.
    const tall = { width: 900, height: 700 };
    const first = nextLayoutItemPosition(sheet, tall.width, tall.height);
    sheet.items.push({ id: "a", ...first, recipe: { kind: "text", text: "a", fontSize: 12 } });
    const second = nextLayoutItemPosition(sheet, tall.width, tall.height);
    expect(second.x).toBe(first.x);
    expect(second.y).toBe(first.y + tall.height + 12);
  });
});

describe("iteration on load", () => {
  it("makes the plots of a saved sheet follow an iteration that nothing followed, and leaves one that has a follower", () => {
    const workspace = createDefaultLayoutWorkspace();
    const plot = (id: string, iterated?: boolean) => ({ id, x: 0, y: 0, width: 200, height: 200, z: 0, recipe: { kind: "biplot" as const, sampleId: "D1", populationId: "p1", xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor" as const, ...(iterated ? { iterated } : {}) } });
    const text = { id: "t", x: 0, y: 0, width: 100, height: 40, z: 1, recipe: { kind: "text" as const, text: "{population}", fontSize: 12 } };
    workspace.sheets[0].items.push(plot("a"), plot("b"), text);
    workspace.sheets[0].iteration = { mode: "populations", source: { kind: "checked" }, populations: { kind: "all" }, arrangement: { kind: "page-per-unit" } } as never;
    const loaded = normalizeLayoutWorkspace(JSON.parse(JSON.stringify(workspace)));
    expect(loaded.sheets[0].items.map((item) => "iterated" in item.recipe && item.recipe.iterated === true)).toEqual([true, true, false]);

    const chosen = createDefaultLayoutWorkspace();
    chosen.sheets[0].items.push(plot("a"), plot("b", true));
    chosen.sheets[0].iteration = workspace.sheets[0].iteration;
    const kept = normalizeLayoutWorkspace(JSON.parse(JSON.stringify(chosen)));
    expect(kept.sheets[0].items.map((item) => "iterated" in item.recipe && item.recipe.iterated === true)).toEqual([false, true]);

    const off = createDefaultLayoutWorkspace();
    off.sheets[0].items.push(plot("a"));
    expect("iterated" in normalizeLayoutWorkspace(JSON.parse(JSON.stringify(off))).sheets[0].items[0].recipe).toBe(false);
  });
});

describe("Plotting chart block", () => {
  it("keeps a chart block's settings through a save and a load, within range, and drops one without settings", () => {
    const workspace = createDefaultLayoutWorkspace();
    const settings = { files: ["D1", "D2"], hierarchy: "h1", plotType: "box", selectedPops: ["p1"], height: 9000, palette: "paired", groupSel: "day" };
    workspace.sheets[0].items.push({ id: "p", x: 0, y: 0, width: 400, height: 300, z: 0, recipe: { kind: "proportions", settings: settings as never, title: "Composition by day" } });
    workspace.sheets[0].items.push({ id: "q", x: 0, y: 0, width: 400, height: 300, z: 1, recipe: { kind: "proportions" } as never });
    const loaded = normalizeLayoutWorkspace(JSON.parse(JSON.stringify(workspace)));
    expect(loaded.sheets[0].items).toHaveLength(1);
    expect(loaded.sheets[0].items[0].recipe).toMatchObject({
      kind: "proportions",
      title: "Composition by day",
      settings: { files: ["D1", "D2"], hierarchy: "h1", plotType: "box", selectedPops: ["p1"], height: 800, groupSel: "day", categoryKind: "population", legend: true },
    });
  });
});

describe("plot style", () => {
  it("keeps known fields within range and drops the rest", () => {
    expect(normalizeLayoutStyle(undefined)).toEqual({});
    expect(normalizeLayoutStyle({ pointSize: 99, pointAlpha: -1, maxEvents: 1234.6, contourLevels: 0, pubStyle: true, histFill: "yes", colour: "red" }))
      .toEqual({ pointSize: 6, pointAlpha: 0.05, maxEvents: 1235, contourLevels: 2, pubStyle: true });
    expect(normalizeLayoutStyle({ gateLabels: "number" })).toEqual({ gateLabels: "number" });
    expect(normalizeLayoutStyle({ gateLabels: "shouting" })).toEqual({});
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

