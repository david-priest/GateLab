import {
  reportMatrixCompatibility,
  type MatrixChannelBinding,
  type SamplePnnChannel,
} from "./compensationCompatibility";
import {
  type CompensationKind,
  type CompensationMethod,
  type Sha256Digest,
} from "./compensationProfile";
import {
  validateCompensationProfileLineage,
  type ValidatedCompensationProfileLineage,
} from "./compensationProfileLineage";
import type { CompensationProfileRecord } from "./compensationProfileRecord";

export const WORKSPACE_COMPENSATION_SCHEMA = "gatelab.workspace-compensation.v1" as const;
export const SAMPLE_ASSAY_BINDING_SCHEMA = "gatelab.sample-assay-binding.v1" as const;

export interface WorkspaceCompensationLineage {
  readonly baselineProfileId: string;
  readonly records: readonly CompensationProfileRecord[];
}

export interface WorkspaceCompensationState {
  readonly schema: typeof WORKSPACE_COMPENSATION_SCHEMA;
  readonly lineages: readonly WorkspaceCompensationLineage[];
}

export interface ValidatedWorkspaceCompensationState extends WorkspaceCompensationState {
  readonly lineages: readonly WorkspaceCompensationLineage[];
}

export type PersistedTransformBinding =
  | Readonly<{ kind: "flow-linear" }>
  | Readonly<{ kind: "cytof-asinh"; cofactor: number }>;

export interface PersistedCompensatedLayerBinding {
  readonly profileId: string;
  readonly profileHash: Sha256Digest;
  readonly matrixHash: Sha256Digest;
  readonly kind: CompensationKind;
  readonly method: CompensationMethod;
  readonly includedPnns: readonly string[];
  readonly channelBindings: readonly MatrixChannelBinding[];
  readonly transformBinding: PersistedTransformBinding;
}

export interface SampleAssayBinding {
  readonly schema: typeof SAMPLE_ASSAY_BINDING_SCHEMA;
  readonly activeLayer: "original" | "compensated";
  /** May remain installed while Original is active so the user can switch back. */
  readonly compensatedLayer: PersistedCompensatedLayerBinding | null;
}

export type WorkspaceCompensationValidationCode =
  | "invalid-compensation-state"
  | "unsupported-compensation-schema"
  | "invalid-lineage-entry"
  | "lineage-baseline-mismatch"
  | "duplicate-global-profile-id"
  | "invalid-assay-binding"
  | "unsupported-assay-schema"
  | "active-layer-missing"
  | "missing-profile"
  | "profile-identity-mismatch"
  | "included-channels-mismatch"
  | "invalid-channel-binding"
  | "incomplete-included-binding"
  | "transform-mismatch"
  | "sample-context-required"
  | "sample-kind-mismatch"
  | "sample-mapping-incompatible"
  | "persisted-mapping-mismatch"
  | "legacy-compensated-workspace";

export class WorkspaceCompensationValidationError extends Error {
  readonly code: WorkspaceCompensationValidationCode;
  readonly profileId?: string;
  readonly lineageIndex?: number;
  override readonly cause?: unknown;

  constructor(
    code: WorkspaceCompensationValidationCode,
    message: string,
    details: { readonly profileId?: string; readonly lineageIndex?: number; readonly cause?: unknown } = {},
  ) {
    super(`Invalid workspace compensation state: ${message}`);
    this.name = "WorkspaceCompensationValidationError";
    this.code = code;
    this.profileId = details.profileId;
    this.lineageIndex = details.lineageIndex;
    this.cause = details.cause;
  }
}

