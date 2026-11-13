// A legend text block on a Layout sheet, written from a plot of a population counted through a
// drawn gate: the day it was written is kept when the workspace is saved and opened again, an
// older text block opens without one, and the plot it describes keeps the gate's count. Synthetic
// file D1; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { newGate, newGateRef, newPopulation, newRootPopulation, type Population } from "./models";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { cloneLayoutWorkspace, copyLayoutItems, createLayoutSheet, normalizeLayoutWorkspace, type LayoutTextRecipe } from "./layout";

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

describe("A legend text block", () => {
  it("keeps the day it was written through save and open, beside the plot whose count it states", () => {
    const { state, id } = tree();
    const count = recompute(file(), state).populations[id].event_count;
    expect(count).toBe(7);
    const sheet = createLayoutSheet("S");
    sheet.items = [
      { id: "plot", x: 20, y: 20, width: 200, height: 200, z: 0, recipe: { kind: "histogram", sampleId: "D1", populationId: id, xChannel: "FSC-A", yChannel: null, displayMode: "pseudocolor" } },
      { id: "legend", x: 20, y: 232, width: 320, height: 40, z: 1, recipe: { kind: "text", text: `Panel 1. Histogram of FSC-A of CD4_positive cells in D1.fcs (n = ${count} events).`, fontSize: 10, legendGenerated: "2026-11-10" } },
    ];
    const loaded = reopen(sheet);
    const legend = loaded.items.find((item) => item.id === "legend")!.recipe as LayoutTextRecipe;
    expect(legend.legendGenerated).toBe("2026-11-10");
    expect(legend.text).toContain("n = 7 events");
    expect(loaded.items.find((item) => item.id === "plot")!.recipe).toMatchObject({ populationId: id });
    expect((cloneLayoutWorkspace({ version: 2, activeSheetId: loaded.id, sheets: [loaded] }).sheets[0].items[1].recipe as LayoutTextRecipe).legendGenerated).toBe("2026-11-10");
    expect((copyLayoutItems([loaded.items[1]]).copies[0].recipe as LayoutTextRecipe).legendGenerated).toBe("2026-11-10");
  });

  it("opens a text block saved before legends without a date, and drops a malformed one", () => {
    const sheet = createLayoutSheet("S");
    sheet.items = [
      { id: "old", x: 0, y: 0, width: 160, height: 32, z: 0, recipe: { kind: "text", text: "Text", fontSize: 18 } },
      { id: "bad", x: 0, y: 40, width: 160, height: 32, z: 1, recipe: { kind: "text", text: "Text", fontSize: 18, legendGenerated: "yesterday" } as never },
    ];
    const loaded = reopen(sheet);
    expect(loaded.items.map((item) => item.recipe)).toEqual([
      { kind: "text", text: "Text", fontSize: 18 },
      { kind: "text", text: "Text", fontSize: 18 },
    ]);
  });
});
