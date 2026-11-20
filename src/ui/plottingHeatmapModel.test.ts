// The Plotting tab's summary heatmap against the Illustration tab's: the same gate, files and
// channels give the same numbers, and the rows are the populations in each file or pooled unit,
// ordered by group. Synthetic files D1, D2 and D3; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { defaultIllustrationConfig, figureStyle } from "../engine/figureDefaults";
import { buildHeatmapMatrix } from "../engine/figureHeatmap";
import {
  buildFigurePanel,
  captureFigureTransforms,
  figureHierarchies,
  layoutFigure,
  migrateFigure,
  prepareFigureSource,
  type FigurePanelData,
  type FigurePlot,
  type FigurePopulation,
  type FigureSample,
  type FigureSpec,
} from "../engine/figure";
import { BASE_PROPORTIONS_SETTINGS, normalizeProportionsSettings, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "../engine/proportionsSettings";
import {
  buildPlottingHeatmapPanel,
  heatmapDataTable,
  plottingHeatmapConfig,
  plottingHeatmapFigure,
  plottingHeatmapMatrix,
  plottingHeatmapPage,
  plottingHeatmapPlot,
  plottingHeatmapPopulationIds,
  plottingHeatmapUnits,
} from "./plottingHeatmapModel";

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
const D3 = file("D3", [[HIGH, LOW, 35], [HIGH, LOW, 45], [LOW, HIGH, 25]]);

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
  const samples = [D1, D2, D3];
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


const metadata: Record<string, Record<string, string>> = {
  D1: { condition: "treated", donor: "B1" },
  D2: { condition: "control", donor: "B2" },
  D3: { condition: "treated", donor: "B1" },
};

function sources(fx: ReturnType<typeof fixture>) {
  return fx.samples.map((entry) => prepareFigureSource(entry, fx.trees[fx.state.active_hierarchy_id], fx.state));
}

function plottingMatrix(fx: ReturnType<typeof fixture>, patch: Partial<ProportionsSettings>) {
  const settings = normalizeProportionsSettings({
    ...BASE_PROPORTIONS_SETTINGS,
    valueKind: "heatmap",
    plotType: "heatmap",
    files: ["D1", "D2", "D3"],
    hierarchy: fx.state.active_hierarchy_id,
    parent: fx.state.root_population_id,
    selectedPops: [fx.refs[2].populationId, fx.refs[0].populationId],
    channel: CHANNELS[0],
    channels: CHANNELS,
    heatmapScale: "none",
    ...patch,
  });
  const tree = fx.trees[fx.state.active_hierarchy_id];
  const ids = plottingHeatmapPopulationIds(settings, tree);
  const populations: FigurePopulation[] = ids.map((id) => ({ hierarchyId: tree.id, populationId: id, label: tree.populations[id].name }));
  const units = plottingHeatmapUnits(settings, fx.samples, metadata);
  const plot = plottingHeatmapPlot(settings.channels);
  const figure = plottingHeatmapFigure(fx.samples, fx.trees, tree.id, populations, plot);
  const page = plottingHeatmapPage(units, populations, plot);
  const config = plottingHeatmapConfig(settings, { fontTick: 9, fontAxis: 10 });
  const data = Object.fromEntries(page.panels.map((panel) => [panel.key, buildPlottingHeatmapPanel(panel, figure, sources(fx), fx.trees, config)]));
  return { settings, units, populations, matrix: plottingHeatmapMatrix(page, units, data, config)! };
}

describe("The Plotting tab's summary heatmap", () => {
  it("gives the Illustration heatmap's numbers for the same gate, files and channels", () => {
    const fx = fixture();
    const { matrix } = plottingMatrix(fx, {});
    // Illustration: the same populations down the rows, a file per column, one heatmap plot.
    const figure: FigureSpec = captureFigureTransforms({
      ...fx.figure,
      sampleIds: ["D1", "D2", "D3"],
      populations: [fx.refs[0], fx.refs[2]],
      plots: [{ id: "heat", name: "Heat", x: CHANNELS[0], y: "", type: "heatmap", channels: CHANNELS }],
      rows: ["populations", "samples"],
      columns: ["plots"],
    }, fx.samples);
    const [page] = layoutFigure(figure, fx.samples, fx.trees);
    const style = figureStyle(defaultIllustrationConfig(), true);
    const data: Record<string, FigurePanelData> = Object.fromEntries(page.panels.map((panel) => [panel.key, buildFigurePanel(panel, figure, sources(fx), fx.trees, style, {}, true)]));
    const illustration = buildHeatmapMatrix(page, data, { heatmapScale: "none" } as never)!;
    expect(matrix.columns.map((c) => c.label)).toEqual(CHANNELS);
    // Rows in tree order (CD8 SP before CD4 SP), a file each.
    expect(matrix.rows.map((r) => r.label)).toEqual([
      "CD8 SP · D1.fcs", "CD8 SP · D2.fcs", "CD8 SP · D3.fcs",
      "CD4 SP · D1.fcs", "CD4 SP · D2.fcs", "CD4 SP · D3.fcs",
    ]);
    expect(matrix.raw).toEqual(illustration.raw);
    expect(matrix.rows.map((r) => r.count)).toEqual(illustration.rows.map((r) => r.count));
    // CD4 SP's FSC medians: 65 in D1 (50, 60, 70, 80), 60 in D2 (55, 65), 40 in D3 (35, 45).
    expect(matrix.raw.slice(3).map((row) => row[0])).toEqual([65, 60, 40]);
  });

  it("pools a replicate unit's files into one row, named by the unit, and orders the units by group", () => {
    const fx = fixture();
    const { units, matrix } = plottingMatrix(fx, { unitSel: "donor", groupSel: "condition" });
    // condition's levels in file order: treated (D1, D3) then control (D2).
    expect(units.map((u) => [u.group, u.label, u.files])).toEqual([["treated", "B1", ["D1", "D3"]], ["control", "B2", ["D2"]]]);
    expect(matrix.rows.map((r) => r.label)).toEqual(["CD8 SP · B1", "CD8 SP · B2", "CD4 SP · B1", "CD4 SP · B2"]);
    // B1 pools D1 and D3: CD4 SP's FSC 50, 60, 70, 80, 35, 45, six events, median 55.
    expect(matrix.rows[2].count).toBe(6);
    expect(matrix.raw[2][0]).toBe(55);
    expect(matrix.raw[3][0]).toBe(60);
  });

  it("reads the Plotting selection: nothing ticked draws nothing; ticks under another parent read as its children", () => {
    const fx = fixture();
    const tree = fx.trees[fx.state.active_hierarchy_id];
    const parent = fx.state.root_population_id!;
    expect(plottingHeatmapPopulationIds({ parent, selectedPops: [] }, tree)).toEqual([]);
    expect(plottingHeatmapPopulationIds({ parent, selectedPops: ["elsewhere"] }, tree)).toEqual(tree.populations[parent].children);
    expect(plottingHeatmapPopulationIds({ parent: fx.refs[0].populationId, selectedPops: [fx.refs[0].populationId] }, tree)).toEqual([]);
  });

  it("writes its table in drawing order, and keeps its settings through a save", () => {
    const fx = fixture();
    const { matrix, settings } = plottingMatrix(fx, { heatmapClusterRows: true, statistic: "mean", heatmapPalette: "viridis", heatmapCellSize: 40 });
    const table = heatmapDataTable(matrix);
    expect(table.header).toEqual(["Row", "FSC-A (mean)", "CD4 (mean)", "CD8 (mean)", "Events"]);
    expect(table.rows.map((row) => row[0])).toEqual(matrix.rowOrder.map((r) => matrix.rows[r].label));
    const saved = normalizeProportionsSettings(JSON.parse(JSON.stringify(settings)));
    expect([saved.valueKind, saved.plotType, saved.heatmapClusterRows, saved.statistic, saved.heatmapPalette, saved.heatmapCellSize]).toEqual(["heatmap", "heatmap", true, "mean", "viridis", 40]);
    // Out of range or unknown values fall back.
    const odd = normalizeProportionsSettings({ valueKind: "heatmap", plotType: "heatmap", heatmapScale: "nope", heatmapCellSize: 4000 });
    expect([odd.heatmapScale, odd.heatmapCellSize]).toEqual(["column_quantile", 120]);
    void PROPORTIONS_SAMPLE_FACTOR;
  });
});
