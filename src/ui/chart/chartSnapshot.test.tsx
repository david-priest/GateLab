// @vitest-environment jsdom
// The Plotting and Layout charts' drawing, held as snapshots: each chart rendered from a fixed
// synthetic model for every plot type and option that changes what it draws. The chart toolkit
// (src/ui/chart/) was extracted against these; a change to a snapshot is a change to a drawing.
// Synthetic donors D1 to D4, groups control and treated, facets B1 and B2.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CellValueAxis, CellValuesModel, CellViolin } from "../../engine/cellValuesModel";
import { DEFAULT_LAYOUT_STYLE, type LayoutChartRecipe, type LayoutProportionsPanel } from "../../engine/layout";
import { groupPoints, testGroups, type ChartPoint } from "../../engine/layoutChart";
import type { PopulationMap } from "../../engine/models";
import type { SampleComposition } from "../../engine/proportions";
import { CellValuesChart } from "../CellValuesChart";
import { LayoutChart, type ChartData } from "../LayoutChart";
import { ProportionsChart } from "../PlottingTab";
import { StatisticChart } from "../StatisticChart";

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

const draw = (element: JSX.Element): string => {
  act(() => root.render(element));
  return host.innerHTML;
};

const FONTS = { tick: 9, axis: 10, legend: 11 };
const CAT_COLOURS = ["#2f80ed", "#e15759", "#59a14f", "#9c755f"];

// ── Proportions ──────────────────────────────────────────────────────────────

const PER_SAMPLE: SampleComposition[] = [
  { unit: "D1", group: "control", facet: "B1", catCounts: [40, 25, 10, 25] },
  { unit: "D2", group: "control", facet: "B2", catCounts: [35, 30, 12, 23] },
  { unit: "D3", group: "treated", facet: "B1", catCounts: [20, 45, 5, 30] },
  { unit: "D4", group: "treated", facet: "B2", catCounts: [25, 40, 8, 27] },
  { unit: "D5", group: "control", facet: "B1", catCounts: [38, 28, 9, 25] },
  { unit: "D6", group: "treated", facet: "B2", catCounts: [22, 42, 6, 30] },
];
const POP_LEVELS = ["CD4_positive", "CD8_positive", "CD4_memory", "Rest of parent"];
// CD4_memory lies within CD4_positive, so the stacked bar nests it; the fourth category is the rest of the parent.
const POPULATIONS = {
  P: { population_id: "P", name: "T_cells", parent_id: null },
  CD4: { population_id: "CD4", name: "CD4_positive", parent_id: "P" },
  CD8: { population_id: "CD8", name: "CD8_positive", parent_id: "P" },
  MEM: { population_id: "MEM", name: "CD4_memory", parent_id: "CD4" },
} as unknown as PopulationMap;
const LEVELS = [
  { popId: "CD4", depth: 0 },
  { popId: "CD8", depth: 0 },
  { popId: "MEM", depth: 1 },
];

function proportions(over: Partial<Parameters<typeof ProportionsChart>[0]> & { facets?: boolean; rest?: boolean; nested?: boolean } = {}) {
  const { facets = false, rest = false, nested = false, ...props } = over;
  const nCat = rest ? 4 : 3;
  const perSample = PER_SAMPLE.map((s) => ({ ...s, facet: facets ? s.facet : null, catCounts: s.catCounts.slice(0, nCat) }));
  return (
    <ProportionsChart
      plotType="stacked"
      model={{ catLevels: POP_LEVELS.slice(0, nCat), perSample, hasFacet: facets, levels: nested ? LEVELS : undefined }}
      catColors={CAT_COLOURS}
      palette="paired"
      averagePerUnit
      populations={POPULATIONS}
      fonts={FONTS}
      appearance={{ height: 200, showGrid: true, showPoints: true, showLegend: true, pointRadius: 1.5 }}
      valueTitle="% of T_cells"
      groupTitle="condition"
      facetTitle="batch"
      {...props}
    />
  );
}

