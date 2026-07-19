import { describe, expect, it } from "vitest";
import {
  createCompensationBaselineProfile,
  createCompensationProfileRevision,
  type BaselineCompensationProfileRecord,
  type CompensationProfileRecord,
} from "./compensationProfileRecord";
import {
  validateAndCanonicalizeCompensationMatrix,
  type CanonicalCompensationMatrix,
  type CompensationKind,
  type CompensationMatrixInput,
  type CompensationProfileHashInput,
} from "./compensationProfile";
import {
  SAMPLE_ASSAY_BINDING_SCHEMA,
  WORKSPACE_COMPENSATION_SCHEMA,
  WorkspaceCompensationValidationError,
  createOriginalSampleAssayBinding,
  migrateLegacySampleAssayBinding,
  validateSampleAssayBinding,
  validateWorkspaceCompensationState,
  type PersistedCompensatedLayerBinding,
  type SampleAssayBinding,
  type ValidatedWorkspaceCompensationState,
  type WorkspaceCompensationValidationCode,
} from "./workspaceCompensation";

const CREATED = "2026-07-17T11:00:00.000Z";
const EDITED = "2026-07-17T11:01:00.000Z";
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

function canonicalMatrix(
  input: CompensationMatrixInput,
  kind: CompensationKind,
): CanonicalCompensationMatrix {
  const result = validateAndCanonicalizeCompensationMatrix(input, kind);
  if (!result.ok) throw new Error(result.errors.map(({ message }) => message).join(" "));
  return result.value;
}

function flowScientific(ab = 0.1): CompensationProfileHashInput {
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
          [0.05, 1],
        ],
      },
      "flow-spillover",
    ),
  };
}

function cytofScientific(
  includedChannels: readonly string[] = ["A", "C"],
  ac = 0.2,
): CompensationProfileHashInput {
  return {
    kind: "cytof-spillover",
    method: "nnls",
    solverVersion: "coordinate-descent-qr-v1",
    solverSettings: NNLS_SETTINGS,
    matrix: canonicalMatrix(
      {
        sourceChannels: ["A", "B"],
        receiverChannels: ["A", "B", "C", "D"],
        matrix: [
          [1, 0.1, ac, 0.04],
          [0.05, 1, 0.3, 0.02],
        ],
      },
      "cytof-spillover",
    ),
    includedChannels,
  };
}

async function baseline(
  profileId: string,
  scientific: CompensationProfileHashInput,
): Promise<BaselineCompensationProfileRecord> {
  return createCompensationBaselineProfile(scientific, {
    profileId,
    name: `${profileId} profile`,
    createdAt: CREATED,
    origin: {
      type: "uploaded",
      fileName: `${profileId}.csv`,
      format: "csv",
      sourceColumnHeader: "channel",
    },
  });
}

