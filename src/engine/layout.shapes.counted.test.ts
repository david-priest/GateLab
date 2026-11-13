// Lines and shapes on a Layout sheet: what is saved, and that a sheet holding a gated plot keeps
// the plot's recipe, and the plot's gate its count, when shapes are added beside it, saved and
// loaded. A sheet saved before shapes loads as it did. Synthetic file D1, population
// CD4_positive; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import {
  cloneLayoutWorkspace,
  copyLayoutItems,
  createLayoutSheet,
  followsIteration,
  isPlotLikeRecipe,
  layoutItemMinimum,
  normalizeLayoutWorkspace,
  type LayoutItem,
  type LayoutPlotRecipe,
  type LayoutSheet,
} from "./layout";
import { expandLayoutSheet } from "./layoutBatch";
import { defaultShapeRecipe, normalizeShapeRecipe, type LayoutShapeRecipe } from "./shapeBlock";

// Each event is [FITC-A (CD4), FSC-A]; CD4_positive is FITC-A from 1000: 3 of D1's 5 events.
function sample(): Sample {
  const channels = [
    { index: 0, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
    { index: 1, name: "FSC-A", marker: null, bits: 32, range: 262144 },
  ];
  const events = [[5000, 10], [6000, 20], [7000, 30], [100, 40], [200, 50]];
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: events.length,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels,
    columns: channels.map((_, c) => Float32Array.from(events.map((event) => event[c]))),
  };
  return new Sample(fcs);
}

function gated() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 5 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "FSC-A",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["Q1", "Q2", "CD4_positive", "Q4"],
  });
  const core = state as CoreState;
  const pop = Object.values(core.populations).find((p) => p.name === "CD4_positive")!;
  return { state: core, popId: pop.population_id };
}

const plot = (popId: string): LayoutItem => ({
  id: "plot-1", x: 57, y: 57, width: 260, height: 280, z: 0,
  recipe: { kind: "biplot", sampleId: "D1", populationId: popId, xChannel: "FITC-A", yChannel: "FSC-A", displayMode: "pseudocolor", iterated: true },
});

const shapes: LayoutItem[] = [
  { id: "arrow-1", x: 330, y: 150, width: 120, height: 0, z: 1, recipe: { ...defaultShapeRecipe("arrow"), strokeWidth: 1.5, from: "bottom-right" } },
  { id: "bracket-1", x: 57, y: 30, width: 260, height: 12, z: 2, recipe: { ...defaultShapeRecipe("bracket"), dash: "dashed", ends: 10 } },
  { id: "rect-1", x: 40, y: 40, width: 300, height: 320, z: 3, recipe: { ...defaultShapeRecipe("rectangle"), stroke: "#ff0000", fill: "#eeeeee", cornerRadius: 6 } },
  { id: "ellipse-1", x: 400, y: 300, width: 0, height: 80, z: 4, recipe: { ...defaultShapeRecipe("ellipse"), dash: "dotted" } },
];

const saveAndLoad = (sheet: LayoutSheet) =>
  normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));

