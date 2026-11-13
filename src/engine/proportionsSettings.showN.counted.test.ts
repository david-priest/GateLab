// "Show n" saved with a Plotting chart and with its Layout block, against a gate drawn and counted:
// the setting is kept on a reload and an older save without it loads with it off, and the cells a
// violin holds (the n it writes) are the gate's count. Synthetic files F1 and F2; nothing here is
// a real experiment.

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
// F1: CD8 SP 3, CD4 SP 4, DN 1. F2: CD8 SP 1, CD4 SP 2, DN 2.
const FILES = [
  file("F1", [[LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30], [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80], [LOW, LOW, 90]]),
  file("F2", [[LOW, HIGH, 15], [HIGH, LOW, 55], [HIGH, LOW, 65], [LOW, LOW, 90], [LOW, LOW, 100]]),
];

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
  // A per-cell chart of the quadrants' forward scatter, both files pooled in the group control.
  const settings: ProportionsSettings = {
    ...BASE_PROPORTIONS_SETTINGS,
    valueKind: "cells",
    plotType: "violin",
    channel: "FSC-A",
    files: ["F1", "F2"],
    hierarchy: core.active_hierarchy_id,
    parent: core.root_population_id!,
    selectedPops: quadrants,
    groupSel: "condition",
    xAxis: "populations",
    showN: true,
  };
  return { state: core, quadrants, settings };
}

describe("Show n, saved with a Plotting chart and its Layout block", () => {
  it("is off by default and off for an older save without it; kept when saved", () => {
    expect(BASE_PROPORTIONS_SETTINGS.showN).toBe(false);
    const { showN: _dropped, ...older } = fixture().settings;
    void _dropped;
    expect(normalizeProportionsSettings(JSON.parse(JSON.stringify(older))).showN).toBe(false);
    expect(normalizeProportionsSettings({ ...older, showN: true }).showN).toBe(true);
    expect(normalizeProportionsSettings({ ...older, showN: "yes" }).showN).toBe(false);
  });

  it("keeps a block's setting over a save and reload, and the n of each violin is the gate's count pooled over the files", () => {
    const fx = fixture();
    const { showN: _dropped, ...older } = fx.settings;
    void _dropped;
    const sheet = createLayoutSheet("S");
    sheet.items = [
      { id: "on", x: 57, y: 57, width: 300, height: 300, z: 0, recipe: { kind: "proportions", settings: fx.settings } },
      { id: "older", x: 57, y: 400, width: 300, height: 300, z: 1, recipe: { kind: "proportions", settings: older as ProportionsSettings } },
    ];
    const saved = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    const [on, old] = saved.sheets[0].items.map((item) => (item.recipe as LayoutProportionsRecipe).settings);
    expect(on.showN).toBe(true);
    expect(old.showN).toBe(false);
    expect(old).toEqual({ ...on, showN: false });

    const model = buildCellValuesModel(on, FILES, fx.state, { F1: { condition: "control" }, F2: { condition: "control" } });
    const counted = FILES.map((entry) => recompute(entry.sample, fx.state).populations);
    expect(counted.map((pops) => pops[fx.quadrants[2]].event_count)).toEqual([4, 2]);
    for (const violin of model.violins) {
      const total = counted.reduce((sum, pops) => sum + (pops[fx.quadrants[violin.cat]].event_count ?? 0), 0);
      expect(violin.values.length).toBe(total);
    }
    const cd4 = model.violins.find((v) => v.cat === 2)!;
    expect(cd4.values.length).toBe(6);
    expect(cd4.files).toEqual(["F1.fcs", "F2.fcs"]);
  });
});
