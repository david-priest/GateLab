import { describe, expect, it } from "vitest";
import {
  createCompensationBaselineProfile,
  createCompensationProfileRevision,
  createResetToBaselineRevision,
  type BaselineCompensationProfileRecord,
  type CompensationProfileOrigin,
  type CompensationProfileProvenance,
  type CompensationProfileRecord,
  type RevisionCompensationProfileRecord,
} from "./compensationProfileRecord";
import {
  CompensationProfileLineageValidationError,
  validateCompensationProfileLineage,
  type CompensationProfileLineageValidationCode,
} from "./compensationProfileLineage";
import {
  validateAndCanonicalizeCompensationMatrix,
  type CanonicalCompensationMatrix,
  type CompensationKind,
  type CompensationMatrixInput,
  type CompensationProfileHashInput,
} from "./compensationProfile";

const BASELINE_TIME = "2026-07-17T11:00:00.000Z";
const MINUTE_1 = "2026-07-17T11:01:00.000Z";
const MINUTE_2 = "2026-07-17T11:02:00.000Z";
const MINUTE_3 = "2026-07-17T11:03:00.000Z";
const FLOW_SETTINGS = {
  singularTolerance: 1e-12,
  conditionWarningThreshold: 1e8,
} as const;
const NNLS_SETTINGS = {
  tolerance: 1e-10,
  kktTolerance: 1e-9,
  maxIterations: 1000,
  adaptationVersion: "identity-backed-v1",
} as const;

const ORIGIN: CompensationProfileOrigin = {
  type: "uploaded",
  fileName: "Wing Lab reference.csv",
  format: "csv",
  sourceColumnHeader: "channel",
};
const PROVENANCE: CompensationProfileProvenance = {
  controlDate: "2026-07-01",
  controlType: "single-stained beads",
  instrument: "Aurora",
  estimationMethod: "manual review",
};

function canonicalMatrix(
  input: CompensationMatrixInput,
  kind: CompensationKind,
): CanonicalCompensationMatrix {
  const result = validateAndCanonicalizeCompensationMatrix(input, kind);
  if (!result.ok) throw new Error(result.errors.map(({ message }) => message).join(" "));
  return result.value;
}

function flowScientific(
  ab = 0.1,
  options: {
    readonly channels?: readonly [string, string];
    readonly solverVersion?: string;
    readonly singularTolerance?: number;
  } = {},
): CompensationProfileHashInput {
  const channels = options.channels ?? ["A", "B"];
  return {
    kind: "flow-spillover",
    method: "matrix-inverse",
    solverVersion: options.solverVersion ?? "flow-lu-v1",
    solverSettings: {
      ...FLOW_SETTINGS,
      singularTolerance: options.singularTolerance ?? FLOW_SETTINGS.singularTolerance,
    },
    matrix: canonicalMatrix(
      {
        sourceChannels: channels,
        receiverChannels: channels,
        matrix: [
          [1, ab],
          [0.05, 1],
        ],
      },
      "flow-spillover",
    ),
  };
}

function cytofScientific(
  ac = 0.2,
  includedChannels: readonly string[] = ["A", "B", "C"],
): CompensationProfileHashInput {
  return {
    kind: "cytof-spillover",
    method: "nnls",
    solverVersion: "coordinate-descent-qr-v1",
    solverSettings: NNLS_SETTINGS,
    matrix: canonicalMatrix(
      {
        sourceChannels: ["A", "B"],
        receiverChannels: ["A", "B", "C"],
        matrix: [
          [1, 0.1, ac],
          [0.05, 1, 0.3],
        ],
      },
      "cytof-spillover",
    ),
    includedChannels,
  };
}

async function baseline(
  profileId = "baseline",
  scientific: CompensationProfileHashInput = flowScientific(),
  options: {
    readonly createdAt?: string;
    readonly origin?: CompensationProfileOrigin;
    readonly provenance?: CompensationProfileProvenance;
  } = {},
): Promise<BaselineCompensationProfileRecord> {
  return createCompensationBaselineProfile(scientific, {
    profileId,
    name: `${profileId} profile`,
    createdAt: options.createdAt ?? BASELINE_TIME,
    origin: options.origin ?? ORIGIN,
    provenance: options.provenance ?? PROVENANCE,
  });
}

