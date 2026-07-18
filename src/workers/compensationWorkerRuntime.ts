import {
  FlowCompensationError,
  compensateFlowRange,
  matrixInfinityNorm,
  prepareFlowCompensation,
  type FlowChannelImpact,
  type FlowCompensationPlan,
  type FlowReconstructionDiagnostics,
} from "../engine/flowCompensationEngine";
import {
  CytofCompensationError,
  compensateCytofRange,
  prepareCytofNnls,
  type CytofNnlsPlan,
} from "../engine/cytofCompensationEngine";
import {
  COMPENSATION_WORKER_PROTOCOL,
  responseTransferables,
  type ApplyChunkRequest,
  type CompensationWorkerEmit,
  type CompensationWorkerErrorScope,
  type CompensationWorkerChannelBinding,
  type CompensationWorkerRequest,
  type PrimePreviewRequest,
  type SolvePreviewRequest,
  type StartApplyRequest,
} from "./compensationProtocol";

const DEFAULT_MICROBATCH_EVENTS = 2_048;
const TASK_ABORTED = Symbol("compensation-task-aborted");

type YieldToEventLoop = () => Promise<void>;

export interface CompensationWorkerRuntimeOptions {
  readonly emit: CompensationWorkerEmit;
  /** Test seam; production deliberately yields to a macrotask so cancel messages can run. */
  readonly yieldToEventLoop?: YieldToEventLoop;
  readonly microbatchEvents?: number;
}

interface PreviewSession {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly profileHash: string;
  readonly bindingKey: string;
  readonly sourceChannels: readonly string[];
  readonly receiverChannels: readonly string[];
  readonly receiverBindings: readonly CompensationWorkerChannelBinding[];
  readonly sourceBindings: readonly CompensationWorkerChannelBinding[];
  readonly fixedEventIndices: Uint32Array;
  readonly measuredColumns: readonly Float64Array[];
  generation: number;
  latestRequestId: string | null;
  cancelled: boolean;
}

interface ApplyJob {
  readonly jobId: string;
  readonly jobToken: string;
  readonly profileHash: string;
  readonly bindingKey: string;
  readonly method: "matrix-inverse" | "nnls";
  readonly plan: FlowCompensationPlan | CytofNnlsPlan;
  readonly totalEvents: number;
  readonly channelCount: number;
  readonly byteBudget: number;
  readonly receiverBindings: readonly CompensationWorkerChannelBinding[];
  readonly sourceBindings: readonly CompensationWorkerChannelBinding[];
  nextChunkIndex: number;
  processedEvents: number;
  busy: boolean;
  cancelled: boolean;
  complete: boolean;
}

interface PreviewGuard {
  readonly session: PreviewSession;
  readonly generation: number;
  readonly requestId: string;
}

function defaultYieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasExactDistinctArrayBuffers(
  views: readonly (Uint32Array | Float64Array)[],
): boolean {
  const seen = new Set<ArrayBuffer>();
  for (const view of views) {
    const buffer = view.buffer;
    if (
      !(buffer instanceof ArrayBuffer) ||
      view.byteOffset !== 0 ||
      view.byteLength !== buffer.byteLength ||
      seen.has(buffer)
    ) {
      return false;
    }
    seen.add(buffer);
  }
  return true;
}

function quantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

function compensationErrorCode(error: unknown): string {
  return error instanceof FlowCompensationError || error instanceof CytofCompensationError
    ? error.code
    : "unexpected-worker-error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateChannelBindings(
  request: Pick<StartApplyRequest, "sourceChannels" | "receiverChannels" | "channelBindings">,
  count: number,
): Readonly<{
  receiverBindings: readonly CompensationWorkerChannelBinding[];
  sourceBindings: readonly CompensationWorkerChannelBinding[];
}> {
  if (
    !Array.isArray(request.sourceChannels) ||
    !Array.isArray(request.receiverChannels) ||
    !Array.isArray(request.channelBindings) ||
    request.sourceChannels.length !== count ||
    request.receiverChannels.length !== count ||
    request.channelBindings.length !== count ||
    request.sourceChannels.some((pnn) => !isNonEmptyString(pnn)) ||
    request.receiverChannels.some((pnn) => !isNonEmptyString(pnn)) ||
    new Set(request.sourceChannels).size !== count ||
    new Set(request.receiverChannels).size !== count
  ) {
    throw new FlowCompensationError(
      "dimension-mismatch",
      "Apply requires unique source/receiver channel axes and one exact binding per channel.",
    );
  }
  const seenPnns = new Set<string>();
  const seenFcsColumns = new Set<number>();
  const seenSources = new Set<number>();
  const receiverBindings: CompensationWorkerChannelBinding[] = [];
  for (let receiverIndex = 0; receiverIndex < count; receiverIndex++) {
    if (!Object.prototype.hasOwnProperty.call(request.channelBindings, receiverIndex)) {
      throw new FlowCompensationError(
        "dimension-mismatch",
        "Apply channel bindings must not contain sparse entries.",
      );
    }
    const binding = request.channelBindings[receiverIndex];
    if (
      !binding ||
      !isNonEmptyString(binding.pnn) ||
      !Number.isSafeInteger(binding.fcsColumnIndex) ||
      binding.fcsColumnIndex < 0 ||
      !Number.isSafeInteger(binding.matrixSourceIndex) ||
      binding.matrixSourceIndex < 0 ||
      binding.matrixSourceIndex >= count ||
      binding.matrixReceiverIndex !== receiverIndex ||
      request.receiverChannels[receiverIndex] !== binding.pnn ||
      request.sourceChannels[binding.matrixSourceIndex] !== binding.pnn ||
      seenPnns.has(binding.pnn) ||
      seenFcsColumns.has(binding.fcsColumnIndex) ||
      seenSources.has(binding.matrixSourceIndex)
    ) {
      throw new FlowCompensationError(
        "dimension-mismatch",
        "Apply channel bindings must uniquely match each PnN, FCS column, source axis, and receiver axis.",
      );
    }
    seenPnns.add(binding.pnn);
    seenFcsColumns.add(binding.fcsColumnIndex);
    seenSources.add(binding.matrixSourceIndex);
    receiverBindings.push(Object.freeze({ ...binding }));
  }
  const sourceBindings = Array.from(receiverBindings).sort(
    (left, right) => left.matrixSourceIndex - right.matrixSourceIndex,
  );
  return Object.freeze({
    receiverBindings: Object.freeze(receiverBindings),
    sourceBindings: Object.freeze(sourceBindings),
  });
}

