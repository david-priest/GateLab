// A plot of the Gating tab that is not the selected one: the events of its own population on its
// own channels, and the gates on those channels counted in that population.
// Synthetic files D1 and D2, channels A, B and C, one rectangle gate "high A" on A and B.

import { describe, expect, it } from "vitest";
import { decodeFloat32Base64 } from "../engine/encode";
import type { FcsFile } from "../engine/fcs";
import { Sample } from "../engine/sample";
import { coreReducer, initialCoreState, recomputeGating, type CoreState } from "../store";
import { buildCompanionPlot, type CompanionPlotInput, type CompanionPlotLook, type CompanionPlotView } from "./companionPlotPayload";

type Event = [number, number, number];
function fcs(events: Event[]): FcsFile {
  const channels = ["A", "B", "C"].map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 }));
  return {
    version: "FCS3.1", nEvents: events.length, instrument: "flow", keywords: {}, spillover: null, channels,
    columns: channels.map((_, c) => Float32Array.from(events.map((event) => event[c]))),
  };
}
// "high A" holds A from 1000 to 9000 with B from 0 to 9000.
const D1: Event[] = [[5000, 100, 1], [6000, 200, 2], [7000, 300, 3], [100, 100, 4], [200, 200, 5]];
const D2: Event[] = [[5000, 100, 6], [100, 100, 7], [150, 100, 8], [120, 100, 9]];

const LOOK: CompanionPlotLook = {
  mode: "dots", maxEvents: 0, contourThreshold: 5, contourLevels: 8, pointAlpha: 0.8, pointSize: 1,
  densityColorPower: 1, gateEdgeMode: "straight", colouredGates: true, gateLineWidth: 1.2, gateLabelBackground: 0.85,
};

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: D1.length }) as CoreState;
  state = coreReducer(state, {
    type: "addGate", gateType: "rectangle", xChannel: "A", yChannel: "B", space: "raw",
    vertices: [[1000, 0], [9000, 0], [9000, 9000], [1000, 9000]],
    name: "high A gate", createPop: { name: "high A", parentId: state.root_population_id! },
  }) as CoreState;
  const population = Object.values(state.populations).find((p) => p.name === "high A")!.population_id;
  const gate = Object.keys(state.gates)[0];
  const d1 = new Sample(fcs(D1));
  const d2 = new Sample(fcs(D2));
  const input = (view: CompanionPlotView, extra: Partial<CompanionPlotInput> = {}): CompanionPlotInput => ({
    view,
    file: { id: "D1", name: "D1.fcs", sample: d1, gating: recomputeGating(d1, state) },
    state,
    drawnGates: state.gates,
    branchGatesOnly: false,
    showUnownedGates: false,
    globalScales: {},
    pool: null,
    countScope: (kind, count) => ({ text: kind, hint: `${count} files` }),
    look: LOOK,
    ...extra,
  });
  return { state, population, gate, d1, d2, input };
}
const view = (populationId: string | null, xKey = "A", yKey = "B", histogram = false): CompanionPlotView =>
  ({ populationId, selectedPopulationIds: [], xKey, yKey, histogram });
const gates = (plot: { payload: Record<string, unknown> }) =>
  plot.payload.gates as { gate_id: string; event_count?: number; percent?: number; label?: string }[];

