import { describe, expect, it } from "vitest";
import {
  COMPENSATION_PROFILE_RECORD_SCHEMA,
  createCompensationBaselineProfile,
  createCompensationProfileRevision,
  createResetToBaselineRevision,
  diffCompensationProfiles,
  validateCompensationProfileRecord,
  type BaselineCompensationProfileRecord,
  type CompensationProfileOrigin,
  type CompensationProfileProvenance,
  type CompensationProfileRecord,
  type NewBaselineMetadata,
} from "./compensationProfileRecord";
import {
  validateAndCanonicalizeCompensationMatrix,
  type CanonicalCompensationMatrix,
  type CompensationKind,
  type CompensationMatrixInput,
  type CompensationProfileHashInput,
} from "./compensationProfile";

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
const DIGEST_A = `sha256:${"a".repeat(64)}` as const;
const DIGEST_B = `sha256:${"b".repeat(64)}` as const;
const CREATED = "2026-07-17T11:00:00.000Z";

function canonicalMatrix(
  input: CompensationMatrixInput,
  kind: CompensationKind,
): CanonicalCompensationMatrix {
  const result = validateAndCanonicalizeCompensationMatrix(input, kind);
  if (!result.ok) throw new Error(result.errors.map(({ message }) => message).join(" "));
  return result.value;
}

function flowScientific(ab = 0.1, ba = 0.05): CompensationProfileHashInput {
  return {
    kind: "flow-spillover",
    method: "matrix-inverse",
    solverVersion: "flow-lu-v1",
    solverSettings: FLOW_SETTINGS,
    matrix: canonicalMatrix(
      {
        sourceChannels: ["A", "B"],
        receiverChannels: ["A", "B"],
        matrix: [
          [1, ab],
          [ba, 1],
        ],
      },
      "flow-spillover",
    ),
  };
}

