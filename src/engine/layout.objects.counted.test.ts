// An item's name and hidden flag in the Layout model (the objects list): what the model saves for
// them, that a sheet holding a gated plot keeps that plot's recipe, and its gate's count,
// unchanged when the plot is named and hidden, and that a sheet saved without them loads as
// before. Synthetic file D1 and population CD4_positive; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { initialCoreState, recompute, type CoreState } from "../store";
import { newGate, newPopulation, newRootPopulation } from "./models";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { cloneLayoutWorkspace, copyLayoutItems, createLayoutSheet, normalizeLayoutWorkspace, type LayoutItem, type LayoutWorkspace } from "./layout";

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

describe("Item names and hidden items in the layout model", () => {
  it("keeps a named, hidden gated plot's recipe and its gate's count, and round-trips the name and the flag", () => {
    const fx = fixture();
    const counted = recompute(fx.sample, fx.state).populations[fx.cd4Id].event_count;
    expect(counted).toBe(3);

    const sheet = createLayoutSheet("S");
    const plot: LayoutItem = { ...plotItem(fx.cd4Id), name: "CD4 panel", hidden: true };
    sheet.items = [plot, { id: "t", x: 10, y: 10, width: 160, height: 32, z: 1, name: "Heading", recipe: { kind: "text", text: "Day 7", fontSize: 18 } }];
    const loaded = saveAndLoad({ version: 2, activeSheetId: sheet.id, sheets: [sheet] });
    const [loadedPlot, text] = loaded.sheets[0].items;
    expect(loadedPlot.recipe).toEqual(plot.recipe);
    expect(loadedPlot).toMatchObject({ name: "CD4 panel", hidden: true });
    expect(text).toMatchObject({ name: "Heading" });
    expect(text).not.toHaveProperty("hidden");
    // Normalising what was loaded changes nothing, and a clone and a copy carry both fields.
    expect(saveAndLoad(loaded)).toEqual(loaded);
    expect(cloneLayoutWorkspace(loaded).sheets[0].items[0]).toMatchObject({ name: "CD4 panel", hidden: true });
    expect(copyLayoutItems([loadedPlot], () => "copy").copies[0]).toMatchObject({ id: "copy", name: "CD4 panel", hidden: true });
    // The plot the sheet holds still counts its gate's events as the gate list does.
    expect(recompute(fx.sample, fx.state).populations[(loadedPlot.recipe as { populationId: string }).populationId].event_count).toBe(counted);
  });

  it("loads a sheet saved without names or hidden items as before", () => {
    const fx = fixture();
    const sheet = createLayoutSheet("S");
    sheet.items = [plotItem(fx.cd4Id)];
    const loaded = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    const item = loaded.sheets[0].items[0];
    expect(item).not.toHaveProperty("name");
    expect(item).not.toHaveProperty("hidden");
    expect(item.recipe).toEqual(plotItem(fx.cd4Id).recipe);
    expect(item).toMatchObject({ id: "plot-1", x: 100, y: 120, width: 260, height: 280, z: 0, locked: false, showFrame: false });
  });

  it("drops a blank or malformed name and any hidden flag but true", () => {
    const loaded = normalizeLayoutWorkspace({
      version: 2,
      sheets: [{ id: "s", items: [
        { id: "a", name: "   ", hidden: "yes", recipe: { kind: "text", text: "A", fontSize: 16 } },
        { id: "b", name: 7, hidden: false, recipe: { kind: "text", text: "B", fontSize: 16 } },
        { id: "c", name: "  treated  ", recipe: { kind: "text", text: "C", fontSize: 16 } },
      ] }],
    });
    const [a, b, c] = loaded.sheets[0].items;
    expect(a).not.toHaveProperty("name");
    expect(a).not.toHaveProperty("hidden");
    expect(b).not.toHaveProperty("name");
    expect(b).not.toHaveProperty("hidden");
    expect(c.name).toBe("treated");
  });
});