async function revision(
  parent: CompensationProfileRecord,
  profileId: string,
  scientific: CompensationProfileHashInput,
): Promise<CompensationProfileRecord> {
  return createCompensationProfileRevision(parent, scientific, {
    profileId,
    createdAt: EDITED,
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function expectWorkspaceError(
  action: Promise<unknown> | (() => unknown),
  code: WorkspaceCompensationValidationCode,
): Promise<WorkspaceCompensationValidationError> {
  try {
    if (typeof action === "function") action();
    else await action;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceCompensationValidationError);
    const workspaceError = error as WorkspaceCompensationValidationError;
    expect(workspaceError.code).toBe(code);
    return workspaceError;
  }
  throw new Error(`Expected workspace compensation error ${code}.`);
}

async function workspaceFor(
  ...records: readonly CompensationProfileRecord[]
): Promise<ValidatedWorkspaceCompensationState> {
  const lineages = records.map((record) => ({
    baselineProfileId: record.baselineProfileId,
    records: [record],
  }));
  return validateWorkspaceCompensationState({
    schema: WORKSPACE_COMPENSATION_SCHEMA,
    lineages,
  });
}

function flowLayer(
  profile: CompensationProfileRecord,
  overrides: Partial<PersistedCompensatedLayerBinding> = {},
): PersistedCompensatedLayerBinding {
  return {
    profileId: profile.profileId,
    profileHash: profile.profileHash,
    matrixHash: profile.matrixHash,
    kind: "flow-spillover",
    method: "matrix-inverse",
    includedPnns: ["A", "B"],
    channelBindings: [
      {
        pnn: "A",
        fcsColumnIndex: 4,
        matrixSourceIndex: 0,
        matrixReceiverIndex: 0,
        included: true,
      },
      {
        pnn: "B",
        fcsColumnIndex: 7,
        matrixSourceIndex: 1,
        matrixReceiverIndex: 1,
        included: true,
      },
    ],
    transformBinding: { kind: "flow-linear" },
    ...overrides,
  };
}

function cytofLayer(
  profile: CompensationProfileRecord,
  overrides: Partial<PersistedCompensatedLayerBinding> = {},
): PersistedCompensatedLayerBinding {
  return {
    profileId: profile.profileId,
    profileHash: profile.profileHash,
    matrixHash: profile.matrixHash,
    kind: "cytof-spillover",
    method: "nnls",
    includedPnns: ["A", "C"],
    channelBindings: [
      {
        pnn: "A",
        fcsColumnIndex: 3,
        matrixSourceIndex: 0,
        matrixReceiverIndex: 0,
        included: true,
      },
      {
        pnn: "B",
        fcsColumnIndex: 5,
        matrixSourceIndex: 1,
        matrixReceiverIndex: 1,
        included: false,
      },
      {
        pnn: "C",
        fcsColumnIndex: 8,
        matrixSourceIndex: null,
        matrixReceiverIndex: 2,
        included: true,
      },
      {
        pnn: "D",
        fcsColumnIndex: 9,
        matrixSourceIndex: null,
        matrixReceiverIndex: 3,
        included: false,
      },
    ],
    transformBinding: { kind: "cytof-asinh", cofactor: 5 },
    ...overrides,
  };
}

function assay(
  layer: PersistedCompensatedLayerBinding | null,
  activeLayer: "original" | "compensated" = "compensated",
): SampleAssayBinding {
  return {
    schema: SAMPLE_ASSAY_BINDING_SCHEMA,
    activeLayer,
    compensatedLayer: layer,
  };
}

const FLOW_SAMPLE_CHANNELS = Object.freeze([
  Object.freeze({ pnn: "A", columnIndex: 4 }),
  Object.freeze({ pnn: "B", columnIndex: 7 }),
]);
const CYTOF_SAMPLE_CHANNELS = Object.freeze([
  Object.freeze({ pnn: "A", columnIndex: 3 }),
  Object.freeze({ pnn: "B", columnIndex: 5 }),
  Object.freeze({ pnn: "C", columnIndex: 8 }),
  Object.freeze({ pnn: "D", columnIndex: 9 }),
]);

function flowContext(
  sampleChannels: readonly { readonly pnn: string; readonly columnIndex: number }[] =
    FLOW_SAMPLE_CHANNELS,
) {
  return { sampleChannels, instrumentKind: "flow" as const };
}

function cytofContext(
  sampleChannels: readonly { readonly pnn: string; readonly columnIndex: number }[] =
    CYTOF_SAMPLE_CHANNELS,
  expectedCytofCofactor = 5,
) {
  return { sampleChannels, instrumentKind: "cytof" as const, expectedCytofCofactor };
}

describe("workspace compensation histories", () => {
  it("accepts an empty state and round-trips canonically and idempotently", async () => {
    const input = { schema: WORKSPACE_COMPENSATION_SCHEMA, lineages: [] };
    const first = await validateWorkspaceCompensationState(input);
    const second = await validateWorkspaceCompensationState(first);

    expect(first).toEqual(input);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.lineages)).toBe(true);
  });

  it("validates multiple flow and CyTOF lineages and sorts histories deterministically", async () => {
    const flowRoot = await baseline("z-flow", flowScientific());
    const flowEdit = await revision(flowRoot, "z-flow-edit", flowScientific(0.2));
    const cytofRoot = await baseline("a-cytof", cytofScientific());
    const cytofEdit = await revision(cytofRoot, "a-cytof-edit", cytofScientific(["A", "C"], 0.25));
    const input = {
      schema: WORKSPACE_COMPENSATION_SCHEMA,
      lineages: [
        { baselineProfileId: "z-flow", records: [flowEdit, flowRoot] },
        { baselineProfileId: "a-cytof", records: [cytofEdit, cytofRoot] },
      ],
    };
    const snapshot = clone(input);

    const result = await validateWorkspaceCompensationState(input);

    expect(result.lineages.map(({ baselineProfileId }) => baselineProfileId)).toEqual([
      "a-cytof",
      "z-flow",
    ]);
    expect(result.lineages[0].records.map(({ profileId }) => profileId)).toEqual([
      "a-cytof",
      "a-cytof-edit",
    ]);
    expect(result.lineages[1].records.map(({ profileId }) => profileId)).toEqual([
      "z-flow",
      "z-flow-edit",
    ]);
    expect(input).toEqual(snapshot);
    expect(Object.isFrozen(result.lineages)).toBe(true);
    expect(Object.isFrozen(result.lineages[0])).toBe(true);
    expect(Object.isFrozen(result.lineages[0].records)).toBe(true);
    expect(Object.isFrozen(result.lineages[0].records[0].scientific.matrix.matrix[0])).toBe(true);
  });

  it.each([null, [], "state", 42])("rejects non-object compensation state %#", async (value) => {
    await expectWorkspaceError(
      validateWorkspaceCompensationState(value),
      "invalid-compensation-state",
    );
  });

  it.each([
    {},
    { schema: WORKSPACE_COMPENSATION_SCHEMA },
    { lineages: [] },
    { schema: WORKSPACE_COMPENSATION_SCHEMA, lineages: [], extra: true },
    { schema: WORKSPACE_COMPENSATION_SCHEMA, lineages: "not-an-array" },
  ])("rejects malformed state shape %#", async (value) => {
    await expectWorkspaceError(
      validateWorkspaceCompensationState(value),
      "invalid-compensation-state",
    );
  });

  it("rejects sparse lineage arrays", async () => {
    const lineages = new Array<unknown>(2);
    lineages[1] = {};
    await expectWorkspaceError(
      validateWorkspaceCompensationState({ schema: WORKSPACE_COMPENSATION_SCHEMA, lineages }),
      "invalid-compensation-state",
    );
  });

  it("rejects future workspace schemas explicitly", async () => {
    const error = await expectWorkspaceError(
      validateWorkspaceCompensationState({
        schema: "gatelab.workspace-compensation.v2",
        lineages: [],
      }),
      "unsupported-compensation-schema",
    );
    expect(error.message).toContain("v2");
  });

  it.each([
    null,
    [],
    {},
    { baselineProfileId: "root", records: [], extra: true },
    { baselineProfileId: 1, records: [] },
    { baselineProfileId: "root", records: "not-an-array" },
  ])("rejects malformed lineage entries %#", async (entry) => {
    const error = await expectWorkspaceError(
      validateWorkspaceCompensationState({
        schema: WORKSPACE_COMPENSATION_SCHEMA,
        lineages: [entry],
      }),
      "invalid-lineage-entry",
    );
    expect(error.lineageIndex).toBe(0);
  });

  it("wraps invalid lineage histories with their index and original cause", async () => {
    const root = await baseline("root", flowScientific());
    const error = await expectWorkspaceError(
      validateWorkspaceCompensationState({
        schema: WORKSPACE_COMPENSATION_SCHEMA,
        lineages: [{ baselineProfileId: "root", records: [{ ...root, extra: true }] }],
      }),
      "invalid-lineage-entry",
    );
    expect(error.lineageIndex).toBe(0);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("rejects a lineage whose declared baseline does not match its records", async () => {
    const root = await baseline("actual-root", flowScientific());
    const error = await expectWorkspaceError(
      validateWorkspaceCompensationState({
        schema: WORKSPACE_COMPENSATION_SCHEMA,
        lineages: [{ baselineProfileId: "declared-root", records: [root] }],
      }),
      "lineage-baseline-mismatch",
    );
    expect(error.profileId).toBe("actual-root");
    expect(error.lineageIndex).toBe(0);
  });

  it("rejects profile IDs reused globally across independently valid lineages", async () => {
    const firstRoot = await baseline("first-root", flowScientific());
    const firstEdit = await revision(firstRoot, "shared-edit", flowScientific(0.2));
    const secondRoot = await baseline("second-root", flowScientific());
    const secondEdit = await revision(secondRoot, "shared-edit", flowScientific(0.3));
    const error = await expectWorkspaceError(
      validateWorkspaceCompensationState({
        schema: WORKSPACE_COMPENSATION_SCHEMA,
        lineages: [
          { baselineProfileId: firstRoot.profileId, records: [firstRoot, firstEdit] },
          { baselineProfileId: secondRoot.profileId, records: [secondRoot, secondEdit] },
        ],
      }),
      "duplicate-global-profile-id",
    );
    expect(error.profileId).toBe("shared-edit");
  });
});

describe("original and legacy sample assay bindings", () => {
  it("creates and validates a deeply immutable Original binding", async () => {
    const compensation = await validateWorkspaceCompensationState({
      schema: WORKSPACE_COMPENSATION_SCHEMA,
      lineages: [],
    });
    const created = createOriginalSampleAssayBinding();
    const validated = validateSampleAssayBinding(clone(created), compensation);

    expect(created).toEqual({
      schema: SAMPLE_ASSAY_BINDING_SCHEMA,
      activeLayer: "original",
      compensatedLayer: null,
    });
    expect(validated).toEqual(created);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(validated)).toBe(true);
  });

  it("migrates only an explicit legacy false and rejects true or ambiguous flags", async () => {
    expect(migrateLegacySampleAssayBinding(false)).toEqual(createOriginalSampleAssayBinding());
    const trueError = await expectWorkspaceError(
      () => migrateLegacySampleAssayBinding(true),
      "legacy-compensated-workspace",
    );
    expect(trueError.message).toContain("FCS-assisted migration");
    for (const invalid of [undefined, null, 0, "false"]) {
      await expectWorkspaceError(
        () => migrateLegacySampleAssayBinding(invalid),
        "legacy-compensated-workspace",
      );
    }
  });

  it("rejects malformed and unsupported assay bindings", async () => {
    const compensation = await validateWorkspaceCompensationState({
      schema: WORKSPACE_COMPENSATION_SCHEMA,
      lineages: [],
    });
    for (const invalid of [null, [], "binding", {}, {
      schema: SAMPLE_ASSAY_BINDING_SCHEMA,
      activeLayer: "original",
      compensatedLayer: null,
      extra: true,
    }]) {
      await expectWorkspaceError(
        () => validateSampleAssayBinding(invalid, compensation),
        "invalid-assay-binding",
      );
    }
    await expectWorkspaceError(
      () => validateSampleAssayBinding({
        schema: "gatelab.sample-assay-binding.v2",
        activeLayer: "original",
        compensatedLayer: null,
      }, compensation),
      "unsupported-assay-schema",
    );
    await expectWorkspaceError(
      () => validateSampleAssayBinding({
        schema: SAMPLE_ASSAY_BINDING_SCHEMA,
        activeLayer: "raw",
        compensatedLayer: null,
      }, compensation),
      "invalid-assay-binding",
    );
  });

  it("rejects Compensated as active when no compensated layer is installed", async () => {
    const compensation = await validateWorkspaceCompensationState({
      schema: WORKSPACE_COMPENSATION_SCHEMA,
      lineages: [],
    });
    await expectWorkspaceError(
      () => validateSampleAssayBinding(assay(null), compensation),
      "active-layer-missing",
    );
  });
});

describe("valid persisted compensated layer bindings", () => {
  it("validates an exact flow binding", async () => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    const result = validateSampleAssayBinding(
      assay(flowLayer(profile)),
      compensation,
      flowContext(),
    );

    expect(result.activeLayer).toBe("compensated");
    expect(result.compensatedLayer).toEqual(flowLayer(profile));
    expect(Object.isFrozen(result.compensatedLayer)).toBe(true);
    expect(Object.isFrozen(result.compensatedLayer?.includedPnns)).toBe(true);
    expect(Object.isFrozen(result.compensatedLayer?.channelBindings)).toBe(true);
    expect(Object.isFrozen(result.compensatedLayer?.channelBindings[0])).toBe(true);
    expect(Object.isFrozen(result.compensatedLayer?.transformBinding)).toBe(true);
  });

  it("canonicalizes signed-zero integer indices and remains idempotent on round-trip", async () => {
    const profile = await baseline("flow-zero", flowScientific());
    const compensation = await workspaceFor(profile);
    const bindings = [
      {
        pnn: "A",
        fcsColumnIndex: -0,
        matrixSourceIndex: -0,
        matrixReceiverIndex: -0,
        included: true,
      },
      flowLayer(profile).channelBindings[1],
    ];
    const input = assay(flowLayer(profile, { channelBindings: bindings }));
    const context = flowContext([
      { pnn: "A", columnIndex: -0 },
      { pnn: "B", columnIndex: 7 },
    ]);

    const first = validateSampleAssayBinding(input, compensation, context);
    const second = validateSampleAssayBinding(first, compensation, context);
    const canonical = first.compensatedLayer?.channelBindings[0];

    expect(second).toEqual(first);
    expect(canonical).toEqual({
      pnn: "A",
      fcsColumnIndex: 0,
      matrixSourceIndex: 0,
      matrixReceiverIndex: 0,
      included: true,
    });
    expect(Object.is(canonical?.fcsColumnIndex, -0)).toBe(false);
    expect(Object.is(canonical?.matrixSourceIndex, -0)).toBe(false);
    expect(Object.is(canonical?.matrixReceiverIndex, -0)).toBe(false);
    expect(Object.is(input.compensatedLayer?.channelBindings[0].fcsColumnIndex, -0)).toBe(true);
  });

  it("allows Original to remain active while retaining an installed compensated layer", async () => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    const result = validateSampleAssayBinding(
      assay(flowLayer(profile), "original"),
      compensation,
      flowContext(),
    );

    expect(result.activeLayer).toBe("original");
    expect(result.compensatedLayer?.profileId).toBe("flow");
  });

  it("validates rectangular CyTOF receiver-only bindings and explicit excluded mappings", async () => {
    const profile = await baseline("cytof", cytofScientific());
    const compensation = await workspaceFor(profile);
    const result = validateSampleAssayBinding(
      assay(cytofLayer(profile)),
      compensation,
      cytofContext(),
    );

    expect(result.compensatedLayer?.channelBindings).toEqual([
      expect.objectContaining({ pnn: "A", matrixSourceIndex: 0, included: true }),
      expect.objectContaining({ pnn: "B", matrixSourceIndex: 1, included: false }),
      expect.objectContaining({ pnn: "C", matrixSourceIndex: null, included: true }),
      expect.objectContaining({ pnn: "D", matrixSourceIndex: null, included: false }),
    ]);
  });

  it("permits excluded receiver mappings to be omitted but requires every included channel", async () => {
    const profile = await baseline("cytof", cytofScientific());
    const compensation = await workspaceFor(profile);
    const complete = cytofLayer(profile);
    const includedOnly = complete.channelBindings.filter(({ included }) => included);
    const result = validateSampleAssayBinding(
      assay(cytofLayer(profile, { channelBindings: includedOnly })),
      compensation,
      cytofContext([
        { pnn: "A", columnIndex: 3 },
        { pnn: "C", columnIndex: 8 },
      ]),
    );

    expect(result.compensatedLayer?.channelBindings.map(({ pnn }) => pnn)).toEqual(["A", "C"]);
  });
});

