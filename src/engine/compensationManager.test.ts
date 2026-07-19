import { describe, expect, it, vi } from "vitest";
import {
  CompensationCancelledError,
  CompensationManager,
  planCompensationChunks,
  type CompensationWorkerLike,
} from "./compensationManager";
import {
  compensateFlowColumns,
  prepareFlowCompensation,
} from "./flowCompensationEngine";
import { validateAndCanonicalizeCompensationMatrix } from "./compensationProfile";
import {
  createCompensationBaselineProfile,
  type CompensationProfileRecord,
} from "./compensationProfileRecord";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import type {
  CompensationWorkerRequest,
  CompensationWorkerResponse,
} from "../workers/compensationProtocol";
import { createCompensationWorkerRuntime } from "../workers/compensationWorkerRuntime";

function flowFcs(offset = 0): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: 5,
    instrument: "flow",
    keywords: {},
    // Deliberately put FL2 before FL1: matrix order must never be inferred from FCS position.
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262_144 },
      { index: 1, name: "FL2-A", marker: "CD19", bits: 32, range: 262_144 },
      { index: 2, name: "FL1-A", marker: "CD3", bits: 32, range: 262_144 },
      { index: 3, name: "Time", marker: null, bits: 32, range: 262_144 },
    ],
    columns: [
      Float32Array.from([100, 200, 300, 400, 500], (value) => value + offset),
      Float32Array.from([15, -3, 40, 7, 80], (value) => value + offset),
      Float32Array.from([100, 75, -20, 4, 500], (value) => value + offset),
      Float32Array.from([0, 1, 2, 3, 4]),
    ],
    spillover: null,
  };
}

function cytofFcs(): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: 5,
    instrument: "cytof",
    keywords: {},
    channels: [
      { index: 0, name: "B", marker: "Marker B", bits: 32, range: 262_144 },
      { index: 1, name: "C", marker: "Marker C", bits: 32, range: 262_144 },
      { index: 2, name: "A", marker: "Marker A", bits: 32, range: 262_144 },
      { index: 3, name: "D", marker: "Dump", bits: 32, range: 262_144 },
    ],
    columns: [
      new Float32Array([11, 12, 13, 14, 15]),
      new Float32Array([8, 2, 5, 4.6, 2.6]),
      new Float32Array([5, 10, 0, 3, 8]),
      new Float32Array([99, 98, 97, 96, 95]),
    ],
    spillover: null,
  };
}

async function flowProfile(
  matrix: readonly (readonly number[])[] = [[1, 0.12], [0.04, 1]],
  sourceChannels: readonly string[] = ["FL1-A", "FL2-A"],
  receiverChannels: readonly string[] = ["FL1-A", "FL2-A"],
): Promise<CompensationProfileRecord> {
  const canonical = validateAndCanonicalizeCompensationMatrix({
    sourceChannels,
    receiverChannels,
    matrix,
  }, "flow-spillover");
  if (!canonical.ok) throw new Error(canonical.errors.map(({ message }) => message).join(" "));
  return createCompensationBaselineProfile({
    kind: "flow-spillover",
    method: "matrix-inverse",
    solverVersion: "flow-lu-v1",
    solverSettings: {
      singularTolerance: 1e-12,
      conditionWarningThreshold: 1e8,
    },
    matrix: canonical.value,
  }, {
    profileId: "flow-profile-1",
    name: "Flow profile",
    createdAt: "2026-07-18T00:00:00.000Z",
    origin: {
      type: "uploaded",
      fileName: "spill.csv",
      format: "csv",
      sourceColumnHeader: "source",
    },
  });
}

async function cytofProfile(): Promise<CompensationProfileRecord> {
  const canonical = validateAndCanonicalizeCompensationMatrix({
    sourceChannels: ["A", "B"],
    receiverChannels: ["A", "B", "C", "D"],
    matrix: [
      [1, 0.1, 0.2, 0.04],
      [0.05, 1, 0.3, 0.02],
    ],
  }, "cytof-spillover");
  if (!canonical.ok) throw new Error(canonical.errors.map(({ message }) => message).join(" "));
  return createCompensationBaselineProfile({
    kind: "cytof-spillover",
    method: "nnls",
    solverVersion: "coordinate-descent-qr-v1",
    solverSettings: {
      tolerance: 1e-10,
      kktTolerance: 1e-9,
      maxIterations: 1000,
      adaptationVersion: "identity-backed-v1",
    },
    matrix: canonical.value,
    includedChannels: ["A", "C"],
  }, {
    profileId: "cytof-profile-1",
    name: "CyTOF profile",
    createdAt: "2026-07-18T00:00:00.000Z",
    origin: {
      type: "uploaded",
      fileName: "cytof-spill.csv",
      format: "csv",
      sourceColumnHeader: "channel",
    },
  });
}