async function edit(
  parent: CompensationProfileRecord,
  profileId: string,
  scientific: CompensationProfileHashInput,
  createdAt = MINUTE_1,
): Promise<RevisionCompensationProfileRecord> {
  return createCompensationProfileRevision(parent, scientific, {
    profileId,
    createdAt,
  });
}

async function expectLineageError(
  input: unknown,
  code: CompensationProfileLineageValidationCode,
): Promise<CompensationProfileLineageValidationError> {
  try {
    await validateCompensationProfileLineage(input);
  } catch (error) {
    expect(error).toBeInstanceOf(CompensationProfileLineageValidationError);
    const lineageError = error as CompensationProfileLineageValidationError;
    expect(lineageError.code).toBe(code);
    return lineageError;
  }
  throw new Error(`Expected lineage validation code ${code}.`);
}

function ids(records: readonly CompensationProfileRecord[]): string[] {
  return records.map(({ profileId }) => profileId);
}

describe("valid compensation profile lineage graphs", () => {
  it.each([
    ["flow", flowScientific()],
    ["CyTOF", cytofScientific()],
  ] as const)("accepts an immutable singleton %s baseline", async (_label, scientific) => {
    const root = await baseline("only", scientific);
    const result = await validateCompensationProfileLineage([root]);

    expect(result.baseline.profileId).toBe("only");
    expect(result.records).toEqual([root]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(Object.isFrozen(result.baseline)).toBe(true);
    expect(Object.isFrozen(result.baseline.scientific.matrix.matrix[0])).toBe(true);
  });

  it("accepts a linear flow history supplied in reverse order", async () => {
    const root = await baseline();
    const first = await edit(root, "first", flowScientific(0.2), MINUTE_1);
    const second = await edit(first, "second", flowScientific(0.3), MINUTE_2);
    const result = await validateCompensationProfileLineage([second, first, root]);

    expect(ids(result.records)).toEqual(["baseline", "first", "second"]);
    expect(result.baseline).toBe(result.records[0]);
  });

  it("accepts a branched CyTOF history and orders ready siblings by time then profile ID", async () => {
    const root = await baseline("cytof-root", cytofScientific());
    const branchB = await edit(root, "branch-b", cytofScientific(0.22), MINUTE_1);
    const branchA = await edit(root, "branch-a", cytofScientific(0.24), MINUTE_1);
    const childA = await edit(branchA, "child-a", cytofScientific(0.26), MINUTE_3);
    const childB = await edit(branchB, "child-b", cytofScientific(0.28), MINUTE_2);

    const shuffled = [childA, branchB, root, childB, branchA];
    const result = await validateCompensationProfileLineage(shuffled);
    expect(ids(result.records)).toEqual([
      "cytof-root",
      "branch-a",
      "branch-b",
      "child-b",
      "child-a",
    ]);

    const differentlyShuffled = await validateCompensationProfileLineage([
      branchA,
      childB,
      childA,
      root,
      branchB,
    ]);
    expect(ids(differentlyShuffled.records)).toEqual(ids(result.records));
  });

  it("allows a revision timestamp equal to its parent timestamp", async () => {
    const root = await baseline();
    const equalTime = await edit(root, "same-time", flowScientific(0.2), BASELINE_TIME);
    const result = await validateCompensationProfileLineage([equalTime, root]);
    expect(ids(result.records)).toEqual(["baseline", "same-time"]);
  });

  it("accepts a solver-only edit with an unchanged matrix hash", async () => {
    const root = await baseline();
    const solverEdit = await edit(
      root,
      "solver-edit",
      flowScientific(0.1, { solverVersion: "flow-lu-v2", singularTolerance: 1e-11 }),
    );
    expect(solverEdit.matrixHash).toBe(root.matrixHash);
    expect(solverEdit.profileHash).not.toBe(root.profileHash);

    const result = await validateCompensationProfileLineage([solverEdit, root]);
    expect(ids(result.records)).toEqual(["baseline", "solver-edit"]);
  });

  it("accepts a CyTOF included-channel edit followed by an exact reset", async () => {
    const root = await baseline("cytof-baseline", cytofScientific());
    const includedEdit = await edit(
      root,
      "included-edit",
      cytofScientific(0.2, ["A", "C"]),
      MINUTE_1,
    );
    expect(includedEdit.matrixHash).toBe(root.matrixHash);
    expect(includedEdit.profileHash).not.toBe(root.profileHash);
    const reset = await createResetToBaselineRevision(includedEdit, root, {
      profileId: "exact-reset",
      createdAt: MINUTE_2,
    });

    const result = await validateCompensationProfileLineage([reset, root, includedEdit]);
    expect(ids(result.records)).toEqual(["cytof-baseline", "included-edit", "exact-reset"]);
    expect(result.records[2].scientific).toEqual(root.scientific);
  });

  it("accepts replay of an older nonbaseline state as a genuine edit", async () => {
    const root = await baseline();
    const older = await edit(root, "older", flowScientific(0.2), MINUTE_1);
    const current = await edit(older, "current", flowScientific(0.3), MINUTE_2);
    const replay = await edit(current, "replay", flowScientific(0.2), MINUTE_3);

    expect(replay.profileHash).toBe(older.profileHash);
    expect(replay.profileHash).not.toBe(current.profileHash);
    expect(replay.profileHash).not.toBe(root.profileHash);
    await expect(
      validateCompensationProfileLineage([replay, root, current, older]),
    ).resolves.toMatchObject({ records: [root, older, current, replay] });
  });

  it("does not retain mutable input objects and returns deeply immutable records", async () => {
    const root = await baseline();
    const revision = await edit(root, "revision", flowScientific(0.2));
    const mutableInput = JSON.parse(JSON.stringify([revision, root])) as Array<
      Record<string, unknown>
    >;
    const result = await validateCompensationProfileLineage(mutableInput);

    mutableInput.reverse();
    mutableInput[0].name = "mutated outside";
    const inputScientific = mutableInput[0].scientific as {
      matrix: { matrix: number[][] };
    };
    inputScientific.matrix.matrix[0][0] = 999;

    expect(ids(result.records)).toEqual(["baseline", "revision"]);
    expect(result.records[0].name).toBe("baseline profile");
    expect(result.records[0].scientific.matrix.matrix[0][0]).toBe(1);
    expect(Object.isFrozen(result.records[0].origin)).toBe(true);
    expect(Object.isFrozen(result.records[0].provenance)).toBe(true);
    expect(Object.isFrozen(result.records[0].scientific)).toBe(true);
    expect(Object.isFrozen(result.records[0].scientific.matrix.matrix[0])).toBe(true);
    expect(() => {
      (result.records as CompensationProfileRecord[]).push(root);
    }).toThrow(TypeError);
    expect(() => {
      (result.records[0] as { name: string }).name = "cannot mutate";
    }).toThrow(TypeError);
  });
});

describe("lineage container and local-record trust boundaries", () => {
  it.each([null, {}, "records", new Set()])("rejects non-array container %#", async (value) => {
    await expectLineageError(value, "invalid-lineage-container");
  });

  it("rejects sparse arrays instead of silently skipping holes", async () => {
    const sparse = new Array<unknown>(2);
    sparse[1] = await baseline();
    await expectLineageError(sparse, "invalid-lineage-container");
  });

  it("rejects an empty history", async () => {
    await expectLineageError([], "empty-lineage");
  });

  it("wraps a locally invalid record with its input index and cause", async () => {
    const root = await baseline();
    const invalid = { ...root, unexpected: true };
    const error = await expectLineageError([root, invalid], "invalid-record");
    expect(error.recordIndex).toBe(1);
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.message).toContain("record 2 is invalid");
    expect((error.cause as Error).message).toContain("unexpected field");
  });

  it("rejects duplicate profile IDs before interpreting graph edges", async () => {
    const root = await baseline();
    const first = await edit(root, "duplicate", flowScientific(0.2));
    const second = await edit(root, "duplicate", flowScientific(0.3));
    const error = await expectLineageError(
      [second, root, first],
      "duplicate-profile-id",
    );
    expect(error.profileId).toBe("duplicate");
  });
});

