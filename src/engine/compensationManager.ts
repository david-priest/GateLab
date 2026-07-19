import { reportMatrixCompatibility, type MatrixChannelBinding } from "./compensationCompatibility";
import {
  FLOW_SOLVER_VERSION,
  type FlowSolverSettings,
} from "./flowCompensationEngine";
import {
  CYTOF_NNLS_SOLVER_VERSION,
  adaptCytofSpilloverMatrix,
} from "./cytofCompensationEngine";
import type { NnlsSolverSettingsInput } from "./compensationProfile";
import {
  validateCompensationProfileRecord,
  type CompensationProfileRecord,
} from "./compensationProfileRecord";
import {
  Sample,
  type AssayLayer,
  type CompensatedLayerOutputBinding,
  type CompensatedLayerStaging,
  type CompensatedLayerStagingIdentity,
  type PreparedCompensatedLayer,
} from "./sample";
import type { PersistedCompensatedLayerBinding } from "./workspaceCompensation";
import {
  COMPENSATION_WORKER_PROTOCOL,
  requestTransferables,
  type ApplyChunkCompleteResponse,
  type CompensationWorkerChannelBinding,
  type CompensationWorkerRequest,
  type CompensationWorkerResponse,
  type PreviewSolvedResponse,
} from "../workers/compensationProtocol";

const DEFAULT_BYTE_BUDGET = 64 * 1024 * 1024;
const DEFAULT_FIXED_WORKSPACE_BYTES = 256 * 1024;
const DEFAULT_COPY_SLICE_EVENTS = 8_192;
const DEFAULT_MAX_EVENTS_PER_CHUNK = 8_192;
const DEFAULT_MAX_PREVIEW_EVENTS = 20_000;
const DEFAULT_PREVIEW_BYTE_BUDGET = 64 * 1024 * 1024;
const ESTIMATED_PREVIEW_BYTES_PER_CHANNEL_EVENT = 5 * Float64Array.BYTES_PER_ELEMENT;

export interface CompensationWorkerLike {
  onmessage: ((event: MessageEvent<CompensationWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: CompensationWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

export type CompensationWorkerFactory = () => CompensationWorkerLike;

export interface CompensationChunkPlan {
  readonly totalByteBudget: number;
  readonly fixedWorkspaceBytes: number;
  readonly transientByteBudget: number;
  readonly bytesPerEvent: number;
  readonly eventsPerChunk: number;
  readonly chunkCount: number;
}

export interface CompensationManagerOptions {
  readonly workspaceKey?: string;
  readonly workerFactory?: CompensationWorkerFactory;
  readonly byteBudget?: number;
  readonly fixedWorkspaceBytes?: number;
  readonly copySliceEvents?: number;
  readonly maxPreviewEvents?: number;
  readonly previewByteBudget?: number;
  /** Test seam. Production yields to a macrotask so React and Cancel remain responsive. */
  readonly yieldToEventLoop?: () => Promise<void>;
}

export interface CompensationApplyTarget {
  readonly sample: Sample;
  /** Apply activates the complete derived assay by default. */
  readonly activeLayer?: AssayLayer;
}

export interface CompensationApplyProgress {
  readonly jobId: string;
  readonly sampleIndex: number;
  readonly sampleCount: number;
  readonly sampleProcessedEvents: number;
  readonly sampleTotalEvents: number;
  readonly processedEvents: number;
  readonly totalEvents: number;
  readonly fraction: number;
}

export interface CompensationApplyRequest {
  readonly profile: CompensationProfileRecord;
  readonly targets: readonly CompensationApplyTarget[];
  readonly byteBudget?: number;
  readonly fixedWorkspaceBytes?: number;
  readonly onProgress?: (progress: CompensationApplyProgress) => void;
}

export interface CompensationApplyTargetResult {
  readonly sample: Sample;
  readonly binding: PersistedCompensatedLayerBinding;
}

export interface CompensationApplyResult {
  readonly jobId: string;
  readonly profile: CompensationProfileRecord;
  readonly targets: readonly CompensationApplyTargetResult[];
}

export interface PrimeCompensationPreviewRequest {
  readonly profile: CompensationProfileRecord;
  readonly sample: Sample;
  readonly fixedEventIndices: Uint32Array;
}

export interface PrimedCompensationPreview {
  readonly sessionId: string;
  readonly eventCount: number;
  readonly profileHash: string;
  readonly bindingKey: string;
}

export class CompensationManagerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CompensationManagerError";
    this.code = code;
  }
}

export class CompensationCancelledError extends CompensationManagerError {
  constructor(message = "The compensation operation was cancelled.") {
    super("cancelled", message);
    this.name = "CompensationCancelledError";
  }
}

interface Waiter {
  readonly predicate: (response: CompensationWorkerResponse) => boolean;
  readonly errorMatches: (response: Extract<CompensationWorkerResponse, { type: "worker-error" }>) => boolean;
  readonly resolve: (response: CompensationWorkerResponse) => void;
  readonly reject: (error: unknown) => void;
  readonly tag: string;
}

interface SampleSnapshot {
  readonly sample: Sample;
  readonly dataRevision: number;
  readonly layerRevision: number;
  readonly activeLayer: AssayLayer;
  readonly displayTransformContextKey: string;
  readonly channelSignature: string;
  readonly invalidationGeneration: number;
  readonly bindingFingerprint: string;
  readonly binding: PersistedCompensatedLayerBinding;
  readonly receiverResolvedIndices: readonly number[];
  readonly solveChannels: readonly string[];
  readonly solveMatrix: readonly (readonly number[])[];
  readonly workerBindings: readonly CompensationWorkerChannelBinding[];
}

interface ActiveApply {
  readonly aggregateId: string;
  readonly token: string;
  readonly workspaceEpoch: number;
  readonly workspaceKey: string;
  readonly profileId: string;
  readonly profileGeneration: number;
  cancelled: boolean;
  currentWorkerJob: Readonly<{ id: string; token: string }> | null;
}

interface ApplyReservation {
  readonly workspaceEpoch: number;
  readonly workspaceKey: string;
  readonly profileId: string;
  readonly samples: ReadonlySet<Sample>;
  cancelled: boolean;
}

interface PreviewPrimeReservation {
  readonly workspaceEpoch: number;
  readonly workspaceKey: string;
  readonly profileId: string;
  readonly profileGeneration: number;
  readonly sample: Sample;
  readonly sampleGeneration: number;
  cancelled: boolean;
}

interface SolvedApplyTarget {
  readonly result: CompensationApplyTargetResult;
  readonly prepared: PreparedCompensatedLayer;
}

interface PreviewSessionState {
  readonly sessionId: string;
  readonly token: string;
  readonly workspaceEpoch: number;
  readonly workspaceKey: string;
  readonly profile: CompensationProfileRecord;
  readonly profileGeneration: number;
  readonly snapshot: SampleSnapshot;
  readonly bindingKey: string;
  readonly eventCount: number;
  requestSequence: number;
  pendingRequestTag: string | null;
}

function defaultWorkerFactory(): CompensationWorkerLike {
  return new Worker(
    new URL("../workers/compensation.worker.ts", import.meta.url),
    { type: "module", name: "gatelab-compensation" },
  ) as CompensationWorkerLike;
}

function defaultYieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CompensationManagerError("invalid-memory-budget", `${label} must be a positive safe integer.`);
  }
  return value;
}

/**
 * Plan one worker chunk from a total memory budget. The final installed Float32 columns are
 * persistent result storage and deliberately excluded; this budget covers the simultaneous
 * receiver-order Float64 input, source-order Float32 output, and fixed solver workspace.
 */
