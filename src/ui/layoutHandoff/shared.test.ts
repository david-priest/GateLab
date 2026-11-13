import { describe, expect, it } from "vitest";
import { createDefaultLayoutWorkspace, type LayoutPlotRecipe, type LayoutProportionsRecipe, type LayoutWorkspace } from "../../engine/layout";
import { BASE_PROPORTIONS_SETTINGS } from "../../engine/proportionsSettings";
import { addPlotsToSheet, type PlotHandoffContext } from "./shared";

const context: PlotHandoffContext = {
  samples: [{ id: "f1", name: "D1_control.fcs" }, { id: "f2", name: "D2_treated.fcs" }],
  metadata: { f1: { donor: "D1" }, f2: { donor: "D2" } },
  hierarchyOfFile: () => "h1",
  treeOf: () => ({ populations: { p1: { name: "CD4_positive" } } }),
  populationMetadata: {},
  figureLayout: {},
};

function plot(sampleId: string): LayoutPlotRecipe {
  return { kind: "biplot", sampleId, populationId: "p1", xChannel: "CD3", yChannel: "CD4", displayMode: "scatter" };
}

describe("addPlotsToSheet", () => {
  it("places each plot on the active sheet and leaves the workspace it was given as it was", () => {
    const before = createDefaultLayoutWorkspace();
    const after = addPlotsToSheet(before, [plot("f1"), plot("f2")], undefined, undefined, undefined, context);
    expect(before.sheets[0].items).toHaveLength(0);
    expect(after).not.toBe(before);
    const items = after.sheets[0].items;
    expect(items.map((item) => item.recipe)).toEqual([plot("f1"), plot("f2")]);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    for (const item of items) {
      expect(after.sheets[0].width).toBeGreaterThanOrEqual(item.x + item.width + 48);
      expect(after.sheets[0].height).toBeGreaterThanOrEqual(item.y + item.height + 48);
    }
  });

  it("keeps a grid's arrangement at the panel size given, with a heading over each column read from its first plot", () => {
    const before = createDefaultLayoutWorkspace();
    const cells = [{ row: 0, column: 0 }, { row: 0, column: 1 }];
    const headings = { columns: [{ text: "D1" }, { text: "D2", template: "{population}" }], rows: [] };
    const after = addPlotsToSheet(before, [plot("f1"), plot("f2")], cells, headings, 120, context);
    const items = after.sheets[0].items;
    const plots = items.filter((item) => item.recipe.kind === "biplot");
    const texts = items.filter((item) => item.recipe.kind === "text");
    expect(plots).toHaveLength(2);
    expect(plots.map((item) => [item.width, item.height])).toEqual([[128, 128], [128, 128]]);
    expect(plots[0].y).toBe(plots[1].y);
    expect(plots[1].x).toBeGreaterThan(plots[0].x);
    expect(texts).toHaveLength(2);
    for (const text of texts) expect(text.y).toBeLessThan(plots[0].y);
    const templated = texts.find((item) => item.recipe.kind === "text" && item.recipe.text === "{population}");
    expect(templated?.recipe).toMatchObject({ readsFrom: plots[1].id, fontSize: 14 });
  });

  it("gives a plot that spans cells, as an Illustration summary panel does, the frames of the cells it spans", () => {
    const before = createDefaultLayoutWorkspace();
    const cells = [{ row: 0, column: 0 }, { row: 0, column: 1 }, { row: 1, column: 0, span: { rows: 1, columns: 2 } }];
    const after = addPlotsToSheet(before, [plot("f1"), plot("f2"), plot("f1")], cells, undefined, 120, context);
    const [first, second, spanning] = after.sheets[0].items;
    expect(spanning.x).toBe(first.x);
    expect(spanning.width).toBe(2 * 128 + 12);
    expect(spanning.x + spanning.width).toBe(second.x + second.width);
    expect(spanning.height).toBe(128);
    expect(spanning.y).toBe(first.y + 128 + 12);
  });

  it("keeps a plot that spans rows only one cell high, as the figure draws a summary of files down the rows", () => {
    const before = createDefaultLayoutWorkspace();
    const cells = [{ row: 0, column: 0 }, { row: 1, column: 0 }, { row: 0, column: 1, span: { rows: 2, columns: 1 } }];
    const after = addPlotsToSheet(before, [plot("f1"), plot("f2"), plot("f1")], cells, undefined, 120, context);
    const [first, , spanning] = after.sheets[0].items;
    expect(spanning.y).toBe(first.y);
    expect(spanning.width).toBe(128);
    expect(spanning.height).toBe(128);
  });

  it("writes out the heading of a row whose first plot is a chart block, which has no file or population to read", () => {
    const before = createDefaultLayoutWorkspace();
    const chart: LayoutProportionsRecipe = { kind: "proportions", settings: { ...BASE_PROPORTIONS_SETTINGS, files: ["f1", "f2"] }, panel: {} };
    const cells = [{ row: 0, column: 0 }, { row: 1, column: 0 }];
    const headings = { columns: [], rows: [{ text: "CD4_positive · CD3", template: "{population} · {plot}" }, { text: "CD4_positive · Plot 2", template: "{population} · {plot}" }] };
    const after = addPlotsToSheet(before, [plot("f1"), chart], cells, headings, 120, context);
    const items = after.sheets[0].items;
    const texts = items.filter((item) => item.recipe.kind === "text").map((item) => item.recipe);
    expect(texts[0]).toMatchObject({ text: "{population} · {plot}", readsFrom: items[0].id });
    expect(texts[1]).toMatchObject({ text: "CD4_positive · Plot 2" });
    expect(texts[1]).not.toHaveProperty("readsFrom");
  });

  it("returns the workspace unchanged when it has no sheet", () => {
    const empty: LayoutWorkspace = { ...createDefaultLayoutWorkspace(), sheets: [] };
    expect(addPlotsToSheet(empty, [plot("f1")], undefined, undefined, undefined, context)).toBe(empty);
  });
});