function invalid(
  code: WorkspaceCompensationValidationCode,
  message: string,
  details: { readonly profileId?: string; readonly lineageIndex?: number; readonly cause?: unknown } = {},
): never {
  throw new WorkspaceCompensationValidationError(code, message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
  code: WorkspaceCompensationValidationCode = "invalid-assay-binding",
): void {
  const actual = Object.keys(value);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extra = actual.filter((key) => !required.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    invalid(
      code,
      `${label} must contain exactly [${required.join(", ")}].` +
        (missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "") +
        (extra.length > 0 ? ` Unexpected: ${extra.join(", ")}.` : ""),
    );
  }
}

function denseArray(
  value: unknown,
  label: string,
  code: WorkspaceCompensationValidationCode = "invalid-assay-binding",
): unknown[] {
  if (!Array.isArray(value)) {
    invalid(code, `${label} must be an array.`);
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      invalid(code, `${label} must not contain sparse entries.`);
    }
  }
  return Array.from(value);
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function findProfile(
  compensation: ValidatedWorkspaceCompensationState,
  profileId: string,
): CompensationProfileRecord | undefined {
  for (const lineage of compensation.lineages) {
    const found = lineage.records.find((record) => record.profileId === profileId);
    if (found) return found;
  }
  return undefined;
}

function sameBinding(left: MatrixChannelBinding, right: MatrixChannelBinding): boolean {
  return left.pnn === right.pnn &&
    left.fcsColumnIndex === right.fcsColumnIndex &&
    left.matrixSourceIndex === right.matrixSourceIndex &&
    left.matrixReceiverIndex === right.matrixReceiverIndex &&
    left.included === right.included;
}

/** Validate and canonicalize all workspace-level profile histories. Empty state is valid. */
export async function validateWorkspaceCompensationState(
  untrusted: unknown,
): Promise<ValidatedWorkspaceCompensationState> {
  if (!isRecord(untrusted)) {
    invalid("invalid-compensation-state", "compensation state must be an object.");
  }
  const state = untrusted as Record<string, unknown>;
  const keys = Object.keys(state);
  if (
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(state, "schema") ||
    !Object.prototype.hasOwnProperty.call(state, "lineages")
  ) {
    invalid(
      "invalid-compensation-state",
      "compensation state must contain exactly schema and lineages.",
    );
  }
  if (state.schema !== WORKSPACE_COMPENSATION_SCHEMA) {
    invalid(
      "unsupported-compensation-schema",
      `unsupported schema '${String(state.schema)}'.`,
    );
  }
  if (!Array.isArray(state.lineages)) {
    invalid("invalid-compensation-state", "lineages must be an array.");
  }
  for (let index = 0; index < state.lineages.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(state.lineages, index)) {
      invalid("invalid-compensation-state", "lineages must not contain sparse entries.");
    }
  }

  const validated: WorkspaceCompensationLineage[] = [];
  for (let index = 0; index < state.lineages.length; index++) {
    const candidate = state.lineages[index];
    if (!isRecord(candidate)) {
      invalid("invalid-lineage-entry", `lineage ${index + 1} must be an object.`, {
        lineageIndex: index,
      });
    }
    const entry = candidate as Record<string, unknown>;
    if (
      Object.keys(entry).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(entry, "baselineProfileId") ||
      !Object.prototype.hasOwnProperty.call(entry, "records") ||
      typeof entry.baselineProfileId !== "string"
    ) {
      invalid(
        "invalid-lineage-entry",
        `lineage ${index + 1} must contain exactly baselineProfileId and records.`,
        { lineageIndex: index },
      );
    }
    let lineage: ValidatedCompensationProfileLineage;
    try {
      lineage = await validateCompensationProfileLineage(entry.records);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      invalid("invalid-lineage-entry", `lineage ${index + 1} is invalid: ${detail}`, {
        lineageIndex: index,
        cause,
      });
    }
    if (entry.baselineProfileId !== lineage.baseline.profileId) {
      invalid(
        "lineage-baseline-mismatch",
        `lineage ${index + 1} declares baseline "${String(entry.baselineProfileId)}" but contains "${lineage.baseline.profileId}".`,
        { lineageIndex: index, profileId: lineage.baseline.profileId },
      );
    }
    validated.push(
      Object.freeze({
        baselineProfileId: lineage.baseline.profileId,
        records: lineage.records,
      }),
    );
  }

  validated.sort((left, right) => compareCodePoints(left.baselineProfileId, right.baselineProfileId));
  const profileIds = new Set<string>();
  for (const lineage of validated) {
    for (const record of lineage.records) {
      if (profileIds.has(record.profileId)) {
        invalid(
          "duplicate-global-profile-id",
          `profileId "${record.profileId}" appears in more than one lineage.`,
          { profileId: record.profileId },
        );
      }
      profileIds.add(record.profileId);
    }
  }
  return Object.freeze({
    schema: WORKSPACE_COMPENSATION_SCHEMA,
    lineages: Object.freeze(validated),
  });
}