describe("Proportions chart drawing", () => {
  it("stacked bars", () => expect(draw(proportions())).toMatchSnapshot());
  it("stacked bars with facets", () => expect(draw(proportions({ facets: true }))).toMatchSnapshot());
  it("stacked bars, nested, with the rest of the parent", () => expect(draw(proportions({ nested: true, rest: true }))).toMatchSnapshot());
  it("stacked bars, flat, with the rest of the parent, summed over events", () =>
    expect(draw(proportions({ rest: true, averagePerUnit: false }))).toMatchSnapshot());
  it("stacked bars without gridlines, legend or titles", () =>
    expect(draw(proportions({ appearance: { height: 160, showGrid: false, showPoints: false, showLegend: false, pointRadius: 1 }, valueTitle: undefined, groupTitle: undefined }))).toMatchSnapshot());
  it("stacked bars with long, rotated group labels at a set panel width", () =>
    expect(draw(proportions({
      model: {
        catLevels: POP_LEVELS.slice(0, 3),
        perSample: PER_SAMPLE.map((s) => ({ ...s, facet: null, group: `${s.group}_condition_with_a_long_synthetic_name_${s.unit}`, catCounts: s.catCounts.slice(0, 3) })),
        hasFacet: false,
      },
      arrangement: { panelColumns: "", panelsPerRow: 5, panelWidth: 220 },
    }))).toMatchSnapshot());
  it("box", () => expect(draw(proportions({ plotType: "box" }))).toMatchSnapshot());
  it("box with facets, paired, a column per facet", () =>
    expect(draw(proportions({
      plotType: "box",
      facets: true,
      appearance: { height: 180, showGrid: true, showPoints: true, paired: true, showLegend: true, pointRadius: 2 },
      arrangement: { panelColumns: "facet", panelsPerRow: 5, panelWidth: 0 },
    }))).toMatchSnapshot());
  it("box without points", () =>
    expect(draw(proportions({ plotType: "box", appearance: { height: 200, showGrid: true, showPoints: false, showLegend: true, pointRadius: 1.5 } }))).toMatchSnapshot());
  it("box, one panel", () =>
    expect(draw(proportions({ plotType: "box", only: { population: "CD8_positive", populationId: "CD8" } }))).toMatchSnapshot());
  it("box, the legend alone", () => expect(draw(proportions({ plotType: "box", only: { legend: true } }))).toMatchSnapshot());
  it("stacked bars with n", () => expect(draw(proportions({ showN: true, unitSel: "donor" }))).toMatchSnapshot());
  it("stacked bars with n, long rotated group labels", () =>
    expect(draw(proportions({
      showN: true,
      model: {
        catLevels: POP_LEVELS.slice(0, 3),
        perSample: PER_SAMPLE.map((s) => ({ ...s, facet: null, group: `${s.group}_condition_with_a_long_synthetic_name`, catCounts: s.catCounts.slice(0, 3) })),
        hasFacet: false,
      },
    }))).toMatchSnapshot());
  it("bars with n, facets, a column per facet", () =>
    expect(draw(proportions({ plotType: "bar", facets: true, showN: true, arrangement: { panelColumns: "facet", panelsPerRow: 5, panelWidth: 0 } }))).toMatchSnapshot());
});

// ── Per-cell and statistic models ────────────────────────────────────────────

const ascending = (values: number[]) => Float32Array.from([...values].sort((a, b) => a - b));

/** Cells of three populations in two groups (and two facets), pooled by group or by donor. */
function cellModel(byUnit: boolean, facets = false, catLevels = ["CD4_positive", "CD8_positive", "B_cells"]): CellValuesModel {
  const violins: CellViolin[] = [];
  const donors: Record<string, { group: string; facet: string }> = {
    D1: { group: "control", facet: "B1" },
    D2: { group: "control", facet: "B2" },
    D3: { group: "treated", facet: "B1" },
    D4: { group: "treated", facet: "B2" },
    D5: { group: "control", facet: "B1" },
    D6: { group: "treated", facet: "B2" },
  };
  catLevels.forEach((_, cat) => {
    if (byUnit) {
      Object.entries(donors).forEach(([unit, { group, facet }], ui) => {
        const shift = (group === "treated" ? 40 : 0) + cat * 25 + ui * 3;
        violins.push({ cat, group, facet: facets ? facet : null, unit, values: ascending([10, 14, 18, 22, 30].map((v) => v + shift)), files: [`${unit}.fcs`] });
      });
    } else {
      for (const group of ["control", "treated"])
        for (const facet of facets ? ["B1", "B2"] : [null]) {
          const shift = (group === "treated" ? 0.6 : 0) + cat * 0.4 + (facet === "B2" ? 0.2 : 0);
          const values = Array.from({ length: 40 }, (_, i) => 1 + shift + Math.sin(i * 1.7) * 0.5 + (i % 7) * 0.12);
          violins.push({ cat, group, facet, unit: null, values: ascending(values), files: ["D1.fcs", "D3.fcs"] });
        }
    }
  });
  // One population drawn from a single cell, and one whose cells all lie beyond the axis.
  if (!byUnit) {
    violins.push({ cat: 0, group: "single", facet: facets ? "B1" : null, unit: null, values: ascending([1.5]), files: ["D7.fcs"] });
    violins.push({ cat: 1, group: "single", facet: facets ? "B1" : null, unit: null, values: ascending([9, 9.5, 10]), files: ["D7.fcs"] });
  }
  return {
    catLevels,
    levels: catLevels.map((_, i) => ({ popId: `pop${i}`, depth: 0 })),
    violins,
    hasFacet: facets,
    channelLabel: "CD3 BV421",
    excluded: [],
    noChannel: [],
    extent: [0, 4],
    axisSource: null,
  };
}