describe("baseline identity and graph structure", () => {
  it("rejects both zero and multiple baseline records", async () => {
    const root = await baseline("root");
    const revision = await edit(root, "revision", flowScientific(0.2));
    await expectLineageError([revision], "baseline-count");

    const other = await baseline("other");
    await expectLineageError([other, root], "baseline-count");
  });

  it("rejects a locally valid revision whose baseline identity drifts", async () => {
    const root = await baseline();
    const revision = await edit(root, "revision", flowScientific(0.2));
    const drifted = {
      ...revision,
      baselineProfileId: "different-baseline",
    } satisfies CompensationProfileRecord;
    const error = await expectLineageError(
      [root, drifted],
      "baseline-reference-mismatch",
    );
    expect(error.profileId).toBe("revision");
    expect(error.relatedProfileId).toBe("baseline");
  });

  it("rejects a locally valid missing-parent reference", async () => {
    const root = await baseline();
    const revision = await edit(root, "orphan", flowScientific(0.2));
    const orphan = {
      ...revision,
      parentProfileId: "missing-parent",
    } satisfies RevisionCompensationProfileRecord;
    const error = await expectLineageError([orphan, root], "missing-parent");
    expect(error.profileId).toBe("orphan");
    expect(error.relatedProfileId).toBe("missing-parent");
  });

  it("reports a canonical closed cycle independent of input order", async () => {
    const root = await baseline();
    const first = await edit(root, "cycle-b", flowScientific(0.2));
    const second = await edit(root, "cycle-a", flowScientific(0.3));
    const cycleB = { ...first, parentProfileId: "cycle-a" } satisfies RevisionCompensationProfileRecord;
    const cycleA = { ...second, parentProfileId: "cycle-b" } satisfies RevisionCompensationProfileRecord;

    const firstError = await expectLineageError([cycleB, root, cycleA], "cycle");
    const secondError = await expectLineageError([cycleA, cycleB, root], "cycle");
    expect(firstError.cycle).toEqual(["cycle-a", "cycle-b", "cycle-a"]);
    expect(secondError.cycle).toEqual(firstError.cycle);
    expect(firstError.profileId).toBe("cycle-a");
    expect(Object.isFrozen(firstError.cycle)).toBe(true);
  });

  it("rejects a child that predates its parent or baseline", async () => {
    const root = await baseline();
    const revision = await edit(root, "revision", flowScientific(0.2));
    const predating = {
      ...revision,
      createdAt: "2026-07-17T10:59:59.999Z",
    } satisfies RevisionCompensationProfileRecord;
    const error = await expectLineageError([root, predating], "chronology");
    expect(error.profileId).toBe("revision");
    expect(error.relatedProfileId).toBe("baseline");
  });
});

