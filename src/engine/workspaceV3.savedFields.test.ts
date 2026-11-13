import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKSPACE_FORMAT, type WorkspaceFile } from "./workspace";
import { stampWorkspaceV3 } from "./workspaceFeatures";
import { migrateWorkspaceV2ToV3, validateWorkspaceV3 } from "./workspaceV3";

// A version 3 workspace is refused when it holds a field its reader does not list. The saver
// gained `strategy`, `derived` and `images` without the lists gaining them, as `groupId`,
// `plotting` and `hostedAssayId` had before, and a workspace with a compensation profile then
// refused to reopen. These tests hold the lists to the fields the workspace types declare.

function v2(): WorkspaceFile {
  return {
    format: WORKSPACE_FORMAT, version: 2, savedAt: "2026-11-11T00:00:00.000Z", app: "GateLab",
    samples: [{ sampleId: "S1", fileName: "S1.fcs", dataPath: "data/0_S1.fcs", logicleW: {}, compensationOn: false }],
    activeSample: 0,
    gating: {
      gates: {}, gate_order: [],
      populations: { root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: [], event_count: null, percent_of_parent: null } },
      root_population_id: "root", active_population_id: "root", selected_gate_id: null,
    },
    scales: { globalScales: {} },
    display: { xChannel: "FL1-A", yChannel: "FL2-A", mode: "pseudocolor", maxEvents: 1000, contourThreshold: 5 },
  } as WorkspaceFile;
}

const reopened = (ws: WorkspaceFile) =>
  validateWorkspaceV3(JSON.parse(JSON.stringify(stampWorkspaceV3(migrateWorkspaceV2ToV3(ws)))));

/** The property names an interface in workspace.ts declares at its top level. */
function declaredFields(name: string): string[] {
  const source = readFileSync(new URL("./workspace.ts", import.meta.url), "utf8");
  const start = source.indexOf(`export interface ${name} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf("\n}\n", start));
  return [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((match) => match[1]);
}

describe("a version 3 workspace reopens with every field the saver writes", () => {
  it("with the Strategy tab's controls", async () => {
    const ws = v2();
    ws.strategy = { mode: "single" } as WorkspaceFile["strategy"];
    await expect(reopened(ws)).resolves.toMatchObject({ strategy: { mode: "single" } });
  });

  it("with a derived channel on a file", async () => {
    const ws = v2();
    ws.samples[0].derived = [{ name: "Ratio", feature: "ratio", range: 10, dtype: "f32", values: "" } as never];
    const back = await reopened(ws);
    expect(back.samples[0].derived).toHaveLength(1);
  });

  it("with cell images attached to a file", async () => {
    const ws = v2();
    ws.samples[0].images = [{ kind: "cvw", fileName: "S1.cvw", eventCount: 0 }];
    const back = await reopened(ws);
    expect(back.samples[0].images).toEqual([{ kind: "cvw", fileName: "S1.cvw", eventCount: 0 }]);
  });

  it("accepts every field WorkspaceFile declares", async () => {
    const fields = declaredFields("WorkspaceFile").filter((field) => field !== "version");
    expect(fields).toContain("strategy");
    const v3 = stampWorkspaceV3(migrateWorkspaceV2ToV3(v2())) as unknown as Record<string, unknown>;
    // The key check reads the object's own keys, so a declared field is present with no value.
    for (const field of fields) if (!(field in v3)) v3[field] = undefined;
    await expect(validateWorkspaceV3(v3)).resolves.toBeTruthy();
  });

  it("accepts every field WorkspaceSample declares", async () => {
    const fields = declaredFields("WorkspaceSample").filter((field) => field !== "compensationOn");
    expect(fields).toEqual(expect.arrayContaining(["derived", "images", "groupId"]));
    const v3 = stampWorkspaceV3(migrateWorkspaceV2ToV3(v2())) as unknown as { samples: Record<string, unknown>[] };
    for (const field of fields) if (!(field in v3.samples[0])) v3.samples[0][field] = undefined;
    await expect(validateWorkspaceV3(v3)).resolves.toBeTruthy();
  });
});