describe("parsed sample verification for retained compensated layers", () => {
  it.each([
    ["all context", {}],
    ["sample channels", { instrumentKind: "flow" as const }],
    ["instrument kind", { sampleChannels: FLOW_SAMPLE_CHANNELS }],
  ])("rejects a retained flow layer missing %s", async (_label, context) => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    await expectWorkspaceError(
      () => validateSampleAssayBinding(assay(flowLayer(profile)), compensation, context),
      "sample-context-required",
    );
  });

  it("requires an explicit effective cofactor when restoring CyTOF compensation", async () => {
    const profile = await baseline("cytof", cytofScientific());
    const compensation = await workspaceFor(profile);
    await expectWorkspaceError(
      () => validateSampleAssayBinding(assay(cytofLayer(profile)), compensation, {
        sampleChannels: CYTOF_SAMPLE_CHANNELS,
        instrumentKind: "cytof",
      }),
      "sample-context-required",
    );
  });

  it.each([
    ["flow profile on CyTOF sample", "flow", flowScientific(), flowLayer, "cytof"],
    ["CyTOF profile on flow sample", "cytof", cytofScientific(), cytofLayer, "flow"],
  ] as const)(
    "rejects %s",
    async (_label, profileId, scientific, layerFactory, instrumentKind) => {
      const profile = await baseline(profileId, scientific);
      const compensation = await workspaceFor(profile);
      await expectWorkspaceError(
        () => validateSampleAssayBinding(
          assay(layerFactory(profile)),
          compensation,
          {
            sampleChannels: instrumentKind === "flow"
              ? FLOW_SAMPLE_CHANNELS
              : CYTOF_SAMPLE_CHANNELS,
            instrumentKind,
            expectedCytofCofactor: 5,
          },
        ),
        "sample-kind-mismatch",
      );
    },
  );

  it.each([
    ["missing a required flow channel", [{ pnn: "A", columnIndex: 4 }]],
    ["duplicating a parsed PnN", [
      { pnn: "A", columnIndex: 4 },
      { pnn: "A", columnIndex: 7 },
    ]],
  ])("rejects an incompatible parsed sample: %s", async (_label, sampleChannels) => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    const error = await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(flowLayer(profile)),
        compensation,
        flowContext(sampleChannels),
      ),
      "sample-mapping-incompatible",
    );
    expect(error.profileId).toBe("flow");
  });

  it.each([
    ["swapped FCS indices", [
      { pnn: "A", columnIndex: 7 },
      { pnn: "B", columnIndex: 4 },
    ]],
    ["an arbitrary FCS index", [
      { pnn: "A", columnIndex: 99 },
      { pnn: "B", columnIndex: 7 },
    ]],
  ])("rejects persisted flow bindings against %s", async (_label, sampleChannels) => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(flowLayer(profile)),
        compensation,
        flowContext(sampleChannels),
      ),
      "persisted-mapping-mismatch",
    );
  });

  it("rejects omission of an excluded CyTOF receiver that is matched in the parsed FCS", async () => {
    const profile = await baseline("cytof", cytofScientific());
    const compensation = await workspaceFor(profile);
    const includedOnly = cytofLayer(profile).channelBindings.filter(({ included }) => included);
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(cytofLayer(profile, { channelBindings: includedOnly })),
        compensation,
        cytofContext(),
      ),
      "persisted-mapping-mismatch",
    );
  });
});

