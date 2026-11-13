// A sheet's guides in the Layout model (rulers and guides): what the model saves for them, that a
// sheet holding a gated plot keeps that plot's recipe, and its gate's count, unchanged when guides
// are added, and that a sheet saved without guides loads as before. Synthetic file D1 and
// population CD4_positive; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { initialCoreState, recompute, type CoreState } from "../store";
import { newGate, newPopulation, newRootPopulation } from "./models";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { cloneLayoutWorkspace, createLayoutSheet, normalizeLayoutWorkspace, type LayoutItem, type LayoutWorkspace } from "./layout";

// Events as [FITC-A (CD4), FSC-A]; the rectangle CD4 1000..10000 × FSC-A 0..1000 holds three of five.
const EVENTS: [number, number][] = [[2000, 100], [3000, 200], [4000, 300], [100, 400], [200, 500]];

function fixture() {
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: EVENTS.length,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
      { index: 1, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from(EVENTS.map((e) => e[0])), Float32Array.from(EVENTS.map((e) => e[1]))],
  };
  const sample = new Sample(fcs);
  const state = initialCoreState() as CoreState;
  const root = newRootPopulation();
  const cd4 = newPopulation("CD4_positive", [], root.population_id);
  root.children = [cd4.population_id];
  const gate = { ...newGate("CD4_gate", "rectangle", "CD4", "FSC-A", [[1000, 0], [10000, 1000]]), space: "raw" as const };
  cd4.gate_refs = [{ gate_id: gate.gate_id, include: true }];
  Object.assign(state, {
    populations: { [root.population_id]: root, [cd4.population_id]: cd4 },
    root_population_id: root.population_id,
    active_population_id: cd4.population_id,
    gates: { [gate.gate_id]: gate },
    gate_order: [gate.gate_id],
  });
  return { sample, state, cd4Id: cd4.population_id };
}

function plotItem(populationId: string): LayoutItem {
  return {
    id: "plot-1", x: 100, y: 120, width: 260, height: 280, z: 0,
    recipe: { kind: "biplot", sampleId: "D1", populationId, xChannel: "CD4", yChannel: "FSC-A", displayMode: "pseudocolor" },
  };
}

function saveAndLoad(workspace: LayoutWorkspace): LayoutWorkspace {
  return normalizeLayoutWorkspace(JSON.parse(JSON.stringify(workspace)));
}

describe("Guides in the layout model", () => {
  it("keeps a gated plot's recipe and its gate's count, and round-trips the sheet's guides", () => {
    const fx = fixture();
    const counted = recompute(fx.sample, fx.state).populations[fx.cd4Id].event_count;
    expect(counted).toBe(3);

    const sheet = createLayoutSheet("S");
    const plot = plotItem(fx.cd4Id);
    sheet.items = [plot];
    sheet.guides = [{ axis: "x", at: 100 }, { axis: "y", at: 120.456 }];
    const loaded = saveAndLoad({ version: 2, activeSheetId: sheet.id, sheets: [sheet] });
    expect(loaded.sheets[0].items[0].recipe).toEqual(plot.recipe);
    expect(loaded.sheets[0].guides).toEqual([{ axis: "x", at: 100 }, { axis: "y", at: 120.46 }]);
    // Normalising what was loaded changes nothing; a clone carries its own copy of the guides.
    expect(saveAndLoad(loaded)).toEqual(loaded);
    const clone = cloneLayoutWorkspace(loaded);
    expect(clone.sheets[0].guides).toEqual(loaded.sheets[0].guides);
    clone.sheets[0].guides![0].at = 5;
    expect(loaded.sheets[0].guides![0].at).toBe(100);
    // The plot the sheet holds still counts its gate's events as the gate list does.
    expect(recompute(fx.sample, fx.state).populations[(loaded.sheets[0].items[0].recipe as { populationId: string }).populationId].event_count).toBe(counted);
  });

  it("loads a sheet saved without guides as before", () => {
    const fx = fixture();
    const sheet = createLayoutSheet("S");
    sheet.items = [plotItem(fx.cd4Id)];
    const loaded = saveAndLoad({ version: 2, activeSheetId: sheet.id, sheets: [sheet] });
    expect(loaded.sheets[0]).not.toHaveProperty("guides");
    expect(loaded.sheets[0].items[0].recipe).toEqual(plotItem(fx.cd4Id).recipe);
    expect(cloneLayoutWorkspace(loaded).sheets[0]).not.toHaveProperty("guides");
  });

  it("drops malformed guides and an empty list", () => {
    const loaded = normalizeLayoutWorkspace({
      version: 2,
      sheets: [
        { id: "a", items: [], guides: [{ axis: "z", at: 4 }, { axis: "x", at: "4" }, { axis: "y", at: Number.NaN }, null, { axis: "y", at: 40 }] },
        { id: "b", items: [], guides: [] },
        { id: "c", items: [], guides: "x" },
      ],
    });
    expect(loaded.sheets[0].guides).toEqual([{ axis: "y", at: 40 }]);
    expect(loaded.sheets[1]).not.toHaveProperty("guides");
    expect(loaded.sheets[2]).not.toHaveProperty("guides");
  });
});
