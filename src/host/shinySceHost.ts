import {
  GATELAB_DATASET_CONTRACT_VERSION,
  type GateLabHostDatasetDescriptor,
  type GateLabHostDatasetPort,
} from "./datasetContract";
import {
  GATELAB_HOST_COLDATA_CONTRACT_VERSION,
  type GateLabHostCategoricalWriteResult,
  type GateLabHostColDataPort,
  type GateLabHostColDataWriteResult,
} from "./colDataContract";
import {
  GATELAB_HOST_COMPENSATION_CONTRACT_VERSION,
  type GateLabHostCompensationApplication,
  type GateLabHostCompensationAdoptRequest,
  type GateLabHostCompensationApplyRequest,
  type GateLabHostCompensationApplyResult,
  type GateLabHostCompensationPort,
  type GateLabHostCompensationProgress,
} from "./compensationContract";
import {
  GATELAB_HOST_CONTRACT_VERSION,
  type GateLabHostAdapter,
} from "./contracts";
import { validateCompensationProfileRecord } from "../engine/compensationProfileRecord";
import { CompensationCancelledError } from "../engine/compensationManager";
import {
  GATELAB_HOST_ROWDATA_CONTRACT_VERSION,
  type GateLabHostRowDataPort,
  type GateLabHostRowDataWriteResult,
} from "./rowDataContract";
import {
  GATELAB_HOST_WORKSPACE_CONTRACT_VERSION,
  GateLabWorkspaceConflictError,
  workspaceConflictFrom,
  type GateLabHostWorkspaceEnvelope,
  type GateLabHostWorkspacePort,
  type GateLabHostWorkspaceWriteResult,
} from "./workspaceContract";

interface ShinyClient {
  addCustomMessageHandler(
    type: string,
    handler: (message: unknown) => void,
  ): void;
  setInputValue?(
    name: string,
    value: unknown,
    options?: Readonly<{ priority?: "event" | "deferred" | "immediate" }>,
  ): void;
  initializedPromise?: PromiseLike<unknown>;
  shinyapp?: {
    isConnected?(): boolean;
  };
}

declare global {
  interface Window {
    Shiny?: ShinyClient;
  }
}

export interface GateLabShinyResourceDescriptor {
  datasetId: string;
  sampleId: string;
  eventIndexUrl: string;
  assayUrls: Readonly<Record<string, string>>;
}

export interface GateLabShinyManifest {
  contractVersion: typeof GATELAB_DATASET_CONTRACT_VERSION;
  datasets: readonly GateLabHostDatasetDescriptor[];
  resources: readonly GateLabShinyResourceDescriptor[];
  workspace?: GateLabHostWorkspaceEnvelope | null;
  compensationApplications?: readonly GateLabShinyCompensationApplication[];
}

export interface ShinySceHostOptions {
  manifestMessage?: string;
  readyInput?: string;
  requestInput?: string;
  responseMessage?: string;
  compensationProgressMessage?: string;
  requestTimeoutMs?: number;
  compensationRequestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GateLabShinyCompensationApplication {
  contractVersion: typeof GATELAB_HOST_COMPENSATION_CONTRACT_VERSION;
  datasetId: string;
  profileJson: string;
  sourceAssayId: string;
  execution?: "computed" | "adopted-existing-assay";
  outputAssay: GateLabHostCompensationApplication["outputAssay"];
  targetSampleIds: readonly string[] | string;
  activeSampleIds: readonly string[] | string;
  appliedAt: string;
}

interface GateLabShinyAppliedAssayTarget {
  sampleId: string;
  eventCount: number;
  assayUrl: string;
}

interface GateLabShinyCompensationApplyResult {
  application: GateLabShinyCompensationApplication;
  targets:
    | readonly GateLabShinyAppliedAssayTarget[]
    | GateLabShinyAppliedAssayTarget;
}

interface GateLabShinyHostResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
  errorData?: unknown;
}

interface PendingHostRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timeout: number;
  onProgress?: (progress: GateLabHostCompensationProgress) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface GateLabShinyCompensationProgress
  extends GateLabHostCompensationProgress {
  requestId: string;
}

