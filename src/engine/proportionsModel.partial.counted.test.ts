// The composition model where a file's tree lacks a selected population: the file keeps its bar,
// the population counts 0 there, its events fall to the rest of the parent, and the file is named
// in `partial`. Gates drawn through the store and counted by the gate list. Synthetic files D1, D2
// and D3; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { BASE_PROPORTIONS_SETTINGS, normalizeProportionsSettings, type ProportionsSettings } from "./proportionsSettings";
import { buildProportionsModel, type FilePopulations, type ProportionsModel } from "./proportionsModel";
import { D3_TREE, PARTIAL_METADATA, partialWorkspace } from "./partialPopulations.fixture";
import { computeBoxes, perUnitProps } from "./proportions";

type Workspace = ReturnType<typeof partialWorkspace>;

function settings(ws: Workspace, over: Partial<ProportionsSettings>): ProportionsSettings {
  return normalizeProportionsSettings({
    ...BASE_PROPORTIONS_SETTINGS, valueKind: "proportion", plotType: "stacked", includeUngated: true,
    files: ["D1", "D2", "D3"], hierarchy: ws.core.active_hierarchy_id, parent: ws.main("All Events"), groupSel: "__sample__",
    ...over,
  });
}

/** Each bar as [file, catCounts, popCounts]. */
const bars = (model: ProportionsModel) => model.perSample.map((row) => [row.unit, row.catCounts, row.popCounts]);

