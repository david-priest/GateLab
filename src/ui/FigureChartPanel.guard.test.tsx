// @vitest-environment jsdom
// An Illustration figure's chart panel as drawn, held as snapshots: each panel built by
// buildFigureChartPanel from a counted synthetic workspace and drawn by FigureChartPanel, for every
// chart kind and figure option that changes the drawing. A figure whose charts carry no settings of
// their own draws what these hold. Synthetic files D1, D2 and D3, conditions control and treated;
// nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import {
  figureHierarchies,
  figureRanges,
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
import { buildFigureChartPanel } from "./figureChartData";
import { chartLeftMargin, FigureChartPanel, figureStatisticAxes } from "./FigureChartPanel";
import { summaryFrame } from "./FigureGrid";

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
type Event = [number, number, number];
const LOW = 100;
const HIGH = 5000;
// D1 (control): CD8_positive 3, double_positive 1, CD4_positive 4, double_negative 0.
// D2 (treated): CD8_positive 1, double_positive 0, CD4_positive 2, double_negative 2.
// D3 (treated): CD8_positive 2, double_positive 0, CD4_positive 1, double_negative 0.
const EVENTS: Record<string, Event[]> = {
  D1: [
    [LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30],
    [HIGH, HIGH, 40],
    [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80],
  ],
  D2: [[LOW, HIGH, 15], [HIGH, LOW, 55], [HIGH, LOW, 65], [LOW, LOW, 90], [LOW, LOW, 100]],
  D3: [[LOW, HIGH, 25], [LOW, HIGH, 35], [HIGH, LOW, 75]],
};
const CONDITION: Record<string, string> = { D1: "control", D2: "treated", D3: "treated" };

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
  return { id, name: `${id}.fcs`, sample: new Sample(fcs), hierarchyId: DEFAULT_HIERARCHY_ID, metadata: { condition: CONDITION[id] } };
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
  const samples = ["D1", "D2", "D3"].map(file);
  const sources = samples.map((entry) => prepareFigureSource(entry, trees[entry.hierarchyId], core));
  const ref = (name: string): FigurePopulation => ({
    hierarchyId: DEFAULT_HIERARCHY_ID,
    populationId: Object.values(core.populations).find((p) => p.name === name)!.population_id,
    label: name,
  });
  return { core, trees, samples, sources, ref };
}
type Workspace = ReturnType<typeof workspace>;

interface Case {
  files?: string[];
  chart: FigureChart;
  populations?: string[];
  rows?: FigureSpec["rows"];
  columns?: FigureSpec["columns"];
  composition?: FigureSpec["composition"];
  scalePolicy?: FigureSpec["scalePolicy"];
  samplePopulations?: (ws: Workspace) => FigureSpec["samplePopulations"];
  config?: Partial<IllustrationConfig>;
  /** Build with the figure's shared channel ranges (figureRanges). */
  sharedRanges?: boolean;
}

const SIZE = 200;
const QUADRANTS = ["CD8_positive", "double_positive", "CD4_positive", "double_negative"];

function figureOf(ws: Workspace, c: Case): FigureSpec {
  return {
    ...migrateFigure(null, ws.samples, ws.trees, DEFAULT_HIERARCHY_ID, "FSC-A", "FSC-A"),
    sampleIds: c.files ?? ["D1", "D2", "D3"],
    populations: [ws.ref("CD4_positive")],
    plots: [{ id: "chart", name: "Chart", x: "FSC-A", y: "FSC-A", type: "chart", chart: c.chart, populations: (c.populations ?? QUADRANTS).map(ws.ref) }],
    rows: c.rows ?? ["plots"],
    columns: c.columns ?? ["samples"],
    pages: [],
    composition: c.composition ?? "separate",
    panelSize: SIZE,
    ...(c.scalePolicy ? { scalePolicy: c.scalePolicy } : {}),
    ...(c.samplePopulations ? { samplePopulations: c.samplePopulations(ws) } : {}),
  };
}

