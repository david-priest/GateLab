// @vitest-environment jsdom
// The Plotting settings an Illustration figure's chart plot carries take effect in its panel as
// they do in a Layout block made from the panel (figureChartRecipe drawn by
// LayoutProportionsSurface): each is asserted on the figure's panel and on the block. A setting
// that cannot take effect in one panel of a figure is ignored, not half applied. Synthetic files
// D1, D2 and D3, conditions control and treated; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import {
  figureHierarchies,
  layoutFigure,
  migrateFigure,
  prepareFigureSource,
  type FigureChart,
  type FigurePanel,
  type FigurePopulation,
  type FigureSample,
  type FigureSpec,
} from "../engine/figure";
import { defaultIllustrationConfig } from "../engine/figureDefaults";
import type { IllustrationConfig } from "../engine/workspace";
import { buildFigureChartPanel, type FigureChartData } from "./figureChartData";
import { FigureChartPanel, figureStatisticAxes } from "./FigureChartPanel";
import { summaryFrame } from "./FigureGrid";
import { figureChartRecipe } from "./figureLayoutRecipes";
import { LayoutProportionsSurface } from "./LayoutProportions";

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

// Each event is [FITC-A (CD4), PE-A (CD8), FSC-A]; the quadrant's centre is 1000, 1000.
// D1 (control): CD8_positive 3 (FSC 10, 20, 30), double_positive 1, CD4_positive 4 (50-80).
// D2 (treated): CD8_positive 1 (15), CD4_positive 2 (55, 65), double_negative 2.
// D3 (treated): CD8_positive 2 (25, 35), CD4_positive 1 (75).
// D4 (control): CD8_positive 1 (45), CD4_positive 1 (85); drawn only where a case names it.
type Event = [number, number, number];
const LOW = 100;
const HIGH = 5000;
const EVENTS: Record<string, Event[]> = {
  D1: [
    [LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30],
    [HIGH, HIGH, 40],
    [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80],
  ],
  D2: [[LOW, HIGH, 15], [HIGH, LOW, 55], [HIGH, LOW, 65], [LOW, LOW, 90], [LOW, LOW, 100]],
  D3: [[LOW, HIGH, 25], [LOW, HIGH, 35], [HIGH, LOW, 75]],
  D4: [[LOW, HIGH, 45], [HIGH, LOW, 85]],
};
const METADATA: Record<string, Record<string, string>> = { D1: { condition: "control" }, D2: { condition: "treated" }, D3: { condition: "treated" }, D4: { condition: "control" } };

function file(id: string): FigureSample {
  const events = EVENTS[id];
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
  return { id, name: `${id}.fcs`, sample: new Sample(fcs), hierarchyId: DEFAULT_HIERARCHY_ID, metadata: METADATA[id] };
}

function workspace() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 8 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "CD8",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["CD8_positive", "double_positive", "CD4_positive", "double_negative"],
  });
  const core = state as CoreState;
  const trees = figureHierarchies(core);
  const samples = ["D1", "D2", "D3", "D4"].map(file);
  const sources = samples.map((entry) => prepareFigureSource(entry, trees[entry.hierarchyId], core));
  const ref = (name: string): FigurePopulation => ({
    hierarchyId: DEFAULT_HIERARCHY_ID,
    populationId: Object.values(core.populations).find((p) => p.name === name)!.population_id,
    label: name,
  });
  return { core, trees, samples, sources, ref };
}

interface Case {
  chart: FigureChart;
  files?: string[];
  populations?: string[];
  columns?: FigureSpec["columns"];
  composition?: FigureSpec["composition"];
}

const SIZE = 200;

/** The figure's first drawn panel of the case, built as the figure builds it. */
function built(c: Case) {
  const ws = workspace();
  const figure: FigureSpec = {
    ...migrateFigure(null, ws.samples, ws.trees, DEFAULT_HIERARCHY_ID, "FSC-A", "FSC-A"),
    sampleIds: c.files ?? ["D1", "D2", "D3"],
    populations: [ws.ref("CD4_positive")],
    plots: [{ id: "chart", name: "Chart", x: "FSC-A", y: "FSC-A", type: "chart", chart: c.chart, populations: (c.populations ?? ["CD8_positive", "CD4_positive"]).map(ws.ref) }],
    rows: ["plots"],
    columns: c.columns ?? ["samples"],
    pages: [],
    composition: c.composition ?? "pool",
    panelSize: SIZE,
  };
  const config: IllustrationConfig = { ...defaultIllustrationConfig(), figure };
  const page = layoutFigure(figure, ws.samples, ws.trees)[0];
  const drawn = page.panels.filter((panel) => panel.samples.length);
  const data = Object.fromEntries(drawn.map((panel) => [panel.key, buildFigureChartPanel(panel, figure, ws.sources, ws.trees, { state: ws.core })]));
  const axes = figureStatisticAxes(page.panels, data, config);
  return { ws, figure, config, panel: drawn[0], data, axes };
}