function hostResponse(message: unknown): GateLabShinyHostResponse | null {
  if (!message || typeof message !== "object") return null;
  const candidate = message as Partial<GateLabShinyHostResponse>;
  if (
    typeof candidate.requestId !== "string" ||
    candidate.requestId.length === 0 ||
    typeof candidate.ok !== "boolean"
  ) return null;
  return candidate as GateLabShinyHostResponse;
}

function hostCompensationProgress(
  message: unknown,
): GateLabShinyCompensationProgress | null {
  if (!message || typeof message !== "object") return null;
  const candidate = message as Partial<GateLabShinyCompensationProgress>;
  const numerical = [
    candidate.sampleIndex,
    candidate.sampleCount,
    candidate.sampleProcessedEvents,
    candidate.sampleTotalEvents,
    candidate.processedEvents,
    candidate.totalEvents,
    candidate.fraction,
  ];
  if (
    typeof candidate.requestId !== "string" ||
    candidate.requestId.length === 0 ||
    typeof candidate.jobId !== "string" ||
    candidate.jobId.length === 0 ||
    numerical.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) return null;
  return candidate as GateLabShinyCompensationProgress;
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `gatelabr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function validateManifest(message: unknown): GateLabShinyManifest {
  if (!message || typeof message !== "object") {
    throw new Error("GateLabR supplied an invalid SCE host manifest.");
  }
  const candidate = message as Partial<GateLabShinyManifest>;
  if (candidate.contractVersion !== GATELAB_DATASET_CONTRACT_VERSION) {
    throw new Error(
      `Unsupported GateLabR dataset contract ${String(candidate.contractVersion)}; ` +
      `expected ${GATELAB_DATASET_CONTRACT_VERSION}.`,
    );
  }
  if (!Array.isArray(candidate.datasets) || !Array.isArray(candidate.resources)) {
    throw new Error("GateLabR supplied an incomplete SCE host manifest.");
  }
  return candidate as GateLabShinyManifest;
}

function resourceKey(datasetId: string, sampleId: string): string {
  return JSON.stringify([datasetId, sampleId]);
}

function hostStringArray(value: readonly string[] | string): string[] {
  return typeof value === "string" ? [value] : Array.from(value);
}

function hostObjectArray<T>(value: readonly T[] | T): T[] {
  return Array.isArray(value) ? Array.from(value) : [value as T];
}

async function fetchBinary(
  fetchImpl: typeof fetch,
  url: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetchImpl(url, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `GateLabR assay request failed (${response.status} ${response.statusText}).`,
    );
  }
  return response.arrayBuffer();
}

/**
 * Create the thin GateLabR host adapter. Shiny sends only a compact manifest
 * over its websocket; large assays are fetched as session-scoped binary files.
 */
export function createShinySceHost(
  options: ShinySceHostOptions = {},
): GateLabHostAdapter {
  const shiny = window.Shiny;
  if (!shiny) {
    throw new Error("GateLabR's Shiny client is unavailable.");
  }
  const manifestMessage = options.manifestMessage ?? "gatelabr-host-manifest";
  const readyInput = options.readyInput ?? "gatelabr_react_ready";
  const requestInput = options.requestInput ?? "gatelabr_host_request";
  const responseMessage = options.responseMessage ?? "gatelabr-host-response";
  const compensationProgressMessage =
    options.compensationProgressMessage ??
    "gatelabr-host-compensation-progress";
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const compensationRequestTimeoutMs =
    options.compensationRequestTimeoutMs ?? 30 * 60_000;
  const fetchImpl = options.fetchImpl ?? window.fetch.bind(window);

  let resolveManifest!: (manifest: GateLabShinyManifest) => void;
  let rejectManifest!: (reason: unknown) => void;
  const manifestPromise = new Promise<GateLabShinyManifest>((resolve, reject) => {
    resolveManifest = resolve;
    rejectManifest = reject;
  });

  shiny.addCustomMessageHandler(manifestMessage, (message) => {
    try {
      resolveManifest(validateManifest(message));
    } catch (error) {
      rejectManifest(error);
    }
  });

  const pendingRequests = new Map<string, PendingHostRequest>();
  const clearPendingRequest = (
    id: string,
    pending: PendingHostRequest,
  ): void => {
    pendingRequests.delete(id);
    window.clearTimeout(pending.timeout);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
    }
  };
  shiny.addCustomMessageHandler(responseMessage, (message) => {
    const response = hostResponse(message);
    if (!response) return;
    const pending = pendingRequests.get(response.requestId);
    if (!pending) return;
    clearPendingRequest(response.requestId, pending);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      const message =
        typeof response.error === "string" && response.error.length > 0
          ? response.error
          : "GateLabR could not complete the requested SCE update.";
      // A revision conflict keeps its numbers so the caller can resync; everything else is a
      // plain failure.
      const conflict = workspaceConflictFrom(response.errorCode, response.errorData);
      pending.reject(
        conflict
          ? new GateLabWorkspaceConflictError(message, conflict)
          : new Error(message),
      );
    }
  });
  shiny.addCustomMessageHandler(compensationProgressMessage, (message) => {
    const progress = hostCompensationProgress(message);
    if (!progress) return;
    pendingRequests.get(progress.requestId)?.onProgress?.(progress);
  });

  const sendRequest = async <TResult>(
    operation: string,
    payload: unknown,
    timeoutMs = requestTimeoutMs,
    signal?: AbortSignal,
    onProgress?: (progress: GateLabHostCompensationProgress) => void,
  ): Promise<TResult> => {
    if (shiny.initializedPromise) await shiny.initializedPromise;
    if (typeof shiny.setInputValue !== "function") {
      throw new Error("GateLabR's Shiny input API did not initialize.");
    }
    const id = requestId();
    const result = new Promise<TResult>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        const pending = pendingRequests.get(id);
        if (pending) clearPendingRequest(id, pending);
        reject(new Error(
          `GateLabR did not acknowledge '${operation}' within ${Math.round(timeoutMs / 1000)} seconds.`,
        ));
      }, timeoutMs);
      const pending: PendingHostRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        ...(onProgress ? { onProgress } : {}),
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        pending.abortHandler = () => {
          const active = pendingRequests.get(id);
          if (!active) return;
          clearPendingRequest(id, active);
          shiny.setInputValue?.(
            requestInput,
            {
              requestId: requestId(),
              operation: "cancel-compensation",
              payload: { requestId: id },
            },
            { priority: "event" },
          );
          reject(new CompensationCancelledError("Cancelled by the user."));
        };
        if (signal.aborted) {
          window.clearTimeout(timeout);
          reject(new CompensationCancelledError("Cancelled by the user."));
          return;
        }
        signal.addEventListener("abort", pending.abortHandler, { once: true });
      }
      pendingRequests.set(id, pending);
    });
    shiny.setInputValue(
      requestInput,
      { requestId: id, operation, payload },
      { priority: "event" },
    );
    return result;
  };

  const resources = async (): Promise<Map<string, GateLabShinyResourceDescriptor>> => {
    const manifest = await manifestPromise;
    return new Map(
      manifest.resources.map((resource) => [
        resourceKey(resource.datasetId, resource.sampleId),
        resource,
      ]),
    );
  };

  const datasets: GateLabHostDatasetPort = {
    async listDatasets() {
      return (await manifestPromise).datasets;
    },
    async readAssay(datasetId, sampleId, assayId, signal) {
      const resource = (await resources()).get(resourceKey(datasetId, sampleId));
      const url = resource?.assayUrls[assayId];
      if (!url) {
        throw new Error(
          `GateLabR has no assay '${assayId}' for sample '${sampleId}'.`,
        );
      }
      return fetchBinary(fetchImpl, url, signal);
    },
    async readEventIndex(datasetId, sampleId, signal) {
      const resource = (await resources()).get(resourceKey(datasetId, sampleId));
      if (!resource) {
        throw new Error(`GateLabR has no event index for sample '${sampleId}'.`);
      }
      return fetchBinary(fetchImpl, resource.eventIndexUrl, signal);
    },
  };
  const workspaces: GateLabHostWorkspacePort = {
    async readWorkspace(datasetId: string) {
      const workspace = (await manifestPromise).workspace ?? null;
      if (!workspace) return null;
      if (
        workspace.contractVersion !==
          GATELAB_HOST_WORKSPACE_CONTRACT_VERSION ||
        workspace.datasetId !== datasetId
      ) {
        throw new Error(
          "GateLabR supplied an incompatible SCE workspace envelope.",
        );
      }
      return {
        ...workspace,
        revision: Number.isInteger(workspace.revision) && workspace.revision >= 0
          ? workspace.revision
          : 0,
      };
    },
    async writeWorkspace(request) {
      return sendRequest<GateLabHostWorkspaceWriteResult>(
        "write-workspace",
        request,
      );
    },
  };
  const colData: GateLabHostColDataPort = {
    async writeColumns(request) {
      if (request.contractVersion !== GATELAB_HOST_COLDATA_CONTRACT_VERSION) {
        throw new Error("GateLab supplied an incompatible colData write request.");
      }
      return sendRequest<GateLabHostColDataWriteResult>(
        "write-coldata",
        request,
      );
    },
    async writeCategoricalColumns(request) {
      if (request.contractVersion !== GATELAB_HOST_COLDATA_CONTRACT_VERSION) {
        throw new Error("GateLab supplied an incompatible categorical colData write request.");
      }
      return sendRequest<GateLabHostCategoricalWriteResult>(
        "write-categorical-coldata",
        request,
      );
    },
  };
  const rowData: GateLabHostRowDataPort = {
    async writeChannelLabels(request) {
      if (request.contractVersion !== GATELAB_HOST_ROWDATA_CONTRACT_VERSION) {
        throw new Error("GateLab supplied an incompatible rowData write request.");
      }
      return sendRequest<GateLabHostRowDataWriteResult>(
        "write-rowdata-labels",
        request,
      );
    },
  };
  const dynamicApplications =
    new Map<string, GateLabShinyCompensationApplyResult>();

  const decodeApplication = async (
    application: GateLabShinyCompensationApplication,
  ): Promise<GateLabHostCompensationApplication> => {
    if (
      application.contractVersion !==
        GATELAB_HOST_COMPENSATION_CONTRACT_VERSION ||
      typeof application.profileJson !== "string"
    ) {
      throw new Error(
        "GateLabR supplied an incompatible compensation application.",
      );
    }
    const profile = await validateCompensationProfileRecord(
      JSON.parse(application.profileJson),
    );
    return {
      contractVersion: GATELAB_HOST_COMPENSATION_CONTRACT_VERSION,
      datasetId: application.datasetId,
      profile,
      sourceAssayId: application.sourceAssayId,
      execution: application.execution === "adopted-existing-assay"
        ? "adopted-existing-assay"
        : "computed",
      outputAssay: application.outputAssay,
      targetSampleIds: hostStringArray(application.targetSampleIds),
      activeSampleIds: hostStringArray(application.activeSampleIds),
      appliedAt: application.appliedAt,
    };
  };

  const materializeApplication = async (
    raw: GateLabShinyCompensationApplyResult,
    signal?: AbortSignal,
  ): Promise<GateLabHostCompensationApplyResult> => {
    const application = await decodeApplication(raw.application);
    const targets = await Promise.all(hostObjectArray(raw.targets).map(async (target) => ({
      sampleId: target.sampleId,
      eventCount: target.eventCount,
      assayPayload: await fetchBinary(fetchImpl, target.assayUrl, signal),
    })));
    return { application, targets };
  };

  const storedRawApplication = async (
    datasetId: string,
    profileId: string,
  ): Promise<GateLabShinyCompensationApplyResult | null> => {
    const dynamic = dynamicApplications.get(profileId);
    if (dynamic?.application.datasetId === datasetId) return dynamic;
    const manifest = await manifestPromise;
    const descriptor = (manifest.compensationApplications ?? []).find(
      (candidate) => {
        if (candidate.datasetId !== datasetId) return false;
        try {
          const parsed = JSON.parse(candidate.profileJson) as {
            profileId?: unknown;
          };
          return parsed.profileId === profileId;
        } catch {
          return false;
        }
      },
    );
    if (!descriptor) return null;
    const resourceMap = await resources();
    const sampleById = new Map(
      manifest.datasets
        .find(({ id }) => id === datasetId)
        ?.samples.map((sample) => [sample.id, sample]) ?? [],
    );
    const targets = hostStringArray(descriptor.targetSampleIds).map((sampleId) => {
      const resource = resourceMap.get(resourceKey(datasetId, sampleId));
      const assayUrl = resource?.assayUrls[descriptor.outputAssay.id];
      const sample = sampleById.get(sampleId);
      if (!assayUrl || !sample) {
        throw new Error(
          `GateLabR cannot restore compensated assay '${descriptor.outputAssay.id}' ` +
            `for sample '${sampleId}'.`,
        );
      }
      return {
        sampleId,
        eventCount: sample.eventCount,
        assayUrl,
      };
    });
    return { application: descriptor, targets };
  };

  const compensation: GateLabHostCompensationPort = {
    async applyProfile(
      request: GateLabHostCompensationApplyRequest,
      signal?: AbortSignal,
      onProgress?: (progress: GateLabHostCompensationProgress) => void,
    ) {
      if (
        request.contractVersion !==
          GATELAB_HOST_COMPENSATION_CONTRACT_VERSION
      ) {
        throw new Error(
          "GateLab supplied an incompatible host compensation request.",
        );
      }
      const { profile, ...hostRequest } = request;
      const raw = await sendRequest<GateLabShinyCompensationApplyResult>(
        "apply-compensation",
        {
          ...hostRequest,
          profileJson: JSON.stringify(profile),
        },
        compensationRequestTimeoutMs,
        signal,
        onProgress,
      );
      dynamicApplications.set(
        JSON.parse(raw.application.profileJson).profileId as string,
        raw,
      );
      return materializeApplication(raw, signal);
    },
    async adoptExistingAssay(
      request: GateLabHostCompensationAdoptRequest,
      signal?: AbortSignal,
    ) {
      if (
        request.contractVersion !==
          GATELAB_HOST_COMPENSATION_CONTRACT_VERSION
      ) {
        throw new Error(
          "GateLab supplied an incompatible host compensation request.",
        );
      }
      const { profile, ...hostRequest } = request;
      const raw = await sendRequest<GateLabShinyCompensationApplyResult>(
        "adopt-compensated-assay",
        {
          ...hostRequest,
          profileJson: JSON.stringify(profile),
        },
        compensationRequestTimeoutMs,
      );
      dynamicApplications.set(
        JSON.parse(raw.application.profileJson).profileId as string,
        raw,
      );
      return materializeApplication(raw, signal);
    },
    async readStoredApplication(datasetId, profileId, signal) {
      const raw = await storedRawApplication(datasetId, profileId);
      return raw ? materializeApplication(raw, signal) : null;
    },
  };

  return {
    contractVersion: GATELAB_HOST_CONTRACT_VERSION,
    id: "gatelabr-shiny-sce",
    kind: "r-sce",
    label: "GateLabR / SingleCellExperiment",
    capabilities: {
      dataSources: {
        fcsFiles: false,
        singleCellExperiment: true,
      },
      dataModel: {
        multipleAssays: true,
        sampleMetadata: true,
        writeBackColumns: true,
      },
      persistence: {
        workspaceFiles: false,
        hostObject: true,
        fileSystemAccess: false,
        directoryAccess: false,
      },
      compute: {
        location: "host",
      },
    },
    datasets,
    workspaces,
    colData,
    rowData,
    compensation,
    lifecycle: {
      mounted() {
        const signalReady = async () => {
          // Shiny constructs window.Shiny before initialize() installs its
          // input API. Its initialization promise remains usable whether this
          // bundle mounts before or after shiny:sessioninitialized.
          if (shiny.initializedPromise) {
            await shiny.initializedPromise;
          }
          if (typeof shiny.setInputValue !== "function") {
            throw new Error("GateLabR's Shiny input API did not initialize.");
          }
          shiny.setInputValue(
            readyInput,
            {
              contractVersion: GATELAB_HOST_CONTRACT_VERSION,
              nonce: Date.now(),
            },
            { priority: "event" },
          );
        };
        void signalReady().catch(rejectManifest);
      },
    },
  };
}
