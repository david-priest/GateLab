// Panel letters on a Layout sheet: what the model saves for a letter and for the sheet's letter
// style, and that a sheet holding a gated plot keeps that plot's recipe, and its gate's count,
// unchanged when the plot is lettered. Synthetic file D1 and population CD4_positive; nothing
// here is a real experiment.

import { describe, expect, it } from "vitest";
import { initialCoreState, recompute, type CoreState } from "../store";
import { newGate, newPopulation, newRootPopulation } from "./models";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import {
  DEFAULT_LETTER_STYLE,
  cloneLayoutWorkspace,
  copyLayoutItems,
  createLayoutSheet,
  normalizeLayoutWorkspace,
  normalizeLetterStyle,
  type LayoutItem,
  type LayoutWorkspace,
} from "./layout";

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

describe("Panel letters in the layout model", () => {
  it("keeps a lettered gated plot's recipe and its gate's count, and round-trips the letter and the style", () => {
    const fx = fixture();
    const counted = recompute(fx.sample, fx.state).populations[fx.cd4Id].event_count;
    expect(counted).toBe(3);

    const sheet = createLayoutSheet("S");
    const plot = plotItem(fx.cd4Id);
    sheet.items = [
      plot,
      { id: "letter-1", x: 80, y: 100, width: 24, height: 26, z: 1, recipe: { kind: "text", text: "A", fontSize: 14, bold: true, letterFor: "plot-1", letterOffset: { x: -20, y: -20 } } },
    ];
    sheet.letterStyle = { fontSize: 14, bold: true, case: "lower" };
    const workspace: LayoutWorkspace = { version: 2, activeSheetId: sheet.id, sheets: [sheet] };
    const loaded = saveAndLoad(workspace);
    const [loadedPlot, letter] = loaded.sheets[0].items;
    expect(loadedPlot.recipe).toEqual(plot.recipe);
    expect(letter.recipe).toEqual({ kind: "text", text: "A", fontSize: 14, bold: true, letterFor: "plot-1", letterOffset: { x: -20, y: -20 } });
    expect(loaded.sheets[0].letterStyle).toEqual({ fontSize: 14, bold: true, case: "lower" });
    // Normalising what was loaded changes nothing, and a clone carries it.
    expect(saveAndLoad(loaded)).toEqual(loaded);
    expect(cloneLayoutWorkspace(loaded).sheets[0]).toMatchObject({ letterStyle: { case: "lower" }, items: [{ recipe: plot.recipe }, { recipe: { letterFor: "plot-1" } }] });
    // The plot the sheet holds still counts its gate's events as the gate list does.
    expect(recompute(fx.sample, fx.state).populations[(loadedPlot.recipe as { populationId: string }).populationId].event_count).toBe(counted);
  });

  it("loads a sheet saved without letters as before: no letter style, text without a binding", () => {
    const fx = fixture();
    const sheet = createLayoutSheet("S");
    sheet.items = [plotItem(fx.cd4Id), { id: "t", x: 10, y: 10, width: 160, height: 32, z: 1, recipe: { kind: "text", text: "Day 7", fontSize: 18 } }];
    const saved = JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] }));
    const loaded = normalizeLayoutWorkspace(saved);
    expect(loaded.sheets[0]).not.toHaveProperty("letterStyle");
    expect(loaded.sheets[0].items[1].recipe).toEqual({ kind: "text", text: "Day 7", fontSize: 18 });
    expect(loaded.sheets[0].items[0].recipe).toEqual(plotItem(fx.cd4Id).recipe);
  });

  it("fills a letter style from defaults and keeps its fields in range", () => {
    expect(normalizeLetterStyle(undefined)).toEqual(DEFAULT_LETTER_STYLE);
    expect(DEFAULT_LETTER_STYLE).toEqual({ fontSize: 16, bold: true, case: "upper" });
    expect(normalizeLetterStyle({ fontSize: 400, bold: false, case: "lower" })).toEqual({ fontSize: 72, bold: false, case: "lower" });
    expect(normalizeLetterStyle({ fontSize: "x", case: "title" })).toEqual(DEFAULT_LETTER_STYLE);
    // A letter saved with a malformed offset keeps its binding without the offset.
    const loaded = normalizeLayoutWorkspace({ version: 2, sheets: [{ id: "s", items: [{ id: "l", recipe: { kind: "text", text: "", fontSize: 16, letterFor: "p", letterOffset: { x: "a" } } }] }] });
    expect(loaded.sheets[0].items[0].recipe).toEqual({ kind: "text", text: "", fontSize: 16, letterFor: "p" });
  });

  it("binds a copied letter to the copy of its item", () => {
    const fx = fixture();
    const items: LayoutItem[] = [plotItem(fx.cd4Id), { id: "letter-1", x: 80, y: 100, width: 24, height: 26, z: 1, recipe: { kind: "text", text: "A", fontSize: 16, letterFor: "plot-1" } }];
    let n = 0;
    const { copies } = copyLayoutItems(items, () => `copy-${++n}`);
    expect(copies[1].recipe).toMatchObject({ letterFor: copies[0].id });
    // A letter copied without its item still names the original.
    expect(copyLayoutItems([items[1]], () => "lone").copies[0].recipe).toMatchObject({ letterFor: "plot-1" });
  });
});
