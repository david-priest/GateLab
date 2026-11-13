// A population's own colour (Population.color) is saved and reloaded with the workspace, an older
// workspace without it loads as it was, the old Illustration tab's popColors move onto the
// populations, and no exported gating file carries it. A quadrant gate drawn on a synthetic file
// D1 and counted throughout; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import type { PopulationMap } from "./models";
import { populationColor, populationColorOf } from "./palettes";
import { exportGatingML } from "./gatingmlExport";
import { exportFlowJoWorkspace } from "./flowjoExport";
import { exportFlowJo11Workbench } from "./flowjo11Export";
import { defaultIllustrationConfig } from "./figureDefaults";
import {
  packWorkspaceReference,
  readWorkspaceBytes,
  withLegacyPopulationColors,
  type WorkspaceFile,
} from "./workspace";

// Each event is [FITC-A (CD4), PE-A (CD8)]; the quadrant's centre is at 1000, 1000.
const LOW = 100;
const HIGH = 5000;
const EVENTS: [number, number][] = [
  [LOW, HIGH], [LOW, HIGH], [LOW, HIGH], // CD8 SP 3
  [HIGH, HIGH], // DP 1
  [HIGH, LOW], [HIGH, LOW], [HIGH, LOW], [HIGH, LOW], // CD4 SP 4
  [LOW, LOW], [LOW, LOW], // DN 2
];

function sampleD1(): Sample {
  const channels = [
    { index: 0, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
    { index: 1, name: "PE-A", marker: "CD8", bits: 32, range: 262144 },
  ];
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: EVENTS.length,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels,
    columns: channels.map((_, c) => Float32Array.from(EVENTS.map((event) => event[c]))),
  };
  return new Sample(fcs);
}

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: EVENTS.length });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "CD8",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["CD8 SP", "DP", "CD4 SP", "DN"],
  });
  const core = state as CoreState;
  const byName = (name: string) => Object.values(core.populations).find((p) => p.name === name)!;
  return { state: core, sample: sampleD1(), dp: byName("DP"), dn: byName("DN") };
}

/** The tree with the DP population in a colour of its own. */
function withPicked(populations: PopulationMap, popId: string, color: string): PopulationMap {
  return { ...populations, [popId]: { ...populations[popId], color } };
}

function workspaceOf(state: CoreState, populations: PopulationMap, extra: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return {
    format: "gatelab-workspace", version: 2, savedAt: "2026-11-10T00:00:00.000Z", app: "GateLab",
    samples: [{ fileName: "D1.fcs", dataPath: "data/0_D1.fcs", logicleW: {}, compensationOn: false }],
    activeSample: 0,
    gating: {
      gates: state.gates, gate_order: state.gate_order, populations,
      root_population_id: state.root_population_id, active_population_id: state.root_population_id, selected_gate_id: null,
    },
    scales: { globalScales: {} },
    display: { xChannel: "FITC-A", yChannel: "PE-A", mode: "dots", maxEvents: 1000, contourThreshold: 5 },
    ...extra,
  } as unknown as WorkspaceFile;
}

function counts(sample: Sample, state: CoreState, populations: PopulationMap): Record<string, number | null> {
  const derived = recompute(sample, { ...state, populations });
  return Object.fromEntries(Object.keys(populations).map((id) => [id, derived.populations[id].event_count]));
}