export function createOriginalSampleAssayBinding(): SampleAssayBinding {
  return Object.freeze({
    schema: SAMPLE_ASSAY_BINDING_SCHEMA,
    activeLayer: "original",
    compensatedLayer: null,
  });
}

/** Safe legacy migration is possible only when the old implicit compensation switch was off. */
export function migrateLegacySampleAssayBinding(compensationOn: unknown): SampleAssayBinding {
  if (compensationOn !== false) {
    invalid(
      "legacy-compensated-workspace",
      compensationOn === true
        ? "a legacy workspace marked as compensated needs FCS-assisted migration and cannot be opened as Original data."
        : "the legacy compensation flag is missing or invalid.",
    );
  }
  return createOriginalSampleAssayBinding();
}

function canonicalTransformBinding(
  value: unknown,
  profile: CompensationProfileRecord,
  expectedCytofCofactor?: number,
): PersistedTransformBinding {
  if (!isRecord(value) || typeof value.kind !== "string") {
    invalid("transform-mismatch", "transformBinding must declare a supported transform.", {
      profileId: profile.profileId,
    });
  }
  if (profile.scientific.kind === "flow-spillover") {
    assertExactKeys(value, ["kind"], "flow transformBinding", "transform-mismatch");
    if (value.kind !== "flow-linear") {
      invalid("transform-mismatch", "flow compensation requires flow-linear transform binding.", {
        profileId: profile.profileId,
      });
    }
    return Object.freeze({ kind: "flow-linear" });
  }
  assertExactKeys(
    value,
    ["kind", "cofactor"],
    "CyTOF transformBinding",
    "transform-mismatch",
  );
  if (
    value.kind !== "cytof-asinh" ||
    typeof value.cofactor !== "number" ||
    !Number.isFinite(value.cofactor) ||
    value.cofactor <= 0
  ) {
    invalid(
      "transform-mismatch",
      "CyTOF compensation requires a positive finite cytof-asinh cofactor.",
      { profileId: profile.profileId },
    );
  }
  if (expectedCytofCofactor !== undefined && value.cofactor !== expectedCytofCofactor) {
    invalid(
      "transform-mismatch",
      `persisted CyTOF cofactor ${value.cofactor} does not match sample cofactor ${expectedCytofCofactor}.`,
      { profileId: profile.profileId },
    );
  }
  return Object.freeze({ kind: "cytof-asinh", cofactor: value.cofactor });
}

