// An Illustration figure with a summary violin set to draw the figure's populations together: a
// row of histograms per population over one panel holding every ticked population, per file.
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

// CD4_positive: 4 in D1, 2 in D2, 1 in D3. CD8_positive: 2 in D1, 1 in D2, 1 in D3.
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
    // CD4_positive then CD8_positive, in the order they were ticked.
    populations: [refs[2], refs[0]],
    plots: [
      { id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram" },
      {
        id: "violin", name: "FSC-A violin", x: "FSC-A", y: "FSC-A", type: "chart",
        chart: { valueKind: "cells", plotType: "violin", summary: true }, together: true,
      },
    ],
    rows: ["plots", "populations"],
    columns: ["samples"],
    pages: [],
    composition: "separate",
  };
  return { state: core, quadrants, trees, samples, figure, refs };
}

const gatedCount = (fx: ReturnType<typeof fixture>, sampleId: string, populationId: string) => {
  const entry = fx.samples.find((s) => s.id === sampleId)!;
  const source = prepareFigureSource(entry, fx.trees[fx.state.active_hierarchy_id], fx.state);
  const counted = recompute(entry.sample, fx.state).populations[populationId].event_count;
  const mask = source.gating.masks[populationId];
  expect(mask.reduce((n, v) => n + v, 0)).toBe(counted);
  return counted;
};

describe("A summary chart plot set to draw the figure's populations together", () => {
  it("closes the figure when the populations are the outer rows: the summary row comes after every population's histogram row", () => {
    const fx = fixture();
    const [page] = layoutFigure({ ...fx.figure, rows: ["populations", "plots"] }, fx.samples, fx.trees);
    const summaries = page.panels.filter((p) => p.plot.id === "violin" && p.span);
    expect(summaries).toHaveLength(1);
    const lastHistogramRow = Math.max(...page.panels.filter((p) => p.plot.id === "size").map((p) => p.row));
    expect(summaries[0].row).toBe(lastHistogramRow + 1);
    expect(summaries[0].populations?.map((ref) => ref.label)).toEqual(["CD4_positive", "CD8_positive"]);
  });

  it("is one summary panel under the histogram rows, holding both ticked populations in order, with each file's gated cells", () => {
    const fx = fixture();
    expect(isFigureSpec(fx.figure)).toBe(true);
    const [page] = layoutFigure(fx.figure, fx.samples, fx.trees);
    // A histogram row per population, then one summary row.
    const sizes = page.panels.filter((p) => p.plot.id === "size");
    expect(sizes.map((p) => [p.row, p.population.label])).toEqual([
      [0, "CD4_positive"], [0, "CD4_positive"], [0, "CD4_positive"],
      [1, "CD8_positive"], [1, "CD8_positive"], [1, "CD8_positive"],
    ]);
    const summaries = page.panels.filter((p) => p.plot.id === "violin" && p.span);
    expect(summaries).toHaveLength(1);
    const [summary] = summaries;
    expect(summary.row).toBe(2);
    expect(summary.span).toEqual({ rows: 1, columns: 3 });
    expect(summary.samples).toEqual(["D2", "D1", "D3"]);
    expect(summary.populations?.map((ref) => ref.label)).toEqual(["CD4_positive", "CD8_positive"]);
    expect(page.panels.filter((p) => p.plot.id === "violin" && !p.span).every((p) => p.coveredBy === summary.key)).toBe(true);
    // Each file's cells in each population are the events the gate counts in that file.
    const counts = summary.samples.map((id) =>
      summary.populations!.map((ref) => gatedCount(fx, id, ref.populationId)),
    );
    expect(counts).toEqual([[2, 1], [4, 2], [1, 1]]);
  });

  it("follows the figure's populations: unticking one leaves one population in the one summary panel", () => {
    const fx = fixture();
    const [page] = layoutFigure({ ...fx.figure, populations: [fx.refs[2]] }, fx.samples, fx.trees);
    const summaries = page.panels.filter((p) => p.plot.id === "violin" && p.span);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].populations?.map((ref) => ref.label)).toEqual(["CD4_positive"]);
    expect(summaries[0].samples.map((id) => gatedCount(fx, id, fx.refs[2].populationId))).toEqual([2, 4, 1]);
  });

  it("lays out a figure without the field as before: a summary panel per population", () => {
    const fx = fixture();
    const { together: _together, ...plain } = fx.figure.plots[1];
    const figure = { ...fx.figure, plots: [fx.figure.plots[0], plain] };
    expect(isFigureSpec(figure)).toBe(true);
    const [page] = layoutFigure(figure, fx.samples, fx.trees);
    const summaries = page.panels.filter((p) => p.plot.id === "violin" && p.span);
    expect(summaries.map((p) => [p.population.label, p.populations])).toEqual([
      ["CD4_positive", undefined],
      ["CD8_positive", undefined],
    ]);
    // Set off, it is the same as absent.
    const [off] = layoutFigure(
      { ...fx.figure, plots: [fx.figure.plots[0], { ...fx.figure.plots[1], together: false }] },
      fx.samples,
      fx.trees,
    );
    expect(off.panels.map((p) => [p.key, p.samples, p.populations])).toEqual(
      page.panels.map((p) => [p.key, p.samples, p.populations]),
    );
  });

  it("draws the same as the figure-wide overlay switch, without doubling it", () => {
    const fx = fixture();
    const [page] = layoutFigure({ ...fx.figure, overlayPopulations: true }, fx.samples, fx.trees);
    const summaries = page.panels.filter((p) => p.plot.id === "violin" && p.span);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].populations?.map((ref) => ref.label)).toEqual(["CD4_positive", "CD8_positive"]);
  });

  it("refuses a together flag that is not a boolean", () => {
    const fx = fixture();
    expect(isFigureSpec({ ...fx.figure, plots: [fx.figure.plots[0], { ...fx.figure.plots[1], together: "yes" }] })).toBe(false);
  });
});
