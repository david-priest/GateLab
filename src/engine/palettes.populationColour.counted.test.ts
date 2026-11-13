// One population, one colour: the Illustration figure (figure.ts) and the Plotting chart
// (proportionsModel.ts) take a population's colour through populationColorOf, a colour of its own
// where it has one, else its slot's in the default palette, whatever palette the chart is set to.
// A quadrant gate drawn on synthetic files D1 and D2 and counted; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { plottingPopulationColors, populationColor, populationColorOf, populationOverlayColor } from "./palettes";
import { proportionsCategoryColors } from "./proportionsModel";
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

// D1: CD8 SP 3, DP 1, CD4 SP 4, DN 1.
const D1 = file("D1", [
  [LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30],
  [HIGH, HIGH, 40],
  [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80],
  [LOW, LOW, 90],
]);

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 9 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "CD8",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["CD8 SP", "DP", "CD4 SP", "DN"],
  });
  const gate = Object.values(state.gates).find((g) => g.gate_type === "quadrant")!;
  const quadrants = [1, 2, 3, 4].map((q) =>
    Object.values(state.populations).find((p) => p.gate_refs.some((r) => r.gate_id === gate.gate_id && r.quadrant === q))!,
  );
  // DP in a colour of its own; the others in their slots' colours.
  const dpId = quadrants[1].population_id;
  const core: CoreState = { ...state, populations: { ...state.populations, [dpId]: { ...state.populations[dpId], color: "#123456" } } };
  return { state: core, quadrants: quadrants.map((p) => core.populations[p.population_id]) };
}

function illustrationColours(state: CoreState, populationIds: string[]): string[] {
  const trees = figureHierarchies(state);
  const samples = [D1];
  const figure = migrateFigure(null, samples, trees, state.active_hierarchy_id, "CD4", "CD8");
  const refs: FigurePopulation[] = populationIds.map((id) => ({ hierarchyId: state.active_hierarchy_id, populationId: id, label: state.populations[id].name }));
  figure.sampleIds = ["D1"];
  figure.populations = [{ hierarchyId: state.active_hierarchy_id, populationId: state.root_population_id!, label: "All Events" }];
  figure.plots = [{ id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram", populations: refs }];
  figure.rows = ["populations", "plots"];
  figure.columns = ["samples"];
  figure.pages = [];
  figure.composition = "separate";
  const panel = layoutFigure(figure, samples, trees)[0].panels[0];
  const source = prepareFigureSource(D1, trees[state.active_hierarchy_id], state);
  const config = buildFigurePanel(panel, figure, [source], trees, figureStyle(defaultIllustrationConfig()), {}, true).config!;
  const gated = recompute(D1.sample, state).populations;
  const traces = [{ x: config.x as number[] }, ...(config.overlay_traces as { x: number[] }[])];
  populationIds.forEach((id, i) => expect(traces[i].x).toHaveLength(gated[id].event_count ?? -1));
  return (config.legend_entries as { color: string }[]).map((entry) => entry.color);
}

describe("a population's colour is one in every view", () => {
  it("is the same in the Illustration figure and the Plotting chart, in any chart palette", () => {
    const fx = fixture();
    const ids = fx.quadrants.map((p) => p.population_id);
    const gated = recompute(D1.sample, fx.state).populations;
    expect(ids.map((id) => gated[id].event_count)).toEqual([3, 1, 4, 1]);
    const expected = fx.quadrants.map((p) => populationColorOf(p)!);
    expect(expected[1]).toBe("#123456");
    expect(expected[0]).toBe(populationColor("default", fx.quadrants[0].colorSlot));
    expect(illustrationColours(fx.state, ids)).toEqual(expected);
    const model = { catLevels: fx.quadrants.map((p) => p.name), levels: ids.map((popId) => ({ popId, depth: 1 })) };
    for (const palette of ["paired", "default", "viridis"] as const) {
      expect(proportionsCategoryColors(model, { palette, includeUngated: false }, fx.state.populations)).toEqual(expected);
    }
  });

  it("gives a population past the twelfth slot a colour no earlier slot has, the same in every view", () => {
    // Slots 13 and 1 fall on one colour when the twelve slot colours wrap; here CD8 SP sits in slot 13
    // and CD4 SP in slot 1.
    const fx = fixture();
    const [cd8, dp, cd4, dn] = fx.quadrants.map((p) => p.population_id);
    const state: CoreState = {
      ...fx.state,
      populations: {
        ...fx.state.populations,
        [cd8]: { ...fx.state.populations[cd8], colorSlot: 13 },
        [cd4]: { ...fx.state.populations[cd4], colorSlot: 1 },
        [dn]: { ...fx.state.populations[dn], colorSlot: 2 },
      },
    };
    const ids = [cd8, dp, cd4, dn];
    const gated = recompute(D1.sample, state).populations;
    expect(ids.map((id) => gated[id].event_count)).toEqual([3, 1, 4, 1]);
    const expected = ids.map((id) => populationColorOf(state.populations[id])!);
    expect(populationColor("default", 13)).toBe(populationColor("default", 1));
    expect(expected[2]).toBe(populationColor("default", 1));
    expect(new Set(expected).size).toBe(4);
    expect(illustrationColours(state, ids)).toEqual(expected);
    const model = { catLevels: ids.map((id) => state.populations[id].name), levels: ids.map((popId) => ({ popId, depth: 1 })) };
    expect(proportionsCategoryColors(model, { palette: "default", includeUngated: false }, state.populations)).toEqual(expected);
    // The Gating tab's overlay: the same colours under the default palette; under another palette
    // the slot's colour in it, and the hand-picked colour kept.
    expect(ids.map((id) => populationOverlayColor("default", state.populations[id]))).toEqual(expected);
    expect(ids.map((id) => populationOverlayColor("paired", state.populations[id]))).toEqual([
      populationColor("paired", 13), "#123456", populationColor("paired", 1), populationColor("paired", 2),
    ]);
  });

  it("gives the first 24 slots 24 colours, the first twelve the slot colours", () => {
    const colours = Array.from({ length: 24 }, (_, colorSlot) => populationColorOf({ colorSlot })!);
    expect(new Set(colours).size).toBe(24);
    expect(colours.slice(0, 12)).toEqual(Array.from({ length: 12 }, (_, slot) => populationColor("default", slot)));
    expect(populationColorOf({ colorSlot: 24 })).toBe(colours[0]);
  });

  it("keeps a hand-picked colour in the Plotting chart and gives no other category the same one", () => {
    // A population picked in slot 1's colour: the one in slot 1 passes on to a colour no other holds.
    const slot1 = populationColor("default", 1);
    const colors = plottingPopulationColors("default", [0, 1, 2], ["#ABCDEF".toLowerCase(), undefined, undefined]);
    expect(colors).toEqual(["#abcdef", slot1, populationColor("default", 2)]);
    const taken = plottingPopulationColors("default", [5, 1, 2], [slot1, undefined, undefined]);
    expect(taken[0]).toBe(slot1);
    expect(new Set(taken).size).toBe(3);
  });
});
