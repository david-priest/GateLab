// A Plotting chart of several channels (`channels`, with `channel` its first) and the channel a
// Layout block of one panel records, against a gate drawn and counted: both are kept on a reload,
// an older save with one channel loads as that channel alone, and each channel's cells of each
// population are the gate's counts. Synthetic files F1 to F3; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { BASE_PROPORTIONS_SETTINGS, normalizeProportionsSettings, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "./proportionsSettings";
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
// F1: CD8 SP 3, DP 1, CD4 SP 4, DN 0. F2: CD8 SP 1, CD4 SP 2, DN 2. F3: CD8 SP 2, CD4 SP 1.
const FILES = [
  file("F1", [[LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30], [HIGH, HIGH, 40], [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80]]),
  file("F2", [[LOW, HIGH, 15], [HIGH, LOW, 55], [HIGH, LOW, 65], [LOW, LOW, 90], [LOW, LOW, 100]]),
  file("F3", [[LOW, HIGH, 25], [LOW, HIGH, 35], [HIGH, LOW, 75]]),
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
  // A per-cell chart of the quadrants' forward scatter, a panel per file (each file its own group).
  const settings: ProportionsSettings = {
    ...BASE_PROPORTIONS_SETTINGS,
    valueKind: "cells",
    plotType: "violin",
    channel: "FSC-A",
    channels: ["FSC-A", "CD8"],
    panelColumns: "channels",
    files: ["F1", "F2", "F3"],
    hierarchy: core.active_hierarchy_id,
    parent: core.root_population_id!,
    selectedPops: quadrants,
    groupSel: PROPORTIONS_SAMPLE_FACTOR,
    xAxis: "populations",
  };
  return { state: core, quadrants, settings };
}

describe("Several channels, saved with a Plotting chart and the channel its Layout block draws", () => {
  it("reads the list with the channel first; an older save takes its one channel; anything else is refused", () => {
    expect(BASE_PROPORTIONS_SETTINGS.channels).toEqual([]);
    const { channels: _dropped, ...older } = fixture().settings;
    void _dropped;
    expect(normalizeProportionsSettings(JSON.parse(JSON.stringify(older))).channels).toEqual(["FSC-A"]);
    expect(normalizeProportionsSettings({ ...older, channel: "" }).channels).toEqual([]);
    const both = normalizeProportionsSettings({ ...older, channels: ["FSC-A", "CD8", "FSC-A", 3] });
    expect([both.channel, both.channels]).toEqual(["FSC-A", ["FSC-A", "CD8"]]);
    // A list that does not start with the channel the older reader draws is not taken.
    expect(normalizeProportionsSettings({ ...older, channels: ["CD8", "FSC-A"] }).channels).toEqual(["FSC-A"]);
    // A list without a channel names it.
    expect(normalizeProportionsSettings({ ...older, channel: "", channels: ["CD8"] }).channel).toBe("CD8");
    expect(normalizeProportionsSettings({ ...older, panelColumns: "channels", panelRows: "channels", pageBy: "channels" })).toMatchObject({ panelColumns: "channels", panelRows: "channels", pageBy: "channels" });
  });

  it("keeps a block's channel over a save and reload, an older block loads with its one channel, and each channel holds the gate's cells", () => {
    const fx = fixture();
    const { channels: _dropped, ...older } = fx.settings;
    void _dropped;
    const sheet = createLayoutSheet("S");
    sheet.items = [
      { id: "one", x: 57, y: 57, width: 300, height: 300, z: 0, recipe: { kind: "proportions", settings: fx.settings, panel: { channel: "CD8", group: "F2.fcs" } } },
      { id: "older", x: 400, y: 57, width: 300, height: 300, z: 1, recipe: { kind: "proportions", settings: { ...older, panelColumns: "" } as ProportionsSettings, panel: { group: "F2.fcs" } } },
    ];
    const saved = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    const [one, old] = saved.sheets[0].items.map((item) => item.recipe as LayoutProportionsRecipe);
    expect(one.panel).toEqual({ channel: "CD8", group: "F2.fcs" });
    expect(one.settings.channels).toEqual(["FSC-A", "CD8"]);
    expect(one.settings.panelColumns).toBe("channels");
    expect(old.panel).toEqual({ group: "F2.fcs" });
    expect(old.settings.channels).toEqual(["FSC-A"]);
    expect(old.settings.channel).toBe("FSC-A");

    // Each channel's model holds, for each file and population, the cells the gate counts there.
    for (const key of one.settings.channels) {
      const model = buildCellValuesModel({ ...one.settings, channel: key }, FILES, fx.state, {});
      expect(model.channelLabel).toContain(key);
      for (const entry of FILES) {
        const counts = recompute(entry.sample, fx.state).populations;
        for (const violin of model.violins.filter((v) => v.group === entry.name))
          expect(violin.values.length).toBe(counts[fx.quadrants[violin.cat]].event_count ?? 0);
      }
      // CD4 SP: F1 4, F2 2, F3 1, the same cells in either channel.
      expect(FILES.map((entry) => model.violins.find((v) => v.cat === 2 && v.group === entry.name)?.values.length ?? 0)).toEqual([4, 2, 1]);
    }
  });
});
