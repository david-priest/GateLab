// An Illustration figure with a summary chart plot: a row of histograms over a row drawn once for
// all the files of the row, the violins of three files in one panel spanning their columns.
// Synthetic files D1, D2 and D3 in groups control and treated; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { isFigureSpec } from "./figureSchema";
import {
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

function file(id: string, group: string, events: Event[]): FigureSample {
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
  return { id, name: `${id}.fcs`, sample: new Sample(fcs), hierarchyId: DEFAULT_HIERARCHY_ID, metadata: { group } };
}

// CD4_positive (CD4 SP): 4 in D1, 2 in D2, 1 in D3.
const D1 = file("D1", "control", [
  [LOW, HIGH, 10], [LOW, HIGH, 20], [HIGH, HIGH, 40],
  [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80],
]);
const D2 = file("D2", "treated", [[LOW, HIGH, 15], [HIGH, LOW, 55], [HIGH, LOW, 65], [LOW, LOW, 90]]);
const D3 = file("D3", "control", [[HIGH, LOW, 35], [LOW, LOW, 95], [LOW, HIGH, 25]]);

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 7 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "CD8",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["CD8_positive", "DP", "CD4_positive", "DN"],
  });
  const core = state as CoreState;
  const gate = Object.values(core.gates).find((g) => g.gate_type === "quadrant")!;
  const quadrants = [1, 2, 3, 4].map((q) =>
    Object.values(core.populations).find((p) => p.gate_refs.some((r) => r.gate_id === gate.gate_id && r.quadrant === q))!,
  );
  const trees = figureHierarchies(core);
  const samples = [D1, D2, D3];
  const refs: FigurePopulation[] = quadrants.map((p) => ({ hierarchyId: core.active_hierarchy_id, populationId: p.population_id, label: p.name }));
  const figure: FigureSpec = {
    ...migrateFigure(null, samples, trees, core.active_hierarchy_id, "CD4", "CD8"),
    sampleIds: ["D2", "D1", "D3"],
    populations: [refs[2]],
    plots: [
      { id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram" },
      { id: "violin", name: "FSC-A violin", x: "FSC-A", y: "FSC-A", type: "chart", chart: { valueKind: "cells", plotType: "violin", summary: true } },
    ],
    rows: ["populations", "plots"],
    columns: ["samples"],
    pages: [],
    composition: "separate",
  };
  return { state: core, quadrants, trees, samples, figure, refs };
}

