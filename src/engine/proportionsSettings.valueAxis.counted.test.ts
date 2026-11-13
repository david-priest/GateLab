// A Plotting chart's value-axis settings (limits, start at zero, one axis over the panels) saved
// with a Layout block and opened again, and a block saved before them opening with the defaults;
// the block's cells as the gate list counts them either way. Synthetic files F1 and F2; nothing
// here is a real experiment.

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
// F1: CD8 SP 3, DP 1, CD4 SP 4. F2: CD8 SP 1, CD4 SP 2, DN 2.
const FILES = [
  file("F1", [[LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30], [HIGH, HIGH, 40], [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80]]),
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
  // A statistic of the quadrants' forward scatter, a point per file.
  const settings: ProportionsSettings = {
    ...BASE_PROPORTIONS_SETTINGS,
    valueKind: "statistic",
    plotType: "box",
    channel: "FSC-A",
    files: ["F1", "F2"],
    hierarchy: core.active_hierarchy_id,
    parent: core.root_population_id!,
    selectedPops: quadrants,
    groupSel: PROPORTIONS_SAMPLE_FACTOR,
    xAxis: "groups",
  };
  return { state: core, quadrants, settings };
}

function reopen(settings: unknown) {
  const sheet = createLayoutSheet("S");
  sheet.items = [{ id: "p", x: 57, y: 57, width: 300, height: 300, z: 0, recipe: { kind: "proportions", settings } as LayoutProportionsRecipe }];
  const saved = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
  return (saved.sheets[0].items[0].recipe as LayoutProportionsRecipe).settings;
}

/** Each file's cells of CD4 SP in the block's model, against the gate list's count. */
function expectCounted(settings: ProportionsSettings, fx: ReturnType<typeof fixture>) {
  const model = buildCellValuesModel(settings, FILES, fx.state, {}, { poolBy: "unit", values: "raw" });
  for (const entry of FILES) {
    const count = recompute(entry.sample, fx.state).populations[fx.quadrants[2]].event_count;
    const violin = model.violins.find((v) => v.cat === 2 && v.files.includes(entry.name))!;
    expect(violin.values.length).toBe(count);
  }
  expect(model.violins.filter((v) => v.cat === 2).map((v) => v.values.length)).toEqual([4, 2]);
}

describe("A Plotting block's value-axis settings", () => {
  it("are saved with the block and opened again as they were", () => {
    const fx = fixture();
    const settings = { ...fx.settings, valueMin: 12.5, valueMax: 80, valueFromZero: false, shareValueAxis: true };
    const loaded = reopen(settings);
    expect(loaded).toMatchObject({ valueMin: 12.5, valueMax: 80, valueFromZero: false, shareValueAxis: true });
    expectCounted(loaded, fx);
    // Automatic limits and the chart kind's own sharing are kept as such.
    expect(reopen({ ...settings, valueMin: null, shareValueAxis: null })).toMatchObject({ valueMin: null, valueMax: 80, shareValueAxis: null });
  });

  it("open with the defaults from a block saved before them, and drop what is not a setting", () => {
    const fx = fixture();
    const older: Record<string, unknown> = { ...fx.settings };
    for (const key of ["valueMin", "valueMax", "valueFromZero", "shareValueAxis"]) delete older[key];
    const loaded = reopen(older);
    expect(loaded).toMatchObject({ valueMin: null, valueMax: null, valueFromZero: true, shareValueAxis: null });
    expectCounted(loaded, fx);
    expect(normalizeProportionsSettings({ valueMin: "10", valueMax: Infinity, valueFromZero: 0, shareValueAxis: "yes" })).toMatchObject({
      valueMin: null,
      valueMax: null,
      valueFromZero: true,
      shareValueAxis: null,
    });
  });
});
