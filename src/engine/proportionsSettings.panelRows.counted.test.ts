// A Plotting chart's Rows shelf (`panelRows`) saved with the chart and with its Layout block,
// against a gate drawn and counted: the setting is kept on a reload, an older save without it
// loads with no rows, and the panels of the grid it makes hold the gate's counts. Synthetic files
// F1 to F3, donors D1 and D2 as the facet, groups control and treated; nothing here is a real
// experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { BASE_PROPORTIONS_SETTINGS, normalizeProportionsSettings, type ProportionsSettings } from "./proportionsSettings";
import { buildProportionsModel, type ProportionsSampleRef } from "./proportionsModel";
import { createLayoutSheet, normalizeLayoutWorkspace, type LayoutProportionsRecipe } from "./layout";

// Each event is [FITC-A (CD4), PE-A (CD8)]; the quadrant's centre is at 1000, 1000.
type Event = [number, number];
const LOW = 100;
const HIGH = 5000;
function file(id: string, events: Event[]): ProportionsSampleRef {
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
  return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
}
const cd4: Event = [HIGH, LOW];
const cd8: Event = [LOW, HIGH];
const FILES = [
  file("F1", [cd4, cd4, cd4, cd8]),
  file("F2", [cd4, cd8, cd8]),
  file("F3", [cd4, cd4, cd8, cd8]),
];
const METADATA = {
  F1: { condition: "control", donor: "D1" },
  F2: { condition: "treated", donor: "D1" },
  F3: { condition: "control", donor: "D2" },
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
    valueKind: "proportion",
    plotType: "box",
    files: ["F1", "F2", "F3"],
    hierarchy: core.active_hierarchy_id,
    parent: core.root_population_id!,
    selectedPops: [quadrants[0], quadrants[2]],
    includeUngated: false,
    groupSel: "condition",
    facetSel: "donor",
    panelColumns: "populations",
    panelRows: "facet",
  };
  return { state: core, quadrants, settings };
}

describe("The Rows shelf, saved with a Plotting chart and its Layout block", () => {
  it("is empty by default and for an older save without it; kept when saved; anything else is refused", () => {
    expect(BASE_PROPORTIONS_SETTINGS.panelRows).toBe("");
    const { panelRows: _dropped, ...older } = fixture().settings;
    void _dropped;
    expect(normalizeProportionsSettings(JSON.parse(JSON.stringify(older))).panelRows).toBe("");
    expect(normalizeProportionsSettings({ ...older, panelRows: "facet" }).panelRows).toBe("facet");
    expect(normalizeProportionsSettings({ ...older, panelRows: "rows" }).panelRows).toBe("");
    expect(normalizeProportionsSettings({ ...older, panelRows: 2 }).panelRows).toBe("");
  });

  it("keeps a block's rows over a save and reload, and each panel of the grid holds the gate's counts", () => {
    const fx = fixture();
    const { panelRows: _dropped, ...older } = fx.settings;
    void _dropped;
    const sheet = createLayoutSheet("S");
    sheet.items = [
      { id: "grid", x: 57, y: 57, width: 300, height: 300, z: 0, recipe: { kind: "proportions", settings: fx.settings } },
      { id: "older", x: 57, y: 400, width: 300, height: 300, z: 1, recipe: { kind: "proportions", settings: older as ProportionsSettings } },
    ];
    const saved = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    const [grid, old] = saved.sheets[0].items.map((item) => (item.recipe as LayoutProportionsRecipe).settings);
    expect(grid.panelRows).toBe("facet");
    expect(old.panelRows).toBe("");
    expect(old).toEqual({ ...grid, panelRows: "" });

    // The gate counted in each file: CD4 SP holds 3, 1 and 2 events; CD8 SP 1, 2 and 2.
    const counted = (q: number) => FILES.map((entry) => recompute(entry.sample, fx.state).populations[fx.quadrants[q]].event_count);
    expect(counted(2)).toEqual([3, 1, 2]);
    expect(counted(0)).toEqual([1, 2, 2]);
    // The grid's rows are the donors and its columns the populations: each panel's units are the
    // files of its donor, with the gate's counts.
    const model = buildProportionsModel(grid, FILES, fx.state, METADATA, {});
    const cd4 = model.catLevels.indexOf("CD4 SP");
    const cd8 = model.catLevels.indexOf("CD8 SP");
    const panel = (donor: string, cat: number) => model.perSample.filter((row) => row.facet === donor).map((row) => [row.group, row.catCounts[cat]]);
    expect(panel("D1", cd4)).toEqual([["control", 3], ["treated", 1]]);
    expect(panel("D2", cd4)).toEqual([["control", 2]]);
    expect(panel("D1", cd8)).toEqual([["control", 1], ["treated", 2]]);
    expect(panel("D2", cd8)).toEqual([["control", 2]]);
  });
});
