import { describe, expect, it } from "vitest";
import {
  createCompensationBaselineProfile,
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
  type PersistedCompensatedLayerBinding,
  type SampleAssayBinding,
} from "./workspaceCompensation";
import {
  WORKSPACE_VERSION_3,
  WorkspaceV3ValidationError,
  migrateWorkspaceToV3,
  migrateWorkspaceV2ToV3,
  newEmptyWorkspaceCompensationState,
  newOriginalWorkspaceSampleAssay,
  packWorkspaceV3,
  packWorkspaceV3Reference,
  validateWorkspaceV3,
  type WorkspaceFileV3,
  type WorkspaceV3SampleRestoreContexts,
  type WorkspaceV3ValidationCode,
} from "./workspaceV3";
import {
  readWorkspaceEnvelope,
  WORKSPACE_FORMAT,
  type WorkspaceFile,
  type WorkspaceSample,
} from "./workspace";

const CREATED = "2026-07-17T11:00:00.000Z";
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalMatrix(
  input: CompensationMatrixInput,
  kind: CompensationKind,
): CanonicalCompensationMatrix {
  const result = validateAndCanonicalizeCompensationMatrix(input, kind);
  if (!result.ok) throw new Error(result.errors.map(({ message }) => message).join(" "));
  return result.value;
}

function flowScientific(): CompensationProfileHashInput {
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
          [1, 0.1],
          [0.05, 1],
        ],
      },
      "flow-spillover",
    ),
  };
}