/** The figure's panel as drawn: its chart's svg. */
function figurePanel(b: ReturnType<typeof built>, panel: FigurePanel = b.panel): SVGSVGElement {
  act(() =>
    root.render(
      <FigureChartPanel chart={panel.plot.chart!} data={b.data[panel.key]} config={b.config} size={SIZE} containerId="figure-chart" valueAxis={b.axes.get(panel.key)} frame={summaryFrame(panel, SIZE)} />,
    ),
  );
  return host.querySelector<SVGSVGElement>(".gl-figure-chart svg.gl-prop-panel")!;
}

/** The Layout block made from the panel (figureChartRecipe), as LayoutProportionsSurface draws it: its chart's svg. */
function blockPanel(b: ReturnType<typeof built>, panel: FigurePanel = b.panel): SVGSVGElement {
  const recipe = figureChartRecipe(panel, b.figure, b.config, () => true, b.ws.trees)!;
  act(() =>
    root.render(
      <LayoutProportionsSurface recipe={recipe} samples={b.ws.samples} state={b.ws.core} metadataById={METADATA} divisionProfiles={{}} width={2000} height={2000} containerId="block-chart" />,
    ),
  );
  return host.querySelector<SVGSVGElement>("svg.gl-prop-panel")!;
}

/** The panel drawn by the figure and by the block, read the same way. */
function both<T>(c: Case, read: (svg: SVGSVGElement) => T): { figure: T; block: T } {
  const b = built(c);
  return { figure: read(figurePanel(b)), block: read(blockPanel(b)) };
}

