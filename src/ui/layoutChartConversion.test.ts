// A Layout summary chart converted to a Plotting chart: the converted chart's value for each file
// equals the summary chart's, for every statistic and plot type, on gates drawn around known events.
// Synthetic files D1 to D4, two control and two treated; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation, type Population } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, recomputeGating, type CoreState } from "../store";
import { figureHierarchies } from "../engine/figure";
import type { LayoutChartRecipe } from "../engine/layout";
import { buildProportionsModel, type ProportionsSampleRef } from "../engine/proportionsModel";
import { perUnitProps } from "../engine/proportions";
import { buildCellValuesModel } from "../engine/cellValuesModel";
import { chartData, type ChartSource } from "./LayoutChart";
import { statisticPoints } from "./StatisticChart";
import { chartPlottingSettings, chartToPlottingRecipe, quickStartPlottingRecipe } from "./layoutChartConversion";

// A holds FSC below 55; B, inside A, SSC below 25.
function tree() {
  const state = initialCoreState();
  const root = newRootPopulation();
  const gateA = newGate("A", "rectangle", "FSC-A", "SSC-A", [[0, 0], [55, 1000]]);
  const gateB = newGate("B", "rectangle", "FSC-A", "SSC-A", [[0, 0], [1000, 25]]);
  const a = newPopulation("A", [newGateRef(gateA.gate_id)], root.population_id);
  const b = newPopulation("B", [newGateRef(gateB.gate_id)], a.population_id);
  root.children = [a.population_id];
  a.children = [b.population_id];
  const populations: Record<string, Population> = { [root.population_id]: root, [a.population_id]: a, [b.population_id]: b };
  Object.assign(state, {
    gates: { [gateA.gate_id]: gateA, [gateB.gate_id]: gateB },
    gate_order: [gateA.gate_id, gateB.gate_id],
    populations,
    root_population_id: root.population_id,
    active_population_id: root.population_id,
  });
  return { state: state as CoreState, a: a.population_id, b: b.population_id };
}

function sample(fsc: number[], ssc: number[]): Sample {
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
    columns: [Float32Array.from(fsc), Float32Array.from(ssc)],
  };
  return new Sample(fcs);
}

// Ten events a file: A 5, 3, 4, 2; B 2, 1, 3, 1; nine of ten are in A for none.
const FILES = [
  { id: "D1", condition: "control", s: sample([10, 20, 30, 40, 50, 60, 70, 80, 90, 95], [10, 20, 30, 40, 50, 50, 50, 50, 50, 50]) },
  { id: "D2", condition: "control", s: sample([10, 20, 30, 60, 70, 80, 90, 95, 96, 97], [10, 50, 50, 50, 50, 50, 50, 50, 50, 50]) },
  { id: "D3", condition: "treated", s: sample([11, 21, 31, 41, 60, 60, 70, 80, 90, 95], [10, 10, 10, 40, 50, 50, 50, 50, 50, 50]) },
  { id: "D4", condition: "treated", s: sample([12, 22, 60, 60, 60, 70, 80, 90, 95, 96], [10, 50, 50, 50, 50, 50, 50, 50, 50, 50]) },
];
const METADATA = Object.fromEntries(FILES.map((file) => [file.id, { condition: file.condition }]));

function setup() {
  const fx = tree();
  const own = figureHierarchies(fx.state)[DEFAULT_HIERARCHY_ID];
  const sources: ChartSource[] = FILES.map((file) => ({ id: file.id, name: `${file.id}.fcs`, sample: file.s, derived: recomputeGating(file.s, fx.state), tree: own }));
  const refs: ProportionsSampleRef[] = FILES.map((file) => ({ id: file.id, name: `${file.id}.fcs`, sample: file.s, hierarchyId: DEFAULT_HIERARCHY_ID }));
  const ids = FILES.map((file) => file.id);
  return { ...fx, own, sources, refs, ids };
}

const recipe = (statistic: LayoutChartRecipe["statistic"], chartType: LayoutChartRecipe["chartType"], populationId: string, groupBy = "condition"): LayoutChartRecipe => ({
  kind: "chart",
  sampleId: "D1",
  populationId,
  statistic,
  ...(statistic === "median" ? { channel: "FSC-A" } : {}),
  files: "all",
  groupBy,
  chartType,
  showPoints: true,
  test: true,
});

