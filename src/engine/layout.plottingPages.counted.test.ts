// A Plotting chart's Pages shelf (`pageBy`) and the page a Layout block records in its panel
// selector, against a gate drawn and counted: both are kept on a reload, an older save without
// them loads as one page drawing the whole chart, and each page holds the gate's counts of its
// files. Synthetic files F1 to F3, donors D1 and D2 as the facet, groups control and treated;
// nothing here is a real experiment.

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
    pageBy: "facet",
  };
  return { state: core, quadrants, settings };
}

describe("Pages, saved with a Plotting chart and the page its Layout block draws", () => {
  it("is empty by default and for an older save without it; kept when saved; anything else is refused", () => {
    expect(BASE_PROPORTIONS_SETTINGS.pageBy).toBe("");
    const { pageBy: _dropped, ...older } = fixture().settings;
    void _dropped;
    expect(normalizeProportionsSettings(JSON.parse(JSON.stringify(older))).pageBy).toBe("");
    expect(normalizeProportionsSettings({ ...older, pageBy: "facet" }).pageBy).toBe("facet");
    expect(normalizeProportionsSettings({ ...older, pageBy: "pages" }).pageBy).toBe("");
    expect(normalizeProportionsSettings({ ...older, pageBy: 2 }).pageBy).toBe("");
  });

  it("keeps a block's page over a save and reload, an older block loads unchanged, and each page holds the gate's counts", () => {
    const fx = fixture();
    const { pageBy: _dropped, ...older } = fx.settings;
    void _dropped;
    const sheet = createLayoutSheet("S");
    sheet.items = [
      { id: "page", x: 57, y: 57, width: 300, height: 300, z: 0, recipe: { kind: "proportions", settings: fx.settings, panel: { page: "D2" } } },
      { id: "panel", x: 57, y: 400, width: 300, height: 300, z: 1, recipe: { kind: "proportions", settings: fx.settings, panel: { facet: "D1", population: "CD4 SP" } } },
      { id: "older", x: 400, y: 57, width: 300, height: 300, z: 2, recipe: { kind: "proportions", settings: older as ProportionsSettings } },
    ];
    const saved = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    const [page, panel, old] = saved.sheets[0].items.map((item) => item.recipe as LayoutProportionsRecipe);
    expect(page.panel).toEqual({ page: "D2" });
    expect(page.settings.pageBy).toBe("facet");
    expect(panel.panel).toEqual({ facet: "D1", population: "CD4 SP" });
    expect(old.panel).toBeUndefined();
    expect(old.settings.pageBy).toBe("");
    expect(old.settings).toEqual({ ...page.settings, pageBy: "" });
    // A selector field that is not text is dropped; the page alone stays.
    const odd = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [{ ...sheet, items: [{ ...sheet.items[0], recipe: { ...sheet.items[0].recipe, panel: { page: "D2", facet: 3 } } }] }] })));
    expect((odd.sheets[0].items[0].recipe as LayoutProportionsRecipe).panel).toEqual({ page: "D2" });

    // The gate counted in each file: CD4 SP holds 3, 1 and 2 events; CD8 SP 1, 2 and 2.
    const counted = (q: number) => FILES.map((entry) => recompute(entry.sample, fx.state).populations[fx.quadrants[q]].event_count);
    expect(counted(2)).toEqual([3, 1, 2]);
    expect(counted(0)).toEqual([1, 2, 2]);
    // A page per donor: the D2 page's units are F3 alone, the D1 page's F1 and F2, with the gate's counts.
    const model = buildProportionsModel(page.settings, FILES, fx.state, METADATA, {});
    const cd4 = model.catLevels.indexOf("CD4 SP");
    const cd8 = model.catLevels.indexOf("CD8 SP");
    const onPage = (donor: string, cat: number) => model.perSample.filter((row) => row.facet === donor).map((row) => [row.group, row.catCounts[cat]]);
    expect(onPage("D2", cd4)).toEqual([["control", 2]]);
    expect(onPage("D2", cd8)).toEqual([["control", 2]]);
    expect(onPage("D1", cd4)).toEqual([["control", 3], ["treated", 1]]);
    expect(onPage("D1", cd8)).toEqual([["control", 1], ["treated", 2]]);
  });
});