export function planCompensationChunks(input: Readonly<{
  totalEvents: number;
  channelCount: number;
  byteBudget?: number;
  fixedWorkspaceBytes?: number;
  maxEventsPerChunk?: number;
}>): CompensationChunkPlan {
  if (!Number.isSafeInteger(input.totalEvents) || input.totalEvents < 0) {
    throw new CompensationManagerError("invalid-event-count", "Compensation totalEvents must be a non-negative safe integer.");
  }
  const channelCount = positiveSafeInteger(input.channelCount, "Compensation channelCount");
  const totalByteBudget = positiveSafeInteger(
    input.byteBudget ?? DEFAULT_BYTE_BUDGET,
    "Compensation byte budget",
  );
  const fixedWorkspaceBytes = input.fixedWorkspaceBytes ?? DEFAULT_FIXED_WORKSPACE_BYTES;
  if (!Number.isSafeInteger(fixedWorkspaceBytes) || fixedWorkspaceBytes < 0) {
    throw new CompensationManagerError(
      "invalid-memory-budget",
      "Compensation fixed workspace must be a non-negative safe integer.",
    );
  }
  const transientByteBudget = totalByteBudget - fixedWorkspaceBytes;
  const bytesPerEvent = channelCount * (
    Float64Array.BYTES_PER_ELEMENT + Float32Array.BYTES_PER_ELEMENT
  );
  if (transientByteBudget < bytesPerEvent) {
    throw new CompensationManagerError(
      "memory-budget-too-small",
      `Compensation needs at least ${fixedWorkspaceBytes + bytesPerEvent} bytes for one event across ${channelCount} channels.`,
    );
  }
  const maxEventsPerChunk = positiveSafeInteger(
    input.maxEventsPerChunk ?? DEFAULT_MAX_EVENTS_PER_CHUNK,
    "Compensation maximum events per chunk",
  );
  const eventsPerChunk = Math.max(
    1,
    Math.min(maxEventsPerChunk, Math.floor(transientByteBudget / bytesPerEvent)),
  );
  return Object.freeze({
    totalByteBudget,
    fixedWorkspaceBytes,
    transientByteBudget,
    bytesPerEvent,
    eventsPerChunk,
    chunkCount: input.totalEvents === 0 ? 0 : Math.ceil(input.totalEvents / eventsPerChunk),
  });
}

function channelSignature(sample: Sample): string {
  return JSON.stringify(sample.channels.map(({ pnn, columnIndex }) => [pnn, columnIndex]));
}

function bindingsFingerprint(bindings: readonly MatrixChannelBinding[]): string {
  return JSON.stringify(bindings.map((binding) => [
    binding.pnn,
    binding.fcsColumnIndex,
    binding.matrixSourceIndex,
    binding.matrixReceiverIndex,
    binding.included,
  ]));
}

function sameWorkerBinding(
  left: CompensationWorkerChannelBinding,
  right: CompensationWorkerChannelBinding,
): boolean {
  return left.pnn === right.pnn &&
    left.fcsColumnIndex === right.fcsColumnIndex &&
    left.matrixSourceIndex === right.matrixSourceIndex &&
    left.matrixReceiverIndex === right.matrixReceiverIndex;
}

function sameWorkerBindings(
  left: readonly CompensationWorkerChannelBinding[],
  right: readonly CompensationWorkerChannelBinding[],
): boolean {
  if (!hasDenseArrayLength(left, right.length) || !hasDenseArrayLength(right, left.length)) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (!sameWorkerBinding(left[index], right[index])) return false;
  }
  return true;
}

