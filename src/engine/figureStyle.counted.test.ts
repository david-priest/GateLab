// The workspace's figure style through a workspace save and reload, drawn and counted: the style
// and each tab's choice to follow it come back as saved, a workspace saved before them loads with
// every sheet, chart, figure and strategy drawn from its own values as before, and the gates the
// charts count still count as the gate list does. Synthetic donors D1 and D2; nothing here is a
// real experiment.

import { describe, expect, it } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation, type Population } from "./models";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { buildProportionsModel, defaultProportionsSettings, type ProportionsSampleRef } from "./proportionsModel";
import { normalizeProportionsSettings } from "./proportionsSettings";
import { createLayoutSheet, DEFAULT_LAYOUT_STYLE, effectiveLayoutStyle, normalizeLayoutWorkspace, type LayoutPlotStyle } from "./layout";
import { DEFAULT_FIGURE_STYLE, FIGURE_STYLE_KEYS, isDefaultFigureStyle, normalizeFigureStyle } from "./figureStyle";
import { packWorkspaceReference, readWorkspaceBytes, workspacePlottingCharts, type WorkspaceFile } from "./workspace";

// CD4_positive holds FSC below 55.
function tree() {
  const state = initialCoreState();
  const root = newRootPopulation();
  const gate = newGate("CD4_positive", "rectangle", "FSC-A", "SSC-A", [[0, 0], [55, 1000]]);
  const pop = newPopulation("CD4_positive", [newGateRef(gate.gate_id)], root.population_id);
  root.children = [pop.population_id];
  const populations: Record<string, Population> = { [root.population_id]: root, [pop.population_id]: pop };
  Object.assign(state, {
    gates: { [gate.gate_id]: gate },
    gate_order: [gate.gate_id],
    populations,
    root_population_id: root.population_id,
    active_population_id: root.population_id,
  });
  return { state: state as CoreState, pop: pop.population_id };
}

function file(id: string, fsc: number[]): ProportionsSampleRef {
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: fsc.length,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from(fsc), Float32Array.from(fsc.map(() => 10))],
  };
  return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
}

// D1: 3 of 5 events CD4_positive; D2: 1 of 4.
const FILES = [file("D1", [10, 20, 30, 70, 80]), file("D2", [10, 60, 70, 80])];

function workspace(state: CoreState, extra: Partial<WorkspaceFile>): WorkspaceFile {
  return {
    format: "gatelab-workspace",
    version: 2,
    savedAt: "2026-01-01T00:00:00.000Z",
    app: "GateLab",
    samples: FILES.map((entry, index) => ({ fileName: entry.name, dataPath: `data/${index}_${entry.name}`, logicleW: {}, compensationOn: false })),
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
    ...extra,
  } as WorkspaceFile;
}

const roundTrip = (ws: WorkspaceFile): WorkspaceFile => readWorkspaceBytes(packWorkspaceReference(ws)).ws;

/** The CD4_positive count of each file, as the gate list has it and as a chart of the settings draws it. */
function counted(state: CoreState, pop: string, plotting: Record<string, unknown>) {
  const held = Object.fromEntries(Object.entries(plotting).map(([key, value]) => [key.slice(5), value]));
  const settings = normalizeProportionsSettings(held, defaultProportionsSettings(FILES, state, []));
  const model = buildProportionsModel(settings, FILES, state, {}, {});
  return {
    settings,
    chart: model.perSample.map((row) => row.popCounts?.[0] ?? 0),
    gateList: FILES.map((entry) => recompute(entry.sample, state).populations[pop].event_count ?? 0),
  };
}

/** A sheet's figure fields as the app gives them: the style's sizes, and the gate ink's width and colour. */
const figureFields = (style = DEFAULT_FIGURE_STYLE): Partial<LayoutPlotStyle> => ({ ...style, gateLineWidth: 1.2, pubStyle: true });

