// @vitest-environment jsdom
// "Show n": the n each Plotting chart writes under its marks is the number the chart's table
// gives (Cells and Files, or the rows of replicate units), drawn from gated synthetic files D1 to
// D4 in conditions control and treated; with the setting off nothing is written.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, type CoreState } from "../store";
import { BASE_PROPORTIONS_SETTINGS, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "../engine/proportionsSettings";
import { buildCellValuesModel, type CellValueAxis } from "../engine/cellValuesModel";
import { buildProportionsModel, type ProportionsSampleRef } from "../engine/proportionsModel";
import { cellsDataTable, proportionsDataTable, statisticDataTable } from "./plottingData";
import { CellValuesChart } from "./CellValuesChart";
import { StatisticChart } from "./StatisticChart";
import { ProportionsChart, proportionPanelTests } from "./ProportionsChart";
import { nLines, nUnitName, withNUnit } from "./chart/chartN";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

// Small holds FSC below 25 and Large FSC from 25: D1 (control) 10, 20 | 30, 40, 50;
// D3 (control) 12, 22 | 36; D2 (treated) 15, 18 | 35, 45; D4 (treated) 19, 21 | 41, 47.
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

const FONTS = { tick: 9, axis: 10, legend: 11 };
const AXIS: CellValueAxis = { range: [0, 60], major: [0, 20, 40, 60].map((at) => ({ at, label: String(at) })), minor: [] };
const nTexts = () => [...host.querySelectorAll(".gl-prop-n")].map((node) => node.textContent);
const draw = (element: JSX.Element) => act(() => root.render(element));

describe("n under a chart's marks", () => {
  it("writes n with its files on a second line, thousands separated, and names what n counts", () => {
    expect(nLines(51715, 3)).toEqual(["n = 51,715", "(3 files)"]);
    expect(nLines(265)).toEqual(["n = 265"]);
    expect(nUnitName(PROPORTIONS_SAMPLE_FACTOR)).toBe("files");
    expect(nUnitName("sample_id")).toBe("Sample ID");
    expect(withNUnit("Median FSC-A", "donor")).toBe("Median FSC-A · n: donor");
  });

  it("gives each violin the cells and files of its row in the chart's table", () => {
    const fx = fixture();
    const settings = { ...fx.settings, valueKind: "cells" as const, plotType: "violin" as const };
    const raw = buildCellValuesModel(settings, fx.files, fx.state, METADATA, { values: "raw" });
    const drawn = buildCellValuesModel(settings, fx.files, fx.state, METADATA);
    const table = cellsDataTable(raw, drawn, { group: "condition" }, "FSC-A", { xAxis: "populations" });
    const cells = table.header.indexOf("Cells");
    const files = table.header.indexOf("Files");
    const expected = table.rows.flatMap((row) => nLines(Number(row[cells]), String(row[files]).split("; ").length));
    const chart = (showN: boolean) => (
      <CellValuesChart model={drawn} plotType="violin" xAxis="populations" violinBox showN={showN} axis={AXIS} catColors={["#111", "#222"]} palette="paired" fonts={FONTS} appearance={{ height: 160, showGrid: true, showLegend: true }} />
    );
    draw(chart(true));
    // Control Small pools D1 and D3: 10, 20, 12, 22.
    expect(expected.slice(0, 2)).toEqual(["n = 4", "(2 files)"]);
    expect(nTexts()).toEqual(expected);
    const withN = host.querySelector("svg.gl-prop-panel")!.getAttribute("height");
    draw(chart(false));
    expect(nTexts()).toEqual([]);
    expect(Number(withN)).toBeGreaterThan(Number(host.querySelector("svg.gl-prop-panel")!.getAttribute("height")));
  });

  it("gives each statistic slot the replicate units of its rows in the chart's table, and names them on the value axis", () => {
    const fx = fixture();
    const settings = { ...fx.settings, valueKind: "statistic" as const, plotType: "box" as const, xAxis: "groups" as const };
    const model = buildCellValuesModel(settings, fx.files, fx.state, METADATA, { poolBy: "unit", values: "raw" });
    const table = statisticDataTable(model, settings, { group: "condition" }, "FSC-A");
    const population = table.header.indexOf("Population");
    const group = table.header.indexOf("condition");
    // Panels by population, a slot per group, as the chart draws them.
    const expected = model.catLevels.flatMap((pop) =>
      ["control", "treated"].flatMap((g) => nLines(table.rows.filter((row) => row[population] === pop && row[group] === g).length)),
    );
    expect(expected).toEqual(["n = 2", "n = 2", "n = 2", "n = 2"]);
    const chart = (showN: boolean) => (
      <StatisticChart model={model} statistic="median" plotType="box" errorBar="sd" test={false} showN={showN} xAxis="groups" unitSel={PROPORTIONS_SAMPLE_FACTOR} catColors={["#111", "#222"]} palette="paired" fonts={FONTS} appearance={{ height: 160, showGrid: true, showLegend: true, showPoints: true, pointRadius: 1.5 }} />
    );
    draw(chart(true));
    expect(nTexts()).toEqual(expected);
    expect(host.textContent).toContain("Median FSC-A · n: files");
    draw(chart(false));
    expect(nTexts()).toEqual([]);
    expect(host.textContent).not.toContain("n: files");
  });

  it("gives each proportion box the replicate units of its rows in the chart's table", () => {
    const fx = fixture();
    const model = buildProportionsModel(fx.settings, fx.files, fx.state, METADATA, {});
    const table = proportionsDataTable(model, { group: "condition", unit: "File" }, (id) => `${id}.fcs`, true);
    const [file, group, population] = ["File", "condition", "Population"].map((name) => table.header.indexOf(name));
    const units = (pop: string, g: string) => new Set(table.rows.filter((row) => row[population] === pop && row[group] === g).map((row) => row[file])).size;
    const expected = model.catLevels.flatMap((pop) => ["control", "treated"].flatMap((g) => nLines(units(pop, g))));
    expect(expected).toEqual(["n = 2", "n = 2", "n = 2", "n = 2"]);
    const chart = (plotType: "box" | "stacked", showN: boolean) => (
      <ProportionsChart plotType={plotType} showN={showN} unitSel={PROPORTIONS_SAMPLE_FACTOR} model={model} catColors={["#111", "#222"]} palette="paired" averagePerUnit populations={fx.state.populations} fonts={FONTS} valueTitle="% of all events" />
    );
    draw(chart("box", true));
    expect(nTexts()).toEqual(expected);
    expect(host.textContent).toContain("% of all events · n: files");
    // A stacked bar averages its group's two files: n = 2 under each bar.
    draw(chart("stacked", true));
    expect(nTexts()).toEqual(["n = 2", "n = 2"]);
    draw(chart("box", false));
    expect(nTexts()).toEqual([]);
    expect(host.textContent).not.toContain("n: files");
  });

  it("writes no n under a stacked bar of one file", () => {
    const fx = fixture();
    const model = buildProportionsModel({ ...fx.settings, groupSel: PROPORTIONS_SAMPLE_FACTOR }, fx.files, fx.state, METADATA, {});
    draw(<ProportionsChart plotType="stacked" showN model={model} catColors={["#111", "#222"]} palette="paired" averagePerUnit populations={fx.state.populations} fonts={FONTS} valueTitle="% of all events" />);
    expect(host.querySelectorAll("svg.gl-prop-panel").length).toBeGreaterThan(0);
    expect(nTexts()).toEqual([]);
    expect(host.textContent).not.toContain("n: files");
  });
});

describe("a file that does not draw a population", () => {
  // D3's Large is not drawn (as an Illustration figure leaves a population out of a file): D3 keeps
  // its bar, and has no share of Large. Large: control D1 3 of 5 (D3 none), treated D2 2 of 4, D4 2 of 4.
  function partial() {
    const fx = fixture();
    const large = fx.settings.selectedPops[1];
    const model = buildProportionsModel(fx.settings, fx.files, fx.state, METADATA, {}, { filePopulations: { D3: { [large]: null } } });
    return { fx, model };
  }

  it("writes n = 1 under its control box, the units that have a share of it", () => {
    const { fx, model } = partial();
    expect(model.partial).toEqual([{ file: "D3.fcs", populations: ["Large"] }]);
    draw(<ProportionsChart plotType="box" showN unitSel={PROPORTIONS_SAMPLE_FACTOR} model={model} catColors={["#111", "#222"]} palette="paired" averagePerUnit populations={fx.state.populations} fonts={FONTS} valueTitle="% of all events" />);
    // Small: control D1, D3; treated D2, D4. Large: control D1 alone; treated D2, D4.
    expect(nTexts()).toEqual(["n = 2", "n = 2", "n = 1", "n = 2"]);
  });

  it("tests Large on the units that have a share of it", () => {
    const { model } = partial();
    const tests = proportionPanelTests(model, [null], ["control", "treated"], "parent", { comparisons: "pairwise", comparisonsShow: "all", paired: false });
    expect(tests.get("p0-0")!.pairs.map((pair) => [pair.nA, pair.nB])).toEqual([[2, 2]]);
    expect(tests.get("p0-1")!.pairs.map((pair) => [pair.nA, pair.nB])).toEqual([[1, 2]]);
  });

  it("leaves its whole count and whole percents blank in the chart's table, and its stacked-bar count as drawn", () => {
    const { model } = partial();
    const table = proportionsDataTable(model, { group: "condition", unit: "File" }, (id) => `${id}.fcs`, true, {}, "total");
    const at = (name: string) => table.header.indexOf(name);
    const row = (file: string, pop: string) => table.rows.find((r) => r[at("File")] === file && r[at("Population")] === pop)!;
    const columns = ["Count", "Whole count", "Whole percent (boxplot)", "Whole percent of total"];
    expect(columns.map((name) => row("D3.fcs", "Large")[at(name)])).toEqual([0, "", "", ""]);
    expect(columns.map((name) => row("D1.fcs", "Large")[at(name)])).toEqual([3, 3, "60", "60"]);
  });
});