function cytofScientific(): CompensationProfileHashInput {
  return {
    kind: "cytof-spillover",
    method: "nnls",
    solverVersion: "lawson-hanson-v1",
    solverSettings: NNLS_SETTINGS,
    matrix: canonicalMatrix(
      {
        sourceChannels: ["A", "B"],
        receiverChannels: ["A", "B", "C", "D"],
        matrix: [
          [1, 0.1, 0.2, 0.04],
          [0.05, 1, 0.3, 0.02],
        ],
      },
      "cytof-spillover",
    ),
    includedChannels: ["A", "C"],
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

function fullSample(
  overrides: Partial<WorkspaceSample> = {},
): WorkspaceSample {
  return {
    fileName: "sample α.fcs",
    dataPath: "data/0_sample-alpha.fcs",
    logicleW: { A: 0.72, B: 0.55 },
    scatterCofactor: { "FSC-A": 300, "SSC-A": 180 },
    cytofCofactor: 5,
    compensationOn: false,
    instrumentMode: "auto",
    labels: { A: "CD3", B: "CD19" },
    metadata: { donor: "D01", condition: "stim" },
    division: {
      channelKey: "A",
      boundaries: [1.5, 3.25, 7],
      n: 3,
      colName: "A division",
    },
    ...overrides,
  };
}

function workspaceV2(samples: WorkspaceSample[] = [fullSample()]): WorkspaceFile {
  return {
    format: WORKSPACE_FORMAT,
    version: 2,
    workspaceId: "workspace-v3-test",
    savedAt: "2026-07-17T12:34:56.789Z",
    app: "GateLab v0.10.0",
    samples,
    activeSample: samples.length - 1,
    gating: {
      gates: {
        g1: {
          gate_id: "g1",
          name: "Cells",
          gate_type: "rectangle",
          x_channel: "A",
          y_channel: "B",
          vertices: [[1, 2], [3, 4]],
          color: "#e41a1c",
          label_offset: [0.1, -0.2],
        },
      },
      gate_order: ["g1"],
      populations: {
        root: {
          population_id: "root",
          name: "All Events",
          gate_refs: [],
          gate_logic: "and",
          parent_id: null,
          children: ["cells"],
          event_count: 10_000,
          percent_of_parent: 100,
        },
        cells: {
          population_id: "cells",
          name: "Cells",
          gate_refs: [{ gate_id: "g1", include: true }],
          gate_logic: "and",
          parent_id: "root",
          children: [],
          event_count: 8_000,
          percent_of_parent: 80,
        },
      },
      root_population_id: "root",
      active_population_id: "cells",
      selected_gate_id: "g1",
    },
    scales: { globalScales: { A: [-1, 9], B: [0, 12] } },
    display: {
      xChannel: "A",
      yChannel: "B",
      mode: "contour",
      maxEvents: 25_000,
      contourThreshold: 7.5,
      fontSizes: { tick: 9, axis: 12, title: 12, gate: 10 },
    },
    illustration: {
      plotType: "heatmap",
      popIds: ["cells"],
      xChannels: ["A", "B"],
      yChannel: "B",
      displayMode: "pseudocolor",
      plotSize: 240,
      nColumns: 3,
      fitToColumns: true,
      maxEvents: 12_000,
      allEvents: false,
      colorByPop: true,
      overlayPops: false,
      popColors: { cells: "#377eb8" },
      pointSize: 1.4,
      pointAlpha: 0.4,
      contourThreshold: 6,
      kdeBandwidth: 0.8,
      pubStyle: true,
      gateLineWidth: 1.5,
      histLineWidth: 1.25,
      histFill: true,
      histFillAlpha: 0.3,
      histOverlayMode: "overlay",
      histLayout: "ridgeline",
      ridgeOverlap: 1.2,
      ridgeColGap: 12,
      ridgeGradient: true,
      heatmapStat: "median",
      heatmapScale: "column_zscore",
      heatmapPalette: "blue_white_yellow_red",
      heatmapCellSize: 32,
      heatmapShowValues: true,
      fontTick: 9,
      fontAxis: 12,
      fontTitle: 12,
      fontGate: 10,
      scaleFontsWithPlot: true,
    },
    illustrationPresets: [
      {
        name: "Barcode heatmap",
        config: {
          plotType: "histogram",
          popIds: ["cells"],
          xChannels: ["A"],
          yChannel: "B",
          displayMode: "dots",
          plotSize: 200,
          nColumns: 2,
          fitToColumns: false,
          maxEvents: 5_000,
          allEvents: true,
          colorByPop: false,
          overlayPops: true,
          popColors: {},
          pointSize: 1,
          pointAlpha: 0.5,
          contourThreshold: 5,
          kdeBandwidth: 1,
          pubStyle: false,
          gateLineWidth: 1,
          histLineWidth: 1,
          histFill: false,
          histFillAlpha: 0.2,
          histOverlayMode: "stacked",
          histLayout: "grid",
          ridgeOverlap: 1,
          ridgeColGap: 8,
          ridgeGradient: false,
          fontTick: 8,
          fontAxis: 10,
          fontTitle: 10,
          fontGate: 8,
        },
      },
    ],
    metadataColumns: [
      { name: "donor" },
      { name: "condition", levels: ["unstim", "stim"] },
    ],
    populationMetadata: { cells: { lineage: "lymphocyte", review: "accepted" } },
    populationMetaColumns: [
      { name: "lineage", levels: ["lymphocyte", "myeloid"] },
      { name: "review" },
    ],
  };
}

function flowLayer(profile: CompensationProfileRecord): PersistedCompensatedLayerBinding {
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
  };
}

function cytofLayer(profile: CompensationProfileRecord): PersistedCompensatedLayerBinding {
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

const FLOW_CHANNELS = Object.freeze([
  Object.freeze({ pnn: "A", columnIndex: 4 }),
  Object.freeze({ pnn: "B", columnIndex: 7 }),
]);
const CYTOF_CHANNELS = Object.freeze([
  Object.freeze({ pnn: "A", columnIndex: 3 }),
  Object.freeze({ pnn: "B", columnIndex: 5 }),
  Object.freeze({ pnn: "C", columnIndex: 8 }),
  Object.freeze({ pnn: "D", columnIndex: 9 }),
]);

async function compensatedWorkspace(): Promise<{
  workspace: WorkspaceFileV3;
  flow: BaselineCompensationProfileRecord;
  cytof: BaselineCompensationProfileRecord;
  contexts: WorkspaceV3SampleRestoreContexts;
}> {
  const flow = await baseline("flow-root", flowScientific());
  const cytof = await baseline("cytof-root", cytofScientific());
  const legacy = workspaceV2([
    fullSample({
      fileName: "flow.fcs",
      dataPath: "data/flow.fcs",
      cytofCofactor: undefined,
      instrumentMode: "flow",
    }),
    fullSample({
      fileName: "cytof.fcs",
      dataPath: "data/cytof.fcs",
      logicleW: {},
      scatterCofactor: undefined,
      cytofCofactor: 5,
      instrumentMode: "cytof",
    }),
  ]);
  const workspace = migrateWorkspaceV2ToV3(legacy);
  workspace.compensation = {
    schema: WORKSPACE_COMPENSATION_SCHEMA,
    lineages: [
      { baselineProfileId: flow.profileId, records: [flow] },
      { baselineProfileId: cytof.profileId, records: [cytof] },
    ],
  };
  workspace.samples[0].assay = assay(flowLayer(flow));
  workspace.samples[1].assay = assay(cytofLayer(cytof));
  return {
    workspace,
    flow,
    cytof,
    contexts: {
      "data/flow.fcs": { sampleChannels: FLOW_CHANNELS, instrumentKind: "flow" },
      "data/cytof.fcs": { sampleChannels: CYTOF_CHANNELS, instrumentKind: "cytof" },
    },
  };
}

async function expectV3Error(
  action: Promise<unknown> | (() => unknown),
  code: WorkspaceV3ValidationCode,
): Promise<WorkspaceV3ValidationError> {
  try {
    if (typeof action === "function") action();
    else await action;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceV3ValidationError);
    const workspaceError = error as WorkspaceV3ValidationError;
    expect(workspaceError.code).toBe(code);
    return workspaceError;
  }
  throw new Error(`Expected workspace v3 error ${code}.`);
}

describe("legacy workspace migration to v3", () => {
  it("migrates every v2 non-compensation field losslessly and installs Original assays", async () => {
    const legacy = workspaceV2([
      fullSample(),
      fullSample({
        fileName: "second.fcs",
        dataPath: "data/1_second.fcs",
        logicleW: {},
        scatterCofactor: undefined,
        cytofCofactor: 7.5,
        instrumentMode: "cytof",
        labels: { C: "CD45" },
        metadata: { donor: "D02" },
        division: undefined,
      }),
    ]);
    const snapshot = clone(legacy);

    const migrated = await migrateWorkspaceToV3(legacy);
    const expectedSamples = snapshot.samples.map(({ compensationOn: _legacy, ...sample }) => ({
      ...sample,
      assay: {
        schema: SAMPLE_ASSAY_BINDING_SCHEMA,
        activeLayer: "original" as const,
        compensatedLayer: null,
      },
    }));
    const { version: _version, samples: _samples, ...expectedCommon } = snapshot;

    expect(migrated).toEqual({
      ...expectedCommon,
      version: WORKSPACE_VERSION_3,
      samples: expectedSamples,
      compensation: { schema: WORKSPACE_COMPENSATION_SCHEMA, lineages: [] },
    });
    expect(legacy).toEqual(snapshot);
    expect(migrated.samples.every((sample) => !("compensationOn" in sample))).toBe(true);
  });

  it("migrates an uncompensated v1 workspace through the exact v1-to-v2 path", async () => {
    const source = workspaceV2();
    const v1 = {
      format: WORKSPACE_FORMAT,
      version: 1,
      workspaceId: "legacy-one",
      savedAt: source.savedAt,
      app: source.app,
      sample: { fileName: "legacy.fcs", dataPath: "data/legacy.fcs" },
      gating: source.gating,
      scales: {
        logicleW: { APC: 0.91 },
        globalScales: { APC: [-2, 8] as [number, number] },
      },
      compensation: { on: false },
      display: { ...source.display, xChannel: "APC", yChannel: "APC" },
    };

    const migrated = await migrateWorkspaceToV3(v1);

    expect(migrated).toMatchObject({
      format: WORKSPACE_FORMAT,
      version: WORKSPACE_VERSION_3,
      workspaceId: "legacy-one",
      samples: [{
        fileName: "legacy.fcs",
        dataPath: "data/legacy.fcs",
        logicleW: { APC: 0.91 },
        assay: {
          schema: SAMPLE_ASSAY_BINDING_SCHEMA,
          activeLayer: "original",
          compensatedLayer: null,
        },
      }],
      activeSample: 0,
      scales: { globalScales: { APC: [-2, 8] } },
      compensation: { schema: WORKSPACE_COMPENSATION_SCHEMA, lineages: [] },
    });
  });

  it.each([
    ["v2", () => workspaceV2([fullSample({ compensationOn: true })])],
    ["v1", () => {
      const source = workspaceV2();
      return {
        format: WORKSPACE_FORMAT,
        version: 1,
        savedAt: source.savedAt,
        app: source.app,
        sample: { fileName: "legacy.fcs", dataPath: "data/legacy.fcs" },
        gating: source.gating,
        scales: { logicleW: {}, globalScales: source.scales.globalScales },
        compensation: { on: true },
        display: source.display,
      };
    }],
  ])("rejects legacy compensated %s state instead of guessing its scientific identity", async (_label, make) => {
    const error = await expectV3Error(
      migrateWorkspaceToV3(make()),
      "unsafe-legacy-compensation",
    );
    expect(error.message).toMatch(/cannot be migrated safely|legacy compensation/i);
  });

  it.each([
    ["missing", undefined],
    ["string", "2"],
    ["future", 4],
  ])("rejects a %s version explicitly", async (_label, version) => {
    const candidate = clone(workspaceV2()) as unknown as Record<string, unknown>;
    if (version === undefined) delete candidate.version;
    else candidate.version = version;
    const error = await expectV3Error(
      migrateWorkspaceToV3(candidate),
      "unsupported-workspace-version",
    );
    expect(error.message).toContain(String(version));
  });

  it("does not reinterpret a samples-shaped future workspace as v2", async () => {
    const future = { ...clone(workspaceV2()), version: 99, futureState: { mode: "new" } };
    const error = await expectV3Error(
      migrateWorkspaceToV3(future),
      "unsupported-workspace-version",
    );
    expect(error.message).toContain("99");
  });
});

describe("uncompensated v3 validation", () => {
  it("round-trips an empty compensation state and Original assay idempotently through JSON", async () => {
    const migrated = migrateWorkspaceV2ToV3(workspaceV2());
    const json = JSON.stringify(migrated);
    const first = await migrateWorkspaceToV3(JSON.parse(json));
    const second = await validateWorkspaceV3(JSON.parse(JSON.stringify(first)));

    expect(first).toEqual(migrated);
    expect(second).toEqual(first);
    expect(second.compensation).toEqual(newEmptyWorkspaceCompensationState());
    expect(second.samples[0].assay).toEqual(newOriginalWorkspaceSampleAssay());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("requires the GateLab workspace format marker", async () => {
    const candidate = clone(migrateWorkspaceV2ToV3(workspaceV2())) as unknown as Record<string, unknown>;
    delete candidate.format;
    await expectV3Error(validateWorkspaceV3(candidate), "unrecognized-workspace");
  });

  it.each(["savedAt", "app", "samples", "activeSample", "gating", "scales", "display", "compensation"])(
    "requires the top-level %s field",
    async (field) => {
      const candidate = clone(migrateWorkspaceV2ToV3(workspaceV2())) as unknown as Record<string, unknown>;
      delete candidate[field];
      await expectV3Error(validateWorkspaceV3(candidate), "invalid-workspace-v3");
    },
  );

  it("rejects unknown top-level fields", async () => {
    const candidate = clone(migrateWorkspaceV2ToV3(workspaceV2())) as unknown as Record<string, unknown>;
    candidate.futureCompensationCache = [];
    const error = await expectV3Error(validateWorkspaceV3(candidate), "invalid-workspace-v3");
    expect(error.message).toContain("futureCompensationCache");
  });

  it.each(["fileName", "dataPath", "logicleW", "assay"])(
    "requires the sample %s field",
    async (field) => {
      const candidate = clone(migrateWorkspaceV2ToV3(workspaceV2()));
      delete (candidate.samples[0] as unknown as Record<string, unknown>)[field];
      const error = await expectV3Error(validateWorkspaceV3(candidate), "invalid-workspace-sample");
      expect(error.sampleIndex).toBe(0);
      expect(error.dataPath).toBe(field === "dataPath" ? undefined : "data/0_sample-alpha.fcs");
    },
  );

  it.each([
    ["legacy compensation flag", "compensationOn", true],
    ["raw event rows", "rawValues", [[1, 2]]],
    ["derived compensated rows", "compensatedValues", [[0.9, 1.8]]],
    ["display rows", "displayValues", [[0.1, 0.2]]],
    ["FCS bytes", "fcsBytes", [70, 67, 83]],
  ])("rejects persisted %s on a sample", async (_label, field, value) => {
    const candidate = clone(migrateWorkspaceV2ToV3(workspaceV2()));
    (candidate.samples[0] as unknown as Record<string, unknown>)[field] = value;
    const error = await expectV3Error(validateWorkspaceV3(candidate), "invalid-workspace-sample");
    expect(error.message).toContain(field);
  });

  it("reuses common workspace validation, including unique data paths and graph/display state", async () => {
    const duplicate = migrateWorkspaceV2ToV3(workspaceV2([
      fullSample(),
      fullSample({ fileName: "duplicate.fcs", dataPath: "data/1_duplicate.fcs" }),
    ]));
    duplicate.samples[1].dataPath = duplicate.samples[0].dataPath;
    const duplicateError = await expectV3Error(
      validateWorkspaceV3(duplicate),
      "invalid-workspace-v3",
    );
    expect(duplicateError.message).toMatch(/duplicate.*dataPath/i);

    const badDisplay = clone(migrateWorkspaceV2ToV3(workspaceV2()));
    badDisplay.display.maxEvents = -1;
    await expectV3Error(validateWorkspaceV3(badDisplay), "invalid-workspace-v3");

    const badGraph = clone(migrateWorkspaceV2ToV3(workspaceV2()));
    badGraph.gating.populations.cells.parent_id = "missing";
    await expectV3Error(validateWorkspaceV3(badGraph), "invalid-workspace-v3");

    const badInstrumentMode = clone(migrateWorkspaceV2ToV3(workspaceV2()));
    (badInstrumentMode.samples[0] as unknown as { instrumentMode: string }).instrumentMode = "spectral";
    const modeError = await expectV3Error(
      validateWorkspaceV3(badInstrumentMode),
      "invalid-workspace-v3",
    );
    expect(modeError.message).toMatch(/instrument mode/i);

    const badDivision = clone(migrateWorkspaceV2ToV3(workspaceV2()));
    badDivision.samples[0].division!.boundaries = [1.5, 1.5, 7];
    const divisionError = await expectV3Error(
      validateWorkspaceV3(badDivision),
      "invalid-workspace-v3",
    );
    expect(divisionError.message).toMatch(/division profile.*strictly increasing/i);
  });
});

describe("compensated v3 restoration", () => {
  it("round-trips v3 profile state through bundled and reference storage envelopes", async () => {
    const { workspace } = await compensatedWorkspace();
    const flowBytes = Uint8Array.from([70, 67, 83, 1]);
    const cytofBytes = Uint8Array.from([70, 67, 83, 2]);
    const bundled = packWorkspaceV3(workspace, {
      "data/flow.fcs": flowBytes,
      "data/cytof.fcs": cytofBytes,
    });
    const bundleEnvelope = readWorkspaceEnvelope(bundled);

    expect(bundleEnvelope.storage).toBe("bundle");
    expect(bundleEnvelope.raw).toEqual(workspace);
    expect(bundleEnvelope.fcsByPath?.["data/flow.fcs"]).toEqual(flowBytes);
    expect(bundleEnvelope.fcsByPath?.["data/cytof.fcs"]).toEqual(cytofBytes);

    const referenceEnvelope = readWorkspaceEnvelope(packWorkspaceV3Reference(workspace));
    expect(referenceEnvelope.storage).toBe("reference");
    expect(referenceEnvelope.raw).toEqual(workspace);
    expect(referenceEnvelope.fcsByPath).toBeNull();
  });

  it("restores exact flow and rectangular CyTOF layers from FCS PnN contexts", async () => {
    const { workspace, contexts } = await compensatedWorkspace();

    const restored = await validateWorkspaceV3(clone(workspace), contexts);

    expect(restored.samples[0].assay).toEqual(workspace.samples[0].assay);
    expect(restored.samples[1].assay).toEqual(workspace.samples[1].assay);
    expect(restored.samples[1].assay.compensatedLayer?.channelBindings).toEqual([
      expect.objectContaining({ pnn: "A", matrixSourceIndex: 0, matrixReceiverIndex: 0, included: true }),
      expect.objectContaining({ pnn: "B", matrixSourceIndex: 1, matrixReceiverIndex: 1, included: false }),
      expect.objectContaining({ pnn: "C", matrixSourceIndex: null, matrixReceiverIndex: 2, included: true }),
      expect.objectContaining({ pnn: "D", matrixSourceIndex: null, matrixReceiverIndex: 3, included: false }),
    ]);
    expect(restored.compensation.lineages.map(({ baselineProfileId }) => baselineProfileId)).toEqual([
      "cytof-root",
      "flow-root",
    ]);
  });

  it("retains an installed compensated layer while Original remains active", async () => {
    const { workspace, contexts } = await compensatedWorkspace();
    workspace.samples[0].assay = assay(
      workspace.samples[0].assay.compensatedLayer,
      "original",
    );

    const restored = await validateWorkspaceV3(clone(workspace), contexts);

    expect(restored.samples[0].assay.activeLayer).toBe("original");
    expect(restored.samples[0].assay.compensatedLayer?.profileId).toBe("flow-root");
  });

  it("looks up restore context by dataPath, never by fileName or sample order", async () => {
    const { workspace, contexts } = await compensatedWorkspace();
    const byFileName = {
      "flow.fcs": contexts["data/flow.fcs"],
      "cytof.fcs": contexts["data/cytof.fcs"],
    };
    const missing = await expectV3Error(
      validateWorkspaceV3(clone(workspace), byFileName),
      "invalid-sample-assay",
    );
    expect(missing.sampleIndex).toBe(0);
    expect(missing.dataPath).toBe("data/flow.fcs");

    const reversedInsertionOrder = {
      "data/cytof.fcs": contexts["data/cytof.fcs"],
      "data/flow.fcs": contexts["data/flow.fcs"],
    };
    await expect(validateWorkspaceV3(clone(workspace), reversedInsertionOrder)).resolves.toMatchObject({
      samples: [
        { dataPath: "data/flow.fcs", assay: { activeLayer: "compensated" } },
        { dataPath: "data/cytof.fcs", assay: { activeLayer: "compensated" } },
      ],
    });
  });

  it("enforces explicit instrument overrides against parsed context while allowing auto detection", async () => {
    const explicitFlow = migrateWorkspaceV2ToV3(workspaceV2([
      fullSample({ instrumentMode: "flow" }),
    ]));
    const dataPath = explicitFlow.samples[0].dataPath;
    const cytofContext = {
      [dataPath]: { sampleChannels: CYTOF_CHANNELS, instrumentKind: "cytof" as const },
    };
    const flowError = await expectV3Error(
      validateWorkspaceV3(explicitFlow, cytofContext),
      "invalid-sample-assay",
    );
    expect(flowError.message).toMatch(/context says cytof.*override is flow/i);

    const explicitCytof = clone(explicitFlow);
    explicitCytof.samples[0].instrumentMode = "cytof";
    const flowContext = {
      [dataPath]: { sampleChannels: FLOW_CHANNELS, instrumentKind: "flow" as const },
    };
    const cytofError = await expectV3Error(
      validateWorkspaceV3(explicitCytof, flowContext),
      "invalid-sample-assay",
    );
    expect(cytofError.message).toMatch(/context says flow.*override is cytof/i);

    const automatic = clone(explicitFlow);
    automatic.samples[0].instrumentMode = "auto";
    await expect(validateWorkspaceV3(clone(automatic), flowContext)).resolves.toBeDefined();
    await expect(validateWorkspaceV3(clone(automatic), cytofContext)).resolves.toBeDefined();
  });

  it.each([
    ["all context", {}],
    ["parsed channel identities", {
      "data/flow.fcs": { instrumentKind: "flow" as const },
    }],
    ["instrument kind", {
      "data/flow.fcs": { sampleChannels: FLOW_CHANNELS },
    }],
  ])("rejects retained compensation missing %s", async (_label, partial) => {
    const { workspace, contexts } = await compensatedWorkspace();
    const supplied = {
      ...contexts,
      ...partial,
    } as WorkspaceV3SampleRestoreContexts;
    if (_label === "all context") delete (supplied as Record<string, unknown>)["data/flow.fcs"];
    const error = await expectV3Error(
      validateWorkspaceV3(clone(workspace), supplied),
      "invalid-sample-assay",
    );
    expect(error.sampleIndex).toBe(0);
  });

  it("rejects wrong instrument kind, effective CyTOF cofactor, or parsed channel mapping", async () => {
    const fixture = await compensatedWorkspace();

    const wrongKind = {
      ...fixture.contexts,
      "data/flow.fcs": { sampleChannels: FLOW_CHANNELS, instrumentKind: "cytof" as const },
    };
    await expectV3Error(
      validateWorkspaceV3(clone(fixture.workspace), wrongKind),
      "invalid-sample-assay",
    );

    const wrongCofactor = clone(fixture.workspace);
    wrongCofactor.samples[1].cytofCofactor = 6;
    const cofactorError = await expectV3Error(
      validateWorkspaceV3(wrongCofactor, fixture.contexts),
      "invalid-sample-assay",
    );
    expect(cofactorError.sampleIndex).toBe(1);
    expect(cofactorError.message).toMatch(/cofactor/i);

    const wrongMapping = {
      ...fixture.contexts,
      "data/flow.fcs": {
        instrumentKind: "flow" as const,
        sampleChannels: [
          { pnn: "A", columnIndex: 40 },
          { pnn: "B", columnIndex: 7 },
        ],
      },
    };
    const mappingError = await expectV3Error(
      validateWorkspaceV3(clone(fixture.workspace), wrongMapping),
      "invalid-sample-assay",
    );
    expect(mappingError.dataPath).toBe("data/flow.fcs");
  });

  it("rejects invalid compensation lineage declarations and tampered scientific hashes", async () => {
    const fixture = await compensatedWorkspace();
    const mismatchedBaseline = clone(fixture.workspace);
    (mismatchedBaseline.compensation.lineages[0] as { baselineProfileId: string }).baselineProfileId =
      "not-the-record-baseline";
    const lineageError = await expectV3Error(
      validateWorkspaceV3(mismatchedBaseline, fixture.contexts),
      "invalid-compensation-state",
    );
    expect(lineageError.message).toMatch(/baseline/i);

    const tamperedScientific = clone(fixture.workspace);
    const record = tamperedScientific.compensation.lineages[0].records[0];
    (record.scientific.matrix.matrix[0] as number[])[1] = 0.987;
    const hashError = await expectV3Error(
      validateWorkspaceV3(tamperedScientific, fixture.contexts),
      "invalid-compensation-state",
    );
    expect(hashError.message).toMatch(/hash|canonical/i);
  });

  it("rejects a sample layer whose persisted profile identity hash no longer matches", async () => {
    const fixture = await compensatedWorkspace();
    const tampered = clone(fixture.workspace);
    const layer = tampered.samples[0].assay.compensatedLayer;
    if (!layer) throw new Error("expected flow layer");
    (layer as { profileHash: string }).profileHash = `sha256:${"a".repeat(64)}`;

    const error = await expectV3Error(
      validateWorkspaceV3(tampered, fixture.contexts),
      "invalid-sample-assay",
    );
    expect(error.message).toMatch(/identity|hash/i);
  });

  it("detaches validated output from both untrusted workspace and context inputs", async () => {
    const fixture = await compensatedWorkspace();
    const input = clone(fixture.workspace);
    const contexts = clone(fixture.contexts) as {
      [dataPath: string]: {
        sampleChannels: Array<{ pnn: string; columnIndex: number }>;
        instrumentKind: "flow" | "cytof";
      };
    };
    const snapshot = clone(input);

    const restored = await validateWorkspaceV3(input, contexts);

    input.samples[0].fileName = "mutated-input.fcs";
    const inputLayer = input.samples[0].assay.compensatedLayer;
    if (!inputLayer) throw new Error("expected input flow layer");
    (inputLayer.channelBindings[0] as { pnn: string }).pnn = "mutated-input";
    (input.compensation.lineages[0].records[0] as { name: string }).name = "mutated input";
    contexts["data/flow.fcs"].sampleChannels[0].pnn = "mutated-context";

    expect(restored.samples[0].fileName).toBe(snapshot.samples[0].fileName);
    expect(restored.samples[0].assay.compensatedLayer?.channelBindings[0].pnn).toBe("A");
    expect(restored.compensation.lineages[0].records[0].name).not.toBe("mutated input");
    expect(Object.isFrozen(restored.samples[0].assay)).toBe(true);
    expect(Object.isFrozen(restored.compensation)).toBe(true);

    restored.samples[0].fileName = "mutated-output.fcs";
    expect(input.samples[0].fileName).toBe("mutated-input.fcs");
    expect(snapshot.samples[0].fileName).toBe("flow.fcs");
  });
});