describe("The workspace's figure style", () => {
  it("defaults to a new Layout sheet's style and keeps a saved one's fields within their ranges", () => {
    for (const key of FIGURE_STYLE_KEYS) expect(DEFAULT_FIGURE_STYLE[key]).toBe(DEFAULT_LAYOUT_STYLE[key]);
    expect(normalizeFigureStyle(undefined)).toEqual(DEFAULT_FIGURE_STYLE);
    expect(normalizeFigureStyle({ fontTick: 400, fontAxis: "12", histLineWidth: 2.5, extra: 1 })).toEqual({ ...DEFAULT_FIGURE_STYLE, fontTick: 40, histLineWidth: 2.5 });
    expect(isDefaultFigureStyle(normalizeFigureStyle({}))).toBe(true);
    expect(isDefaultFigureStyle(normalizeFigureStyle({ fontGate: 12 }))).toBe(false);
  });

  it("is saved and loaded with each tab's choice to follow it, and the charts count the gate as the gate list does", () => {
    const fx = tree();
    const style = { ...DEFAULT_FIGURE_STYLE, fontTick: 8, fontAxis: 10, fontLegend: 9, fontTitle: 12, fontGate: 7, histLineWidth: 1.2 };
    const sheet = { ...createLayoutSheet("S"), style: { fontTick: 14 }, followFigureStyle: true };
    const plotting = { "prop.selectedPops": [fx.pop], "prop.plotType": "box", "prop.fontTick": 15, "prop.followFigureStyle": true };
    const saved = roundTrip(workspace(fx.state, {
      figureStyle: style,
      layout: { version: 2, activeSheetId: sheet.id, sheets: [sheet] },
      plotting,
      plottingCharts: { activeId: "chart-1", charts: [{ id: "chart-1", name: "Chart 1", plotting }] },
      illustration: { followFigureStyle: true, fontTick: 10 } as WorkspaceFile["illustration"],
      strategy: { followFigureStyle: true, fontTick: 12 } as WorkspaceFile["strategy"],
    }));

    expect(normalizeFigureStyle(saved.figureStyle)).toEqual(style);
    const layout = normalizeLayoutWorkspace(saved.layout);
    expect(layout.sheets[0].followFigureStyle).toBe(true);
    // The sheet keeps its own tick size, which gives way to the style's while it follows.
    expect(layout.sheets[0].style).toEqual({ fontTick: 14 });
    expect(effectiveLayoutStyle(layout.sheets[0], null, figureFields(style))).toMatchObject({ fontTick: 8, fontAxis: 10, fontLegend: 9, fontTitle: 12, fontGate: 7, histLineWidth: 1.2, gateLineWidth: 1.2, pubStyle: true });
    expect(saved.illustration?.followFigureStyle).toBe(true);
    expect(saved.strategy?.followFigureStyle).toBe(true);

    const chart = workspacePlottingCharts(saved).charts[0].plotting;
    const drawn = counted(fx.state, fx.pop, chart);
    expect(drawn.settings.followFigureStyle).toBe(true);
    expect(drawn.settings.fontTick).toBe(15);
    expect(drawn.gateList).toEqual([3, 1]);
    expect(drawn.chart).toEqual(drawn.gateList);
  });

  it("leaves everything in a workspace saved before it drawn from its own values, counting as before", () => {
    const fx = tree();
    const sheet = { ...createLayoutSheet("S"), style: { fontTick: 14, gateLineWidth: 2 } };
    const plotting = { "prop.selectedPops": [fx.pop], "prop.plotType": "box", "prop.fontTick": 15 };
    const older = roundTrip(workspace(fx.state, {
      layout: { version: 2, activeSheetId: sheet.id, sheets: [sheet] },
      plotting,
      illustration: { fontTick: 10 } as WorkspaceFile["illustration"],
      strategy: { fontTick: 12 } as WorkspaceFile["strategy"],
    }));

    expect(older.figureStyle).toBeUndefined();
    expect(normalizeFigureStyle(older.figureStyle)).toEqual(DEFAULT_FIGURE_STYLE);
    const layout = normalizeLayoutWorkspace(older.layout);
    expect(layout.sheets[0]).not.toHaveProperty("followFigureStyle");
    // A sheet that does not follow is drawn from its own style whatever the workspace's is.
    const changed = { ...DEFAULT_FIGURE_STYLE, fontTick: 6, histLineWidth: 3 };
    expect(effectiveLayoutStyle(layout.sheets[0], null, figureFields(changed))).toEqual(effectiveLayoutStyle(layout.sheets[0]));
    expect(effectiveLayoutStyle(layout.sheets[0])).toMatchObject({ fontTick: 14, gateLineWidth: 2, histLineWidth: DEFAULT_LAYOUT_STYLE.histLineWidth });
    expect(older.illustration).not.toHaveProperty("followFigureStyle");
    expect(older.strategy).not.toHaveProperty("followFigureStyle");

    const chart = workspacePlottingCharts(older).charts[0].plotting;
    const drawn = counted(fx.state, fx.pop, chart);
    expect(drawn.settings).not.toHaveProperty("followFigureStyle");
    expect(drawn.settings.fontTick).toBe(15);
    expect(drawn.chart).toEqual([3, 1]);
    expect(drawn.chart).toEqual(drawn.gateList);
  });
});
