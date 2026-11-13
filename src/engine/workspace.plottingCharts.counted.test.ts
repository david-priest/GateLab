// The Plotting tab's named charts through a workspace save and reload, drawn and counted: gates
// drawn around known events, each chart's numbers checked against the gate list's counts.
// Synthetic donors D1 and D2, each with a control and a treated file; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation, type Population } from "./models";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { buildProportionsModel, defaultProportionsSettings, type ProportionsSampleRef } from "./proportionsModel";
import { normalizeProportionsSettings } from "./proportionsSettings";
import {
  FIRST_PLOTTING_CHART,
  packWorkspaceReference,
  readWorkspaceBytes,
  workspacePlottingCharts,
  type WorkspaceFile,
} from "./workspace";

// A holds FSC below 55, B (inside A) SSC below 25, C FSC from 65.
function tree() {
  const state = initialCoreState();
  const root = newRootPopulation();
  const gateA = newGate("A", "rectangle", "FSC-A", "SSC-A", [[0, 0], [55, 1000]]);
  const gateB = newGate("B", "rectangle", "FSC-A", "SSC-A", [[0, 0], [1000, 25]]);
  const gateC = newGate("C", "rectangle", "FSC-A", "SSC-A", [[65, 0], [1000, 1000]]);
  const a = newPopulation("A", [newGateRef(gateA.gate_id)], root.population_id);
  const b = newPopulation("B", [newGateRef(gateB.gate_id)], a.population_id);
  const c = newPopulation("C", [newGateRef(gateC.gate_id)], root.population_id);
  root.children = [a.population_id, c.population_id];
  a.children = [b.population_id];
  const populations: Record<string, Population> = { [root.population_id]: root, [a.population_id]: a, [b.population_id]: b, [c.population_id]: c };
  Object.assign(state, {
    gates: { [gateA.gate_id]: gateA, [gateB.gate_id]: gateB, [gateC.gate_id]: gateC },
    gate_order: [gateA.gate_id, gateB.gate_id, gateC.gate_id],
    populations,
    root_population_id: root.population_id,
    active_population_id: root.population_id,
  });
  return { state: state as CoreState, a: a.population_id, b: b.population_id, c: c.population_id };
}

function file(id: string, fsc: number[], ssc: number[]): ProportionsSampleRef {
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
    columns: [Float32Array.from(fsc), Float32Array.from(ssc)],
  };
  return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
}

const FILES = [
  file("D1-control", [10, 20, 30, 40, 50, 60, 70, 80, 90, 95], [10, 20, 30, 40, 50, 50, 50, 50, 50, 50]), // A 5, B 2, C 4
  file("D1-treated", [10, 20, 30, 60, 70, 80, 90, 95, 96, 97], [10, 50, 50, 50, 50, 50, 50, 50, 50, 50]), // A 3, B 1, C 6
  file("D2-control", [10, 20, 30, 40, 60, 60, 70, 80, 90, 95], [10, 10, 10, 40, 50, 50, 50, 50, 50, 50]), // A 4, B 3, C 4
  file("D2-treated", [10, 20, 60, 60, 60, 70, 80, 90, 95, 96], [10, 50, 50, 50, 50, 50, 50, 50, 50, 50]), // A 2, B 1, C 5
];
const METADATA = {
  "D1-control": { donor: "D1", condition: "control" },
  "D1-treated": { donor: "D1", condition: "treated" },
  "D2-control": { donor: "D2", condition: "control" },
  "D2-treated": { donor: "D2", condition: "treated" },
};

function workspace(state: CoreState, extra: Partial<WorkspaceFile>): WorkspaceFile {
  return {
    format: "gatelab-workspace",
    version: 2,
    savedAt: "2026-01-01T00:00:00.000Z",
    app: "GateLab",
    samples: FILES.map((entry, index) => ({ fileName: entry.name, dataPath: `data/${index}_${entry.name}`, logicleW: {}, compensationOn: false, metadata: METADATA[entry.id as keyof typeof METADATA] })),
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
    display: { xChannel: "FSC-A", yChannel: "SSC-A", mode: "contour", maxEvents: 20000, contourThreshold: 10, densityColorPower: 1.8, fontSizes: { tick: 12, axis: 14, title: 11, gate: 12 } },
    ...extra,
  } as WorkspaceFile;
}

/** The reloaded workspace's gate tree, as the app takes it from the file. */
function reloadedState(ws: WorkspaceFile): CoreState {
  return { ...initialCoreState(), ...ws.gating } as CoreState;
}

/** A chart's settings as the Plotting tab shows them: its `prop.` keys over the workspace's defaults. */
function chartSettings(plotting: Record<string, unknown>, state: CoreState) {
  const held = Object.fromEntries(Object.entries(plotting).filter(([key]) => key.startsWith("prop.")).map(([key, value]) => [key.slice(5), value]));
  return normalizeProportionsSettings(held, defaultProportionsSettings(FILES, state, []));
}

