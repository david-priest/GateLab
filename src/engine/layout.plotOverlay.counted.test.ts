// A Layout plot overlaying several populations (an Illustration plot's four quadrants carried to
// the Layout tab): what is saved, copied and bound per unit when the sheet iterates, against the
// gate list's counts in each file. Synthetic files D1 and D2; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { cloneLayoutWorkspace, createLayoutSheet, normalizeLayoutWorkspace, type LayoutItem, type LayoutPlotRecipe } from "./layout";
import { expandLayoutSheet, type LayoutUnit } from "./layoutBatch";
import { plotTitle, plotTitleContext } from "./layoutTitle";

// Each event is [FITC-A (CD4), PE-A (CD8)]; the quadrant's centre is at 1000, 1000.
const LOW = 100;
const HIGH = 5000;
function sample(events: [number, number][]): Sample {
  const channels = [
    { index: 0, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
    { index: 1, name: "PE-A", marker: "CD8", bits: 32, range: 262144 },
  ];
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
// D1: CD8 SP 3, DP 1, CD4 SP 4, DN 0. D2: CD8 SP 1, DP 0, CD4 SP 2, DN 2.
const FILES: Record<string, Sample> = {
  D1: sample([[LOW, HIGH], [LOW, HIGH], [LOW, HIGH], [HIGH, HIGH], [HIGH, LOW], [HIGH, LOW], [HIGH, LOW], [HIGH, LOW]]),
  D2: sample([[LOW, HIGH], [HIGH, LOW], [HIGH, LOW], [LOW, LOW], [LOW, LOW]]),
};
const UNITS: LayoutUnit[] = [
  { id: "D1", name: "D1", fileName: "D1.fcs" },
  { id: "D2", name: "D2", fileName: "D2.fcs" },
];

function quadrants() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 8 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "CD8",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["CD8 SP", "DP", "CD4 SP", "DN"],
  });
  const core = state as CoreState;
  const gate = Object.values(core.gates).find((g) => g.gate_type === "quadrant")!;
  const ids = [1, 2, 3, 4].map((q) =>
    Object.values(core.populations).find((p) => p.gate_refs.some((r) => r.gate_id === gate.gate_id && r.quadrant === q))!.population_id,
  );
  return { state: core, ids };
}

function overlayItem(ids: string[]): LayoutItem {
  const recipe: LayoutPlotRecipe = {
    kind: "histogram", sampleId: "D1", populationId: ids[0], populationIds: ids,
    xChannel: "CD4", yChannel: null, displayMode: "pseudocolor", iterated: true,
  };
  return { id: "a", x: 57, y: 57, width: 288, height: 288, z: 0, recipe };
}

