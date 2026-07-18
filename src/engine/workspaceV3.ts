import type { SamplePnnChannel } from "./compensationCompatibility";
import { strToU8, zipSync } from "fflate";
import {
  createOriginalSampleAssayBinding,
  migrateLegacySampleAssayBinding,
  validateSampleAssayBinding,
  validateWorkspaceCompensationState,
  WORKSPACE_COMPENSATION_SCHEMA,
  type SampleAssayBinding,
  type WorkspaceCompensationState,
} from "./workspaceCompensation";
import {
  migrateWorkspaceToV2,
  validateWorkspace,
  WORKSPACE_FORMAT,
  type WorkspaceFile,
  type WorkspaceStorage,
  type WorkspaceSample,
} from "./workspace";

export const WORKSPACE_VERSION_3 = 3 as const;

export type WorkspaceSampleV3 = Omit<WorkspaceSample, "compensationOn"> & {
  assay: SampleAssayBinding;
};

export type WorkspaceFileV3 = Omit<WorkspaceFile, "version" | "samples"> & {
  version: typeof WORKSPACE_VERSION_3;
  samples: WorkspaceSampleV3[];
  compensation: WorkspaceCompensationState;
};

export interface WorkspaceV3SampleRestoreContext {
  readonly sampleChannels: readonly SamplePnnChannel[];
  readonly instrumentKind: "flow" | "cytof";
}

export type WorkspaceV3SampleRestoreContexts = Readonly<
  Record<string, WorkspaceV3SampleRestoreContext>
>;

export type WorkspaceV3ValidationCode =
  | "unrecognized-workspace"
  | "unsupported-workspace-version"
  | "invalid-workspace-v3"
  | "invalid-workspace-sample"
  | "unsafe-legacy-compensation"
  | "invalid-compensation-state"
  | "invalid-sample-assay";

export class WorkspaceV3ValidationError extends Error {
  readonly code: WorkspaceV3ValidationCode;
  readonly sampleIndex?: number;
  readonly dataPath?: string;
  override readonly cause?: unknown;

  constructor(
    code: WorkspaceV3ValidationCode,
    message: string,
    details: { readonly sampleIndex?: number; readonly dataPath?: string; readonly cause?: unknown } = {},
  ) {
    super(`Invalid GateLab workspace v3: ${message}`);
    this.name = "WorkspaceV3ValidationError";
    this.code = code;
    this.sampleIndex = details.sampleIndex;
    this.dataPath = details.dataPath;
    this.cause = details.cause;
  }
}

function invalid(
  code: WorkspaceV3ValidationCode,
  message: string,
  details: { readonly sampleIndex?: number; readonly dataPath?: string; readonly cause?: unknown } = {},
): never {
  throw new WorkspaceV3ValidationError(code, message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function assertObjectKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[],
  label: string,
  code: WorkspaceV3ValidationCode,
  details: { readonly sampleIndex?: number; readonly dataPath?: string } = {},
): void {
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    invalid(
      code,
      `${label} has an invalid field set.` +
        (missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "") +
        (extra.length > 0 ? ` Unexpected: ${extra.join(", ")}.` : ""),
      details,
    );
  }
}

function cloneJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (cause) {
    invalid("invalid-workspace-v3", "workspace state must be JSON-serializable.", { cause });
  }
}

const WORKSPACE_V3_REQUIRED_KEYS = [
  "format",
  "version",
  "savedAt",
  "app",
  "samples",
  "activeSample",
  "gating",
  "scales",
  "display",
  "compensation",
] as const;

const WORKSPACE_V3_ALLOWED_KEYS = [
  ...WORKSPACE_V3_REQUIRED_KEYS,
  "workspaceId",
  "illustration",
  "illustrationPresets",
  "metadataColumns",
  "populationMetadata",
  "populationMetaColumns",
] as const;

const SAMPLE_V3_REQUIRED_KEYS = ["fileName", "dataPath", "logicleW", "assay"] as const;
const SAMPLE_V3_ALLOWED_KEYS = [
  ...SAMPLE_V3_REQUIRED_KEYS,
  "scatterCofactor",
  "cytofCofactor",
  "instrumentMode",
  "labels",
  "metadata",
  "division",
] as const;

/**
 * Convert an already validated v2 workspace without changing any non-compensation JSON value.
 * Legacy compensated state is intentionally blocked until FCS-assisted reconstruction exists.
 */
