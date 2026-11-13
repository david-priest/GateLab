// An Illustration plot that overlays chosen populations in its panels, as the four quadrants of a
// quadrant gate in one histogram, against the gate list. Synthetic files D1 and D2; nothing here is
// a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { populationColor } from "./palettes";
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

// D1: CD8 SP 3, DP 1, CD4 SP 4, DN 0. D2: CD8 SP 1, DP 0, CD4 SP 2, DN 2.
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
  const figure = migrateFigure(null, samples, trees, core.active_hierarchy_id, "CD4", "CD8");
  const refs: FigurePopulation[] = quadrants.map((p) => ({ hierarchyId: core.active_hierarchy_id, populationId: p.population_id, label: p.name }));
  figure.sampleIds = samples.map((s) => s.id);
  figure.populations = [{ hierarchyId: core.active_hierarchy_id, populationId: core.root_population_id!, label: "All Events" }];
  figure.plots = [
    { id: "quadrants", name: "Quadrants", x: "CD4", y: "CD8", type: "biplot" },
    { id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram", populations: refs },
  ];
  figure.rows = ["populations", "plots"];
  figure.columns = ["samples"];
  figure.pages = [];
  figure.composition = "separate";
  return { state: core, quadrants, trees, samples, figure, refs };
}

describe("A plot overlaying chosen populations", () => {
  it("overlays the quadrants in each file's histogram, each with the gate list's events, in its own colour", () => {
    const fx = fixture();
    expect(isFigureSpec(fx.figure)).toBe(true);
    const page = layoutFigure(fx.figure, fx.samples, fx.trees)[0];
    const histograms = page.panels.filter((panel) => panel.plot.id === "size");
    const biplots = page.panels.filter((panel) => panel.plot.id === "quadrants");
    expect(histograms).toHaveLength(2);
    // The other plot is unaffected: one population a panel, the figure's own.
    expect(biplots.every((panel) => !panel.populations && panel.population.label === "All Events")).toBe(true);
    // DP has a colour of its own; a legacy popColors map in the options is not read.
    const dpId = fx.quadrants[1].population_id;
    const state: CoreState = { ...fx.state, populations: { ...fx.state.populations, [dpId]: { ...fx.state.populations[dpId], color: "#123456" } } };
    const trees = figureHierarchies(state);
    const options = { ...figureStyle(defaultIllustrationConfig()), populationColors: { [fx.quadrants[2].population_id]: "#654321" } };
    for (const panel of histograms) {
      expect(panel.populations?.map((p) => p.label)).toEqual(["CD8 SP", "DP", "CD4 SP", "DN"]);
      const entry = fx.samples.find((s) => s.id === panel.samples[0])!;
      const source = prepareFigureSource(entry, trees[state.active_hierarchy_id], state);
      const data = buildFigurePanel(panel, fx.figure, [source], trees, options, {}, true);
      const config = data.config!;
      const gated = recompute(entry.sample, fx.state).populations;
      const traces = [{ x: config.x as number[] }, ...(config.overlay_traces as { x: number[] }[])];
      const legend = config.legend_entries as { name: string; color: string }[];
      // Every quadrant keeps its trace and legend entry, an empty one (DN in D1) with no events.
      const drawn = fx.quadrants;
      expect(legend.map((l) => l.name)).toEqual(drawn.map((p) => p.name));
      drawn.forEach((p, i) => expect(traces[i].x).toHaveLength(gated[p.population_id].event_count ?? 0));
      expect(config.n_events).toBe(drawn.reduce((n, p) => n + (gated[p.population_id].event_count ?? 0), 0));
      // Each quadrant in its colour: its own where set, else its stable slot's.
      expect(legend.map((l) => l.color)).toEqual(
        drawn.map((p) => (p === fx.quadrants[1] ? "#123456" : populationColor("default", p.colorSlot))),
      );
    }
  });

  it("leads with a population that has events, so one empty in a file does not blank the others", () => {
    const fx = fixture();
    // DN first: D1 has no DN cells, so DP (1 cell) leads and DN is drawn as an empty overlay.
    const order = [3, 1, 0, 2].map((i) => fx.refs[i]);
    fx.figure.plots[1] = { ...fx.figure.plots[1], populations: order };
    const panel = layoutFigure(fx.figure, fx.samples, fx.trees)[0].panels.find((p) => p.plot.id === "size" && p.samples[0] === "D1")!;
    const source = prepareFigureSource(D1, fx.trees[fx.state.active_hierarchy_id], fx.state);
    const config = buildFigurePanel(panel, fx.figure, [source], fx.trees, figureStyle(defaultIllustrationConfig()), {}, true).config!;
    expect((config.x as number[]).length).toBe(1);
    expect((config.legend_entries as { name: string }[]).map((l) => l.name)).toEqual(["DN", "DP", "CD8 SP", "CD4 SP"]);
    const overlaid = config.overlay_traces as { x: number[]; name: string }[];
    expect(overlaid.map((t) => [t.name, t.x.length])).toEqual([["DN", 0], ["CD8 SP", 3], ["CD4 SP", 4]]);
  });

  it("draws the populations that remain when one overlaid population was deleted, and names the one missing", () => {
    const fx = fixture();
    const deleted: FigurePopulation = { hierarchyId: fx.state.active_hierarchy_id, populationId: "deleted", label: "CD4_negative" };
    fx.figure.plots[1] = { ...fx.figure.plots[1], populations: [fx.refs[0], deleted, fx.refs[2]] };
    const panel = layoutFigure(fx.figure, fx.samples, fx.trees)[0].panels.find((p) => p.plot.id === "size" && p.samples[0] === "D1")!;
    const source = prepareFigureSource(D1, fx.trees[fx.state.active_hierarchy_id], fx.state);
    const data = buildFigurePanel(panel, fx.figure, [source], fx.trees, figureStyle(defaultIllustrationConfig()), {}, true);
    expect(data.problem).toBeUndefined();
    const config = data.config!;
    const gated = recompute(D1.sample, fx.state).populations;
    expect((config.legend_entries as { name: string }[]).map((l) => l.name)).toEqual(["CD8 SP", "CD4 SP"]);
    // CD8 SP 3 events and CD4 SP 4 in D1, counted from the gate.
    expect([(config.x as number[]).length, (config.overlay_traces as { x: number[] }[])[0].x.length]).toEqual(
      [fx.quadrants[0], fx.quadrants[2]].map((p) => gated[p.population_id].event_count),
    );
    expect(config.n_events).toBe(7);
    expect(data.note).toContain("CD4_negative");
  });

  it("keeps a population's place in the legend in a file it is left out of, marked as absent", () => {
    const fx = fixture();
    // D2's panels leave DP out; D1's keep all four.
    fx.figure.samplePopulations = { D1: fx.refs, D2: fx.refs.filter((_, i) => i !== 1) };
    const pages = layoutFigure(fx.figure, fx.samples, fx.trees);
    const legendOf = (sample: FigureSample) => {
      const panel = pages[0].panels.find((p) => p.plot.id === "size" && p.samples[0] === sample.id)!;
      const source = prepareFigureSource(sample, fx.trees[fx.state.active_hierarchy_id], fx.state);
      const config = buildFigurePanel(panel, fx.figure, [source], fx.trees, figureStyle(defaultIllustrationConfig()), {}, true).config!;
      const traces = [{ name: (config.legend_entries as { name: string }[])[0].name, x: config.x as number[] }, ...(config.overlay_traces as { name: string; x: number[] }[])];
      return { config, traces, legend: config.legend_entries as { name: string; color: string }[] };
    };
    const d1 = legendOf(D1), d2 = legendOf(D2);
    expect(d1.legend.map((l) => l.name)).toEqual(["CD8 SP", "DP", "CD4 SP", "DN"]);
    // The same number names the same population in both files: DP keeps its place in D2, absent.
    expect(d2.legend.map((l) => l.name)).toEqual(["CD8 SP", "DP (not in this file)", "CD4 SP", "DN"]);
    expect(d2.legend.map((l) => l.color)).toEqual(d1.legend.map((l) => l.color));
    // D2: CD8 SP 1, CD4 SP 2, DN 2, counted from the gate; DP drawn with no events.
    const gated = recompute(D2.sample, fx.state).populations;
    const byName = Object.fromEntries(d2.traces.map((t) => [t.name, t.x.length]));
    expect(byName).toEqual({
      "CD8 SP": gated[fx.quadrants[0].population_id].event_count,
      "DP (not in this file)": 0,
      "CD4 SP": gated[fx.quadrants[2].population_id].event_count,
      DN: gated[fx.quadrants[3].population_id].event_count,
    });
    expect(d2.config.n_events).toBe(5);
  });

  it("is drawn once along the figure's populations, while the other plots keep one panel per population", () => {
    const fx = fixture();
    // Two figure populations on the rows: All Events and CD4 SP.
    fx.figure.populations = [...fx.figure.populations, fx.refs[2]];
    const pages = layoutFigure(fx.figure, fx.samples, fx.trees);
    expect(pages).toHaveLength(1);
    const histograms = pages[0].panels.filter((panel) => panel.plot.id === "size");
    const biplots = pages[0].panels.filter((panel) => panel.plot.id === "quadrants");
    // One overlay panel a file, not one a file for each figure population.
    expect(histograms.map((panel) => panel.samples)).toEqual([["D1"], ["D2"]]);
    expect(biplots.map((panel) => [panel.population.label, panel.samples[0]])).toEqual([
      ["All Events", "D1"], ["All Events", "D2"], ["CD4 SP", "D1"], ["CD4 SP", "D2"],
    ]);
    // Three rows: All Events / Quadrants, All Events / Size, CD4 SP / Quadrants.
    expect(pages[0].rows.map((row) => row.map((v) => v.label).join(" / "))).toEqual([
      "All Events / Quadrants", "All Events / Size", "CD4 SP / Quadrants",
    ]);
    // The overlay panel still draws each quadrant with the gate list's events.
    const source = prepareFigureSource(D1, fx.trees[fx.state.active_hierarchy_id], fx.state);
    const config = buildFigurePanel(histograms[0], fx.figure, [source], fx.trees, figureStyle(defaultIllustrationConfig()), {}, true).config!;
    const gated = recompute(D1.sample, fx.state).populations;
    expect(config.n_events).toBe(fx.quadrants.reduce((n, p) => n + (gated[p.population_id].event_count ?? 0), 0));
    // With the populations on the columns the overlay plot fills only the first column.
    fx.figure.rows = ["plots"];
    fx.figure.columns = ["populations", "samples"];
    const byColumn = layoutFigure(fx.figure, fx.samples, fx.trees)[0];
    expect(byColumn.panels.filter((p) => p.plot.id === "size" && p.samples.length).map((p) => [p.row, p.column])).toEqual([[1, 0], [1, 1]]);
    expect(byColumn.panels.filter((p) => p.plot.id === "quadrants" && p.samples.length)).toHaveLength(4);
  });

  it("is refused by the schema when its populations are not references", () => {
    const fx = fixture();
    expect(isFigureSpec({ ...fx.figure, plots: [{ ...fx.figure.plots[1], populations: [{ populationId: 3 }] }] })).toBe(false);
  });
});
