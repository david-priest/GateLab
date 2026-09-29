// What a saved workspace needs of the GateLab that opens it (workspaceFeatures.ts). A gate on
// FlowJo's grid, or a biex axis on FlowJo's 4096-channel table, is misread by GateLab 0.8.3 rather
// than refused, so a workspace holding either is written where 0.8.3 refuses it: version 4 for the
// version 2 layout. Synthetic names throughout.

import { describe, expect, it } from "vitest";
import { strFromU8 } from "fflate";
import { migrateWorkspaceToV2, packWorkspace, packWorkspaceReference, readWorkspaceBytes, WORKSPACE_FORMAT, type WorkspaceFile } from "./workspace";
import { requiredWorkspaceFeatures, stampHostedWorkspace, stampWorkspace } from "./workspaceFeatures";
import type { Gate, TransformSpec } from "./models";
import { unzipSync } from "fflate";

const GRID: TransformSpec = { kind: "flowjoChannels", channels: 256, axis: { kind: "linear", minRange: 0, maxRange: 262144 } };
const TABLE: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.41854, neg: 0, widthBasis: -10, channelRange: 256, tableChannels: 4096 };
const OLD_TABLE: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.41854, neg: 0, widthBasis: -10, channelRange: 256 };

function workspace(transforms?: Record<string, TransformSpec>): WorkspaceFile {
  const gate: Gate = {
    gate_id: "g1", name: "CD4_positive", gate_type: "polygon", x_channel: "FSC-A", y_channel: "B-A",
    vertices: [[10, 20], [200, 20], [100, 250]], color: "#000000", label_offset: null,
    ...(transforms ? { space: "display" as const, transforms } : {}),
  };
  return {
    format: WORKSPACE_FORMAT, version: 2, savedAt: "2026-09-25T00:00:00.000Z", app: "GateLab",
    samples: [{ fileName: "D1.fcs", dataPath: "data/0_D1.fcs", logicleW: {}, cytofCofactor: 5, compensationOn: false }],
    activeSample: 0,
    gating: {
      gates: { g1: gate }, gate_order: ["g1"],
      populations: {
        root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: ["p1"] },
        p1: { population_id: "p1", name: "CD4_positive", gate_refs: [{ gate_id: "g1", include: true }], gate_logic: "and", parent_id: "root", children: [] },
      },
      root_population_id: "root", active_population_id: "root", selected_gate_id: null,
    },
    scales: { globalScales: {} },
    display: { xChannel: "FSC-A", yChannel: "B-A", mode: "dots", maxEvents: 1000, contourThreshold: 5 },
  } as unknown as WorkspaceFile;
}

const written = (ws: WorkspaceFile): Record<string, unknown> => JSON.parse(strFromU8(packWorkspaceReference(ws)));

describe("a saved workspace names what it needs of the GateLab that opens it", () => {
  it("writes one holding a gate on FlowJo's grid as version 4 with the feature, and reads it back unchanged", () => {
    const ws = workspace({ "FSC-A": GRID, "B-A": GRID });
    const file = written(ws);
    expect(file.version).toBe(4);
    expect(file.requiredFeatures).toEqual(["flowjo-grid"]);
    const back = readWorkspaceBytes(packWorkspaceReference(ws)).ws;
    expect(back.version).toBe(2);
    expect("requiredFeatures" in back).toBe(false);
    expect(back.gating.gates.g1).toEqual(ws.gating.gates.g1);
  });

  it("names FlowJo's biex table too, in a bundle as in a reference", () => {
    const ws = workspace({ "FSC-A": { kind: "identity" }, "B-A": TABLE });
    expect(written(ws)).toMatchObject({ version: 4, requiredFeatures: ["flowjo-biex-table"] });
    const bundle = unzipSync(packWorkspace(ws, { "data/0_D1.fcs": Uint8Array.from([1]) }));
    expect(JSON.parse(strFromU8(bundle["workspace.json"]))).toMatchObject({ version: 4, requiredFeatures: ["flowjo-biex-table"] });
    expect(requiredWorkspaceFeatures({ a: [{ b: GRID }], c: TABLE })).toEqual(["flowjo-grid", "flowjo-biex-table"]);
  });

  // A rectangle drawn in GateLab is half-open (min <= x < max); 0.8.3 reads and keeps `bounds` but
  // evaluates every rectangle closed, so an event exactly on the max was counted otherwise, without
  // a word. A closed rectangle, stated or not, is what 0.8.3 evaluates, and needs nothing.
  it("names a half-open rectangle, and writes a closed one as before", () => {
    const rectangle = (bounds?: "closed" | "half-open"): WorkspaceFile => {
      const ws = workspace();
      ws.gating.gates.g1 = { ...ws.gating.gates.g1, gate_type: "rectangle", vertices: [[10, 20], [200, 250]], ...(bounds ? { bounds } : {}) } as Gate;
      return ws;
    };
    expect(written(rectangle("half-open"))).toMatchObject({ version: 4, requiredFeatures: ["half-open-rectangle"] });
    expect(readWorkspaceBytes(packWorkspaceReference(rectangle("half-open"))).ws.gating.gates.g1).toMatchObject({ bounds: "half-open" });
    for (const closed of [rectangle("closed"), rectangle()]) {
      expect(written(closed).version).toBe(2);
      expect(stampWorkspace(closed)).toBe(closed);
    }
    expect(requiredWorkspaceFeatures({ a: [{ b: GRID }], c: TABLE, d: { bounds: "half-open" } })).toEqual(["flowjo-grid", "flowjo-biex-table", "half-open-rectangle"]);
  });

  it("writes a workspace holding neither exactly as before, the older biex table included", () => {
    for (const ws of [workspace(), workspace({ "FSC-A": { kind: "identity" }, "B-A": OLD_TABLE })]) {
      const file = written(ws);
      expect(file.version).toBe(2);
      expect("requiredFeatures" in file).toBe(false);
      expect(stampWorkspace(ws)).toBe(ws);
    }
  });

  // A FlowJo import compensates a file with the workspace's matrix where it differs from the file's;
  // a GateLab without the record compensates with the file's own, and says nothing.
  it("records a matrix that is not the file's own, names the feature, and refuses a malformed one", () => {
    const matrix = { label: "Matrix_A", channels: ["BV786-A", "APC-A"], matrix: [[1, 0.25], [0.05, 1]] };
    const ws = workspace();
    ws.samples[0] = { ...ws.samples[0], compensationOn: true, externalSpillover: matrix };
    expect(written(ws)).toMatchObject({ version: 4, requiredFeatures: ["external-spillover"] });
    expect(readWorkspaceBytes(packWorkspaceReference(ws)).ws.samples[0].externalSpillover).toEqual(matrix);
    // What it left out on its file, when it left anything out, is kept with it.
    const leaving = { ...matrix, channels: ["BV786-A", "APC-A", "PE-A"], matrix: [[1, 0.25, 0], [0.05, 1, 0], [0, 0, 1]], leftOut: ["PE-A"] };
    const withLeftOut = workspace();
    withLeftOut.samples[0] = { ...withLeftOut.samples[0], externalSpillover: leaving };
    expect(readWorkspaceBytes(packWorkspaceReference(withLeftOut)).ws.samples[0].externalSpillover).toEqual(leaving);
    for (const bad of [
      { ...matrix, leftOut: ["PE-A"] },
      { ...matrix, leftOut: ["APC-A", "APC-A"] },
      { ...matrix, leftOut: "APC-A" },
      { ...matrix, label: 3 },
      { ...matrix, channels: ["BV786-A"] },
      { ...matrix, channels: ["BV786-A", "BV786-A"] },
      { ...matrix, matrix: [[1, 0.25]] },
      { ...matrix, matrix: [[1, Number.NaN], [0.05, 1]] },
    ]) {
      const broken = workspace();
      broken.samples[0] = { ...broken.samples[0], externalSpillover: bad as never };
      expect(() => packWorkspaceReference(broken)).toThrow(/invalid spillover matrix/);
    }
  });

  it("refuses a workspace naming a feature this GateLab does not have, and a version it does not know", () => {
    const later = { ...written(workspace({ "FSC-A": GRID, "B-A": GRID })), requiredFeatures: ["flowjo-grid", "something-later"] };
    expect(() => readWorkspaceBytes(new TextEncoder().encode(JSON.stringify(later)))).toThrow(/needs something-later/);
    const v5 = { ...written(workspace()), version: 5 };
    expect(() => readWorkspaceBytes(new TextEncoder().encode(JSON.stringify(v5)))).toThrow(/version '5'/);
  });
});

