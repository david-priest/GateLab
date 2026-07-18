import { describe, expect, it } from "vitest";
import {
  compareFlowCompensation,
  compensateFlowColumns,
  prepareFlowCompensation,
} from "../engine/flowCompensationEngine";
import {
  COMPENSATION_WORKER_PROTOCOL,
  requestTransferables,
  type ApplyChunkRequest,
  type CompensationWorkerResponse,
  type PrimePreviewRequest,
  type SolvePreviewRequest,
  type StartApplyRequest,
} from "./compensationProtocol";
import { createCompensationWorkerRuntime } from "./compensationWorkerRuntime";

const CURRENT_MATRIX = [
  [1, 0.12],
  [0.04, 1],
] as const;

const CANDIDATE_MATRIX = [
  [1, 0.21],
  [0.04, 1],
] as const;

const PREVIEW_IDENTITY = {
  sessionId: "preview-1",
  sessionToken: "preview-token-1",
  profileHash: "profile-hash",
  bindingKey: "binding-key",
} as const;

const APPLY_IDENTITY = {
  jobId: "apply-1",
  jobToken: "apply-token-1",
  profileHash: "profile-hash",
  bindingKey: "binding-key",
} as const;

function previewPrime(
  measuredColumns: readonly Float64Array[],
  fixedEventIndices = Uint32Array.from(
    { length: measuredColumns[0]?.length ?? 0 },
    (_, index) => index,
  ),
): PrimePreviewRequest {
  return {
    protocol: COMPENSATION_WORKER_PROTOCOL,
    type: "prime-preview",
    method: "matrix-inverse",
    ...PREVIEW_IDENTITY,
    sourceChannels: ["source-a", "source-b"],
    receiverChannels: ["source-a", "source-b"],
    channelBindings: [
      {
        pnn: "source-a",
        fcsColumnIndex: 4,
        matrixSourceIndex: 0,
        matrixReceiverIndex: 0,
      },
      {
        pnn: "source-b",
        fcsColumnIndex: 7,
        matrixSourceIndex: 1,
        matrixReceiverIndex: 1,
      },
    ],
    fixedEventIndices,
    measuredColumns,
  };
}

function previewSolve(
  requestId: string,
  candidateMatrix: readonly (readonly number[])[] = CANDIDATE_MATRIX,
): SolvePreviewRequest {
  return {
    protocol: COMPENSATION_WORKER_PROTOCOL,
    type: "solve-preview",
    method: "matrix-inverse",
    ...PREVIEW_IDENTITY,
    requestId,
    currentMatrix: CURRENT_MATRIX,
    candidateMatrix,
  };
}

function applyStart(
  totalEvents: number,
  overrides: Partial<StartApplyRequest> = {},
): StartApplyRequest {
  return {
    protocol: COMPENSATION_WORKER_PROTOCOL,
    type: "start-apply",
    method: "matrix-inverse",
    ...APPLY_IDENTITY,
    sourceChannels: ["source-a", "source-b"],
    receiverChannels: ["source-a", "source-b"],
    channelBindings: [
      {
        pnn: "source-a",
        fcsColumnIndex: 4,
        matrixSourceIndex: 0,
        matrixReceiverIndex: 0,
      },
      {
        pnn: "source-b",
        fcsColumnIndex: 7,
        matrixSourceIndex: 1,
        matrixReceiverIndex: 1,
      },
    ],
    matrix: CANDIDATE_MATRIX,
    totalEvents,
    channelCount: 2,
    byteBudget: 16_384,
    ...overrides,
  };
}

function applyChunk(
  chunkIndex: number,
  startEvent: number,
  measuredColumns: readonly Float64Array[],
  overrides: Partial<ApplyChunkRequest> = {},
): ApplyChunkRequest {
  return {
    protocol: COMPENSATION_WORKER_PROTOCOL,
    type: "apply-chunk",
    ...APPLY_IDENTITY,
    chunkIndex,
    startEvent,
    measuredColumns,
    ...overrides,
  };
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for compensation worker response.");
}

function responseOfType<T extends CompensationWorkerResponse["type"]>(
  responses: readonly CompensationWorkerResponse[],
  type: T,
): Extract<CompensationWorkerResponse, { readonly type: T }> | undefined {
  return responses.find(
    (response): response is Extract<CompensationWorkerResponse, { readonly type: T }> =>
      response.type === type,
  );
}

