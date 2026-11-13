// A chart plot's panels in an Illustration figure, against the gate list: a violin's cells, a
// statistic's points and a composition's bars are the events the quadrant gate counts in each
// file. Synthetic files D1 and D2; nothing here is a real experiment.

import { describe, expect, it, vi } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { cloneHierarchyTree, DEFAULT_HIERARCHY_ID, storeHierarchy, type StoredHierarchy } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { isFigureSpec } from "../engine/figureSchema";
import {
  figureDisplaySample,
  figureHierarchies,
  figureRanges,
  layoutFigure,
  migrateFigure,
  prepareFigureSource,
  type FigurePopulation,
  type FigureSample,
  type FigureSpec,
} from "../engine/figure";
import { buildFigureChartPanel, type FigureChartData } from "./figureChartData";
import { statisticGroups } from "./StatisticChart";

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

// D1: CD8 SP 3, DP 1, CD4 SP 4, DN 0. D2: CD8 SP 1, DP 0, CD4 SP 2, DN 2.
const D1 = file("D1", [
  [LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30],
  [HIGH, HIGH, 40],
  [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80],
]);
const D2 = file("D2", [[LOW, HIGH, 15], [HIGH, LOW, 55], [HIGH, LOW, 65], [LOW, LOW, 90], [LOW, LOW, 100]]);

function fixture(chart: NonNullable<FigureSpec["plots"][number]["chart"]>) {
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
    ...migrateFigure(null, samples, trees, core.active_hierarchy_id, "FSC-A", "FSC-A"),
    sampleIds: ["D1", "D2"],
    populations: [{ hierarchyId: core.active_hierarchy_id, populationId: core.root_population_id!, label: "All Events" }],
    plots: [{ id: "chart", name: "Chart", x: "FSC-A", y: "FSC-A", type: "chart", chart, populations: refs }],
    rows: ["populations", "plots"],
    columns: ["samples"],
    pages: [],
    composition: "separate",
  };
  const sources = samples.map((entry) => prepareFigureSource(entry, trees[core.active_hierarchy_id], core));
  const gated = (entry: FigureSample) => recompute(entry.sample, core).populations;
  return { core, quadrants, trees, samples, figure, refs, sources, gated };
}

const chartOf = (data: { config: Record<string, unknown> | null }) => data.config!.chart as FigureChartData;

