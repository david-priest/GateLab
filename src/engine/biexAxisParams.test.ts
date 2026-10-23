// @vitest-environment jsdom
//
// A fluorescence axis on FlowJo's biexponential, shown at parameters other than those recorded for
// it. Display only, as every flow scale choice: a gate held in raw values, and an imported FlowJo
// gate held in its own stored transform, keep every event they held. The adjusted axis is saved
// with the workspace, and the recorded one beside it, so Reset still finds it after reopening.

import { describe, expect, it } from "vitest";
import type { BiexParams } from "./biex";
import { ChannelScales } from "./channelScales";
import { writeFcs } from "./fcsExport";
import type { FcsFile } from "./fcs";
import { newRootPopulation, type Gate } from "./models";
import { computeGateMasks, gateMaskKey } from "./populations";
import { Sample } from "./sample";
import { robustAxisRange } from "./axisRange";
import { packWorkspace, validateWorkspace, type WorkspaceFile } from "./workspace";
import { migrateWorkspaceV2ToV3, validateWorkspaceV3 } from "./workspaceV3";
import { openWorkspace } from "../headless/workspace";

const RECORDED: BiexParams = { maxValue: 262144, pos: 4.42, neg: 0, widthBasis: -100, channelRange: 256, tableChannels: 4096 };
const ADJUSTED: BiexParams = { ...RECORDED, pos: 4.8, neg: 0.5, widthBasis: -30, maxValue: 1e6 };

/** 4000 events over the full biex range, negatives included, the same every run. */
function columns(): Float32Array[] {
  const n = 4000;
  const fl1 = new Float32Array(n);
  const fl2 = new Float32Array(n);
  let seed = 12345;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < n; i++) {
    fl1[i] = Math.pow(10, next() * 5.3) - 2000;
    fl2[i] = Math.pow(10, next() * 5.3) - 2000;
  }
  return [fl1, fl2];
}