describe("A summary chart plot", () => {
  it("is one panel under the row of histograms, spanning their three columns, with each file's gated cells", () => {
    const fx = fixture();
    expect(isFigureSpec(fx.figure)).toBe(true);
    const [page] = layoutFigure(fx.figure, fx.samples, fx.trees);
    expect(page.columns.map((column) => column[0].label)).toEqual(["D2.fcs", "D1.fcs", "D3.fcs"]);
    expect(page.panels.filter((p) => p.plot.id === "size").map((p) => p.samples)).toEqual([["D2"], ["D1"], ["D3"]]);
    const violins = page.panels.filter((p) => p.plot.id === "violin");
    // The grid keeps a panel per cell: the first draws the summary, the other two are covered by it.
    expect(violins.map((p) => [p.row, p.column])).toEqual([[1, 0], [1, 1], [1, 2]]);
    const [summary, ...covered] = violins;
    expect(summary.samples).toEqual(["D2", "D1", "D3"]);
    expect(summary.span).toEqual({ rows: 1, columns: 3 });
    expect(summary.cells).toEqual([
      { label: "D2.fcs", samples: ["D2"] },
      { label: "D1.fcs", samples: ["D1"] },
      { label: "D3.fcs", samples: ["D3"] },
    ]);
    expect(covered.every((p) => p.coveredBy === summary.key && !p.samples.length)).toBe(true);
    // Each file's cells in the panel are the events the gate counts in that file.
    for (const id of summary.samples) {
      const entry = fx.samples.find((s) => s.id === id)!;
      const source = prepareFigureSource(entry, fx.trees[fx.state.active_hierarchy_id], fx.state);
      const gated = recompute(entry.sample, fx.state).populations[fx.quadrants[2].population_id].event_count;
      const mask = source.gating.masks[summary.population.populationId];
      expect(mask.reduce((n, v) => n + v, 0)).toBe(gated);
      expect(gated).toBe({ D1: 4, D2: 2, D3: 1 }[id]);
    }
  });

  it("spans the rows when the files are on rows, as the right-most panel when it is the last plot", () => {
    const fx = fixture();
    const [page] = layoutFigure({ ...fx.figure, rows: ["samples"], columns: ["populations", "plots"] }, fx.samples, fx.trees);
    const summary = page.panels.find((p) => p.plot.id === "violin" && p.span)!;
    expect([summary.row, summary.column]).toEqual([0, 1]);
    expect(summary.span).toEqual({ rows: 3, columns: 1 });
    expect(summary.samples).toEqual(["D2", "D1", "D3"]);
    expect(page.panels.filter((p) => p.coveredBy === summary.key).map((p) => [p.row, p.column])).toEqual([[1, 1], [2, 1]]);
  });

  it("groups the files by a metadata column on the spanned shelf, its values as the groups, in the column's order", () => {
    const fx = fixture();
    const [pooled] = layoutFigure({ ...fx.figure, columns: ["metadata:group", "samples"], composition: "pool" }, fx.samples, fx.trees);
    const summary = pooled.panels.find((p) => p.plot.id === "violin" && p.span)!;
    expect(summary.span).toEqual({ rows: 1, columns: 2 });
    expect(summary.cells).toEqual([
      { label: "treated", samples: ["D2"], group: "treated" },
      { label: "control", samples: ["D1", "D3"], group: "control" },
    ]);
    expect(summary.samples).toEqual(["D2", "D1", "D3"]);
    // With the files themselves on the shelf too, a cell per file, each with its group.
    const [separate] = layoutFigure({ ...fx.figure, columns: ["metadata:group", "samples"] }, fx.samples, fx.trees);
    const each = separate.panels.find((p) => p.plot.id === "violin" && p.span)!;
    expect(each.cells?.map((c) => [c.samples[0], c.group])).toEqual([["D2", "treated"], ["D1", "control"], ["D3", "control"]]);
  });

  it("draws a panel per file where the files are on pages", () => {
    const fx = fixture();
    const pages = layoutFigure({ ...fx.figure, columns: [], pages: ["samples"] }, fx.samples, fx.trees);
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      const violin = page.panels.find((p) => p.plot.id === "violin")!;
      expect(violin.samples).toHaveLength(1);
      expect(violin.span).toBeUndefined();
    }
  });

  it("lays out a saved figure without the field as before, and refuses a summary that is not a boolean", () => {
    const fx = fixture();
    const { summary: _summary, ...chart } = fx.figure.plots[1].chart!;
    const saved = JSON.parse(JSON.stringify({ figure: { ...fx.figure, plots: [fx.figure.plots[0], { ...fx.figure.plots[1], chart }] } }));
    const loaded = migrateFigure(saved, fx.samples, fx.trees, fx.state.active_hierarchy_id, "CD4", "CD8");
    expect(loaded.plots[1].chart).toEqual({ valueKind: "cells", plotType: "violin" });
    const [page] = layoutFigure(loaded, fx.samples, fx.trees);
    expect(page.panels.filter((p) => p.plot.id === "violin").map((p) => [p.row, p.column, p.samples])).toEqual([[1, 0, ["D2"]], [1, 1, ["D1"]], [1, 2, ["D3"]]]);
    expect(page.panels.some((p) => "span" in p || "cells" in p || "coveredBy" in p)).toBe(false);
    const withChart = (patch: Record<string, unknown>) => ({ ...fx.figure, plots: [fx.figure.plots[0], { ...fx.figure.plots[1], chart: { ...chart, ...patch } }] });
    expect(isFigureSpec(withChart({ summary: "yes" }))).toBe(false);
    expect(isFigureSpec(withChart({ fileLabels: 1 }))).toBe(false);
    expect(isFigureSpec(withChart({ summary: true, fileLabels: true }))).toBe(true);
  });
});