export function migrateWorkspaceV2ToV3(workspace: WorkspaceFile): WorkspaceFileV3 {
  validateWorkspace(workspace);
  const cloned = cloneJson(workspace);
  const samples: WorkspaceSampleV3[] = cloned.samples.map((sample, index) => {
    let assay: SampleAssayBinding;
    try {
      assay = migrateLegacySampleAssayBinding(sample.compensationOn);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      invalid(
        "unsafe-legacy-compensation",
        `sample ${index + 1} cannot be migrated safely: ${detail}`,
        { sampleIndex: index, dataPath: sample.dataPath, cause },
      );
    }
    const { compensationOn: _legacyCompensationOn, ...rest } = sample;
    return { ...rest, assay };
  });
  const { version: _legacyVersion, samples: _legacySamples, ...rest } = cloned;
  return {
    ...rest,
    version: WORKSPACE_VERSION_3,
    samples,
    compensation: {
      schema: WORKSPACE_COMPENSATION_SCHEMA,
      lineages: [],
    },
  };
}

/**
 * Validate a v3 workspace and, for every retained compensated layer, prove that the freshly
 * parsed FCS identity mapping can reconstruct the exact persisted scientific state.
 */
export async function validateWorkspaceV3(
  untrusted: unknown,
  sampleContexts: WorkspaceV3SampleRestoreContexts = {},
): Promise<WorkspaceFileV3> {
  if (!isRecord(untrusted) || untrusted.format !== WORKSPACE_FORMAT) {
    invalid("unrecognized-workspace", "unrecognized workspace format.");
  }
  if (untrusted.version !== WORKSPACE_VERSION_3) {
    invalid(
      "unsupported-workspace-version",
      `expected version 3 but found '${String(untrusted.version)}'.`,
    );
  }
  assertObjectKeys(
    untrusted,
    WORKSPACE_V3_REQUIRED_KEYS,
    WORKSPACE_V3_ALLOWED_KEYS,
    "workspace",
    "invalid-workspace-v3",
  );
  if (typeof untrusted.savedAt !== "string" || typeof untrusted.app !== "string") {
    invalid("invalid-workspace-v3", "savedAt and app must be strings.");
  }
  if (!Array.isArray(untrusted.samples)) {
    invalid("invalid-workspace-v3", "samples must be an array.");
  }
  for (let index = 0; index < untrusted.samples.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(untrusted.samples, index)) {
      invalid("invalid-workspace-v3", "samples must not contain sparse entries.");
    }
  }

  const cloned = cloneJson(untrusted) as Record<string, unknown>;
  const rawSamples = cloned.samples as unknown[];
  const sampleParts: Array<{ common: Omit<WorkspaceSampleV3, "assay">; assay: unknown }> = [];
  for (let index = 0; index < rawSamples.length; index++) {
    if (!isRecord(rawSamples[index])) {
      invalid("invalid-workspace-sample", `sample ${index + 1} must be an object.`, {
        sampleIndex: index,
      });
    }
    const sample = rawSamples[index] as Record<string, unknown>;
    const dataPath = typeof sample.dataPath === "string" ? sample.dataPath : undefined;
    assertObjectKeys(
      sample,
      SAMPLE_V3_REQUIRED_KEYS,
      SAMPLE_V3_ALLOWED_KEYS,
      `sample ${index + 1}`,
      "invalid-workspace-sample",
      { sampleIndex: index, dataPath },
    );
    const { assay, ...common } = sample;
    sampleParts.push({
      common: common as unknown as Omit<WorkspaceSampleV3, "assay">,
      assay,
    });
  }

  const { compensation: _compensation, version: _version, samples: _samples, ...commonWorkspace } =
    cloned;
  const v2Surrogate = {
    ...commonWorkspace,
    version: 2,
    samples: sampleParts.map(({ common }) => ({ ...common, compensationOn: false })),
  } as WorkspaceFile;
  try {
    validateWorkspace(v2Surrogate);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    invalid("invalid-workspace-v3", detail, { cause });
  }

  let compensation: Awaited<ReturnType<typeof validateWorkspaceCompensationState>>;
  try {
    compensation = await validateWorkspaceCompensationState(cloned.compensation);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    invalid("invalid-compensation-state", detail, { cause });
  }

  const samples: WorkspaceSampleV3[] = sampleParts.map(({ common, assay }, index) => {
    const context = sampleContexts[common.dataPath];
    if (
      context &&
      (common.instrumentMode === "flow" || common.instrumentMode === "cytof") &&
      context.instrumentKind !== common.instrumentMode
    ) {
      invalid(
        "invalid-sample-assay",
        `sample ${index + 1} context says ${context.instrumentKind} but its persisted instrument override is ${common.instrumentMode}.`,
        { sampleIndex: index, dataPath: common.dataPath },
      );
    }
    let canonicalAssay: SampleAssayBinding;
    try {
      canonicalAssay = validateSampleAssayBinding(
        assay,
        compensation,
        context
          ? {
              sampleChannels: context.sampleChannels,
              instrumentKind: context.instrumentKind,
              expectedCytofCofactor: common.cytofCofactor ?? 5,
            }
          : {},
      );
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      invalid("invalid-sample-assay", `sample ${index + 1}: ${detail}`, {
        sampleIndex: index,
        dataPath: common.dataPath,
        cause,
      });
    }
    return { ...common, assay: canonicalAssay };
  });

  return {
    ...(commonWorkspace as unknown as Omit<WorkspaceFileV3, "version" | "samples" | "compensation">),
    version: WORKSPACE_VERSION_3,
    samples,
    compensation,
  };
}