describe("An Illustration chart panel", () => {
  it("draws each population's cells in a file's violin panel as the gate counts them, on the file's FSC values", () => {
    const fx = fixture({ valueKind: "cells", plotType: "violin" });
    expect(isFigureSpec(fx.figure)).toBe(true);
    const page = layoutFigure(fx.figure, fx.samples, fx.trees)[0];
    expect(page.panels.map((p) => p.samples)).toEqual([["D1"], ["D2"]]);
    for (const panel of page.panels) {
      const entry = fx.samples.find((s) => s.id === panel.samples[0])!;
      const data = buildFigureChartPanel(panel, fx.figure, fx.sources, fx.trees, { state: fx.core });
      const chart = chartOf(data);
      const gated = fx.gated(entry);
      expect(chart.valueKind).toBe("cells");
      expect(chart.cells!.catLevels).toEqual(["CD8 SP", "DP", "CD4 SP", "DN"]);
      const counts = fx.quadrants.map((_, cat) => chart.cells!.violins.find((v) => v.cat === cat)?.values.length ?? 0);
      expect(counts).toEqual(fx.quadrants.map((p) => gated[p.population_id].event_count));
      expect(data.config!.n_events).toBe(entry.sample.fcs.nEvents);
      // CD4 SP's cells are the file's FSC values of the CD4 SP events, on the display scale.
      const fsc = entry.sample.displayColumn(2);
      const mask = fx.sources.find((s) => s.id === entry.id)!.gating.masks[fx.quadrants[2].population_id];
      const expected = Float32Array.from([...fsc].filter((_, e) => mask[e])).sort();
      expect([...chart.cells!.violins.find((v) => v.cat === 2)!.values]).toEqual([...expected]);
    }
  });

  it("shares the value axis across files unless each file's axes are its own", () => {
    const fx = fixture({ valueKind: "cells", plotType: "box" });
    const panel = layoutFigure(fx.figure, fx.samples, fx.trees)[0].panels[0];
    const ranges = figureRanges(fx.sources, fx.figure);
    expect(chartOf(buildFigureChartPanel(panel, fx.figure, fx.sources, fx.trees, { state: fx.core }, ranges)).range).toEqual(ranges["FSC-A"]);
    const individual = { ...fx.figure, scalePolicy: "individual" as const };
    expect(chartOf(buildFigureChartPanel(panel, individual, fx.sources, fx.trees, { state: fx.core }, ranges)).range).toBeUndefined();
  });

  it("takes a statistic of each file's cells, one point per file and population", () => {
    const fx = fixture({ valueKind: "statistic", plotType: "box", statistic: "median" });
    fx.figure.composition = "pool";
    const panel = layoutFigure(fx.figure, fx.samples, fx.trees)[0].panels[0];
    expect(panel.samples).toEqual(["D1", "D2"]);
    const chart = chartOf(buildFigureChartPanel(panel, fx.figure, fx.sources, fx.trees, { state: fx.core }));
    expect(chart.files).toBe(2);
    for (const entry of fx.samples) {
      const gated = fx.gated(entry);
      const own = chart.cells!.violins.filter((v) => v.unit === entry.id);
      expect(own.map((v) => v.values.length)).toEqual(fx.quadrants.map((p) => gated[p.population_id].event_count));
    }
    // Linear values: D1's CD4 SP cells have FSC 50, 60, 70 and 80.
    expect([...chart.cells!.violins.find((v) => v.unit === "D1" && v.cat === 2)!.values]).toEqual([50, 60, 70, 80]);
  });

  it("stacks each file's populations as shares of their common parent, a bar per file", () => {
    const fx = fixture({ valueKind: "proportion", plotType: "stacked" });
    fx.figure.plots[0].populations = [fx.refs[0], fx.refs[2]];
    fx.figure.composition = "pool";
    const panel = layoutFigure(fx.figure, fx.samples, fx.trees)[0].panels[0];
    const chart = chartOf(buildFigureChartPanel(panel, fx.figure, fx.sources, fx.trees, { state: fx.core }));
    const model = chart.proportions!;
    // The quadrants' common parent is the root: the rest is every other event.
    expect(model.catLevels).toEqual(["CD8 SP", "CD4 SP", "ungated"]);
    expect(model.perSample.map((row) => [row.group, row.catCounts])).toEqual([
      ["D1.fcs", [3, 4, 1]],
      ["D2.fcs", [1, 2, 2]],
    ]);
    for (const entry of fx.samples) {
      const gated = fx.gated(entry);
      const row = model.perSample.find((r) => r.unit === entry.id)!;
      expect(row.catCounts.slice(0, 2)).toEqual([fx.quadrants[0], fx.quadrants[2]].map((p) => gated[p.population_id].event_count));
      expect(row.catCounts.reduce((a, b) => a + b, 0)).toBe(entry.sample.fcs.nEvents);
    }
    expect(chart.colors).toHaveLength(3);
  });

  it("draws a summary panel's files along x, every population at each file's place, as the gate counts them", () => {
    const fx = fixture({ valueKind: "cells", plotType: "violin", summary: true });
    const [summary] = layoutFigure(fx.figure, fx.samples, fx.trees)[0].panels;
    expect(summary.samples).toEqual(["D1", "D2"]);
    const chart = chartOf(buildFigureChartPanel(summary, fx.figure, fx.sources, fx.trees, { state: fx.core }));
    // The four populations side by side at each file's place, a group named by its file.
    expect(chart.settings).toMatchObject({ xAxis: "groups", populationsTogether: true });
    expect(chart.cells!.catLevels).toEqual(["CD8 SP", "DP", "CD4 SP", "DN"]);
    expect(chart.groupLevels).toEqual(["D1.fcs", "D2.fcs"]);
    expect(chart.summary?.legend.map((entry) => entry.name)).toEqual(["CD8 SP", "DP", "CD4 SP", "DN"]);
    expect(chart.colors).toHaveLength(4);
    fx.samples.forEach((entry) => {
      const gated = fx.gated(entry);
      const counts = fx.quadrants.map((_, cat) => chart.cells!.violins.find((v) => v.cat === cat && v.group === entry.name)?.values.length ?? 0);
      expect(counts).toEqual(fx.quadrants.map((p) => gated[p.population_id].event_count));
    });
    // A statistic: a point per file and population, each its own file's.
    const statistic = fixture({ valueKind: "statistic", plotType: "box", summary: true });
    const [panel] = layoutFigure(statistic.figure, statistic.samples, statistic.trees)[0].panels;
    const points = chartOf(buildFigureChartPanel(panel, statistic.figure, statistic.sources, statistic.trees, { state: statistic.core })).cells!.violins;
    expect(points.filter((v) => v.values.length).map((v) => [v.cat, v.group, v.unit])).toEqual(
      [[0, "D1.fcs", "D1"], [1, "D1.fcs", "D1"], [2, "D1.fcs", "D1"], [0, "D2.fcs", "D2"], [2, "D2.fcs", "D2"], [3, "D2.fcs", "D2"]],
    );
    // A composition: a bar per file, named by its file.
    const composition = fixture({ valueKind: "proportion", plotType: "stacked", summary: true });
    const [bars] = layoutFigure(composition.figure, composition.samples, composition.trees)[0].panels;
    const model = chartOf(buildFigureChartPanel(bars, composition.figure, composition.sources, composition.trees, { state: composition.core })).proportions!;
    expect(model.perSample.map((row) => [row.unit, row.group, row.catCounts.slice(0, 4)])).toEqual(
      composition.samples.map((entry) => [entry.id, entry.name, composition.quadrants.map((p) => composition.gated(entry)[p.population_id].event_count)]),
    );
  });

  it("keeps a summary's place for a file without the channel, so the others' marks stay under their own columns", () => {
    // D3 has CD4 and CD8 but no FSC-A: it is gated, but has no value to take a statistic of.
    const fcs: FcsFile = {
      version: "FCS3.1",
      nEvents: 2,
      instrument: "flow",
      keywords: {},
      spillover: null,
      channels: [
        { index: 0, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
        { index: 1, name: "PE-A", marker: "CD8", bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from([HIGH, LOW]), Float32Array.from([LOW, HIGH])],
    };
    const D3: FigureSample = { id: "D3", name: "D3.fcs", sample: new Sample(fcs), hierarchyId: DEFAULT_HIERARCHY_ID, metadata: {} };
    for (const valueKind of ["statistic", "cells"] as const) {
      const fx = fixture({ valueKind, plotType: "box", statistic: "median", summary: true });
      const samples = [D1, D3, D2];
      const figure = { ...fx.figure, sampleIds: ["D1", "D3", "D2"] };
      const sources = samples.map((entry) => prepareFigureSource(entry, fx.trees[fx.core.active_hierarchy_id], fx.core));
      const [summary] = layoutFigure(figure, samples, fx.trees)[0].panels;
      expect(summary.samples).toEqual(["D1", "D3", "D2"]);
      const chart = chartOf(buildFigureChartPanel(summary, figure, sources, fx.trees, { state: fx.core }));
      expect(chart.groupLevels).toEqual(["D1.fcs", "D3.fcs", "D2.fcs"]);
      // Every place is among the chart's groups, D3's empty, in the columns' order.
      expect(statisticGroups(chart.cells!, chart.groupLevels)).toEqual(["D1.fcs", "D3.fcs", "D2.fcs"]);
      expect(chart.cells!.violins.filter((v) => v.group === "D3.fcs").every((v) => v.values.length === 0)).toBe(true);
      expect(chart.files).toBe(2);
    }
  });

  it("is built from the files as prepared, drawn under the figure's own transforms, a file with tailored gates among them", () => {
    // D2's tree is a copy of Main with the quadrant's centre moved to FITC 6000, so D2's CD4 SP
    // events (FITC 5000) fall in DN there: D2 CD8 SP 1, DP 0, CD4 SP 0, DN 4.
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 8 });
    state = coreReducer(state, {
      type: "addQuadrant", xChannel: "CD4", yChannel: "CD8",
      center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
      names: ["CD8 SP", "DP", "CD4 SP", "DN"],
    });
    const template = storeHierarchy(state.hierarchies[0], state);
    const clone = cloneHierarchyTree(template.populations, template.root_population_id!, template.gates, template.gate_order);
    const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
    const gates = Object.fromEntries(Object.entries(clone.gates).map(([id, gate]) => [id, gate.gate_type === "quadrant" ? { ...gate, center: [6000, 1000] as [number, number] } : gate]));
    const tailored: StoredHierarchy = {
      id: "D2_tree", name: "D2.fcs · Main", owner_sample_id: "D2", structure_locked: false, source_hierarchy_id: DEFAULT_HIERARCHY_ID,
      source_gate_ids: invert(clone.gateIdMap), source_population_ids: invert(clone.idMap),
      gates, gate_order: clone.gate_order, populations: clone.populations, root_population_id: clone.root_population_id,
      active_population_id: clone.root_population_id, selected_pop_ids: [],
    };
    const core = coreReducer(state, { type: "addHierarchyCopies", copies: [tailored], activeHierarchyId: DEFAULT_HIERARCHY_ID }) as CoreState;
    const trees = figureHierarchies(core);
    const samples = [D1, { ...D2, hierarchyId: "D2_tree" }];
    const sources = samples.map((entry) => prepareFigureSource(entry, trees[entry.hierarchyId], core));
    const quadrants = ["CD8 SP", "DP", "CD4 SP", "DN"].map((name) => Object.values(core.populations).find((p) => p.name === name)!);
    const figure: FigureSpec = {
      ...migrateFigure(null, samples, trees, core.active_hierarchy_id, "FSC-A", "FSC-A"),
      sampleIds: ["D1", "D2"],
      populations: [{ hierarchyId: core.active_hierarchy_id, populationId: core.root_population_id!, label: "All Events" }],
      plots: [{ id: "chart", name: "Chart", x: "FSC-A", y: "FSC-A", type: "chart", chart: { valueKind: "cells", plotType: "violin" }, populations: quadrants.map((p) => ({ hierarchyId: core.active_hierarchy_id, populationId: p.population_id, label: p.name })) }],
      rows: ["populations", "plots"],
      columns: ["samples"],
      pages: [],
      composition: "separate",
      scalePolicy: "shared",
      transforms: { "FSC-A": { kind: "asinh", cofactor: 10 } },
    };
    // The files the figure draws (useFigurePanels' `projected`): each file's whole data under the
    // figure's transforms. Gated again, they hold the masks the figure prepared, the tailored file's included.
    const projected = sources.map((source) => ({ ...source, sample: figureDisplaySample(source.sample, figure.transforms) }));
    for (const [i, source] of sources.entries()) {
      expect(projected[i].sample.fcs.nEvents).toBe(source.sample.fcs.nEvents);
      expect(recompute(projected[i].sample, { ...core, ...source.tree }).masks).toEqual(source.gating.masks);
    }
    const gateAssayData = vi.spyOn(Sample.prototype, "gateAssayData");
    const page = layoutFigure(figure, samples, trees)[0];
    const build = () => page.panels.map((panel) => chartOf(buildFigureChartPanel(panel, figure, projected, trees, { state: core, gatingSources: sources })));
    const charts = build();
    expect(gateAssayData.mock.calls.length).toBeGreaterThan(0);
    for (const [i, chart] of charts.entries()) {
      const source = sources[i];
      const counts = quadrants.map((_, cat) => chart.cells!.violins.find((v) => v.cat === cat)?.values.length ?? 0);
      expect(counts).toEqual(Object.values(source.tree.populations).filter((p) => p.parent_id).map((p) => recompute(source.sample, { ...core, ...source.tree }).populations[p.population_id].event_count));
      // The cells' values are the figure's display values, asinh(FSC / 10), of the events its gating holds.
      const display = projected[i].sample.displayColumn(2);
      quadrants.forEach((_, cat) => {
        const id = Object.values(source.tree.populations).filter((p) => p.parent_id)[cat].population_id;
        const expected = Float32Array.from([...display].filter((_, e) => source.gating.masks[id][e])).sort();
        expect([...(chart.cells!.violins.find((v) => v.cat === cat)?.values ?? [])]).toEqual([...expected]);
      });
    }
    expect(charts.map((chart) => chart.cells!.violins.map((v) => v.values.length))).toEqual([[3, 1, 4, 0], [1, 0, 0, 4]]);
    // Built again, as on a repaint or a rebuild with nothing changed, nothing is gated again.
    const before = gateAssayData.mock.calls.length;
    build();
    expect(gateAssayData.mock.calls.length).toBe(before);
    gateAssayData.mockRestore();
  });

  it("draws a panel's populations from two trees, the second's followed into the first's", () => {
    // The plot's populations: CD8 SP from Main and CD4 SP from a copy of Main for D2.
    const fx = fixture({ valueKind: "cells", plotType: "violin" });
    const template = storeHierarchy(fx.core.hierarchies[0], fx.core);
    const clone = cloneHierarchyTree(template.populations, template.root_population_id!, template.gates, template.gate_order);
    const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
    const copy: StoredHierarchy = {
      id: "D2_tree", name: "D2.fcs · Main", owner_sample_id: "D2", structure_locked: false, source_hierarchy_id: DEFAULT_HIERARCHY_ID,
      source_gate_ids: invert(clone.gateIdMap), source_population_ids: invert(clone.idMap),
      gates: clone.gates, gate_order: clone.gate_order, populations: clone.populations, root_population_id: clone.root_population_id,
      active_population_id: clone.root_population_id, selected_pop_ids: [],
    };
    const core = coreReducer(fx.core, { type: "addHierarchyCopies", copies: [copy], activeHierarchyId: DEFAULT_HIERARCHY_ID }) as CoreState;
    const trees = figureHierarchies(core);
    const cd4Copy = Object.values(copy.populations).find((p) => p.name === "CD4 SP")!.population_id;
    const figure: FigureSpec = {
      ...fx.figure,
      composition: "pool",
      plots: [{ ...fx.figure.plots[0], populations: [fx.refs[0], { hierarchyId: "D2_tree", populationId: cd4Copy, label: "CD4 SP" }] }],
    };
    const sources = fx.samples.map((entry) => prepareFigureSource(entry, trees[entry.hierarchyId], core));
    const [panel] = layoutFigure(figure, fx.samples, trees)[0].panels;
    expect(panel.samples).toEqual(["D1", "D2"]);
    const data = buildFigureChartPanel(panel, figure, sources, trees, { state: core });
    const chart = chartOf(data);
    expect(data.note).toBeUndefined();
    expect(chart.cells!.catLevels).toEqual(["CD8 SP", "CD4 SP"]);
    // CD8 SP: D1 3 and D2 1; CD4 SP: D1 4 and D2 2, each file's in its own tree.
    expect(chart.cells!.violins.map((v) => [v.cat, [...v.values]])).toEqual([[0, [10, 15, 20, 30]], [1, [50, 55, 60, 65, 70, 80]]]);
    expect(chart.cells!.violins.map((v) => v.values.length)).toEqual(
      [fx.quadrants[0], fx.quadrants[2]].map((p) => fx.samples.reduce((n, entry) => n + (fx.gated(entry)[p.population_id].event_count ?? 0), 0)),
    );
  });
});