describe("Compositions where a file's tree lacks a selected population", () => {
  it("keeps the file's bar, the population at 0 and its events in the rest, and names it in partial", () => {
    const ws = partialWorkspace();
    const model = buildProportionsModel(settings(ws, { selectedPops: [ws.main("double_positive"), ws.main("FSC_high")] }), ws.files, ws.core, PARTIAL_METADATA, {});
    expect(model.catLevels).toEqual(["double_positive", "FSC_high", "ungated"]);
    expect(model.excluded).toEqual([]);
    expect(model.partial).toEqual([{ file: "D3.fcs", populations: ["FSC_high"] }]);
    // D3's CD4_positive event (FSC 75) is in no drawn population there, so it is in the rest.
    expect(bars(model)).toEqual([
      ["D1", [1, 2, 5], [1, 2]],
      ["D2", [0, 1, 4], [0, 1]],
      ["D3", [0, 0, 3], [0, 0]],
    ]);
    expect(model.perSample.map((row) => row.catCounts[1])).toEqual([ws.counted("D1", "FSC_high"), ws.counted("D2", "FSC_high"), 0]);
    // Each bar is a share of its parent, here every event of the file.
    expect(model.perSample.map((row) => row.catCounts.reduce((a, b) => a + b, 0))).toEqual(["D1", "D2", "D3"].map((id) => ws.counted(id, "All Events")));
  });

  it("sums each bar to its parent within a population the file has", () => {
    const ws = partialWorkspace();
    // Within CD4_positive: D3 holds CD4_positive but none of FSC_high and FSC_low, so it is left
    // out; named for D3 by the map, FSC_low is D3's CD4_positive and FSC_high is not drawn there.
    const s = settings(ws, { parent: ws.main("CD4_positive"), selectedPops: [ws.main("FSC_high"), ws.main("FSC_low")] });
    const none = buildProportionsModel(s, ws.files, ws.core, PARTIAL_METADATA, {});
    expect(none.excluded).toEqual(["D3.fcs"]);
    expect(none.partial).toEqual([]);
    const mapped = buildProportionsModel(s, ws.files, ws.core, PARTIAL_METADATA, {}, { filePopulations: { D3: { [ws.main("FSC_low")]: ws.idOf("CD4_positive", D3_TREE)! } } });
    expect(mapped.catLevels).toEqual(["FSC_high", "FSC_low", "rest of CD4_positive"]);
    expect(mapped.excluded).toEqual([]);
    expect(mapped.partial).toEqual([{ file: "D3.fcs", populations: ["FSC_high"] }]);
    expect(bars(mapped)).toEqual([["D1", [2, 2, 0], [2, 2]], ["D2", [1, 1, 0], [1, 1]], ["D3", [0, 1, 0], [0, 1]]]);
    expect(mapped.perSample.map((row) => row.catCounts.reduce((a, b) => a + b, 0))).toEqual(["D1", "D2", "D3"].map((id) => ws.counted(id, "CD4_positive")));
  });

  it("still leaves out a file without the parent, the map notwithstanding", () => {
    const ws = partialWorkspace();
    const s = settings(ws, { parent: ws.main("FSC_high"), selectedPops: [ws.main("FSC_top")] });
    for (const filePopulations of [undefined, { D3: { [ws.main("FSC_top")]: ws.idOf("CD4_positive", D3_TREE)! } }]) {
      const model = buildProportionsModel(s, ws.files, ws.core, PARTIAL_METADATA, {}, { filePopulations });
      expect(model.excluded).toEqual(["D3.fcs"]);
      expect(bars(model)).toEqual([["D1", [1, 1], [1]], ["D2", [0, 1], [0]]]);
    }
  });

  it("uses the map's id for a file, and leaves a population out of a file where the map says null", () => {
    const ws = partialWorkspace();
    const s = settings(ws, { selectedPops: [ws.main("CD8_positive"), ws.main("CD4_positive")] });
    // D2's CD4_positive is its CD8_positive (1 event); D1 draws no CD8_positive, its 3 in the rest.
    const filePopulations = { D2: { [ws.main("CD4_positive")]: ws.main("CD8_positive") }, D1: { [ws.main("CD8_positive")]: null } };
    const model = buildProportionsModel(s, ws.files, ws.core, PARTIAL_METADATA, {}, { filePopulations });
    expect(model.partial).toEqual([{ file: "D1.fcs", populations: ["CD8_positive"] }]);
    expect(bars(model)).toEqual([
      ["D1", [0, 4, 4], [0, 4]],
      ["D2", [1, 0, 4], [1, 1]],
      ["D3", [2, 1, 0], [2, 1]],
    ]);
    // D2: its CD8_positive event is both CD8_positive and the map's CD4_positive; a stacked bar
    // draws each event once, the first of two levels at one depth taking it, so CD4_positive's
    // bar is 0 there while its whole count (popCounts) is 1, and D2's own CD4_positive events are in the rest.
    expect(model.perSample[1].catCounts.reduce((a, b) => a + b, 0)).toBe(ws.counted("D2", "All Events"));
  });

  it("gives the same model as before where every file has every population", () => {
    const ws = partialWorkspace();
    const s = settings(ws, { selectedPops: [ws.main("CD8_positive"), ws.main("CD4_positive")] });
    const before = buildProportionsModel(s, ws.files, ws.core, PARTIAL_METADATA, {});
    expect(before.excluded).toEqual([]);
    expect(before.partial).toEqual([]);
    expect(bars(before)).toEqual([["D1", [3, 4, 1], [3, 4]], ["D2", [1, 2, 2], [1, 2]], ["D3", [2, 1, 0], [2, 1]]]);
    const D3 = { [ws.main("CD8_positive")]: ws.idOf("CD8_positive", D3_TREE)!, [ws.main("CD4_positive")]: ws.idOf("CD4_positive", D3_TREE)! };
    for (const filePopulations of [{}, { D3 }] as FilePopulations[]) expect(buildProportionsModel(s, ws.files, ws.core, PARTIAL_METADATA, {}, { filePopulations })).toEqual(before);
  });
});

