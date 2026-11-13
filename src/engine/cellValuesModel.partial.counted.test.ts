// The per-cell model where a file's tree lacks a selected population: the file is kept for the
// populations it has, and named in `partial`. Gates drawn through the store and counted by the
// gate list. Synthetic files D1, D2 and D3; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { BASE_PROPORTIONS_SETTINGS, normalizeProportionsSettings, type ProportionsSettings } from "./proportionsSettings";
import { buildCellValuesModel, type CellValuesModel } from "./cellValuesModel";
import type { FilePopulations } from "./proportionsModel";
import { D3_TREE, PARTIAL_METADATA, partialWorkspace, type PartialPopulation } from "./partialPopulations.fixture";

type Workspace = ReturnType<typeof partialWorkspace>;

function settings(ws: Workspace, over: Partial<ProportionsSettings>): ProportionsSettings {
  return normalizeProportionsSettings({
    ...BASE_PROPORTIONS_SETTINGS, valueKind: "cells", plotType: "violin", channel: "FSC-A",
    files: ["D1", "D2", "D3"], hierarchy: ws.core.active_hierarchy_id, parent: ws.main("All Events"), groupSel: "condition",
    ...over,
  });
}

/** Each violin as [population, group, files, cells]. */
const violins = (model: CellValuesModel) => model.violins.map((v) => [model.catLevels[v.cat], v.group, v.files, [...v.values]]);

describe("Per-cell values where a file's tree lacks a selected population", () => {
  it("counts what the fixture's comment says, each file in its own tree", () => {
    const ws = partialWorkspace();
    const names: PartialPopulation[] = ["CD8_positive", "double_positive", "CD4_positive", "double_negative", "FSC_high", "FSC_low", "FSC_top"];
    expect(["D1", "D2", "D3"].map((id) => names.map((name) => ws.counted(id, name)))).toEqual([
      [3, 1, 4, 0, 2, 2, 1],
      [1, 0, 2, 2, 1, 1, 0],
      [2, 0, 1, 0, undefined, undefined, undefined],
    ]);
  });

  it("keeps the file for the populations it has, and names it in partial", () => {
    const ws = partialWorkspace();
    const model = buildCellValuesModel(settings(ws, { selectedPops: [ws.main("double_positive"), ws.main("FSC_high")] }), ws.files, ws.core, PARTIAL_METADATA);
    expect(model.catLevels).toEqual(["double_positive", "FSC_high"]);
    expect(model.excluded).toEqual([]);
    expect(model.partial).toEqual([{ file: "D3.fcs", populations: ["FSC_high"] }]);
    // D3 adds its double_positive (none) to treated's violin, and nothing to treated's FSC_high, whose files are D2's alone.
    expect(violins(model)).toEqual([
      ["double_positive", "control", ["D1.fcs"], [40]],
      ["FSC_high", "control", ["D1.fcs"], [70, 80]],
      ["double_positive", "treated", ["D2.fcs", "D3.fcs"], []],
      ["FSC_high", "treated", ["D2.fcs"], [65]],
    ]);
    const cells = (name: string, group: string) => model.violins.find((v) => model.catLevels[v.cat] === name && v.group === group)!.values.length;
    expect(cells("FSC_high", "treated")).toBe(ws.counted("D2", "FSC_high"));
    expect(cells("double_positive", "treated")).toBe(ws.counted("D2", "double_positive")! + ws.counted("D3", "double_positive")!);
  });

  it("still leaves out a file with none of the populations, and one without the parent", () => {
    const ws = partialWorkspace();
    const none = buildCellValuesModel(settings(ws, { parent: ws.main("CD4_positive"), selectedPops: [ws.main("FSC_high"), ws.main("FSC_low")] }), ws.files, ws.core, PARTIAL_METADATA);
    expect(none.excluded).toEqual(["D3.fcs"]);
    expect(none.partial).toEqual([]);
    expect(none.violins.every((v) => !v.files.includes("D3.fcs"))).toBe(true);
    // FSC_top within FSC_high: D3's tree has neither. Named for D3 by the map, FSC_top is there,
    // but the parent is still found by provenance, so D3 is still left out.
    const withinHigh = settings(ws, { parent: ws.main("FSC_high"), selectedPops: [ws.main("FSC_top")] });
    for (const filePopulations of [undefined, { D3: { [ws.main("FSC_top")]: ws.idOf("CD4_positive", D3_TREE)! } }]) {
      const model = buildCellValuesModel(withinHigh, ws.files, ws.core, PARTIAL_METADATA, { filePopulations });
      expect(model.excluded).toEqual(["D3.fcs"]);
      expect(violins(model)).toEqual([["FSC_top", "control", ["D1.fcs"], [80]], ["FSC_top", "treated", ["D2.fcs"], []]]);
    }
  });

  it("uses the map's id for a file, and leaves a population out of a file where the map says null", () => {
    const ws = partialWorkspace();
    const s = settings(ws, { selectedPops: [ws.main("CD8_positive"), ws.main("CD4_positive")] });
    // D2's CD4_positive is its CD8_positive (FSC 15); D1 draws no CD8_positive.
    const filePopulations = { D2: { [ws.main("CD4_positive")]: ws.main("CD8_positive") }, D1: { [ws.main("CD8_positive")]: null } };
    const model = buildCellValuesModel(s, ws.files, ws.core, PARTIAL_METADATA, { filePopulations });
    expect(model.excluded).toEqual([]);
    expect(model.partial).toEqual([{ file: "D1.fcs", populations: ["CD8_positive"] }]);
    expect(violins(model)).toEqual([
      ["CD4_positive", "control", ["D1.fcs"], [50, 60, 70, 80]],
      ["CD8_positive", "treated", ["D2.fcs", "D3.fcs"], [15, 25, 35]],
      ["CD4_positive", "treated", ["D2.fcs", "D3.fcs"], [15, 75]],
    ]);
    // An id the file's tree does not hold counts as missing there.
    const foreign = buildCellValuesModel(s, ws.files, ws.core, PARTIAL_METADATA, { filePopulations: { D3: { [ws.main("CD8_positive")]: ws.main("FSC_high") } } });
    expect(foreign.partial).toEqual([{ file: "D3.fcs", populations: ["CD8_positive"] }]);
  });

  it("gives the same model as before where every file has every population", () => {
    const ws = partialWorkspace();
    const s = settings(ws, { selectedPops: [ws.main("CD8_positive"), ws.main("CD4_positive")] });
    const before = buildCellValuesModel(s, ws.files, ws.core, PARTIAL_METADATA);
    expect(before.excluded).toEqual([]);
    expect(before.partial).toEqual([]);
    // The map naming where provenance finds each population gives the same model.
    const D3 = { [ws.main("CD8_positive")]: ws.idOf("CD8_positive", D3_TREE)!, [ws.main("CD4_positive")]: ws.idOf("CD4_positive", D3_TREE)! };
    for (const filePopulations of [{}, { D3 }] as FilePopulations[]) expect(buildCellValuesModel(s, ws.files, ws.core, PARTIAL_METADATA, { filePopulations })).toEqual(before);
    const units = buildCellValuesModel({ ...s, valueKind: "statistic" }, ws.files, ws.core, PARTIAL_METADATA, { poolBy: "unit", values: "raw" });
    expect(buildCellValuesModel({ ...s, valueKind: "statistic" }, ws.files, ws.core, PARTIAL_METADATA, { poolBy: "unit", values: "raw", filePopulations: { D3 } })).toEqual(units);
  });
});
