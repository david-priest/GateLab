import { describe, expect, it } from "vitest";
import { validateAndCanonicalizeCompensationMatrix } from "../engine/compensationProfile";
import {
  createCompensationBaselineProfile,
  createCompensationProfileRevision,
  type CompensationProfileRecord,
} from "../engine/compensationProfileRecord";
import type { FcsFile } from "../engine/fcs";
import { newGate, newGateRef, newPopulation, type Gate, type PopulationMap } from "../engine/models";
import { Sample } from "../engine/sample";
import { WORKSPACE_COMPENSATION_SCHEMA, type WorkspaceCompensationState } from "../engine/workspaceCompensation";
import {
  buildMatrixLibrary,
  copyName,
  duplicateOfRow,
  embeddedFlowMatrixOf,
  planMatrixSwitch,
  withDerivedActiveProfile,
} from "./compensationLibrary";

function flowFcs(second = "FL2-A"): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: 2,
    instrument: "flow",
    keywords: { $SPILLOVER: "2,FL1-A,FL2-A,1,0.1,0.05,1" },
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL1-A", marker: null, bits: 32, range: 262144 },
      { index: 2, name: second, marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([1, 2]), Float32Array.from([3, 4]), Float32Array.from([5, 6])],
    spillover: second === "FL2-A" ? { channels: ["FL1-A", "FL2-A"], matrix: [[1, 0.1], [0.05, 1]] } : null,
  };
}

async function profile(profileId: string, spill: number): Promise<CompensationProfileRecord> {
  const canonical = validateAndCanonicalizeCompensationMatrix({
    sourceChannels: ["FL1-A", "FL2-A"],
    receiverChannels: ["FL1-A", "FL2-A"],
    matrix: [[1, spill], [0.05, 1]],
  }, "flow-spillover");
  if (!canonical.ok) throw new Error("invalid");
  return createCompensationBaselineProfile({
    kind: "flow-spillover",
    method: "matrix-inverse",
    solverVersion: "flow-lu-v1",
    solverSettings: { singularTolerance: 1e-12, conditionWarningThreshold: 1e8 },
    matrix: canonical.value,
  }, {
    profileId,
    name: `${profileId} matrix`,
    createdAt: "2026-10-23T00:00:00.000Z",
    origin: { type: "uploaded", fileName: `${profileId}.csv`, format: "csv", sourceColumnHeader: "channel" },
  });
}

function state(
  lineages: WorkspaceCompensationState["lineages"],
  activeProfileId?: string,
): WorkspaceCompensationState {
  return { schema: WORKSPACE_COMPENSATION_SCHEMA, lineages, ...(activeProfileId ? { activeProfileId } : {}) };
}

describe("the Matrices list's rows", () => {
  it("lists every lineage, and an embedded matrix once and only when no row shows it", async () => {
    const d1 = await embeddedFlowMatrixOf(new Sample(flowFcs()), "D1.fcs");
    const d2 = await embeddedFlowMatrixOf(new Sample(flowFcs()), "D2.fcs");
    const a = await profile("a", 0.2);
    const rows = buildMatrixLibrary(
      state([{ baselineProfileId: "a", records: [a], name: "control" }]),
      [d1!, d2!],
      [null, null],
    );
    expect(rows.map(({ name, kind }) => [name, kind])).toEqual([["control", "lineage"], ["D1 spillover", "embedded"]]);
    expect(rows[0]).toMatchObject({ named: true, source: { type: "imported", fileName: "a.csv" }, canDelete: true, active: false });
    expect(rows[1]).toMatchObject({ canRename: false, canDelete: false, active: false, channelCount: 2 });

    // Once stored, the embedded matrix is the stored row, not a second one.
    const stored = await duplicateOfRow(rows[1], "D1 spillover");
    const withStored = buildMatrixLibrary(
      state([{ baselineProfileId: stored.profileId, records: [stored] }]),
      [d1!, d2!],
      [null, null],
    );
    expect(withStored.map(({ kind }) => kind)).toEqual(["lineage"]);
    expect(withStored[0].source).toEqual({ type: "embedded", fileName: "D1.fcs" });
  });

  it("marks the active lineage by the record it shows, and counts the files using it", async () => {
    const a = await profile("a", 0.2);
    const edit = await createCompensationProfileRevision(a, {
      kind: "flow-spillover",
      method: "matrix-inverse",
      solverVersion: "flow-lu-v1",
      solverSettings: { singularTolerance: 1e-12, conditionWarningThreshold: 1e8 },
      matrix: (await profile("x", 0.3)).scientific.matrix,
    }, { profileId: "a-edit", createdAt: "2026-10-23T00:01:00.000Z" });
    const b = await profile("b", 0.4);
    const rows = buildMatrixLibrary(
      state([
        { baselineProfileId: "a", records: [a, edit] },
        { baselineProfileId: "b", records: [b] },
      ], "a"),
      [],
      [{ kind: "profile", profileId: "a" }, { kind: "profile", profileId: "a-edit" }],
    );
    expect(rows[0]).toMatchObject({ active: true, filesUsing: 1, canDelete: false });
    expect(rows[0].profile?.profileId).toBe("a");
    expect(rows[1]).toMatchObject({ active: false, filesUsing: 0, canDelete: true });
  });

  it("marks files' own embedded matrix active while no stored matrix is", async () => {
    const d1 = await embeddedFlowMatrixOf(new Sample(flowFcs()), "D1.fcs");
    const rows = buildMatrixLibrary(state([]), [d1!], [{ kind: "embedded", key: d1!.key }, null]);
    expect(rows[0]).toMatchObject({ active: true, filesUsing: 1, unusable: null });
  });
});

