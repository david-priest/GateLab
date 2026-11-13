// A formatted text block on a Layout sheet beside a plot of a population counted through a drawn
// gate: its italic, colour, alignment and inline-formatting flag are kept when the workspace is
// saved and opened again and when it is copied or iterated, an older text block opens without
// them, and the plot keeps its recipe and the gate's count. Synthetic file D1; nothing here is a
// real experiment.

import { describe, expect, it } from "vitest";
import { newGate, newGateRef, newPopulation, newRootPopulation, type Population } from "./models";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { cloneLayoutWorkspace, copyLayoutItems, createLayoutSheet, normalizeLayoutWorkspace, type LayoutItem, type LayoutTextRecipe } from "./layout";
import { expandLayoutSheet } from "./layoutBatch";

// Gate CD4_positive holds FSC below 55, in raw units.
function tree() {
  const state = initialCoreState();
  const root = newRootPopulation();
  const gate = newGate("CD4_positive", "rectangle", "FSC-A", "SSC-A", [[0, 0], [55, 1000]]);
  const population = newPopulation("CD4_positive", [newGateRef(gate.gate_id)], root.population_id);
  root.children = [population.population_id];
  const populations: Record<string, Population> = { [root.population_id]: root, [population.population_id]: population };
  Object.assign(state, {
    gates: { [gate.gate_id]: gate },
    gate_order: [gate.gate_id],
    populations,
    root_population_id: root.population_id,
    active_population_id: root.population_id,
  });
  return { state: state as CoreState, id: population.population_id };
}

// Twenty events, seven of them inside the gate.
function file(): Sample {
  const fsc = Array.from({ length: 20 }, (_, i) => (i < 7 ? 10 + 5 * i : 60 + i));
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: fsc.length, instrument: "flow", keywords: {}, spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from(fsc), Float32Array.from(fsc.map(() => 10))],
  };
  return new Sample(fcs);
}

const reopen = (sheet: ReturnType<typeof createLayoutSheet>) =>
  normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] }))).sheets[0];

const plot = (id: string): LayoutItem => ({
  id: "plot", x: 20, y: 20, width: 200, height: 200, z: 0,
  recipe: { kind: "biplot", sampleId: "D1", populationId: id, xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor" },
});

describe("A formatted text block", () => {
  it("keeps italic, colour, alignment and its inline tags through save and open, beside the plot whose count it states", () => {
    const { state, id } = tree();
    expect(recompute(file(), state).populations[id].event_count).toBe(7);
    const sheet = createLayoutSheet("S");
    const text: LayoutTextRecipe = { kind: "text", text: "<b>CD4</b><sup>+</sup> of {file}: 7 &lt; 8", fontSize: 12, italic: true, color: "#AA3300", align: "center", rich: true };
    sheet.items = [plot(id), { id: "label", x: 20, y: 232, width: 200, height: 30, z: 1, recipe: text }];
    const before = JSON.parse(JSON.stringify(sheet.items[0].recipe));
    const loaded = reopen(sheet);
    expect(loaded.items[0].recipe).toEqual(before);
    expect(loaded.items[1].recipe).toEqual({ ...text, color: "#aa3300" });
    const cloned = cloneLayoutWorkspace({ version: 2, activeSheetId: loaded.id, sheets: [loaded] }).sheets[0];
    expect(cloned.items[1].recipe).toEqual(loaded.items[1].recipe);
    expect(copyLayoutItems([loaded.items[1]]).copies[0].recipe).toEqual(loaded.items[1].recipe);
    // Iterated over a file, the placeholder inside the text is filled and the formatting stays.
    loaded.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const [page] = expandLayoutSheet(loaded, [{ id: "D1", name: "D1", fileName: "D1.fcs" }]);
    expect(page.items.find((item) => item.templateId === "label")!.recipe).toMatchObject({ text: "<b>CD4</b><sup>+</sup> of D1.fcs: 7 &lt; 8", rich: true, italic: true, align: "center" });
    expect(page.items.find((item) => item.templateId === "plot")!.recipe).toMatchObject({ populationId: id });
    expect(recompute(file(), state).populations[id].event_count).toBe(7);
  });

  it("opens a text block saved before formatting as it was, and drops malformed fields", () => {
    const sheet = createLayoutSheet("S");
    sheet.items = [
      { id: "old", x: 0, y: 0, width: 160, height: 32, z: 0, recipe: { kind: "text", text: "a <b>tag</b> typed as text", fontSize: 18 } },
      { id: "bad", x: 0, y: 40, width: 160, height: 32, z: 1, recipe: { kind: "text", text: "Text", fontSize: 18, italic: "yes", color: "red", align: "justify", rich: 1 } as never },
    ];
    const loaded = reopen(sheet);
    expect(loaded.items.map((item) => item.recipe)).toEqual([
      { kind: "text", text: "a <b>tag</b> typed as text", fontSize: 18 },
      { kind: "text", text: "Text", fontSize: 18 },
    ]);
  });
});