describe("Converting a Layout summary chart to a Plotting chart", () => {
  for (const statistic of ["percent_of_parent", "percent_of_total", "count", "median"] as const) {
    for (const chartType of ["bars", "dots", "box"] as const) {
      it(`gives each file the summary chart's value: ${statistic}, ${chartType}`, () => {
        const fx = setup();
        const old = recipe(statistic, chartType, fx.b);
        const before = chartData(old, fx.sources, METADATA, fx.ids, fx.state);
        expect(before.points).toHaveLength(4);
        const settings = chartPlottingSettings(old, fx.own, { all: fx.ids, checked: fx.ids });
        expect(settings.plotType).toBe({ bars: "bar", dots: "dots", box: "box" }[chartType]);
        expect(settings.test).toBe(true);
        expect(settings.groupSel).toBe("condition");
        let after: { unit: string; group: string; value: number }[];
        if (statistic === "median") {
          expect(settings.valueKind).toBe("statistic");
          const model = buildCellValuesModel(settings, fx.refs, fx.state, METADATA, { poolBy: "unit", values: "raw" });
          after = statisticPoints(model, "median", true).map((p) => ({ unit: p.files[0], group: p.group, value: p.value }));
        } else {
          expect(settings.valueKind).toBe("proportion");
          const model = buildProportionsModel(settings, fx.refs, fx.state, METADATA, {});
          after = perUnitProps(model.perSample, model.catLevels.length, settings.proportionValue).map((row) => ({
            unit: row.unit,
            group: row.group,
            value: statistic === "count" ? row.shares[0] : row.shares[0] * 100,
          }));
        }
        for (const point of before.points) {
          const match = after.find((row) => row.unit === point.sampleId || row.unit === point.name)!;
          expect(match.group).toBe(point.group);
          // The Statistics tab, which the summary chart reads, rounds a percentage to two decimals.
          expect(statistic === "percent_of_parent" || statistic === "percent_of_total" ? Math.round(match.value * 100) / 100 : match.value).toBe(point.value);
        }
        // The values the fixture's comments give for B: 2, 1, 3 and 1 events of 10, within A's 5, 3, 4 and 2.
        if (statistic === "count") expect(before.points.map((p) => p.value)).toEqual([2, 1, 3, 1]);
        if (statistic === "percent_of_parent") expect(before.points.map((p) => p.value)).toEqual([40, 33.33, 75, 50]);
        // B's FSC values: 10 and 20; 10; 11, 21 and 31; 12. FSC is drawn on a linear scale here,
        // so the summary chart's median of displayed values is the measured median.
        if (statistic === "median") {
          expect(before.axis).toContain("linear");
          expect(before.points.map((p) => p.value)).toEqual([15, 10, 21, 12]);
        }
      });
    }
  }

  it("draws each file as its own group when the summary chart has no grouping, without a test", () => {
    const fx = setup();
    const settings = chartPlottingSettings(recipe("count", "dots", fx.a, ""), fx.own, { all: fx.ids, checked: fx.ids });
    expect(settings).toMatchObject({ groupSel: "__sample__", unitSel: "__sample__", test: false, points: true, parent: fx.own.root_population_id, selectedPops: [fx.a] });
    const model = buildProportionsModel(settings, fx.refs, fx.state, METADATA, {});
    expect(model.perSample.map((row) => row.group)).toEqual(["D1.fcs", "D2.fcs", "D3.fcs", "D4.fcs"]);
  });

  it("fixes the checked files, keeps the title, and leaves the rest of the block to the caller", () => {
    const fx = setup();
    const converted = chartToPlottingRecipe({ ...recipe("percent_of_total", "box", fx.b), files: "checked", title: "B in A" }, fx.own, { all: fx.ids, checked: ["D3", "D1"] });
    expect(converted).toMatchObject({ kind: "proportions", title: "B in A", settings: { files: ["D1", "D3"], parent: fx.a, proportionValue: "total", legend: false } });
  });

  it("makes the quick start's chart: bars of the mean, each file a point, a test between the groups", () => {
    const fx = setup();
    const made = quickStartPlottingRecipe({ sampleId: "D1", populationId: fx.b, statistic: "count", groupBy: "condition" }, fx.own, { all: fx.ids, checked: fx.ids });
    expect(made.settings).toMatchObject({ valueKind: "proportion", proportionValue: "count", plotType: "bar", points: true, test: true, groupSel: "condition", selectedPops: [fx.b] });
  });
});