describe("Shapes on a Layout sheet", () => {
  it("round-trip through save and load beside a gated plot, which keeps its recipe and its gate its count", () => {
    const fx = gated();
    const counted = recompute(sample(), fx.state).populations[fx.popId].event_count;
    expect(counted).toBe(3);

    const sheet = createLayoutSheet("S");
    sheet.items = [plot(fx.popId), ...shapes];
    const loaded = saveAndLoad(sheet).sheets[0];
    // The plot loads as it does on a sheet without shapes, its recipe as it was written.
    const alone = createLayoutSheet("S");
    alone.items = [plot(fx.popId)];
    expect(loaded.items[0]).toEqual(saveAndLoad(alone).sheets[0].items[0]);
    expect(loaded.items[0]).toEqual({ ...plot(fx.popId), showFrame: false, locked: false });
    expect(loaded.items.slice(1)).toEqual(shapes.map((item) => ({ ...item, showFrame: false, locked: false })));
    // A line with no height and an ellipse with no width keep their frames.
    expect(loaded.items.find((item) => item.id === "arrow-1")).toMatchObject({ width: 120, height: 0 });
    expect(loaded.items.find((item) => item.id === "ellipse-1")).toMatchObject({ width: 0, height: 80 });

    // The plot's gate counts as the gate list counts it, from the loaded recipe.
    const recipe = loaded.items[0].recipe as LayoutPlotRecipe;
    expect(recompute(sample(), fx.state).populations[recipe.populationId].event_count).toBe(counted);

    // Saved again, it is the same; cloned and copied, the shapes keep every field.
    expect(saveAndLoad(loaded as LayoutSheet).sheets[0].items).toEqual(loaded.items);
    expect(cloneLayoutWorkspace(saveAndLoad(sheet)).sheets[0].items.map((item) => item.recipe)).toEqual(loaded.items.map((item) => item.recipe));
    expect(copyLayoutItems(loaded.items.slice(1)).copies.map((item) => item.recipe)).toEqual(shapes.map((item) => item.recipe));
  });

  it("are not plots: they follow no iteration and are drawn once on each page as text is", () => {
    const fx = gated();
    const sheet = createLayoutSheet("S");
    sheet.items = [plot(fx.popId), ...shapes];
    sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const loaded = saveAndLoad(sheet).sheets[0];
    expect(loaded.items.slice(1).every((item) => !isPlotLikeRecipe(item.recipe) && !followsIteration(item))).toBe(true);
    const pages = expandLayoutSheet(loaded, [{ id: "D1", name: "D1", fileName: "D1.fcs" }, { id: "D2", name: "D2", fileName: "D2.fcs" }]);
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(page.items.filter((item) => item.recipe.kind === "shape").map((item) => item.recipe)).toEqual(shapes.map((item) => item.recipe));
    }
    expect(layoutItemMinimum("shape")).toEqual({ width: 0, height: 0 });
  });

  it("loads a sheet saved before shapes as it was", () => {
    const fx = gated();
    const sheet = createLayoutSheet("S");
    sheet.items = [plot(fx.popId), { id: "t", x: 10, y: 10, width: 160, height: 32, z: 1, recipe: { kind: "text", text: "CD4_positive", fontSize: 18 } }];
    const saved = JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] }));
    const loaded = normalizeLayoutWorkspace(saved);
    expect(loaded.sheets[0].items).toEqual(sheet.items.map((item) => ({ ...item, showFrame: false, locked: false })));
    expect(loaded.sheets[0].items.some((item) => item.recipe.kind === "shape")).toBe(false);
  });

  it("normalises each kind, keeping only the fields it uses within range, and drops an unknown kind", () => {
    const line = normalizeShapeRecipe({ shape: "line", stroke: "#F00", strokeWidth: 1.3, dash: "wavy", arrows: "both", from: "top-right", fill: "#00ff00", side: "up" });
    expect(line).toEqual({ kind: "shape", shape: "line", stroke: "#ff0000", strokeWidth: 1.25, dash: "solid", arrows: "both", from: "top-right" });
    expect(normalizeShapeRecipe({ shape: "line" })).toEqual({ kind: "shape", shape: "line", stroke: "#000000", strokeWidth: 1, dash: "solid", arrows: "none", from: "top-left" });
    expect(normalizeShapeRecipe({ shape: "bracket", side: "left", ends: -4, arrows: "end" })).toEqual({ kind: "shape", shape: "bracket", stroke: "#000000", strokeWidth: 1, dash: "solid", side: "left", ends: 0 });
    expect(normalizeShapeRecipe({ shape: "bracket", side: "sideways", ends: "x" })).toMatchObject({ side: "down", ends: 8 });
    expect(normalizeShapeRecipe({ shape: "rectangle", fill: "red", cornerRadius: 9000, strokeWidth: 0 })).toEqual({ kind: "shape", shape: "rectangle", stroke: "#000000", strokeWidth: 0.25, dash: "solid", cornerRadius: 400 });
    expect(normalizeShapeRecipe({ shape: "ellipse", fill: "#abc", cornerRadius: 5, stroke: "black", strokeWidth: 99, dash: "dotted" })).toEqual({ kind: "shape", shape: "ellipse", stroke: "#000000", strokeWidth: 24, dash: "dotted", fill: "#aabbcc" });
    expect(normalizeShapeRecipe({ shape: "star" })).toBeNull();

    // On a sheet: an unknown kind is dropped as any unknown block is; a bad frame becomes the default.
    const workspace = normalizeLayoutWorkspace({
      version: 2, activeSheetId: "s", sheets: [{ id: "s", name: "S", items: [
        { id: "a", x: 0, y: 0, width: -5, height: "x", z: 0, recipe: { kind: "shape", shape: "line", strokeWidth: Number.NaN } },
        { id: "b", x: 0, y: 0, width: 10, height: 10, z: 1, recipe: { kind: "shape", shape: "hexagon" } },
      ] }],
    });
    expect(workspace.sheets[0].items).toHaveLength(1);
    expect(workspace.sheets[0].items[0]).toMatchObject({ width: 0, height: 280, recipe: { shape: "line", strokeWidth: 1 } satisfies Partial<LayoutShapeRecipe> });
  });
});
