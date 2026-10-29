import { describe, expect, it } from "vitest";
import { hashCompensationMatrix, validateAndCanonicalizeCompensationMatrix } from "../engine/compensationProfile";
import { serializeCompensationMatrixCsv } from "../engine/compensationMatrixExport";
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
  importedFlowMatrix,
  numberMatrices,
  planMatrixSwitch,
  restoredMatrixNumbers,
  storableFlowMatrix,
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
    // A copy is a second row: the file's own matrix stays listed beside it, to go back to.
    const copy = await duplicateOfRow(rows[1], "D1 spillover copy");
    const withCopy = buildMatrixLibrary(
      state([{ baselineProfileId: copy.profileId, records: [copy] }], copy.profileId),
      [d1!, d2!],
      [{ kind: "profile", profileId: copy.profileId }, { kind: "profile", profileId: copy.profileId }],
    );
    expect(withCopy.map(({ name, kind, active }) => [name, kind, active])).toEqual([
      ["D1 spillover copy", "lineage", true],
      ["D1 spillover", "embedded", false],
    ]);
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

/** A matrix as FACSDiva writes one: single-precision noise on a zero and on a diagonal. */
const divaNoise = {
  sourceChannels: ["FL1-A", "FL2-A", "FL3-A"],
  receiverChannels: ["FL1-A", "FL2-A", "FL3-A"],
  matrix: [[0.9999999974, 0.069, -5e-9], [0.0698593727, 1.0000020054, 0.0010170859], [4.9e-9, 0.5132114846, 1]],
};

describe("a matrix with floating-point noise", () => {
  it("is stored with only the noisy coefficients set to 0 and 1", () => {
    const { validation, roundedCoefficients } = storableFlowMatrix(divaNoise);
    expect(validation.ok).toBe(true);
    // 0.9999999974 is within the engine's own diagonal tolerance; 1.0000020054 and -5e-9 are not.
    expect(roundedCoefficients).toBe(2);
    expect(validation.ok && validation.value.matrix).toEqual([
      [0.9999999974, 0.069, 0],
      [0.0698593727, 1, 0.0010170859],
      [4.9e-9, 0.5132114846, 1],
    ]);
  });

  it("leaves a matrix that is already valid exactly as it is", () => {
    const exact = { ...divaNoise, matrix: [[1, 0.069, 0], [0.07, 1, 0.001], [0, 0.51, 1]] };
    const { validation, roundedCoefficients } = storableFlowMatrix(exact);
    expect(roundedCoefficients).toBe(0);
    expect(validation.ok && validation.value.matrix).toEqual(exact.matrix);
  });

  it("still refuses a negative coefficient or a diagonal beyond noise, and any other objection", () => {
    for (const matrix of [
      [[1, 0.069, -0.0001], [0.07, 1, 0.001], [0, 0.51, 1]],
      [[1, 0.069, 0], [0.07, 0.999, 0.001], [0, 0.51, 1]],
      // Noise beside a real objection is not rounded either.
      [[1, 0.069, -5e-9], [0.07, 1, 0.001], [0, 0.51, Number.NaN]],
    ]) {
      const { validation, roundedCoefficients } = storableFlowMatrix({ ...divaNoise, matrix });
      expect(validation.ok).toBe(false);
      expect(roundedCoefficients).toBe(0);
    }
  });

  it("can be copied from a file that carries it, while Export writes what the file carries", async () => {
    const fcs = flowFcs();
    const noisy = new Sample({ ...fcs, spillover: { channels: ["FL1-A", "FL2-A"], matrix: [[1.000002, 0.1], [-5e-9, 1]] } });
    const embedded = (await embeddedFlowMatrixOf(noisy, "D1.fcs"))!;
    expect(embedded.problem).toBeNull();
    expect(embedded.roundedCoefficients).toBe(2);
    expect(embedded.matrix!.matrix).toEqual([[1, 0.1], [0, 1]]);
    const [row] = buildMatrixLibrary(state([]), [embedded], [{ kind: "embedded", key: embedded.key }]);
    expect(row.unusable).toBeNull();
    expect(row.exportMatrix.matrix).toEqual([[1.000002, 0.1], [-5e-9, 1]]);
    const copy = await duplicateOfRow(row, "D1 spillover copy");
    expect(copy.scientific.matrix.matrix).toEqual([[1, 0.1], [0, 1]]);
    expect(copy.provenance?.estimationMethod).toBe(
      "Imported from FCS; 2 coefficients within 0.00001 of 0 or 1 set to exactly 0 or 1, all others preserved exactly",
    );
  });

  it("imports as it is stored, and says how many coefficients were set", async () => {
    const csv = serializeCompensationMatrixCsv(divaNoise);
    const imported = await importedFlowMatrix(csv, "diva.csv", new Set(divaNoise.receiverChannels));
    expect(imported.roundedCoefficients).toBe(2);
    expect(imported.profile.provenance?.estimationMethod).toContain("2 coefficients within 0.00001 of 0 or 1");
  });
});