/** Exact version dispatcher for migration and future-version rejection. */
export async function migrateWorkspaceToV3(
  raw: unknown,
  sampleContexts: WorkspaceV3SampleRestoreContexts = {},
): Promise<WorkspaceFileV3> {
  if (!isRecord(raw) || raw.format !== WORKSPACE_FORMAT) {
    invalid("unrecognized-workspace", "unrecognized workspace format.");
  }
  if (raw.version === WORKSPACE_VERSION_3) {
    return validateWorkspaceV3(raw, sampleContexts);
  }
  if (raw.version !== 1 && raw.version !== 2) {
    invalid(
      "unsupported-workspace-version",
      `unsupported workspace version '${String(raw.version)}'; GateLab supports migration through version 3.`,
    );
  }
  let v2: WorkspaceFile;
  try {
    v2 = migrateWorkspaceToV2(raw);
    validateWorkspace(v2);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    invalid("invalid-workspace-v3", `legacy workspace is invalid: ${detail}`, { cause });
  }
  return validateWorkspaceV3(migrateWorkspaceV2ToV3(v2));
}

export function newEmptyWorkspaceCompensationState(): WorkspaceCompensationState {
  return Object.freeze({
    schema: WORKSPACE_COMPENSATION_SCHEMA,
    lineages: Object.freeze([]),
  });
}

export function newOriginalWorkspaceSampleAssay(): SampleAssayBinding {
  return createOriginalSampleAssayBinding();
}

function assertPackableV3(workspace: WorkspaceFileV3): void {
  if (
    workspace?.format !== WORKSPACE_FORMAT ||
    workspace.version !== WORKSPACE_VERSION_3 ||
    !Array.isArray(workspace.samples) ||
    workspace.samples.length === 0 ||
    workspace.compensation?.schema !== WORKSPACE_COMPENSATION_SCHEMA
  ) {
    throw new Error("Invalid GateLab workspace v3: cannot pack malformed state.");
  }
}

/** Pack an already validated v3 workspace and its original FCS byte sources. */
export function packWorkspaceV3(
  workspace: WorkspaceFileV3,
  fcsByPath: Record<string, Uint8Array>,
  gatingMLXml?: string,
): Uint8Array {
  assertPackableV3(workspace);
  const files: Record<string, Uint8Array> = {
    "workspace.json": strToU8(JSON.stringify(workspace, null, 2)),
  };
  for (const sample of workspace.samples) {
    const bytes = fcsByPath[sample.dataPath];
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(
        `Invalid GateLab workspace v3: bundled FCS data is missing for "${sample.fileName}" (${sample.dataPath}).`,
      );
    }
    files[sample.dataPath] = bytes;
  }
  if (gatingMLXml) files["gates.gatingml.xml"] = strToU8(gatingMLXml);
  return zipSync(files, { level: 6 });
}

export function packWorkspaceV3Reference(workspace: WorkspaceFileV3): Uint8Array {
  assertPackableV3(workspace);
  return strToU8(JSON.stringify(workspace, null, 2));
}

export function packWorkspaceV3ForStorage(
  workspace: WorkspaceFileV3,
  fcsByPath: Record<string, Uint8Array>,
  storage: WorkspaceStorage,
  gatingMLXml?: string,
): Uint8Array {
  return storage === "bundle"
    ? packWorkspaceV3(workspace, fcsByPath, gatingMLXml)
    : packWorkspaceV3Reference(workspace);
}
