// The order files and a metadata column's values are drawn in, against the gate list's counts: the
// file list's order, a column's own order of its levels (the workspace's) before it, and a chart
// or Layout block that carries no order of its own. Synthetic files D1 to D3, groups control and
// treated; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { columnValueOrder, fileListOrder } from "./levelOrder";
import { BASE_PROPORTIONS_SETTINGS, normalizeProportionsSettings, type ProportionsSettings } from "./proportionsSettings";
import { facetValues } from "./sampleFacets";
import { buildProportionsModel, type ProportionsSampleRef } from "./proportionsModel";
import { buildCellValuesModel } from "./cellValuesModel";
import { cloneLayoutWorkspace, createLayoutSheet, normalizeLayoutWorkspace, type LayoutProportionsRecipe } from "./layout";
import { expandLayoutSheet, type LayoutUnit } from "./layoutBatch";

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
// Listed D3, D1, D2: the file list's order is not the files' alphabetical order.
// D3: CD4 SP 1 of 3. D1: CD4 SP 4 of 8. D2: CD4 SP 2 of 5.
const FILES = [
  file("D3", [[LOW, HIGH, 25], [LOW, HIGH, 35], [HIGH, LOW, 75]]),
  file("D1", [[LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30], [HIGH, HIGH, 40], [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80]]),
  file("D2", [[LOW, HIGH, 15], [HIGH, LOW, 55], [HIGH, LOW, 65], [LOW, LOW, 90], [LOW, LOW, 100]]),
];
const METADATA = { D1: { condition: "control" }, D2: { condition: "treated" }, D3: { condition: "treated" } };

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
  const settings: ProportionsSettings = {
    ...BASE_PROPORTIONS_SETTINGS,
    files: ["D1", "D2", "D3"],
    hierarchy: core.active_hierarchy_id,
    parent: core.root_population_id!,
    selectedPops: quadrants,
    includeUngated: false,
    groupSel: "condition",
    unitSel: "__sample__",
  };
  return { state: core, quadrants, settings };
}

describe("levelOrder", () => {
  it("orders files as the file list does, and a column's values by its levels, else at their first file", () => {
    expect(fileListOrder(FILES, ["D2", "D3", "D1"]).map((f) => f.id)).toEqual(["D3", "D1", "D2"]);
    const conditions = FILES.map((f) => METADATA[f.id as keyof typeof METADATA].condition);
    expect(columnValueOrder(conditions)).toEqual(["treated", "control"]);
    expect(columnValueOrder(conditions, ["control", "treated"])).toEqual(["control", "treated"]);
    // A level no file carries is dropped; a value the levels do not name follows.
    expect(columnValueOrder(["control", "treated", "(NA)"], ["treated", "gone"])).toEqual(["treated", "control", "(NA)"]);
    expect(columnValueOrder(["b", "a", "b"], [])).toEqual(["b", "a"]);
  });

  it("gives the file list's chips the same order as the charts", () => {
    const metadata = Object.fromEntries(FILES.map((f) => [f.id, METADATA[f.id as keyof typeof METADATA]]));
    expect(facetValues(metadata, { name: "condition" }).map((v) => v.value)).toEqual(["treated", "control"]);
    expect(facetValues(metadata, { name: "condition", levels: ["control", "treated"] }).map((v) => v.value)).toEqual(["control", "treated"]);
  });
});

describe("A Plotting chart's files and groups, against the gate list", () => {
  it("counts each file in the file list's order, whatever order the settings name them in", () => {
    const fx = fixture();
    const model = buildProportionsModel({ ...fx.settings, files: ["D2", "D1", "D3"] }, FILES, fx.state, METADATA, {});
    expect(model.perSample.map((row) => row.unit)).toEqual(["D3", "D1", "D2"]);
    for (const row of model.perSample) {
      const counts = recompute(FILES.find((f) => f.id === row.unit)!.sample, fx.state).populations;
      expect(row.catCounts[2]).toBe(counts[fx.quadrants[2]].event_count);
    }
    expect(model.perSample.map((row) => row.catCounts[2])).toEqual([1, 4, 2]);
    const cells = buildCellValuesModel({ ...fx.settings, valueKind: "cells", plotType: "violin", channel: "FSC-A", groupSel: "__sample__" }, FILES, fx.state, METADATA);
    expect(columnValueOrder(cells.violins.map((v) => v.group))).toEqual(["D3.fcs", "D1.fcs", "D2.fcs"]);
    expect(cells.violins.filter((v) => v.cat === 2).map((v) => v.values.length)).toEqual([1, 4, 2]);
  });

  it("loads a chart saved with an order of its own, ignoring it, and draws it for each file of an iteration", () => {
    const fx = fixture();
    const saved = { ...fx.settings, levelOrder: { condition: ["treated", "control"] } };
    expect("levelOrder" in normalizeProportionsSettings(JSON.parse(JSON.stringify(saved)))).toBe(false);
    const sheet = createLayoutSheet("S");
    sheet.items = [{ id: "p", x: 57, y: 57, width: 300, height: 300, z: 0, recipe: { kind: "proportions", settings: saved as ProportionsSettings, iterated: true } }];
    sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const workspace = normalizeLayoutWorkspace(JSON.parse(JSON.stringify({ version: 2, activeSheetId: sheet.id, sheets: [sheet] })));
    const block = workspace.sheets[0].items[0].recipe as LayoutProportionsRecipe;
    expect("levelOrder" in block.settings).toBe(false);
    expect(block.settings.groupSel).toBe("condition");
    expect("levelOrder" in (cloneLayoutWorkspace(workspace).sheets[0].items[0].recipe as LayoutProportionsRecipe).settings).toBe(false);

    const units: LayoutUnit[] = FILES.map((f) => ({ id: f.id, name: f.id, fileName: f.name }));
    const pages = expandLayoutSheet(workspace.sheets[0], units);
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      const recipe = page.items[0].recipe as LayoutProportionsRecipe;
      expect(recipe.settings.files).toEqual([page.units[0].id]);
      const model = buildProportionsModel(recipe.settings, FILES, fx.state, METADATA, {});
      const entry = FILES.find((f) => f.id === page.units[0].id)!;
      expect(model.perSample).toHaveLength(1);
      expect(model.perSample[0].catCounts[2]).toBe(recompute(entry.sample, fx.state).populations[fx.quadrants[2]].event_count);
    }
  });
});