describe("Per-unit shares where a file's tree lacks a selected population", () => {
  // One group for every file; units by donor, D2 and D3 one donor (P) where asked.
  const cohort = (donors: Record<string, string>) => Object.fromEntries(Object.entries(donors).map(([id, donor]) => [id, { cohort: "all", donor }]));

  it("takes no share of a population from a file that does not draw it", () => {
    const ws = partialWorkspace();
    const s = settings(ws, { selectedPops: [ws.main("double_positive"), ws.main("FSC_high")], groupSel: "cohort", unitSel: "__sample__" });
    const model = buildProportionsModel(s, ws.files, ws.core, cohort({ D1: "D1", D2: "D2", D3: "D3" }), {});
    expect(model.perSample.map((row) => row.missing)).toEqual([undefined, undefined, [1]]);
    const units = perUnitProps(model.perSample, model.catLevels.length);
    // D3 has no FSC_high share: its tree lacks the population.
    expect(units.map((u) => u.shares[1])).toEqual([2 / 8, 1 / 5, NaN]);
    // The stacked bar's partition is as drawn: D3's 3 events all in the rest.
    expect(units[2].props).toEqual([0, 0, 1]);
    const boxes = computeBoxes(units, model.catLevels.length, false);
    // double_positive: D1 1 of 8, D2 0 of 5, D3 0 of 3 (gate counts); FSC_high: D1 2 of 8, D2 1 of 5.
    expect(boxes.map((box) => [box.cat, box.units, box.values])).toEqual([
      [0, ["D1", "D2", "D3"], [ws.counted("D1", "double_positive")! / 8, 0, 0]],
      [1, ["D1", "D2"], [ws.counted("D1", "FSC_high")! / 8, ws.counted("D2", "FSC_high")! / 5]],
      [2, ["D1", "D2", "D3"], [5 / 8, 4 / 5, 1]],
    ]);
    // A share of the total, or a count, is taken over the files that draw the population too.
    expect(perUnitProps(model.perSample, model.catLevels.length, "total").map((u) => u.shares[1])).toEqual([2 / 8, 1 / 5, NaN]);
    expect(perUnitProps(model.perSample, model.catLevels.length, "count").map((u) => u.shares[1])).toEqual([2, 1, NaN]);
  });

  it("takes a pooled unit's share from its files that draw the population, and none from a unit none of whose files does", () => {
    const ws = partialWorkspace();
    const s = settings(ws, { selectedPops: [ws.main("double_positive"), ws.main("FSC_high")], groupSel: "cohort", unitSel: "donor" });
    const model = buildProportionsModel(s, ws.files, ws.core, cohort({ D1: "D1", D2: "P", D3: "P" }), {});
    const [d1, p] = perUnitProps(model.perSample, model.catLevels.length);
    // P pools D2 (5 events) and D3 (3): double_positive over both, 0 of 8; FSC_high over D2 alone, 1 of 5.
    expect([p.unit, p.shares[0], p.shares[1]]).toEqual(["P", 0, 1 / 5]);
    expect(d1.shares[1]).toBe(2 / 8);
    const only = buildProportionsModel({ ...s, files: ["D3"] }, ws.files, ws.core, cohort({ D3: "P" }), {});
    const [alone] = perUnitProps(only.perSample, only.catLevels.length);
    expect(alone.shares[1]).toBeNaN();
    expect(computeBoxes([alone], only.catLevels.length, false).map((box) => box.cat)).toEqual([0, 2]);
  });

  it("gives the same rows and shares as before where every file has every population", () => {
    const ws = partialWorkspace();
    const s = settings(ws, { selectedPops: [ws.main("CD8_positive"), ws.main("CD4_positive")], groupSel: "cohort", unitSel: "__sample__" });
    const model = buildProportionsModel(s, ws.files, ws.core, cohort({ D1: "D1", D2: "D2", D3: "D3" }), {});
    expect(model.perSample.every((row) => !("missing" in row))).toBe(true);
    // Each whole count over the unit's events in the parent, as the share was taken before.
    expect(perUnitProps(model.perSample, model.catLevels.length).map((u) => u.shares)).toEqual(
      model.perSample.map((row) => {
        const n = row.catCounts.reduce((a, b) => a + b, 0);
        return [row.popCounts![0] / n, row.popCounts![1] / n, row.catCounts[2] / n];
      }),
    );
  });
});