/** Stateful worker-side dispatcher. It owns transferred preview and apply buffers. */
export class CompensationWorkerRuntime {
  private readonly emitResponse: CompensationWorkerEmit;
  private readonly yieldToEventLoop: YieldToEventLoop;
  private readonly microbatchEvents: number;
  private readonly previews = new Map<string, PreviewSession>();
  private readonly applyJobs = new Map<string, ApplyJob>();
  private activeApplyJob: ApplyJob | null = null;

  constructor(options: CompensationWorkerRuntimeOptions) {
    this.emitResponse = options.emit;
    this.yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;
    const microbatchEvents = options.microbatchEvents ?? DEFAULT_MICROBATCH_EVENTS;
    if (!Number.isSafeInteger(microbatchEvents) || microbatchEvents <= 0) {
      throw new Error("Compensation worker microbatchEvents must be a positive safe integer.");
    }
    this.microbatchEvents = microbatchEvents;
  }

  dispatch(input: unknown): void {
    if (!isRecord(input) || input.protocol !== COMPENSATION_WORKER_PROTOCOL) {
      this.emitError(
        "protocol",
        null,
        null,
        "unsupported-protocol",
        `Expected compensation worker protocol ${COMPENSATION_WORKER_PROTOCOL}.`,
        false,
      );
      return;
    }
    switch (input.type) {
      case "prime-preview":
        this.handlePrimePreview(input as unknown as PrimePreviewRequest);
        return;
      case "solve-preview":
        this.handleSolvePreview(input as unknown as SolvePreviewRequest);
        return;
      case "start-apply":
        this.handleStartApply(input as unknown as StartApplyRequest);
        return;
      case "apply-chunk":
        this.handleApplyChunk(input as unknown as ApplyChunkRequest);
        return;
      case "cancel":
        this.handleCancel(input as unknown as CompensationWorkerRequest);
        return;
      default:
        this.emitError(
          "protocol",
          null,
          null,
          "unknown-request-type",
          "The compensation worker request type is not recognized.",
          false,
        );
    }
  }

  private emit(response: Parameters<CompensationWorkerEmit>[0]): void {
    this.emitResponse(response, responseTransferables(response));
  }

  private emitError(
    scope: CompensationWorkerErrorScope,
    id: string | null,
    token: string | null,
    code: string,
    message: string,
    recoverable: boolean,
    requestId?: string,
  ): void {
    this.emit({
      protocol: COMPENSATION_WORKER_PROTOCOL,
      type: "worker-error",
      scope,
      id,
      token,
      ...(requestId === undefined ? {} : { requestId }),
      code,
      message,
      recoverable,
    });
  }

