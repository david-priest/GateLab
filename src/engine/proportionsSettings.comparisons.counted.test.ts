// Pairwise comparisons saved with a Plotting chart and with its Layout block, against a gate drawn
// and counted: the settings are kept on a reload, an older save without them loads with the
// overall test and every bracket, and the pairs compared are the gate's shares in the chart's
// model. Synthetic files, donors D1 to D3 in control, low and high; nothing here is a real
// experiment.

import { describe, expect, it } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation, type Population } from "./models";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { BASE_PROPORTIONS_SETTINGS, normalizeProportionsSettings, type ProportionsSettings } from "./proportionsSettings";
import { buildProportionsModel, defaultProportionsSettings, type ProportionsSampleRef } from "./proportionsModel";
import { computeBoxes, perUnitProps } from "./proportions";
import { pairwiseWilcoxon } from "./rankTests";
import { createLayoutSheet, normalizeLayoutWorkspace, type LayoutProportionsRecipe } from "./layout";

// Gate A holds FSC below 55, in raw units.
function tree() {
  const state = initialCoreState();
  const root = newRootPopulation();
  const gate = newGate("A", "rectangle", "FSC-A", "SSC-A", [[0, 0], [55, 1000]]);
  const a = newPopulation("A", [newGateRef(gate.gate_id)], root.population_id);
  root.children = [a.population_id];
  const populations: Record<string, Population> = { [root.population_id]: root, [a.population_id]: a };
  Object.assign(state, {
    gates: { [gate.gate_id]: gate },
    gate_order: [gate.gate_id],
    populations,
    root_population_id: root.population_id,
    active_population_id: root.population_id,
  });
  return { state: state as CoreState, a: a.population_id };
}

// Ten events a file, `inside` of them in A (FSC 10 to 28) and the rest outside it (FSC 60 to 78).
function file(id: string, inside: number): ProportionsSampleRef {
  const fsc = Array.from({ length: 10 }, (_, i) => (i < inside ? 10 + 2 * i : 60 + 2 * (i - inside)));
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: fsc.length,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from(fsc), Float32Array.from(fsc.map(() => 10))],
  };
  return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
}

const INSIDE: Record<string, Record<string, number>> = {
  D1: { control: 9, low: 5, high: 1 },
  D2: { control: 8, low: 6, high: 2 },
  D3: { control: 7, low: 4, high: 3 },
};
const CONDITIONS = ["control", "low", "high"];
const FILES = Object.keys(INSIDE).flatMap((donor) => CONDITIONS.map((condition) => file(`${donor}-${condition}`, INSIDE[donor][condition])));
const METADATA = Object.fromEntries(Object.keys(INSIDE).flatMap((donor) => CONDITIONS.map((condition) => [`${donor}-${condition}`, { donor, condition }])));

function fixture() {
  const fx = tree();
  const settings: ProportionsSettings = {
    ...defaultProportionsSettings(FILES, fx.state, []),
    selectedPops: [fx.a],
    groupSel: "condition",
    unitSel: "donor",
    plotType: "box",
    test: true,
    comparisons: "pairwise",
    comparisonsShow: "significant",
  };
  return { ...fx, settings };
}

describe("Pairwise comparisons, saved with a Plotting chart and its Layout block", () => {
  it("are the overall test and every bracket by default and for an older save; kept when saved; anything else is refused", () => {
    expect(BASE_PROPORTIONS_SETTINGS.comparisons).toBe("overall");
    expect(BASE_PROPORTIONS_SETTINGS.comparisonsShow).toBe("all");
    const { comparisons: _c, comparisonsShow: _s, ...older } = fixture().settings;
    void _c;
    void _s;
    const loaded = normalizeProportionsSettings(JSON.parse(JSON.stringify(older)));
    expect([loaded.comparisons, loaded.comparisonsShow]).toEqual(["overall", "all"]);
    const kept = normalizeProportionsSettings({ ...older, comparisons: "pairwise", comparisonsShow: "significant" });
    expect([kept.comparisons, kept.comparisonsShow]).toEqual(["pairwise", "significant"]);
    const refused = normalizeProportionsSettings({ ...older, comparisons: "all", comparisonsShow: true });
    expect([refused.comparisons, refused.comparisonsShow]).toEqual(["overall", "all"]);
  });

  it("keeps a block's settings over a save and reload, and compares the gate's counted shares", () => {
    const fx = fixture();
    const { comparisons: _c, comparisonsShow: _s, ...older } = fx.settings;
    void _c;
    void _s;
    const sheet = createLayoutSheet("S");
    sheet.items = [
      { id: "on", x: 57, y: 57, width: 300, height: 300, z: 0, recipe: { kind: "proportions", settings: fx.settings } },
      { id: "older", x: 57, y: 400, width: 300, height: 300, z: 1, recipe: { kind: "proportions", settings: older as ProportionsSettings } },
    ];
    const saved = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    const [on, old] = saved.sheets[0].items.map((item) => (item.recipe as LayoutProportionsRecipe).settings);
    expect([on.comparisons, on.comparisonsShow]).toEqual(["pairwise", "significant"]);
    expect(old).toEqual({ ...on, comparisons: "overall", comparisonsShow: "all" });

    // The gate counted in each file is the share the chart's boxes hold for each donor.
    const counted = FILES.map((entry) => recompute(entry.sample, fx.state).populations[fx.a].event_count);
    expect(counted).toEqual([9, 5, 1, 8, 6, 2, 7, 4, 3]);
    const model = buildProportionsModel(on, FILES, fx.state, METADATA, {});
    const boxes = computeBoxes(perUnitProps(model.perSample, model.catLevels.length, on.proportionValue), model.catLevels.length, false).filter((box) => box.cat === 0);
    const shares = CONDITIONS.map((condition) => boxes.find((box) => box.group === condition)!.values.map((v) => Math.round(v * 100)));
    expect(shares).toEqual([[90, 80, 70], [50, 60, 40], [10, 20, 30]]);
    // Three donors a group, every pair separated: U = 9 or 0, exact p = 2 / 20, Holm 3 × 0.1.
    const pairs = pairwiseWilcoxon(shares);
    expect(pairs.map((pair) => pair.p)).toEqual([0.1, 0.1, 0.1]);
    for (const pair of pairs) expect(pair.pAdjusted).toBeCloseTo(0.3, 12);
  });
});
