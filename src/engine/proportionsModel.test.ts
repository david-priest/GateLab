// The Plotting chart's settings and model, as the tab and a Layout block share them.
// Synthetic samples D1 and D2 on one tree; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { newPopulation, newRootPopulation } from "./models";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { initialCoreState, type CoreState } from "../store";
import {
  buildProportionsModel,
  defaultProportionsParent,
  defaultProportionsSettings,
  proportionsCategoryColors,
  proportionsSelection,
  type ProportionsSampleRef,
} from "./proportionsModel";
import { BASE_PROPORTIONS_SETTINGS, normalizeProportionsSettings } from "./proportionsSettings";

function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const child = newPopulation("Lymphocytes", [], rootPop.population_id);
  rootPop.children = [child.population_id];
  Object.assign(state, {
    populations: { [rootPop.population_id]: rootPop, [child.population_id]: child },
    root_population_id: rootPop.population_id,
    active_population_id: rootPop.population_id,
  });
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: 4,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([10, 20, 30, 40]), Float32Array.from([40, 30, 20, 10])],
  };
  const files: ProportionsSampleRef[] = [
    { id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) },
    { id: "D2", name: "D2.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) },
  ];
  const metadata = { D1: { donor: "D1", day: "7" }, D2: { donor: "D2", day: "0" } };
  return { state: state as CoreState, files, metadata, rootId: rootPop.population_id, childId: child.population_id };
}

describe("proportions settings", () => {
  it("defaults to every file, the active tree, every population and the first metadata column", () => {
    const fx = fixture();
    const settings = defaultProportionsSettings(fx.files, fx.state, [{ name: "day" }, { name: "donor" }]);
    expect(settings).toMatchObject({
      files: ["D1", "D2"],
      hierarchy: DEFAULT_HIERARCHY_ID,
      parent: fx.rootId,
      selectedPops: [fx.childId],
      groupSel: "day",
      plotType: "stacked",
      height: 280,
    });
  });

  it("opens on the first population with two or more children, with its children ticked", () => {
    // All Events → Cells → Singlets → {CD4_positive, CD8_positive → {Naive, Memory}}
    const rootPop = newRootPopulation();
    const cells = newPopulation("Cells", [], rootPop.population_id);
    const singlets = newPopulation("Singlets", [], cells.population_id);
    const cd4 = newPopulation("CD4_positive", [], singlets.population_id);
    const cd8 = newPopulation("CD8_positive", [], singlets.population_id);
    const naive = newPopulation("Naive", [], cd8.population_id);
    const memory = newPopulation("Memory", [], cd8.population_id);
    rootPop.children = [cells.population_id];
    cells.children = [singlets.population_id];
    singlets.children = [cd4.population_id, cd8.population_id];
    cd8.children = [naive.population_id, memory.population_id];
    const populations = Object.fromEntries([rootPop, cells, singlets, cd4, cd8, naive, memory].map((pop) => [pop.population_id, pop]));
    const state = { ...initialCoreState(), populations, root_population_id: rootPop.population_id, active_population_id: rootPop.population_id } as CoreState;
    expect(defaultProportionsParent(populations, rootPop.population_id)).toBe(singlets.population_id);
    expect(defaultProportionsSettings([], state, [])).toMatchObject({
      parent: singlets.population_id,
      selectedPops: [cd4.population_id, cd8.population_id],
    });
    // A chain with no split opens on the root, with its one child ticked.
    singlets.children = [];
    expect(defaultProportionsParent(populations, rootPop.population_id)).toBe(rootPop.population_id);
    expect(defaultProportionsSettings([], state, []).selectedPops).toEqual([cells.population_id]);
  });

  it("keeps known fields within range over the defaults and drops the rest", () => {
    const settings = normalizeProportionsSettings(
      { files: ["D1"], plotType: "box", palette: "no-such-palette", height: 5000, pointRadius: "big", legend: false, extra: 1 },
      BASE_PROPORTIONS_SETTINGS,
    );
    expect(settings).toMatchObject({ files: ["D1"], plotType: "box", palette: "paired", height: 800, pointRadius: 2, legend: false });
    expect("extra" in settings).toBe(false);
    expect(normalizeProportionsSettings("nonsense")).toEqual(BASE_PROPORTIONS_SETTINGS);
  });

  it("reads a selection outside the parent's arm as the parent's children", () => {
    const fx = fixture();
    expect(proportionsSelection(fx.state.populations, fx.rootId, [fx.childId])).toEqual([fx.childId]);
    expect(proportionsSelection(fx.state.populations, fx.rootId, ["gone"])).toEqual([fx.childId]);
    expect(proportionsSelection(fx.state.populations, fx.rootId, [])).toEqual([]);
  });
});

describe("proportions model", () => {
  it("counts each file's events per selected population, grouped by metadata, with the rest as ungated", () => {
    const fx = fixture();
    const settings = { ...defaultProportionsSettings(fx.files, fx.state, [{ name: "day" }]), unitSel: "donor" };
    const model = buildProportionsModel(settings, fx.files, fx.state, fx.metadata, {});
    expect(model.catLevels).toEqual(["Lymphocytes", "ungated"]);
    expect(model.levels).toEqual([{ popId: fx.childId, depth: 1 }]);
    expect(model.excluded).toEqual([]);
    expect(model.perSample.map((row) => [row.group, row.unit, row.catCounts])).toEqual([
      ["7", "D1", [4, 0]],
      ["0", "D2", [4, 0]],
    ]);
    expect(proportionsCategoryColors(model, settings, fx.state.populations)).toHaveLength(2);
  });

  it("draws only the files chosen, and leaves ungated out when asked", () => {
    const fx = fixture();
    const settings = { ...defaultProportionsSettings(fx.files, fx.state, []), files: ["D2"], includeUngated: false };
    const model = buildProportionsModel(settings, fx.files, fx.state, fx.metadata, {});
    expect(model.catLevels).toEqual(["Lymphocytes"]);
    expect(model.perSample.map((row) => [row.group, row.catCounts])).toEqual([["D2.fcs", [4]]]);
  });

  it("is empty with no population selected, and falls back to populations without a division profile", () => {
    const fx = fixture();
    const none = buildProportionsModel({ ...defaultProportionsSettings(fx.files, fx.state, []), selectedPops: [] }, fx.files, fx.state, fx.metadata, {});
    expect(none.catLevels).toEqual([]);
    expect(none.perSample).toEqual([]);
    const division = buildProportionsModel({ ...defaultProportionsSettings(fx.files, fx.state, []), categoryKind: "division" }, fx.files, fx.state, fx.metadata, {});
    expect(division.catLevels).toEqual(["Lymphocytes", "ungated"]);
  });
});
