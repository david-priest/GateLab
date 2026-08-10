// @vitest-environment jsdom

import { createShinySceHost, type GateLabShinyManifest } from "./shinySceHost";
import {
  validateAndCanonicalizeCompensationMatrix,
} from "../engine/compensationProfile";
import {
  createCompensationBaselineProfile,
} from "../engine/compensationProfileRecord";
import {
  CYTOF_NNLS_SOLVER_VERSION,
  DEFAULT_CYTOF_NNLS_SETTINGS,
} from "../engine/cytofCompensationEngine";
import {
  adoptedRProfile,
  authoritativeRProfile,
  GATELAB_HOST_COMPENSATION_CONTRACT_VERSION,
} from "./compensationContract";

const descriptor = {
  contractVersion: 1,
  id: "sce",
  label: "Test SCE",
  instrument: "cytof",
  eventCount: 2,
  channels: [{ id: "CD3", label: "CD3", pnn: "Nd142Di" }],
  assays: [{
    id: "counts",
    label: "counts",
    role: "counts",
    coordinateSpace: "linear",
    revision: 0,
    encoding: "channel-major-float32-le",
  }],
  defaultAssayId: "counts",
  samples: [{
    id: "sample-0",
    label: "Donor A",
    eventCount: 2,
    metadata: { batch: "one" },
    assayByteLength: 8,
    eventIndexEncoding: "uint32-le",
    eventIndexByteLength: 8,
  }],
} as const;

async function hostCompensationProfile() {
  const matrix = validateAndCanonicalizeCompensationMatrix({
    sourceChannels: ["Nd142Di"],
    receiverChannels: ["Nd142Di"],
    matrix: [[1]],
  }, "cytof-spillover");
  if (!matrix.ok) throw new Error("fixture matrix failed");
  const browser = await createCompensationBaselineProfile({
    kind: "cytof-spillover",
    method: "nnls",
    solverVersion: CYTOF_NNLS_SOLVER_VERSION,
    solverSettings: DEFAULT_CYTOF_NNLS_SETTINGS,
    matrix: matrix.value,
    includedChannels: ["Nd142Di"],
  }, {
    profileId: "browser-profile",
    name: "Test matrix",
    createdAt: "2026-07-25T00:00:00.000Z",
    origin: {
      type: "uploaded",
      fileName: "matrix.csv",
      format: "csv",
      sourceColumnHeader: "",
    },
  });
  return authoritativeRProfile(browser);
}