function hasDenseArrayLength(value: unknown, length: number): value is readonly unknown[] {
  if (!Array.isArray(value) || value.length !== length) return false;
  for (let index = 0; index < length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

function isFiniteFloat64Column(value: unknown, eventCount: number): value is Float64Array {
  if (!(value instanceof Float64Array) || value.length !== eventCount) return false;
  for (let event = 0; event < value.length; event++) {
    if (!Number.isFinite(value[event])) return false;
  }
  return true;
}

function workerBindingsForSnapshot(snapshot: SampleSnapshot): Readonly<{
  receiver: readonly CompensationWorkerChannelBinding[];
  source: readonly CompensationWorkerChannelBinding[];
}> {
  const receiver = snapshot.workerBindings;
  return Object.freeze({
    receiver,
    source: Object.freeze(Array.from(receiver).sort(
      (left, right) => left.matrixSourceIndex - right.matrixSourceIndex,
    )),
  });
}

function profileFlowSettings(profile: CompensationProfileRecord): FlowSolverSettings {
  const settings = Object.fromEntries(
    profile.scientific.solverSettings.map(({ key, value }) => [key, value]),
  );
  const singularTolerance = settings.singularTolerance;
  const conditionWarningThreshold = settings.conditionWarningThreshold;
  if (
    typeof singularTolerance !== "number" ||
    typeof conditionWarningThreshold !== "number"
  ) {
    throw new CompensationManagerError(
      "unsupported-solver-settings",
      "The flow profile does not contain the exact LU solver settings required by this GateLab version.",
    );
  }
  return Object.freeze({ singularTolerance, conditionWarningThreshold });
}

function profileNnlsSettings(profile: CompensationProfileRecord): NnlsSolverSettingsInput {
  const settings = Object.fromEntries(
    profile.scientific.solverSettings.map(({ key, value }) => [key, value]),
  );
  const { tolerance, kktTolerance, maxIterations, adaptationVersion } = settings;
  if (
    typeof tolerance !== "number" ||
    typeof kktTolerance !== "number" ||
    typeof maxIterations !== "number" ||
    typeof adaptationVersion !== "string"
  ) {
    throw new CompensationManagerError(
      "unsupported-solver-settings",
      "The CyTOF profile does not contain the exact NNLS settings required by this GateLab version.",
    );
  }
  return Object.freeze({ tolerance, kktTolerance, maxIterations, adaptationVersion });
}

function workerError(response: Extract<CompensationWorkerResponse, { type: "worker-error" }>): Error {
  return new CompensationManagerError(
    response.code,
    `Compensation worker ${response.scope} error: ${response.message}`,
  );
}

/** Owns the single deterministic compensation worker independently of any rendered tab. */
export class CompensationManager {
  private readonly workerFactory: CompensationWorkerFactory;
  private readonly defaultByteBudget: number;
  private readonly defaultFixedWorkspaceBytes: number;
  private readonly copySliceEvents: number;
  private readonly maxPreviewEvents: number;
  private readonly previewByteBudget: number;
  private readonly yieldToEventLoop: () => Promise<void>;
  private worker: CompensationWorkerLike | null = null;
  private workerBroken = false;
  private readonly waiters = new Set<Waiter>();
  private readonly sampleGenerations = new WeakMap<Sample, number>();
  private readonly profileGenerations = new Map<string, number>();
  private workspaceKey: string;
  private workspaceEpoch = 0;
  private sequence = 0;
  private disposed = false;
  private applyReservation: ApplyReservation | null = null;
  private previewPrimeReservation: PreviewPrimeReservation | null = null;
  private activeApply: ActiveApply | null = null;
  private preview: PreviewSessionState | null = null;

  constructor(options: CompensationManagerOptions = {}) {
    this.workspaceKey = options.workspaceKey ?? "workspace:unbound";
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.defaultByteBudget = positiveSafeInteger(
      options.byteBudget ?? DEFAULT_BYTE_BUDGET,
      "Compensation byte budget",
    );
    const fixed = options.fixedWorkspaceBytes ?? DEFAULT_FIXED_WORKSPACE_BYTES;
    if (!Number.isSafeInteger(fixed) || fixed < 0) {
      throw new CompensationManagerError("invalid-memory-budget", "Fixed workspace bytes must be a non-negative safe integer.");
    }
    this.defaultFixedWorkspaceBytes = fixed;
    this.copySliceEvents = positiveSafeInteger(
      options.copySliceEvents ?? DEFAULT_COPY_SLICE_EVENTS,
      "Compensation copy slice",
    );
    this.maxPreviewEvents = positiveSafeInteger(
      options.maxPreviewEvents ?? DEFAULT_MAX_PREVIEW_EVENTS,
      "Compensation preview event limit",
    );
    this.previewByteBudget = positiveSafeInteger(
      options.previewByteBudget ?? DEFAULT_PREVIEW_BYTE_BUDGET,
      "Compensation preview byte budget",
    );
    this.yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;
  }

  /** Synchronous UI guard covering both validation/reservation and active worker phases. */
  get applyInProgress(): boolean {
    return this.applyReservation !== null || this.activeApply !== null;
  }

  /** Workspace replacement is an explicit scientific-identity boundary, not a tab lifecycle. */
  resetWorkspace(nextWorkspaceKey: string): void {
    this.assertUsable();
    if (typeof nextWorkspaceKey !== "string" || nextWorkspaceKey.trim().length === 0) {
      throw new CompensationManagerError("invalid-workspace", "A non-blank workspace key is required.");
    }
    this.workspaceEpoch++;
    this.workspaceKey = nextWorkspaceKey;
    this.cancelPreview("The workspace changed.");
    this.cancelApply("The workspace changed.");
  }

  invalidateSample(sample: Sample): void {
    this.sampleGenerations.set(sample, (this.sampleGenerations.get(sample) ?? 0) + 1);
    if (
      this.preview?.snapshot.sample === sample ||
      this.previewPrimeReservation?.sample === sample
    ) {
      this.cancelPreview("The preview sample was removed or replaced.");
    }
    if (
      this.activeApply !== null ||
      this.applyReservation?.samples.has(sample)
    ) {
      this.cancelApply("An Apply target was removed or replaced.");
    }
  }

  invalidateProfile(profileId: string): void {
    this.profileGenerations.set(profileId, (this.profileGenerations.get(profileId) ?? 0) + 1);
    if (
      this.preview?.profile.profileId === profileId ||
      this.previewPrimeReservation?.profileId === profileId
    ) {
      this.cancelPreview("The compensation profile changed.");
    }
    if (
      this.activeApply?.profileId === profileId ||
      this.applyReservation?.profileId === profileId
    ) {
      this.cancelApply("The compensation profile changed.");
    }
  }

  async primePreview(request: PrimeCompensationPreviewRequest): Promise<PrimedCompensationPreview> {
    this.assertUsable();
    if (this.activeApply !== null || this.applyReservation !== null) {
      throw new CompensationManagerError("apply-job-active", "A preview cannot start while Apply is running.");
    }
    if (!(request.fixedEventIndices instanceof Uint32Array)) {
      throw new CompensationManagerError("invalid-preview-events", "Preview event indices must be a Uint32Array.");
    }
    const sample = request.sample;
    const fixed = request.fixedEventIndices.slice();
    const fixedEventCount = fixed.length;
    if (fixedEventCount > this.maxPreviewEvents) {
      throw new CompensationManagerError(
        "preview-event-limit",
        `Compensation preview is limited to ${this.maxPreviewEvents} fixed events; deterministically downsample before priming.`,
      );
    }
    for (const eventIndex of fixed) {
      if (eventIndex >= sample.fcs.nEvents) {
        throw new CompensationManagerError("invalid-preview-events", `Preview event ${eventIndex} is outside the sample.`);
      }
    }
    this.cancelPreview("A newer preview session was primed.");
    const reservation: PreviewPrimeReservation = {
      workspaceEpoch: this.workspaceEpoch,
      workspaceKey: this.workspaceKey,
      profileId: request.profile.profileId,
      profileGeneration: this.profileGenerations.get(request.profile.profileId) ?? 0,
      sample,
      sampleGeneration: this.sampleGenerations.get(sample) ?? 0,
      cancelled: false,
    };
    this.previewPrimeReservation = reservation;
    let state: PreviewSessionState | null = null;
    try {
      const profile = await this.validateFlowProfile(request.profile);
      this.assertPreviewPrimeCurrent(reservation);
      const estimatedPreviewBytes = fixed.byteLength +
        fixed.length * profile.scientific.matrix.sourceChannels.length *
          ESTIMATED_PREVIEW_BYTES_PER_CHANNEL_EVENT;
      if (!Number.isSafeInteger(estimatedPreviewBytes) || estimatedPreviewBytes > this.previewByteBudget) {
        throw new CompensationManagerError(
          "preview-memory-budget",
          `Compensation preview needs approximately ${estimatedPreviewBytes} bytes, above the ${this.previewByteBudget}-byte budget.`,
        );
      }
      const snapshot = this.captureSampleSnapshot(sample, profile);
      const previewBindings = workerBindingsForSnapshot(snapshot);
      const identity = this.nextIdentity("preview");
      const bindingKey = this.contextKey(profile, snapshot);
      const measuredColumns = await this.copyPreviewColumns(snapshot, fixed, reservation);
      this.assertPreviewPrimeCurrent(reservation);
      this.assertSnapshotCurrent(snapshot, profile);
      state = {
        sessionId: identity.id,
        token: identity.token,
        workspaceEpoch: reservation.workspaceEpoch,
        workspaceKey: reservation.workspaceKey,
        profile,
        profileGeneration: reservation.profileGeneration,
        snapshot,
        bindingKey,
        eventCount: fixedEventCount,
        requestSequence: 0,
        pendingRequestTag: null,
      };
      this.preview = state;
      this.previewPrimeReservation = null;
      const responsePromise = this.waitFor(
        (response): response is Extract<CompensationWorkerResponse, { type: "preview-primed" }> =>
          response.type === "preview-primed" &&
          response.sessionId === state!.sessionId &&
          response.sessionToken === state!.token &&
          response.profileHash === profile.profileHash &&
          response.bindingKey === bindingKey,
        (response) => response.scope === "preview" && response.id === state!.sessionId && response.token === state!.token,
        `preview-prime:${state.sessionId}`,
      );
      try {
        this.post({
          protocol: COMPENSATION_WORKER_PROTOCOL,
          type: "prime-preview",
          method: "matrix-inverse",
          sessionId: state.sessionId,
          sessionToken: state.token,
          profileHash: profile.profileHash,
          bindingKey,
          sourceChannels: profile.scientific.matrix.sourceChannels,
          receiverChannels: profile.scientific.matrix.receiverChannels,
          channelBindings: previewBindings.receiver,
          fixedEventIndices: fixed,
          measuredColumns,
        });
      } catch (error) {
        void responsePromise.catch(() => undefined);
        this.rejectWaitersByTag(`preview-prime:${state.sessionId}`, error);
        throw error;
      }
      const response = await responsePromise;
      this.assertPreviewCurrent(state);
      if (
        response.eventCount !== fixedEventCount ||
        response.channelCount !== previewBindings.source.length ||
        !sameWorkerBindings(response.receiverBindings, previewBindings.receiver) ||
        !sameWorkerBindings(response.sourceBindings, previewBindings.source)
      ) {
        throw new CompensationManagerError(
          "invalid-worker-binding",
          "The worker primed preview data with channel bindings that do not match the exact FCS/matrix mapping.",
        );
      }
      return Object.freeze({
        sessionId: state.sessionId,
        eventCount: response.eventCount,
        profileHash: profile.profileHash,
        bindingKey,
      });
    } catch (error) {
      if (this.previewPrimeReservation === reservation) {
        this.previewPrimeReservation = null;
      }
      if (state !== null && this.preview === state) {
        this.cancelPreview("The preview could not be primed.");
      }
      throw error;
    }
  }

  async solvePreview(
    sessionId: string,
    candidateMatrix: readonly (readonly number[])[],
  ): Promise<PreviewSolvedResponse> {
    this.assertUsable();
    const state = this.preview;
    if (state === null || state.sessionId !== sessionId) {
      throw new CompensationManagerError("stale-preview-session", "The preview session is no longer current.");
    }
    this.assertPreviewCurrent(state);
    if (state.pendingRequestTag !== null) {
      this.rejectWaitersByTag(state.pendingRequestTag, new CompensationCancelledError("A newer preview request superseded this result."));
    }
    if (!Array.isArray(candidateMatrix)) {
      throw new CompensationManagerError(
        "invalid-preview-matrix",
        "A candidate compensation matrix array is required.",
      );
    }
    const candidateSnapshot: readonly (readonly number[])[] = Object.freeze(
      candidateMatrix.map((row: readonly number[]) => Object.freeze(Array.from(row))),
    );
    const requestId = `${state.sessionId}:request:${++state.requestSequence}`;
    const tag = `preview-solve:${requestId}`;
    state.pendingRequestTag = tag;
    const responsePromise = this.waitFor(
      (response): response is PreviewSolvedResponse =>
        response.type === "preview-solved" &&
        response.sessionId === state.sessionId &&
        response.sessionToken === state.token &&
        response.requestId === requestId &&
        response.profileHash === state.profile.profileHash &&
        response.bindingKey === state.bindingKey,
      (response) => response.scope === "preview" && response.id === state.sessionId &&
        response.token === state.token && (response.requestId === undefined || response.requestId === requestId),
      tag,
    );
    try {
      try {
        this.post({
          protocol: COMPENSATION_WORKER_PROTOCOL,
          type: "solve-preview",
          method: "matrix-inverse",
          sessionId: state.sessionId,
          sessionToken: state.token,
          profileHash: state.profile.profileHash,
          bindingKey: state.bindingKey,
          requestId,
          currentMatrix: state.profile.scientific.matrix.matrix,
          candidateMatrix: candidateSnapshot,
          flowSettings: profileFlowSettings(state.profile),
        });
      } catch (error) {
        void responsePromise.catch(() => undefined);
        this.rejectWaitersByTag(tag, error);
        throw error;
      }
      const response = await responsePromise;
      this.assertPreviewCurrent(state);
      if (state.requestSequence.toString() !== requestId.split(":").at(-1)) {
        throw new CompensationCancelledError("A newer preview request superseded this result.");
      }
      this.validatePreviewSolvedResponse(state, response);
      return response;
    } finally {
      if (state.pendingRequestTag === tag) state.pendingRequestTag = null;
    }
  }

  cancelPreview(reason = "The compensation preview was cancelled."): void {
    const reservation = this.previewPrimeReservation;
    if (reservation !== null) {
      reservation.cancelled = true;
      this.previewPrimeReservation = null;
    }
    const state = this.preview;
    if (state === null) return;
    this.preview = null;
    if (state.pendingRequestTag !== null) {
      this.rejectWaitersByTag(state.pendingRequestTag, new CompensationCancelledError(reason));
    }
    this.rejectWaitersByTag(`preview-prime:${state.sessionId}`, new CompensationCancelledError(reason));
    this.postIfAvailable({
      protocol: COMPENSATION_WORKER_PROTOCOL,
      type: "cancel",
      target: "preview",
      id: state.sessionId,
      token: state.token,
    });
  }

  async apply(request: CompensationApplyRequest): Promise<CompensationApplyResult> {
    this.assertUsable();
    if (this.activeApply !== null || this.applyReservation !== null) {
      throw new CompensationManagerError("apply-job-active", "Only one aggregate compensation Apply may run at a time.");
    }
    if (!Array.isArray(request.targets) || request.targets.length === 0) {
      throw new CompensationManagerError("empty-apply-targets", "Apply requires at least one Sample target.");
    }
    const targets = Object.freeze(request.targets.map((target, index) => {
      if (!Object.prototype.hasOwnProperty.call(request.targets, index) || !target) {
        throw new CompensationManagerError(
          "invalid-apply-target",
          "Apply targets must be complete, non-sparse records.",
        );
      }
      if (target.activeLayer !== undefined && target.activeLayer !== "original" && target.activeLayer !== "compensated") {
        throw new CompensationManagerError(
          "invalid-apply-target",
          `Invalid active assay layer '${String(target.activeLayer)}'.`,
        );
      }
      return Object.freeze({
        sample: target.sample,
        ...(target.activeLayer === undefined ? {} : { activeLayer: target.activeLayer }),
      });
    }));
    const stableRequest: CompensationApplyRequest = Object.freeze({
      profile: request.profile,
      targets,
      ...(request.byteBudget === undefined ? {} : { byteBudget: request.byteBudget }),
      ...(request.fixedWorkspaceBytes === undefined
        ? {}
        : { fixedWorkspaceBytes: request.fixedWorkspaceBytes }),
      ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
    });
    const uniqueSamples = new Set(targets.map(({ sample }) => sample));
    if (uniqueSamples.size !== targets.length) {
      throw new CompensationManagerError("duplicate-apply-target", "Each Sample may appear only once in an Apply transaction.");
    }
    const reservation: ApplyReservation = {
      workspaceEpoch: this.workspaceEpoch,
      workspaceKey: this.workspaceKey,
      profileId: stableRequest.profile.profileId,
      samples: uniqueSamples,
      cancelled: false,
    };
    this.applyReservation = reservation;
    let profile: CompensationProfileRecord;
    let snapshots: SampleSnapshot[];
    try {
      profile = await this.validateProfile(stableRequest.profile);
      this.assertUsable();
      if (
        this.applyReservation !== reservation ||
        reservation.cancelled ||
        reservation.workspaceEpoch !== this.workspaceEpoch ||
        reservation.workspaceKey !== this.workspaceKey
      ) {
        throw new CompensationCancelledError(
          "The Apply request became stale or was cancelled during profile validation.",
        );
      }
      snapshots = targets.map(({ sample }) => this.captureSampleSnapshot(sample, profile));
    } catch (error) {
      if (this.applyReservation === reservation) this.applyReservation = null;
      throw error;
    }
    const identity = this.nextIdentity("apply");
    const active: ActiveApply = {
      aggregateId: identity.id,
      token: identity.token,
      workspaceEpoch: this.workspaceEpoch,
      workspaceKey: this.workspaceKey,
      profileId: profile.profileId,
      profileGeneration: this.profileGenerations.get(profile.profileId) ?? 0,
      cancelled: false,
      currentWorkerJob: null,
    };
    this.activeApply = active;
    this.applyReservation = null;
    this.cancelPreview("Apply has priority over preview work.");
    const totalEvents = snapshots.reduce((sum, snapshot) => sum + snapshot.sample.fcs.nEvents, 0);
    let acceptedEvents = 0;
    const targetResults: CompensationApplyTargetResult[] = [];
    const prepared: PreparedCompensatedLayer[] = [];

    try {
      for (let sampleIndex = 0; sampleIndex < snapshots.length; sampleIndex++) {
        const snapshot = snapshots[sampleIndex];
        this.assertApplyCurrent(active, profile);
        this.assertSnapshotCurrent(snapshot, profile);
        const solved = await this.solveApplyTarget(
          active,
          profile,
          snapshot,
          sampleIndex,
          snapshots.length,
          acceptedEvents,
          totalEvents,
          stableRequest,
        );
        acceptedEvents += snapshot.sample.fcs.nEvents;
        targetResults.push(solved.result);
        prepared.push(solved.prepared);
      }

      for (const snapshot of snapshots) {
        this.assertApplyCurrent(active, profile);
        this.assertSnapshotCurrent(snapshot, profile);
      }
      this.assertApplyCurrent(active, profile);
      Sample.commitPreparedCompensatedLayers(prepared);
      return Object.freeze({
        jobId: active.aggregateId,
        profile,
        targets: Object.freeze(targetResults),
      });
    } catch (error) {
      if (active.currentWorkerJob !== null) {
        this.postIfAvailable({
          protocol: COMPENSATION_WORKER_PROTOCOL,
          type: "cancel",
          target: "apply",
          id: active.currentWorkerJob.id,
          token: active.currentWorkerJob.token,
        });
      }
      throw error;
    } finally {
      this.rejectWaitersByPrefix(`apply:${active.aggregateId}:`, new CompensationCancelledError());
      if (this.activeApply === active) this.activeApply = null;
    }
  }

  cancelApply(reason = "The compensation Apply was cancelled."): void {
    const reservation = this.applyReservation;
    if (reservation !== null) {
      reservation.cancelled = true;
      this.applyReservation = null;
    }
    const active = this.activeApply;
    if (active === null) return;
    active.cancelled = true;
    if (active.currentWorkerJob !== null) {
      this.postIfAvailable({
        protocol: COMPENSATION_WORKER_PROTOCOL,
        type: "cancel",
        target: "apply",
        id: active.currentWorkerJob.id,
        token: active.currentWorkerJob.token,
      });
    }
    this.rejectWaitersByPrefix(
      `apply:${active.aggregateId}:`,
      new CompensationCancelledError(reason),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelPreview("The compensation manager was disposed.");
    this.cancelApply("The compensation manager was disposed.");
    this.disposed = true;
    this.rejectAllWaiters(new CompensationCancelledError("The compensation manager was disposed."));
    this.worker?.terminate();
    this.worker = null;
  }

  private async solveApplyTarget(
    active: ActiveApply,
    profile: CompensationProfileRecord,
    snapshot: SampleSnapshot,
    sampleIndex: number,
    sampleCount: number,
    acceptedBefore: number,
    aggregateTotal: number,
    request: CompensationApplyRequest,
  ): Promise<SolvedApplyTarget> {
    const sample = snapshot.sample;
    const channelCount = snapshot.solveChannels.length;
    const plan = planCompensationChunks({
      totalEvents: sample.fcs.nEvents,
      channelCount,
      byteBudget: request.byteBudget ?? this.defaultByteBudget,
      fixedWorkspaceBytes: request.fixedWorkspaceBytes ?? this.defaultFixedWorkspaceBytes,
    });
    const workerIdentity = {
      id: `${active.aggregateId}:sample:${sampleIndex}`,
      token: `${active.token}:sample:${sampleIndex}`,
    };
    active.currentWorkerJob = workerIdentity;
    const bindingKey = this.contextKey(profile, snapshot);
    const stagingIdentity: CompensatedLayerStagingIdentity = Object.freeze({
      jobId: workerIdentity.id,
      jobToken: workerIdentity.token,
      bindingKey,
    });
    const workerBindings = workerBindingsForSnapshot(snapshot);
    const receiverBindings = workerBindings.receiver;
    const sourceBindings = workerBindings.source;
    const outputBindings: readonly CompensatedLayerOutputBinding[] = Object.freeze(
      sourceBindings.map((binding) => Object.freeze({
        pnn: binding.pnn,
        fcsColumnIndex: binding.fcsColumnIndex,
        matrixSourceIndex: binding.matrixSourceIndex,
      })),
    );
    const staging = sample.beginCompensatedLayerStaging(
      snapshot.binding,
      outputBindings,
      stagingIdentity,
      { activeLayer: request.targets[sampleIndex].activeLayer ?? "compensated" },
    );
    const prefix = `apply:${active.aggregateId}:sample:${sampleIndex}:`;
    try {
      const startedPromise = this.waitFor(
        (response): response is Extract<CompensationWorkerResponse, { type: "apply-started" }> =>
          response.type === "apply-started" && response.jobId === workerIdentity.id &&
          response.jobToken === workerIdentity.token && response.profileHash === profile.profileHash &&
          response.bindingKey === bindingKey,
        (response) => response.scope === "apply" && response.id === workerIdentity.id && response.token === workerIdentity.token,
        `${prefix}start`,
      );
      const completeWait = () => this.waitFor(
        (response): response is Extract<CompensationWorkerResponse, { type: "apply-complete" }> =>
          response.type === "apply-complete" && response.jobId === workerIdentity.id &&
          response.jobToken === workerIdentity.token && response.profileHash === profile.profileHash &&
          response.bindingKey === bindingKey,
        (response) => response.scope === "apply" && response.id === workerIdentity.id && response.token === workerIdentity.token,
        `${prefix}complete`,
      );
      let completeResponse: Extract<CompensationWorkerResponse, { type: "apply-complete" }> | null = null;
      const zeroEventComplete = sample.fcs.nEvents === 0 ? completeWait() : null;
      this.post({
        protocol: COMPENSATION_WORKER_PROTOCOL,
        type: "start-apply",
        method: profile.scientific.method,
        jobId: workerIdentity.id,
        jobToken: workerIdentity.token,
        profileHash: profile.profileHash,
        bindingKey,
        sourceChannels: snapshot.solveChannels,
        receiverChannels: snapshot.solveChannels,
        channelBindings: receiverBindings,
        matrix: snapshot.solveMatrix,
        ...(profile.scientific.kind === "flow-spillover"
          ? { flowSettings: profileFlowSettings(profile) }
          : { nnlsSettings: profileNnlsSettings(profile) }),
        totalEvents: sample.fcs.nEvents,
        channelCount,
        byteBudget: plan.transientByteBudget,
      });
      const started = await startedPromise;
      if (
        !sameWorkerBindings(started.receiverBindings, receiverBindings) ||
        !sameWorkerBindings(started.sourceBindings, sourceBindings)
      ) {
        throw new CompensationManagerError(
          "invalid-worker-binding",
          "The worker started with channel bindings that do not match the exact FCS/matrix mapping.",
        );
      }
      request.onProgress?.(Object.freeze({
        jobId: active.aggregateId,
        sampleIndex,
        sampleCount,
        sampleProcessedEvents: 0,
        sampleTotalEvents: sample.fcs.nEvents,
        processedEvents: acceptedBefore,
        totalEvents: aggregateTotal,
        fraction: aggregateTotal === 0 ? 1 : acceptedBefore / aggregateTotal,
      }));
      if (zeroEventComplete !== null) completeResponse = await zeroEventComplete;

      for (let chunkIndex = 0, start = 0; start < sample.fcs.nEvents; chunkIndex++) {
        this.assertApplyCurrent(active, profile);
        this.assertSnapshotCurrent(snapshot, profile);
        const end = Math.min(sample.fcs.nEvents, start + plan.eventsPerChunk);
        const measuredColumns = await this.copyReceiverChunk(snapshot, start, end, active, profile);
        this.assertSnapshotCurrent(snapshot, profile);
        const chunkPromise = this.waitFor(
          (response): response is ApplyChunkCompleteResponse =>
            response.type === "apply-chunk-complete" &&
            response.jobId === workerIdentity.id && response.jobToken === workerIdentity.token &&
            response.profileHash === profile.profileHash && response.bindingKey === bindingKey &&
            response.chunkIndex === chunkIndex && response.startEvent === start,
          (response) => response.scope === "apply" && response.id === workerIdentity.id && response.token === workerIdentity.token,
          `${prefix}chunk:${chunkIndex}`,
        );
        const isFinalChunk = end === sample.fcs.nEvents;
        const finalComplete = isFinalChunk ? completeWait() : null;
        this.post({
          protocol: COMPENSATION_WORKER_PROTOCOL,
          type: "apply-chunk",
          jobId: workerIdentity.id,
          jobToken: workerIdentity.token,
          profileHash: profile.profileHash,
          bindingKey,
          chunkIndex,
          startEvent: start,
          measuredColumns,
        });
        const [chunk, complete] = await Promise.all([
          chunkPromise,
          finalComplete ?? Promise.resolve(null),
        ]);
        if (complete !== null) completeResponse = complete;
        this.assertApplyCurrent(active, profile);
        this.assertSnapshotCurrent(snapshot, profile);
        await this.verifyAndStageChunk(
          chunk,
          staging,
          stagingIdentity,
          sourceBindings,
          outputBindings,
          end - start,
          active,
          profile,
          snapshot,
        );
        start = end;
        const accepted = acceptedBefore + start;
        request.onProgress?.(Object.freeze({
          jobId: active.aggregateId,
          sampleIndex,
          sampleCount,
          sampleProcessedEvents: start,
          sampleTotalEvents: sample.fcs.nEvents,
          processedEvents: accepted,
          totalEvents: aggregateTotal,
          fraction: aggregateTotal === 0 ? 1 : accepted / aggregateTotal,
        }));
      }
      const complete = completeResponse;
      if (complete === null) {
        throw new CompensationManagerError("invalid-worker-result", "The worker did not publish a completion receipt.");
      }
      if (
        complete.processedEvents !== sample.fcs.nEvents ||
        complete.totalEvents !== sample.fcs.nEvents ||
        (complete as { readonly allFinite?: unknown }).allFinite !== true ||
        !sameWorkerBindings(complete.outputBindings, sourceBindings)
      ) {
        throw new CompensationManagerError(
          "invalid-worker-result",
          "The worker completion receipt does not cover the complete sample and exact source bindings.",
        );
      }
      this.assertSnapshotCurrent(snapshot, profile);
      const prepared = sample.finishCompensatedLayerStaging(staging, stagingIdentity);
      active.currentWorkerJob = null;
      return Object.freeze({
        result: Object.freeze({ sample, binding: snapshot.binding }),
        prepared,
      });
    } catch (error) {
      sample.abortCompensatedLayerStaging(staging);
      throw error;
    }
  }

  private async copyReceiverChunk(
    snapshot: SampleSnapshot,
    start: number,
    end: number,
    active: ActiveApply,
    profile: CompensationProfileRecord,
  ): Promise<readonly Float64Array[]> {
    const columns = snapshot.receiverResolvedIndices.map(() => new Float64Array(end - start));
    for (let offset = 0; offset < end - start; offset += this.copySliceEvents) {
      this.assertApplyCurrent(active, profile);
      this.assertSnapshotCurrent(snapshot, profile);
      const sliceEnd = Math.min(end - start, offset + this.copySliceEvents);
      for (let receiver = 0; receiver < snapshot.receiverResolvedIndices.length; receiver++) {
        const source = snapshot.sample.originalColumnData(snapshot.receiverResolvedIndices[receiver]);
        const target = columns[receiver];
        for (let event = offset; event < sliceEnd; event++) {
          const value = source[start + event];
          if (!Number.isFinite(value)) {
            throw new CompensationManagerError(
              "non-finite-input",
              `Original event ${start + event} contains a non-finite compensation value.`,
            );
          }
          target[event] = value;
        }
      }
      await this.yieldToEventLoop();
    }
    return Object.freeze(columns);
  }

  private async copyPreviewColumns(
    snapshot: SampleSnapshot,
    fixed: Uint32Array,
    reservation: PreviewPrimeReservation,
  ): Promise<readonly Float64Array[]> {
    const columns = snapshot.receiverResolvedIndices.map(() => new Float64Array(fixed.length));
    for (let start = 0; start < fixed.length; start += this.copySliceEvents) {
      const end = Math.min(fixed.length, start + this.copySliceEvents);
      this.assertPreviewPrimeCurrent(reservation);
      this.assertSnapshotCurrent(snapshot, null);
      for (let receiver = 0; receiver < snapshot.receiverResolvedIndices.length; receiver++) {
        const source = snapshot.sample.originalColumnData(snapshot.receiverResolvedIndices[receiver]);
        for (let event = start; event < end; event++) {
          const value = source[fixed[event]];
          if (!Number.isFinite(value)) {
            throw new CompensationManagerError("non-finite-input", `Original preview event ${fixed[event]} is non-finite.`);
          }
          columns[receiver][event] = value;
        }
      }
      await this.yieldToEventLoop();
    }
    return Object.freeze(columns);
  }

  private async verifyAndStageChunk(
    chunk: ApplyChunkCompleteResponse,
    staging: CompensatedLayerStaging,
    identity: CompensatedLayerStagingIdentity,
    expectedWorkerBindings: readonly CompensationWorkerChannelBinding[],
    outputBindings: readonly CompensatedLayerOutputBinding[],
    expectedEventCount: number,
    active: ActiveApply,
    profile: CompensationProfileRecord,
    snapshot: SampleSnapshot,
  ): Promise<void> {
    if (
      chunk.eventCount !== expectedEventCount ||
      !sameWorkerBindings(chunk.outputBindings, expectedWorkerBindings) ||
      chunk.columns.length !== outputBindings.length ||
      chunk.columns.some((column) => !(column instanceof Float32Array) || column.length !== expectedEventCount)
    ) {
      throw new CompensationManagerError(
        "invalid-worker-result",
        "The worker returned malformed or incorrectly labelled compensation output columns.",
      );
    }
    for (let start = 0; start < expectedEventCount; start += this.copySliceEvents) {
      this.assertApplyCurrent(active, profile);
      this.assertSnapshotCurrent(snapshot, profile);
      const end = Math.min(expectedEventCount, start + this.copySliceEvents);
      snapshot.sample.appendCompensatedLayerStagingChunk(staging, {
        ...identity,
        startEvent: chunk.startEvent + start,
        outputBindings,
        columns: chunk.columns.map((column) => column.subarray(start, end)),
      });
      await this.yieldToEventLoop();
    }
  }

  private async validateFlowProfile(input: CompensationProfileRecord): Promise<CompensationProfileRecord> {
    const profile = await this.validateProfile(input);
    if (profile.scientific.kind !== "flow-spillover" || profile.scientific.method !== "matrix-inverse") {
      throw new CompensationManagerError(
        "unsupported-compensation-method",
        "Compensation preview currently supports conventional-flow matrix-inverse profiles only.",
      );
    }
    return profile;
  }

  private async validateProfile(input: CompensationProfileRecord): Promise<CompensationProfileRecord> {
    const profile = await validateCompensationProfileRecord(input);
    if (profile.scientific.kind === "flow-spillover") {
      if (profile.scientific.method !== "matrix-inverse") {
        throw new CompensationManagerError(
          "unsupported-compensation-method",
          "Conventional-flow profiles require exact matrix inversion.",
        );
      }
      if (profile.scientific.solverVersion !== FLOW_SOLVER_VERSION) {
        throw new CompensationManagerError(
          "unsupported-solver-version",
          `Profile solver ${profile.scientific.solverVersion} cannot be labelled as ${FLOW_SOLVER_VERSION}.`,
        );
      }
      profileFlowSettings(profile);
      return profile;
    }
    if (profile.scientific.method !== "nnls") {
      throw new CompensationManagerError(
        "unsupported-compensation-method",
        "CyTOF profiles require non-negative least squares.",
      );
    }
    if (profile.scientific.solverVersion !== CYTOF_NNLS_SOLVER_VERSION) {
      throw new CompensationManagerError(
        "unsupported-solver-version",
        `Profile solver ${profile.scientific.solverVersion} cannot be labelled as ${CYTOF_NNLS_SOLVER_VERSION}.`,
      );
    }
    profileNnlsSettings(profile);
    return profile;
  }

  private captureSampleSnapshot(
    sample: Sample,
    profile: CompensationProfileRecord,
  ): SampleSnapshot {
    const profileKind = profile.scientific.kind;
    const expectedInstrument = profileKind === "flow-spillover" ? "flow" : "cytof";
    if (sample.instrument !== expectedInstrument) {
      throw new CompensationManagerError(
        "sample-kind-mismatch",
        `A ${expectedInstrument} compensation profile requires a ${expectedInstrument} Sample.`,
      );
    }
    const report = reportMatrixCompatibility(
      profileKind === "flow-spillover"
        ? {
            kind: "flow-spillover",
            matrix: profile.scientific.matrix,
            sampleChannels: sample.channels,
          }
        : {
            kind: "cytof-spillover",
            matrix: profile.scientific.matrix,
            sampleChannels: sample.channels,
            includedChannels: profile.scientific.includedChannels,
          },
    );
    if (!report.canApply) {
      throw new CompensationManagerError(
        "incompatible-sample",
        report.blockers.map(({ message }) => message).join(" "),
      );
    }
    const orderedBindings = Array.from(report.bindings).sort(
      (left, right) => left.matrixReceiverIndex - right.matrixReceiverIndex,
    );
    const solveBindings = orderedBindings.filter(({ included }) => included);
    const receiverResolvedIndices = solveBindings.map((binding) => {
      const resolved = sample.channels.findIndex(
        ({ pnn, columnIndex }) => pnn === binding.pnn && columnIndex === binding.fcsColumnIndex,
      );
      if (resolved < 0) {
        throw new CompensationManagerError("stale-channel-binding", `Sample channel '${binding.pnn}' is no longer exact.`);
      }
      return resolved;
    });
    const solveChannels = profileKind === "flow-spillover"
      ? profile.scientific.matrix.receiverChannels
      : profile.scientific.includedChannels;
    if (
      solveBindings.length !== solveChannels.length ||
      solveBindings.some((binding, index) => binding.pnn !== solveChannels[index])
    ) {
      throw new CompensationManagerError(
        "invalid-channel-binding",
        "The included profile channels do not match the exact FCS receiver binding order.",
      );
    }
    const workerBindings = Object.freeze(solveBindings.map((binding, solveIndex) =>
      Object.freeze({
        pnn: binding.pnn,
        fcsColumnIndex: binding.fcsColumnIndex,
        matrixSourceIndex: profileKind === "flow-spillover"
          ? binding.matrixSourceIndex!
          : solveIndex,
        matrixReceiverIndex: profileKind === "flow-spillover"
          ? binding.matrixReceiverIndex
          : solveIndex,
      }),
    ));
    const solveMatrix = profileKind === "flow-spillover"
      ? profile.scientific.matrix.matrix
      : adaptCytofSpilloverMatrix(
          profile.scientific.matrix,
          profile.scientific.includedChannels,
        );
    const binding: PersistedCompensatedLayerBinding = Object.freeze({
      profileId: profile.profileId,
      profileHash: profile.profileHash,
      matrixHash: profile.matrixHash,
      kind: profileKind,
      method: profile.scientific.method,
      includedPnns: Object.freeze(Array.from(solveChannels)),
      channelBindings: Object.freeze(orderedBindings),
      transformBinding: profileKind === "flow-spillover"
        ? Object.freeze({ kind: "flow-linear" as const })
        : Object.freeze({ kind: "cytof-asinh" as const, cofactor: sample.arcsinhCofactor }),
    });
    return Object.freeze({
      sample,
      dataRevision: sample.dataRevision,
      layerRevision: sample.layerRevision,
      activeLayer: sample.activeLayer,
      displayTransformContextKey: sample.displayTransformContextKey,
      channelSignature: channelSignature(sample),
      invalidationGeneration: this.sampleGenerations.get(sample) ?? 0,
      bindingFingerprint: bindingsFingerprint(orderedBindings),
      binding,
      receiverResolvedIndices: Object.freeze(receiverResolvedIndices),
      solveChannels: Object.freeze(Array.from(solveChannels)),
      solveMatrix,
      workerBindings,
    });
  }

  private assertSnapshotCurrent(
    snapshot: SampleSnapshot,
    profile: CompensationProfileRecord | null,
  ): void {
    const sample = snapshot.sample;
    if (
      snapshot.dataRevision !== sample.dataRevision ||
      snapshot.layerRevision !== sample.layerRevision ||
      snapshot.activeLayer !== sample.activeLayer ||
      snapshot.displayTransformContextKey !== sample.displayTransformContextKey ||
      snapshot.channelSignature !== channelSignature(sample) ||
      snapshot.invalidationGeneration !== (this.sampleGenerations.get(sample) ?? 0)
    ) {
      throw new CompensationManagerError("stale-sample", "The Sample changed while compensation was running.");
    }
    if (profile !== null) {
      const report = reportMatrixCompatibility(
        profile.scientific.kind === "flow-spillover"
          ? {
              kind: "flow-spillover",
              matrix: profile.scientific.matrix,
              sampleChannels: sample.channels,
            }
          : {
              kind: "cytof-spillover",
              matrix: profile.scientific.matrix,
              sampleChannels: sample.channels,
              includedChannels: profile.scientific.includedChannels,
            },
      );
      if (!report.canApply || snapshot.bindingFingerprint !== bindingsFingerprint(report.bindings)) {
        throw new CompensationManagerError("stale-channel-binding", "The exact matrix-to-FCS channel binding changed.");
      }
    }
  }

  private assertApplyCurrent(active: ActiveApply, profile: CompensationProfileRecord): void {
    if (
      this.activeApply !== active || active.cancelled ||
      active.workspaceEpoch !== this.workspaceEpoch || active.workspaceKey !== this.workspaceKey ||
      active.profileGeneration !== (this.profileGenerations.get(profile.profileId) ?? 0)
    ) {
      throw new CompensationCancelledError("The Apply job became stale or was cancelled.");
    }
  }

  private assertPreviewCurrent(state: PreviewSessionState): void {
    if (
      this.preview !== state || state.workspaceEpoch !== this.workspaceEpoch ||
      state.workspaceKey !== this.workspaceKey ||
      state.profileGeneration !== (this.profileGenerations.get(state.profile.profileId) ?? 0)
    ) {
      throw new CompensationCancelledError("The preview session became stale.");
    }
    this.assertSnapshotCurrent(state.snapshot, state.profile);
  }

  private validatePreviewSolvedResponse(
    state: PreviewSessionState,
    response: PreviewSolvedResponse,
  ): void {
    const expected = workerBindingsForSnapshot(state.snapshot);
    if (
      !hasDenseArrayLength(response.sourceChannels, expected.source.length) ||
      response.sourceChannels.some((pnn, index) => pnn !== expected.source[index].pnn) ||
      !sameWorkerBindings(response.receiverBindings, expected.receiver) ||
      !sameWorkerBindings(response.sourceBindings, expected.source)
    ) {
      throw new CompensationManagerError(
        "invalid-worker-binding",
        "The preview result does not match the exact FCS/matrix channel mapping.",
      );
    }
    const columnGroups = [
      response.currentColumns,
      response.candidateColumns,
      response.deltas,
    ];
    if (
      response.eventCount !== state.eventCount ||
      columnGroups.some((columns) =>
        !hasDenseArrayLength(columns, expected.source.length) ||
        columns.some((column) => !isFiniteFloat64Column(column, state.eventCount))
      )
    ) {
      throw new CompensationManagerError(
        "invalid-worker-result",
        "The preview worker returned malformed or non-finite source columns.",
      );
    }
    if (
      !Array.isArray(response.impacts) ||
      response.impacts.length !== expected.source.length ||
      !Array.isArray(response.impactRanking) ||
      response.impactRanking.length !== expected.source.length
    ) {
      throw new CompensationManagerError(
        "invalid-worker-result",
        "The preview worker returned incomplete channel-impact summaries.",
      );
    }
    const finiteMetricKeys = [
      "medianAbsoluteDelta",
      "upperTailAbsoluteDelta",
      "meanAbsoluteDelta",
      "rootMeanSquareDelta",
      "maximumAbsoluteDelta",
      "fractionChanged",
    ] as const;
    const countMetricKeys = [
      "changedCount",
      "negativeToNonNegativeCount",
      "nonNegativeToNegativeCount",
      "signCrossingCount",
    ] as const;
    for (let source = 0; source < expected.source.length; source++) {
      const impact = response.impacts[source];
      if (
        !impact ||
        impact.channelIndex !== source ||
        impact.channel !== expected.source[source].pnn ||
        finiteMetricKeys.some((key) => !Number.isFinite(impact[key])) ||
        countMetricKeys.some((key) =>
          !Number.isSafeInteger(impact[key]) || impact[key] < 0 || impact[key] > state.eventCount
        ) ||
        impact.fractionChanged < 0 ||
        impact.fractionChanged > 1 ||
        impact.signCrossingCount !==
          impact.negativeToNonNegativeCount + impact.nonNegativeToNegativeCount
      ) {
        throw new CompensationManagerError(
          "invalid-worker-result",
          "The preview worker returned a mislabeled or invalid channel-impact summary.",
        );
      }
    }
    const rankedSources = new Set<number>();
    for (const ranked of response.impactRanking) {
      const source = ranked?.channelIndex;
      const canonical = Number.isSafeInteger(source) ? response.impacts[source] : undefined;
      if (
        canonical === undefined ||
        rankedSources.has(source) ||
        ranked.channel !== canonical.channel ||
        finiteMetricKeys.some((key) => ranked[key] !== canonical[key]) ||
        countMetricKeys.some((key) => ranked[key] !== canonical[key])
      ) {
        throw new CompensationManagerError(
          "invalid-worker-result",
          "The preview worker returned an invalid impact ranking.",
        );
      }
      rankedSources.add(source);
    }
  }

  private assertPreviewPrimeCurrent(reservation: PreviewPrimeReservation): void {
    this.assertUsable();
    if (
      this.previewPrimeReservation !== reservation ||
      reservation.cancelled ||
      this.activeApply !== null ||
      this.applyReservation !== null ||
      reservation.workspaceEpoch !== this.workspaceEpoch ||
      reservation.workspaceKey !== this.workspaceKey ||
      reservation.profileGeneration !== (this.profileGenerations.get(reservation.profileId) ?? 0) ||
      reservation.sampleGeneration !== (this.sampleGenerations.get(reservation.sample) ?? 0)
    ) {
      throw new CompensationCancelledError(
        "The preview request became stale or was cancelled while it was being primed.",
      );
    }
  }

  private contextKey(profile: CompensationProfileRecord, snapshot: SampleSnapshot): string {
    return JSON.stringify([
      this.workspaceKey,
      this.workspaceEpoch,
      profile.profileId,
      profile.profileHash,
      profile.matrixHash,
      snapshot.dataRevision,
      snapshot.layerRevision,
      snapshot.displayTransformContextKey,
      snapshot.bindingFingerprint,
    ]);
  }

  private nextIdentity(prefix: string): Readonly<{ id: string; token: string }> {
    const serial = ++this.sequence;
    return Object.freeze({
      id: `${prefix}-${serial}`,
      token: `${prefix}-token-${serial}-${Date.now().toString(36)}`,
    });
  }

  private ensureWorker(): CompensationWorkerLike {
    this.assertUsable();
    if (this.worker !== null && !this.workerBroken) return this.worker;
    this.worker?.terminate();
    const worker = this.workerFactory();
    worker.onmessage = (event) => this.handleWorkerMessage(event.data);
    worker.onerror = (event) => {
      this.workerBroken = true;
      this.rejectAllWaiters(new CompensationManagerError(
        "worker-exception",
        event.message || "The compensation worker failed.",
      ));
      if (this.activeApply !== null) this.activeApply.cancelled = true;
      this.preview = null;
    };
    this.worker = worker;
    this.workerBroken = false;
    return worker;
  }

  private post(request: CompensationWorkerRequest): void {
    this.ensureWorker().postMessage(request, requestTransferables(request));
  }

  private postIfAvailable(request: CompensationWorkerRequest): void {
    if (this.disposed || this.worker === null || this.workerBroken) return;
    this.worker.postMessage(request, requestTransferables(request));
  }

  private handleWorkerMessage(response: CompensationWorkerResponse): void {
    if (!response || response.protocol !== COMPENSATION_WORKER_PROTOCOL) {
      this.rejectAllWaiters(new CompensationManagerError("unsupported-protocol", "The compensation worker returned an unsupported protocol."));
      return;
    }
    if (response.type === "apply-progress" || response.type === "cancelled") return;
    if (response.type === "worker-error") {
      let handled = false;
      for (const waiter of Array.from(this.waiters)) {
        if (!waiter.errorMatches(response)) continue;
        handled = true;
        this.waiters.delete(waiter);
        waiter.reject(workerError(response));
      }
      if (handled) return;
    }
    for (const waiter of this.waiters) {
      if (waiter.predicate(response)) {
        this.waiters.delete(waiter);
        waiter.resolve(response);
        return;
      }
    }
  }

  private waitFor<T extends CompensationWorkerResponse>(
    predicate: (response: CompensationWorkerResponse) => response is T,
    errorMatches: Waiter["errorMatches"],
    tag: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiters.add({
        predicate,
        errorMatches,
        resolve: (response) => resolve(response as T),
        reject,
        tag,
      });
    });
  }

  private rejectWaitersByTag(tag: string, error: unknown): void {
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.tag !== tag) continue;
      this.waiters.delete(waiter);
      waiter.reject(error);
    }
  }

  private rejectWaitersByPrefix(prefix: string, error: unknown): void {
    for (const waiter of Array.from(this.waiters)) {
      if (!waiter.tag.startsWith(prefix)) continue;
      this.waiters.delete(waiter);
      waiter.reject(error);
    }
  }

  private rejectAllWaiters(error: unknown): void {
    for (const waiter of Array.from(this.waiters)) {
      this.waiters.delete(waiter);
      waiter.reject(error);
    }
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new CompensationManagerError("manager-disposed", "The compensation manager has been disposed.");
    }
  }
}
