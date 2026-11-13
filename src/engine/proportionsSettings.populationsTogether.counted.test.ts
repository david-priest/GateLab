// "Populations side by side in one panel" saved with a Plotting chart and with its Layout block,
// against a gate drawn and counted: the setting is kept on a reload, an older save without it
// loads without it, and the cells each violin holds are the gate's count whether it is set or not.
// Synthetic files D1 and D2 in groups control and treated; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { BASE_PROPORTIONS_SETTINGS, figureChartOwnSettings, normalizeProportionsSettings, type ProportionsSettings } from "./proportionsSettings";
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
// D1: CD8_positive 3, CD4_positive 4, DN 1. D2: CD8_positive 1, CD4_positive 2, DN 2.
const FILES = [
  file("D1", [[LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30], [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80], [LOW, LOW, 90]]),
  file("D2", [[LOW, HIGH, 15], [HIGH, LOW, 55], [HIGH, LOW, 65], [LOW, LOW, 90], [LOW, LOW, 100]]),
];

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 8 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "CD8",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["CD8_positive", "DP", "CD4_positive", "DN"],
  });
  const core = state as CoreState;
  const gate = Object.values(core.gates).find((g) => g.gate_type === "quadrant")!;
  const quadrants = [1, 2, 3, 4].map((q) =>
    Object.values(core.populations).find((p) => p.gate_refs.some((r) => r.gate_id === gate.gate_id && r.quadrant === q))!.population_id,
  );
  // A per-cell chart of the CD8_positive and CD4_positive cells' forward scatter, the groups along x.
  const settings: ProportionsSettings = {
    ...BASE_PROPORTIONS_SETTINGS,
    valueKind: "cells",
    plotType: "violin",
    channel: "FSC-A",
    files: ["D1", "D2"],
    hierarchy: core.active_hierarchy_id,
    parent: core.root_population_id!,
    selectedPops: [quadrants[0], quadrants[2]],
    groupSel: "condition",
    xAxis: "groups",
    populationsTogether: true,
  };
  return { state: core, quadrants, settings };
}

describe("Populations side by side in one panel, saved with a Plotting chart and its Layout block", () => {
  it("is absent by default and for an older save without it; kept when saved as true only", () => {
    expect("populationsTogether" in BASE_PROPORTIONS_SETTINGS).toBe(false);
    const { populationsTogether: _dropped, ...older } = fixture().settings;
    void _dropped;
    expect("populationsTogether" in normalizeProportionsSettings(JSON.parse(JSON.stringify(older)))).toBe(false);
    expect(normalizeProportionsSettings({ ...older, populationsTogether: true }).populationsTogether).toBe(true);
    expect("populationsTogether" in normalizeProportionsSettings({ ...older, populationsTogether: false })).toBe(false);
    expect("populationsTogether" in normalizeProportionsSettings({ ...older, populationsTogether: "yes" })).toBe(false);
    expect(figureChartOwnSettings({ populationsTogether: true })).toEqual({ populationsTogether: true });
    expect(figureChartOwnSettings({ populationsTogether: false })).toEqual({});
  });

  it("keeps a block's setting over a save and reload, and each violin holds the gate's count with it and without it", () => {
    const fx = fixture();
    const { populationsTogether: _dropped, ...older } = fx.settings;
    void _dropped;
    const sheet = createLayoutSheet("S");
    sheet.items = [
      { id: "on", x: 57, y: 57, width: 300, height: 300, z: 0, recipe: { kind: "proportions", settings: fx.settings } },
      { id: "older", x: 57, y: 400, width: 300, height: 300, z: 1, recipe: { kind: "proportions", settings: older as ProportionsSettings } },
    ];
    const saved = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    const [on, old] = saved.sheets[0].items.map((item) => (item.recipe as LayoutProportionsRecipe).settings);
    expect(on.populationsTogether).toBe(true);
    expect("populationsTogether" in old).toBe(false);
    expect({ ...old, populationsTogether: true }).toEqual(on);

    const metadata = { D1: { condition: "control" }, D2: { condition: "treated" } };
    const counted = FILES.map((entry) => [fx.quadrants[0], fx.quadrants[2]].map((id) => recompute(entry.sample, fx.state).populations[id].event_count));
    expect(counted).toEqual([[3, 4], [1, 2]]);
    const sizes: number[][] = [];
    for (const settings of [on, old]) {
      const model = buildCellValuesModel(settings, FILES, fx.state, metadata);
      sizes.push(model.violins.map((violin) => violin.values.length).sort((a, b) => a - b));
    }
    expect(sizes[0]).toEqual([1, 2, 3, 4]);
    expect(sizes[1]).toEqual(sizes[0]);
  });
});