describe("A Layout plot overlaying populations", () => {
  it("keeps its populations through a save, a copy and a file iteration, each counted as the gate list counts it", () => {
    const fx = quadrants();
    const sheet = createLayoutSheet("S");
    sheet.items = [overlayItem(fx.ids)];
    const saved = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    const reloaded = saved.sheets[0].items[0].recipe as LayoutPlotRecipe;
    expect(reloaded.populationIds).toEqual(fx.ids);
    const copy = cloneLayoutWorkspace(saved);
    expect((copy.sheets[0].items[0].recipe as LayoutPlotRecipe).populationIds).not.toBe(reloaded.populationIds);

    saved.sheets[0].iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const pages = expandLayoutSheet(saved.sheets[0], UNITS);
    const expected: Record<string, number[]> = { D1: [3, 1, 4, 0], D2: [1, 0, 2, 2] };
    for (const page of pages) {
      const recipe = page.items[0].recipe as LayoutPlotRecipe;
      expect(recipe.populationIds).toEqual(fx.ids);
      const counts = recompute(FILES[recipe.sampleId], fx.state).populations;
      expect(recipe.populationIds!.map((id) => counts[id].event_count)).toEqual(expected[recipe.sampleId]);
    }
    expect(pages.map((page) => (page.items[0].recipe as LayoutPlotRecipe).sampleId)).toEqual(["D1", "D2"]);
  });

  it("is drawn as each population alone when the sheet iterates over populations", () => {
    const fx = quadrants();
    const sheet = createLayoutSheet("S");
    sheet.items = [overlayItem(fx.ids)];
    sheet.iteration = { mode: "populations", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const units: LayoutUnit[] = fx.ids.map((id, i) => ({ id, name: `Q${i + 1}`, fileName: "D1.fcs", populationId: id, sampleName: "D1" }));
    const pages = expandLayoutSheet(sheet, units);
    expect(pages.map((page) => (page.items[0].recipe as LayoutPlotRecipe).populationId)).toEqual(fx.ids);
    expect(pages.every((page) => (page.items[0].recipe as LayoutPlotRecipe).populationIds === undefined)).toBe(true);
  });

  it("saves an overlay of two or more populations only", () => {
    const fx = quadrants();
    const sheet = createLayoutSheet("S");
    const one = overlayItem([fx.ids[0]]);
    const bad = overlayItem(fx.ids);
    (bad.recipe as unknown as { populationIds: unknown }).populationIds = [3, "", fx.ids[1], fx.ids[1], fx.ids[2]];
    sheet.items = [one, { ...bad, id: "b" }];
    const saved = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    expect((saved.sheets[0].items[0].recipe as LayoutPlotRecipe).populationIds).toBeUndefined();
    expect((saved.sheets[0].items[1].recipe as LayoutPlotRecipe).populationIds).toEqual([fx.ids[1], fx.ids[2]]);
  });

  it("keeps the overlay mode the Illustration tab sent through a save, a copy and a file iteration, and loads a plot saved without one", () => {
    const fx = quadrants();
    const sheet = createLayoutSheet("S");
    const blended = overlayItem(fx.ids);
    (blended.recipe as LayoutPlotRecipe).histOverlayMode = "blend";
    const older = { ...overlayItem(fx.ids), id: "b" };
    const odd = { ...overlayItem(fx.ids), id: "c" };
    (odd.recipe as unknown as { histOverlayMode: unknown }).histOverlayMode = "stacked";
    const biplot = { ...overlayItem(fx.ids), id: "d", recipe: { ...overlayItem(fx.ids).recipe, kind: "biplot", yChannel: "CD8", histOverlayMode: "blend" } as LayoutPlotRecipe };
    sheet.items = [blended, older, odd, biplot];
    const saved = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    const recipes = saved.sheets[0].items.map((item) => item.recipe as LayoutPlotRecipe);
    expect(recipes.map((recipe) => recipe.histOverlayMode)).toEqual(["blend", undefined, undefined, undefined]);
    expect(recipes.slice(1).every((recipe) => !("histOverlayMode" in recipe))).toBe(true);
    expect((cloneLayoutWorkspace(saved).sheets[0].items[0].recipe as LayoutPlotRecipe).histOverlayMode).toBe("blend");

    saved.sheets[0].items = [saved.sheets[0].items[0]];
    saved.sheets[0].iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const expected: Record<string, number[]> = { D1: [3, 1, 4, 0], D2: [1, 0, 2, 2] };
    for (const page of expandLayoutSheet(saved.sheets[0], UNITS)) {
      const recipe = page.items[0].recipe as LayoutPlotRecipe;
      expect(recipe.histOverlayMode).toBe("blend");
      const counts = recompute(FILES[recipe.sampleId], fx.state).populations;
      expect(recipe.populationIds!.map((id) => counts[id].event_count)).toEqual(expected[recipe.sampleId]);
    }
  });

  it("is titled by its populations' names and counts in the same order, and a plot of one population as before", () => {
    const fx = quadrants();
    const names = fx.ids.map((id) => fx.state.populations[id].name);
    const counts = recompute(FILES.D1, fx.state).populations;
    const recipe = overlayItem(fx.ids).recipe as LayoutPlotRecipe;
    const one = plotTitleContext(recipe, { name: "D1", fileName: "D1.fcs" }, { id: fx.ids[0], name: names[0] }, counts[fx.ids[0]].event_count ?? undefined);
    expect(plotTitle("{population}: {count} · {file}", one)).toBe("CD8 SP: 3 · D1.fcs");
    const overlay = { ...one, population: names.join(", "), counts: fx.ids.map((id) => counts[id].event_count ?? 0) };
    expect(plotTitle("{population}: {count} · {file}", overlay)).toBe("CD8 SP, DP, CD4 SP, DN: 3, 1, 4, 0 · D1.fcs");
  });
});
