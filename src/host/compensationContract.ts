import type {
  FlowSolverSettingsInput,
  NnlsSolverSettingsInput,
} from "../engine/compensationProfile";
import {
  createCompensationBaselineProfile,
  validateCompensationProfileRecord,
  type CompensationProfileRecord,
} from "../engine/compensationProfileRecord";
import type { AssayLayer } from "../engine/sample";
import type { GateLabHostAssayDescriptor } from "./datasetContract";

export const GATELAB_HOST_COMPENSATION_CONTRACT_VERSION = 1 as const;

export const R_CYTOF_NNLS_SOLVER_VERSION = "r-nnls-v1" as const;
export const R_FLOW_MATRIX_SOLVER_VERSION = "r-matrix-inverse-v1" as const;
export const R_EXTERNAL_PRECOMPUTED_SOLVER_VERSION =
  "r-external-precomputed-v1" as const;

export interface GateLabHostCompensationTarget {
  readonly sampleId: string;
  readonly sourceAssayId: string;
  readonly expectedAssayRevision: number;
  readonly activeLayer: AssayLayer;
}

export interface GateLabHostCompensationApplyRequest {
  readonly contractVersion:
    typeof GATELAB_HOST_COMPENSATION_CONTRACT_VERSION;
  readonly datasetId: string;
  readonly profile: CompensationProfileRecord;
  readonly targets: readonly GateLabHostCompensationTarget[];
  readonly workerCount?: number;
}

export interface GateLabHostCompensationAdoptRequest {
  readonly contractVersion:
    typeof GATELAB_HOST_COMPENSATION_CONTRACT_VERSION;
  readonly datasetId: string;
  /**
   * Truthful external-precomputed profile describing the exact matrix used to
   * create the existing assay. Adoption records provenance but never solves or
   * mutates assay values.
   */
  readonly profile: CompensationProfileRecord;
  readonly outputAssayId: string;
  readonly expectedOutputAssayRevision: number;
  readonly targets: readonly GateLabHostCompensationTarget[];
}

export interface GateLabHostAppliedAssayTarget {
  readonly sampleId: string;
  readonly eventCount: number;
  /** Complete channel-major output assay for this hosted sample. */
  readonly assayPayload: ArrayBuffer;
}

export interface GateLabHostCompensationApplication {
  readonly contractVersion:
    typeof GATELAB_HOST_COMPENSATION_CONTRACT_VERSION;
  readonly datasetId: string;
  readonly profile: CompensationProfileRecord;
  readonly sourceAssayId: string;
  readonly execution: "computed" | "adopted-existing-assay";
  readonly outputAssay: GateLabHostAssayDescriptor;
  readonly targetSampleIds: readonly string[];
  readonly activeSampleIds: readonly string[];
  readonly appliedAt: string;
}

export interface GateLabHostCompensationApplyResult {
  readonly application: GateLabHostCompensationApplication;
  readonly targets: readonly GateLabHostAppliedAssayTarget[];
}

export interface GateLabHostCompensationProgress {
  readonly jobId: string;
  readonly sampleIndex: number;
  readonly sampleCount: number;
  readonly sampleProcessedEvents: number;
  readonly sampleTotalEvents: number;
  readonly processedEvents: number;
  readonly totalEvents: number;
  readonly fraction: number;
}

export interface GateLabHostCompensationPort {
  /**
   * Run the authoritative full-data solve in the host and return its persisted
   * assay. Browser previews remain transient and are never written to the SCE.
   */
  applyProfile(
    request: GateLabHostCompensationApplyRequest,
    signal?: AbortSignal,
    onProgress?: (progress: GateLabHostCompensationProgress) => void,
  ): Promise<GateLabHostCompensationApplyResult>;

  /**
   * Bind an existing linear host assay to an exact matrix/profile without
   * recomputing or changing any assay value.
   */
  adoptExistingAssay(
    request: GateLabHostCompensationAdoptRequest,
    signal?: AbortSignal,
  ): Promise<GateLabHostCompensationApplyResult>;

