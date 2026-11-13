// A per-cell chart's split violin and ridgelines, saved with a Plotting chart and with its Layout
// block, against a gate drawn and counted: both plot types are kept on a reload, only a per-cell
// chart takes them, an older save loads as it was, and the cells each half or row draws are the
// gate's counts in its group's files. Synthetic files F1 to F3, groups control and treated;
// nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { BASE_PROPORTIONS_SETTINGS, consistentPlotType, normalizeProportionsSettings, PLOT_TYPES_BY_VALUE, type ProportionsSettings } from "./proportionsSettings";
import type { ProportionsSampleRef } from "./proportionsModel";
import { buildCellValuesModel } from "./cellValuesModel";
import { createLayoutSheet, normalizeLayoutWorkspace, type LayoutProportionsRecipe } from "./layout";

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
const cd4 = (fsc: number): Event => [HIGH, LOW, fsc];
const cd8 = (fsc: number): Event => [LOW, HIGH, fsc];
// CD4 SP forward scatter: control 50, 60, 70 (F1) and 100 (F2); treated 300, 320 (F3).
const FILES = [
  file("F1", [cd4(50), cd4(60), cd4(70), cd8(30)]),
  file("F2", [cd4(100), cd8(35), cd8(36)]),
  file("F3", [cd4(300), cd4(320), cd8(45)]),
];
const METADATA = {
  F1: { condition: "control" },
  F2: { condition: "control" },
  F3: { condition: "treated" },
};

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
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
  const settings: ProportionsSettings = {
    ...BASE_PROPORTIONS_SETTINGS,
    valueKind: "cells",
    plotType: "splitViolin",
    channel: "FSC-A",
    files: ["F1", "F2", "F3"],
    hierarchy: core.active_hierarchy_id,
    parent: core.root_population_id!,
    selectedPops: quadrants,
    groupSel: "condition",
    xAxis: "groups",
  };
  return { state: core, quadrants, settings };
}

describe("Split violin and ridgelines, saved with a Plotting chart and its Layout block", () => {
  it("are per-cell plot types only; an older save and any other kind load as before", () => {
    expect(PLOT_TYPES_BY_VALUE.cells).toEqual(["violin", "box", "splitViolin", "ridgeline"]);
    const { settings } = fixture();
    expect(normalizeProportionsSettings(settings).plotType).toBe("splitViolin");
    expect(normalizeProportionsSettings({ ...settings, plotType: "ridgeline" }).plotType).toBe("ridgeline");
    // An older per-cell chart, saved before the two types, keeps its violin or box.
    expect(normalizeProportionsSettings(JSON.parse(JSON.stringify({ ...settings, plotType: "violin" }))).plotType).toBe("violin");
    expect(normalizeProportionsSettings({ ...settings, plotType: "box" }).plotType).toBe("box");
    // A proportion or statistic chart cannot draw them, and takes its kind's first type.
    expect(consistentPlotType({ ...settings, valueKind: "proportion", plotType: "splitViolin" }).plotType).toBe("stacked");
    expect(consistentPlotType({ ...settings, valueKind: "statistic", plotType: "ridgeline" }).plotType).toBe("box");
    expect(normalizeProportionsSettings({ ...settings, valueKind: "proportion", plotType: "ridgeline" }).plotType).toBe("stacked");
    expect(normalizeProportionsSettings({ ...settings, plotType: "ridgelines" }).plotType).toBe("violin");
  });

  it("keeps a block's plot type over a save and reload, and each half's or row's cells are the gate's count in its group's files", () => {
    const fx = fixture();
    const ridge = { ...fx.settings, plotType: "ridgeline" as const };
    const older = { ...fx.settings, plotType: "violin" as const };
    const sheet = createLayoutSheet("S");
    sheet.items = [
      { id: "split", x: 57, y: 57, width: 300, height: 300, z: 0, recipe: { kind: "proportions", settings: fx.settings } },
      { id: "ridge", x: 57, y: 400, width: 300, height: 300, z: 1, recipe: { kind: "proportions", settings: ridge } },
      { id: "older", x: 400, y: 57, width: 300, height: 300, z: 2, recipe: { kind: "proportions", settings: older } },
    ];
    const saved = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    const [split, rows, old] = saved.sheets[0].items.map((item) => (item.recipe as LayoutProportionsRecipe).settings);
    expect(split.plotType).toBe("splitViolin");
    expect(rows.plotType).toBe("ridgeline");
    expect(old).toEqual({ ...split, plotType: "violin" });

    // The gate counted in each file: CD4 SP holds 3, 1 and 2 events.
    const counted = FILES.map((entry) => recompute(entry.sample, fx.state).populations[fx.quadrants[2]].event_count);
    expect(counted).toEqual([3, 1, 2]);
    // The cells each half (control left, treated right) or row draws: the group's files pooled.
    const model = buildCellValuesModel(split, FILES, fx.state, METADATA);
    const cd4 = model.violins.filter((v) => v.cat === 2).map((v) => ({ group: v.group, files: v.files, n: v.values.length }));
    expect(cd4).toEqual([
      { group: "control", files: ["F1.fcs", "F2.fcs"], n: counted[0]! + counted[1]! },
      { group: "treated", files: ["F3.fcs"], n: counted[2] },
    ]);
    expect(buildCellValuesModel(rows, FILES, fx.state, METADATA).violins.map((v) => v.values.length)).toEqual(model.violins.map((v) => v.values.length));
  });
});