function canonicalChannelBindings(
  value: unknown,
  profile: CompensationProfileRecord,
  includedPnns: readonly string[],
): readonly MatrixChannelBinding[] {
  const entries = denseArray(value, "channelBindings", "invalid-channel-binding");
  const sourceChannels = profile.scientific.matrix.sourceChannels;
  const receiverChannels = profile.scientific.matrix.receiverChannels;
  const included = new Set(includedPnns);
  const seenPnn = new Set<string>();
  const seenFcs = new Set<number>();
  const seenReceiver = new Set<number>();
  const bindings: MatrixChannelBinding[] = [];

  for (let index = 0; index < entries.length; index++) {
    if (!isRecord(entries[index])) {
      invalid("invalid-channel-binding", `channel binding ${index + 1} must be an object.`, {
        profileId: profile.profileId,
      });
    }
    const entry = entries[index] as Record<string, unknown>;
    assertExactKeys(
      entry,
      ["pnn", "fcsColumnIndex", "matrixSourceIndex", "matrixReceiverIndex", "included"],
      `channel binding ${index + 1}`,
      "invalid-channel-binding",
    );
    if (
      typeof entry.pnn !== "string" ||
      !Number.isSafeInteger(entry.fcsColumnIndex) ||
      (entry.fcsColumnIndex as number) < 0 ||
      !Number.isSafeInteger(entry.matrixReceiverIndex) ||
      (entry.matrixReceiverIndex as number) < 0 ||
      (entry.matrixSourceIndex !== null &&
        (!Number.isSafeInteger(entry.matrixSourceIndex) || (entry.matrixSourceIndex as number) < 0)) ||
      typeof entry.included !== "boolean"
    ) {
      invalid("invalid-channel-binding", `channel binding ${index + 1} has invalid field types.`, {
        profileId: profile.profileId,
      });
    }
    const pnn = entry.pnn;
    const fcsColumnIndex = Object.is(entry.fcsColumnIndex, -0)
      ? 0
      : entry.fcsColumnIndex as number;
    const matrixReceiverIndex = Object.is(entry.matrixReceiverIndex, -0)
      ? 0
      : entry.matrixReceiverIndex as number;
    const matrixSourceIndex = entry.matrixSourceIndex === null
      ? null
      : Object.is(entry.matrixSourceIndex, -0)
        ? 0
        : entry.matrixSourceIndex as number;
    const expectedPnn = receiverChannels[matrixReceiverIndex];
    const expectedSourceIndex = sourceChannels.indexOf(pnn);
    if (
      expectedPnn !== pnn ||
      (expectedSourceIndex < 0 ? matrixSourceIndex !== null : matrixSourceIndex !== expectedSourceIndex) ||
      entry.included !== included.has(pnn) ||
      (matrixSourceIndex === null && profile.scientific.kind !== "cytof-spillover")
    ) {
      invalid(
        "invalid-channel-binding",
        `channel binding ${index + 1} does not match profile axes or included-channel state.`,
        { profileId: profile.profileId },
      );
    }
    if (
      seenPnn.has(pnn) ||
      seenFcs.has(fcsColumnIndex) ||
      seenReceiver.has(matrixReceiverIndex)
    ) {
      invalid(
        "invalid-channel-binding",
        `channel binding ${index + 1} duplicates a PnN, FCS column, or matrix receiver.`,
        { profileId: profile.profileId },
      );
    }
    if (bindings.length > 0 && bindings[bindings.length - 1].matrixReceiverIndex >= matrixReceiverIndex) {
      invalid(
        "invalid-channel-binding",
        "channelBindings must be ordered by increasing matrixReceiverIndex.",
        { profileId: profile.profileId },
      );
    }
    seenPnn.add(pnn);
    seenFcs.add(fcsColumnIndex);
    seenReceiver.add(matrixReceiverIndex);
    bindings.push(
      Object.freeze({ pnn, fcsColumnIndex, matrixSourceIndex, matrixReceiverIndex, included: entry.included }),
    );
  }

  const missingIncluded = includedPnns.filter((pnn) => !seenPnn.has(pnn));
  if (missingIncluded.length > 0) {
    invalid(
      "incomplete-included-binding",
      `included channels lack persisted FCS bindings: ${missingIncluded.join(", ")}.`,
      { profileId: profile.profileId },
    );
  }
  return Object.freeze(bindings);
}