  /**
   * Rehydrate a previously persisted SCE assay without recomputing it.
   * Returns null when the host has no current application for this profile.
   */
  readStoredApplication(
    datasetId: string,
    profileId: string,
    signal?: AbortSignal,
  ): Promise<GateLabHostCompensationApplyResult | null>;
}

function portableId(): string {
  const random = globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `r-${random}`.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);
}

function solverSettingsObject(
  profile: CompensationProfileRecord,
): FlowSolverSettingsInput | NnlsSolverSettingsInput {
  return Object.fromEntries(
    profile.scientific.solverSettings.map(({ key, value }) => [key, value]),
  ) as unknown as FlowSolverSettingsInput | NnlsSolverSettingsInput;
}

/**
 * Convert a browser-authored profile into a truthful R-solver baseline.
 *
 * The numerical matrix identity is unchanged. The profile identity changes
 * because the final solver is R's implementation, not GateLab's worker
 * implementation. Profiles already owned by the R host pass through intact.
 */
export async function authoritativeRProfile(
  input: CompensationProfileRecord,
): Promise<CompensationProfileRecord> {
  const profile = await validateCompensationProfileRecord(input);
  const expectedSolver = profile.scientific.kind === "cytof-spillover"
    ? R_CYTOF_NNLS_SOLVER_VERSION
    : R_FLOW_MATRIX_SOLVER_VERSION;
  if (profile.scientific.solverVersion === expectedSolver) return profile;

  const settings = solverSettingsObject(profile);
  const scientific = profile.scientific.kind === "cytof-spillover"
    ? {
        kind: "cytof-spillover" as const,
        method: "nnls" as const,
        solverVersion: R_CYTOF_NNLS_SOLVER_VERSION,
        solverSettings: settings as NnlsSolverSettingsInput,
        matrix: profile.scientific.matrix,
        includedChannels: profile.scientific.includedChannels,
      }
    : {
        kind: "flow-spillover" as const,
        method: "matrix-inverse" as const,
        solverVersion: R_FLOW_MATRIX_SOLVER_VERSION,
        solverSettings: settings as FlowSolverSettingsInput,
        matrix: profile.scientific.matrix,
      };

  return createCompensationBaselineProfile(scientific, {
    profileId: portableId(),
    name: profile.name,
    createdAt: new Date(),
    ...(profile.note === null ? {} : { note: profile.note }),
    origin: profile.origin,
    ...(profile.provenance === null
      ? {}
      : { provenance: profile.provenance }),
  });
}

/**
 * Re-identify a browser-authored matrix as an externally precomputed R assay.
 *
 * This preserves the exact matrix but deliberately does not claim GateLabR ran
 * the original solve. The user confirms that the selected assay was created
 * from this matrix before the host records the association.
 */
export async function adoptedRProfile(
  input: CompensationProfileRecord,
): Promise<CompensationProfileRecord> {
  const profile = await validateCompensationProfileRecord(input);
  if (
    profile.scientific.solverVersion ===
      R_EXTERNAL_PRECOMPUTED_SOLVER_VERSION
  ) return profile;

  const settings = solverSettingsObject(profile);
  const scientific = profile.scientific.kind === "cytof-spillover"
    ? {
        kind: "cytof-spillover" as const,
        method: "nnls" as const,
        solverVersion: R_EXTERNAL_PRECOMPUTED_SOLVER_VERSION,
        solverSettings: settings as NnlsSolverSettingsInput,
        matrix: profile.scientific.matrix,
        includedChannels: profile.scientific.includedChannels,
      }
    : {
        kind: "flow-spillover" as const,
        method: "matrix-inverse" as const,
        solverVersion: R_EXTERNAL_PRECOMPUTED_SOLVER_VERSION,
        solverSettings: settings as FlowSolverSettingsInput,
        matrix: profile.scientific.matrix,
      };

  return createCompensationBaselineProfile(scientific, {
    profileId: portableId(),
    name: profile.name,
    createdAt: new Date(),
    ...(profile.note === null ? {} : { note: profile.note }),
    origin: profile.origin,
    provenance: {
      ...(profile.provenance ?? {}),
      estimationMethod: "External precomputed assay",
      estimationSoftware: { name: "R" },
      applicabilityNote:
        "Adopted from an existing R-created assay without recomputation.",
    },
  });
}
