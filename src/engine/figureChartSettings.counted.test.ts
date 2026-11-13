// An Illustration figure's chart plot holding Plotting settings under their Plotting names: kept
// through a workspace save and load, an invalid one dropped without the workspace failing to open,
// and nothing drawn differently, against a gate drawn and counted. Synthetic files D1 and D2;
// nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { isFigureSpec } from "./figureSchema";
import { figureHierarchies, layoutFigure, migrateFigure, prepareFigureSource, type FigurePopulation, type FigureSample, type FigureSpec } from "./figure";
import { BASE_PROPORTIONS_SETTINGS, FIGURE_CHART_SETTING_KEYS, figureChartOwnSettings, type ProportionsSettings } from "./proportionsSettings";
import { packWorkspaceReference, readWorkspaceBytes, type WorkspaceFile } from "./workspace";

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

// D1: CD8 SP 3, DP 1, CD4_positive (CD4 SP) 4. D2: CD8 SP 1, CD4_positive 2, DN 2.
const D1 = file("D1", [
  [LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30],
  [HIGH, HIGH, 40],
  [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80],
]);
const D2 = file("D2", [[LOW, HIGH, 15], [HIGH, LOW, 55], [HIGH, LOW, 65], [LOW, LOW, 90], [LOW, LOW, 100]]);

/** The owned settings a figure's chart carries in these tests. */
const OWNED = { showN: true, test: true, comparisons: "pairwise", palette: "viridis", valueMin: 0, replicateMarks: "median", colourByPopulation: true } as const;

function fixture(chartExtra: Record<string, unknown> = {}) {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 8 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "CD8",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["CD8 SP", "DP", "CD4_positive", "DN"],
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
    sampleIds: ["D1", "D2"],
    populations: [refs[2]],
    plots: [
      { id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram" },
      { id: "violin", name: "FSC-A violin", x: "FSC-A", y: "FSC-A", type: "chart", chart: { valueKind: "cells", plotType: "violin", ...chartExtra } as FigureSpec["plots"][number]["chart"] },
    ],
    rows: ["populations", "plots"],
    columns: ["samples"],
    pages: [],
    composition: "separate",
  };
  return { state: core, quadrants, trees, samples, figure };
}

function workspace(state: CoreState, figure: FigureSpec): WorkspaceFile {
  return {
    format: "gatelab-workspace",
    version: 2,
    savedAt: "2026-01-01T00:00:00.000Z",
    app: "GateLab",
    samples: [D1, D2].map((entry, index) => ({ fileName: entry.name, dataPath: `data/${index}_${entry.name}`, logicleW: {}, compensationOn: false })),
    activeSample: 0,
    gating: {
      gates: state.gates,
      gate_order: state.gate_order,
      populations: state.populations,
      root_population_id: state.root_population_id,
      active_population_id: state.active_population_id,
      selected_gate_id: null,
    },
    scales: { globalScales: {} },
    display: { xChannel: "FSC-A", yChannel: "SSC-A", mode: "contour", maxEvents: 20000, contourThreshold: 10 },
    illustration: { figure } as WorkspaceFile["illustration"],
    illustrationPresets: [{ name: "P1", config: { figure } }] as unknown as WorkspaceFile["illustrationPresets"],
  } as WorkspaceFile;
}

/** Save and load a workspace, then load its figure as the Illustration tab does. */
function reload(fx: ReturnType<typeof fixture>): { figure: FigureSpec; preset: FigureSpec } {
  const ws = readWorkspaceBytes(packWorkspaceReference(workspace(fx.state, fx.figure))).ws;
  const load = (config: unknown) => migrateFigure(config as Parameters<typeof migrateFigure>[0], fx.samples, fx.trees, fx.state.active_hierarchy_id, "CD4", "CD8");
  return { figure: load(ws.illustration), preset: load(ws.illustrationPresets![0].config) };
}

/** CD4_positive's count in each file, from the gate and from the mask the figure's violin panel draws. */
function counts(fx: ReturnType<typeof fixture>, figure: FigureSpec) {
  const [page] = layoutFigure(figure, fx.samples, fx.trees);
  return fx.samples.map((entry) => {
    const panel = page.panels.find((p) => p.plot.id === "violin" && p.samples[0] === entry.id)!;
    const source = prepareFigureSource(entry, fx.trees[fx.state.active_hierarchy_id], fx.state);
    const mask = source.gating.masks[panel.population.populationId];
    return { gate: recompute(entry.sample, fx.state).populations[fx.quadrants[2].population_id].event_count, drawn: mask.reduce((n, v) => n + v, 0) };
  });
}