describe("an embedded matrix GateLab cannot store", () => {
  it("is listed with why, keyed by its values, and counted for the file using it", async () => {
    const fcs = flowFcs();
    const odd = new Sample({ ...fcs, spillover: { channels: ["FL1-A", "FL2-A"], matrix: [[0.9, 0.1], [-0.05, 1]] } });
    const embedded = await embeddedFlowMatrixOf(odd, "D1.fcs");
    expect(embedded).toMatchObject({ matrix: null, matrixHash: null });
    expect(embedded!.problem).toBeTruthy();
    const rows = buildMatrixLibrary(state([]), [embedded!], [{ kind: "embedded", key: embedded!.key }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ matrix: null, active: true, filesUsing: 1, canDelete: false, canRename: false });
    expect(rows[0].unusable).toBe(embedded!.problem);
    expect(rows[0].exportMatrix.matrix).toEqual([[0.9, 0.1], [-0.05, 1]]);
  });
});

describe("a workspace saved before the list", () => {
  it("opens with the profile most of its files are bound to active", async () => {
    const a = await profile("a", 0.2);
    const b = await profile("b", 0.4);
    const lineages = [{ baselineProfileId: "a", records: [a] }, { baselineProfileId: "b", records: [b] }];
    expect(withDerivedActiveProfile(state(lineages), ["b", "a", "b", null]).activeProfileId).toBe("b");
    expect(withDerivedActiveProfile(state(lineages), [null, null]).activeProfileId).toBeUndefined();
    // A saved marker is kept as it is.
    expect(withDerivedActiveProfile(state(lineages, "a"), ["b", "b"]).activeProfileId).toBe("a");
  });
});

describe("what a switch would do", () => {
  it("counts the gates on compensated channels and the populations at or below them, and refuses an uncovered file", async () => {
    const d1 = new Sample(flowFcs());
    const d2 = new Sample(flowFcs("FL3-A"));
    const a = await profile("a", 0.2);
    const scatter: Gate = newGate("Cells", "rectangle", "FSC-A", "FSC-A", [[0, 0], [1, 0], [1, 1], [0, 1]]);
    const fluor: Gate = newGate("CD4_positive", "rectangle", "FL1-A", "FL2-A", [[0, 0], [1, 0], [1, 1], [0, 1]]);
    const root = newPopulation("All Events");
    const cells = newPopulation("Cells", [newGateRef(scatter.gate_id)], root.population_id);
    const positive = newPopulation("CD4_positive", [newGateRef(fluor.gate_id)], cells.population_id);
    const below = newPopulation("below", [], positive.population_id);
    const populations: PopulationMap = Object.fromEntries(
      [root, cells, positive, below].map((population) => [population.population_id, population]),
    );

    const plan = planMatrixSwitch(
      a.scientific.matrix,
      "flow-spillover",
      [{ name: "D1.fcs", sample: d1 }, { name: "D2.fcs", sample: d2 }],
      d1,
      { [scatter.gate_id]: scatter, [fluor.gate_id]: fluor },
      populations,
      root.population_id,
    );
    expect(plan).toMatchObject({ fileCount: 2, gateCount: 1, populationCount: 2, leavingEmbedded: [] });
    expect(plan.uncovered).toEqual([{ name: "D2.fcs", wrongInstrument: false, missingChannels: ["FL2-A"], message: null }]);
  });

  it("names a copy that no row has", () => {
    expect(copyName("control", new Set(["control"]))).toBe("control copy");
    expect(copyName("control", new Set(["control", "control copy"]))).toBe("control copy 2");
  });
});
