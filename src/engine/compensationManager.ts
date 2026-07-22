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
const DEFAULT_MAX_APPLY_WORKERS = 4;
const MAX_CONFIGURABLE_APPLY_WORKERS = 8;
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

export interface CompensationWorkerPoolPlan {
  readonly workerCount: number;
  readonly totalByteBudget: number;
  readonly perWorkerByteBudget: number;
  readonly chunk: CompensationChunkPlan;
}

export interface CompensationManagerOptions {
  readonly workspaceKey?: string;
  readonly workerFactory?: CompensationWorkerFactory;
  readonly byteBudget?: number;
  readonly fixedWorkspaceBytes?: number;
  readonly copySliceEvents?: number;
  readonly maxPreviewEvents?: number;
  readonly previewByteBudget?: number;
  /** Maximum event-parallel workers. Custom test workers default to one unless explicit. */
  readonly workerPoolSize?: number;
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
  readonly channelIdentities: readonly Readonly<{
    readonly pnn: string;
    readonly columnIndex: number;
  }>[];
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
  currentWorkerJobs: Array<Readonly<{
    id: string;
    token: string;
    worker: CompensationWorkerLike;
  }>>;
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

/** Logical workers available for event-parallel Apply while leaving one thread for the UI. */
export function availableCompensationWorkerCount(): number {
  const hardware = typeof navigator === "undefined" || !Number.isFinite(navigator.hardwareConcurrency)
    ? 2
    : Math.max(1, Math.floor(navigator.hardwareConcurrency));
  return Math.max(1, Math.min(MAX_CONFIGURABLE_APPLY_WORKERS, hardware - 1));
}

function defaultWorkerPoolSize(): number {
  return Math.min(DEFAULT_MAX_APPLY_WORKERS, availableCompensationWorkerCount());
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CompensationManagerError("invalid-memory-budget", `${label} must be a positive safe integer.`);
  }
  return value;
}