// The SCE's copy is opened by whichever GateLab the opening GateLabR embeds, 0.8.3 in an older one.
// Written as version 2 with the features key beside it, 0.8.3 read it as version 2 and the gate
// badge threw on the grid gate, blanking the app. It is written as a file is.
describe("a workspace saved to a GateLabR host", () => {
  /** GateLab 0.8.3's readers: versions 1 and 2 by migrateWorkspaceToV2, and 3 by validateWorkspaceV3, which refuses a key it does not know. */
  const refusedBy083 = (ws: Record<string, unknown>): boolean =>
    ![1, 2, 3].includes(ws.version as number) || (ws.version === 3 && "requiredFeatures" in ws);

  it("is written as a file is, a version 0.8.3 refuses, when it needs a feature", () => {
    for (const ws of [workspace({ "FSC-A": { kind: "identity" }, "B-A": TABLE }), workspace({ "FSC-A": GRID, "B-A": GRID })]) {
      const hosted = JSON.parse(JSON.stringify(stampHostedWorkspace(ws)));
      expect(hosted).toEqual(written(ws));
      expect(hosted.version).toBe(4);
      expect(refusedBy083(hosted)).toBe(true);
    }
    // The version 3 layout lists the key, which 0.8.3's version 3 reader refuses.
    const v3 = { ...workspace({ "FSC-A": GRID, "B-A": GRID }), version: 3 };
    expect(refusedBy083(stampHostedWorkspace(v3) as Record<string, unknown>)).toBe(true);
    // One needing nothing is written as it was, and 0.8.3 opens it.
    expect(stampHostedWorkspace(workspace())).toEqual(workspace());
    expect(refusedBy083(workspace() as unknown as Record<string, unknown>)).toBe(false);
  });

  it("is read back by this build, and refused by it when it names a feature it does not have", () => {
    const ws = workspace({ "FSC-A": GRID, "B-A": GRID });
    const hosted = JSON.parse(JSON.stringify(stampHostedWorkspace(ws)));
    const back = migrateWorkspaceToV2(hosted);
    expect(back.version).toBe(2);
    expect("requiredFeatures" in back).toBe(false);
    expect(back.gating.gates.g1).toEqual(ws.gating.gates.g1);
    expect(() => migrateWorkspaceToV2({ ...hosted, requiredFeatures: ["flowjo-grid", "something-later"] })).toThrow(/needs something-later/);
    // The form the hosted save wrote before, version 2 with the features key, is still read.
    const before = { ...hosted, version: 2 };
    expect(migrateWorkspaceToV2(before).gating.gates.g1).toEqual(ws.gating.gates.g1);
    expect(() => migrateWorkspaceToV2({ ...before, requiredFeatures: ["something-later"] })).toThrow(/needs something-later/);
  });
});