function flowSample(): Sample {
  const [fl1, fl2] = columns();
  return new Sample({
    version: "FCS3.1", nEvents: fl1.length, instrument: "flow", keywords: {}, spillover: null,
    channels: [
      { index: 0, name: "FL1-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL2-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [fl1, fl2],
  } as unknown as FcsFile);
}

/** A rectangle held in raw values, and a polygon an import holds on its own biex. */
const GATES: Record<string, Gate> = {
  raw: {
    gate_id: "raw", name: "CD4_positive", gate_type: "rectangle", x_channel: "FL1-A", y_channel: "FL2-A",
    vertices: [[1000, -500], [100000, -500], [100000, 20000], [1000, 20000]],
    space: "raw", color: "#e41a1c", label_offset: null,
  },
  imported: {
    gate_id: "imported", name: "CD8_positive", gate_type: "polygon", x_channel: "FL1-A", y_channel: "FL2-A",
    vertices: [[60, 140], [200, 140], [230, 230], [90, 220]],
    space: "display",
    transforms: { "FL1-A": { kind: "biex", ...RECORDED }, "FL2-A": { kind: "biex", ...RECORDED } },
    color: "#377eb8", label_offset: null,
  },
};

function counts(sample: Sample): Record<string, number> {
  const masks = computeGateMasks(GATES, sample.gateAssayData());
  const out: Record<string, number> = {};
  for (const id of Object.keys(GATES)) out[id] = masks[gateMaskKey(id)].reduce((sum, v) => sum + v, 0);
  return out;
}

/** A workspace's gating: the two gates under one root, as a saved tree holds them. */
function gating() {
  const root = newRootPopulation();
  return {
    gates: GATES, gate_order: Object.keys(GATES),
    populations: { [root.population_id]: root }, root_population_id: root.population_id,
    active_population_id: root.population_id, selected_gate_id: null,
  };
}

const DISPLAY = { xChannel: "FL1-A", yChannel: "FL2-A", mode: "pseudocolor", maxEvents: 50000, contourThreshold: 5 };

/** A sample in a workspace's shared scales, with FL1-A recorded on biex, as the app has one after an import. */
function attached(): { sample: Sample; idx: number } {
  const sample = flowSample();
  sample.attachChannelScales(new ChannelScales());
  sample.applyFluorBiex({ "FL1-A": RECORDED });
  return { sample, idx: sample.index("FL1-A")! };
}

describe("adjusting the biexponential a fluorescence axis is shown on", () => {
  it("moves the axis and no gate: every count is the same before and after", () => {
    const { sample, idx } = attached();
    const before = counts(sample);
    // Neither gate is vacuous.
    for (const n of Object.values(before)) {
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(4000);
    }
    const displayBefore = sample.rawToDisplay("FL1-A", 1000);

    expect(sample.setFluorBiexParams(idx, ADJUSTED)).toBe(true);
    expect(sample.fluorScale(idx)).toBe("biex");
    expect(sample.fluorBiexParams(idx)).toEqual(ADJUSTED);
    expect(sample.transformSpec("FL1-A")).toEqual({ kind: "biex", ...ADJUSTED });
    // The view really moved, so the counts below cannot hold by nothing having changed.
    expect(Math.abs(sample.rawToDisplay("FL1-A", 1000) - displayBefore)).toBeGreaterThan(1);
    expect(counts(sample)).toEqual(before);

    sample.resetFluorBiex(idx);
    expect(sample.fluorBiexParams(idx)).toEqual(RECORDED);
    expect(sample.rawToDisplay("FL1-A", 1000)).toBeCloseTo(displayBefore, 9);
    expect(counts(sample)).toEqual(before);
  });

  it("keeps every count through each slider's own sweep, the width basis's included", () => {
    // One parameter at a time across its slider, as a drag moves it.
    const { sample, idx } = attached();
    const before = counts(sample);
    const sweeps: [keyof BiexParams, number[]][] = [
      ["widthBasis", [-3.2, -10, -31.6, -316, -1000]],
      ["neg", [0.25, 0.5, 1, 2]],
      ["pos", [3, 4, 5.5, 7]],
      ["maxValue", [1000, 1e5, 1e6, 3e7]],
    ];
    for (const [field, values] of sweeps) {
      for (const value of values) {
        const at = sample.rawToDisplay("FL1-A", 5000);
        expect(sample.setFluorBiexParams(idx, { ...RECORDED, [field]: value })).toBe(true);
        expect(sample.rawToDisplay("FL1-A", 5000)).not.toBe(at);
        expect(counts(sample)).toEqual(before);
      }
      sample.resetFluorBiex(idx);
    }
  });

  it("frames a biex axis exactly as a sort of its display column would, at every setting", () => {
    // Sample.displayRange maps the raw column's sorted sample through the table instead of
    // sorting the display column each time; the table never decreases, so the two must agree.
    const { sample, idx } = attached();
    for (const params of [RECORDED, ADJUSTED, { ...RECORDED, neg: 1.5 }, { ...RECORDED, widthBasis: -10, pos: 3 }, { ...RECORDED, maxValue: 5000 }]) {
      sample.setFluorBiexParams(idx, params);
      expect(sample.displayRange(idx)).toEqual(robustAxisRange(sample.displayColumn(idx)));
    }
  });

  it("holds the change workspace-wide, for every file sharing the scales", () => {
    const scales = new ChannelScales();
    const a = flowSample();
    const b = flowSample();
    a.attachChannelScales(scales);
    b.attachChannelScales(scales);
    a.applyFluorBiex({ "FL1-A": RECORDED });
    a.setFluorBiexParams(a.index("FL1-A")!, ADJUSTED);
    expect(b.fluorBiexParams(b.index("FL1-A")!)).toEqual(ADJUSTED);
  });

  it("refuses parameters it cannot build a table for, and a channel not on biex", () => {
    const { sample, idx } = attached();
    // No top of scale, and no positive decades: neither table is increasing (biex.ts).
    expect(sample.setFluorBiexParams(idx, { ...RECORDED, maxValue: 0 })).toBe(false);
    expect(sample.setFluorBiexParams(idx, { ...RECORDED, pos: -1 })).toBe(false);
    expect(sample.fluorBiexParams(idx)).toEqual(RECORDED);
    const fl2 = sample.index("FL2-A")!;
    expect(sample.setFluorBiexParams(fl2, ADJUSTED)).toBe(false);
    expect(sample.fluorScale(fl2)).toBe("logicle");
  });

  it("saves the adjusted axis and the recorded one only where they differ", () => {
    const { sample, idx } = attached();
    expect(sample.fluorBiexRecordedEntries()).toEqual({});
    sample.setFluorBiexParams(idx, ADJUSTED);
    expect(sample.fluorBiexEntries()).toEqual({ "FL1-A": ADJUSTED });
    expect(sample.fluorBiexRecordedEntries()).toEqual({ "FL1-A": RECORDED });
  });

  it("reopens on the adjusted axis, and Reset returns to the recorded one", async () => {
    const { sample, idx } = attached();
    const before = counts(sample);
    sample.setFluorBiexParams(idx, ADJUSTED);
    const [fl1, fl2] = columns();
    const fcs = writeFcs([fl1, fl2], [{ name: "FL1-A", desc: "", range: 262144 }, { name: "FL2-A", desc: "", range: 262144 }]);
    // The sample entry as the app writes it (App.tsx buildWorkspaceFile).
    const ws: WorkspaceFile = {
      format: "gatelab-workspace", version: 2, savedAt: "2026-01-01T00:00:00.000Z", app: "GateLab",
      samples: [{
        sampleId: "s1", fileName: "D1.fcs", dataPath: "data/0_D1.fcs", logicleW: {}, compensationOn: false,
        fluorBiex: sample.fluorBiexEntries(), fluorBiexRecorded: sample.fluorBiexRecordedEntries(),
      }],
      activeSample: 0,
      gating: gating(),
      scales: { globalScales: {} },
      display: DISPLAY,
    } as unknown as WorkspaceFile;
    expect(validateWorkspace(ws)).toBe(true);

    const [reopened] = await openWorkspace(packWorkspace(ws, { "data/0_D1.fcs": fcs }), "biex.gatelab", []);
    const again = reopened.sample;
    const i = again.index("FL1-A")!;
    expect(again.fluorScale(i)).toBe("biex");
    expect(again.fluorBiexParams(i)).toEqual(ADJUSTED);
    expect(again.recordedBiex(i)).toEqual(RECORDED);
    expect(counts(again)).toEqual(before);
    again.resetFluorBiex(i);
    expect(again.fluorBiexParams(i)).toEqual(RECORDED);
    expect(again.fluorBiexRecordedEntries()).toEqual({});
  });

  it("accepts the recorded axis in a version 3 workspace and refuses a malformed one", async () => {
    const { sample, idx } = attached();
    sample.setFluorBiexParams(idx, ADJUSTED);
    const ws = {
      format: "gatelab-workspace", version: 2, savedAt: "2026-01-01T00:00:00.000Z", app: "GateLab",
      samples: [{
        sampleId: "s1", fileName: "D1.fcs", dataPath: "data/0_D1.fcs", logicleW: {}, compensationOn: false,
        fluorBiex: sample.fluorBiexEntries(), fluorBiexRecorded: sample.fluorBiexRecordedEntries(),
      }],
      activeSample: 0,
      gating: gating(),
      scales: { globalScales: {} },
      display: DISPLAY,
    } as unknown as WorkspaceFile;
    const v3 = await validateWorkspaceV3(JSON.parse(JSON.stringify(migrateWorkspaceV2ToV3(ws))));
    expect(v3.samples[0].fluorBiexRecorded).toEqual({ "FL1-A": RECORDED });
    const bad = { ...ws, samples: [{ ...ws.samples[0], fluorBiexRecorded: { "FL1-A": { pos: "4.42" } } }] } as unknown as WorkspaceFile;
    expect(() => validateWorkspace(bad)).toThrow(/recorded biexponential/);
  });
});