function cytofScientific(
  includedChannels: readonly string[] = ["A", "B", "C"],
  ac = 0.2,
): CompensationProfileHashInput {
  return {
    kind: "cytof-spillover",
    method: "nnls",
    solverVersion: "lawson-hanson-v1",
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

function uploadedOrigin(
  overrides: Partial<Extract<CompensationProfileOrigin, { type: "uploaded" }>> = {},
): Extract<CompensationProfileOrigin, { type: "uploaded" }> {
  return {
    type: "uploaded",
    fileName: "Wing Lab QQ beads (2021-06-03), α β.csv",
    format: "csv",
    sourceColumnHeader: "",
    ...overrides,
  };
}

async function baseline(
  profileId = "baseline-1",
  scientific: CompensationProfileHashInput = flowScientific(),
  overrides: Partial<NewBaselineMetadata> = {},
): Promise<BaselineCompensationProfileRecord> {
  return createCompensationBaselineProfile(scientific, {
    profileId,
    name: "Baseline matrix",
    createdAt: CREATED,
    origin: uploadedOrigin(),
    ...overrides,
  });
}

describe("compensation profile baseline records", () => {
  it("creates a canonical immutable baseline with self-consistent hashes and provenance", async () => {
    const origin = uploadedOrigin({
      fileName: "  Wing Lab QQ beads (2021-06-03), α β.CSV  ",
      fileDigest: DIGEST_A,
    });
    const provenance: CompensationProfileProvenance = {
      controlDate: "2021-06-03",
      sourceDescription: "QQ bead matrix\npre-debarcoding",
      controlType: " bead controls ",
      instrument: " CyTOF 2 ",
      estimationMethod: " CATALYST::computeSpillmat ",
      estimationSoftware: { name: " CATALYST ", version: " 1.28.0 " },
      wasManuallyAdjustedBeforeImport: false,
      applicabilityNote: "Preserve this whitespace.  ",
    };
    const record = await createCompensationBaselineProfile(flowScientific(), {
      profileId: "baseline.portal-1",
      name: "  Cafe\u0301 baseline  ",
      createdAt: "2026-07-17T20:00:00+09:00",
      note: "  multiline note\nkeeps whitespace  ",
      origin,
      provenance,
    });

    expect(record).toMatchObject({
      schema: COMPENSATION_PROFILE_RECORD_SCHEMA,
      recordType: "baseline",
      profileId: "baseline.portal-1",
      name: "Café baseline",
      createdAt: CREATED,
      note: "  multiline note\nkeeps whitespace  ",
      parentProfileId: null,
      revisionReason: null,
      baselineProfileId: "baseline.portal-1",
    });
    expect(record.origin).toEqual(origin);
    expect(record.provenance).toEqual({
      ...provenance,
      controlType: "bead controls",
      instrument: "CyTOF 2",
      estimationMethod: "CATALYST::computeSpillmat",
      estimationSoftware: { name: "CATALYST", version: "1.28.0" },
    });
    expect(record.matrixHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.profileHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.baselineMatrixHash).toBe(record.matrixHash);
    expect(record.baselineProfileHash).toBe(record.profileHash);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.origin)).toBe(true);
    expect(Object.isFrozen(record.provenance)).toBe(true);
    expect(Object.isFrozen(record.provenance?.estimationSoftware)).toBe(true);
    expect(Object.isFrozen(record.scientific.matrix.matrix[0])).toBe(true);
  });

  it("deep-copies metadata and normalizes negative zero in stored scientific state", async () => {
    const origin = uploadedOrigin();
    const provenance: CompensationProfileProvenance = { instrument: "CyTOF" };
    const scientific = flowScientific(-0, 0.05);
    const record = await createCompensationBaselineProfile(scientific, {
      profileId: "zero-baseline",
      name: "Zero",
      createdAt: CREATED,
      origin,
      provenance,
    });
    (origin as { fileName: string }).fileName = "mutated.csv";
    (provenance as { instrument?: string }).instrument = "mutated";
    expect(record.origin.type === "uploaded" && record.origin.fileName).not.toBe("mutated.csv");
    expect(record.provenance?.instrument).toBe("CyTOF");
    expect(Object.is(record.scientific.matrix.matrix[0][1], -0)).toBe(false);
    expect(record.scientific.matrix.matrix[0][1]).toBe(0);
  });

  it("keeps metadata and source-byte identity outside the scientific profile hash", async () => {
    const first = await baseline("metadata-a", flowScientific(), {
      name: "First",
      note: "one",
      origin: uploadedOrigin({ fileName: "one.csv", fileDigest: DIGEST_A }),
    });
    const second = await baseline("metadata-b", flowScientific(), {
      name: "Second",
      note: "two",
      origin: uploadedOrigin({ fileName: "two.csv", fileDigest: DIGEST_B }),
    });
    expect(second.matrixHash).toBe(first.matrixHash);
    expect(second.profileHash).toBe(first.profileHash);
    expect(second.profileId).not.toBe(first.profileId);
  });

  it.each([
    {
      type: "embedded-fcs",
      fileName: "sample.FCS",
      fileDigest: DIGEST_A,
      keyword: "$SPILLOVER",
    },
    uploadedOrigin({ fileDigest: DIGEST_A, sourceColumnHeader: "channel" }),
    {
      type: "bundled-preset",
      presetId: "wing.qq-beads",
      presetVersion: "2021.06.03",
      assetDigest: DIGEST_A,
    },
  ] as CompensationProfileOrigin[])("round-trips the supported '$type' origin", async (origin) => {
    const record = await baseline(`origin-${origin.type}`, flowScientific(), { origin });
    const decoded = await validateCompensationProfileRecord(
      JSON.parse(JSON.stringify(record)),
    );
    expect(decoded).toEqual(record);
    expect(decoded).not.toBe(record);
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  it("accepts a leap-day timestamp but rejects impossible or ambiguous construction timestamps", async () => {
    await expect(
      baseline("leap", flowScientific(), { createdAt: "2024-02-29T00:00:00Z" }),
    ).resolves.toMatchObject({ createdAt: "2024-02-29T00:00:00.000Z" });
    await expect(
      baseline("early-year", flowScientific(), {
        createdAt: "0099-01-02T03:04:05Z",
        provenance: { controlDate: "0099-01-02" },
      }),
    ).resolves.toMatchObject({
      createdAt: "0099-01-02T03:04:05.000Z",
      provenance: { controlDate: "0099-01-02" },
    });
    await expect(
      baseline("feb30", flowScientific(), { createdAt: "2024-02-30T00:00:00Z" }),
    ).rejects.toThrow("invalid calendar");
    await expect(
      baseline("no-zone", flowScientific(), { createdAt: "2026-07-17T11:00:00" }),
    ).rejects.toThrow("explicit timezone");
    await expect(
      baseline("bad-offset", flowScientific(), { createdAt: "2026-07-17T11:00:00+15:00" }),
    ).rejects.toThrow("timezone offset");
    await expect(
      baseline("utc-year-overflow", flowScientific(), {
        createdAt: "9999-12-31T23:59:59-14:00",
      }),
    ).rejects.toThrow("four-digit UTC year");

    class MisleadingDate extends Date {
      override toISOString(): string {
        return "not the represented instant";
      }
    }
    await expect(
      baseline("intrinsic-date", flowScientific(), {
        createdAt: new MisleadingDate(CREATED),
      }),
    ).resolves.toMatchObject({ createdAt: CREATED });
    await expect(
      baseline("extended-year", flowScientific(), {
        createdAt: new Date(Date.UTC(10_000, 0, 1)),
      }),
    ).rejects.toThrow("four-digit year");
  });

  it("rejects unsafe IDs, names, filenames, digests, and origin shapes", async () => {
    await expect(baseline(" bad-id")).rejects.toThrow("portable identifier");
    await expect(baseline("ok-id", flowScientific(), { name: "\n" })).rejects.toThrow(
      "single-line",
    );
    await expect(
      baseline("blank-file", flowScientific(), {
        origin: uploadedOrigin({ fileName: "   " }),
      }),
    ).rejects.toThrow("filename must not be blank");
    await expect(
      baseline("nul-file", flowScientific(), {
        origin: uploadedOrigin({ fileName: "bad\0name.csv" }),
      }),
    ).rejects.toThrow("NUL");
    await expect(
      baseline("bad-digest", flowScientific(), {
        origin: uploadedOrigin({ fileDigest: `sha256:${"A".repeat(64)}` as typeof DIGEST_A }),
      }),
    ).rejects.toThrow("lowercase");
    await expect(
      baseline("edited-origin", flowScientific(), {
        origin: { type: "edited", fileName: "x.csv" } as unknown as CompensationProfileOrigin,
      }),
    ).rejects.toThrow("Unsupported");
    await expect(
      baseline("cross-kind", flowScientific(), {
        origin: {
          ...uploadedOrigin(),
          presetId: "wrong",
        } as unknown as CompensationProfileOrigin,
      }),
    ).rejects.toThrow("unexpected field");
  });
});

describe("compensation profile revisions and diffs", () => {
  it("creates an auditable child revision and names the exact edited coefficient", async () => {
    const root = await baseline();
    const revision = await createCompensationProfileRevision(root, flowScientific(0.125), {
      profileId: "revision-1",
      createdAt: "2026-07-17T11:01:00.000Z",
      note: "A → B review",
    });
    expect(revision).toMatchObject({
      recordType: "revision",
      profileId: "revision-1",
      name: root.name,
      parentProfileId: root.profileId,
      revisionReason: "edit",
      baselineProfileId: root.profileId,
      baselineMatrixHash: root.matrixHash,
      baselineProfileHash: root.profileHash,
    });
    expect(revision.origin).toEqual(root.origin);
    expect(revision.origin).not.toBe(root.origin);
    expect(revision.provenance).toEqual(root.provenance);
    expect(revision.matrixHash).not.toBe(root.matrixHash);
    expect(revision.profileHash).not.toBe(root.profileHash);

    const diff = diffCompensationProfiles(root, revision);
    expect(diff).toEqual({
      fromProfileId: "baseline-1",
      toProfileId: "revision-1",
      matrixHashChanged: true,
      profileHashChanged: true,
      coefficientChanges: [
        {
          sourceChannel: "A",
          receiverChannel: "B",
          before: 0.1,
          after: 0.125,
          delta: 0.024999999999999994,
        },
      ],
      solverVersionChange: null,
      solverSettingChanges: [],
      includedChannelsAdded: [],
      includedChannelsRemoved: [],
    });
    expect(Object.isFrozen(diff)).toBe(true);
    expect(Object.isFrozen(diff.coefficientChanges[0])).toBe(true);
  });

  it("accepts scientific solver-only changes even when the matrix hash is unchanged", async () => {
    const root = await baseline();
    const candidate = {
      ...flowScientific(),
      solverVersion: "flow-lu-v2",
      solverSettings: {
        singularTolerance: 1e-11,
        conditionWarningThreshold: 1e8,
      },
    } as CompensationProfileHashInput;
    const revision = await createCompensationProfileRevision(root, candidate, {
      profileId: "solver-revision",
      name: "Solver revision",
      createdAt: "2026-07-17T11:01:00.000Z",
    });
    expect(revision.matrixHash).toBe(root.matrixHash);
    expect(revision.profileHash).not.toBe(root.profileHash);
    const diff = diffCompensationProfiles(root, revision);
    expect(diff.solverVersionChange).toEqual({ before: "flow-lu-v1", after: "flow-lu-v2" });
    expect(diff.solverSettingChanges).toEqual([
      { key: "singularTolerance", before: 1e-12, after: 1e-11 },
    ]);
    expect(diff.coefficientChanges).toEqual([]);
  });

  it("captures CyTOF included-channel and coefficient changes together", async () => {
    const root = await baseline("cytof-baseline", cytofScientific());
    const revision = await createCompensationProfileRevision(
      root,
      cytofScientific(["A", "C"], 0.25),
      {
        profileId: "cytof-revision",
        createdAt: "2026-07-17T11:01:00.000Z",
      },
    );
    const diff = diffCompensationProfiles(root, revision);
    expect(diff.includedChannelsAdded).toEqual([]);
    expect(diff.includedChannelsRemoved).toEqual(["B"]);
    expect(diff.coefficientChanges).toEqual([
      {
        sourceChannel: "A",
        receiverChannel: "C",
        before: 0.2,
        after: 0.25,
        delta: 0.04999999999999999,
      },
    ]);
  });

  it("is invariant to independent candidate row/column order before canonicalization", async () => {
    const root = await baseline();
    const shuffled: CompensationProfileHashInput = {
      kind: "flow-spillover",
      method: "matrix-inverse",
      solverVersion: "flow-lu-v1",
      solverSettings: FLOW_SETTINGS,
      matrix: canonicalMatrix(
        {
          sourceChannels: ["B", "A"],
          receiverChannels: ["B", "A"],
          matrix: [
            [1, 0.05],
            [0.125, 1],
          ],
        },
        "flow-spillover",
      ),
    };
    const revision = await createCompensationProfileRevision(root, shuffled, {
      profileId: "shuffled-revision",
      createdAt: "2026-07-17T11:01:00.000Z",
    });
    expect(diffCompensationProfiles(root, revision).coefficientChanges).toMatchObject([
      { sourceChannel: "A", receiverChannel: "B", after: 0.125 },
    ]);
  });

  it("rejects no-ops, ID reuse, chronology errors, kind/method changes, and axis changes", async () => {
    const root = await baseline();
    await expect(
      createCompensationProfileRevision(root, flowScientific(), {
        profileId: "no-op",
        createdAt: "2026-07-17T11:01:00.000Z",
      }),
    ).rejects.toThrow("no scientific changes");
    await expect(
      createCompensationProfileRevision(root, flowScientific(0.2), {
        profileId: root.profileId,
        createdAt: "2026-07-17T11:01:00.000Z",
      }),
    ).rejects.toThrow("differ from its parent");
    await expect(
      createCompensationProfileRevision(root, flowScientific(0.2), {
        profileId: "old-revision",
        createdAt: "2026-07-17T10:59:00.000Z",
      }),
    ).rejects.toThrow("cannot predate");
    await expect(
      createCompensationProfileRevision(root, cytofScientific(), {
        profileId: "wrong-kind",
        createdAt: "2026-07-17T11:01:00.000Z",
      }),
    ).rejects.toThrow("kind or method");
    const changedAxes: CompensationProfileHashInput = {
      ...flowScientific(),
      matrix: canonicalMatrix(
        {
          sourceChannels: ["A", "C"],
          receiverChannels: ["A", "C"],
          matrix: [
            [1, 0.1],
            [0.05, 1],
          ],
        },
        "flow-spillover",
      ),
    };
    await expect(
      createCompensationProfileRevision(root, changedAxes, {
        profileId: "wrong-axes",
        createdAt: "2026-07-17T11:01:00.000Z",
      }),
    ).rejects.toThrow("cannot change the matrix source or receiver axes");
  });

  it("resets the complete scientific payload as a new child without mutating history", async () => {
    const root = await baseline("reset-baseline", cytofScientific());
    const edited = await createCompensationProfileRevision(
      root,
      {
        ...cytofScientific(["A", "C"], 0.25),
        solverVersion: "lawson-hanson-v2",
        solverSettings: { ...NNLS_SETTINGS, tolerance: 1e-8 },
      } as CompensationProfileHashInput,
      {
        profileId: "edited",
        createdAt: "2026-07-17T11:01:00.000Z",
      },
    );
    const reset = await createResetToBaselineRevision(edited, root, {
      profileId: "reset-1",
      name: "Reset to baseline",
      createdAt: "2026-07-17T11:02:00.000Z",
      note: "Audited reset",
    });
    expect(reset).toMatchObject({
      recordType: "revision",
      revisionReason: "reset-to-baseline",
      parentProfileId: "edited",
      baselineProfileId: "reset-baseline",
      matrixHash: root.matrixHash,
      profileHash: root.profileHash,
    });
    expect(reset.scientific).toEqual(root.scientific);
    expect(edited.profileHash).not.toBe(root.profileHash);
    const inverse = diffCompensationProfiles(edited, reset);
    expect(inverse.includedChannelsAdded).toEqual(["B"]);
    expect(inverse.solverVersionChange).toEqual({
      before: "lawson-hanson-v2",
      after: "lawson-hanson-v1",
    });
    await expect(validateCompensationProfileRecord(reset)).resolves.toEqual(reset);
  });

  it("rejects an already-baseline reset, the wrong baseline, and changed lineage provenance", async () => {
    const root = await baseline();
    await expect(
      createResetToBaselineRevision(root, root, {
        profileId: "unneeded-reset",
        createdAt: "2026-07-17T11:01:00.000Z",
      }),
    ).rejects.toThrow("already at its baseline");

    const edited = await createCompensationProfileRevision(root, flowScientific(0.2), {
      profileId: "edited-for-reset",
      createdAt: "2026-07-17T11:01:00.000Z",
    });
    const otherRoot = await baseline("other-baseline");
    await expect(
      createResetToBaselineRevision(edited, otherRoot, {
        profileId: "wrong-reset",
        createdAt: "2026-07-17T11:02:00.000Z",
      }),
    ).rejects.toThrow("does not match");

    const changedOrigin = {
      ...edited,
      origin: uploadedOrigin({ fileName: "different.csv" }),
    } as CompensationProfileRecord;
    await expect(
      createResetToBaselineRevision(changedOrigin, root, {
        profileId: "origin-reset",
        createdAt: "2026-07-17T11:02:00.000Z",
      }),
    ).rejects.toThrow("origin/provenance");

    const predatingCurrent = {
      ...edited,
      createdAt: "2000-01-01T00:00:00.000Z",
    } as CompensationProfileRecord;
    await expect(
      createResetToBaselineRevision(predatingCurrent, root, {
        profileId: "predating-reset",
        createdAt: "2000-01-01T00:01:00.000Z",
      }),
    ).rejects.toThrow("cannot predate its baseline");
  });

  it("rejects diffs across lineages or incompatible axes", async () => {
    const first = await baseline("lineage-a");
    const second = await baseline("lineage-b");
    expect(() => diffCompensationProfiles(first, second)).toThrow("different lineages");
    const forged = {
      ...first,
      scientific: { ...first.scientific, matrix: cytofScientific().matrix },
    } as unknown as CompensationProfileRecord;
    expect(() => diffCompensationProfiles(first, forged)).toThrow("incompatible");
  });

  it("does not treat a reused baseline ID as sufficient lineage identity", async () => {
    const first = await baseline("colliding-baseline", flowScientific());
    const changedScience = await baseline("colliding-baseline", flowScientific(0.2));
    expect(() => diffCompensationProfiles(first, changedScience)).toThrow(
      "different lineages",
    );

    const changedOrigin = await baseline("colliding-baseline", flowScientific(), {
      origin: uploadedOrigin({ fileName: "other-source.csv" }),
    });
    expect(() => diffCompensationProfiles(first, changedOrigin)).toThrow(
      "different lineages",
    );
  });
});

describe("strict compensation profile record deserialization", () => {
  it("rejects extra and missing top-level fields and future schemas", async () => {
    const record = await baseline();
    await expect(
      validateCompensationProfileRecord({ ...record, surprise: true }),
    ).rejects.toThrow("unexpected field");
    const missing = { ...record } as Record<string, unknown>;
    delete missing.note;
    await expect(validateCompensationProfileRecord(missing)).rejects.toThrow("missing required");
    await expect(
      validateCompensationProfileRecord({ ...record, schema: "gatelab.compensation-profile-record.v2" }),
    ).rejects.toThrow("Unsupported");
  });

  it("rejects noncanonical persisted names, timestamps, origin, and provenance", async () => {
    const record = await baseline("strict-record", flowScientific(), {
      provenance: { instrument: "CyTOF" },
    });
    await expect(
      validateCompensationProfileRecord({ ...record, name: " Baseline matrix " }),
    ).rejects.toThrow("not canonical");
    await expect(
      validateCompensationProfileRecord({ ...record, createdAt: "2026-07-17T20:00:00+09:00" }),
    ).rejects.toThrow("canonical UTC");
    await expect(
      validateCompensationProfileRecord({
        ...record,
        origin: { ...record.origin, fileDigest: undefined },
      }),
    ).rejects.toThrow("origin is not canonical");
    await expect(
      validateCompensationProfileRecord({
        ...record,
        provenance: { instrument: " CyTOF " },
      }),
    ).rejects.toThrow("provenance is not canonical");
  });

  it("rejects malformed or mismatched matrix/profile hashes", async () => {
    const record = await baseline();
    await expect(
      validateCompensationProfileRecord({ ...record, matrixHash: DIGEST_A }),
    ).rejects.toThrow("does not match the matrix");
    await expect(
      validateCompensationProfileRecord({ ...record, profileHash: DIGEST_B }),
    ).rejects.toThrow("does not match the scientific");
    await expect(
      validateCompensationProfileRecord({
        ...record,
        matrixHash: `sha256:${"A".repeat(64)}`,
      }),
    ).rejects.toThrow("lowercase");
  });

  it("rejects tampered and noncanonical nested scientific state", async () => {
    const record = await baseline("nested-record", cytofScientific());
    const tamperedMatrix = record.scientific.matrix.matrix.map((row) => [...row]);
    tamperedMatrix[0][1] = 0.2;
    await expect(
      validateCompensationProfileRecord({
        ...record,
        scientific: {
          ...record.scientific,
          matrix: { ...record.scientific.matrix, matrix: tamperedMatrix },
        },
      }),
    ).rejects.toThrow("matrixHash does not match");

    await expect(
      validateCompensationProfileRecord({
        ...record,
        scientific: {
          ...record.scientific,
          includedChannels: ["C", "B", "A"],
        },
      }),
    ).rejects.toThrow("not canonical");

    await expect(
      validateCompensationProfileRecord({
        ...record,
        scientific: {
          ...record.scientific,
          solverSettings: [...record.scientific.solverSettings].reverse(),
        },
      }),
    ).rejects.toThrow("not canonical");

    await expect(
      validateCompensationProfileRecord({
        ...record,
        scientific: { ...record.scientific, unexpected: true },
      }),
    ).rejects.toThrow("unexpected field");
  });

  it("enforces baseline and revision lineage invariants that are locally provable", async () => {
    const root = await baseline();
    await expect(
      validateCompensationProfileRecord({ ...root, parentProfileId: "parent" }),
    ).rejects.toThrow("baseline profile must have null");
    await expect(
      validateCompensationProfileRecord({ ...root, baselineProfileId: "other" }),
    ).rejects.toThrow("identify its own");

    const revision = await createCompensationProfileRevision(root, flowScientific(0.2), {
      profileId: "strict-revision",
      createdAt: "2026-07-17T11:01:00.000Z",
    });
    await expect(
      validateCompensationProfileRecord({ ...revision, parentProfileId: revision.profileId }),
    ).rejects.toThrow("differ from its parent");
    await expect(
      validateCompensationProfileRecord({ ...revision, revisionReason: "unknown" }),
    ).rejects.toThrow("must declare");
    await expect(
      validateCompensationProfileRecord({
        ...revision,
        revisionReason: "reset-to-baseline",
      }),
    ).rejects.toThrow("restore the complete baseline");
  });
});
