// A Plotting chart's panel as a Layout block: what is saved, and how it is drawn for each unit
// when the sheet iterates, against the gate list's counts. Synthetic files F1 to F3; nothing
// here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { BASE_PROPORTIONS_SETTINGS, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "./proportionsSettings";
import type { ProportionsSampleRef } from "./proportionsModel";
import { buildCellValuesModel } from "./cellValuesModel";
import { cloneLayoutWorkspace, createLayoutSheet, normalizeLayoutWorkspace, type LayoutItem, type LayoutProportionsRecipe } from "./layout";
import { expandLayoutSheet, type LayoutUnit } from "./layoutBatch";

// Each event is [FITC-A (CD4), PE-A (CD8), FSC-A]; the quadrant's centre is at 1000, 1000.
type Event = [number, number, number];
const LOW = 100;
const HIGH = 5000;
function file(id: string, events: Event[]): ProportionsSampleRef {
  const channels = [
    { index: 0, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
    { index: 1, name: "PE-A", marker: "CD8", bits: 32, range: 262144 },
    { index: 2, name: "FSC-A", marker: null, bits: 32, range: 262144 },
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
  return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
}
// F1: CD8 SP 3, DP 1, CD4 SP 4, DN 0. F2: CD8 SP 1, CD4 SP 2, DN 2. F3: CD8 SP 2, CD4 SP 1.
const FILES = [
  file("F1", [[LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30], [HIGH, HIGH, 40], [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80]]),
  file("F2", [[LOW, HIGH, 15], [HIGH, LOW, 55], [HIGH, LOW, 65], [LOW, LOW, 90], [LOW, LOW, 100]]),
  file("F3", [[LOW, HIGH, 25], [LOW, HIGH, 35], [HIGH, LOW, 75]]),
];
const UNITS: LayoutUnit[] = FILES.map((f) => ({ id: f.id, name: f.id, fileName: f.name }));

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 8 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "CD8",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["CD8 SP", "DP", "CD4 SP", "DN"],
  });
  const core = state as CoreState;
  const gate = Object.values(core.gates).find((g) => g.gate_type === "quadrant")!;
  const quadrants = [1, 2, 3, 4].map((q) =>
    Object.values(core.populations).find((p) => p.gate_refs.some((r) => r.gate_id === gate.gate_id && r.quadrant === q))!.population_id,
  );
  // A per-cell chart of the quadrants' forward scatter, a panel per file (each file its own group).
  const settings: ProportionsSettings = {
    ...BASE_PROPORTIONS_SETTINGS,
    valueKind: "cells",
    plotType: "violin",
    channel: "FSC-A",
    files: ["F1"],
    hierarchy: core.active_hierarchy_id,
    parent: core.root_population_id!,
    selectedPops: quadrants,
    groupSel: PROPORTIONS_SAMPLE_FACTOR,
    xAxis: "populations",
  };
  return { state: core, quadrants, settings };
}

function block(settings: ProportionsSettings, panel: LayoutProportionsRecipe["panel"], iterated: boolean): LayoutItem {
  return { id: "p", x: 57, y: 57, width: 300, height: 300, z: 0, recipe: { kind: "proportions", settings, panel, ...(iterated ? { iterated: true } : {}) } };
}

describe("A Plotting panel on a Layout sheet", () => {
  it("is drawn for each file of a file iteration, its cells as the gate list counts them", () => {
    const fx = fixture();
    const sheet = createLayoutSheet("S");
    sheet.items = [block(fx.settings, { group: "F1.fcs", population: "CD4 SP" }, true)];
    sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const saved = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    expect((saved.sheets[0].items[0].recipe as LayoutProportionsRecipe).panel).toEqual({ group: "F1.fcs", population: "CD4 SP" });
    expect(cloneLayoutWorkspace(saved).sheets[0].items[0].recipe).toMatchObject({ iterated: true, panel: { population: "CD4 SP" } });

    const pages = expandLayoutSheet(saved.sheets[0], UNITS);
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      const recipe = page.items[0].recipe as LayoutProportionsRecipe;
      // The unit's file makes the panel: the group no longer picks one, the population still does.
      expect(recipe.panel).toEqual({ population: "CD4 SP" });
      expect(recipe.settings.files).toEqual([page.units[0].id]);
      const model = buildCellValuesModel(recipe.settings, FILES, fx.state, {});
      const entry = FILES.find((f) => f.id === page.units[0].id)!;
      const counts = recompute(entry.sample, fx.state).populations;
      for (const violin of model.violins) {
        expect(violin.files).toEqual([entry.name]);
        expect(violin.values.length).toBe(counts[fx.quadrants[violin.cat]].event_count ?? 0);
      }
      expect(model.violins.find((v) => v.cat === 2)!.values.length).toBe({ F1: 4, F2: 2, F3: 1 }[entry.id]);
    }
  });

  it("stays as added when it does not follow, and keeps a legend block whole", () => {
    const fx = fixture();
    const sheet = createLayoutSheet("S");
    sheet.items = [block(fx.settings, { group: "F1.fcs" }, false), { ...block(fx.settings, { legend: true }, true), id: "l" }];
    sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const pages = expandLayoutSheet(sheet, UNITS);
    for (const page of pages) {
      const [fixed, legend] = page.items.map((item) => item.recipe as LayoutProportionsRecipe);
      expect(fixed.settings.files).toEqual(["F1"]);
      expect(fixed.panel).toEqual({ group: "F1.fcs" });
      expect(legend.panel).toEqual({ legend: true });
      expect(legend.settings.files).toEqual([page.units[0].id]);
    }
  });

  it("saves a panel's text fields and the legend, and nothing else", () => {
    const fx = fixture();
    const sheet = createLayoutSheet("S");
    sheet.items = [block(fx.settings, { facet: 3, other: "x" } as never, false)];
    const saved = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    expect((saved.sheets[0].items[0].recipe as LayoutProportionsRecipe).panel).toBeUndefined();
  });
});