const CELL_AXIS: CellValueAxis = {
  range: [0, 4],
  major: [0, 1, 2, 3, 4].map((at) => ({ at, label: at === 0 ? "0" : `10^${at}` })),
  minor: [0.5, 1.5, 2.5, 3.5],
};

function cells(over: Partial<Parameters<typeof CellValuesChart>[0]> & { facets?: boolean } = {}) {
  const { facets = false, ...props } = over;
  return (
    <CellValuesChart
      model={cellModel(false, facets)}
      plotType="violin"
      xAxis="populations"
      violinBox={false}
      axis={CELL_AXIS}
      catColors={CAT_COLOURS}
      palette="paired"
      groupLevels={["control", "treated", "single"]}
      fonts={FONTS}
      appearance={{ height: 180, showGrid: true, showLegend: true }}
      groupTitle="condition"
      facetTitle="batch"
      {...props}
    />
  );
}

describe("Per-cell chart drawing", () => {
  it("violin", () => expect(draw(cells())).toMatchSnapshot());
  it("violin with a box", () => expect(draw(cells({ violinBox: true }))).toMatchSnapshot());
  it("box", () => expect(draw(cells({ plotType: "box" }))).toMatchSnapshot());
  it("violin, groups along x, with facets, a column per facet", () =>
    expect(draw(cells({ xAxis: "groups", facets: true, arrangement: { panelColumns: "facet", panelsPerRow: 5, panelWidth: 0 } }))).toMatchSnapshot());
  it("box without gridlines or legend, at a set panel width", () =>
    expect(draw(cells({ plotType: "box", appearance: { height: 150, showGrid: false, showLegend: false }, arrangement: { panelColumns: "", panelsPerRow: 2, panelWidth: 160 } }))).toMatchSnapshot());
  it("violin with long, rotated population labels and a long panel title", () =>
    expect(draw(cells({
      model: { ...cellModel(false, false, ["CD4_positive_central_memory_synthetic", "CD8_positive_effector_memory_synthetic", "B_cells"]) },
      groupTitle: "condition_with_a_long_synthetic_column_name",
    }))).toMatchSnapshot());
  it("violin, one panel", () => expect(draw(cells({ only: { group: "treated" } as LayoutProportionsPanel }))).toMatchSnapshot());
  it("violin, the legend alone", () => expect(draw(cells({ only: { legend: true } }))).toMatchSnapshot());
  it("violin with n", () => expect(draw(cells({ showN: true }))).toMatchSnapshot());
  it("box with n, long rotated population labels", () =>
    expect(draw(cells({ plotType: "box", showN: true, model: { ...cellModel(false, false, ["CD4_positive_central_memory_synthetic", "CD8_positive_effector_memory_synthetic", "B_cells"]) } }))).toMatchSnapshot());
});

function statistic(over: Partial<Parameters<typeof StatisticChart>[0]> & { facets?: boolean } = {}) {
  const { facets = false, ...props } = over;
  return (
    <StatisticChart
      model={cellModel(true, facets)}
      statistic="median"
      plotType="box"
      errorBar="sd"
      test={false}
      xAxis="groups"
      unitSel="donor"
      catColors={CAT_COLOURS}
      palette="paired"
      groupLevels={["control", "treated"]}
      fonts={FONTS}
      appearance={{ height: 180, showGrid: true, showLegend: true, showPoints: true, pointRadius: 1.5 }}
      groupTitle="condition"
      facetTitle="batch"
      {...props}
    />
  );
}