/** The figure's drawn panels, each built as the figure builds it, with the page's statistic axes. */
function built(c: Case) {
  const ws = workspace();
  const figure = figureOf(ws, c);
  const config: IllustrationConfig = { ...defaultIllustrationConfig(), ...c.config, figure };
  const ranges = c.sharedRanges ? figureRanges(ws.sources, figure) : {};
  const page = layoutFigure(figure, ws.samples, ws.trees)[0];
  const drawn = page.panels.filter((panel) => panel.samples.length);
  const data = Object.fromEntries(drawn.map((panel) => [panel.key, buildFigureChartPanel(panel, figure, ws.sources, ws.trees, { state: ws.core }, ranges)]));
  const axes = figureStatisticAxes(page.panels, data, config);
  return { ws, figure, config, page, drawn, data, axes };
}

/** The chart's markup as FigureChartPanel draws it for a panel. */
function draw(b: ReturnType<typeof built>, panel: FigurePanel): string {
  act(() =>
    root.render(
      <FigureChartPanel
        chart={panel.plot.chart!}
        data={b.data[panel.key]}
        config={b.config}
        size={SIZE}
        containerId="guard-chart"
        showLegend
        valueAxis={b.axes.get(panel.key)}
        frame={summaryFrame(panel, SIZE)}
      />,
    ),
  );
  const chart = host.querySelector(".gl-figure-chart");
  expect(chart).not.toBeNull();
  return host.innerHTML;
}

/** Every drawn panel of the case's first page, as markup. */
const drawAll = (c: Case) => {
  const b = built(c);
  return b.drawn.map((panel) => draw(b, panel));
};

const CELLS: FigureChart = { valueKind: "cells", plotType: "violin" };
const BOX: FigureChart = { valueKind: "cells", plotType: "box" };
const STATISTIC: FigureChart = { valueKind: "statistic", plotType: "box", statistic: "median" };
const PROPORTION: FigureChart = { valueKind: "proportion", plotType: "stacked" };

