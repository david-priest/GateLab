import type {
  FlowChannelImpact,
  FlowMatrixDiagnostics,
  FlowReconstructionDiagnostics,
  FlowSolverSettings,
} from "../engine/flowCompensationEngine";

export const COMPENSATION_WORKER_PROTOCOL =
  "gatelab.compensation-worker.v1" as const;

export type CompensationWorkerMethod = "matrix-inverse" | "nnls";

/** Exact one-channel bridge between FCS identity and both matrix axes. */
export interface CompensationWorkerChannelBinding {
  readonly pnn: string;
  readonly fcsColumnIndex: number;
  readonly matrixSourceIndex: number;
  readonly matrixReceiverIndex: number;
}

interface WorkerRequestBase {
  readonly protocol: typeof COMPENSATION_WORKER_PROTOCOL;
}

interface PreviewIdentity {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly profileHash: string;
  readonly bindingKey: string;
}

interface ApplyIdentity {
  readonly jobId: string;
  readonly jobToken: string;
  readonly profileHash: string;
  readonly bindingKey: string;
}

export interface PrimePreviewRequest extends WorkerRequestBase, PreviewIdentity {
  readonly type: "prime-preview";
  readonly method: CompensationWorkerMethod;
  readonly sourceChannels: readonly string[];
  readonly receiverChannels: readonly string[];
  /** Receiver-order identities for the fixed measured columns. */
  readonly channelBindings: readonly CompensationWorkerChannelBinding[];
  readonly fixedEventIndices: Uint32Array;
  /** Private Float64 copies in receiver-channel order; original Sample columns are never sent. */
  readonly measuredColumns: readonly Float64Array[];
}

export interface SolvePreviewRequest extends WorkerRequestBase, PreviewIdentity {
  readonly type: "solve-preview";
  readonly requestId: string;
  readonly method: CompensationWorkerMethod;
  readonly currentMatrix: readonly (readonly number[])[];
  readonly candidateMatrix: readonly (readonly number[])[];
  readonly flowSettings?: FlowSolverSettings;
}

export interface StartApplyRequest extends WorkerRequestBase, ApplyIdentity {
  readonly type: "start-apply";
  readonly method: CompensationWorkerMethod;
  readonly sourceChannels: readonly string[];
  readonly receiverChannels: readonly string[];
  /** Receiver-order bindings; apply-chunk columns use this exact order. */
  readonly channelBindings: readonly CompensationWorkerChannelBinding[];
  readonly matrix: readonly (readonly number[])[];
  readonly flowSettings?: FlowSolverSettings;
  readonly totalEvents: number;
  readonly channelCount: number;
  /** Governs host-side chunk construction and is echoed for an auditable job receipt. */
  readonly byteBudget: number;
}

export interface ApplyChunkRequest extends WorkerRequestBase, ApplyIdentity {
  readonly type: "apply-chunk";
  readonly chunkIndex: number;
  readonly startEvent: number;
  /** Fresh transferable copies in receiver-channel order. */
  readonly measuredColumns: readonly Float64Array[];
}

export interface CancelCompensationRequest extends WorkerRequestBase {
  readonly type: "cancel";
  readonly target: "preview" | "apply";
  readonly id: string;
  readonly token: string;
}

export type CompensationWorkerRequest =
  | PrimePreviewRequest
  | SolvePreviewRequest
  | StartApplyRequest
  | ApplyChunkRequest
  | CancelCompensationRequest;

interface WorkerResponseBase {
  readonly protocol: typeof COMPENSATION_WORKER_PROTOCOL;
}

export interface PreviewPrimedResponse extends WorkerResponseBase, PreviewIdentity {
  readonly type: "preview-primed";
  readonly eventCount: number;
  readonly channelCount: number;
  readonly receiverBindings: readonly CompensationWorkerChannelBinding[];
  readonly sourceBindings: readonly CompensationWorkerChannelBinding[];
}

export interface PreviewSolvedResponse extends WorkerResponseBase, PreviewIdentity {
  readonly type: "preview-solved";
  readonly requestId: string;
  readonly eventCount: number;
  readonly sourceChannels: readonly string[];
  readonly receiverBindings: readonly CompensationWorkerChannelBinding[];
  readonly sourceBindings: readonly CompensationWorkerChannelBinding[];
  readonly currentColumns: readonly Float64Array[];
  readonly candidateColumns: readonly Float64Array[];
  readonly deltas: readonly Float64Array[];
  readonly impacts: readonly FlowChannelImpact[];
  readonly impactRanking: readonly FlowChannelImpact[];
  readonly currentDiagnostics: FlowMatrixDiagnostics;
  readonly candidateDiagnostics: FlowMatrixDiagnostics;
  readonly currentReconstruction: FlowReconstructionDiagnostics | null;
  readonly candidateReconstruction: FlowReconstructionDiagnostics | null;
}

