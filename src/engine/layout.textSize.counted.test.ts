// A Plotting block's text size and a sheet's legend font, saved and loaded: a block that takes the
// sheet's text sizes keeps the choice through save, load, copy and iteration, a block or style
// saved before the fields loads as it was, and the gate the block's chart counts still counts the
// same. Synthetic files D1 and D2, population CD4_positive; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { BASE_PROPORTIONS_SETTINGS, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "./proportionsSettings";
import type { ProportionsSampleRef } from "./proportionsModel";
import { buildCellValuesModel } from "./cellValuesModel";
import {
  cloneLayoutWorkspace,
  copyLayoutItems,
  createLayoutSheet,
  DEFAULT_LAYOUT_STYLE,
  effectiveLayoutStyle,
  normalizeLayoutWorkspace,
  type LayoutItem,
  type LayoutProportionsRecipe,
} from "./layout";
import { expandLayoutSheet } from "./layoutBatch";

// Each event is [FITC-A (CD4), FSC-A]; CD4_positive is FITC-A from 1000 (FSC-A is below 1000 throughout).
function file(id: string, events: [number, number][]): ProportionsSampleRef {
  const channels = [
    { index: 0, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
    { index: 1, name: "FSC-A", marker: null, bits: 32, range: 262144 },
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
// D1: 3 of 5 CD4_positive; D2: 1 of 3.
const FILES = [
  file("D1", [[5000, 10], [6000, 20], [7000, 30], [100, 40], [200, 50]]),
  file("D2", [[5000, 15], [100, 25], [200, 35]]),
];

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 5 });
  // A quadrant at CD4 1000, FSC-A 1000: every event is below 1000 in FSC-A, so CD4_positive is
  // the quadrant of high CD4 and low FSC-A.
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "FSC-A",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["Q1", "Q2", "CD4_positive", "Q4"],
  });
  const core = state as CoreState;
  const pop = Object.values(core.populations).find((p) => p.name === "CD4_positive")!;
  const settings: ProportionsSettings = {
    ...BASE_PROPORTIONS_SETTINGS,
    valueKind: "cells",
    plotType: "violin",
    channel: "FSC-A",
    files: ["D1", "D2"],
    hierarchy: core.active_hierarchy_id,
    parent: core.root_population_id!,
    selectedPops: [pop.population_id],
    groupSel: PROPORTIONS_SAMPLE_FACTOR,
    xAxis: "populations",
  };
  return { state: core, popId: pop.population_id, settings };
}

function block(settings: ProportionsSettings, extra: Partial<LayoutProportionsRecipe> = {}): LayoutItem {
  return { id: "p", x: 57, y: 57, width: 300, height: 300, z: 0, recipe: { kind: "proportions", settings, panel: {}, ...extra } };
}

const saveAndLoad = (sheet: ReturnType<typeof createLayoutSheet>) =>
  normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));

describe("A Plotting block's text size on a Layout sheet", () => {
  it("is saved and loaded with the sheet's legend font, and the block's chart counts its gate as the gate list does", () => {
    const fx = fixture();
    const gateCounted = FILES.map((f) => recompute(f.sample, fx.state).populations[fx.popId].event_count);
    expect(gateCounted).toEqual([3, 1]);

    const sheet = createLayoutSheet("S");
    sheet.style = { fontTick: 12, fontLegend: 14 };
    sheet.items = [block(fx.settings, { textSize: "sheet" })];
    const saved = saveAndLoad(sheet);
    const recipe = saved.sheets[0].items[0].recipe as LayoutProportionsRecipe;
    expect(recipe.textSize).toBe("sheet");
    expect(saved.sheets[0].style).toEqual({ fontTick: 12, fontLegend: 14 });
    expect(effectiveLayoutStyle(saved.sheets[0], recipe)).toMatchObject({ fontTick: 12, fontLegend: 14, fontAxis: DEFAULT_LAYOUT_STYLE.fontAxis });

    // The chart drawn from the loaded block holds each file's CD4_positive events.
    const model = buildCellValuesModel(recipe.settings, FILES, fx.state, {});
    expect(model.violins.map((violin) => violin.values.length)).toEqual(gateCounted);

    // Copied, cloned and drawn for each file of an iteration, it keeps its text size.
    expect(cloneLayoutWorkspace(saved).sheets[0].items[0].recipe).toMatchObject({ textSize: "sheet" });
    expect(copyLayoutItems(saved.sheets[0].items).copies[0].recipe).toMatchObject({ textSize: "sheet" });
    const iterated = { ...saved.sheets[0], items: [block(fx.settings, { textSize: "sheet", iterated: true })], iteration: { mode: "files" as const, source: { kind: "all" as const }, arrangement: { kind: "page-per-unit" as const } } };
    const pages = expandLayoutSheet(iterated, FILES.map((f) => ({ id: f.id, name: f.id, fileName: f.name })));
    expect(pages.map((page) => (page.items[0].recipe as LayoutProportionsRecipe).textSize)).toEqual(["sheet", "sheet"]);
    pages.forEach((page, i) => {
      const unitModel = buildCellValuesModel((page.items[0].recipe as LayoutProportionsRecipe).settings, FILES, fx.state, {});
      expect(unitModel.violins.map((violin) => violin.values.length)).toEqual([gateCounted[i]]);
    });
  });

  it("loads a block and a style saved before the fields as they were", () => {
    const fx = fixture();
    const sheet = createLayoutSheet("S");
    sheet.style = { fontTick: 12 };
    sheet.items = [block(fx.settings)];
    const saved = saveAndLoad(sheet);
    const recipe = saved.sheets[0].items[0].recipe as LayoutProportionsRecipe;
    expect(recipe).not.toHaveProperty("textSize");
    expect(saved.sheets[0].style).toEqual({ fontTick: 12 });
    // The legend font of a style saved before it is the Plotting tab's default.
    expect(effectiveLayoutStyle(saved.sheets[0], recipe).fontLegend).toBe(11);
    expect(DEFAULT_LAYOUT_STYLE.fontLegend).toBe(BASE_PROPORTIONS_SETTINGS.fontLegend);
    expect(buildCellValuesModel(recipe.settings, FILES, fx.state, {}).violins.map((violin) => violin.values.length)).toEqual([3, 1]);
  });

  it("drops a text size it does not know and keeps a legend font within its range", () => {
    const fx = fixture();
    const sheet = createLayoutSheet("S");
    sheet.style = { fontLegend: 400 } as never;
    sheet.items = [block(fx.settings, { textSize: "huge" } as never), { ...block(fx.settings, { textSize: "chart" }), id: "q" }];
    const saved = saveAndLoad(sheet);
    expect(saved.sheets[0].items[0].recipe).not.toHaveProperty("textSize");
    expect((saved.sheets[0].items[1].recipe as LayoutProportionsRecipe).textSize).toBe("chart");
    expect(saved.sheets[0].style).toEqual({ fontLegend: 40 });
  });
});
