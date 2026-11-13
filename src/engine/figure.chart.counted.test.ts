// An Illustration figure with a chart plot: a row of histograms over a row of violins of the same
// files, the two rows sharing columns. Synthetic files D1 and D2; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { isFigureSpec } from "./figureSchema";
import { defaultIllustrationConfig, figureStyle } from "./figureDefaults";
import {
  buildFigurePanel,
  figureHierarchies,
  layoutFigure,
  migrateFigure,
  prepareFigureSource,
  type FigurePopulation,
  type FigureSample,
  type FigureSpec,
} from "./figure";

// Each event is [FITC-A (CD4), PE-A (CD8), FSC-A]; the quadrant's centre is at 1000, 1000.
type Event = [number, number, number];
const LOW = 100;
const HIGH = 5000;

function file(id: string, events: Event[]): FigureSample {
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
  return { id, name: `${id}.fcs`, sample: new Sample(fcs), hierarchyId: DEFAULT_HIERARCHY_ID, metadata: {} };
}

// D1: CD8 SP 3, DP 1, CD4 SP 4. D2: CD8 SP 1, CD4 SP 2, DN 2.
const D1 = file("D1", [
  [LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30],
  [HIGH, HIGH, 40],
  [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80],
]);
const D2 = file("D2", [[LOW, HIGH, 15], [HIGH, LOW, 55], [HIGH, LOW, 65], [LOW, LOW, 90], [LOW, LOW, 100]]);

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
    Object.values(core.populations).find((p) => p.gate_refs.some((r) => r.gate_id === gate.gate_id && r.quadrant === q))!,
  );
  const trees = figureHierarchies(core);
  const samples = [D1, D2];
  const refs: FigurePopulation[] = quadrants.map((p) => ({ hierarchyId: core.active_hierarchy_id, populationId: p.population_id, label: p.name }));
  const figure: FigureSpec = {
    ...migrateFigure(null, samples, trees, core.active_hierarchy_id, "CD4", "CD8"),
    sampleIds: ["D2", "D1"],
    populations: [refs[2]],
    plots: [
      { id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram" },
      { id: "violin", name: "FSC-A violin", x: "FSC-A", y: "FSC-A", type: "chart", chart: { valueKind: "cells", plotType: "violin" } },
    ],
    rows: ["populations", "plots"],
    columns: ["samples"],
    pages: [],
    composition: "separate",
  };
  return { state: core, quadrants, trees, samples, figure, refs };
}

describe("A figure with a chart plot", () => {
  it("puts each violin panel in the column of its file's histogram, in the file list's order, drawn from the gate's events", () => {
    const fx = fixture();
    expect(isFigureSpec(fx.figure)).toBe(true);
    const [page] = layoutFigure(fx.figure, fx.samples, fx.trees);
    expect(page.columns.map((column) => column[0].label)).toEqual(["D2.fcs", "D1.fcs"]);
    const at = (plot: string) => page.panels.filter((p) => p.plot.id === plot).map((p) => [p.row, p.column, p.samples]);
    expect(at("size")).toEqual([[0, 0, ["D2"]], [0, 1, ["D1"]]]);
    expect(at("violin")).toEqual([[1, 0, ["D2"]], [1, 1, ["D1"]]]);
    const style = figureStyle(defaultIllustrationConfig());
    for (const entry of fx.samples) {
      const source = prepareFigureSource(entry, fx.trees[fx.state.active_hierarchy_id], fx.state);
      const gated = recompute(entry.sample, fx.state).populations[fx.quadrants[2].population_id].event_count;
      const histogram = page.panels.find((p) => p.plot.id === "size" && p.samples[0] === entry.id)!;
      const violin = page.panels.find((p) => p.plot.id === "violin" && p.samples[0] === entry.id)!;
      expect(buildFigurePanel(histogram, fx.figure, [source], fx.trees, style, {}, true).config!.n_events).toBe(gated);
      // The violin panel draws the same population of the same file: the mask the figure resolved
      // holds the gate's events (CD4 SP: 4 in D1, 2 in D2).
      expect(violin.population).toEqual(fx.refs[2]);
      const mask = source.gating.masks[violin.population.populationId];
      expect(mask.reduce((n, v) => n + v, 0)).toBe(gated);
      expect(gated).toBe(entry.id === "D1" ? 4 : 2);
      // It is never built as a flow plot.
      const chart = buildFigurePanel(violin, fx.figure, [source], fx.trees, style, {}, true);
      expect(chart.config).toBeNull();
      expect(chart.problem).toBeTruthy();
    }
  });

  it("is saved and loaded unchanged, and lays out the same", () => {
    const fx = fixture();
    const saved = JSON.parse(JSON.stringify({ figure: fx.figure }));
    const loaded = migrateFigure(saved, fx.samples, fx.trees, fx.state.active_hierarchy_id, "CD4", "CD8");
    expect(loaded.plots[1]).toEqual(fx.figure.plots[1]);
    expect(layoutFigure(loaded, fx.samples, fx.trees)).toEqual(layoutFigure(fx.figure, fx.samples, fx.trees));
  });

  it("draws a chart with its own populations once along the figure's populations", () => {
    const fx = fixture();
    fx.figure.populations = [fx.refs[0], fx.refs[2]];
    fx.figure.plots[1] = { ...fx.figure.plots[1], populations: [fx.refs[0], fx.refs[2]] };
    const [page] = layoutFigure(fx.figure, fx.samples, fx.trees);
    const violins = page.panels.filter((p) => p.plot.id === "violin" && p.samples.length);
    expect(violins.map((p) => p.samples[0])).toEqual(["D2", "D1"]);
    expect(violins.every((p) => p.populations?.map((r) => r.label).join() === "CD8 SP,CD4 SP")).toBe(true);
    expect(page.panels.filter((p) => p.plot.id === "size" && p.samples.length)).toHaveLength(4);
  });

  it("refuses a chart plot without its chart, or with a plot type its kind does not draw", () => {
    const fx = fixture();
    const withPlot = (plot: unknown) => ({ ...fx.figure, plots: [fx.figure.plots[0], plot] });
    expect(isFigureSpec(withPlot({ ...fx.figure.plots[1], chart: undefined }))).toBe(false);
    expect(isFigureSpec(withPlot({ ...fx.figure.plots[1], chart: { valueKind: "cells", plotType: "stacked" } }))).toBe(false);
    expect(isFigureSpec(withPlot({ ...fx.figure.plots[1], chart: { valueKind: "statistic", plotType: "box", statistic: "mode" } }))).toBe(false);
    expect(isFigureSpec(withPlot({ ...fx.figure.plots[1], chart: { valueKind: "proportion", plotType: "stacked", populationLabels: false } }))).toBe(true);
    // A figure saved without chart plots is unchanged by them.
    expect(isFigureSpec({ ...fx.figure, plots: [fx.figure.plots[0]] })).toBe(true);
  });
});