const texts = (svg: Element) => [...svg.querySelectorAll("text")].map((t) => [...t.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(""));
const nTexts = (svg: Element) => texts(svg).filter((t) => /^n = /.test(t));
const gridLines = (svg: Element) => svg.querySelectorAll('line[stroke="#eee"]').length;
const tips = (svg: Element) => [...svg.querySelectorAll(".gl-prop-mark title")].map((t) => t.textContent ?? "");
/** The value axis's tick labels: the texts that are numbers. */
const ticks = (svg: Element) => texts(svg).filter((t) => t !== "" && Number.isFinite(Number(t.replace(/,/g, "")))).map((t) => Number(t.replace(/,/g, "")));

const CELLS: FigureChart = { valueKind: "cells", plotType: "violin" };
const STATISTIC: FigureChart = { valueKind: "statistic", plotType: "box", statistic: "median" };
const PROPORTION: FigureChart = { valueKind: "proportion", plotType: "stacked" };

describe("A figure's chart panel drawn with the settings its chart carries", () => {
  it("writes n under its marks with showN, as the block does", () => {
    expect(nTexts(figurePanel(built({ chart: CELLS, files: ["D1"] })))).toEqual([]);
    const drawn = both({ chart: { ...CELLS, showN: true }, files: ["D1"] }, nTexts);
    // D1: CD8_positive 3 cells, CD4_positive 4.
    expect(drawn.figure).toEqual(["n = 3", "n = 4"]);
    expect(drawn.block).toEqual(drawn.figure);
  });

  it("draws grid lines with grid, as the block does", () => {
    expect(gridLines(figurePanel(built({ chart: CELLS, files: ["D1"] })))).toBe(0);
    const drawn = both({ chart: { ...CELLS, grid: true }, files: ["D1"] }, gridLines);
    expect(drawn.figure).toBeGreaterThan(0);
    expect(drawn.block).toBeGreaterThan(0);
  });

  it("still draws a violin without its box, and a box, from the chart's own fields", () => {
    const marks = (svg: Element) => svg.querySelectorAll("*").length;
    const withBox = both({ chart: CELLS, files: ["D1"] }, marks);
    const without = both({ chart: { ...CELLS, violinBox: false }, files: ["D1"] }, marks);
    expect(without.figure).toBeLessThan(withBox.figure);
    expect(without).toEqual({ figure: without.block, block: without.block });
    expect(withBox.block).toBe(withBox.figure);
    const box = both({ chart: { ...CELLS, plotType: "box" }, files: ["D1"] }, (svg) => svg.querySelectorAll("rect.gl-prop-mark").length);
    expect(box.figure).toBe(2);
    expect(box.block).toBe(box.figure);
  });

  it("sets the value axis from valueMin and valueMax, as the block does", () => {
    const cells = both({ chart: { ...CELLS, valueMin: 20, valueMax: 70 }, files: ["D1"] }, ticks);
    expect(Math.min(...cells.figure)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...cells.figure)).toBeLessThanOrEqual(70);
    expect(cells.block).toEqual(cells.figure);
    // A statistic's axis shared across the figure's panels keeps the limits too.
    const statistic = both({ chart: { ...STATISTIC, valueMin: 0, valueMax: 200 } }, ticks);
    expect(Math.max(...statistic.figure)).toBe(200);
    expect(statistic.block).toEqual(statistic.figure);
  });

  it("draws the standard error with errorBar sem, as the block does", () => {
    // Two files: points, each a mean with its error bar.
    const drawn = both({ chart: { ...STATISTIC, errorBar: "sem" }, files: ["D1", "D2"] }, tips);
    expect(drawn.figure.length).toBeGreaterThan(0);
    expect(drawn.figure.every((tip) => tip.includes("± SEM"))).toBe(true);
    expect(drawn.block).toEqual(drawn.figure);
    expect(tips(figurePanel(built({ chart: STATISTIC, files: ["D1", "D2"] }))).every((tip) => tip.includes("± SD"))).toBe(true);
  });

  it("draws the rank test between two groups of files with xAxis groups and test, as the block does", () => {
    // control: D1 and D4; treated: D2 and D3; CD4_positive's median FSC in each file.
    const chart: FigureChart = { ...STATISTIC, xAxis: "groups", test: true, groupSel: "condition" };
    const files = ["D1", "D2", "D3", "D4"];
    const test = (svg: Element) => [...svg.querySelectorAll(".gl-prop-test")].map((t) => t.textContent);
    expect(test(figurePanel(built({ chart: STATISTIC, files, populations: ["CD4_positive"] })))).toEqual([]);
    const drawn = both({ chart, files, populations: ["CD4_positive"] }, test);
    expect(drawn.figure).toHaveLength(1);
    expect(drawn.figure[0]).toMatch(/p/);
    expect(drawn.block).toEqual(drawn.figure);
    // The groups are named under their marks.
    expect(texts(figurePanel(built({ chart, files, populations: ["CD4_positive"] })))).toEqual(expect.arrayContaining(["control", "treated"]));
  });

  it("colours each mark by its population with colourByPopulation, as the block does", () => {
    const fills = (svg: Element) => new Set([...svg.querySelectorAll("rect.gl-prop-mark")].map((r) => r.getAttribute("fill"))).size;
    const chart: FigureChart = { ...STATISTIC, xAxis: "groups", groupSel: "condition", populationsTogether: true };
    // Every population together at each group, coloured by population: one population, one colour.
    expect(both({ chart, populations: ["CD4_positive"] }, fills)).toEqual({ figure: 1, block: 1 });
    const byGroup = both({ chart: { ...chart, populationsTogether: undefined }, populations: ["CD4_positive"] }, fills);
    // A panel per population, coloured by group: the two groups' marks take two colours.
    expect(byGroup).toEqual({ figure: 2, block: 2 });
    const byPopulation = both({ chart: { ...chart, populationsTogether: undefined, colourByPopulation: true }, populations: ["CD4_positive"] }, fills);
    expect(byPopulation).toEqual({ figure: 1, block: 1 });
  });

  it("draws each replicate unit's median over a per-cell chart with replicateMarks, as the block does", () => {
    const units = (svg: Element) => svg.querySelectorAll(".gl-prop-replicate").length;
    expect(units(figurePanel(built({ chart: CELLS })))).toBe(0);
    const drawn = both({ chart: { ...CELLS, replicateMarks: "median" } }, units);
    // Two populations in each of three files.
    expect(drawn.figure).toBe(6);
    expect(drawn.block).toBe(drawn.figure);
  });

  it("drops the rest of the parent from a composition with includeUngated off, as the block does", () => {
    const b = built({ chart: { ...PROPORTION, includeUngated: false } });
    const data = b.data[b.panel.key].config!.chart as FigureChartData;
    expect(data.proportions!.catLevels).toEqual(["CD8_positive", "CD4_positive"]);
    // D1: 3 and 4 of 7; D2: 1 and 2 of 3; D3: 2 and 1 of 3, no remainder.
    expect(data.proportions!.perSample.map((row) => row.catCounts)).toEqual([[3, 4], [1, 2], [2, 1]]);
    const bars = (svg: Element) => svg.querySelectorAll("rect.gl-prop-mark").length;
    const drawn = { figure: bars(figurePanel(b)), block: bars(blockPanel(b)) };
    expect(drawn.figure).toBe(6);
    expect(drawn.block).toBe(drawn.figure);
    // With the rest: D3's is empty and drawn as no bar.
    expect(bars(figurePanel(built({ chart: PROPORTION })))).toBe(8);
  });

  it("ignores a legend: the figure names the populations under the plot's first panel", () => {
    const markup = (chart: FigureChart) => {
      figurePanel(built({ chart, files: ["D1"] }));
      return host.innerHTML;
    };
    expect(markup({ ...CELLS, legend: true })).toBe(markup(CELLS));
  });

  it("ignores an arrangement that would draw the panel's cells in several panels", () => {
    const markup = (chart: FigureChart) => {
      const b = built({ chart, files: ["D1"] });
      expect((b.data[b.panel.key].config!.chart as FigureChartData).settings.xAxis).toBe("populations");
      figurePanel(b);
      return host.innerHTML;
    };
    // Two populations with the groups along x would be a panel per population.
    expect(markup({ ...CELLS, xAxis: "groups" })).toBe(markup(CELLS));
  });
});