  private handlePrimePreview(request: PrimePreviewRequest): void {
    const identityError = this.previewIdentityError(request);
    if (identityError !== null) {
      this.emitError("preview", request.sessionId ?? null, request.sessionToken ?? null,
        "invalid-preview-request", identityError, true);
      return;
    }
    if (request.method !== "matrix-inverse") {
      this.emitError("preview", request.sessionId, request.sessionToken,
        "unsupported-method", "NNLS compensation is not implemented in this worker version.", true);
      return;
    }
    if (this.hasActiveApplyJob()) {
      this.emitError("preview", request.sessionId, request.sessionToken,
        "apply-job-active", "A preview cannot be primed while compensation Apply is running.", true);
      return;
    }
    if (
      !Array.isArray(request.sourceChannels) ||
      !Array.isArray(request.receiverChannels) ||
      request.sourceChannels.length === 0 ||
      request.sourceChannels.length !== request.receiverChannels.length ||
      request.sourceChannels.some((channel) => !isNonEmptyString(channel)) ||
      request.receiverChannels.some((channel) => !isNonEmptyString(channel))
    ) {
      this.emitError("preview", request.sessionId, request.sessionToken,
        "dimension-mismatch", "Preview source and receiver channels must be equally sized non-empty lists.", true);
      return;
    }
    if (!(request.fixedEventIndices instanceof Uint32Array)) {
      this.emitError("preview", request.sessionId, request.sessionToken,
        "invalid-preview-events", "Preview event indices must be a Uint32Array.", true);
      return;
    }
    if (
      !Array.isArray(request.measuredColumns) ||
      request.measuredColumns.length !== request.receiverChannels.length ||
      request.measuredColumns.some((column) => !(column instanceof Float64Array))
    ) {
      this.emitError("preview", request.sessionId, request.sessionToken,
        "dimension-mismatch", "Preview measurements must be Float64 columns in receiver-channel order.", true);
      return;
    }
    const eventCount = request.fixedEventIndices.length;
    if (request.measuredColumns.some((column) => column.length !== eventCount)) {
      this.emitError("preview", request.sessionId, request.sessionToken,
        "dimension-mismatch", "Every preview measurement column must match the fixed event selection.", true);
      return;
    }
    if (!hasExactDistinctArrayBuffers([request.fixedEventIndices, ...request.measuredColumns])) {
      this.emitError("preview", request.sessionId, request.sessionToken,
        "invalid-transfer-buffer",
        "Preview data must use exact-owned, distinct ArrayBuffers.", true);
      return;
    }

    let previewBindings: ReturnType<typeof validateChannelBindings>;
    try {
      previewBindings = validateChannelBindings(request, request.sourceChannels.length);
    } catch (error) {
      this.emitError("preview", request.sessionId, request.sessionToken,
        compensationErrorCode(error), errorMessage(error), true);
      return;
    }

    const previous = this.previews.get(request.sessionId);
    if (previous !== undefined) {
      previous.cancelled = true;
      previous.generation++;
    }
    const session: PreviewSession = {
      sessionId: request.sessionId,
      sessionToken: request.sessionToken,
      profileHash: request.profileHash,
      bindingKey: request.bindingKey,
      sourceChannels: Object.freeze(Array.from(request.sourceChannels)),
      receiverChannels: Object.freeze(Array.from(request.receiverChannels)),
      receiverBindings: previewBindings.receiverBindings,
      sourceBindings: previewBindings.sourceBindings,
      fixedEventIndices: request.fixedEventIndices,
      measuredColumns: Object.freeze(Array.from(request.measuredColumns)),
      generation: 0,
      latestRequestId: null,
      cancelled: false,
    };
    this.previews.set(session.sessionId, session);
    this.emit({
      protocol: COMPENSATION_WORKER_PROTOCOL,
      type: "preview-primed",
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      profileHash: session.profileHash,
      bindingKey: session.bindingKey,
      eventCount,
      channelCount: session.sourceChannels.length,
      receiverBindings: session.receiverBindings,
      sourceBindings: session.sourceBindings,
    });
  }

  private handleSolvePreview(request: SolvePreviewRequest): void {
    const identityError = this.previewIdentityError(request);
    if (identityError !== null || !isNonEmptyString(request.requestId)) {
      this.emitError("preview", request.sessionId ?? null, request.sessionToken ?? null,
        "invalid-preview-request", identityError ?? "Preview requestId must be non-empty.", true,
        request.requestId);
      return;
    }
    if (request.method !== "matrix-inverse") {
      this.emitError("preview", request.sessionId, request.sessionToken,
        "unsupported-method", "NNLS compensation is not implemented in this worker version.", true,
        request.requestId);
      return;
    }
    if (this.hasActiveApplyJob()) {
      this.emitError("preview", request.sessionId, request.sessionToken,
        "apply-job-active", "A preview cannot run while compensation Apply is active.", true,
        request.requestId);
      return;
    }
    const session = this.previews.get(request.sessionId);
    if (session === undefined || !this.matchesPreviewIdentity(session, request)) {
      this.emitError("preview", request.sessionId, request.sessionToken,
        "stale-preview-session", "The preview session is missing or its identity is stale.", true,
        request.requestId);
      return;
    }
    session.cancelled = false;
    session.latestRequestId = request.requestId;
    session.generation++;
    const guard: PreviewGuard = {
      session,
      generation: session.generation,
      requestId: request.requestId,
    };
    void this.runPreview(request, guard);
  }