export function validateSampleAssayBinding(
  untrusted: unknown,
  compensation: ValidatedWorkspaceCompensationState,
  context: {
    readonly sampleChannels?: readonly SamplePnnChannel[];
    readonly instrumentKind?: "flow" | "cytof";
    readonly expectedCytofCofactor?: number;
  } = {},
): SampleAssayBinding {
  if (!isRecord(untrusted)) {
    invalid("invalid-assay-binding", "sample assay binding must be an object.");
  }
  const assay = untrusted as Record<string, unknown>;
  assertExactKeys(assay, ["schema", "activeLayer", "compensatedLayer"], "sample assay binding");
  if (assay.schema !== SAMPLE_ASSAY_BINDING_SCHEMA) {
    invalid("unsupported-assay-schema", `unsupported schema '${String(assay.schema)}'.`);
  }
  if (assay.activeLayer !== "original" && assay.activeLayer !== "compensated") {
    invalid("invalid-assay-binding", "activeLayer must be original or compensated.");
  }
  if (assay.compensatedLayer === null) {
    if (assay.activeLayer === "compensated") {
      invalid("active-layer-missing", "Compensated cannot be active without a persisted layer binding.");
    }
    return createOriginalSampleAssayBinding();
  }
  if (!isRecord(assay.compensatedLayer)) {
    invalid("invalid-assay-binding", "compensatedLayer must be an object or null.");
  }
  const layer = assay.compensatedLayer as Record<string, unknown>;
  assertExactKeys(
    layer,
    [
      "profileId",
      "profileHash",
      "matrixHash",
      "kind",
      "method",
      "includedPnns",
      "channelBindings",
      "transformBinding",
    ],
    "compensatedLayer",
  );
  if (typeof layer.profileId !== "string") {
    invalid("missing-profile", "compensatedLayer profileId must be a string.");
  }
  const profile = findProfile(compensation, layer.profileId);
  if (!profile) {
    invalid("missing-profile", `profile "${layer.profileId}" is not stored in the workspace.`, {
      profileId: layer.profileId,
    });
  }
  if (
    layer.profileHash !== profile.profileHash ||
    layer.matrixHash !== profile.matrixHash ||
    layer.kind !== profile.scientific.kind ||
    layer.method !== profile.scientific.method
  ) {
    invalid(
      "profile-identity-mismatch",
      `persisted binding does not match exact identity of profile "${profile.profileId}".`,
      { profileId: profile.profileId },
    );
  }
  const rawIncluded = denseArray(
    layer.includedPnns,
    "includedPnns",
    "included-channels-mismatch",
  );
  if (rawIncluded.some((pnn) => typeof pnn !== "string")) {
    invalid("included-channels-mismatch", "includedPnns must contain only strings.", {
      profileId: profile.profileId,
    });
  }
  const includedPnns = rawIncluded as string[];
  const expectedIncluded =
    profile.scientific.kind === "flow-spillover"
      ? profile.scientific.matrix.receiverChannels
      : profile.scientific.includedChannels;
  if (!sameStrings(includedPnns, expectedIncluded)) {
    invalid(
      "included-channels-mismatch",
      `includedPnns do not match profile "${profile.profileId}".`,
      { profileId: profile.profileId },
    );
  }
  if (!Array.isArray(context.sampleChannels) || context.instrumentKind === undefined) {
    invalid(
      "sample-context-required",
      `restoring profile "${profile.profileId}" requires the parsed sample's exact PnN/column mapping and effective instrument kind.`,
      { profileId: profile.profileId },
    );
  }
  const expectedInstrumentKind =
    profile.scientific.kind === "flow-spillover" ? "flow" : "cytof";
  if (context.instrumentKind !== expectedInstrumentKind) {
    invalid(
      "sample-kind-mismatch",
      `profile "${profile.profileId}" is ${expectedInstrumentKind} but the sample is ${context.instrumentKind}.`,
      { profileId: profile.profileId },
    );
  }
  if (
    profile.scientific.kind === "cytof-spillover" &&
    context.expectedCytofCofactor === undefined
  ) {
    invalid(
      "sample-context-required",
      `restoring CyTOF profile "${profile.profileId}" requires the sample's effective arcsinh cofactor.`,
      { profileId: profile.profileId },
    );
  }
  const channelBindings = canonicalChannelBindings(layer.channelBindings, profile, includedPnns);
  const transformBinding = canonicalTransformBinding(
    layer.transformBinding,
    profile,
    context.expectedCytofCofactor,
  );
  const compatibility = reportMatrixCompatibility(
    profile.scientific.kind === "flow-spillover"
      ? {
          kind: "flow-spillover",
          matrix: profile.scientific.matrix,
          sampleChannels: context.sampleChannels,
        }
      : {
          kind: "cytof-spillover",
          matrix: profile.scientific.matrix,
          sampleChannels: context.sampleChannels,
          includedChannels: profile.scientific.includedChannels,
        },
  );
  if (!compatibility.canApply) {
    invalid(
      "sample-mapping-incompatible",
      `profile "${profile.profileId}" is not compatible with this sample: ${compatibility.blockers
        .map(({ message }) => message)
        .join(" ")}`,
      { profileId: profile.profileId },
    );
  }
  if (
    channelBindings.length !== compatibility.bindings.length ||
    channelBindings.some((binding, index) => !sameBinding(binding, compatibility.bindings[index]))
  ) {
    invalid(
      "persisted-mapping-mismatch",
      `persisted channel bindings for profile "${profile.profileId}" do not exactly match the parsed FCS file.`,
      { profileId: profile.profileId },
    );
  }
  const compensatedLayer: PersistedCompensatedLayerBinding = Object.freeze({
    profileId: profile.profileId,
    profileHash: profile.profileHash,
    matrixHash: profile.matrixHash,
    kind: profile.scientific.kind,
    method: profile.scientific.method,
    includedPnns: Object.freeze(Array.from(includedPnns)),
    channelBindings,
    transformBinding,
  });
  return Object.freeze({
    schema: SAMPLE_ASSAY_BINDING_SCHEMA,
    activeLayer: assay.activeLayer,
    compensatedLayer,
  });
}