export interface ApplyStartedResponse extends WorkerResponseBase, ApplyIdentity {
  readonly type: "apply-started";
  readonly totalEvents: number;
  readonly channelCount: number;
  readonly byteBudget: number;
  readonly diagnostics: FlowMatrixDiagnostics;
  readonly receiverBindings: readonly CompensationWorkerChannelBinding[];
  readonly sourceBindings: readonly CompensationWorkerChannelBinding[];
}

export interface ApplyChunkCompleteResponse extends WorkerResponseBase, ApplyIdentity {
  readonly type: "apply-chunk-complete";
  readonly chunkIndex: number;
  readonly startEvent: number;
  readonly eventCount: number;
  /** Exact source-order identities for the returned columns. */
  readonly outputBindings: readonly CompensationWorkerChannelBinding[];
  /** Float32 installed-assay precision, in source-channel order. */
  readonly columns: readonly Float32Array[];
}

export interface ApplyProgressResponse extends WorkerResponseBase, ApplyIdentity {
  readonly type: "apply-progress";
  readonly processedEvents: number;
  readonly totalEvents: number;
  readonly fraction: number;
  /** Source-order output identities for the progress receipt. */
  readonly outputBindings: readonly CompensationWorkerChannelBinding[];
}

export interface ApplyCompleteResponse extends WorkerResponseBase, ApplyIdentity {
  readonly type: "apply-complete";
  readonly processedEvents: number;
  readonly totalEvents: number;
  readonly outputBindings: readonly CompensationWorkerChannelBinding[];
  readonly allFinite: true;
}

export interface CompensationCancelledResponse extends WorkerResponseBase {
  readonly type: "cancelled";
  readonly target: "preview" | "apply";
  readonly id: string;
  readonly token: string;
}

export type CompensationWorkerErrorScope =
  | "preview"
  | "apply"
  | "protocol";

export interface CompensationWorkerErrorResponse extends WorkerResponseBase {
  readonly type: "worker-error";
  readonly scope: CompensationWorkerErrorScope;
  readonly id: string | null;
  readonly token: string | null;
  readonly requestId?: string;
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

export type CompensationWorkerResponse =
  | PreviewPrimedResponse
  | PreviewSolvedResponse
  | ApplyStartedResponse
  | ApplyChunkCompleteResponse
  | ApplyProgressResponse
  | ApplyCompleteResponse
  | CompensationCancelledResponse
  | CompensationWorkerErrorResponse;

export type CompensationWorkerEmit = (
  response: CompensationWorkerResponse,
  transfer?: readonly Transferable[],
) => void;

function exactDistinctTransferBuffers(
  views: readonly (Uint32Array | Float64Array)[],
  label: string,
): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  const seen = new Set<ArrayBuffer>();
  for (const view of views) {
    const buffer = view.buffer;
    if (
      !(buffer instanceof ArrayBuffer) ||
      view.byteOffset !== 0 ||
      view.byteLength !== buffer.byteLength ||
      seen.has(buffer)
    ) {
      throw new TypeError(
        `${label} must use one exact-owned, distinct ArrayBuffer per transferred column.`,
      );
    }
    seen.add(buffer);
    buffers.push(buffer);
  }
  return buffers;
}

export function requestTransferables(
  request: CompensationWorkerRequest,
): Transferable[] {
  if (request.type === "prime-preview") {
    return exactDistinctTransferBuffers(
      [request.fixedEventIndices, ...request.measuredColumns],
      "Preview transfer views",
    );
  }
  if (request.type === "apply-chunk") {
    return exactDistinctTransferBuffers(
      request.measuredColumns,
      "Apply transfer columns",
    );
  }
  return [];
}

export function responseTransferables(
  response: CompensationWorkerResponse,
): Transferable[] {
  if (response.type === "preview-solved") {
    return [
      ...response.currentColumns.map((column) => column.buffer),
      ...response.candidateColumns.map((column) => column.buffer),
      ...response.deltas.map((column) => column.buffer),
    ];
  }
  if (response.type === "apply-chunk-complete") {
    return response.columns.map((column) => column.buffer);
  }
  return [];
}