function counts(plotting: Record<string, unknown>, state: CoreState): number[][] {
  const model = buildProportionsModel(chartSettings(plotting, state), FILES, state, METADATA, {});
  return model.perSample.map((row) => row.popCounts ?? []);
}

/** What the gate list counts in each file for the populations given. */
function gateList(state: CoreState, ids: string[]): number[][] {
  return FILES.map((entry) => {
    const derived = recompute(entry.sample, state);
    return ids.map((id) => derived.populations[id].event_count ?? 0);
  });
}

function roundTrip(ws: WorkspaceFile): WorkspaceFile {
  return readWorkspaceBytes(packWorkspaceReference(ws)).ws;
}

describe("Plotting charts in a saved workspace", () => {
  it("saves two named charts and reloads both, each counting its own populations as the gate list does", () => {
    const fx = tree();
    const first = { "prop.selectedPops": [fx.a, fx.c], "prop.plotType": "stacked", "prop.fontTick": 12 };
    const second = { "prop.selectedPops": [fx.b], "prop.parent": fx.a, "prop.files": ["D1-control", "D2-control"], "prop.plotType": "box" };
    const saved = workspace(fx.state, {
      plotting: second,
      plottingCharts: {
        activeId: "chart-b",
        charts: [
          { id: "chart-a", name: "CD4_positive share", plotting: first },
          { id: "chart-b", name: "Controls only", plotting: second },
        ],
      },
    });
    const reloaded = roundTrip(saved);
    const charts = workspacePlottingCharts(reloaded);
    expect(charts.activeId).toBe("chart-b");
    expect(charts.charts.map(({ id, name }) => [id, name])).toEqual([["chart-a", "CD4_positive share"], ["chart-b", "Controls only"]]);
    expect(charts.charts[0].plotting).toEqual(first);
    expect(charts.charts[1].plotting).toEqual(second);

    const state = reloadedState(reloaded);
    expect(chartSettings(charts.charts[0].plotting, state).fontTick).toBe(12);
    expect(counts(charts.charts[0].plotting, state)).toEqual(gateList(state, [fx.a, fx.c]));
    expect(counts(charts.charts[0].plotting, state)).toEqual([[5, 4], [3, 6], [4, 4], [2, 5]]);
    // The second chart draws the two control files only, B within A.
    const model = buildProportionsModel(chartSettings(charts.charts[1].plotting, state), FILES, state, METADATA, {});
    expect(model.perSample.map((row) => row.popCounts)).toEqual([[2], [3]]);
    expect(gateList(state, [fx.b])).toEqual([[2], [1], [3], [1]]);
  });

  it("reads a workspace saved before named charts as one chart named Chart 1, with the same settings and counts", () => {
    const fx = tree();
    const plotting = { "prop.selectedPops": [fx.a, fx.b, fx.c], "prop.plotType": "box", "prop.groupSel": "condition" };
    const older = roundTrip(workspace(fx.state, { plotting }));
    expect(older.plottingCharts).toBeUndefined();
    const charts = workspacePlottingCharts(older);
    expect(charts).toEqual({ activeId: FIRST_PLOTTING_CHART.id, charts: [{ id: FIRST_PLOTTING_CHART.id, name: "Chart 1", plotting }] });
    const state = reloadedState(older);
    expect(chartSettings(charts.charts[0].plotting, state)).toEqual(chartSettings(plotting, fx.state));
    expect(counts(charts.charts[0].plotting, state)).toEqual(counts(plotting, fx.state));
    expect(counts(charts.charts[0].plotting, state)).toEqual([[5, 2, 4], [3, 1, 6], [4, 3, 4], [2, 1, 5]]);
    // A workspace with no Plotting state at all is one chart of the defaults.
    expect(workspacePlottingCharts({}).charts).toEqual([{ id: FIRST_PLOTTING_CHART.id, name: "Chart 1", plotting: {} }]);
  });

  it("drops malformed or repeated charts and shows the first when the shown one is gone", () => {
    const charts = workspacePlottingCharts({
      plotting: { "prop.plotType": "box" },
      plottingCharts: {
        activeId: "missing",
        charts: [
          { id: "chart-a", name: "control", plotting: { "prop.plotType": "stacked" } },
          { id: "chart-a", name: "repeated", plotting: {} },
          { id: "", name: "no id", plotting: {} },
          { id: "chart-c", name: 3, plotting: {} },
          { id: "chart-d", name: "treated", plotting: [] },
        ],
      } as unknown as WorkspaceFile["plottingCharts"],
    });
    expect(charts).toEqual({ activeId: "chart-a", charts: [{ id: "chart-a", name: "control", plotting: { "prop.plotType": "stacked" } }] });
    // Nothing usable in the list: the workspace's own plotting settings, as an older workspace.
    expect(workspacePlottingCharts({ plotting: { "prop.plotType": "box" }, plottingCharts: { activeId: "x", charts: [] } }).charts[0].plotting).toEqual({ "prop.plotType": "box" });
  });
});
