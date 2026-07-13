import { describe, it, expect } from "vitest";
import { packWorkspace, packWorkspaceReference, readWorkspaceBytes, type WorkspaceFile } from "./workspace";

function makeWs(): WorkspaceFile {
  return {
    format: "gatelab-workspace",
    version: 2,
    savedAt: "2026-01-01T00:00:00.000Z",
    app: "GateLab",
    samples: [
      { fileName: "run1.fcs", dataPath: "data/0_run1.fcs", logicleW: { "PE-A": 0.7 }, compensationOn: true, labels: { "PE-A": "CD3" }, metadata: { condition: "stim", donor: "d1" } },
      { fileName: "run2.fcs", dataPath: "data/1_run2.fcs", logicleW: {}, compensationOn: false, metadata: { condition: "unstim", donor: "d2" } },
    ],
    activeSample: 1,
    gating: {
      gates: { g1: { gate_id: "g1", name: "Cells", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A", vertices: [[1, 2], [3, 4]], color: "#e41a1c", label_offset: null } },
      gate_order: ["g1"],
      populations: {},
      root_population_id: "root",
      active_population_id: "root",
      selected_gate_id: "g1",
    },
    scales: { globalScales: { "FSC-A": [0, 8] } },
    display: { xChannel: "FSC-A", yChannel: "SSC-A", mode: "contour", maxEvents: 20000, contourThreshold: 10 },
    metadataColumns: [{ name: "condition", levels: ["unstim", "stim"] }, { name: "donor" }],
  };
}

describe("workspace pack/read round-trip (multi-sample)", () => {
  const ws = makeWs();
  const fcs0 = new Uint8Array([70, 67, 83, 51, 46, 48, 1, 2, 3]);
  const fcs1 = new Uint8Array([70, 67, 83, 51, 46, 48, 9, 8, 7, 6]);
  const fcsByPath = { "data/0_run1.fcs": fcs0, "data/1_run2.fcs": fcs1 };

  it("bundled: recovers the JSON + every sample's FCS bytes", () => {
    const { ws: back, fcsByPath: got } = readWorkspaceBytes(packWorkspace(ws, fcsByPath, "<xml/>"));
    expect(back).toEqual(ws);
    expect(Array.from(got!["data/0_run1.fcs"])).toEqual(Array.from(fcs0));
    expect(Array.from(got!["data/1_run2.fcs"])).toEqual(Array.from(fcs1));
    expect(back.samples.length).toBe(2);
    expect(back.activeSample).toBe(1);
  });

  it("bundled zip starts with PK; reference is JSON", () => {
    expect(packWorkspace(ws, fcsByPath)[0]).toBe(0x50);
    const ref = packWorkspaceReference(ws);
    expect(ref[0]).not.toBe(0x50);
    const { ws: back, fcsByPath: got } = readWorkspaceBytes(ref);
    expect(got).toBeNull(); // reference — FCS re-linked by the caller
    expect(back).toEqual(ws);
  });

  it("preserves per-sample W / compensation + shared scales/display/selection", () => {
    const { ws: back } = readWorkspaceBytes(packWorkspace(ws, fcsByPath));
    expect(back.samples[0].logicleW["PE-A"]).toBe(0.7);
    expect(back.samples[0].compensationOn).toBe(true);
    expect(back.samples[0].labels).toEqual({ "PE-A": "CD3" });
    expect(back.samples[0].metadata).toEqual({ condition: "stim", donor: "d1" });
    expect(back.metadataColumns).toEqual([{ name: "condition", levels: ["unstim", "stim"] }, { name: "donor" }]);
    expect(back.samples[1].compensationOn).toBe(false);
    expect(back.scales.globalScales["FSC-A"]).toEqual([0, 8]);
    expect(back.display.mode).toBe("contour");
    expect(back.gating.selected_gate_id).toBe("g1");
  });

  it("migrates a v1 (single-sample) workspace to v2 on read", () => {
    const v1 = {
      format: "gatelab-workspace",
      version: 1,
      savedAt: "2026-01-01T00:00:00.000Z",
      app: "GateLab",
      sample: { fileName: "old.fcs", dataPath: "data/old.fcs" },
      gating: ws.gating,
      scales: { logicleW: { "APC-A": 0.9 }, globalScales: { "FSC-A": [1, 5] } },
      compensation: { on: true },
      display: ws.display,
    };
    const { ws: back } = readWorkspaceBytes(new TextEncoder().encode(JSON.stringify(v1)));
    expect(back.version).toBe(2);
    expect(back.samples.length).toBe(1);
    expect(back.samples[0].fileName).toBe("old.fcs");
    expect(back.samples[0].logicleW["APC-A"]).toBe(0.9);
    expect(back.samples[0].compensationOn).toBe(true);
    expect(back.scales.globalScales["FSC-A"]).toEqual([1, 5]);
  });

  it("rejects a non-workspace file", () => {
    expect(() => readWorkspaceBytes(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