describe("createShinySceHost", () => {
  it("waits for the Shiny manifest and fetches session-scoped binary resources", async () => {
    const handlers = new Map<string, (message: unknown) => void>();
    const setInputValue = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => new Response(
      url.includes("events")
        ? new Uint32Array([0, 1])
        : new Float32Array([1.5, 2.5]),
      { status: 200 },
    ));
    window.Shiny = {
      addCustomMessageHandler(type, handler) {
        handlers.set(type, handler);
      },
      setInputValue,
      shinyapp: { isConnected: () => true },
    };

    const host = createShinySceHost({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    host.lifecycle?.mounted?.();
    const listPromise = host.datasets!.listDatasets();

    const manifest: GateLabShinyManifest = {
      contractVersion: 1,
      datasets: [descriptor],
      resources: [{
        datasetId: "sce",
        sampleId: "sample-0",
        eventIndexUrl: "session/events",
        assayUrls: { counts: "session/counts" },
      }],
      workspace: {
        contractVersion: 1,
        datasetId: "sce",
        sourceFormat: "gatelabr-legacy",
        revision: 0,
        workspaceJson: '{"gates":[]}',
      },
    };
    handlers.get("gatelabr-host-manifest")!(manifest);

    await expect(listPromise).resolves.toEqual([descriptor]);
    await expect(host.datasets!.readAssay("sce", "sample-0", "counts"))
      .resolves.toHaveProperty("byteLength", 8);
    await expect(host.datasets!.readEventIndex("sce", "sample-0"))
      .resolves.toHaveProperty("byteLength", 8);
    await expect(host.workspaces!.readWorkspace("sce")).resolves.toEqual(
      manifest.workspace,
    );
    expect(setInputValue).toHaveBeenCalledWith(
      "gatelabr_react_ready",
      expect.objectContaining({ contractVersion: 1 }),
      { priority: "event" },
    );

    const writePromise = host.workspaces!.writeWorkspace({
      datasetId: "sce",
      expectedRevision: 0,
      clientRevision: 4,
      reason: "explicit",
      workspaceJson: '{"format":"gatelab-workspace","version":2}',
    });
    const workspaceRequest = setInputValue.mock.calls.find(
      ([name]) => name === "gatelabr_host_request",
    )?.[1] as { requestId: string; operation: string };
    expect(workspaceRequest.operation).toBe("write-workspace");
    handlers.get("gatelabr-host-response")!({
      requestId: workspaceRequest.requestId,
      ok: true,
      result: {
        revision: 1,
        clientRevision: 4,
        savedAt: "2026-07-25T00:00:00Z",
      },
    });
    await expect(writePromise).resolves.toEqual({
      revision: 1,
      clientRevision: 4,
      savedAt: "2026-07-25T00:00:00Z",
    });

    const colDataPromise = host.colData!.writeColumns({
      contractVersion: 1,
      datasetId: "sce",
      workspaceRevision: 1,
      overwrite: false,
      columns: [],
    });
    const colDataRequest = [...setInputValue.mock.calls].reverse().find(
      ([name]) => name === "gatelabr_host_request",
    )?.[1] as { requestId: string; operation: string };
    expect(colDataRequest.operation).toBe("write-coldata");
    handlers.get("gatelabr-host-response")!({
      requestId: colDataRequest.requestId,
      ok: false,
      error: "Select at least one population to export.",
    });
    await expect(colDataPromise).rejects.toThrow(
      "Select at least one population to export.",
    );

    const categoricalPromise = host.colData!.writeCategoricalColumns({
      contractVersion: 1,
      datasetId: "sce",
      overwrite: false,
      columns: [{
        columnName: "condition",
        levels: ["control"],
        sampleValues: [{
          sampleId: "sample-0",
          eventCount: 2,
          constantCode: 0,
        }],
      }],
    });
    const categoricalRequest = [...setInputValue.mock.calls].reverse().find(
      ([name]) => name === "gatelabr_host_request",
    )?.[1] as { requestId: string; operation: string };
    expect(categoricalRequest.operation).toBe("write-categorical-coldata");
    handlers.get("gatelabr-host-response")!({
      requestId: categoricalRequest.requestId,
      ok: true,
      result: {
        columns: [{
          columnName: "condition",
          valueCounts: { control: 2 },
          missingCount: 0,
        }],
      },
    });
    await expect(categoricalPromise).resolves.toMatchObject({
      columns: [{ columnName: "condition", missingCount: 0 }],
    });

    const rowDataPromise = host.rowData!.writeChannelLabels({
      contractVersion: 1,
      datasetId: "sce",
      expectedRevision: 0,
      changes: [{ channelId: "CD3", label: "T cells" }],
    });
    const rowDataRequest = [...setInputValue.mock.calls].reverse().find(
      ([name]) => name === "gatelabr_host_request",
    )?.[1] as { requestId: string; operation: string };
    expect(rowDataRequest.operation).toBe("write-rowdata-labels");
    handlers.get("gatelabr-host-response")!({
      requestId: rowDataRequest.requestId,
      ok: true,
      result: { revision: 1, changedChannelIds: ["CD3"] },
    });
    await expect(rowDataPromise).resolves.toEqual({
      revision: 1,
      changedChannelIds: ["CD3"],
    });
  });

  it("waits for Shiny initialization before signalling the R host", async () => {
    let finishInitialization!: () => void;
    const initializedPromise = new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    const shiny = {
      addCustomMessageHandler() {},
      initializedPromise,
    } as NonNullable<typeof window.Shiny>;
    window.Shiny = shiny;

    const host = createShinySceHost();
    host.lifecycle?.mounted?.();
    const setInputValue = vi.fn();
    shiny.setInputValue = setInputValue;
    finishInitialization();
    await initializedPromise;
    await Promise.resolve();

    expect(setInputValue).toHaveBeenCalledWith(
      "gatelabr_react_ready",
      expect.objectContaining({ contractVersion: 1 }),
      { priority: "event" },
    );
  });

  it("materializes an authoritative R assay and reuses it without recomputation", async () => {
    const handlers = new Map<string, (message: unknown) => void>();
    const setInputValue = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(
      new Float32Array([7.5, 8.5]),
      { status: 200 },
    ));
    window.Shiny = {
      addCustomMessageHandler(type, handler) {
        handlers.set(type, handler);
      },
      setInputValue,
      shinyapp: { isConnected: () => true },
    };

    const host = createShinySceHost({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    host.lifecycle?.mounted?.();
    handlers.get("gatelabr-host-manifest")!({
      contractVersion: 1,
      datasets: [descriptor],
      resources: [{
        datasetId: "sce",
        sampleId: "sample-0",
        eventIndexUrl: "session/events",
        assayUrls: { counts: "session/counts" },
      }],
    } satisfies GateLabShinyManifest);

    const profile = await hostCompensationProfile();
    const applyPromise = host.compensation!.applyProfile({
      contractVersion: GATELAB_HOST_COMPENSATION_CONTRACT_VERSION,
      datasetId: "sce",
      profile,
      targets: [{
        sampleId: "sample-0",
        sourceAssayId: "counts",
        expectedAssayRevision: 0,
        activeLayer: "compensated",
      }],
      workerCount: 2,
    });
    const request = [...setInputValue.mock.calls].reverse().find(
      ([name]) => name === "gatelabr_host_request",
    )?.[1] as {
      requestId: string;
      operation: string;
      payload: { profileJson: string; profile?: unknown };
    };
    expect(request.operation).toBe("apply-compensation");
    expect(request.payload.profile).toBeUndefined();
    expect(JSON.parse(request.payload.profileJson).profileId)
      .toBe(profile.profileId);

    handlers.get("gatelabr-host-response")!({
      requestId: request.requestId,
      ok: true,
      result: {
        application: {
          contractVersion: 1,
          datasetId: "sce",
          profileJson: JSON.stringify(profile),
          sourceAssayId: "counts",
          outputAssay: {
            id: "gatelab_compensated",
            label: "gatelab_compensated",
            role: "compensated",
            coordinateSpace: "linear",
            revision: 1,
            encoding: "channel-major-float32-le",
          },
          // Shiny auto-unboxes single-element R vectors.
          targetSampleIds: "sample-0",
          activeSampleIds: "sample-0",
          appliedAt: "2026-07-25T00:00:00.000Z",
        },
        // Shiny also auto-unboxes a one-target list.
        targets: {
          sampleId: "sample-0",
          eventCount: 2,
          assayUrl: "session/compensated",
        },
      },
    });

    const applied = await applyPromise;
    expect(applied.application.profile).toEqual(profile);
    expect(applied.application.targetSampleIds).toEqual(["sample-0"]);
    expect(
      Array.from(new Float32Array(applied.targets[0].assayPayload)),
    ).toEqual([7.5, 8.5]);

    const restored = await host.compensation!.readStoredApplication(
      "sce",
      profile.profileId,
    );
    expect(restored?.application.outputAssay.id).toBe("gatelab_compensated");
    expect(setInputValue.mock.calls.filter(
      ([name, value]) =>
        name === "gatelabr_host_request" &&
        (value as { operation?: unknown }).operation === "apply-compensation",
    )).toHaveLength(1);

    const adoptedProfile = await adoptedRProfile(profile);
    const adoptionPromise = host.compensation!.adoptExistingAssay({
      contractVersion: GATELAB_HOST_COMPENSATION_CONTRACT_VERSION,
      datasetId: "sce",
      profile: adoptedProfile,
      outputAssayId: "precomputed",
      expectedOutputAssayRevision: 4,
      targets: [{
        sampleId: "sample-0",
        sourceAssayId: "counts",
        expectedAssayRevision: 0,
        activeLayer: "compensated",
      }],
    });
    const adoptionRequest = [...setInputValue.mock.calls].reverse().find(
      ([name]) => name === "gatelabr_host_request",
    )?.[1] as {
      requestId: string;
      operation: string;
      payload: {
        profileJson: string;
        profile?: unknown;
        outputAssayId: string;
        expectedOutputAssayRevision: number;
      };
    };
    expect(adoptionRequest.operation).toBe("adopt-compensated-assay");
    expect(adoptionRequest.payload.profile).toBeUndefined();
    expect(adoptionRequest.payload.outputAssayId).toBe("precomputed");
    expect(adoptionRequest.payload.expectedOutputAssayRevision).toBe(4);
    handlers.get("gatelabr-host-response")!({
      requestId: adoptionRequest.requestId,
      ok: true,
      result: {
        application: {
          contractVersion: 1,
          datasetId: "sce",
          profileJson: JSON.stringify(adoptedProfile),
          sourceAssayId: "counts",
          execution: "adopted-existing-assay",
          outputAssay: {
            id: "precomputed",
            label: "precomputed",
            role: "compensated",
            coordinateSpace: "linear",
            revision: 4,
            encoding: "channel-major-float32-le",
          },
          targetSampleIds: "sample-0",
          activeSampleIds: "sample-0",
          appliedAt: "2026-07-25T00:00:00.000Z",
        },
        targets: {
          sampleId: "sample-0",
          eventCount: 2,
          assayUrl: "session/precomputed",
        },
      },
    });
    const adopted = await adoptionPromise;
    expect(adopted.application.execution).toBe("adopted-existing-assay");
    expect(adopted.application.outputAssay.id).toBe("precomputed");
  });

  it("streams host progress and cancels the exact in-flight R job", async () => {
    const handlers = new Map<string, (message: unknown) => void>();
    const setInputValue = vi.fn();
    window.Shiny = {
      addCustomMessageHandler(type, handler) {
        handlers.set(type, handler);
      },
      setInputValue,
      shinyapp: { isConnected: () => true },
    };
    const host = createShinySceHost();
    const profile = await hostCompensationProfile();
    const controller = new AbortController();
    const onProgress = vi.fn();
    const applyPromise = host.compensation!.applyProfile({
      contractVersion: GATELAB_HOST_COMPENSATION_CONTRACT_VERSION,
      datasetId: "sce",
      profile,
      targets: [{
        sampleId: "sample-0",
        sourceAssayId: "counts",
        expectedAssayRevision: 0,
        activeLayer: "compensated",
      }],
      workerCount: 2,
    }, controller.signal, onProgress);
    const request = [...setInputValue.mock.calls].reverse().find(
      ([name]) => name === "gatelabr_host_request",
    )?.[1] as { requestId: string; operation: string };

    handlers.get("gatelabr-host-compensation-progress")!({
      requestId: request.requestId,
      jobId: "r-job-1",
      sampleIndex: 0,
      sampleCount: 1,
      sampleProcessedEvents: 1,
      sampleTotalEvents: 2,
      processedEvents: 1,
      totalEvents: 2,
      fraction: 0.5,
    });
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "r-job-1",
      processedEvents: 1,
      totalEvents: 2,
      fraction: 0.5,
    }));

    controller.abort();
    await expect(applyPromise).rejects.toMatchObject({
      name: "CompensationCancelledError",
    });
    const cancel = [...setInputValue.mock.calls].reverse().find(
      ([, value]) =>
        (value as { operation?: unknown }).operation ===
          "cancel-compensation",
    )?.[1] as {
      operation: string;
      payload: { requestId: string };
    };
    expect(cancel.operation).toBe("cancel-compensation");
    expect(cancel.payload.requestId).toBe(request.requestId);

    handlers.get("gatelabr-host-compensation-progress")!({
      requestId: request.requestId,
      jobId: "r-job-1",
      sampleIndex: 0,
      sampleCount: 1,
      sampleProcessedEvents: 2,
      sampleTotalEvents: 2,
      processedEvents: 2,
      totalEvents: 2,
      fraction: 1,
    });
    expect(onProgress).toHaveBeenCalledTimes(1);
  });
});