describe("profile identity and included-channel binding failures", () => {
  it("rejects a missing profile", async () => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await validateWorkspaceCompensationState({
      schema: WORKSPACE_COMPENSATION_SCHEMA,
      lineages: [],
    });
    const error = await expectWorkspaceError(
      () => validateSampleAssayBinding(assay(flowLayer(profile)), compensation),
      "missing-profile",
    );
    expect(error.profileId).toBe("flow");
  });

  it.each([
    ["profileHash", `sha256:${"a".repeat(64)}`],
    ["matrixHash", `sha256:${"b".repeat(64)}`],
    ["kind", "cytof-spillover"],
    ["method", "nnls"],
  ] as const)("rejects a wrong persisted %s", async (field, value) => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(flowLayer(profile, { [field]: value })),
        compensation,
      ),
      "profile-identity-mismatch",
    );
  });

  it.each([
    ["missing", ["A"]],
    ["extra", ["A", "B", "C"]],
    ["reordered", ["B", "A"]],
    ["duplicate", ["A", "A"]],
    ["non-string", ["A", 2]],
  ])("rejects %s includedPnns", async (_label, includedPnns) => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(flowLayer(profile, { includedPnns: includedPnns as string[] })),
        compensation,
      ),
      "included-channels-mismatch",
    );
  });

  it("rejects sparse includedPnns", async () => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    const includedPnns = new Array<string>(2);
    includedPnns[0] = "A";
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(flowLayer(profile, { includedPnns })),
        compensation,
      ),
      "included-channels-mismatch",
    );
  });
});