  private async runPreview(request: SolvePreviewRequest, guard: PreviewGuard): Promise<void> {
    try {
      await this.previewCheckpoint(guard);
      const channelCount = guard.session.sourceChannels.length;
      if (
        !Array.isArray(request.currentMatrix) ||
        !Array.isArray(request.candidateMatrix) ||
        request.currentMatrix.length !== channelCount ||
        request.candidateMatrix.length !== channelCount
      ) {
        throw new FlowCompensationError(
          "dimension-mismatch",
          "Preview matrices must match the primed channel count.",
        );
      }
      const currentPlan = prepareFlowCompensation(request.currentMatrix, request.flowSettings);
      const candidatePlan = prepareFlowCompensation(request.candidateMatrix, request.flowSettings);
      const currentColumns = await this.solvePreviewColumns(guard.session, currentPlan, guard);
      const candidateColumns = await this.solvePreviewColumns(guard.session, candidatePlan, guard);
      const comparison = await this.summarizePreview(currentColumns, candidateColumns, guard);
      const currentReconstruction = await this.reconstructPreview(
        guard.session.measuredColumns,
        currentColumns,
        currentPlan.matrix,
        guard,
      );
      const candidateReconstruction = await this.reconstructPreview(
        guard.session.measuredColumns,
        candidateColumns,
        candidatePlan.matrix,
        guard,
      );
      this.assertPreviewCurrent(guard);
      this.emit({
        protocol: COMPENSATION_WORKER_PROTOCOL,
        type: "preview-solved",
        sessionId: guard.session.sessionId,
        sessionToken: guard.session.sessionToken,
        profileHash: guard.session.profileHash,
        bindingKey: guard.session.bindingKey,
        requestId: guard.requestId,
        eventCount: guard.session.fixedEventIndices.length,
        sourceChannels: guard.session.sourceChannels,
        receiverBindings: guard.session.receiverBindings,
        sourceBindings: guard.session.sourceBindings,
        currentColumns,
        candidateColumns,
        deltas: comparison.deltas,
        impacts: comparison.impacts,
        impactRanking: comparison.impactRanking,
        currentDiagnostics: currentPlan.diagnostics,
        candidateDiagnostics: candidatePlan.diagnostics,
        currentReconstruction,
        candidateReconstruction,
      });
    } catch (error) {
      if (error === TASK_ABORTED) return;
      if (!this.isPreviewCurrent(guard)) return;
      this.emitError(
        "preview",
        guard.session.sessionId,
        guard.session.sessionToken,
        compensationErrorCode(error),
        errorMessage(error),
        true,
        guard.requestId,
      );
    }
  }

  private async solvePreviewColumns(
    session: PreviewSession,
    plan: FlowCompensationPlan,
    guard: PreviewGuard,
  ): Promise<readonly Float64Array[]> {
    const eventCount = session.fixedEventIndices.length;
    const output = Array.from(
      { length: plan.matrix.length },
      () => new Float64Array(eventCount),
    );
    for (let start = 0; start < eventCount; start += this.microbatchEvents) {
      const end = Math.min(start + this.microbatchEvents, eventCount);
      this.assertFiniteMeasuredRange(
        session.measuredColumns,
        start,
        end,
        (event) => session.fixedEventIndices[event],
      );
      compensateFlowRange(session.measuredColumns, plan, output, {
        inputStart: start,
        inputEnd: end,
        outputStart: start,
        validateMeasuredValues: false,
        validateOutputValues: false,
      });
      this.assertFiniteOutputRange(output, start, end, (event) => session.fixedEventIndices[event]);
      await this.previewCheckpoint(guard);
    }
    return Object.freeze(output);
  }