describe("Export CSV and Import CSV/TSV", () => {
  it("read back the same matrix, coefficient for coefficient", async () => {
    const original = validateAndCanonicalizeCompensationMatrix({
      ...divaNoise,
      matrix: [[1, 0.029123456789012344, 0], [0.0698593727, 1, 1e-7], [4.9e-9, 0.5132114846, 1]],
    }, "flow-spillover");
    if (!original.ok) throw new Error("invalid");
    const imported = await importedFlowMatrix(
      serializeCompensationMatrixCsv(original.value),
      "exported.csv",
      new Set(divaNoise.receiverChannels),
    );
    expect(imported.roundedCoefficients).toBe(0);
    expect(imported.profile.scientific.matrix.matrix).toEqual(original.value.matrix);
    expect(imported.profile.matrixHash).toBe(await hashCompensationMatrix(original.value));
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

describe("matrix numbers", () => {
  it("numbers the primary matrix first, the active one where there is one, then the rest in list order", async () => {
    const d1 = (await embeddedFlowMatrixOf(new Sample(flowFcs()), "D1.fcs"))!;
    const a = await profile("a", 0.2);
    const b = await profile("b", 0.4);
    const rows = buildMatrixLibrary(
      state([{ baselineProfileId: "a", records: [a] }, { baselineProfileId: "b", records: [b] }], "b"),
      [d1],
      [null],
    );
    const numbers = numberMatrices(null, rows)!;
    expect(numbers.primary).toBe("lineage:b");
    expect(numbers.byKey).toEqual({ "lineage:b": 1, "lineage:a": 2, [`embedded:${d1.key}`]: 3 });
    expect(numbers.next).toBe(4);
    // Nothing new: the same object, so no state churns.
    expect(numberMatrices(numbers, rows)).toBe(numbers);
    const shown = buildMatrixLibrary(
      state([{ baselineProfileId: "a", records: [a] }, { baselineProfileId: "b", records: [b] }], "b"),
      [d1],
      [null],
      "flow-spillover",
      numbers,
    );
    expect(shown.map(({ name, number, primary }) => [name, number, primary])).toEqual([
      ["a matrix", 2, false],
      ["b matrix", 1, true],
      ["D1 spillover", 3, false],
    ]);
  });

  it("makes the first file's own matrix primary where none is in use, and none where there is none", async () => {
    const d1 = (await embeddedFlowMatrixOf(new Sample(flowFcs()), "D1.fcs"))!;
    const a = await profile("a", 0.2);
    expect(numberMatrices(null, buildMatrixLibrary(state([{ baselineProfileId: "a", records: [a] }]), [d1], [null]))!.primary)
      .toBe(`embedded:${d1.key}`);
    const none = numberMatrices(null, buildMatrixLibrary(state([{ baselineProfileId: "a", records: [a] }]), [], []))!;
    expect(none.primary).toBeNull();
    expect(none.byKey).toEqual({ "lineage:a": 1 });
    // Decided once: a matrix used later is not made primary.
    const b = await profile("b", 0.4);
    const later = numberMatrices(none, buildMatrixLibrary(
      state([{ baselineProfileId: "a", records: [a] }, { baselineProfileId: "b", records: [b] }], "b"), [], []))!;
    expect(later.primary).toBeNull();
    expect(later.byKey["lineage:b"]).toBe(2);
  });

  it("shows a file's matrix number on its stored form, and gives the stored form its own once edited", async () => {
    const d1 = (await embeddedFlowMatrixOf(new Sample(flowFcs()), "D1.fcs"))!;
    const [embeddedRow] = buildMatrixLibrary(state([]), [d1], [null]);
    const numbers = numberMatrices(null, [embeddedRow])!;
    const stored = await duplicateOfRow(embeddedRow, "D1 spillover");
    const asStored = buildMatrixLibrary(
      state([{ baselineProfileId: stored.profileId, records: [stored] }], stored.profileId), [d1], [null], "flow-spillover", numbers);
    expect(asStored.map(({ kind, number, primary }) => [kind, number, primary])).toEqual([["lineage", 1, true]]);
    expect(numberMatrices(numbers, asStored)).toBe(numbers);

    const edit = await createCompensationProfileRevision(stored, {
      kind: "flow-spillover",
      method: "matrix-inverse",
      solverVersion: stored.scientific.solverVersion,
      solverSettings: { singularTolerance: 1e-12, conditionWarningThreshold: 1e8 },
      matrix: (await profile("x", 0.3)).scientific.matrix,
    }, { profileId: "d1-edit", createdAt: new Date(Date.now() + 60_000) });
    const edited = state([{ baselineProfileId: stored.profileId, records: [stored, edit] }], "d1-edit");
    const renumbered = numberMatrices(numbers, buildMatrixLibrary(edited, [d1], [null], "flow-spillover", numbers))!;
    const rows = buildMatrixLibrary(edited, [d1], [null], "flow-spillover", renumbered);
    expect(rows.map(({ kind, number, primary }) => [kind, number, primary])).toEqual([
      ["lineage", 2, false],
      ["embedded", 1, true],
    ]);
  });

  it("reads back saved numbers, and drops any that do not hold together", () => {
    const saved = { next: 4, byKey: { "lineage:a": 1, "embedded:k": 3 }, primary: "embedded:k" };
    expect(restoredMatrixNumbers(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(restoredMatrixNumbers({ next: 2, byKey: {}, primary: null })).toEqual({ next: 2, byKey: {}, primary: null });
    for (const bad of [
      undefined,
      [],
      { next: 0, byKey: {} },
      { next: 3, byKey: { a: 3 } },
      { next: 4, byKey: { a: 1, b: 1 } },
      { next: 4, byKey: { a: 1.5 } },
      { next: 4, byKey: { a: 1 }, primary: "b" },
      { next: 4, byKey: { ["k".repeat(301)]: 1 } },
    ]) {
      expect(restoredMatrixNumbers(bad)).toBeNull();
    }
  });
});