describe("a plot that is not the selected one", () => {
  it("draws its own population on its own channels, whatever the selected plot shows", () => {
    const fx = fixture();
    const all = buildCompanionPlot(fx.input(view(fx.state.root_population_id)))!;
    expect(all.payload.n_events).toBe(5);
    expect(all.populationEvents).toBe(5);
    expect(all.payload.x_label).toBe("A");
    expect(all.payload.y_label).toBe("B");

    const gated = buildCompanionPlot(fx.input(view(fx.population, "C", "A")))!;
    expect(gated.payload.n_events).toBe(3);
    expect(gated.title).toBe("high A");
    expect(gated.payload.x_label).toBe("C");
    expect([...decodeFloat32Base64(gated.payload.x_b64 as string)].sort()).toEqual(
      [...fx.d1.displayColumn(2)].slice(0, 3).sort());
  });

  it("draws the gates on its channels, and none on channels that hold none", () => {
    const fx = fixture();
    expect(gates(buildCompanionPlot(fx.input(view(fx.state.root_population_id)))!).map((g) => g.gate_id)).toEqual([fx.gate]);
    expect(gates(buildCompanionPlot(fx.input(view(fx.state.root_population_id, "C", "A")))!)).toEqual([]);
  });

  it("follows a gate as it changes: the events of the population it defines, and the gate where it is drawn", () => {
    const fx = fixture();
    const before = buildCompanionPlot(fx.input(view(fx.population, "C", "A")))!;
    // The gate drawn in to A from 5500: one event of D1 leaves the population.
    const edited = coreReducer(fx.state, {
      type: "editGate", gateId: fx.gate, vertices: [[5500, 0], [9000, 0], [9000, 9000], [5500, 9000]],
    }) as CoreState;
    const after = buildCompanionPlot(fx.input(view(fx.population, "C", "A"), {
      state: edited, drawnGates: edited.gates, file: { id: "D1", name: "D1.fcs", sample: fx.d1, gating: recomputeGating(fx.d1, edited) },
    }))!;
    expect(before.payload.n_events).toBe(3);
    expect(after.payload.n_events).toBe(2);
  });

  it("shows all events when its population has been deleted", () => {
    const fx = fixture();
    const plot = buildCompanionPlot(fx.input(view("gone")))!;
    expect(plot.payload.n_events).toBe(5);
    expect(plot.title).toBe(fx.state.populations[fx.state.root_population_id!].name);
  });

  it("is not drawn for a file that lacks its channels", () => {
    const fx = fixture();
    expect(buildCompanionPlot(fx.input(view(fx.state.root_population_id, "A", "Z")))).toBeNull();
  });

  it("is the histogram of its X channel when its view is one", () => {
    const fx = fixture();
    const plot = buildCompanionPlot(fx.input(view(fx.population, "C", "A", true)))!;
    expect(plot.payload.x_label).toBe("C");
    expect(plot.payload.y_label).toBe("C");
    expect(plot.payload.n_events).toBe(3);
  });

  it("holds the workspace's range for a channel that has one", () => {
    const fx = fixture();
    const plot = buildCompanionPlot(fx.input(view(fx.state.root_population_id), { globalScales: { A: [0, 4], B: [1, 3] } }))!;
    expect(plot.payload.x_range).toEqual([0, 4]);
    expect(plot.payload.y_range).toEqual([1, 3]);
  });
});

describe("a plot that is not the selected one, pooled", () => {
  it("pools the population's events over the files, each under its own gating", () => {
    const fx = fixture();
    const pool = [
      { id: "D1", name: "D1.fcs", sample: fx.d1, gating: null },
      { id: "D2", name: "D2.fcs", sample: fx.d2, gating: recomputeGating(fx.d2, fx.state) },
    ];
    const all = buildCompanionPlot(fx.input(view(fx.state.root_population_id), { pool }))!;
    expect(all.payload.n_events).toBe(9);
    const gated = buildCompanionPlot(fx.input(view(fx.population, "C", "A"), { pool }))!;
    expect(gated.payload.n_events).toBe(4);
    expect(gated.populationEvents).toBe(4);
  });

  it("draws the files gated so far while another is still being gated, and counts on the viewed file", () => {
    const fx = fixture();
    const pool = [
      { id: "D1", name: "D1.fcs", sample: fx.d1, gating: null },
      { id: "D2", name: "D2.fcs", sample: fx.d2, gating: null },
    ];
    const gated = buildCompanionPlot(fx.input(view(fx.population), { pool }))!;
    expect(gated.payload.n_events).toBe(3);
  });
});
