// "Every page, one sheet each": a sheet per page after the current sheet. Synthetic sheets and
// pages (control, treated); nothing here is a real experiment.
import { describe, expect, it } from "vitest";
import { defaultIllustrationConfig } from "../../engine/figureDefaults";
import { createDefaultLayoutWorkspace, createLayoutSheet, type LayoutPlotRecipe, type LayoutWorkspace } from "../../engine/layout";
import { defaultProportionsSettings } from "../../engine/proportionsModel";
import { initialCoreState } from "../../store";
import { addChartPageSheets, addChartPanelPageSheets, addFigurePageSheets, addPanelPageSheets, addSheetPerPage, uniqueSheetName } from "./everyPage";

/** Three sheets, the middle one current, with its own page, margins and style. */
function threeSheets(): LayoutWorkspace {
  const workspace = createDefaultLayoutWorkspace();
  const middle = createLayoutSheet("Main", { preset: "custom", orientation: "landscape", widthMm: 180, heightMm: 120, marginMm: 7, dpi: 600, columns: 1, rows: 1 });
  middle.style = { fontTick: 9 };
  middle.followFigureStyle = false;
  middle.items.push({ id: "kept", x: 10, y: 10, width: 100, height: 30, z: 1, recipe: { kind: "text", text: "Kept", fontSize: 12 } });
  workspace.sheets.push(middle, createLayoutSheet("Last"));
  workspace.activeSheetId = middle.id;
  return workspace;
}

const settings = defaultProportionsSettings([], initialCoreState(), []);
const plot = (sampleId: string): LayoutPlotRecipe => ({ kind: "biplot", sampleId, populationId: "p1", xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "scatter" });
const plotContext = { samples: [], metadata: {}, hierarchyOfFile: () => "h1", treeOf: () => null, populationMetadata: {}, figureLayout: {} };

describe("uniqueSheetName", () => {
  it("keeps a free name and numbers a taken one", () => {
    expect(uniqueSheetName("control", new Set(["treated"]))).toBe("control");
    expect(uniqueSheetName("control", new Set(["control"]))).toBe("control (2)");
    expect(uniqueSheetName("control", new Set(["control", "control (2)"]))).toBe("control (3)");
  });
});

describe("addSheetPerPage", () => {
  it("adds a sheet per page after the current one, named by the page, with its page, margins and style, and opens the first", () => {
    const before = threeSheets();
    const after = addSheetPerPage(before, ["control", "treated"], (workspace) => workspace);
    expect(before.sheets).toHaveLength(3);
    expect(after.sheets.map((sheet) => sheet.name)).toEqual(["Layout 1", "Main", "control", "treated", "Last"]);
    const [control, treated] = after.sheets.slice(2, 4);
    expect(after.activeSheetId).toBe(control.id);
    for (const sheet of [control, treated]) {
      expect(sheet.page).toEqual(before.sheets[1].page);
      expect(sheet.page).not.toBe(after.sheets[1].page);
      expect([sheet.width, sheet.height]).toEqual([before.sheets[1].width, before.sheets[1].height]);
      expect(sheet.style).toEqual({ fontTick: 9 });
      expect(sheet.followFigureStyle).toBe(false);
      expect(sheet.items).toEqual([]);
      expect(sheet.iteration).toBeUndefined();
    }
    // The current sheet is left as it was.
    expect(after.sheets[1].items.map((item) => item.id)).toEqual(["kept"]);
  });

  it("gives a page label already a sheet's name, or repeated, a name of its own, and a blank one its number", () => {
    const after = addSheetPerPage(threeSheets(), ["Main", "control", "control", " "], (workspace) => workspace);
    expect(after.sheets.slice(2, 6).map((sheet) => sheet.name)).toEqual(["Main (2)", "control", "control (2)", "Page 4"]);
  });

  it("fills each new sheet as the active one, in page order", () => {
    const seen: [string, number][] = [];
    const after = addSheetPerPage(threeSheets(), ["control", "treated"], (workspace, index) => {
      seen.push([workspace.sheets.find((sheet) => sheet.id === workspace.activeSheetId)!.name, index]);
      return workspace;
    });
    expect(seen).toEqual([["control", 0], ["treated", 1]]);
    expect(after.sheets).toHaveLength(5);
  });

  it("returns the workspace unchanged with no page or no sheet", () => {
    const workspace = threeSheets();
    expect(addSheetPerPage(workspace, [], (w) => w)).toBe(workspace);
    const empty: LayoutWorkspace = { ...createDefaultLayoutWorkspace(), sheets: [] };
    expect(addSheetPerPage(empty, ["control"], (w) => w)).toBe(empty);
  });
});