function plot(id: string, kind: "biplot" | "histogram", populationId: string, iterated?: boolean): LayoutItem {
  return {
    id, x: 400, y: 57, width: 200, height: 200, z: 1,
    recipe: { kind, sampleId: "F1", populationId, xChannel: "CD4", yChannel: kind === "biplot" ? "CD8" : null, displayMode: "pseudocolor", ...(iterated === undefined ? {} : { iterated }) },
  };
}
function reopen(sheet: ReturnType<typeof createLayoutSheet>) {
  return normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] }))).sheets[0];
}

describe("A Plotting panel on a sheet saved and opened again", () => {
  it("keeps the plots left fixed fixed when only Plotting panels follow the file iteration", () => {
    const fx = fixture();
    const sheet = createLayoutSheet("S");
    sheet.items = [
      block(fx.settings, { population: "CD4 SP" }, true),
      { ...block(fx.settings, { legend: true }, true), id: "l" },
      plot("b", "biplot", fx.quadrants[2]),
      plot("h", "histogram", fx.quadrants[2]),
    ];
    sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const loaded = reopen(sheet);
    const byId = Object.fromEntries(loaded.items.map((item) => [item.id, item.recipe]));
    expect(byId.b).not.toHaveProperty("iterated");
    expect(byId.h).not.toHaveProperty("iterated");
    expect(byId.p).toMatchObject({ iterated: true });
    expect(byId.l).toMatchObject({ iterated: true });

    // Every page draws the fixed plots from F1, the population counted on F1; the panel from the page's file.
    const f1 = recompute(FILES[0].sample, fx.state).populations[fx.quadrants[2]].event_count;
    expect(f1).toBe(4);
    for (const page of expandLayoutSheet(loaded, UNITS)) {
      const recipes = Object.fromEntries(page.items.map((item) => [item.templateId, item.recipe]));
      expect(recipes.b).toMatchObject({ sampleId: "F1", populationId: fx.quadrants[2] });
      expect(recipes.h).toMatchObject({ sampleId: "F1", populationId: fx.quadrants[2] });
      const panel = recipes.p as LayoutProportionsRecipe;
      const model = buildCellValuesModel(panel.settings, FILES, fx.state, {});
      expect(model.violins.find((v) => v.cat === 2)!.values.length).toBe({ F1: 4, F2: 2, F3: 1 }[page.units[0].id]);
    }
  });

  it("still makes the plots of a sheet saved before items followed one follow its iteration", () => {
    const fx = fixture();
    const sheet = createLayoutSheet("S");
    sheet.items = [plot("b", "biplot", fx.quadrants[2]), plot("h", "histogram", fx.quadrants[2]), block(fx.settings, { population: "CD4 SP" }, false)];
    sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const loaded = reopen(sheet);
    const byId = Object.fromEntries(loaded.items.map((item) => [item.id, item.recipe]));
    expect(byId.b).toMatchObject({ iterated: true });
    expect(byId.h).toMatchObject({ iterated: true });
    expect(byId.p).not.toHaveProperty("iterated");
    const pages = expandLayoutSheet(loaded, UNITS);
    expect(pages.map((page) => (page.items.find((item) => item.templateId === "b")!.recipe as { sampleId: string }).sampleId)).toEqual(["F1", "F2", "F3"]);
  });

  it("keeps a block of the one panel of a chart without facets as a panel block", () => {
    const fx = fixture();
    const stacked: ProportionsSettings = { ...fx.settings, valueKind: "proportion", plotType: "stacked", groupSel: "", files: ["F1", "F2", "F3"] };
    const sheet = createLayoutSheet("S");
    sheet.items = [block(stacked, {}, false)];
    const loaded = reopen(sheet);
    expect((loaded.items[0].recipe as LayoutProportionsRecipe).panel).toEqual({});
    expect((cloneLayoutWorkspace({ version: 2, activeSheetId: loaded.id, sheets: [loaded] } as never).sheets[0].items[0].recipe as LayoutProportionsRecipe).panel).toEqual({});
    // An older save without a panel stays the whole chart.
    sheet.items = [{ ...block(stacked, undefined, false) }];
    expect((reopen(sheet).items[0].recipe as LayoutProportionsRecipe).panel).toBeUndefined();
  });

  it("saves the panel's population id with its text, and opens a block saved without one", () => {
    const fx = fixture();
    const sheet = createLayoutSheet("S");
    sheet.items = [block(fx.settings, { group: "F1.fcs", population: "CD4 SP", populationId: fx.quadrants[2] }, true)];
    sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const loaded = reopen(sheet);
    expect((loaded.items[0].recipe as LayoutProportionsRecipe).panel).toEqual({ group: "F1.fcs", population: "CD4 SP", populationId: fx.quadrants[2] });
    for (const page of expandLayoutSheet(loaded, UNITS)) {
      const recipe = page.items[0].recipe as LayoutProportionsRecipe;
      expect(recipe.panel).toEqual({ population: "CD4 SP", populationId: fx.quadrants[2] });
      const model = buildCellValuesModel(recipe.settings, FILES, fx.state, {});
      const cat = model.levels.findIndex((level) => level.popId === fx.quadrants[2]);
      expect(model.violins.find((v) => v.cat === cat)!.values.length).toBe({ F1: 4, F2: 2, F3: 1 }[page.units[0].id]);
    }
    sheet.items = [block(fx.settings, { population: "CD4 SP", populationId: 7 } as never, false)];
    expect((reopen(sheet).items[0].recipe as LayoutProportionsRecipe).panel).toEqual({ population: "CD4 SP" });
  });
});
