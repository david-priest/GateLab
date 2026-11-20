// A summary heatmap plot with several channels: each channel's summary must be the one a
// one-channel plot of that channel gives, over the same gated events. Synthetic files D1 and D2,
// gated by a drawn quadrant; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { isFigureSpec } from "./figureSchema";
import { defaultIllustrationConfig, figureStyle } from "./figureDefaults";
import { buildHeatmapMatrix } from "./figureHeatmap";
import {
  buildFigurePanel,
  captureFigureTransforms,
  figureHierarchies,
  heatmapChannels,
  layoutFigure,
  migrateFigure,
  prepareFigureSource,
  type FigurePanelData,
  type FigurePlot,
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

// D1: CD8 SP 3, DP 1, CD4 SP 4 (FSC 50, 60, 70, 80). D2: CD8 SP 1, CD4 SP 2 (FSC 55, 65), DN 2.
const D1 = file("D1", [
  [LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30],
  [HIGH, HIGH, 40],
  [HIGH, LOW, 50], [HIGH + 1000, LOW, 60], [HIGH + 2000, LOW, 70], [HIGH + 3000, LOW, 80],
]);
const D2 = file("D2", [[LOW, HIGH, 15], [HIGH, LOW, 55], [HIGH + 500, LOW, 65], [LOW, LOW, 90], [LOW, LOW, 100]]);

const CHANNELS = ["FSC-A", "CD4", "CD8"];

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
  const heatmap: FigurePlot = { id: "heat", name: "Heatmap", x: CHANNELS[0], y: "", type: "heatmap", channels: CHANNELS };
  const figure: FigureSpec = {
    ...migrateFigure(null, samples, trees, core.active_hierarchy_id, "CD4", "CD8"),
    sampleIds: ["D1", "D2"],
    populations: [refs[2], refs[0]],
    plots: [heatmap],
    rows: ["populations", "plots"],
    columns: ["samples"],
    pages: [],
    composition: "separate",
  };
  return { state: core, quadrants, trees, samples, figure, refs };
}

const style = figureStyle(defaultIllustrationConfig());

describe("A summary heatmap plot with several channels", () => {
  it("summarises each channel over the gate's events as a one-channel plot of it does", () => {
    const fx = fixture();
    expect(isFigureSpec(fx.figure)).toBe(true);
    const figure = captureFigureTransforms(fx.figure, fx.samples);
    expect(Object.keys(figure.transforms).sort()).toEqual([...CHANNELS].sort());
    const [page] = layoutFigure(figure, fx.samples, fx.trees);
    // One panel per population and file: the channels are not panels.
    expect(page.panels.filter((p) => p.samples.length)).toHaveLength(4);
    const sources = fx.samples.map((entry) => prepareFigureSource(entry, fx.trees[fx.state.active_hierarchy_id], fx.state));
    const data: Record<string, FigurePanelData> = {};
    for (const panel of page.panels.filter((p) => p.samples.length)) {
      const built = buildFigurePanel(panel, figure, sources, fx.trees, style, {}, true);
      data[panel.key] = built;
      const config = built.config!;
      const entry = fx.samples.find((s) => s.id === panel.samples[0])!;
      const gated = recompute(entry.sample, fx.state).populations[panel.population.populationId].event_count;
      expect(config.n_events).toBe(gated);
      expect(config.summary_channels).toEqual(CHANNELS);
      CHANNELS.forEach((channel, c) => {
        const single = buildFigurePanel({ ...panel, plot: { ...panel.plot, x: channel, channels: undefined } }, figure, sources, fx.trees, style, {}, true).config!;
        expect((config.channel_summaries as number[])[c]).toBe(single.figure_summary);
        expect((config.channel_quantiles as number[][])[c]).toEqual(single.summary_quantiles);
      });
      // The first channel's values are where a one-channel panel kept them.
      expect(config.figure_summary).toBe((config.channel_summaries as number[])[0]);
    }
    // FSC-A is drawn linear: CD4 SP's median FSC is 65 in D1 (50, 60, 70, 80) and 60 in D2 (55, 65).
    const cd4sp = page.panels.filter((p) => p.population.populationId === fx.refs[2].populationId && p.samples.length);
    expect(cd4sp.map((p) => (data[p.key].config!.channel_summaries as number[])[0])).toEqual([65, 60]);
    const matrix = buildHeatmapMatrix(page, data, { heatmapScale: "none" } as never)!;
    expect(matrix.columns.map((c) => c.label)).toEqual(CHANNELS);
    expect(matrix.rows).toHaveLength(4);
    matrix.rows.forEach((row, r) => {
      const config = data[row.panelKeys[0]!].config!;
      expect(matrix.raw[r]).toEqual(config.channel_summaries);
      expect(new Set(row.panelKeys).size).toBe(1);
    });
  });

  it("pools the files of a pooled panel per channel, and leaves blank a channel a file lacks", () => {
    const fx = fixture();
    const figure = captureFigureTransforms({ ...fx.figure, composition: "pool", plots: [{ ...fx.figure.plots[0], channels: ["FSC-A", "NOPE"] }] }, fx.samples);
    const [page] = layoutFigure(figure, fx.samples, fx.trees);
    const panel = page.panels.find((p) => p.population.populationId === fx.refs[2].populationId && p.samples.length)!;
    expect(panel.samples).toEqual(["D1", "D2"]);
    const sources = fx.samples.map((entry) => prepareFigureSource(entry, fx.trees[fx.state.active_hierarchy_id], fx.state));
    const config = buildFigurePanel(panel, figure, sources, fx.trees, style, {}, true).config!;
    // CD4 SP pooled: FSC 50, 55, 60, 65, 70, 80, six events, median 62.5.
    expect(config.n_events).toBe(6);
    expect(config.channel_summaries).toEqual([62.5, null]);
    expect(config.channel_quantiles).toEqual([expect.any(Array), []]);
    // A plot of none of the files' channels is a problem, as a one-channel plot of a missing channel is.
    const none = buildFigurePanel({ ...panel, plot: { ...panel.plot, x: "NOPE", channels: ["NOPE"] } }, figure, sources, fx.trees, style, {}, true);
    expect(none.config).toBeNull();
    expect(none.problem).toMatch(/channel unavailable/);
  });

  it("reads a plot saved with one channel as that channel, and keeps the list through save and load", () => {
    expect(heatmapChannels({ x: "CD4" })).toEqual(["CD4"]);
    expect(heatmapChannels({ x: "CD4", channels: [] })).toEqual(["CD4"]);
    expect(heatmapChannels({ x: "CD4", channels: ["CD8", "CD4"] })).toEqual(["CD8", "CD4"]);
    const fx = fixture();
    const loaded = migrateFigure(JSON.parse(JSON.stringify({ figure: fx.figure })), fx.samples, fx.trees, fx.state.active_hierarchy_id, "CD4", "CD8");
    expect(loaded.plots[0].channels).toEqual(CHANNELS);
    // A malformed list never makes the workspace unreadable: it is passed over, down to `x`.
    expect(isFigureSpec({ ...fx.figure, plots: [{ ...fx.figure.plots[0], channels: [1] as never }] })).toBe(true);
    expect(heatmapChannels({ x: "CD4", channels: [1, "", "CD8", "CD8"] as never })).toEqual(["CD8"]);
    expect(heatmapChannels({ x: "CD4", channels: "CD8" as never })).toEqual(["CD4"]);
  });
});