  private async summarizePreview(
    currentColumns: readonly Float64Array[],
    candidateColumns: readonly Float64Array[],
    guard: PreviewGuard,
  ): Promise<{
    readonly deltas: readonly Float64Array[];
    readonly impacts: readonly FlowChannelImpact[];
    readonly impactRanking: readonly FlowChannelImpact[];
  }> {
    const eventCount = guard.session.fixedEventIndices.length;
    const relativeTolerance = 64 * Number.EPSILON;
    const deltas: Float64Array[] = [];
    const impacts: FlowChannelImpact[] = [];
    for (let channel = 0; channel < currentColumns.length; channel++) {
      const delta = new Float64Array(eventCount);
      const absoluteDeltas = new Array<number>(eventCount);
      let sumAbsolute = 0;
      let sumSquares = 0;
      let maximumAbsolute = 0;
      let changedCount = 0;
      let negativeToNonNegativeCount = 0;
      let nonNegativeToNegativeCount = 0;
      for (let start = 0; start < eventCount; start += this.microbatchEvents) {
        const end = Math.min(start + this.microbatchEvents, eventCount);
        for (let event = start; event < end; event++) {
          const before = currentColumns[channel][event];
          const after = candidateColumns[channel][event];
          const difference = after - before;
          const absolute = Math.abs(difference);
          delta[event] = difference;
          absoluteDeltas[event] = absolute;
          sumAbsolute += absolute;
          sumSquares += difference * difference;
          maximumAbsolute = Math.max(maximumAbsolute, absolute);
          const tolerance = relativeTolerance * Math.max(Math.abs(before), Math.abs(after));
          if (absolute > tolerance) {
            changedCount++;
            const beforeNegative = before < 0;
            const afterNegative = after < 0;
            if (beforeNegative && !afterNegative) negativeToNonNegativeCount++;
            else if (!beforeNegative && afterNegative) nonNegativeToNegativeCount++;
          }
        }
        await this.previewCheckpoint(guard);
      }
      absoluteDeltas.sort((left, right) => left - right);
      await this.previewCheckpoint(guard);
      const impact: FlowChannelImpact = Object.freeze({
        channelIndex: channel,
        channel: guard.session.sourceChannels[channel],
        medianAbsoluteDelta: quantile(absoluteDeltas, 0.5),
        upperTailAbsoluteDelta: quantile(absoluteDeltas, 0.95),
        meanAbsoluteDelta: eventCount === 0 ? 0 : sumAbsolute / eventCount,
        rootMeanSquareDelta: eventCount === 0 ? 0 : Math.sqrt(sumSquares / eventCount),
        maximumAbsoluteDelta: maximumAbsolute,
        changedCount,
        fractionChanged: eventCount === 0 ? 0 : changedCount / eventCount,
        negativeToNonNegativeCount,
        nonNegativeToNegativeCount,
        signCrossingCount: negativeToNonNegativeCount + nonNegativeToNegativeCount,
      });
      deltas.push(delta);
      impacts.push(impact);
    }
    const impactRanking = Array.from(impacts).sort(
      (left, right) =>
        right.medianAbsoluteDelta - left.medianAbsoluteDelta ||
        right.upperTailAbsoluteDelta - left.upperTailAbsoluteDelta ||
        right.meanAbsoluteDelta - left.meanAbsoluteDelta ||
        left.channelIndex - right.channelIndex,
    );
    return {
      deltas: Object.freeze(deltas),
      impacts: Object.freeze(impacts),
      impactRanking: Object.freeze(impactRanking),
    };
  }

  private async reconstructPreview(
    measuredColumns: readonly Float64Array[],
    compensatedColumns: readonly Float64Array[],
    matrix: readonly (readonly number[])[],
    guard: PreviewGuard,
  ): Promise<FlowReconstructionDiagnostics> {
    const eventCount = guard.session.fixedEventIndices.length;
    let maximumAbsoluteResidual = 0;
    let residualInfinityNorm = 0;
    let measuredInfinityNorm = 0;
    let compensatedInfinityNorm = 0;
    for (let start = 0; start < eventCount; start += this.microbatchEvents) {
      const end = Math.min(start + this.microbatchEvents, eventCount);
      for (let event = start; event < end; event++) {
        let eventResidualSum = 0;
        let measuredEventSum = 0;
        let compensatedEventSum = 0;
        for (let source = 0; source < matrix.length; source++) {
          compensatedEventSum += Math.abs(compensatedColumns[source][event]);
        }
        for (let receiver = 0; receiver < matrix.length; receiver++) {
          let reconstructed = 0;
          for (let source = 0; source < matrix.length; source++) {
            reconstructed += compensatedColumns[source][event] * matrix[source][receiver];
          }
          const measured = measuredColumns[receiver][event];
          const residual = reconstructed - measured;
          maximumAbsoluteResidual = Math.max(maximumAbsoluteResidual, Math.abs(residual));
          eventResidualSum += Math.abs(residual);
          measuredEventSum += Math.abs(measured);
        }
        residualInfinityNorm = Math.max(residualInfinityNorm, eventResidualSum);
        measuredInfinityNorm = Math.max(measuredInfinityNorm, measuredEventSum);
        compensatedInfinityNorm = Math.max(compensatedInfinityNorm, compensatedEventSum);
      }
      await this.previewCheckpoint(guard);
    }
    const denominator = compensatedInfinityNorm * matrixInfinityNorm(matrix) + measuredInfinityNorm;
    const relativeBackwardError = denominator === 0
      ? residualInfinityNorm === 0 ? 0 : Number.POSITIVE_INFINITY
      : residualInfinityNorm / denominator;
    return Object.freeze({
      maximumAbsoluteResidual,
      residualInfinityNorm,
      measuredInfinityNorm,
      compensatedInfinityNorm,
      relativeBackwardError,
    });
  }