describe("A figure's chart plot holding Plotting settings", () => {
  it("loads an older figure without them deeply equal, with no settings of its own", () => {
    const fx = fixture();
    const loaded = reload(fx);
    expect(loaded.figure).toEqual(fx.figure);
    expect(loaded.preset).toEqual(fx.figure);
    expect(figureChartOwnSettings(loaded.figure.plots[1].chart)).toEqual({});
    expect(figureChartOwnSettings(undefined)).toEqual({});
    expect(counts(fx, loaded.figure)).toEqual([{ gate: 4, drawn: 4 }, { gate: 2, drawn: 2 }]);
  });

  it("keeps its settings through a workspace save and load and a preset, and returns exactly them", () => {
    const fx = fixture(OWNED);
    expect(isFigureSpec(fx.figure)).toBe(true);
    const loaded = reload(fx);
    expect(loaded.figure).toEqual(fx.figure);
    expect(loaded.preset).toEqual(fx.figure);
    expect(figureChartOwnSettings(loaded.figure.plots[1].chart)).toEqual(OWNED);
    expect(figureChartOwnSettings(loaded.preset.plots[1].chart)).toEqual(OWNED);
  });

  it("drops an invalid setting and a figure-decided key, and the workspace still opens", () => {
    const fx = fixture({ ...OWNED, showN: "yes", comparisons: "all-pairs", valueMin: "0", files: ["D1"], selectedPops: ["x"], fontTick: 12, panelWidth: 300 });
    expect(isFigureSpec(fx.figure)).toBe(true);
    const loaded = reload(fx);
    const { showN: _s, comparisons: _c, valueMin: _v, ...valid } = OWNED;
    void _s; void _c; void _v;
    expect(figureChartOwnSettings(loaded.figure.plots[1].chart)).toEqual(valid);
    // Validated as Plotting validates: a point radius out of range is clamped, null limits are automatic.
    expect(figureChartOwnSettings({ valueKind: "cells", plotType: "box", pointRadius: 40, valueMax: null, colourByPopulation: false })).toEqual({ pointRadius: 5, valueMax: null });
  });

  it("classifies every Plotting setting in exactly one group", () => {
    const shared = ["valueKind", "plotType", "statistic", "violinBox"] as const;
    const decided = [
      "files", "hierarchy", "parent", "selectedPops", "categoryKind", "channel", "channels", "facetSel", "panelColumns",
      "panelRows", "pageBy", "panelsPerRow", "panelWidth", "height", "cellRange", "fontTick", "fontAxis", "fontLegend", "followFigureStyle",
    ] as const;
    // A setting added to ProportionsSettings without a group fails to compile here.
    type Unclassified = Exclude<keyof ProportionsSettings, (typeof shared)[number] | (typeof decided)[number] | (typeof FIGURE_CHART_SETTING_KEYS)[number]>;
    const none: [Unclassified] extends [never] ? true : false = true;
    expect(none).toBe(true);
    const groups = [...shared, ...decided, ...FIGURE_CHART_SETTING_KEYS];
    expect(new Set(groups).size).toBe(groups.length);
    // The optional settings are absent from the defaults; every other one is there.
    const keys = new Set([...Object.keys(BASE_PROPORTIONS_SETTINGS), "colourByPopulation", "populationsTogether", "followFigureStyle"]);
    expect([...keys].sort()).toEqual([...groups].sort());
  });

  it("lays out the same panels and counts the gate the same with the settings present and absent", () => {
    const plain = fixture();
    const held = { ...plain, figure: { ...plain.figure, plots: plain.figure.plots.map((p) => (p.chart ? { ...p, chart: { ...p.chart, ...OWNED } } : p)) } };
    const strip = (pages: ReturnType<typeof layoutFigure>) => JSON.parse(JSON.stringify(pages, (key, value) => (key === "chart" ? undefined : value)));
    expect(strip(layoutFigure(held.figure, held.samples, held.trees))).toEqual(strip(layoutFigure(plain.figure, plain.samples, plain.trees)));
    expect(counts(held, held.figure)).toEqual(counts(plain, plain.figure));
    expect(counts(held, held.figure)).toEqual([{ gate: 4, drawn: 4 }, { gate: 2, drawn: 2 }]);
  });
});