describe("channel binding validation", () => {
  it.each([
    ["not-array", "bindings"],
    ["non-object", [null]],
    ["missing-field", [{ pnn: "A" }]],
    ["extra-field", [{
      pnn: "A",
      fcsColumnIndex: 4,
      matrixSourceIndex: 0,
      matrixReceiverIndex: 0,
      included: true,
      extra: true,
    }]],
    ["invalid-types", [{
      pnn: "A",
      fcsColumnIndex: -1,
      matrixSourceIndex: 0,
      matrixReceiverIndex: 0,
      included: true,
    }]],
  ])("rejects %s channelBindings", async (_label, channelBindings) => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(flowLayer(profile, { channelBindings: channelBindings as never })),
        compensation,
        flowContext(),
      ),
      "invalid-channel-binding",
    );
  });

  it("rejects sparse channelBindings", async () => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    const bindings = new Array<unknown>(2);
    bindings[1] = flowLayer(profile).channelBindings[1];
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(flowLayer(profile, { channelBindings: bindings as never })),
        compensation,
        flowContext(),
      ),
      "invalid-channel-binding",
    );
  });

  it.each([
    ["PnN", { pnn: "A", fcsColumnIndex: 8, matrixSourceIndex: 1, matrixReceiverIndex: 1, included: true }],
    ["FCS column", { pnn: "B", fcsColumnIndex: 4, matrixSourceIndex: 1, matrixReceiverIndex: 1, included: true }],
    ["receiver", { pnn: "A", fcsColumnIndex: 8, matrixSourceIndex: 0, matrixReceiverIndex: 0, included: true }],
  ])("rejects duplicate %s bindings", async (_label, replacement) => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    const bindings = [flowLayer(profile).channelBindings[0], replacement];
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(flowLayer(profile, { channelBindings: bindings })),
        compensation,
        flowContext(),
      ),
      "invalid-channel-binding",
    );
  });

  it("rejects out-of-order receiver bindings", async () => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(flowLayer(profile, {
          channelBindings: Array.from(flowLayer(profile).channelBindings).reverse(),
        })),
        compensation,
        flowContext(),
      ),
      "invalid-channel-binding",
    );
  });

  it("rejects an incomplete binding for included channels", async () => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(flowLayer(profile, {
          channelBindings: [flowLayer(profile).channelBindings[0]],
        })),
        compensation,
        flowContext(),
      ),
      "incomplete-included-binding",
    );
  });

  it.each([
    ["receiver PnN", { pnn: "B", fcsColumnIndex: 4, matrixSourceIndex: 0, matrixReceiverIndex: 0, included: true }],
    ["source index", { pnn: "A", fcsColumnIndex: 4, matrixSourceIndex: 1, matrixReceiverIndex: 0, included: true }],
    ["included flag", { pnn: "A", fcsColumnIndex: 4, matrixSourceIndex: 0, matrixReceiverIndex: 0, included: false }],
    ["flow null source", { pnn: "A", fcsColumnIndex: 4, matrixSourceIndex: null, matrixReceiverIndex: 0, included: true }],
  ])("rejects a %s mismatch", async (_label, firstBinding) => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(flowLayer(profile, {
          channelBindings: [firstBinding, flowLayer(profile).channelBindings[1]],
        })),
        compensation,
        flowContext(),
      ),
      "invalid-channel-binding",
    );
  });

  it("rejects a CyTOF receiver-only binding with a forged source index", async () => {
    const profile = await baseline("cytof", cytofScientific());
    const compensation = await workspaceFor(profile);
    const bindings = Array.from(cytofLayer(profile).channelBindings);
    bindings[2] = { ...bindings[2], matrixSourceIndex: 0 };
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(cytofLayer(profile, { channelBindings: bindings })),
        compensation,
        cytofContext(),
      ),
      "invalid-channel-binding",
    );
  });
});

