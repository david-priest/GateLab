// Placed images on a Layout sheet: what is saved, and that a sheet holding a gated plot keeps the
// plot's recipe, and the plot's gate its count, when images are placed beside it, saved and
// loaded. A sheet saved before placed images loads as it did. Synthetic file D1, population
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
import { normalizePlacedImageRecipe, type LayoutPlacedImageRecipe } from "./placedImageBlock";

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

const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect id="r" width="40" height="20" fill="#336699"/></svg>';
const PNG_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const images: LayoutItem[] = [
  { id: "svg-1", x: 330, y: 60, width: 80, height: 40, z: 1, recipe: { kind: "image", fileName: "schematic_D1.svg", mediaType: "image/svg+xml", naturalWidth: 40, naturalHeight: 20, content: SVG_TEXT } },
  { id: "png-1", x: 330, y: 120, width: 10, height: 10, z: 2, name: "Panel control", recipe: { kind: "image", fileName: "control.png", mediaType: "image/png", naturalWidth: 1, naturalHeight: 1, content: PNG_URL } },
];

const saveAndLoad = (sheet: LayoutSheet) =>
  normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));

describe("Placed images on a Layout sheet", () => {
  it("round-trip through save and load beside a gated plot, which keeps its recipe and its gate its count", () => {
    const fx = gated();
    const counted = recompute(sample(), fx.state).populations[fx.popId].event_count;
    expect(counted).toBe(3);

    const sheet = createLayoutSheet("S");
    sheet.items = [plot(fx.popId), ...images];
    const loaded = saveAndLoad(sheet).sheets[0];
    // The plot loads as it does on a sheet without images, its recipe as it was written.
    const alone = createLayoutSheet("S");
    alone.items = [plot(fx.popId)];
    expect(loaded.items[0]).toEqual(saveAndLoad(alone).sheets[0].items[0]);
    expect(loaded.items[0]).toEqual({ ...plot(fx.popId), showFrame: false, locked: false });
    // Each image keeps its file name, type, natural size and content, byte for byte.
    expect(loaded.items.slice(1)).toEqual(images.map((item) => ({ ...item, showFrame: false, locked: false })));

    // The plot's gate counts as the gate list counts it, from the loaded recipe.
    const recipe = loaded.items[0].recipe as LayoutPlotRecipe;
    expect(recompute(sample(), fx.state).populations[recipe.populationId].event_count).toBe(counted);

    // Saved again, it is the same; cloned and copied, the images keep every field.
    expect(saveAndLoad(loaded as LayoutSheet).sheets[0].items).toEqual(loaded.items);
    expect(cloneLayoutWorkspace(saveAndLoad(sheet)).sheets[0].items.map((item) => item.recipe)).toEqual(loaded.items.map((item) => item.recipe));
    expect(copyLayoutItems(loaded.items.slice(1)).copies.map((item) => item.recipe)).toEqual(images.map((item) => item.recipe));
  });

  it("are not plots: they follow no iteration and are drawn once on each page as text is", () => {
    const fx = gated();
    const sheet = createLayoutSheet("S");
    sheet.items = [plot(fx.popId), ...images];
    sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const loaded = saveAndLoad(sheet).sheets[0];
    expect(loaded.items.slice(1).every((item) => !isPlotLikeRecipe(item.recipe) && !followsIteration(item))).toBe(true);
    const pages = expandLayoutSheet(loaded, [{ id: "D1", name: "D1", fileName: "D1.fcs" }, { id: "D2", name: "D2", fileName: "D2.fcs" }]);
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(page.items.filter((item) => item.recipe.kind === "image").map((item) => item.recipe)).toEqual(images.map((item) => item.recipe));
    }
    expect(layoutItemMinimum("image")).toEqual({ width: 8, height: 8 });
  });

  it("loads a sheet saved before placed images as it was", () => {
    const fx = gated();
    const sheet = createLayoutSheet("S");
    sheet.items = [plot(fx.popId), { id: "t", x: 10, y: 10, width: 160, height: 32, z: 1, recipe: { kind: "text", text: "CD4_positive", fontSize: 18 } }];
    const saved = JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] }));
    const loaded = normalizeLayoutWorkspace(saved);
    expect(loaded.sheets[0].items).toEqual(sheet.items.map((item) => ({ ...item, showFrame: false, locked: false })));
    expect(loaded.sheets[0].items.some((item) => item.recipe.kind === "image")).toBe(false);
  });

  it("normalises the fields, and drops an image of another type or without content of its type", () => {
    expect(normalizePlacedImageRecipe({ mediaType: "image/svg+xml", content: SVG_TEXT, fileName: "  a.svg ", naturalWidth: 40.004, naturalHeight: -3, extra: 1 }))
      .toEqual({ kind: "image", fileName: "a.svg", mediaType: "image/svg+xml", naturalWidth: 40, naturalHeight: 150, content: SVG_TEXT } satisfies LayoutPlacedImageRecipe);
    expect(normalizePlacedImageRecipe({ mediaType: "image/png", content: PNG_URL, naturalWidth: "x" })).toMatchObject({ fileName: "image", naturalWidth: 300, naturalHeight: 150 });
    expect(normalizePlacedImageRecipe({ mediaType: "image/gif", content: "data:image/gif;base64,R0lG" })).toBeNull();
    expect(normalizePlacedImageRecipe({ mediaType: "application/pdf", content: "%PDF-1.7" })).toBeNull();
    expect(normalizePlacedImageRecipe({ mediaType: "image/png", content: "data:image/jpeg;base64,/9j/" })).toBeNull();
    expect(normalizePlacedImageRecipe({ mediaType: "image/jpeg", content: "https://example.org/a.jpg" })).toBeNull();
    expect(normalizePlacedImageRecipe({ mediaType: "image/svg+xml", content: "<html></html>" })).toBeNull();
    expect(normalizePlacedImageRecipe({ mediaType: "image/svg+xml" })).toBeNull();

    // On a sheet: an image that does not normalise is dropped as any unknown block is.
    const workspace = normalizeLayoutWorkspace({
      version: 2, activeSheetId: "s", sheets: [{ id: "s", name: "S", items: [
        { id: "a", x: 0, y: 0, width: 40, height: 20, z: 0, recipe: { kind: "image", mediaType: "image/svg+xml", content: SVG_TEXT, naturalWidth: 40, naturalHeight: 20 } },
        { id: "b", x: 0, y: 0, width: 10, height: 10, z: 1, recipe: { kind: "image", mediaType: "image/png", content: "" } },
      ] }],
    });
    expect(workspace.sheets[0].items.map((item) => item.id)).toEqual(["a"]);
  });
});
