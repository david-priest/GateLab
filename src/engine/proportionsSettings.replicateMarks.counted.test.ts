// A per-cell chart's replicate marks saved with a Plotting chart and with its Layout block,
// against a gate drawn and counted: the setting is kept on a reload, an older save without it
// loads with no marks, and each replicate unit's cells (whose median or mean the mark is) are the
// gate's counts in the unit's files. Synthetic files F1 to F4, donors D1 and D2, groups control
// and treated; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { BASE_PROPORTIONS_SETTINGS, normalizeProportionsSettings, type ProportionsSettings } from "./proportionsSettings";
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
// CD4 SP forward scatter: D1 control 50, 60, 70 (F1) and 100 (F2); D2 control 200, 220 (F3);
// D1 treated 300, 320, 340 (F4).
const FILES = [
  file("F1", [cd4(50), cd4(60), cd4(70), cd8(30)]),
  file("F2", [cd4(100), cd8(35)]),
  file("F3", [cd4(200), cd4(220), cd8(40)]),
  file("F4", [cd4(300), cd4(320), cd4(340), cd8(45)]),
];
const METADATA = {
  F1: { condition: "control", donor: "D1" },
  F2: { condition: "control", donor: "D1" },
  F3: { condition: "control", donor: "D2" },
  F4: { condition: "treated", donor: "D1" },
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
    plotType: "violin",
    channel: "FSC-A",
    files: ["F1", "F2", "F3", "F4"],
    hierarchy: core.active_hierarchy_id,
    parent: core.root_population_id!,
    selectedPops: quadrants,
    groupSel: "condition",
    unitSel: "donor",
    xAxis: "groups",
    replicateMarks: "median",
  };
  return { state: core, quadrants, settings };
}

describe("Replicate marks, saved with a Plotting chart and its Layout block", () => {
  it("are off by default and for an older save without them; kept when saved; anything else is refused", () => {
    expect(BASE_PROPORTIONS_SETTINGS.replicateMarks).toBe("none");
    const { replicateMarks: _dropped, ...older } = fixture().settings;
    void _dropped;
    expect(normalizeProportionsSettings(JSON.parse(JSON.stringify(older))).replicateMarks).toBe("none");
    expect(normalizeProportionsSettings({ ...older, replicateMarks: "median" }).replicateMarks).toBe("median");
    expect(normalizeProportionsSettings({ ...older, replicateMarks: "mean" }).replicateMarks).toBe("mean");
    expect(normalizeProportionsSettings({ ...older, replicateMarks: "geomean" }).replicateMarks).toBe("none");
    expect(normalizeProportionsSettings({ ...older, replicateMarks: true }).replicateMarks).toBe("none");
  });

  it("keeps a block's setting over a save and reload, and each unit's cells are the gate's count in the unit's files", () => {
    const fx = fixture();
    const { replicateMarks: _dropped, ...older } = fx.settings;
    void _dropped;
    const sheet = createLayoutSheet("S");
    sheet.items = [
      { id: "on", x: 57, y: 57, width: 300, height: 300, z: 0, recipe: { kind: "proportions", settings: fx.settings } },
      { id: "older", x: 57, y: 400, width: 300, height: 300, z: 1, recipe: { kind: "proportions", settings: older as ProportionsSettings } },
    ];
    const saved = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    const [on, old] = saved.sheets[0].items.map((item) => (item.recipe as LayoutProportionsRecipe).settings);
    expect(on.replicateMarks).toBe("median");
    expect(old.replicateMarks).toBe("none");
    expect(old).toEqual({ ...on, replicateMarks: "none" });

    // The gate counted in each file: CD4 SP holds 3, 1, 2 and 3 events.
    const counted = FILES.map((entry) => recompute(entry.sample, fx.state).populations[fx.quadrants[2]].event_count);
    expect(counted).toEqual([3, 1, 2, 3]);
    // The units the marks are taken of: the chart's cells pooled by donor within each group, on linear values.
    const units = buildCellValuesModel(on, FILES, fx.state, METADATA, { poolBy: "unit", values: "raw" });
    const cd4Units = units.violins.filter((v) => v.cat === 2).map((v) => ({ group: v.group, unit: v.unit, files: v.files, values: Array.from(v.values) }));
    expect(cd4Units).toEqual([
      { group: "control", unit: "D1", files: ["F1.fcs", "F2.fcs"], values: [50, 60, 70, 100] },
      { group: "control", unit: "D2", files: ["F3.fcs"], values: [200, 220] },
      { group: "treated", unit: "D1", files: ["F4.fcs"], values: [300, 320, 340] },
    ]);
    expect(cd4Units.map((u) => u.values.length)).toEqual([counted[0]! + counted[1]!, counted[2], counted[3]]);
  });
});