describe("transform binding validation", () => {
  it.each([
    ["CyTOF kind", { kind: "cytof-asinh", cofactor: 5 }],
    ["extra field", { kind: "flow-linear", cofactor: 5 }],
    ["unknown kind", { kind: "linear" }],
    ["not object", "flow-linear"],
  ])("rejects flow transform with %s", async (_label, transformBinding) => {
    const profile = await baseline("flow", flowScientific());
    const compensation = await workspaceFor(profile);
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(flowLayer(profile, { transformBinding: transformBinding as never })),
        compensation,
        flowContext(),
      ),
      "transform-mismatch",
    );
  });

  it.each([
    ["flow kind", { kind: "flow-linear" }],
    ["zero", { kind: "cytof-asinh", cofactor: 0 }],
    ["negative", { kind: "cytof-asinh", cofactor: -5 }],
    ["infinite", { kind: "cytof-asinh", cofactor: Number.POSITIVE_INFINITY }],
    ["missing cofactor", { kind: "cytof-asinh" }],
    ["extra field", { kind: "cytof-asinh", cofactor: 5, extra: true }],
  ])("rejects CyTOF transform with %s", async (_label, transformBinding) => {
    const profile = await baseline("cytof", cytofScientific());
    const compensation = await workspaceFor(profile);
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(cytofLayer(profile, { transformBinding: transformBinding as never })),
        compensation,
        cytofContext(),
      ),
      "transform-mismatch",
    );
  });

  it("requires the persisted CyTOF cofactor to match sample context exactly", async () => {
    const profile = await baseline("cytof", cytofScientific());
    const compensation = await workspaceFor(profile);
    await expectWorkspaceError(
      () => validateSampleAssayBinding(
        assay(cytofLayer(profile)),
        compensation,
        cytofContext(CYTOF_SAMPLE_CHANNELS, 6),
      ),
      "transform-mismatch",
    );
    expect(
      validateSampleAssayBinding(
        assay(cytofLayer(profile)),
        compensation,
        cytofContext(),
      ).compensatedLayer
        ?.transformBinding,
    ).toEqual({ kind: "cytof-asinh", cofactor: 5 });
  });
});