describe("compensation worker runtime", () => {
  it("builds exact cancellable preview feedback from the primed fixed event set", async () => {
    const measured = [
      new Float64Array([100, 75, -20, 4, 500]),
      new Float64Array([12, -5, 33, 8, 90]),
    ] as const;
    const fixed = new Uint32Array([2, 9, 20, 101, 503]);
    const responses: CompensationWorkerResponse[] = [];
    const runtime = createCompensationWorkerRuntime({
      emit: (response) => responses.push(response),
      microbatchEvents: 2,
    });

    const prime = previewPrime(measured, fixed);
    runtime.dispatch(prime);
    runtime.dispatch(previewSolve("exact-preview"));
    const primed = await eventually(() => responseOfType(responses, "preview-primed"));
    const solved = await eventually(() => responseOfType(responses, "preview-solved"));
    const expected = compareFlowCompensation(measured, CURRENT_MATRIX, CANDIDATE_MATRIX, {
      sourceChannels: ["source-a", "source-b"],
    });

    expect(primed.receiverBindings).toEqual(prime.channelBindings);
    expect(primed.sourceBindings).toEqual(prime.channelBindings);
    expect(solved.requestId).toBe("exact-preview");
    expect(solved.receiverBindings).toEqual(prime.channelBindings);
    expect(solved.sourceBindings).toEqual(prime.channelBindings);
    expect(solved.currentColumns).toEqual(expected.current.columns);
    expect(solved.candidateColumns).toEqual(expected.candidate.columns);
    expect(solved.deltas).toEqual(expected.deltas);
    expect(solved.impacts).toEqual(expected.impacts);
    expect(solved.impactRanking).toEqual(expected.impactRanking);
    expect(solved.currentDiagnostics).toEqual(expected.current.factorization.diagnostics);
    expect(solved.candidateDiagnostics).toEqual(expected.candidate.factorization.diagnostics);
    expect(solved.currentReconstruction).toEqual(expected.current.reconstruction);
    expect(solved.candidateReconstruction).toEqual(expected.candidate.reconstruction);
  });

  it("lets the latest preview request supersede an older solve before either can publish", async () => {
    const measured = [
      Float64Array.from({ length: 8 }, (_, index) => index * 3 - 10),
      Float64Array.from({ length: 8 }, (_, index) => 20 - index * 2),
    ] as const;
    const responses: CompensationWorkerResponse[] = [];
    const runtime = createCompensationWorkerRuntime({
      emit: (response) => responses.push(response),
      microbatchEvents: 1,
    });
    const latestMatrix = [[1, 0.08], [0.04, 1]] as const;

    runtime.dispatch(previewPrime(measured));
    runtime.dispatch(previewSolve("old"));
    runtime.dispatch(previewSolve("latest", latestMatrix));
    const solved = await eventually(() => responses.find(
      (response) => response.type === "preview-solved" && response.requestId === "latest",
    ));

    expect(solved.type).toBe("preview-solved");
    expect(responses.some(
      (response) => response.type === "preview-solved" && response.requestId === "old",
    )).toBe(false);
  });

  it("keeps preview outputs source-labelled when the matrix receiver axis is reversed", async () => {
    const sourceChannels = ["source-a", "source-b"] as const;
    const receiverChannels = ["source-b", "source-a"] as const;
    const receiverBindings = [
      {
        pnn: "source-b",
        fcsColumnIndex: 7,
        matrixSourceIndex: 1,
        matrixReceiverIndex: 0,
      },
      {
        pnn: "source-a",
        fcsColumnIndex: 4,
        matrixSourceIndex: 0,
        matrixReceiverIndex: 1,
      },
    ] as const;
    const matrix = [[0.2, 1], [1, 0.1]] as const;
    const source = [
      new Float64Array([10, 20, -5]),
      new Float64Array([3, 7, 4]),
    ] as const;
    const measured = [
      Float64Array.from(source[0], (value, event) =>
        value * matrix[0][0] + source[1][event] * matrix[1][0]
      ),
      Float64Array.from(source[0], (value, event) =>
        value * matrix[0][1] + source[1][event] * matrix[1][1]
      ),
    ] as const;
    const responses: CompensationWorkerResponse[] = [];
    const runtime = createCompensationWorkerRuntime({
      emit: (response) => responses.push(response),
      microbatchEvents: 1,
    });

    runtime.dispatch({
      ...previewPrime(measured),
      sourceChannels,
      receiverChannels,
      channelBindings: receiverBindings,
    });
    runtime.dispatch({
      ...previewSolve("reversed-preview"),
      currentMatrix: matrix,
      candidateMatrix: matrix,
    });
    const solved = await eventually(() => responseOfType(responses, "preview-solved"));

    expect(solved.receiverBindings).toEqual(receiverBindings);
    expect(solved.sourceBindings).toEqual([receiverBindings[1], receiverBindings[0]]);
    expect(solved.sourceChannels).toEqual(sourceChannels);
    for (const columns of [solved.currentColumns, solved.candidateColumns]) {
      for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex++) {
        for (let event = 0; event < source[sourceIndex].length; event++) {
          expect(columns[sourceIndex][event]).toBeCloseTo(source[sourceIndex][event], 12);
        }
      }
    }
  });

  it("accepts exactly one sequential Apply chunk and reports monotonic verified progress", async () => {
    const measured = [
      new Float64Array([100, 75, -20, 4, 500]),
      new Float64Array([12, -5, 33, 8, 90]),
    ] as const;
    const expected = compensateFlowColumns(
      measured,
      prepareFlowCompensation(CANDIDATE_MATRIX),
      { output: "float32" },
    );
    const responses: CompensationWorkerResponse[] = [];
    const runtime = createCompensationWorkerRuntime({
      emit: (response) => responses.push(response),
      microbatchEvents: 1,
    });

    runtime.dispatch(applyStart(5));
    runtime.dispatch(applyChunk(0, 0, measured.map((column) => column.slice(0, 2))));
    runtime.dispatch(applyChunk(1, 2, measured.map((column) => column.slice(2))));
    await eventually(() => responses.find(
      (response) => response.type === "worker-error" && response.code === "apply-chunk-in-flight",
    ));
    await eventually(() => responses.find(
      (response) => response.type === "apply-chunk-complete" && response.chunkIndex === 0,
    ));
    runtime.dispatch(applyChunk(1, 2, measured.map((column) => column.slice(2))));
    await eventually(() => responseOfType(responses, "apply-complete"));

    const chunks = responses.filter(
      (response): response is Extract<CompensationWorkerResponse, { type: "apply-chunk-complete" }> =>
        response.type === "apply-chunk-complete",
    );
    for (let channel = 0; channel < 2; channel++) {
      const combined = new Float32Array(5);
      for (const chunk of chunks) combined.set(chunk.columns[channel], chunk.startEvent);
      expect(new Uint8Array(combined.buffer)).toEqual(
        new Uint8Array(expected.columns[channel].buffer),
      );
    }
    const progress = responses.filter(
      (response): response is Extract<CompensationWorkerResponse, { type: "apply-progress" }> =>
        response.type === "apply-progress",
    );
    expect(progress.map((response) => response.processedEvents)).toEqual([2, 5]);
    expect(progress.map((response) => response.fraction)).toEqual([0.4, 1]);
    expect(progress.every((response) =>
      response.outputBindings.map(({ pnn }) => pnn).join(",") === "source-a,source-b"
    )).toBe(true);
  });

  it("runs CyTOF NNLS Apply through the same bounded worker protocol", async () => {
    const measured = [
      new Float64Array([10.4, 3, 0]),
      new Float64Array([6, -2, 5]),
    ] as const;
    const responses: CompensationWorkerResponse[] = [];
    const runtime = createCompensationWorkerRuntime({
      emit: (response) => responses.push(response),
      microbatchEvents: 1,
    });

    runtime.dispatch(applyStart(3, {
      method: "nnls",
      matrix: [
        [1, 0.2],
        [0.1, 1],
      ],
      nnlsSettings: {
        tolerance: 1e-10,
        kktTolerance: 1e-9,
        maxIterations: 1000,
        adaptationVersion: "identity-backed-v1",
      },
    }));
    const started = await eventually(() => responseOfType(responses, "apply-started"));
    expect(started.diagnostics).toMatchObject({
      method: "nnls",
      channelCount: 2,
      adaptationVersion: "identity-backed-v1",
    });

    runtime.dispatch(applyChunk(0, 0, measured));
    const chunk = await eventually(() => responseOfType(responses, "apply-chunk-complete"));
    await eventually(() => responseOfType(responses, "apply-complete"));

    expect(chunk.columns[0][0]).toBeCloseTo(10, 5);
    expect(chunk.columns[1][0]).toBeCloseTo(4, 5);
    expect(chunk.columns[0][1]).toBeCloseTo(2.5, 5);
    expect(chunk.columns[1][1]).toBe(0);
    expect(chunk.columns.flatMap((column) => Array.from(column)).every((value) => value >= 0)).toBe(true);
  });

  it("keeps FCS, receiver, and source identities exact when the matrix axes are permuted", async () => {
    const sourceChannels = ["source-a", "source-b"] as const;
    const receiverChannels = ["source-b", "source-a"] as const;
    const receiverBindings = [
      {
        pnn: "source-b",
        fcsColumnIndex: 7,
        matrixSourceIndex: 1,
        matrixReceiverIndex: 0,
      },
      {
        pnn: "source-a",
        fcsColumnIndex: 4,
        matrixSourceIndex: 0,
        matrixReceiverIndex: 1,
      },
    ] as const;
    const sourceBindings = [receiverBindings[1], receiverBindings[0]] as const;
    // Rows are source-a/source-b; columns are the deliberately reversed source-b/source-a
    // receiver axis. Thus the unit coefficients are off the array diagonal.
    const matrix = [
      [0.2, 1],
      [1, 0.1],
    ] as const;
    const trueSourceColumns = [
      new Float64Array([10, 20, -5]),
      new Float64Array([3, 7, 4]),
    ] as const;
    const measuredReceiverColumns = [
      Float64Array.from(trueSourceColumns[0], (value, event) =>
        value * matrix[0][0] + trueSourceColumns[1][event] * matrix[1][0]
      ),
      Float64Array.from(trueSourceColumns[0], (value, event) =>
        value * matrix[0][1] + trueSourceColumns[1][event] * matrix[1][1]
      ),
    ] as const;
    const responses: CompensationWorkerResponse[] = [];
    const runtime = createCompensationWorkerRuntime({
      emit: (response) => responses.push(response),
      microbatchEvents: 1,
    });

    runtime.dispatch(applyStart(3, {
      sourceChannels,
      receiverChannels,
      channelBindings: receiverBindings,
      matrix,
    }));
    const started = await eventually(() => responseOfType(responses, "apply-started"));
    expect(started.receiverBindings).toEqual(receiverBindings);
    expect(started.sourceBindings).toEqual(sourceBindings);

    runtime.dispatch(applyChunk(0, 0, measuredReceiverColumns));
    const chunk = await eventually(() => responseOfType(responses, "apply-chunk-complete"));
    const complete = await eventually(() => responseOfType(responses, "apply-complete"));

    expect(chunk.outputBindings).toEqual(sourceBindings);
    expect(complete.outputBindings).toEqual(sourceBindings);
    expect(complete.allFinite).toBe(true);
    const progress = responses.filter(
      (response): response is Extract<CompensationWorkerResponse, { type: "apply-progress" }> =>
        response.type === "apply-progress",
    );
    expect(progress).toHaveLength(1);
    expect(progress[0].outputBindings).toEqual(sourceBindings);
    for (let source = 0; source < sourceChannels.length; source++) {
      expect(chunk.outputBindings[source].pnn).toBe(sourceChannels[source]);
      for (let event = 0; event < trueSourceColumns[source].length; event++) {
        expect(chunk.columns[source][event]).toBeCloseTo(trueSourceColumns[source][event], 5);
      }
    }
  });

  it("rejects malformed or ambiguous Apply channel mappings before creating a job", () => {
    const invalidStarts: StartApplyRequest[] = [
      applyStart(1, {
        receiverChannels: ["source-b", "source-a"],
        // The bindings still claim the original receiver order.
      }),
      applyStart(1, {
        channelBindings: [
          {
            pnn: "source-a",
            fcsColumnIndex: 4,
            matrixSourceIndex: 0,
            matrixReceiverIndex: 0,
          },
          {
            pnn: "source-b",
            fcsColumnIndex: 4,
            matrixSourceIndex: 1,
            matrixReceiverIndex: 1,
          },
        ],
      }),
      applyStart(1, {
        channelBindings: [
          {
            pnn: "source-a",
            fcsColumnIndex: 4,
            matrixSourceIndex: 1,
            matrixReceiverIndex: 0,
          },
          {
            pnn: "source-b",
            fcsColumnIndex: 7,
            matrixSourceIndex: 0,
            matrixReceiverIndex: 1,
          },
        ],
      }),
      applyStart(1, {
        sourceChannels: ["source-a", "source-a"],
      }),
    ];

    for (const request of invalidStarts) {
      const responses: CompensationWorkerResponse[] = [];
      const runtime = createCompensationWorkerRuntime({
        emit: (response) => responses.push(response),
      });
      runtime.dispatch(request);

      expect(responseOfType(responses, "apply-started")).toBeUndefined();
      expect(responseOfType(responses, "worker-error")).toMatchObject({
        scope: "apply",
        code: "dimension-mismatch",
        recoverable: true,
      });
    }
  });

  it("cancels between macrotask slices and ignores a stale token for the replacement job", async () => {
    const responses: CompensationWorkerResponse[] = [];
    const runtime = createCompensationWorkerRuntime({
      emit: (response) => responses.push(response),
      microbatchEvents: 1,
    });
    const large = [
      Float64Array.from({ length: 100 }, (_, index) => index),
      Float64Array.from({ length: 100 }, (_, index) => 100 - index),
    ] as const;

    runtime.dispatch(applyStart(100));
    runtime.dispatch(applyChunk(0, 0, large));
    runtime.dispatch({
      protocol: COMPENSATION_WORKER_PROTOCOL,
      type: "cancel",
      target: "apply",
      id: APPLY_IDENTITY.jobId,
      token: APPLY_IDENTITY.jobToken,
    });
    await eventually(() => responseOfType(responses, "cancelled"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(responseOfType(responses, "apply-chunk-complete")).toBeUndefined();

    const replacementIdentity = { ...APPLY_IDENTITY, jobToken: "apply-token-2" };
    runtime.dispatch(applyStart(2, replacementIdentity));
    runtime.dispatch({
      protocol: COMPENSATION_WORKER_PROTOCOL,
      type: "cancel",
      target: "apply",
      id: APPLY_IDENTITY.jobId,
      token: APPLY_IDENTITY.jobToken,
    });
    await eventually(() => responses.find(
      (response) => response.type === "worker-error" && response.code === "stale-cancel",
    ));
    runtime.dispatch(applyChunk(
      0,
      0,
      [new Float64Array([5, 8]), new Float64Array([2, 3])],
      replacementIdentity,
    ));
    const complete = await eventually(() => responses.find(
      (response) => response.type === "apply-complete" && response.jobToken === "apply-token-2",
    ));
    expect(complete.type).toBe("apply-complete");
  });

  it("keeps an immediate same-id replacement active while the cancelled job unwinds", async () => {
    const responses: CompensationWorkerResponse[] = [];
    const runtime = createCompensationWorkerRuntime({
      emit: (response) => responses.push(response),
      microbatchEvents: 1,
    });
    const oldMeasured = [
      Float64Array.from({ length: 50 }, (_, index) => index),
      Float64Array.from({ length: 50 }, (_, index) => 50 - index),
    ] as const;
    const replacementIdentity = { ...APPLY_IDENTITY, jobToken: "same-id-replacement" };

    runtime.dispatch(applyStart(50));
    runtime.dispatch(applyChunk(0, 0, oldMeasured));
    runtime.dispatch({
      protocol: COMPENSATION_WORKER_PROTOCOL,
      type: "cancel",
      target: "apply",
      id: APPLY_IDENTITY.jobId,
      token: APPLY_IDENTITY.jobToken,
    });
    runtime.dispatch(applyStart(2, replacementIdentity));
    await new Promise((resolve) => setTimeout(resolve, 10));

    runtime.dispatch(previewPrime([
      new Float64Array([1]),
      new Float64Array([2]),
    ]));
    await eventually(() => responses.find(
      (response) => response.type === "worker-error" &&
        response.scope === "preview" &&
        response.code === "apply-job-active",
    ));
    runtime.dispatch(applyChunk(
      0,
      0,
      [new Float64Array([5, 8]), new Float64Array([2, 3])],
      replacementIdentity,
    ));
    const complete = await eventually(() => responses.find(
      (response) => response.type === "apply-complete" &&
        response.jobToken === replacementIdentity.jobToken,
    ));
    expect(complete.type).toBe("apply-complete");
    expect((runtime as unknown as { applyJobs: Map<string, unknown> }).applyJobs.size).toBe(0);
  });

  it("rejects subarray-backed or duplicate transfer buffers before worker ownership", async () => {
    const backing = new ArrayBuffer(8 * Float64Array.BYTES_PER_ELEMENT);
    const subarrayRequest = applyChunk(0, 0, [
      new Float64Array(backing, Float64Array.BYTES_PER_ELEMENT, 2),
      new Float64Array(2),
    ]);
    expect(() => requestTransferables(subarrayRequest)).toThrow(
      /exact-owned, distinct ArrayBuffer/,
    );

    const duplicate = new ArrayBuffer(2 * Float64Array.BYTES_PER_ELEMENT);
    const duplicateRequest = applyChunk(0, 0, [
      new Float64Array(duplicate),
      new Float64Array(duplicate),
    ]);
    expect(() => requestTransferables(duplicateRequest)).toThrow(
      /exact-owned, distinct ArrayBuffer/,
    );

    const responses: CompensationWorkerResponse[] = [];
    const runtime = createCompensationWorkerRuntime({
      emit: (response) => responses.push(response),
    });
    runtime.dispatch(applyStart(2));
    runtime.dispatch(subarrayRequest);
    const error = await eventually(() => responses.find(
      (response) => response.type === "worker-error" &&
        response.code === "invalid-transfer-buffer",
    ));
    expect(error.type).toBe("worker-error");
  });

  it("gives Apply priority over preview work and permits a clean retry after a chunk failure", async () => {
    const responses: CompensationWorkerResponse[] = [];
    const runtime = createCompensationWorkerRuntime({
      emit: (response) => responses.push(response),
      microbatchEvents: 1,
    });
    const measured = [
      Float64Array.from({ length: 20 }, (_, index) => index + 1),
      Float64Array.from({ length: 20 }, (_, index) => 20 - index),
    ] as const;

    runtime.dispatch(previewPrime(measured));
    runtime.dispatch(previewSolve("superseded-by-apply"));
    runtime.dispatch(applyStart(2));
    await eventually(() => responseOfType(responses, "apply-started"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(responses.some(
      (response) => response.type === "preview-solved" &&
        response.requestId === "superseded-by-apply",
    )).toBe(false);

    runtime.dispatch(previewPrime([
      new Float64Array([1]),
      new Float64Array([2]),
    ]));
    await eventually(() => responses.find(
      (response) => response.type === "worker-error" &&
        response.scope === "preview" &&
        response.code === "apply-job-active",
    ));

    runtime.dispatch(applyChunk(
      0,
      0,
      [new Float64Array([1, 2]), new Float64Array([3, Number.NaN])],
    ));
    await eventually(() => responses.find(
      (response) => response.type === "worker-error" &&
        response.scope === "apply" &&
        response.code === "non-finite-measured-value",
    ));

    const retryIdentity = { ...APPLY_IDENTITY, jobToken: "retry-token" };
    runtime.dispatch(applyStart(2, retryIdentity));
    await eventually(() => responses.find(
      (response) => response.type === "apply-started" && response.jobToken === "retry-token",
    ));
    runtime.dispatch(applyChunk(
      0,
      0,
      [new Float64Array([1, 2]), new Float64Array([3, 4])],
      retryIdentity,
    ));
    const complete = await eventually(() => responses.find(
      (response) => response.type === "apply-complete" && response.jobToken === "retry-token",
    ));
    expect(complete.type).toBe("apply-complete");
  });

  it("enforces the transient input-plus-output byte budget", async () => {
    const responses: CompensationWorkerResponse[] = [];
    const runtime = createCompensationWorkerRuntime({
      emit: (response) => responses.push(response),
    });
    // Two Float64 input columns (32 bytes) plus two Float32 outputs (16 bytes).
    runtime.dispatch(applyStart(2, { byteBudget: 47 }));
    runtime.dispatch(applyChunk(
      0,
      0,
      [new Float64Array([1, 2]), new Float64Array([3, 4])],
    ));

    const error = await eventually(() => responses.find(
      (response) => response.type === "worker-error" &&
        response.code === "apply-chunk-over-budget",
    ));
    expect(error.type).toBe("worker-error");
  });

  it("reports non-finite values at fixed preview and full-sample Apply coordinates", async () => {
    const previewResponses: CompensationWorkerResponse[] = [];
    const previewRuntime = createCompensationWorkerRuntime({
      emit: (response) => previewResponses.push(response),
      microbatchEvents: 1,
    });
    previewRuntime.dispatch(previewPrime(
      [new Float64Array([1, 2]), new Float64Array([3, Number.NaN])],
      new Uint32Array([8, 41]),
    ));
    previewRuntime.dispatch(previewSolve("non-finite-preview"));
    const previewError = await eventually(() => responseOfType(previewResponses, "worker-error"));
    expect(previewError.code).toBe("non-finite-measured-value");
    expect(previewError.message).toMatch(/receiver 2, event 42/);

    const applyResponses: CompensationWorkerResponse[] = [];
    const applyRuntime = createCompensationWorkerRuntime({
      emit: (response) => applyResponses.push(response),
      microbatchEvents: 1,
    });
    applyRuntime.dispatch(applyStart(12));
    applyRuntime.dispatch(applyChunk(0, 0, [new Float64Array(10), new Float64Array(10)]));
    await eventually(() => applyResponses.find(
      (response) => response.type === "apply-chunk-complete" && response.chunkIndex === 0,
    ));
    applyRuntime.dispatch(applyChunk(
      1,
      10,
      [new Float64Array([1, 2]), new Float64Array([3, Number.NaN])],
    ));
    const applyError = await eventually(() => applyResponses.find(
      (response) => response.type === "worker-error" && response.scope === "apply",
    ));
    expect(applyError.type).toBe("worker-error");
    if (applyError.type !== "worker-error") throw new Error("Expected worker error.");
    expect(applyError.code).toBe("non-finite-measured-value");
    expect(applyError.message).toMatch(/receiver 2, event 12/);

    const overflowResponses: CompensationWorkerResponse[] = [];
    const overflowRuntime = createCompensationWorkerRuntime({
      emit: (response) => overflowResponses.push(response),
      microbatchEvents: 1,
    });
    overflowRuntime.dispatch(applyStart(3, {
      jobId: "overflow-job",
      jobToken: "overflow-token",
      matrix: [[1]],
      channelCount: 1,
      sourceChannels: ["source-a"],
      receiverChannels: ["source-a"],
      channelBindings: [{
        pnn: "source-a",
        fcsColumnIndex: 4,
        matrixSourceIndex: 0,
        matrixReceiverIndex: 0,
      }],
    }));
    overflowRuntime.dispatch(applyChunk(
      0,
      0,
      [new Float64Array([1, 2])],
      { jobId: "overflow-job", jobToken: "overflow-token" },
    ));
    await eventually(() => overflowResponses.find(
      (response) => response.type === "apply-chunk-complete" && response.chunkIndex === 0,
    ));
    overflowRuntime.dispatch(applyChunk(
      1,
      2,
      [new Float64Array([Number.MAX_VALUE])],
      { jobId: "overflow-job", jobToken: "overflow-token" },
    ));
    const overflowError = await eventually(() => overflowResponses.find(
      (response) => response.type === "worker-error" && response.code === "non-finite-output",
    ));
    expect(overflowError.type).toBe("worker-error");
    if (overflowError.type !== "worker-error") throw new Error("Expected worker error.");
    expect(overflowError.message).toMatch(/source 1, event 3/);
  });

  it("returns structured protocol and unsupported-NNLS errors without poisoning later work", () => {
    const responses: CompensationWorkerResponse[] = [];
    const runtime = createCompensationWorkerRuntime({
      emit: (response) => responses.push(response),
    });

    runtime.dispatch({ protocol: "obsolete", type: "prime-preview" });
    runtime.dispatch({ ...previewPrime([new Float64Array(1), new Float64Array(1)]), method: "nnls" });

    expect(responses.map((response) => response.type)).toEqual(["worker-error", "worker-error"]);
    const errors = responses.filter(
      (response): response is Extract<CompensationWorkerResponse, { type: "worker-error" }> =>
        response.type === "worker-error",
    );
    expect(errors[0]).toMatchObject({ scope: "protocol", code: "unsupported-protocol", recoverable: false });
    expect(errors[1]).toMatchObject({ scope: "preview", code: "unsupported-method", recoverable: true });
  });
});