function validApplyWorkerCount(value: number): number {
  const count = positiveSafeInteger(value, "Compensation worker pool size");
  if (count > MAX_CONFIGURABLE_APPLY_WORKERS) {
    throw new CompensationManagerError(
      "invalid-worker-count",
      "Compensation supports at most " + MAX_CONFIGURABLE_APPLY_WORKERS + " event-parallel workers.",
    );
  }
  return count;
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

/** Divide one aggregate transient-memory budget across a bounded worker pool. */
export function planCompensationWorkerPool(input: Readonly<{
  totalEvents: number;
  channelCount: number;
  maxWorkers: number;
  byteBudget?: number;
  fixedWorkspaceBytes?: number;
  maxEventsPerChunk?: number;
}>): CompensationWorkerPoolPlan {
  if (!Number.isSafeInteger(input.totalEvents) || input.totalEvents < 0) {
    throw new CompensationManagerError("invalid-event-count", "Compensation totalEvents must be a non-negative safe integer.");
  }
  const maxWorkers = positiveSafeInteger(input.maxWorkers, "Compensation worker count");
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
  let workerCount = input.totalEvents === 0 ? 1 : Math.min(maxWorkers, input.totalEvents);
  let lastError: unknown = null;
  while (workerCount >= 1) {
    const perWorkerByteBudget = Math.floor(totalByteBudget / workerCount);
    try {
      const chunk = planCompensationChunks({
        totalEvents: input.totalEvents,
        channelCount: input.channelCount,
        byteBudget: perWorkerByteBudget,
        fixedWorkspaceBytes,
        maxEventsPerChunk: input.maxEventsPerChunk,
      });
      const usefulWorkers = chunk.chunkCount === 0 ? 1 : Math.min(workerCount, chunk.chunkCount);
      if (usefulWorkers < workerCount) {
        workerCount = usefulWorkers;
        continue;
      }
      return Object.freeze({
        workerCount,
        totalByteBudget,
        perWorkerByteBudget,
        chunk,
      });
    } catch (error) {
      lastError = error;
      workerCount--;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new CompensationManagerError(
    "invalid-memory-budget",
    "No compensation worker can run within the aggregate memory budget.",
  );
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

function sameSampleChannelIdentities(snapshot: SampleSnapshot, sample: Sample): boolean {
  if (snapshot.channelIdentities.length !== sample.channels.length) return false;
  for (let index = 0; index < snapshot.channelIdentities.length; index++) {
    const expected = snapshot.channelIdentities[index];
    const current = sample.channels[index];
    if (!current || current.pnn !== expected.pnn || current.columnIndex !== expected.columnIndex) {
      return false;
    }
  }
  return true;
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

/** Owns one preview worker plus a bounded deterministic event-parallel Apply pool. */
export class CompensationManager {
  private readonly workerFactory: CompensationWorkerFactory;
  private readonly defaultByteBudget: number;
  private readonly defaultFixedWorkspaceBytes: number;
  private readonly copySliceEvents: number;
  private readonly maxPreviewEvents: number;
  private readonly previewByteBudget: number;
  private maxApplyWorkers: number;
  private readonly yieldToEventLoop: () => Promise<void>;
  private readonly workers: CompensationWorkerLike[] = [];
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
    this.maxApplyWorkers = validApplyWorkerCount(
      options.workerPoolSize ?? (options.workerFactory ? 1 : defaultWorkerPoolSize()),
    );
    this.yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;
  }

  /** Synchronous UI guard covering both validation/reservation and active worker phases. */
  get applyInProgress(): boolean {
    return this.applyReservation !== null || this.activeApply !== null;
  }

  get applyWorkerPoolSize(): number {
    return this.maxApplyWorkers;
  }

  /**
   * Change the maximum number of event-parallel Apply workers. The aggregate transient-memory
   * budget remains fixed and is divided across the selected pool; this does not multiply it.
   */
  setApplyWorkerPoolSize(count: number): void {
    this.assertUsable();
    const next = validApplyWorkerCount(count);
    if (this.applyInProgress) {
      throw new CompensationManagerError(
        "apply-in-progress",
        "The compensation worker count cannot change while Apply is running.",
      );
    }
    this.maxApplyWorkers = next;
    // Worker zero may own a preview session. Extra Apply lanes are idle when no Apply is active,
    // so shrinking from the end preserves preview continuity and releases their resources.
    while (this.workers.length > next) {
      this.workers.pop()?.terminate();
    }
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
      const profile = await this.validateProfile(request.profile);
      this.assertPreviewPrimeCurrent(reservation);
      const snapshot = this.captureSampleSnapshot(sample, profile);
      const estimatedPreviewBytes = fixed.byteLength +
        fixed.length * snapshot.solveChannels.length *
          ESTIMATED_PREVIEW_BYTES_PER_CHANNEL_EVENT;
      if (!Number.isSafeInteger(estimatedPreviewBytes) || estimatedPreviewBytes > this.previewByteBudget) {
        throw new CompensationManagerError(
          "preview-memory-budget",
          `Compensation preview needs approximately ${estimatedPreviewBytes} bytes, above the ${this.previewByteBudget}-byte budget.`,
        );
      }
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
          method: profile.scientific.method,
          sessionId: state.sessionId,
          sessionToken: state.token,
          profileHash: profile.profileHash,
          bindingKey,
          sourceChannels: snapshot.solveChannels,
          receiverChannels: snapshot.solveChannels,
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
    const candidateSolveMatrix = state.profile.scientific.kind === "flow-spillover"
      ? candidateSnapshot
      : adaptCytofSpilloverMatrix(
          Object.freeze({
            ...state.profile.scientific.matrix,
            matrix: candidateSnapshot,
          }),
          state.profile.scientific.includedChannels,
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
          method: state.profile.scientific.method,
          sessionId: state.sessionId,
          sessionToken: state.token,
          profileHash: state.profile.profileHash,
          bindingKey: state.bindingKey,
          requestId,
          currentMatrix: state.snapshot.solveMatrix,
          candidateMatrix: candidateSolveMatrix,
          ...(state.profile.scientific.kind === "flow-spillover"
            ? { flowSettings: profileFlowSettings(state.profile) }
            : { nnlsSettings: profileNnlsSettings(state.profile) }),
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
      currentWorkerJobs: [],
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
      for (const job of active.currentWorkerJobs) {
        this.postIfAvailable({
          protocol: COMPENSATION_WORKER_PROTOCOL,
          type: "cancel",
          target: "apply",
          id: job.id,
          token: job.token,
        }, job.worker);
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
    for (const job of active.currentWorkerJobs) {
      this.postIfAvailable({
        protocol: COMPENSATION_WORKER_PROTOCOL,
        type: "cancel",
        target: "apply",
        id: job.id,
        token: job.token,
      }, job.worker);
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
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
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
    const poolPlan = planCompensationWorkerPool({
      totalEvents: sample.fcs.nEvents,
      channelCount,
      maxWorkers: this.maxApplyWorkers,
      byteBudget: request.byteBudget ?? this.defaultByteBudget,
      fixedWorkspaceBytes: request.fixedWorkspaceBytes ?? this.defaultFixedWorkspaceBytes,
    });
    const plan = poolPlan.chunk;
    const bindingKey = this.contextKey(profile, snapshot);
    const stagingIdentity: CompensatedLayerStagingIdentity = Object.freeze({
      jobId: `${active.aggregateId}:sample:${sampleIndex}:staging`,
      jobToken: `${active.token}:sample:${sampleIndex}:staging`,
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
      {
        activeLayer: request.targets[sampleIndex].activeLayer ?? "compensated",
        allowOutOfOrderChunks: poolPlan.workerCount > 1,
      },
    );
    const prefix = `apply:${active.aggregateId}:sample:${sampleIndex}:`;
    const chunkRanges: Array<Readonly<{ start: number; end: number }>> = [];
    for (let start = 0; start < sample.fcs.nEvents; start += plan.eventsPerChunk) {
      chunkRanges.push(Object.freeze({
        start,
        end: Math.min(sample.fcs.nEvents, start + plan.eventsPerChunk),
      }));
    }
    const workers = this.ensureWorkers(poolPlan.workerCount);
    let chunkCursor = 0;
    const lanes = workers.map((worker, laneIndex) => {
      const baseCount = Math.floor(chunkRanges.length / workers.length);
      const laneChunkCount = baseCount + (laneIndex < chunkRanges.length % workers.length ? 1 : 0);
      const chunks = chunkRanges.slice(chunkCursor, chunkCursor + laneChunkCount);
      chunkCursor += laneChunkCount;
      const start = chunks[0]?.start ?? 0;
      const end = chunks[chunks.length - 1]?.end ?? 0;
      const identity = Object.freeze({
        id: `${active.aggregateId}:sample:${sampleIndex}:lane:${laneIndex}`,
        token: `${active.token}:sample:${sampleIndex}:lane:${laneIndex}`,
        worker,
      });
      return Object.freeze({ worker, laneIndex, identity, chunks, start, end });
    });
    active.currentWorkerJobs = lanes.map(({ identity }) => identity);
    let completedSampleEvents = 0;

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

    try {
      await Promise.all(lanes.map(async (lane) => {
        const workerIdentity = lane.identity;
        const lanePrefix = `${prefix}lane:${lane.laneIndex}:`;
        const laneEventCount = lane.end - lane.start;
        const startedPromise = this.waitFor(
          (response): response is Extract<CompensationWorkerResponse, { type: "apply-started" }> =>
            response.type === "apply-started" && response.jobId === workerIdentity.id &&
            response.jobToken === workerIdentity.token && response.profileHash === profile.profileHash &&
            response.bindingKey === bindingKey,
          (response) => response.scope === "apply" && response.id === workerIdentity.id && response.token === workerIdentity.token,
          `${lanePrefix}start`,
        );
        const completeWait = () => this.waitFor(
          (response): response is Extract<CompensationWorkerResponse, { type: "apply-complete" }> =>
            response.type === "apply-complete" && response.jobId === workerIdentity.id &&
            response.jobToken === workerIdentity.token && response.profileHash === profile.profileHash &&
            response.bindingKey === bindingKey,
          (response) => response.scope === "apply" && response.id === workerIdentity.id && response.token === workerIdentity.token,
          `${lanePrefix}complete`,
        );
        let completeResponse: Extract<CompensationWorkerResponse, { type: "apply-complete" }> | null = null;
        const zeroEventComplete = laneEventCount === 0 ? completeWait() : null;
        this.postToWorker(lane.worker, {
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
          eventOffset: lane.start,
          totalEvents: laneEventCount,
          channelCount,
          byteBudget: plan.transientByteBudget,
        });
        const started = await startedPromise;
        if (
          started.eventOffset !== lane.start ||
          started.totalEvents !== laneEventCount ||
          !sameWorkerBindings(started.receiverBindings, receiverBindings) ||
          !sameWorkerBindings(started.sourceBindings, sourceBindings)
        ) {
          throw new CompensationManagerError(
            "invalid-worker-binding",
            "A compensation worker started with the wrong event partition or channel mapping.",
          );
        }
        if (zeroEventComplete !== null) completeResponse = await zeroEventComplete;

        for (let chunkIndex = 0; chunkIndex < lane.chunks.length; chunkIndex++) {
          const { start, end } = lane.chunks[chunkIndex];
          this.assertApplyCurrent(active, profile);
          this.assertSnapshotIdentityCurrent(snapshot);
          const measuredColumns = await this.copyReceiverChunk(snapshot, start, end, active, profile);
          this.assertSnapshotIdentityCurrent(snapshot);
          const chunkPromise = this.waitFor(
            (response): response is ApplyChunkCompleteResponse =>
              response.type === "apply-chunk-complete" &&
              response.jobId === workerIdentity.id && response.jobToken === workerIdentity.token &&
              response.profileHash === profile.profileHash && response.bindingKey === bindingKey &&
              response.chunkIndex === chunkIndex && response.startEvent === start,
            (response) => response.scope === "apply" && response.id === workerIdentity.id && response.token === workerIdentity.token,
            `${lanePrefix}chunk:${chunkIndex}`,
          );
          const finalComplete = chunkIndex === lane.chunks.length - 1 ? completeWait() : null;
          this.postToWorker(lane.worker, {
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
          this.assertSnapshotIdentityCurrent(snapshot);
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
          completedSampleEvents += end - start;
          const accepted = acceptedBefore + completedSampleEvents;
          request.onProgress?.(Object.freeze({
            jobId: active.aggregateId,
            sampleIndex,
            sampleCount,
            sampleProcessedEvents: completedSampleEvents,
            sampleTotalEvents: sample.fcs.nEvents,
            processedEvents: accepted,
            totalEvents: aggregateTotal,
            fraction: aggregateTotal === 0 ? 1 : accepted / aggregateTotal,
          }));
        }
        const complete = completeResponse;
        if (
          complete === null ||
          complete.eventOffset !== lane.start ||
          complete.processedEvents !== laneEventCount ||
          complete.totalEvents !== laneEventCount ||
          (complete as { readonly allFinite?: unknown }).allFinite !== true ||
          !sameWorkerBindings(complete.outputBindings, sourceBindings)
        ) {
          throw new CompensationManagerError(
            "invalid-worker-result",
            "A worker completion receipt does not cover its exact event partition and source bindings.",
          );
        }
      }));
      if (completedSampleEvents !== sample.fcs.nEvents) {
        throw new CompensationManagerError(
          "invalid-worker-result",
          "Parallel compensation did not cover the complete Sample.",
        );
      }
      this.assertSnapshotCurrent(snapshot, profile);
      const prepared = sample.finishCompensatedLayerStaging(staging, stagingIdentity);
      active.currentWorkerJobs = [];
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
      this.assertSnapshotIdentityCurrent(snapshot);
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
      this.assertSnapshotIdentityCurrent(snapshot);
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
      channelIdentities: Object.freeze(sample.channels.map(({ pnn, columnIndex }) =>
        Object.freeze({ pnn, columnIndex })
      )),
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
    this.assertSnapshotIdentityCurrent(snapshot);
    const sample = snapshot.sample;
    if (snapshot.displayTransformContextKey !== sample.displayTransformContextKey) {
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

  /**
   * Allocation-free Apply hot-path guard. Full matrix validation is deliberately retained at
   * capture, target boundaries, and transaction finalization; per-slice checks only need to
   * reject changes to the exact Sample/workspace identity already validated for this snapshot.
   */
  private assertSnapshotIdentityCurrent(snapshot: SampleSnapshot): void {
    const sample = snapshot.sample;
    if (
      snapshot.dataRevision !== sample.dataRevision ||
      snapshot.layerRevision !== sample.layerRevision ||
      snapshot.activeLayer !== sample.activeLayer ||
      !sameSampleChannelIdentities(snapshot, sample) ||
      snapshot.invalidationGeneration !== (this.sampleGenerations.get(sample) ?? 0)
    ) {
      throw new CompensationManagerError("stale-sample", "The Sample changed while compensation was running.");
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
    return this.ensureWorkers(1)[0];
  }

  private ensureWorkers(count: number): readonly CompensationWorkerLike[] {
    this.assertUsable();
    positiveSafeInteger(count, "Compensation worker count");
    if (this.workerBroken) {
      for (const worker of this.workers) worker.terminate();
      this.workers.length = 0;
      this.workerBroken = false;
    }
    while (this.workers.length < count) {
      const worker = this.workerFactory();
      if (this.workers.includes(worker)) {
        throw new CompensationManagerError(
          "invalid-worker-factory",
          "The compensation worker factory must return a distinct worker for each pool lane.",
        );
      }
      worker.onmessage = (event) => this.handleWorkerMessage(event.data);
      worker.onerror = (event) => {
        if (!this.workers.includes(worker)) return;
        this.workerBroken = true;
        const workers = this.workers.splice(0);
        for (const candidate of workers) candidate.terminate();
        this.rejectAllWaiters(new CompensationManagerError(
          "worker-exception",
          event.message || "A compensation worker failed.",
        ));
        if (this.activeApply !== null) this.activeApply.cancelled = true;
        this.preview = null;
      };
      this.workers.push(worker);
    }
    return this.workers.slice(0, count);
  }

  private post(request: CompensationWorkerRequest): void {
    this.postToWorker(this.ensureWorker(), request);
  }

  private postToWorker(
    worker: CompensationWorkerLike,
    request: CompensationWorkerRequest,
  ): void {
    if (this.workerBroken || !this.workers.includes(worker)) {
      throw new CompensationManagerError("worker-unavailable", "The selected compensation worker is unavailable.");
    }
    worker.postMessage(request, requestTransferables(request));
  }

  private postIfAvailable(
    request: CompensationWorkerRequest,
    worker: CompensationWorkerLike | undefined = this.workers[0],
  ): void {
    if (this.disposed || !worker || this.workerBroken || !this.workers.includes(worker)) return;
    worker.postMessage(request, requestTransferables(request));
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
