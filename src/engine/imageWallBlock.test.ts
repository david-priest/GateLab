import { describe, expect, it } from "vitest";
import { imageWallCaption, imageWallNaturalSize, normalizeImageWallRecipe, type LayoutImageWallRecipe } from "./imageWallBlock";
import { normalizeLayoutWorkspace } from "./layout";

const recipe: LayoutImageWallRecipe = {
  kind: "imagewall", sampleId: "D1", fileName: "D1.fcs", populationId: "p1", populationName: "CD4_positive",
  events: [3, 1, 2], imaged: 3, populationCount: 10, sortKey: "FSC-A", sortLabel: "FSC-A", sortDesc: false,
  display: [{ slot: 2, name: "LightLoss (Imaging)", enabled: true, colour: "#bdbdbd", threshold: 0, saturation: 0.8, gamma: 1, smoothing: 1 }],
  exposure: 1, tile: 40, columns: 2,
};

describe("the image wall block", () => {
  it("sizes itself from its tiles and caption", () => {
    expect(imageWallNaturalSize(recipe)).toEqual({ width: 8 * 2 + 2 * 40 + 3, height: 8 * 2 + 34 + 2 * 40 + 3 });
    expect(imageWallNaturalSize({ events: [], tile: 40, columns: 0 })).toEqual({ width: 16 + 40, height: 16 + 34 + 40 });
  });

  it("adds a legend line to its height and keeps the colours through a save", () => {
    const legend = [{ label: "single", colour: "#1f77b4" }, { label: "multiple objects", colour: "#2ca02c" }];
    const classed = { ...recipe, tileColours: ["#1f77b4", "", "#2ca02c"], legend };
    expect(imageWallNaturalSize(classed).height).toBe(imageWallNaturalSize(recipe).height + 16);
    expect(normalizeImageWallRecipe({ ...classed } as unknown as Record<string, unknown>)).toMatchObject({ tileColours: ["#1f77b4", "", "#2ca02c"], legend });
    expect(normalizeImageWallRecipe({ ...classed, legend: [{ label: 1 }, { label: "ok", colour: "#000" }] } as unknown as Record<string, unknown>)?.legend).toEqual([{ label: "ok", colour: "#000" }]);
    expect(normalizeImageWallRecipe({ ...classed, outline: { slot: 4, fraction: 0.125 } } as unknown as Record<string, unknown>)?.outline).toEqual({ slot: 4, fraction: 0.125 });
    expect(normalizeImageWallRecipe({ ...classed, outline: {} } as unknown as Record<string, unknown>)?.outline).toEqual({});
    expect(normalizeImageWallRecipe({ ...classed, outline: "yes" } as unknown as Record<string, unknown>)?.outline).toBeUndefined();
    expect(normalizeImageWallRecipe({ ...classed, tileColours: [1] } as unknown as Record<string, unknown>)?.tileColours).toBeUndefined();
  });

  it("captions the population, the file, the counts and the order", () => {
    expect(imageWallCaption(recipe)).toEqual(["CD4_positive", "D1.fcs · 3 imaged cells of 10 · sorted by FSC-A ↑"]);
    expect(imageWallCaption({ ...recipe, title: " Naive B ", events: [3], sortKey: "", sortDesc: true })).toEqual(["Naive B", "D1.fcs · 1 of 3 imaged cells of 10 · latest first"]);
    expect(imageWallCaption({ ...recipe, sortKey: "" })[1]).toContain("in event order");
    expect(imageWallCaption({ ...recipe, rangeLabel: "FSC-A 120–340" })[1]).toBe("D1.fcs · 3 imaged cells of 10 · sorted by FSC-A ↑ · FSC-A 120–340");
    expect(normalizeImageWallRecipe({ ...recipe, rangeLabel: "FSC-A 120–340" } as unknown as Record<string, unknown>)?.rangeLabel).toBe("FSC-A 120–340");
    expect(normalizeImageWallRecipe({ ...recipe, rangeLabel: 3 } as unknown as Record<string, unknown>)?.rangeLabel).toBeUndefined();
  });

  it("is kept through a saved layout workspace, and a broken one is dropped", () => {
    const saved = { version: 1, activeSheetId: "s", sheets: [{ id: "s", name: "Sheet", items: [{ id: "i", x: 0, y: 0, width: 200, height: 160, z: 1, recipe }, { id: "j", x: 0, y: 0, width: 200, height: 160, z: 2, recipe: { ...recipe, events: ["x"] } }] }] };
    const workspace = normalizeLayoutWorkspace(saved);
    const items = workspace.sheets[0].items;
    expect(items).toHaveLength(1);
    expect(items[0].recipe).toEqual(recipe);
    expect(normalizeImageWallRecipe({ kind: "imagewall", sampleId: "D1", events: [1], display: [] })).toMatchObject({ imaged: 1, tile: 56, columns: 8, exposure: 1, sortDesc: false });
    expect(normalizeImageWallRecipe({ kind: "imagewall", events: [1], display: [] })).toBeNull();
  });
});