describe("A histogram plot with several channels", () => {
  it("is a plot per channel along the plots dimension, each panel the one-channel histogram of its channel", () => {
    const fx = fixture();
    const histogram: FigurePlot = { id: "hist", name: "Hist", x: "FSC-A", y: "FSC-A", type: "histogram", channels: ["FSC-A", "CD4"] };
    const figure = captureFigureTransforms({ ...fx.figure, populations: [fx.refs[2]], plots: [histogram] }, fx.samples);
    expect(Object.keys(figure.transforms)).toEqual(expect.arrayContaining(["CD4", "FSC-A"]));
    const [page] = layoutFigure(figure, fx.samples, fx.trees);
    // Rows: the population, then a row per channel; columns: the files.
    expect(page.rows.map((row) => row.map((v) => v.label))).toEqual([["CD4 SP", "Hist · FSC-A"], ["CD4 SP", "Hist · CD4"]]);
    expect(page.panels.map((p) => [p.row, p.column, p.plot.id, p.plot.x, p.samples])).toEqual([
      [0, 0, "hist", "FSC-A", ["D1"]], [0, 1, "hist", "FSC-A", ["D2"]],
      [1, 0, "hist", "CD4", ["D1"]], [1, 1, "hist", "CD4", ["D2"]],
    ]);
    expect(new Set(page.panels.map((p) => p.key)).size).toBe(4);
    const sources = fx.samples.map((entry) => prepareFigureSource(entry, fx.trees[fx.state.active_hierarchy_id], fx.state));
    for (const panel of page.panels) {
      const built = buildFigurePanel(panel, figure, sources, fx.trees, style, {}, true).config!;
      const single = buildFigurePanel({ ...panel, plot: { ...histogram, x: panel.plot.x, channels: undefined } }, figure, sources, fx.trees, style, {}, true).config!;
      const entry = fx.samples.find((s) => s.id === panel.samples[0])!;
      expect(built.n_events).toBe(recompute(entry.sample, fx.state).populations[fx.refs[2].populationId].event_count);
      expect(built.x).toEqual(single.x);
      expect(built.x_label).toBe(single.x_label);
    }
  });

  it("stays one plot value, with its own id, when it has one channel", () => {
    const fx = fixture();
    const figure = { ...fx.figure, populations: [fx.refs[2]], plots: [{ id: "hist", name: "Hist", x: "CD4", y: "CD4", type: "histogram" as const, channels: ["CD4"] }] };
    const [page] = layoutFigure(figure, fx.samples, fx.trees);
    expect(page.rows.map((row) => row.map((v) => v.id))).toEqual([["0", "hist"]]);
    expect(page.panels.every((p) => p.plot.x === "CD4")).toBe(true);
  });
});