  private handleStartApply(request: StartApplyRequest): void {
    const identityError = this.applyIdentityError(request);
    if (identityError !== null) {
      this.emitError("apply", request.jobId ?? null, request.jobToken ?? null,
        "invalid-apply-request", identityError, true);
      return;
    }
    if (request.method !== "matrix-inverse" && request.method !== "nnls") {
      this.emitError("apply", request.jobId, request.jobToken,
        "unsupported-method", "The requested compensation method is not supported.", true);
      return;
    }
    if (
      !Number.isSafeInteger(request.totalEvents) ||
      request.totalEvents < 0 ||
      !Number.isSafeInteger(request.channelCount) ||
      request.channelCount <= 0 ||
      !Number.isSafeInteger(request.byteBudget) ||
      request.byteBudget <= 0
    ) {
      this.emitError("apply", request.jobId, request.jobToken,
        "invalid-apply-request", "Apply dimensions and byte budget must be non-negative/positive safe integers.", true);
      return;
    }
    const active = this.activeApplyJob;
    if (active !== null && !active.cancelled && !active.complete) {
      this.emitError("apply", request.jobId, request.jobToken,
        "apply-job-active", "Another compensation Apply job is still active.", true);
      return;
    }
    try {
      const plan = request.method === "matrix-inverse"
        ? prepareFlowCompensation(request.matrix, request.flowSettings)
        : prepareCytofNnls(request.sourceChannels, request.matrix, request.nnlsSettings);
      if (plan.matrix.length !== request.channelCount) {
        throw new FlowCompensationError(
          "dimension-mismatch",
          "Apply channelCount must match the spillover matrix size.",
        );
      }
      const applyBindings = validateChannelBindings(request, request.channelCount);
      // Apply has priority in the single deterministic worker. Supersede any preview task before
      // installing the job so preview and full-file solves cannot interleave their compute/memory.
      for (const session of this.previews.values()) {
        session.cancelled = true;
        session.generation++;
      }
      this.previews.clear();
      const prior = this.applyJobs.get(request.jobId);
      if (prior !== undefined) prior.cancelled = true;
      const job: ApplyJob = {
        jobId: request.jobId,
        jobToken: request.jobToken,
        profileHash: request.profileHash,
        bindingKey: request.bindingKey,
        method: request.method,
        plan,
        totalEvents: request.totalEvents,
        channelCount: request.channelCount,
        byteBudget: request.byteBudget,
        receiverBindings: applyBindings.receiverBindings,
        sourceBindings: applyBindings.sourceBindings,
        nextChunkIndex: 0,
        processedEvents: 0,
        busy: false,
        cancelled: false,
        complete: false,
      };
      this.applyJobs.set(job.jobId, job);
      this.activeApplyJob = job;
      this.emit({
        protocol: COMPENSATION_WORKER_PROTOCOL,
        type: "apply-started",
        jobId: job.jobId,
        jobToken: job.jobToken,
        profileHash: job.profileHash,
        bindingKey: job.bindingKey,
        totalEvents: job.totalEvents,
        channelCount: job.channelCount,
        byteBudget: job.byteBudget,
        diagnostics: job.plan.diagnostics,
        receiverBindings: job.receiverBindings,
        sourceBindings: job.sourceBindings,
      });
      if (job.totalEvents === 0) {
        job.complete = true;
        this.emitApplyProgress(job);
        this.emit({
          protocol: COMPENSATION_WORKER_PROTOCOL,
          type: "apply-complete",
          jobId: job.jobId,
          jobToken: job.jobToken,
          profileHash: job.profileHash,
          bindingKey: job.bindingKey,
          processedEvents: 0,
          totalEvents: 0,
          outputBindings: job.sourceBindings,
          allFinite: true,
        });
        this.releaseApplyJob(job);
      }
    } catch (error) {
      this.emitError("apply", request.jobId, request.jobToken,
        compensationErrorCode(error), errorMessage(error), true);
    }
  }

  private handleApplyChunk(request: ApplyChunkRequest): void {
    const identityError = this.applyIdentityError(request);
    if (identityError !== null) {
      this.emitError("apply", request.jobId ?? null, request.jobToken ?? null,
        "invalid-apply-request", identityError, true);
      return;
    }
    const job = this.applyJobs.get(request.jobId);
    if (
      job === undefined ||
      this.activeApplyJob !== job ||
      !this.matchesApplyIdentity(job, request) ||
      job.cancelled
    ) {
      this.emitError("apply", request.jobId, request.jobToken,
        "stale-apply-job", "The Apply job is missing, cancelled, or its identity is stale.", true);
      return;
    }
    if (job.complete) {
      this.emitError("apply", request.jobId, request.jobToken,
        "apply-already-complete", "The Apply job has already completed.", true);
      return;
    }
    if (job.busy) {
      this.emitError("apply", request.jobId, request.jobToken,
        "apply-chunk-in-flight", "Wait for the current Apply chunk before sending another.", true);
      return;
    }
    if (
      !Number.isSafeInteger(request.chunkIndex) ||
      request.chunkIndex !== job.nextChunkIndex ||
      !Number.isSafeInteger(request.startEvent) ||
      request.startEvent !== job.processedEvents
    ) {
      this.emitError("apply", request.jobId, request.jobToken,
        "out-of-order-apply-chunk", "Apply chunks must be contiguous and strictly sequential.", true);
      return;
    }
    if (
      !Array.isArray(request.measuredColumns) ||
      request.measuredColumns.length !== job.channelCount ||
      request.measuredColumns.some((column) => !(column instanceof Float64Array))
    ) {
      this.emitError("apply", request.jobId, request.jobToken,
        "dimension-mismatch", "Apply measurements must be Float64 columns in receiver-channel order.", true);
      return;
    }
    const eventCount = request.measuredColumns[0]?.length ?? 0;
    const transferredInputBytes = request.measuredColumns.reduce(
      (total, column) => total + column.byteLength,
      0,
    );
    const outputBytes = eventCount * job.channelCount * Float32Array.BYTES_PER_ELEMENT;
    if (
      eventCount <= 0 ||
      request.measuredColumns.some((column) => column.length !== eventCount) ||
      request.startEvent + eventCount > job.totalEvents
    ) {
      this.emitError("apply", request.jobId, request.jobToken,
        "dimension-mismatch", "Apply chunks must contain equally sized columns within the declared total event count.", true);
      return;
    }
    if (!hasExactDistinctArrayBuffers(request.measuredColumns)) {
      this.emitError("apply", request.jobId, request.jobToken,
        "invalid-transfer-buffer",
        "Apply measurements must use exact-owned, distinct ArrayBuffers.", true);
      return;
    }
    if (transferredInputBytes + outputBytes > job.byteBudget) {
      this.emitError("apply", request.jobId, request.jobToken,
        "apply-chunk-over-budget", "The Apply chunk's input and output arrays exceed the job's transient byte budget.", true);
      return;
    }
    job.busy = true;
    void this.runApplyChunk(job, request, eventCount);
  }