describe("a population's own colour in a saved workspace", () => {
  it("saves and reloads with the colour and the same counts", () => {
    const fx = fixture();
    const populations = withPicked(fx.state.populations, fx.dp.population_id, "#123456");
    const before = counts(fx.sample, fx.state, populations);
    expect(before[fx.dp.population_id]).toBe(1);
    expect(before[fx.dn.population_id]).toBe(2);
    const back = readWorkspaceBytes(packWorkspaceReference(workspaceOf(fx.state, populations))).ws;
    expect(back.gating.populations[fx.dp.population_id].color).toBe("#123456");
    expect(back.gating.populations[fx.dn.population_id].color).toBeUndefined();
    expect(counts(fx.sample, fx.state, back.gating.populations)).toEqual(before);
    expect(populationColorOf(back.gating.populations[fx.dp.population_id])).toBe("#123456");
  });

  it("loads an older workspace without the field unchanged, each population in its slot's colour", () => {
    const fx = fixture();
    const ws = workspaceOf(fx.state, fx.state.populations);
    const json = JSON.stringify(ws);
    expect(Object.values(ws.gating.populations).some((p) => "color" in p)).toBe(false);
    const back = readWorkspaceBytes(new TextEncoder().encode(json)).ws;
    expect(back.gating.populations).toEqual(fx.state.populations);
    expect(withLegacyPopulationColors(back)).toBe(back);
    expect(counts(fx.sample, fx.state, back.gating.populations)).toEqual(counts(fx.sample, fx.state, fx.state.populations));
    expect(populationColorOf(back.gating.populations[fx.dp.population_id])).toBe(populationColor("default", fx.dp.colorSlot));
  });

  it("moves the old Illustration popColors onto the populations, and leaves a population's own colour", () => {
    const fx = fixture();
    const populations = withPicked(fx.state.populations, fx.dn.population_id, "#abcdef");
    const illustration = {
      ...defaultIllustrationConfig(),
      popColors: { [fx.dp.population_id]: "#FF0000", [fx.dn.population_id]: "#00ff00", missing: "#0000ff" },
    };
    const preset = { name: "P1", config: { ...defaultIllustrationConfig(), popColors: { [fx.dp.population_id]: "#222222" } } };
    const ws = workspaceOf(fx.state, populations, { illustration, illustrationPresets: [preset] });
    const migrated = withLegacyPopulationColors(ws);
    expect(migrated.gating.populations[fx.dp.population_id].color).toBe("#ff0000");
    expect(migrated.gating.populations[fx.dn.population_id].color).toBe("#abcdef");
    expect(migrated.illustration!.popColors).toEqual({});
    expect(migrated.illustrationPresets![0].config.popColors).toEqual({});
    // The input is not changed, and the counts are the same.
    expect(ws.gating.populations[fx.dp.population_id].color).toBeUndefined();
    expect(counts(fx.sample, fx.state, migrated.gating.populations)).toEqual(counts(fx.sample, fx.state, fx.state.populations));
  });

  it("is written into no Gating-ML, FlowJo or FlowJo 11 export", () => {
    const fx = fixture();
    const picked = withPicked(fx.state.populations, fx.dp.population_id, "#123456");
    const tree = (populations: PopulationMap) => ({
      gates: fx.state.gates, gate_order: fx.state.gate_order, populations, root_population_id: fx.state.root_population_id!,
    });
    for (const format of ["cytobank", "standard"] as const) {
      const plain = exportGatingML({ ...tree(fx.state.populations), sample: fx.sample, format, allowQuadrantOmission: true });
      const coloured = exportGatingML({ ...tree(picked), sample: fx.sample, format, allowQuadrantOmission: true });
      expect(coloured).toBe(plain);
      expect(coloured).not.toContain("123456");
    }
    const now = new Date("2026-11-10T00:00:00Z");
    const flowjo = (populations: PopulationMap) =>
      exportFlowJoWorkspace({ samples: [{ sample: fx.sample, fileName: "D1.fcs", ...tree(populations) }], now }).xml;
    expect(flowjo(picked)).toBe(flowjo(fx.state.populations));
    expect(flowjo(picked)).not.toContain("123456");
    const ids = () => { let i = 0; return () => `id-${i++}`; };
    const flowjo11 = (populations: PopulationMap) =>
      exportFlowJo11Workbench({ samples: [{ sample: fx.sample, fileName: "D1.fcs", ...tree(populations) }], fcsFolder: "/data", name: "D1", uuid: ids() });
    const a = flowjo11(picked), b = flowjo11(fx.state.populations);
    expect(JSON.stringify(a.analysis)).toBe(JSON.stringify(b.analysis));
    expect(JSON.stringify(a.analysis)).not.toContain("123456");
  });
});
