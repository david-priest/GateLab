import type { GateLabHostPopulationSampleMask } from "./colDataContract";

export const GATELAB_HOST_WORKSPACE_CONTRACT_VERSION = 1 as const;

export type GateLabHostWorkspaceSource =
  | "gatelab-workspace"
  | "gatelabr-legacy";

/**
 * A workspace is small enough for Shiny's websocket, but it travels as an
 * explicit JSON string so R vector auto-unboxing cannot change one-item arrays
 * such as gate_order or population children.
 */
export interface GateLabHostWorkspaceEnvelope {
  contractVersion: typeof GATELAB_HOST_WORKSPACE_CONTRACT_VERSION;
  datasetId: string;
  sourceFormat: GateLabHostWorkspaceSource;
  /**
   * Monotonic host revision. Legacy GateLabR metadata starts at revision zero;
   * every successful React write increments it.
   */
  revision: number;
  workspaceJson: string;
}

export type GateLabHostWorkspaceWriteReason = "autosave" | "explicit";

/** One population of one hierarchy, with its membership over every SCE sample. */
export interface GateLabHostMembershipPopulation {
  hierarchyId: string;
  populationId: string;
  populationName: string;
  /** Null for the hierarchy's root. */
  parentId: string | null;
  gateLogic: "and" | "or";
  gates: readonly Readonly<{
    gateId: string;
    gateName: string;
    include: boolean;
    quadrant?: number;
  }>[];
  /** One mask per SCE sample, in the packed form the colData export uses. */
  sampleMasks: readonly GateLabHostPopulationSampleMask[];
}

/**
 * Every population of every hierarchy, evaluated over every event of the SCE.
 *
 * The workspace JSON carries gate geometry, and membership is computed only in the browser, so
 * without this the R side could never say which events a population holds without reimplementing
 * the gating engine. Sent with an explicit save, not an autosave: it costs one bit per event per
 * population and a full evaluation of every sample.
 */
export interface GateLabHostWorkspaceMemberships {
  hierarchies: readonly Readonly<{
    id: string;
    name: string;
    active: boolean;
    rootPopulationId: string;
  }>[];
  /** In hierarchy order, then tree order within a hierarchy (parents before children). */
  populations: readonly GateLabHostMembershipPopulation[];
}

export interface GateLabHostWorkspaceWriteRequest {
  datasetId: string;
  expectedRevision: number;
  clientRevision: number;
  reason: GateLabHostWorkspaceWriteReason;
  workspaceJson: string;
  /**
   * Stable identity for this browser session, recorded with the write.
   *
   * A write can land while its response is lost, leaving this browser behind the SCE and every
   * later save failing the revision check. Comparing this id against the one stored with the
   * winning write is what separates "my own write, whose reply I never heard" -- recoverable by
   * resyncing -- from a genuine second session, which must not be silently overwritten.
   * Optional: hosts that predate it simply record nothing.
   */
  writerId?: string;
  /**
   * Population memberships to store beside the workspace. Optional: an autosave omits them, and a
   * host that predates them ignores the field. The host keeps the last set it was given until the
   * next set arrives, recording the workspace revision they were computed at.
   */
  memberships?: GateLabHostWorkspaceMemberships;
}

/** A revision conflict, carrying what the browser needs to tell its own lost write apart. */
export interface GateLabHostWorkspaceConflict {
  expectedRevision: number;
  currentRevision: number;
  /** Absent when the stored write predates writer ids, and therefore cannot be attributed. */
  writerId?: string;
}

export interface GateLabHostWorkspaceWriteResult {
  revision: number;
  clientRevision: number;
  savedAt: string;
  /** Present when the write carried memberships and the host stored them. */
  memberships?: Readonly<{ hierarchies: number; populations: number }>;
}

export interface GateLabHostWorkspacePort {
  readWorkspace(
    datasetId: string,
  ): Promise<GateLabHostWorkspaceEnvelope | null>;
  writeWorkspace(
    request: GateLabHostWorkspaceWriteRequest,
  ): Promise<GateLabHostWorkspaceWriteResult>;
}

/** Error carrying a revision conflict's data, so callers can resync rather than only report. */
export class GateLabWorkspaceConflictError extends Error {
  readonly conflict: GateLabHostWorkspaceConflict;

  constructor(message: string, conflict: GateLabHostWorkspaceConflict) {
    super(message);
    this.name = "GateLabWorkspaceConflictError";
    this.conflict = conflict;
  }
}

function finiteRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Read a host error response as a revision conflict, or null when it is anything else.
 *
 * Both revisions must be present and well formed: a partial payload is treated as an ordinary
 * failure, because resyncing to a revision we cannot trust would be worse than reporting.
 */
export function workspaceConflictFrom(
  errorCode: unknown,
  errorData: unknown,
): GateLabHostWorkspaceConflict | null {
  if (errorCode !== "workspace-revision-conflict") return null;
  if (!errorData || typeof errorData !== "object") return null;
  const source = errorData as Record<string, unknown>;
  const currentRevision = finiteRevision(source.currentRevision);
  const expectedRevision = finiteRevision(source.expectedRevision);
  if (currentRevision === null || expectedRevision === null) return null;
  const writerId = source.writerId;
  return {
    expectedRevision,
    currentRevision,
    ...(typeof writerId === "string" && writerId.length > 0 ? { writerId } : {}),
  };
}