describe("the four hand-offs, a sheet per page", () => {
  const sheetsAdded = (after: LayoutWorkspace) => after.sheets.slice(2, after.sheets.length - 1);

  it("Illustration's Add to Layout: a figure block per sheet, each drawing its page", () => {
    const config = { ...defaultIllustrationConfig(), figure: undefined };
    const after = addFigurePageSheets(threeSheets(), config, ["control", "treated", "control"], { samples: [], metadata: {}, hierarchyOfFile: () => "h1", state: initialCoreState() });
    const added = sheetsAdded(after);
    expect(added.map((sheet) => sheet.name)).toEqual(["control", "treated", "control (2)"]);
    expect(added.map((sheet) => sheet.items.map((item) => item.recipe))).toEqual([0, 1, 2].map((page) => [{ kind: "figure", illustration: config, page }]));
  });

  it("Illustration's Add panels to Layout: each page's panels as the grid, with its headings", () => {
    const pages = ["control", "treated"].map((label, index) => ({
      label,
      recipes: [plot(`D${index + 1}`), plot(`D${index + 2}`)],
      cells: [{ row: 0, column: 0 }, { row: 0, column: 1 }],
      headings: { columns: [{ text: "B1" }, { text: "B2" }], rows: [] },
    }));
    const after = addPanelPageSheets(threeSheets(), pages, 120, plotContext);
    const added = sheetsAdded(after);
    expect(added.map((sheet) => sheet.name)).toEqual(["control", "treated"]);
    added.forEach((sheet, index) => {
      const plots = sheet.items.filter((item) => item.recipe.kind === "biplot");
      expect(plots.map((item) => (item.recipe as LayoutPlotRecipe).sampleId)).toEqual([`D${index + 1}`, `D${index + 2}`]);
      expect(plots.map((item) => item.width)).toEqual([128, 128]);
      expect(sheet.items.filter((item) => item.recipe.kind === "text").map((item) => (item.recipe as { text: string }).text)).toEqual(["B1", "B2"]);
    });
  });

  it("Plotting's Add to Layout: a block per sheet naming its page", () => {
    const paged = { ...settings, pageBy: "groups" as const };
    const after = addChartPageSheets(threeSheets(), paged, [{ label: "condition: control", page: "control" }, { label: "condition: treated", page: "treated" }], () => () => ({ width: 300, height: 200 }), {});
    const added = sheetsAdded(after);
    expect(added.map((sheet) => sheet.name)).toEqual(["condition: control", "condition: treated"]);
    expect(added.map((sheet) => sheet.items.map((item) => item.recipe))).toEqual(["control", "treated"].map((page) => [{ kind: "proportions", settings: paged, panel: { page }, textSize: "sheet" }]));
  });

  it("Plotting's Add panels to Layout: each page's panel blocks and the legend, a page with no panel left out", () => {
    const pages = [
      { label: "D1.fcs", blocks: [{ panel: { facet: "D1.fcs", group: "control" }, row: 0, column: 0 }, { panel: { facet: "D1.fcs", group: "treated" }, row: 0, column: 1 }] },
      { label: "D2.fcs", blocks: [] },
      { label: "D3.fcs", blocks: [{ panel: { facet: "D3.fcs", group: "control" }, row: 0, column: 0 }] },
    ];
    const after = addChartPanelPageSheets(threeSheets(), settings, pages, () => () => ({ width: 200, height: 150 }), () => ({ width: 180, height: 40 }), {});
    const added = sheetsAdded(after);
    expect(added.map((sheet) => sheet.name)).toEqual(["D1.fcs", "D3.fcs"]);
    expect(added.map((sheet) => sheet.items.map((item) => (item.recipe as { panel: unknown }).panel))).toEqual([
      [{ facet: "D1.fcs", group: "control" }, { facet: "D1.fcs", group: "treated" }, { legend: true }],
      [{ facet: "D3.fcs", group: "control" }, { legend: true }],
    ]);
  });
});