class RuntimeWorker implements CompensationWorkerLike {
  onmessage: ((event: MessageEvent<CompensationWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: CompensationWorkerRequest[] = [];
  maxChunksInFlight = 0;
  chunksInFlight = 0;
  terminated = false;
  onRequest: ((request: CompensationWorkerRequest) => void) | null = null;
  private readonly runtime;

  constructor(yieldToEventLoop: () => Promise<void> = () => Promise.resolve()) {
    this.runtime = createCompensationWorkerRuntime({
      emit: (response) => {
        if (response.type === "apply-chunk-complete") this.chunksInFlight--;
        this.onmessage?.({ data: response } as MessageEvent<CompensationWorkerResponse>);
      },
      yieldToEventLoop,
      microbatchEvents: 1,
    });
  }

  postMessage(message: CompensationWorkerRequest): void {
    this.requests.push(message);
    if (message.type === "apply-chunk") {
      this.chunksInFlight++;
      this.maxChunksInFlight = Math.max(this.maxChunksInFlight, this.chunksInFlight);
    }
    this.runtime.dispatch(message);
    this.onRequest?.(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

class ExplodingWorker implements CompensationWorkerLike {
  onmessage: ((event: MessageEvent<CompensationWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(): void {
    this.onerror?.({ message: "synthetic worker crash" } as ErrorEvent);
  }

  terminate(): void {}
}

class TransformingRuntimeWorker implements CompensationWorkerLike {
  onmessage: ((event: MessageEvent<CompensationWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: CompensationWorkerRequest[];
  private readonly inner: RuntimeWorker;

  constructor(
    transform: (response: CompensationWorkerResponse) => CompensationWorkerResponse,
  ) {
    this.inner = new RuntimeWorker();
    this.requests = this.inner.requests;
    this.inner.onmessage = (event) => {
      this.onmessage?.({ data: transform(event.data) } as MessageEvent<CompensationWorkerResponse>);
    };
    this.inner.onerror = (event) => this.onerror?.(event);
  }

  postMessage(message: CompensationWorkerRequest): void {
    this.inner.postMessage(message);
  }

  terminate(): void {
    this.inner.terminate();
  }
}

function tamperFirstBinding<
  T extends Readonly<{
    pnn: string;
    fcsColumnIndex: number;
    matrixSourceIndex: number;
    matrixReceiverIndex: number;
  }>,
>(bindings: readonly T[]): readonly T[] {
  return bindings.map((binding, index) => index === 0
    ? { ...binding, pnn: `${binding.pnn}-tampered` } as T
    : binding);
}

function emptyFlowFcs(): FcsFile {
  const base = flowFcs();
  return {
    ...base,
    nEvents: 0,
    columns: base.columns.map(() => new Float32Array(0)),
  };
}

function compensatedValues(sample: Sample, pnn: string): Float32Array {
  const index = sample.channels.findIndex((channel) => channel.pnn === pnn);
  if (index < 0) throw new Error(`Missing channel ${pnn}.`);
  return sample.compensatedColumnData(index) as Float32Array;
}

describe("compensation chunk planning", () => {
  it("accounts for Float64 input, Float32 output, and fixed solver workspace", () => {
    const plan = planCompensationChunks({
      totalEvents: 11,
      channelCount: 2,
      byteBudget: 1_048,
      fixedWorkspaceBytes: 1_000,
    });
    expect(plan.bytesPerEvent).toBe(24);
    expect(plan.transientByteBudget).toBe(48);
    expect(plan.eventsPerChunk).toBe(2);
    expect(plan.chunkCount).toBe(6);
    expect(planCompensationChunks({
      totalEvents: 20_000,
      channelCount: 2,
      byteBudget: 64 * 1024 * 1024,
      fixedWorkspaceBytes: 0,
    })).toMatchObject({ eventsPerChunk: 8_192, chunkCount: 3 });
    expect(() => planCompensationChunks({
      totalEvents: 1,
      channelCount: 2,
      byteBudget: 1_023,
      fixedWorkspaceBytes: 1_000,
    })).toThrow(/at least 1024 bytes/);
  });
});

describe("CompensationManager Apply", () => {
  it("uses immutable original values, exact PnN mapping, one chunk in flight, and source-order output", async () => {
    const sample = new Sample(flowFcs());
    const profile = await flowProfile();
    const worker = new RuntimeWorker();
    const manager = new CompensationManager({
      workspaceKey: "workspace-1",
      workerFactory: () => worker,
      byteBudget: 48,
      fixedWorkspaceBytes: 0,
      copySliceEvents: 1,
      yieldToEventLoop: () => Promise.resolve(),
    });
    const originalFl1 = Float32Array.from(sample.fcs.columns[2]);
    const originalFl2 = Float32Array.from(sample.fcs.columns[1]);
    const progress: number[] = [];
    const dataListener = vi.fn();
    const layerListener = vi.fn();
    sample.subscribeDataRevision(dataListener);
    sample.subscribeLayerRevision(layerListener);

    await manager.apply({
      profile,
      targets: [{ sample }],
      onProgress: ({ processedEvents }) => progress.push(processedEvents),
    });

    const expected = compensateFlowColumns(
      [Float64Array.from(originalFl1), Float64Array.from(originalFl2)],
      prepareFlowCompensation(profile.scientific.matrix.matrix),
      { output: "float32" },
    );
    expect(new Uint8Array(compensatedValues(sample, "FL1-A").buffer)).toEqual(
      new Uint8Array(expected.columns[0].buffer),
    );
    expect(new Uint8Array(compensatedValues(sample, "FL2-A").buffer)).toEqual(
      new Uint8Array(expected.columns[1].buffer),
    );
    expect(sample.fcs.columns[2]).toEqual(originalFl1);
    expect(sample.fcs.columns[1]).toEqual(originalFl2);
    expect(worker.maxChunksInFlight).toBe(1);
    expect(worker.requests.filter(({ type }) => type === "apply-chunk")).toHaveLength(3);
    expect(progress).toEqual([0, 2, 4, 5]);
    expect(sample.dataRevision).toBe(1);
    expect(sample.layerRevision).toBe(1);
    expect(dataListener).toHaveBeenCalledTimes(1);
    expect(layerListener).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it("applies CyTOF NNLS with rectangular adaptation, exclusions, and receiver-only outputs", async () => {
    const sample = new Sample(cytofFcs());
    const profile = await cytofProfile();
    const worker = new RuntimeWorker();
    const manager = new CompensationManager({
      workspaceKey: "workspace-cytof",
      workerFactory: () => worker,
      byteBudget: 48,
      fixedWorkspaceBytes: 0,
      copySliceEvents: 1,
      yieldToEventLoop: () => Promise.resolve(),
    });
    const originalB = Float32Array.from(sample.fcs.columns[0]);
    const originalD = Float32Array.from(sample.fcs.columns[3]);

    const result = await manager.apply({ profile, targets: [{ sample }] });

    const compensatedA = compensatedValues(sample, "A");
    const compensatedC = compensatedValues(sample, "C");
    const expectedA = [5, 10, 0, 3, 8];
    const expectedC = [7, 0, 5, 4, 1];
    for (let event = 0; event < expectedA.length; event++) {
      expect(compensatedA[event]).toBeCloseTo(expectedA[event], 5);
      expect(compensatedC[event]).toBeCloseTo(expectedC[event], 5);
    }
    expect(compensatedValues(sample, "B")).toEqual(originalB);
    expect(compensatedValues(sample, "D")).toEqual(originalD);
    expect(sample.activeLayer).toBe("compensated");
    expect(result.targets[0].binding).toMatchObject({
      kind: "cytof-spillover",
      method: "nnls",
      includedPnns: ["A", "C"],
      transformBinding: { kind: "cytof-asinh", cofactor: 5 },
    });
    expect(result.targets[0].binding.channelBindings.find(({ pnn }) => pnn === "C"))
      .toMatchObject({ matrixSourceIndex: null, included: true });
    expect(worker.requests.find((request) => request.type === "start-apply"))
      .toMatchObject({
        method: "nnls",
        sourceChannels: ["A", "C"],
        receiverChannels: ["A", "C"],
        matrix: [[1, 0.2], [0, 1]],
      });
    manager.dispose();
  });

  it("installs exact source-labelled columns when source and receiver axes are reversed", async () => {
    const sourceFl1 = new Float32Array([10, 20, -5, 8, 2]);
    const sourceFl2 = new Float32Array([3, 7, 4, -1, 9]);
    const matrix = [
      [0.2, 1],
      [1, 0.1],
    ] as const;
    const measuredFl2 = Float32Array.from(sourceFl1, (value, event) => {
      return value * matrix[0][0] + sourceFl2[event] * matrix[1][0];
    });
    const measuredFl1 = Float32Array.from(sourceFl1, (value, event) => {
      return value * matrix[0][1] + sourceFl2[event] * matrix[1][1];
    });
    const base = flowFcs();
    const sample = new Sample({
      ...base,
      columns: [base.columns[0], measuredFl2, measuredFl1, base.columns[3]],
    });
    const profile = await flowProfile(
      matrix,
      ["FL1-A", "FL2-A"],
      ["FL2-A", "FL1-A"],
    );
    const manager = new CompensationManager({
      workspaceKey: "workspace-axis-permutation",
      workerFactory: () => new RuntimeWorker(),
      byteBudget: 120,
      fixedWorkspaceBytes: 0,
      yieldToEventLoop: () => Promise.resolve(),
    });

    const result = await manager.apply({ profile, targets: [{ sample }] });

    expect(result.targets[0]).not.toHaveProperty("columns");
    for (const [actual, expected] of [
      [compensatedValues(sample, "FL1-A"), sourceFl1],
      [compensatedValues(sample, "FL2-A"), sourceFl2],
    ] as const) {
      expect(actual).toHaveLength(expected.length);
      for (let event = 0; event < expected.length; event++) {
        expect(actual[event]).toBeCloseTo(expected[event], 5);
      }
    }
    manager.dispose();
  });

  it("installs multiple samples atomically and observers never see a half-committed batch", async () => {
    const first = new Sample(flowFcs());
    const second = new Sample(flowFcs(3));
    const profile = await flowProfile();
    const manager = new CompensationManager({
      workspaceKey: "workspace-atomic",
      workerFactory: () => new RuntimeWorker(),
      byteBudget: 120,
      fixedWorkspaceBytes: 0,
      yieldToEventLoop: () => Promise.resolve(),
    });
    const observedSecondState: string[] = [];
    first.subscribeLayerRevision(() => {
      observedSecondState.push(second.compensatedLayerStatus().state);
    });

    await manager.apply({ profile, targets: [{ sample: first }, { sample: second }] });

    expect(first.compensatedLayerStatus().state).toBe("ready");
    expect(second.compensatedLayerStatus().state).toBe("ready");
    expect(observedSecondState).toEqual(["ready"]);
    expect([first.dataRevision, first.layerRevision]).toEqual([1, 1]);
    expect([second.dataRevision, second.layerRevision]).toEqual([1, 1]);
    manager.dispose();
  });

  it("discards every computed target when another target becomes stale before installation", async () => {
    const first = new Sample(flowFcs());
    const second = new Sample(flowFcs(4));
    const profile = await flowProfile();
    const manager = new CompensationManager({
      workspaceKey: "workspace-stale-target",
      workerFactory: () => new RuntimeWorker(),
      byteBudget: 120,
      fixedWorkspaceBytes: 0,
      yieldToEventLoop: () => Promise.resolve(),
    });
    let invalidated = false;
    const apply = manager.apply({
      profile,
      targets: [{ sample: first }, { sample: second }],
      onProgress: ({ sampleIndex, sampleProcessedEvents, sampleTotalEvents }) => {
        if (!invalidated && sampleIndex === 0 && sampleProcessedEvents === sampleTotalEvents) {
          invalidated = true;
          second.setInstrumentMode("cytof");
        }
      },
    });

    await expect(apply).rejects.toMatchObject({ code: "stale-sample" });
    expect(first.compensatedLayerStatus().state).toBe("missing");
    expect(second.compensatedLayerStatus().state).toBe("missing");
    expect(first.dataRevision).toBe(0);
    expect(first.layerRevision).toBe(0);
    manager.dispose();
  });

  it("cancels an in-flight chunk on workspace replacement without installing partial output", async () => {
    const sample = new Sample(flowFcs());
    const profile = await flowProfile();
    const worker = new RuntimeWorker(
      () => new Promise((resolve) => setTimeout(resolve, 0)),
    );
    const manager = new CompensationManager({
      workspaceKey: "workspace-old",
      workerFactory: () => worker,
      byteBudget: 120,
      fixedWorkspaceBytes: 0,
      copySliceEvents: 1,
      yieldToEventLoop: () => Promise.resolve(),
    });
    let reset = false;
    worker.onRequest = (request) => {
      if (!reset && request.type === "apply-chunk") {
        reset = true;
        manager.resetWorkspace("workspace-new");
      }
    };

    await expect(manager.apply({ profile, targets: [{ sample }] })).rejects.toBeInstanceOf(
      CompensationCancelledError,
    );
    expect(sample.compensatedLayerStatus().state).toBe("missing");
    expect(sample.dataRevision).toBe(0);
    expect(sample.layerRevision).toBe(0);
    expect(worker.requests.some((request) => request.type === "cancel" && request.target === "apply")).toBe(true);
    manager.dispose();
  });

  it("recreates a crashed worker and allows a clean retry", async () => {
    const sample = new Sample(flowFcs());
    const profile = await flowProfile();
    let factoryCalls = 0;
    const manager = new CompensationManager({
      workspaceKey: "workspace-retry",
      workerFactory: () => {
        factoryCalls++;
        return factoryCalls === 1 ? new ExplodingWorker() : new RuntimeWorker();
      },
      byteBudget: 120,
      fixedWorkspaceBytes: 0,
      yieldToEventLoop: () => Promise.resolve(),
    });

    await expect(manager.apply({ profile, targets: [{ sample }] })).rejects.toMatchObject({
      code: "worker-exception",
    });
    expect(sample.compensatedLayerStatus().state).toBe("missing");
    await expect(manager.apply({ profile, targets: [{ sample }] })).resolves.toMatchObject({
      profile: { profileId: profile.profileId },
    });
    expect(factoryCalls).toBe(2);
    expect(sample.compensatedLayerStatus().state).toBe("ready");
    manager.dispose();
  });

  it.each([
    "apply-started",
    "apply-chunk-complete",
    "apply-complete",
  ] as const)("rejects tampered source identity in the %s response", async (responseType) => {
    const sample = new Sample(flowFcs());
    const profile = await flowProfile();
    const worker = new TransformingRuntimeWorker((response) => {
      if (response.type !== responseType) return response;
      if (response.type === "apply-started") {
        return { ...response, sourceBindings: tamperFirstBinding(response.sourceBindings) };
      }
      return { ...response, outputBindings: tamperFirstBinding(response.outputBindings) };
    });
    const manager = new CompensationManager({
      workspaceKey: `workspace-tampered-${responseType}`,
      workerFactory: () => worker,
      byteBudget: 120,
      fixedWorkspaceBytes: 0,
      yieldToEventLoop: () => Promise.resolve(),
    });

    await expect(manager.apply({ profile, targets: [{ sample }] })).rejects.toMatchObject({
      code: responseType === "apply-started"
        ? "invalid-worker-binding"
        : "invalid-worker-result",
    });
    expect(sample.compensatedLayerStatus().state).toBe("missing");
    expect([sample.dataRevision, sample.layerRevision]).toEqual([0, 0]);
    manager.dispose();
  });

  it("rejects a non-finite worker result without installing a partial layer", async () => {
    const sample = new Sample(flowFcs());
    const profile = await flowProfile();
    const worker = new TransformingRuntimeWorker((response) => {
      if (response.type !== "apply-chunk-complete" || response.chunkIndex !== 0) {
        return response;
      }
      const columns = response.columns.map((column) => column.slice());
      columns[0][0] = Number.NaN;
      return { ...response, columns };
    });
    const manager = new CompensationManager({
      workspaceKey: "workspace-non-finite-worker",
      workerFactory: () => worker,
      byteBudget: 120,
      fixedWorkspaceBytes: 0,
      copySliceEvents: 1,
      yieldToEventLoop: () => Promise.resolve(),
    });

    await expect(manager.apply({ profile, targets: [{ sample }] })).rejects.toThrow(
      /non-finite value at event 1/,
    );
    expect(sample.compensatedLayerStatus().state).toBe("missing");
    expect([sample.dataRevision, sample.layerRevision]).toEqual([0, 0]);
    manager.dispose();
  });

  it("copies worker output into private staging before installation", async () => {
    const sample = new Sample(flowFcs());
    const profile = await flowProfile();
    const emittedColumns: Float32Array[] = [];
    const worker = new TransformingRuntimeWorker((response) => {
      if (response.type === "apply-chunk-complete") {
        emittedColumns.push(...response.columns);
      }
      return response;
    });
    const manager = new CompensationManager({
      workspaceKey: "workspace-private-staging",
      workerFactory: () => worker,
      byteBudget: 120,
      fixedWorkspaceBytes: 0,
      yieldToEventLoop: () => Promise.resolve(),
    });

    await manager.apply({ profile, targets: [{ sample }] });
    const installedFl1 = Float32Array.from(compensatedValues(sample, "FL1-A"));
    const installedFl2 = Float32Array.from(compensatedValues(sample, "FL2-A"));
    expect(emittedColumns.length).toBeGreaterThan(0);

    for (const column of emittedColumns) column.fill(Number.NaN);

    expect(compensatedValues(sample, "FL1-A")).toEqual(installedFl1);
    expect(compensatedValues(sample, "FL2-A")).toEqual(installedFl2);
    manager.dispose();
  });

  it("applies a zero-event sample as a complete empty compensated assay", async () => {
    const sample = new Sample(emptyFlowFcs());
    const profile = await flowProfile();
    const worker = new RuntimeWorker();
    const manager = new CompensationManager({
      workspaceKey: "workspace-zero-events",
      workerFactory: () => worker,
      byteBudget: 120,
      fixedWorkspaceBytes: 0,
      yieldToEventLoop: () => Promise.resolve(),
    });

    await expect(manager.apply({ profile, targets: [{ sample }] })).resolves.toMatchObject({
      profile: { profileId: profile.profileId },
    });
    expect(worker.requests.filter(({ type }) => type === "apply-chunk")).toHaveLength(0);
    expect(compensatedValues(sample, "FL1-A")).toEqual(new Float32Array(0));
    expect(compensatedValues(sample, "FL2-A")).toEqual(new Float32Array(0));
    expect(sample.compensatedLayerStatus().state).toBe("ready");
    expect([sample.dataRevision, sample.layerRevision]).toEqual([1, 1]);
    manager.dispose();
  });

  it("reserves Apply before asynchronous profile validation", async () => {
    const firstSample = new Sample(flowFcs());
    const secondSample = new Sample(flowFcs(2));
    const profile = await flowProfile();
    const manager = new CompensationManager({
      workspaceKey: "workspace-concurrent-apply",
      workerFactory: () => new RuntimeWorker(
        () => new Promise((resolve) => setTimeout(resolve, 0)),
      ),
      byteBudget: 120,
      fixedWorkspaceBytes: 0,
      yieldToEventLoop: () => Promise.resolve(),
    });

    expect(manager.applyInProgress).toBe(false);
    const firstApply = manager.apply({ profile, targets: [{ sample: firstSample }] });
    expect(manager.applyInProgress).toBe(true);
    const secondApply = manager.apply({ profile, targets: [{ sample: secondSample }] });

    await expect(secondApply).rejects.toMatchObject({ code: "apply-job-active" });
    await expect(firstApply).resolves.toMatchObject({
      profile: { profileId: profile.profileId },
    });
    expect(manager.applyInProgress).toBe(false);
    expect(firstSample.compensatedLayerStatus().state).toBe("ready");
    expect(secondSample.compensatedLayerStatus().state).toBe("missing");
    manager.dispose();
  });

  it("snapshots Apply targets and activation choices before asynchronous validation", async () => {
    const intended = new Sample(flowFcs());
    const substituted = new Sample(flowFcs(2));
    const profile = await flowProfile();
    const manager = new CompensationManager({
      workspaceKey: "workspace-apply-target-snapshot",
      workerFactory: () => new RuntimeWorker(),
      byteBudget: 120,
      fixedWorkspaceBytes: 0,
      yieldToEventLoop: () => Promise.resolve(),
    });
    const target: { sample: Sample; activeLayer: "original" | "compensated" } = {
      sample: intended,
      activeLayer: "compensated",
    };
    const targets = [target];

    const apply = manager.apply({ profile, targets });
    target.sample = substituted;
    target.activeLayer = "original";
    targets.push({ sample: substituted, activeLayer: "compensated" });
    await apply;

    expect(intended.compensatedLayerStatus().state).toBe("ready");
    expect(intended.activeLayer).toBe("compensated");
    expect(substituted.compensatedLayerStatus().state).toBe("missing");
    expect([substituted.dataRevision, substituted.layerRevision]).toEqual([0, 0]);
    manager.dispose();
  });

  it.each(["workspace", "sample", "profile"] as const)(
    "cancels a reserved Apply when its %s identity changes during profile validation",
    async (boundary) => {
      const sample = new Sample(flowFcs());
      const profile = await flowProfile();
      const worker = new RuntimeWorker();
      const manager = new CompensationManager({
        workspaceKey: "workspace-reservation-invalidation",
        workerFactory: () => worker,
        byteBudget: 120,
        fixedWorkspaceBytes: 0,
        yieldToEventLoop: () => Promise.resolve(),
      });

      const apply = manager.apply({ profile, targets: [{ sample }] });
      if (boundary === "workspace") manager.resetWorkspace("workspace-replaced");
      else if (boundary === "sample") manager.invalidateSample(sample);
      else manager.invalidateProfile(profile.profileId);

      await expect(apply).rejects.toBeInstanceOf(CompensationCancelledError);
      expect(worker.requests).toHaveLength(0);
      expect(sample.compensatedLayerStatus().state).toBe("missing");
      expect([sample.dataRevision, sample.layerRevision]).toEqual([0, 0]);
      manager.dispose();
    },
  );
});

describe("CompensationManager preview", () => {
  it("locks original events, lets the latest solve win, and never mutates Sample", async () => {
    const sample = new Sample(flowFcs());
    const profile = await flowProfile();
    const manager = new CompensationManager({
      workspaceKey: "workspace-preview",
      workerFactory: () => new RuntimeWorker(
        () => new Promise((resolve) => setTimeout(resolve, 0)),
      ),
      copySliceEvents: 1,
      yieldToEventLoop: () => Promise.resolve(),
    });
    const primed = await manager.primePreview({
      profile,
      sample,
      fixedEventIndices: new Uint32Array([0, 2, 4]),
    });
    const older = manager.solvePreview(primed.sessionId, [[1, 0.2], [0.04, 1]]);
    const latestMatrix = [[1, 0.08], [0.04, 1]] as const;
    const latest = manager.solvePreview(primed.sessionId, latestMatrix);

    await expect(older).rejects.toBeInstanceOf(CompensationCancelledError);
    const solved = await latest;
    const measured = [
      new Float64Array([100, -20, 500]),
      new Float64Array([15, 40, 80]),
    ];
    const expected = compensateFlowColumns(
      measured,
      prepareFlowCompensation(latestMatrix),
      { output: "float64" },
    );
    expect(solved.candidateColumns).toEqual(expected.columns);
    expect(sample.activeLayer).toBe("original");
    expect(sample.dataRevision).toBe(0);
    expect(sample.layerRevision).toBe(0);
    manager.dispose();
  });

  it("rejects a preview-prime receipt with tampered channel identity", async () => {
    const sample = new Sample(flowFcs());
    const profile = await flowProfile();
    const worker = new TransformingRuntimeWorker((response) => response.type === "preview-primed"
      ? { ...response, sourceBindings: tamperFirstBinding(response.sourceBindings) }
      : response);
    const manager = new CompensationManager({
      workspaceKey: "workspace-preview-prime-binding",
      workerFactory: () => worker,
      yieldToEventLoop: () => Promise.resolve(),
    });

    await expect(manager.primePreview({
      profile,
      sample,
      fixedEventIndices: new Uint32Array([0, 2, 4]),
    })).rejects.toMatchObject({ code: "invalid-worker-binding" });
    expect(sample.dataRevision).toBe(0);
    expect(sample.layerRevision).toBe(0);
    manager.dispose();
  });

  it.each([
    "receiver-binding",
    "source-channel-label",
    "column-shape",
    "sparse-binding",
    "sparse-columns",
    "non-finite-column",
    "impact-label",
    "ranked-impact-label",
  ] as const)("rejects a preview-solved response with tampered %s", async (tamper) => {
    const sample = new Sample(flowFcs());
    const profile = await flowProfile();
    const worker = new TransformingRuntimeWorker((response) => {
      if (response.type !== "preview-solved") return response;
      if (tamper === "receiver-binding") {
        return {
          ...response,
          receiverBindings: tamperFirstBinding(response.receiverBindings),
        };
      }
      if (tamper === "source-channel-label") {
        return {
          ...response,
          sourceChannels: response.sourceChannels.map((pnn, index) =>
            index === 0 ? `${pnn}-tampered` : pnn
          ),
        };
      }
      if (tamper === "column-shape") {
        return {
          ...response,
          candidateColumns: response.candidateColumns.slice(0, -1),
        };
      }
      if (tamper === "sparse-binding") {
        const sourceBindings = response.sourceBindings.slice();
        delete (sourceBindings as unknown as Record<number, unknown>)[0];
        return { ...response, sourceBindings };
      }
      if (tamper === "sparse-columns") {
        const currentColumns = response.currentColumns.slice();
        delete (currentColumns as unknown as Record<number, unknown>)[0];
        return { ...response, currentColumns };
      }
      if (tamper === "non-finite-column") {
        const candidateColumns = response.candidateColumns.map((column) => column.slice());
        candidateColumns[0][0] = Number.NaN;
        return { ...response, candidateColumns };
      }
      if (tamper === "impact-label") {
        return {
          ...response,
          impacts: response.impacts.map((impact, index) => index === 0
            ? { ...impact, channel: `${impact.channel}-tampered` }
            : impact),
        };
      }
      return {
        ...response,
        impactRanking: response.impactRanking.map((impact, index) => index === 0
          ? { ...impact, channel: `${impact.channel}-tampered` }
          : impact),
      };
    });
    const manager = new CompensationManager({
      workspaceKey: `workspace-preview-solved-${tamper}`,
      workerFactory: () => worker,
      yieldToEventLoop: () => Promise.resolve(),
    });
    const primed = await manager.primePreview({
      profile,
      sample,
      fixedEventIndices: new Uint32Array([0, 2, 4]),
    });

    await expect(manager.solvePreview(
      primed.sessionId,
      [[1, 0.08], [0.04, 1]],
    )).rejects.toMatchObject({
      code: tamper === "receiver-binding" ||
        tamper === "source-channel-label" ||
        tamper === "sparse-binding"
        ? "invalid-worker-binding"
        : "invalid-worker-result",
    });
    expect(sample.dataRevision).toBe(0);
    expect(sample.layerRevision).toBe(0);
    manager.dispose();
  });

  it("snapshots fixed event indices before asynchronous validation", async () => {
    const sample = new Sample(flowFcs());
    const profile = await flowProfile();
    const worker = new RuntimeWorker();
    const manager = new CompensationManager({
      workspaceKey: "workspace-preview-fixed-snapshot",
      workerFactory: () => worker,
      yieldToEventLoop: () => Promise.resolve(),
    });
    const fixedEventIndices = new Uint32Array([0, 2, 4]);

    const prime = manager.primePreview({ profile, sample, fixedEventIndices });
    fixedEventIndices.fill(1);
    await prime;

    const request = worker.requests.find(
      (candidate): candidate is Extract<CompensationWorkerRequest, { type: "prime-preview" }> =>
        candidate.type === "prime-preview",
    );
    expect(request).toBeDefined();
    expect(Array.from(request!.fixedEventIndices)).toEqual([0, 2, 4]);
    expect(request!.measuredColumns).toEqual([
      new Float64Array([100, -20, 500]),
      new Float64Array([15, 40, 80]),
    ]);
    manager.dispose();
  });

  it("rejects an oversized fixed preview before creating worker work", async () => {
    const sample = new Sample(flowFcs());
    const profile = await flowProfile();
    const worker = new RuntimeWorker();
    const manager = new CompensationManager({
      workspaceKey: "workspace-preview-event-limit",
      workerFactory: () => worker,
      maxPreviewEvents: 2,
    });

    await expect(manager.primePreview({
      profile,
      sample,
      fixedEventIndices: new Uint32Array([0, 1, 2]),
    })).rejects.toMatchObject({ code: "preview-event-limit" });
    expect(worker.requests).toHaveLength(0);
    manager.dispose();
  });

  it("rejects a preview above its byte budget before creating worker work", async () => {
    const sample = new Sample(flowFcs());
    const profile = await flowProfile();
    const worker = new RuntimeWorker();
    const manager = new CompensationManager({
      workspaceKey: "workspace-preview-memory-limit",
      workerFactory: () => worker,
      previewByteBudget: 251,
    });

    await expect(manager.primePreview({
      profile,
      sample,
      fixedEventIndices: new Uint32Array([0, 1, 2]),
    })).rejects.toMatchObject({ code: "preview-memory-budget" });
    expect(worker.requests).toHaveLength(0);
    manager.dispose();
  });

  it.each(["workspace", "sample", "profile"] as const)(
    "cancels a reserved preview when its %s identity changes during profile validation",
    async (boundary) => {
      const sample = new Sample(flowFcs());
      const profile = await flowProfile();
      const worker = new RuntimeWorker();
      const manager = new CompensationManager({
        workspaceKey: "workspace-preview-reservation-invalidation",
        workerFactory: () => worker,
        yieldToEventLoop: () => Promise.resolve(),
      });

      const prime = manager.primePreview({
        profile,
        sample,
        fixedEventIndices: new Uint32Array([0, 2, 4]),
      });
      if (boundary === "workspace") manager.resetWorkspace("workspace-preview-replaced");
      else if (boundary === "sample") manager.invalidateSample(sample);
      else manager.invalidateProfile(profile.profileId);

      await expect(prime).rejects.toBeInstanceOf(CompensationCancelledError);
      expect(worker.requests).toHaveLength(0);
      expect([sample.dataRevision, sample.layerRevision]).toEqual([0, 0]);
      manager.dispose();
    },
  );

  it("lets a same-tick newer prime supersede an older reservation", async () => {
    const sample = new Sample(flowFcs());
    const profile = await flowProfile();
    const worker = new RuntimeWorker();
    const manager = new CompensationManager({
      workspaceKey: "workspace-preview-reservation-latest",
      workerFactory: () => worker,
      yieldToEventLoop: () => Promise.resolve(),
    });

    const older = manager.primePreview({
      profile,
      sample,
      fixedEventIndices: new Uint32Array([0]),
    });
    const latest = manager.primePreview({
      profile,
      sample,
      fixedEventIndices: new Uint32Array([4]),
    });

    await expect(older).rejects.toBeInstanceOf(CompensationCancelledError);
    await expect(latest).resolves.toMatchObject({ eventCount: 1 });
    const primeRequests = worker.requests.filter(
      (request): request is Extract<CompensationWorkerRequest, { type: "prime-preview" }> =>
        request.type === "prime-preview",
    );
    expect(primeRequests).toHaveLength(1);
    expect(Array.from(primeRequests[0].fixedEventIndices)).toEqual([4]);
    expect(primeRequests[0].measuredColumns).toEqual([
      new Float64Array([500]),
      new Float64Array([80]),
    ]);
    manager.dispose();
  });
});