describe("Statistic chart drawing", () => {
  it("box", () => expect(draw(statistic())).toMatchSnapshot());
  it("box with the test", () => expect(draw(statistic({ test: true }))).toMatchSnapshot());
  it("box without points, gridlines or legend", () =>
    expect(draw(statistic({ appearance: { height: 160, showGrid: false, showLegend: false, showPoints: false, pointRadius: 1 } }))).toMatchSnapshot());
  it("dots with the test", () => expect(draw(statistic({ plotType: "dots", test: true, statistic: "mean" }))).toMatchSnapshot());
  it("bar with SD", () => expect(draw(statistic({ plotType: "bar", statistic: "geomean" }))).toMatchSnapshot());
  it("bar with SEM and the test, without points", () =>
    expect(draw(statistic({ plotType: "bar", errorBar: "sem", test: true, appearance: { height: 180, showGrid: true, showLegend: true, showPoints: false, pointRadius: 1.5 } }))).toMatchSnapshot());
  it("box, populations along x, with facets, a column per group", () =>
    expect(draw(statistic({ xAxis: "populations", facets: true, arrangement: { panelColumns: "groups", panelsPerRow: 5, panelWidth: 0 } }))).toMatchSnapshot());
  it("box, groups along x, with facets, a column per facet, the test", () =>
    expect(draw(statistic({ facets: true, test: true, arrangement: { panelColumns: "facet", panelsPerRow: 5, panelWidth: 200 } }))).toMatchSnapshot());
  it("box, one panel", () => expect(draw(statistic({ only: { population: "CD8_positive", populationId: "pop1" } }))).toMatchSnapshot());
  it("box, the legend alone", () => expect(draw(statistic({ only: { legend: true } }))).toMatchSnapshot());
  it("box with n and the test", () => expect(draw(statistic({ showN: true, test: true }))).toMatchSnapshot());
  it("dots with n, populations along x, a column per group", () =>
    expect(draw(statistic({ plotType: "dots", showN: true, xAxis: "populations", unitSel: "__sample__", arrangement: { panelColumns: "groups", panelsPerRow: 5, panelWidth: 0 } }))).toMatchSnapshot());
});

// ── Layout chart ─────────────────────────────────────────────────────────────

function layoutData(test: boolean, empty = false): ChartData {
  const points: ChartPoint[] = empty
    ? []
    : [
        { sampleId: "D1", name: "D1.fcs", group: "control", value: 12.5 },
        { sampleId: "D2", name: "D2.fcs", group: "control", value: 15.1 },
        { sampleId: "D3", name: "D3.fcs", group: "control", value: 13.8 },
        { sampleId: "D4", name: "D4.fcs", group: "treated", value: 24.2 },
        { sampleId: "D5", name: "D5.fcs", group: "treated", value: 28.9 },
        { sampleId: "D6", name: "D6.fcs", group: "treated", value: 2210 },
      ];
  const groups = groupPoints(points);
  return { points, groups, test: test ? testGroups(groups) : null, population: "CD4_positive", axis: "% of parent", missing: empty ? ["D1.fcs"] : [], noChannel: [] };
}

const layoutRecipe = (over: Partial<LayoutChartRecipe> = {}): LayoutChartRecipe =>
  ({ kind: "chart", sampleId: "D1", populationId: "P", statistic: "percent_of_parent", files: "all", groupBy: "condition", chartType: "bars", showPoints: true, test: true, ...over }) as LayoutChartRecipe;

describe("Layout chart drawing", () => {
  for (const chartType of ["bars", "dots", "box"] as const) {
    it(`${chartType} with the test`, () =>
      expect(draw(<LayoutChart data={layoutData(true)} recipe={layoutRecipe({ chartType })} style={DEFAULT_LAYOUT_STYLE} width={260} height={200} title="CD4_positive" />)).toMatchSnapshot());
  }
  it("bars without points, test or title, in print style", () =>
    expect(draw(<LayoutChart data={layoutData(false)} recipe={layoutRecipe({ showPoints: false, test: false })} style={{ ...DEFAULT_LAYOUT_STYLE, pubStyle: true }} width={180} height={160} title="" />)).toMatchSnapshot());
  it("box with rotated labels", () =>
    expect(draw(<LayoutChart data={{ ...layoutData(false), groups: layoutData(false).groups.map((g) => ({ ...g, label: `${g.label}_with_a_long_synthetic_name` })) }} recipe={layoutRecipe({ chartType: "box", test: false })} style={DEFAULT_LAYOUT_STYLE} width={160} height={200} title="CD4_positive" />)).toMatchSnapshot());
  it("no files", () =>
    expect(draw(<LayoutChart data={layoutData(false, true)} recipe={layoutRecipe()} style={DEFAULT_LAYOUT_STYLE} width={200} height={150} title="CD4_positive" />)).toMatchSnapshot());
});