  private async runApplyChunk(
    job: ApplyJob,
    request: ApplyChunkRequest,
    eventCount: number,
  ): Promise<void> {
    try {
      await this.applyCheckpoint(job);
      const output = Array.from(
        { length: job.channelCount },
        () => new Float32Array(eventCount),
      );
      for (let start = 0; start < eventCount; start += this.microbatchEvents) {
        const end = Math.min(start + this.microbatchEvents, eventCount);
        this.assertFiniteMeasuredRange(
          request.measuredColumns,
          start,
          end,
          (event) => request.startEvent + event,
        );
        if (job.method === "matrix-inverse") {
          compensateFlowRange(
            request.measuredColumns,
            job.plan as FlowCompensationPlan,
            output,
            {
              inputStart: start,
              inputEnd: end,
              outputStart: start,
              validateMeasuredValues: false,
              validateOutputValues: false,
            },
          );
        } else {
          compensateCytofRange(
            request.measuredColumns,
            job.plan as CytofNnlsPlan,
            output,
            {
              inputStart: start,
              inputEnd: end,
              outputStart: start,
              validateMeasuredValues: false,
              validateOutputValues: false,
            },
          );
        }
        this.assertFiniteOutputRange(output, start, end, (event) => request.startEvent + event);
        await this.applyCheckpoint(job);
      }
      if (job.cancelled || !this.matchesApplyIdentity(job, request)) throw TASK_ABORTED;
      job.processedEvents += eventCount;
      job.nextChunkIndex++;
      job.busy = false;
      this.emit({
        protocol: COMPENSATION_WORKER_PROTOCOL,
        type: "apply-chunk-complete",
        jobId: job.jobId,
        jobToken: job.jobToken,
        profileHash: job.profileHash,
        bindingKey: job.bindingKey,
        chunkIndex: request.chunkIndex,
        startEvent: request.startEvent,
        eventCount,
        outputBindings: job.sourceBindings,
        columns: Object.freeze(output),
      });
      this.emitApplyProgress(job);
      if (job.processedEvents === job.totalEvents) {
        job.complete = true;
        this.emit({
          protocol: COMPENSATION_WORKER_PROTOCOL,
          type: "apply-complete",
          jobId: job.jobId,
          jobToken: job.jobToken,
          profileHash: job.profileHash,
          bindingKey: job.bindingKey,
          processedEvents: job.processedEvents,
          totalEvents: job.totalEvents,
          outputBindings: job.sourceBindings,
          allFinite: true,
        });
        this.releaseApplyJob(job);
      }
    } catch (error) {
      job.busy = false;
      if (error === TASK_ABORTED || job.cancelled) {
        this.releaseApplyJob(job);
        return;
      }
      // A failed chunk is terminal for this job. Keeping it active would block a clean retry and
      // could tempt a caller to continue after an unknown partial worker state.
      job.cancelled = true;
      this.releaseApplyJob(job);
      this.emitError(
        "apply",
        job.jobId,
        job.jobToken,
        compensationErrorCode(error),
        errorMessage(error),
        true,
      );
    }
  }

  private emitApplyProgress(job: ApplyJob): void {
    this.emit({
      protocol: COMPENSATION_WORKER_PROTOCOL,
      type: "apply-progress",
      jobId: job.jobId,
      jobToken: job.jobToken,
      profileHash: job.profileHash,
      bindingKey: job.bindingKey,
      processedEvents: job.processedEvents,
      totalEvents: job.totalEvents,
      fraction: job.totalEvents === 0 ? 1 : job.processedEvents / job.totalEvents,
      outputBindings: job.sourceBindings,
    });
  }