describe("workspace compensation copy and immutability boundaries", () => {
  it("does not mutate inputs and returns detached deeply immutable histories and bindings", async () => {
    const root = await baseline("flow", flowScientific());
    const workspaceInput = clone({
      schema: WORKSPACE_COMPENSATION_SCHEMA,
      lineages: [{ baselineProfileId: root.profileId, records: [root] }],
    });
    const workspaceSnapshot = clone(workspaceInput);
    const compensation = await validateWorkspaceCompensationState(workspaceInput);
    const assayInput = clone(assay(flowLayer(root)));
    const assaySnapshot = clone(assayInput);
    const validatedAssay = validateSampleAssayBinding(
      assayInput,
      compensation,
      flowContext(),
    );

    expect(workspaceInput).toEqual(workspaceSnapshot);
    expect(assayInput).toEqual(assaySnapshot);
    workspaceInput.lineages[0].baselineProfileId = "mutated";
    (workspaceInput.lineages[0].records[0] as { name: string }).name = "mutated";
    (assayInput as { activeLayer: "original" | "compensated" }).activeLayer = "original";
    if (assayInput.compensatedLayer) {
      (assayInput.compensatedLayer.includedPnns as string[])[0] = "mutated";
      (assayInput.compensatedLayer.channelBindings[0] as { pnn: string }).pnn = "mutated";
    }

    expect(compensation.lineages[0].baselineProfileId).toBe("flow");
    expect(compensation.lineages[0].records[0].name).toBe("flow profile");
    expect(validatedAssay.activeLayer).toBe("compensated");
    expect(validatedAssay.compensatedLayer?.includedPnns[0]).toBe("A");
    expect(validatedAssay.compensatedLayer?.channelBindings[0].pnn).toBe("A");
    expect(Object.isFrozen(compensation)).toBe(true);
    expect(Object.isFrozen(compensation.lineages[0].records[0].scientific)).toBe(true);
    expect(Object.isFrozen(validatedAssay)).toBe(true);
    expect(Object.isFrozen(validatedAssay.compensatedLayer)).toBe(true);
    expect(() => {
      (validatedAssay.compensatedLayer?.channelBindings as unknown[]).push({});
    }).toThrow(TypeError);
  });
});