describe("lineage scientific and provenance invariants", () => {
  it("rejects origin drift", async () => {
    const root = await baseline();
    const revision = await edit(root, "revision", flowScientific(0.2));
    const drifted = {
      ...revision,
      origin: {
        type: "uploaded",
        fileName: "different.csv",
        format: "csv",
        sourceColumnHeader: "channel",
      },
    } satisfies RevisionCompensationProfileRecord;
    await expectLineageError([root, drifted], "origin-mismatch");
  });

  it("rejects provenance drift", async () => {
    const root = await baseline();
    const revision = await edit(root, "revision", flowScientific(0.2));
    const drifted = {
      ...revision,
      provenance: { ...revision.provenance, instrument: "Different instrument" },
    } satisfies RevisionCompensationProfileRecord;
    await expectLineageError([drifted, root], "provenance-mismatch");
  });

  it("rejects a locally canonical change from flow inversion to CyTOF NNLS", async () => {
    const root = await baseline("flow-root");
    const cytofRoot = await baseline("cytof-root", cytofScientific());
    const cytofEdit = await edit(cytofRoot, "kind-drift", cytofScientific(0.25));
    const drifted = {
      ...cytofEdit,
      parentProfileId: root.profileId,
      baselineProfileId: root.profileId,
      baselineMatrixHash: root.matrixHash,
      baselineProfileHash: root.profileHash,
      origin: root.origin,
      provenance: root.provenance,
    } satisfies RevisionCompensationProfileRecord;
    await expectLineageError([drifted, root], "kind-method-mismatch");
  });

  it("rejects changed source and receiver axes within the same compensation kind", async () => {
    const root = await baseline("root");
    const otherRoot = await baseline(
      "other-root",
      flowScientific(0.1, { channels: ["A", "C"] }),
    );
    const otherEdit = await edit(
      otherRoot,
      "axis-drift",
      flowScientific(0.2, { channels: ["A", "C"] }),
    );
    const drifted = {
      ...otherEdit,
      parentProfileId: root.profileId,
      baselineProfileId: root.profileId,
      baselineMatrixHash: root.matrixHash,
      baselineProfileHash: root.profileHash,
      origin: root.origin,
      provenance: root.provenance,
    } satisfies RevisionCompensationProfileRecord;
    await expectLineageError([root, drifted], "axis-mismatch");
  });

  it("rejects an edit that is scientifically identical to its parent", async () => {
    const root = await baseline();
    const changed = await edit(root, "changed", flowScientific(0.2), MINUTE_1);
    const noOp = {
      ...changed,
      profileId: "edit-no-op",
      parentProfileId: changed.profileId,
      createdAt: MINUTE_2,
    } satisfies RevisionCompensationProfileRecord;
    const error = await expectLineageError([noOp, root, changed], "edit-no-op");
    expect(error.profileId).toBe("edit-no-op");
    expect(error.relatedProfileId).toBe("changed");
  });

  it("rejects a reset whose parent is already at baseline", async () => {
    const root = await baseline();
    const changed = await edit(root, "changed", flowScientific(0.2), MINUTE_1);
    const firstReset = await createResetToBaselineRevision(changed, root, {
      profileId: "first-reset",
      createdAt: MINUTE_2,
    });
    const noOpReset = {
      ...firstReset,
      profileId: "second-reset",
      parentProfileId: firstReset.profileId,
      createdAt: MINUTE_3,
    } satisfies RevisionCompensationProfileRecord;
    const error = await expectLineageError(
      [firstReset, noOpReset, changed, root],
      "reset-no-op",
    );
    expect(error.profileId).toBe("second-reset");
    expect(error.relatedProfileId).toBe("first-reset");
  });

  it("wraps locally impossible edit-to-baseline and nonbaseline-reset records as invalid", async () => {
    const root = await baseline();
    const changed = await edit(root, "changed", flowScientific(0.2));
    const editRestoringBaseline = {
      ...root,
      recordType: "revision",
      profileId: "bad-edit",
      parentProfileId: changed.profileId,
      revisionReason: "edit",
      baselineProfileId: root.profileId,
      baselineMatrixHash: root.matrixHash,
      baselineProfileHash: root.profileHash,
      createdAt: MINUTE_2,
    } satisfies RevisionCompensationProfileRecord;
    const invalidEdit = await expectLineageError(
      [root, changed, editRestoringBaseline],
      "invalid-record",
    );
    expect((invalidEdit.cause as Error).message).toContain("recorded as reset-to-baseline");

    const resetNotAtBaseline = {
      ...changed,
      profileId: "bad-reset",
      parentProfileId: changed.profileId,
      revisionReason: "reset-to-baseline",
      createdAt: MINUTE_2,
    } satisfies RevisionCompensationProfileRecord;
    const invalidReset = await expectLineageError(
      [root, changed, resetNotAtBaseline],
      "invalid-record",
    );
    expect((invalidReset.cause as Error).message).toContain("restore the complete baseline");
  });
});
