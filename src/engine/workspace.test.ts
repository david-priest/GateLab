import { describe, it, expect } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  packWorkspace,
  packWorkspaceForStorage,
  packWorkspaceReference,
  readWorkspaceBytes,
  validateWorkspace,
  type WorkspaceFile,
} from "./workspace";

function makeWs(): WorkspaceFile {
  return {
    format: "gatelab-workspace",
    version: 2,
    workspaceId: "workspace-test-1",
    savedAt: "2026-01-01T00:00:00.000Z",
    app: "GateLab",
    samples: [
      { fileName: "run1.fcs", dataPath: "data/0_run1.fcs", logicleW: { "PE-A": 0.7 }, scatterCofactor: { "FSC-A": 300 }, cytofCofactor: 5, compensationOn: true, labels: { "PE-A": "CD3" }, metadata: { condition: "stim", donor: "d1" } },
      { fileName: "run2.fcs", dataPath: "data/1_run2.fcs", logicleW: {}, cytofCofactor: 7.5, compensationOn: false, metadata: { condition: "unstim", donor: "d2" } },
    ],
    activeSample: 1,
    gating: {
      gates: { g1: { gate_id: "g1", name: "Cells", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A", vertices: [[1, 2], [3, 4]], color: "#e41a1c", label_offset: null } },
      gate_order: ["g1"],
      populations: {
        root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: ["p1"], event_count: null, percent_of_parent: 100 },
        p1: { population_id: "p1", name: "Cells", gate_refs: [{ gate_id: "g1", include: true }], gate_logic: "and", parent_id: "root", children: [], event_count: null, percent_of_parent: null },
      },
      root_population_id: "root",
      active_population_id: "root",
      selected_gate_id: "g1",
    },
    scales: { globalScales: { "FSC-A": [0, 8] } },
    display: {
      xChannel: "FSC-A",
      yChannel: "SSC-A",
      mode: "contour",
      maxEvents: 20000,
      contourThreshold: 10,
      fontSizes: { tick: 12, axis: 14, title: 11, gate: 12 },
    },
    metadataColumns: [{ name: "condition", levels: ["unstim", "stim"] }, { name: "donor" }],
  };
}

function cloneWs(ws: WorkspaceFile): WorkspaceFile {
  return JSON.parse(JSON.stringify(ws)) as WorkspaceFile;
}

describe("workspace pack/read round-trip (multi-sample)", () => {
  const ws = makeWs();
  const fcs0 = new Uint8Array([70, 67, 83, 51, 46, 48, 1, 2, 3]);
  const fcs1 = new Uint8Array([70, 67, 83, 51, 46, 48, 9, 8, 7, 6]);
  const fcsByPath = { "data/0_run1.fcs": fcs0, "data/1_run2.fcs": fcs1 };

  it("bundled: recovers the JSON + every sample's FCS bytes", () => {
    const { ws: back, fcsByPath: got, storage } = readWorkspaceBytes(packWorkspace(ws, fcsByPath, "<xml/>"));
    expect(storage).toBe("bundle");
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
    const { ws: back, fcsByPath: got, storage } = readWorkspaceBytes(ref);
    expect(storage).toBe("reference");
    expect(got).toBeNull(); // reference — FCS re-linked by the caller
    expect(back).toEqual(ws);
  });

  it("re-saves without converting a bundle into a reference workspace", () => {
    const savedBundle = packWorkspaceForStorage(ws, fcsByPath, "bundle", "<xml/>");
    const reopenedBundle = readWorkspaceBytes(savedBundle);
    expect(savedBundle[0]).toBe(0x50);
    expect(reopenedBundle.storage).toBe("bundle");
    expect(Array.from(reopenedBundle.fcsByPath!["data/1_run2.fcs"])).toEqual(Array.from(fcs1));

    const savedReference = packWorkspaceForStorage(ws, fcsByPath, "reference");
    expect(savedReference[0]).not.toBe(0x50);
    expect(readWorkspaceBytes(savedReference).storage).toBe("reference");
  });

  it("preserves per-sample W / compensation + shared scales/display/selection", () => {
    const { ws: back } = readWorkspaceBytes(packWorkspace(ws, fcsByPath));
    expect(back.samples[0].logicleW["PE-A"]).toBe(0.7);
    expect(back.samples[0].scatterCofactor).toEqual({ "FSC-A": 300 });
    expect(back.samples[1].cytofCofactor).toBe(7.5);
    expect(back.samples[0].compensationOn).toBe(true);
    expect(back.samples[0].labels).toEqual({ "PE-A": "CD3" });
    expect(back.samples[0].metadata).toEqual({ condition: "stim", donor: "d1" });
    expect(back.metadataColumns).toEqual([{ name: "condition", levels: ["unstim", "stim"] }, { name: "donor" }]);
    expect(back.samples[1].compensationOn).toBe(false);
    expect(back.scales.globalScales["FSC-A"]).toEqual([0, 8]);
    expect(back.display.mode).toBe("contour");
    expect(back.display.fontSizes).toEqual({ tick: 12, axis: 14, title: 11, gate: 12 });
    expect(back.gating.selected_gate_id).toBe("g1");
    expect(back.workspaceId).toBe("workspace-test-1");
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

  it("accepts older v2 workspaces without gating font settings", () => {
    const older = cloneWs(ws);
    delete older.display.fontSizes;
    expect(validateWorkspace(older)).toBe(true);
    expect(readWorkspaceBytes(packWorkspaceReference(older)).ws.display.fontSizes).toBeUndefined();
  });

  it("rejects a non-workspace file", () => {
    expect(() => readWorkspaceBytes(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it("rejects a dangling gate reference rather than changing population semantics", () => {
    const corrupt = cloneWs(ws);
    corrupt.gating.populations.p1.gate_refs[0].gate_id = "missing-gate";
    const bytes = new TextEncoder().encode(JSON.stringify(corrupt));
    expect(() => readWorkspaceBytes(bytes)).toThrow(/dangling gate reference/i);
  });

  it("rejects inconsistent population links and cycles", () => {
    const inconsistent = cloneWs(ws);
    inconsistent.gating.populations.root.children = [];
    expect(() => validateWorkspace(inconsistent)).toThrow(/absent from its parent's children/i);

    const cyclic = cloneWs(ws);
    cyclic.gating.populations.p1.parent_id = "p1";
    cyclic.gating.populations.p1.children = ["p1"];
    cyclic.gating.populations.root.children = [];
    expect(() => validateWorkspace(cyclic)).toThrow(/own parent|cycle/i);
  });

  it("rejects gate_order omissions and unknown selected IDs", () => {
    const omitted = cloneWs(ws);
    omitted.gating.gate_order = [];
    expect(() => packWorkspaceReference(omitted)).toThrow(/gate_order does not match/i);

    const badSelection = cloneWs(ws);
    badSelection.gating.active_population_id = "missing-pop";
    expect(() => validateWorkspace(badSelection)).toThrow(/active_population_id/i);
  });

  it("rejects malformed non-graph state before any workspace state is applied", () => {
    const missingScales = cloneWs(ws) as unknown as Record<string, unknown>;
    delete missingScales.scales;
    const bytes = new TextEncoder().encode(JSON.stringify(missingScales));
    expect(() => readWorkspaceBytes(bytes)).toThrow(/scale settings/i);

    const badCofactor = cloneWs(ws);
    badCofactor.samples[0].scatterCofactor = { "FSC-A": 0 };
    expect(() => validateWorkspace(badCofactor)).toThrow(/scatter cofactors/i);

    const badWorkspaceId = cloneWs(ws);
    badWorkspaceId.workspaceId = "";
    expect(() => validateWorkspace(badWorkspaceId)).toThrow(/workspaceId/i);
  });

  it("requires every declared FCS payload when writing or reading a bundle", () => {
    expect(() => packWorkspace(ws, { "data/0_run1.fcs": fcs0 })).toThrow(/missing.*run2\.fcs/i);

    const incomplete = zipSync({
      "workspace.json": strToU8(JSON.stringify(ws)),
      "data/0_run1.fcs": fcs0,
    });
    expect(() => readWorkspaceBytes(incomplete)).toThrow(/missing.*run2\.fcs/i);
  });
});
