// A text block or placed image turned in quarter turns on a Layout sheet: the turn is saved on the
// item, and a sheet holding a gated plot keeps the plot's recipe, and the plot's gate its count,
// beside a turned text block, through save, load, clone and copy. A turn other than 90, 180 or
// 270, or on another kind of item, is dropped; a sheet saved before turns loads as it did.
// Synthetic file D1, population CD4_positive; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import {
  cloneLayoutWorkspace,
  copyLayoutItems,
  createLayoutSheet,
  normalizeLayoutWorkspace,
  type LayoutItem,
  type LayoutPlotRecipe,
  type LayoutSheet,
} from "./layout";

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
  recipe: { kind: "biplot", sampleId: "D1", populationId: popId, xChannel: "FITC-A", yChannel: "FSC-A", displayMode: "pseudocolor" },
});

const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect width="40" height="20" fill="#336699"/></svg>';

const turned: LayoutItem[] = [
  { id: "label-1", x: 20, y: 57, width: 32, height: 160, z: 1, rotation: 270, recipe: { kind: "text", text: "CD4_positive", fontSize: 14, bold: true } },
  { id: "label-2", x: 330, y: 57, width: 120, height: 32, z: 2, rotation: 180, recipe: { kind: "text", text: "control", fontSize: 14 } },
  { id: "svg-1", x: 330, y: 120, width: 20, height: 40, z: 3, rotation: 90, recipe: { kind: "image", fileName: "schematic_D1.svg", mediaType: "image/svg+xml", naturalWidth: 40, naturalHeight: 20, content: SVG_TEXT } },
];

const saveAndLoad = (sheet: LayoutSheet) =>
  normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));

describe("Turned text blocks and placed images on a Layout sheet", () => {
  it("keep the turn through save, load, clone and copy beside a gated plot, which keeps its recipe and its gate its count", () => {
    const fx = gated();
    const counted = recompute(sample(), fx.state).populations[fx.popId].event_count;
    expect(counted).toBe(3);

    const sheet = createLayoutSheet("S");
    sheet.items = [plot(fx.popId), ...turned];
    const loaded = saveAndLoad(sheet).sheets[0];
    // The plot loads as it does on a sheet without turned items, its recipe as it was written.
    const alone = createLayoutSheet("S");
    alone.items = [plot(fx.popId)];
    expect(loaded.items[0]).toEqual(saveAndLoad(alone).sheets[0].items[0]);
    expect(loaded.items[0]).toEqual({ ...plot(fx.popId), showFrame: false, locked: false });
    expect(loaded.items[0]).not.toHaveProperty("rotation");
    // Each turned item keeps its turn and frame.
    expect(loaded.items.slice(1)).toEqual(turned.map((item) => ({ ...item, showFrame: false, locked: false })));

    // The plot's gate counts as the gate list counts it, from the loaded recipe.
    const recipe = loaded.items[0].recipe as LayoutPlotRecipe;
    expect(recompute(sample(), fx.state).populations[recipe.populationId].event_count).toBe(counted);

    // Saved again, it is the same; cloned and copied, the turns are kept.
    expect(saveAndLoad(loaded).sheets[0].items).toEqual(loaded.items);
    expect(cloneLayoutWorkspace(saveAndLoad(sheet)).sheets[0].items.map((item) => item.rotation)).toEqual([undefined, 270, 180, 90]);
    expect(copyLayoutItems(loaded.items.slice(1)).copies.map((item) => item.rotation)).toEqual([270, 180, 90]);
  });

  it("drops a turn that is not a quarter turn, a turn of 0, and a turn on any other kind of item", () => {
    const fx = gated();
    const text = (id: string, rotation: unknown) => ({ id, x: 0, y: 0, width: 100, height: 32, z: 0, rotation, recipe: { kind: "text", text: "D1", fontSize: 14 } });
    const workspace = normalizeLayoutWorkspace({
      version: 2, activeSheetId: "s", sheets: [{ id: "s", name: "S", items: [
        text("a", 45), text("b", 0), text("c", "90"), text("d", -90), text("e", 360), text("f", 90.5), text("g", 270),
        { ...plot(fx.popId), rotation: 90 },
        { id: "shape", x: 0, y: 0, width: 40, height: 40, z: 9, rotation: 180, recipe: { kind: "shape", shape: "rectangle" } },
      ] }],
    });
    const items = workspace.sheets[0].items;
    expect(items.map((item) => [item.id, item.rotation])).toEqual([
      ["a", undefined], ["b", undefined], ["c", undefined], ["d", undefined], ["e", undefined], ["f", undefined], ["g", 270],
      ["plot-1", undefined], ["shape", undefined],
    ]);
    expect(items.filter((item) => item.id !== "g").every((item) => !("rotation" in item))).toBe(true);
    expect(items.find((item) => item.id === "plot-1")!.recipe).toEqual(plot(fx.popId).recipe);
  });

  it("loads a sheet saved before turns as it was", () => {
    const fx = gated();
    const sheet = createLayoutSheet("S");
    sheet.items = [plot(fx.popId), { id: "t", x: 10, y: 10, width: 160, height: 32, z: 1, recipe: { kind: "text", text: "CD4_positive", fontSize: 18 } }];
    const loaded = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    expect(loaded.sheets[0].items).toEqual(sheet.items.map((item) => ({ ...item, showFrame: false, locked: false })));
    expect(loaded.sheets[0].items.some((item) => "rotation" in item)).toBe(false);
  });
});
