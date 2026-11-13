// The Plotting charts' data as CSV, against hand-computed values. Synthetic files D1 to D4,
// conditions control and treated; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, type CoreState } from "../store";
import { BASE_PROPORTIONS_SETTINGS, PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "../engine/proportionsSettings";
import { buildCellValuesModel, type CellValuesModel } from "../engine/cellValuesModel";
import { buildProportionsModel, type ProportionsSampleRef } from "../engine/proportionsModel";
import { computeBoxes, perUnitProps } from "../engine/proportions";
import { cellsDataCsv, cellsDataTable, channelsDataTable, proportionsDataCsv, proportionsDataTable, statisticDataCsv, statisticDataTable, type PlottingDataTable } from "./plottingData";

// Small holds FSC below 25 and Large FSC from 25, in raw units. Small and Large per file:
// D1 (control) 10, 20 | 30, 40, 50; D3 (control) 12, 22 | 36; D2 (treated) 15, 18 | 35, 45;
// D4 (treated) 19, 21 | 41, 47.
const FSC: Record<string, number[]> = { D1: [10, 20, 30, 40, 50], D2: [15, 18, 35, 45], D3: [12, 22, 36], D4: [19, 21, 41, 47] };
const METADATA = { D1: { condition: "control" }, D2: { condition: "treated" }, D3: { condition: "control" }, D4: { condition: "treated" } };

function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const small = { ...newGate("Small", "rectangle", "FSC-A", "SSC-A", [[0, 0], [25, 1000]]), space: "raw" as const };
  const large = { ...newGate("Large", "rectangle", "FSC-A", "SSC-A", [[25, 0], [1000, 1000]]), space: "raw" as const };
  const smallPop = newPopulation("Small", [newGateRef(small.gate_id)], rootPop.population_id);
  const largePop = newPopulation("Large", [newGateRef(large.gate_id)], rootPop.population_id);
  rootPop.children = [smallPop.population_id, largePop.population_id];
  Object.assign(state, {
    gates: { [small.gate_id]: small, [large.gate_id]: large },
    gate_order: [small.gate_id, large.gate_id],
    populations: { [rootPop.population_id]: rootPop, [smallPop.population_id]: smallPop, [largePop.population_id]: largePop },
    root_population_id: rootPop.population_id,
    active_population_id: rootPop.population_id,
  });
  const files: ProportionsSampleRef[] = ["D1", "D2", "D3", "D4"].map((id) => {
    const fsc = FSC[id];
    const fcs: FcsFile = {
      version: "FCS3.1",
      nEvents: fsc.length,
      instrument: "flow",
      keywords: {},
      spillover: null,
      channels: [
        { index: 0, name: "SSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from(fsc.map(() => 100)), Float32Array.from(fsc)],
    };
    return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
  });
  const s = state as CoreState;
  const settings: ProportionsSettings = {
    ...BASE_PROPORTIONS_SETTINGS,
    files: files.map((f) => f.id),
    hierarchy: s.active_hierarchy_id,
    parent: rootPop.population_id,
    selectedPops: [smallPop.population_id, largePop.population_id],
    groupSel: "condition",
    unitSel: PROPORTIONS_SAMPLE_FACTOR,
    includeUngated: false,
    channel: "FSC-A",
  };
  return { state: s, files, settings };
}

const rows = (csv: string) => csv.trim().split("\r\n").map((line) => line.split(","));

describe("Plotting chart data", () => {
  it.each([false, true])("marks built-in file headings separately from metadata names, with facet %s", (faceted) => {
    const fx = fixture();
    const settings = { ...fx.settings, facetSel: faceted ? "condition" : PROPORTIONS_NO_FACTOR };
    const titles = { group: "File", unit: "Files", facet: "File" };
    const proportions = buildProportionsModel(settings, fx.files, fx.state, METADATA, {});
    const perFile = proportionsDataTable(proportions, titles, (id) => `${id}.fcs`, true);
    expect(perFile.header.slice(0, 2)).toEqual(["File", "File"]);
    expect(perFile.fileColumns).toEqual([0]);
    const perUnit = proportionsDataTable(proportions, titles, (id) => `${id}.fcs`, false);
    expect(perUnit.header.slice(0, 2)).toEqual(["Files", "File"]);
    expect(perUnit.fileColumns).toEqual([]);
    const raw = buildCellValuesModel({ ...settings, valueKind: "cells" }, fx.files, fx.state, METADATA, { values: "raw" });
    const drawn = buildCellValuesModel({ ...settings, valueKind: "cells" }, fx.files, fx.state, METADATA);
    const cells = cellsDataTable(raw, drawn, titles, "FSC-A");
    expect(cells.fileColumns).toEqual([faceted ? 3 : 2]);
    expect(cells.header[cells.fileColumns![0]]).toBe("Files");
    const unitModel = buildCellValuesModel({ ...settings, valueKind: "statistic" }, fx.files, fx.state, METADATA, { poolBy: "unit", values: "raw" });
    const statistic = statisticDataTable(unitModel, settings, titles, "FSC-A");
    expect(statistic.fileColumns).toEqual([faceted ? 4 : 3]);
    expect(statistic.header.slice(0, 2)).toEqual(["Files", "File"]);
    expect(statistic.header[statistic.fileColumns![0]]).toBe("Files");
    const combined = channelsDataTable([{ channel: "FSC-A", table: cells }, { channel: "SSC-A", table: cells }]);
    expect(combined.fileColumns).toEqual([faceted ? 4 : 3]);
    expect(combined.header.slice(0, 2)).toEqual(["Channel", "File"]);
  });

  it("gives a proportion chart's count, total and percentage per file and population", () => {
    const fx = fixture();
    const model = buildProportionsModel(fx.settings, fx.files, fx.state, METADATA, {});
    const table = rows(proportionsDataCsv(model, { group: "condition", unit: "File" }, (id) => `${id}.fcs`, true));
    expect(table[0]).toEqual(["File", "condition", "Population", "Count", "Total", "Percent (stacked bar)", "Whole count", "Whole percent (boxplot)"]);
    expect(table).toContainEqual(["D1.fcs", "control", "Small", "2", "5", "40", "2", "40"]);
    expect(table).toContainEqual(["D3.fcs", "control", "Large", "1", "3", "33.3333", "1", "33.3333"]);
    expect(table).toHaveLength(1 + 4 * 2);
  });

  it("gives both the stacked bar's share and the boxplot's whole share with a population and its child selected", () => {
    // Low, a child of Small, holds FSC below 16: D1 10, D2 15, D3 12, D4 none.
    const fx = fixture();
    const smallId = fx.settings.selectedPops[0];
    const lowGate = { ...newGate("Low", "rectangle", "FSC-A", "SSC-A", [[0, 0], [16, 1000]]), space: "raw" as const };
    const low = newPopulation("Low", [newGateRef(lowGate.gate_id)], smallId);
    const state: CoreState = {
      ...fx.state,
      gates: { ...fx.state.gates, [lowGate.gate_id]: lowGate },
      gate_order: [...fx.state.gate_order, lowGate.gate_id],
      populations: { ...fx.state.populations, [smallId]: { ...fx.state.populations[smallId], children: [low.population_id] }, [low.population_id]: low },
    };
    const settings = { ...fx.settings, selectedPops: [smallId, low.population_id, fx.settings.selectedPops[1]] };
    const model = buildProportionsModel(settings, fx.files, state, METADATA, {});
    expect(model.catLevels).toEqual(["Small", "Low", "Large"]);
    const table = rows(proportionsDataCsv(model, { group: "condition", unit: "File" }, (id) => `${id}.fcs`, true));
    // D1: Small 10, 20 of which Low holds 10; Large 30, 40, 50. The stacked bar gives Small the 20
    // alone (1 of 5, 20%); the boxplot draws Small whole (2 of 5, 40%).
    expect(table).toContainEqual(["D1.fcs", "control", "Small", "1", "5", "20", "2", "40"]);
    expect(table).toContainEqual(["D1.fcs", "control", "Low", "1", "5", "20", "1", "20"]);
    // Every value the boxplot draws is a row's whole percent.
    const boxes = computeBoxes(perUnitProps(model.perSample, model.catLevels.length), model.catLevels.length, false);
    for (const box of boxes) {
      box.units.forEach((unit, i) => {
        const row = table.find((r) => r[0] === `${unit}.fcs` && r[2] === model.catLevels[box.cat])!;
        expect(Number(row[7])).toBeCloseTo(box.values[i] * 100, 4);
      });
    }
  });

  it("gives each violin's cells, median, quartiles and whiskers on linear values", () => {
    const fx = fixture();
    const model = buildCellValuesModel({ ...fx.settings, valueKind: "cells" }, fx.files, fx.state, METADATA, { values: "raw" });
    const drawn = buildCellValuesModel({ ...fx.settings, valueKind: "cells" }, fx.files, fx.state, METADATA);
    const table = rows(cellsDataCsv(model, drawn, { group: "condition" }, "FSC-A"));
    expect(table[0]).toEqual(["condition", "Population", "Files", "Cells", "Median FSC-A", "Q1 FSC-A", "Q3 FSC-A", "Lower whisker FSC-A", "Upper whisker FSC-A"]);
    // Control Small pools D1 and D3: 10, 12, 20, 22; type-7 quartiles 11.5 and 20.5.
    expect(table).toContainEqual(["control", "Small", "D1.fcs; D3.fcs", "4", "16", "11.5", "20.5", "10", "22"]);
  });

  it("gives the whiskers as the measured values of the cells the drawn whiskers end at", () => {
    // Linear: quartiles 5 and 112, upper fence 272.5, so 2048 lies beyond it and the whisker ends
    // at 256. Drawn on log2 values (0 to 8, then 11): quartiles 2.25 and 6.75, upper fence 13.5, so
    // the drawn whisker ends at 2048's cell.
    const linear = [1, 2, 4, 8, 16, 32, 64, 128, 256, 2048];
    const model = (values: number[]): CellValuesModel => ({
      catLevels: ["Small"],
      levels: [{ popId: "p", depth: 1 }],
      violins: [{ cat: 0, group: "control", facet: null, unit: null, values: Float32Array.from(values), files: ["D1.fcs"] }],
      hasFacet: false,
      channelLabel: "FSC-A",
      excluded: [],
      noChannel: [],
      extent: [values[0], values[values.length - 1]],
      axisSource: null,
    });
    const table = rows(cellsDataCsv(model(linear), model(linear.map(Math.log2)), { group: "condition" }, "FSC-A"));
    // Median and quartiles stay on linear values (type 7): 24, 5 and 112.
    expect(table[1]).toEqual(["control", "Small", "D1.fcs", "10", "24", "5", "112", "1", "2048"]);
  });

  it("gives each replicate unit's statistic, with the panel's test when it is on", () => {
    const fx = fixture();
    const model = buildCellValuesModel({ ...fx.settings, valueKind: "statistic" }, fx.files, fx.state, METADATA, { poolBy: "unit", values: "raw" });
    const settings = { ...fx.settings, valueKind: "statistic" as const, plotType: "box" as const, xAxis: "groups" as const, statistic: "median" as const, test: true };
    const table = rows(statisticDataCsv(model, settings, { group: "condition", unit: "File" }, "FSC-A"));
    expect(table[0]).toEqual(["File", "condition", "Population", "Files", "Cells", "Median FSC-A", "Test", "p"]);
    expect(table).toContainEqual(["D1.fcs", "control", "Small", "D1.fcs", "2", "15", "Wilcoxon rank-sum", "0.666667"]);
    expect(table).toContainEqual(["D4.fcs", "treated", "Large", "D4.fcs", "2", "44", "Wilcoxon rank-sum", expect.any(String)]);
    expect(table).toHaveLength(1 + 8);
  });

  it("gives a geometric mean's cells as those it is taken of, and those left out as not positive", () => {
    const unitModel: CellValuesModel = {
      catLevels: ["Small"],
      levels: [{ popId: "p", depth: 1 }],
      violins: [
        { cat: 0, group: "control", facet: null, unit: "D1", values: Float32Array.from([-5, 0, 2, 8]), files: ["D1.fcs"] },
        { cat: 0, group: "treated", facet: null, unit: "D2", values: Float32Array.from([1, 4]), files: ["D2.fcs"] },
      ],
      hasFacet: false,
      channelLabel: "FSC-A",
      excluded: [],
      noChannel: [],
      extent: [-5, 8],
      axisSource: null,
    };
    const fx = fixture();
    const base = { ...fx.settings, valueKind: "statistic" as const, plotType: "box" as const, xAxis: "groups" as const, test: false };
    const geo = rows(statisticDataCsv(unitModel, { ...base, statistic: "geomean" }, { group: "condition", unit: "File" }, "FSC-A"));
    expect(geo[0]).toEqual(["File", "condition", "Population", "Files", "Cells", "Cells not positive", "Geometric mean FSC-A"]);
    expect(geo).toContainEqual(["D1.fcs", "control", "Small", "D1.fcs", "2", "2", "4"]);
    expect(geo).toContainEqual(["D2.fcs", "treated", "Small", "D2.fcs", "2", "0", "2"]);
    const median = rows(statisticDataCsv(unitModel, { ...base, statistic: "median" }, { group: "condition", unit: "File" }, "FSC-A"));
    expect(median[0]).toEqual(["File", "condition", "Population", "Files", "Cells", "Median FSC-A"]);
    expect(median).toContainEqual(["D1.fcs", "control", "Small", "D1.fcs", "4", "1"]);
  });

  it("gives the table shown under each kind of chart the CSV's fields, cell for cell", () => {
    const fx = fixture();
    const titles = { group: "condition", unit: "File" };
    const same = (table: PlottingDataTable, csv: string) =>
      expect([table.header, ...table.rows].map((record) => record.map(String))).toEqual(rows(csv));
    const proportions = buildProportionsModel(fx.settings, fx.files, fx.state, METADATA, {});
    same(proportionsDataTable(proportions, titles, (id) => `${id}.fcs`, true), proportionsDataCsv(proportions, titles, (id) => `${id}.fcs`, true));
    const raw = buildCellValuesModel({ ...fx.settings, valueKind: "cells" }, fx.files, fx.state, METADATA, { values: "raw" });
    const drawn = buildCellValuesModel({ ...fx.settings, valueKind: "cells" }, fx.files, fx.state, METADATA);
    // "D1.fcs; D3.fcs" holds no comma, so splitting the CSV on commas gives its fields.
    same(cellsDataTable(raw, drawn, titles, "FSC-A"), cellsDataCsv(raw, drawn, titles, "FSC-A"));
    const unitModel = buildCellValuesModel({ ...fx.settings, valueKind: "statistic" }, fx.files, fx.state, METADATA, { poolBy: "unit", values: "raw" });
    const settings = { ...fx.settings, valueKind: "statistic" as const, plotType: "box" as const, xAxis: "groups" as const, statistic: "median" as const, test: true };
    same(statisticDataTable(unitModel, settings, titles, "FSC-A"), statisticDataCsv(unitModel, settings, titles, "FSC-A"));
  });
});

describe("channelsDataTable", () => {
  it("leads each channel's rows and tests with its label, the value columns named without a channel", () => {
    const table = (median: number, tested: boolean) => ({
      header: ["Group", "Population", "Median ", "Unit median "],
      rows: [["control", "CD4_positive", median, ""]],
      ...(tested ? { comparisons: { header: ["Population", "p"], rows: [["CD4_positive", 0.5]] } } : {}),
    });
    const joined = channelsDataTable([
      { channel: "FSC-A", table: table(15, false) },
      { channel: "SSC-A", table: table(300, true) },
    ]);
    expect(joined.header).toEqual(["Channel", "Group", "Population", "Median", "Unit median"]);
    expect(joined.rows).toEqual([["FSC-A", "control", "CD4_positive", 15, ""], ["SSC-A", "control", "CD4_positive", 300, ""]]);
    expect(joined.comparisons).toEqual({ header: ["Channel", "Population", "p"], rows: [["SSC-A", "CD4_positive", 0.5]] });
  });
});