  private handleCancel(request: CompensationWorkerRequest): void {
    if (request.type !== "cancel") return;
    if (
      (request.target !== "preview" && request.target !== "apply") ||
      !isNonEmptyString(request.id) ||
      !isNonEmptyString(request.token)
    ) {
      this.emitError("protocol", null, null, "invalid-cancel-request",
        "Cancel requests require a valid target, id, and token.", false);
      return;
    }
    if (request.target === "preview") {
      const session = this.previews.get(request.id);
      if (session === undefined || session.sessionToken !== request.token) {
        this.emitError("preview", request.id, request.token, "stale-cancel",
          "The preview cancellation token is stale.", true);
        return;
      }
      session.cancelled = true;
      session.generation++;
      this.previews.delete(request.id);
    } else {
      const job = this.applyJobs.get(request.id);
      if (job === undefined || job.jobToken !== request.token) {
        this.emitError("apply", request.id, request.token, "stale-cancel",
          "The Apply cancellation token is stale.", true);
        return;
      }
      job.cancelled = true;
      this.releaseApplyJob(job);
    }
    this.emit({
      protocol: COMPENSATION_WORKER_PROTOCOL,
      type: "cancelled",
      target: request.target,
      id: request.id,
      token: request.token,
    });
  }

  private async previewCheckpoint(guard: PreviewGuard): Promise<void> {
    await this.yieldToEventLoop();
    this.assertPreviewCurrent(guard);
  }

  private isPreviewCurrent(guard: PreviewGuard): boolean {
    const session = this.previews.get(guard.session.sessionId);
    return session === guard.session &&
      !session.cancelled &&
      session.generation === guard.generation &&
      session.latestRequestId === guard.requestId;
  }

  private assertPreviewCurrent(guard: PreviewGuard): void {
    if (!this.isPreviewCurrent(guard)) throw TASK_ABORTED;
  }

  private async applyCheckpoint(job: ApplyJob): Promise<void> {
    await this.yieldToEventLoop();
    if (job.cancelled || this.applyJobs.get(job.jobId) !== job) throw TASK_ABORTED;
  }

  private assertFiniteMeasuredRange(
    columns: readonly Float64Array[],
    start: number,
    end: number,
    globalEventIndex: (localEvent: number) => number,
  ): void {
    for (let receiver = 0; receiver < columns.length; receiver++) {
      for (let event = start; event < end; event++) {
        if (!Number.isFinite(columns[receiver][event])) {
          throw new FlowCompensationError(
            "non-finite-measured-value",
            `Measured value at receiver ${receiver + 1}, event ${globalEventIndex(event) + 1} must be finite.`,
          );
        }
      }
    }
  }

  private assertFiniteOutputRange(
    columns: readonly (Float32Array | Float64Array)[],
    start: number,
    end: number,
    globalEventIndex: (localEvent: number) => number,
  ): void {
    for (let source = 0; source < columns.length; source++) {
      for (let event = start; event < end; event++) {
        if (!Number.isFinite(columns[source][event])) {
          throw new FlowCompensationError(
            "non-finite-output",
            `Compensated value at source ${source + 1}, event ${globalEventIndex(event) + 1} is not finite.`,
          );
        }
      }
    }
  }

  private previewIdentityError(request: Partial<PrimePreviewRequest | SolvePreviewRequest>): string | null {
    return isNonEmptyString(request.sessionId) &&
      isNonEmptyString(request.sessionToken) &&
      isNonEmptyString(request.profileHash) &&
      isNonEmptyString(request.bindingKey)
      ? null
      : "Preview identity fields must be non-empty strings.";
  }

  private applyIdentityError(request: Partial<StartApplyRequest | ApplyChunkRequest>): string | null {
    return isNonEmptyString(request.jobId) &&
      isNonEmptyString(request.jobToken) &&
      isNonEmptyString(request.profileHash) &&
      isNonEmptyString(request.bindingKey)
      ? null
      : "Apply identity fields must be non-empty strings.";
  }

  private matchesPreviewIdentity(
    session: PreviewSession,
    request: Pick<SolvePreviewRequest, "sessionToken" | "profileHash" | "bindingKey">,
  ): boolean {
    return session.sessionToken === request.sessionToken &&
      session.profileHash === request.profileHash &&
      session.bindingKey === request.bindingKey;
  }

  private matchesApplyIdentity(
    job: ApplyJob,
    request: Pick<ApplyChunkRequest, "jobToken" | "profileHash" | "bindingKey">,
  ): boolean {
    return job.jobToken === request.jobToken &&
      job.profileHash === request.profileHash &&
      job.bindingKey === request.bindingKey;
  }

  private hasActiveApplyJob(): boolean {
    const job = this.activeApplyJob;
    return job !== null && this.applyJobs.get(job.jobId) === job &&
      !job.cancelled && !job.complete;
  }

  private releaseApplyJob(job: ApplyJob): void {
    if (this.activeApplyJob === job) this.activeApplyJob = null;
    if (this.applyJobs.get(job.jobId) === job) this.applyJobs.delete(job.jobId);
  }
}

export function createCompensationWorkerRuntime(
  options: CompensationWorkerRuntimeOptions,
): CompensationWorkerRuntime {
  return new CompensationWorkerRuntime(options);
}