describe("An Illustration chart panel as drawn (guard)", () => {
  it("counts what the fixture's comment says", () => {
    const ws = workspace();
    expect(ws.samples.map((entry) => QUADRANTS.map((name) => recompute(entry.sample, ws.core).populations[ws.ref(name).populationId].event_count))).toEqual([
      [3, 1, 4, 0],
      [1, 0, 2, 2],
      [2, 0, 1, 0],
    ]);
  });

  it("a violin, a panel per file", () => {
    expect(drawAll({ chart: CELLS, files: ["D1", "D2"] })).toMatchSnapshot();
  });

  it("a box", () => {
    expect(drawAll({ chart: BOX, files: ["D1"] })).toMatchSnapshot();
  });

  it("a violin without its box", () => {
    expect(drawAll({ chart: { ...CELLS, violinBox: false }, files: ["D1"] })).toMatchSnapshot();
  });

  it("a statistic of two files and of three", () => {
    expect(drawAll({ chart: STATISTIC, files: ["D1", "D2"], composition: "pool" })).toMatchSnapshot();
    expect(drawAll({ chart: STATISTIC, files: ["D1", "D2", "D3"], composition: "pool" })).toMatchSnapshot();
  });

  it("a composition of one file and of several", () => {
    expect(drawAll({ chart: PROPORTION, files: ["D1"], populations: ["CD8_positive", "CD4_positive"] })).toMatchSnapshot();
    expect(drawAll({ chart: PROPORTION, composition: "pool", populations: ["CD8_positive", "CD4_positive"] })).toMatchSnapshot();
  });

  it("populations without their names", () => {
    expect(drawAll({ chart: { ...CELLS, populationLabels: false }, files: ["D1"] })).toMatchSnapshot();
    expect(drawAll({ chart: { ...STATISTIC, populationLabels: false }, composition: "pool" })).toMatchSnapshot();
  });

  for (const [name, chart] of [["cells", CELLS], ["statistic", STATISTIC], ["proportion", PROPORTION]] as const)
    for (const populations of [["CD8_positive"], ["CD8_positive", "CD4_positive"]])
      it(`a ${name} summary of ${populations.length === 1 ? "one population" : "two populations"}, the files down the rows`, () => {
        expect(drawAll({ chart: { ...chart, summary: true }, populations, rows: ["samples"], columns: ["plots"] })).toMatchSnapshot();
      });

  it("a summary without its file labels", () => {
    expect(drawAll({ chart: { ...CELLS, summary: true, fileLabels: false }, populations: ["CD8_positive", "CD4_positive"], rows: ["samples"], columns: ["plots"] })).toMatchSnapshot();
  });

  it("a summary grouped by a metadata column, spanning its columns", () => {
    const c: Case = { chart: { ...STATISTIC, summary: true, fileLabels: true }, populations: ["CD8_positive", "CD4_positive"], columns: ["metadata:condition", "samples"], composition: "pool" };
    const b = built(c);
    expect(b.drawn).toHaveLength(1);
    expect(b.drawn[0].span).toEqual({ rows: 1, columns: 2 });
    expect(b.drawn.map((panel) => draw(b, panel))).toMatchSnapshot();
    expect(chartLeftMargin(b.drawn[0].plot.chart!, b.data[b.drawn[0].key].config!.chart as never, b.config, SIZE, b.axes.get(b.drawn[0].key))).toMatchSnapshot();
  });

  for (const [name, chart] of [["cells", CELLS], ["box", BOX], ["statistic", STATISTIC], ["proportion", PROPORTION]] as const)
    it(`a ${name} summary spanning the columns`, () => {
      const b = built({ chart: { ...chart, summary: true }, populations: ["CD8_positive", "CD4_positive"] });
      expect(b.drawn).toHaveLength(1);
      expect(summaryFrame(b.drawn[0], SIZE)?.columns).toEqual({ count: 3, pitch: SIZE + 12 });
      expect(b.drawn.map((panel) => draw(b, panel))).toMatchSnapshot();
      expect(chartLeftMargin(b.drawn[0].plot.chart!, b.data[b.drawn[0].key].config!.chart as never, b.config, SIZE, b.axes.get(b.drawn[0].key))).toMatchSnapshot();
    });

  it("in the publication style", () => {
    expect(drawAll({ chart: CELLS, files: ["D1"], config: { pubStyle: true } })).toMatchSnapshot();
    expect(drawAll({ chart: STATISTIC, composition: "pool", config: { pubStyle: true } })).toMatchSnapshot();
  });

  it("with the figure's fonts scaled with the panel", () => {
    expect(drawAll({ chart: CELLS, files: ["D1"], config: { scaleFontsWithPlot: true } })).toMatchSnapshot();
    expect(drawAll({ chart: PROPORTION, files: ["D1"], config: { scaleFontsWithPlot: true } })).toMatchSnapshot();
  });

  it("on the figure's shared value range, and with each file's axes its own", () => {
    expect(drawAll({ chart: CELLS, files: ["D1", "D2"], sharedRanges: true })).toMatchSnapshot();
    expect(drawAll({ chart: CELLS, files: ["D1", "D2"], sharedRanges: true, scalePolicy: "individual" })).toMatchSnapshot();
  });

  it("a statistic plot's panels on one value axis, or each its own", () => {
    const shared = built({ chart: STATISTIC, populations: ["CD8_positive", "CD4_positive"], columns: ["metadata:condition"] });
    expect(shared.drawn).toHaveLength(2);
    expect([...shared.axes.entries()]).toMatchSnapshot();
    expect(shared.drawn.map((panel) => draw(shared, panel))).toMatchSnapshot();
    const own = built({ chart: STATISTIC, populations: ["CD8_positive", "CD4_positive"], columns: ["metadata:condition"], scalePolicy: "individual" });
    expect(own.axes.size).toBe(0);
    expect(own.drawn.map((panel) => draw(own, panel))).toMatchSnapshot();
  });

  it("the left margin of each kind of panel", () => {
    const margins = ([["cells", CELLS], ["box", BOX], ["statistic", STATISTIC], ["proportion", PROPORTION]] as const).map(([name, chart]) => {
      const b = built({ chart, files: ["D1", "D2"], composition: "pool" });
      return [name, chartLeftMargin(chart, b.data[b.drawn[0].key].config!.chart as never, b.config, SIZE, b.axes.get(b.drawn[0].key))];
    });
    expect(margins).toMatchSnapshot();
  });

  it("a panel with a note", () => {
    const b = built({
      chart: CELLS, files: ["D1", "D2"], composition: "pool", populations: ["CD8_positive", "CD4_positive"],
      samplePopulations: (ws) => ({ D1: [ws.ref("CD8_positive"), ws.ref("CD4_positive")], D2: [ws.ref("CD4_positive")] }),
    });
    expect(b.data[b.drawn[0].key].note).toBe("Not drawn in every file: CD8_positive");
    expect(b.drawn.map((panel) => draw(b, panel))).toMatchSnapshot();
  });
});
