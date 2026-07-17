import { invertMatrix } from "./compensation";

export const COMPENSATION_MATRIX_SCHEMA = "gatelab.compensation-matrix.v1" as const;
export const COMPENSATION_PROFILE_SCHEMA = "gatelab.compensation-profile.v1" as const;
export const COMPENSATION_MATRIX_ORIENTATION =
  "source-rows-receiver-columns" as const;

const DIAGONAL_TOLERANCE = 1e-8;
const ILL_CONDITIONED_THRESHOLD = 1e8;
const textEncoder = new TextEncoder();

export type CompensationKind = "flow-spillover" | "cytof-spillover";
export type CompensationMethod = "matrix-inverse" | "nnls";
export type Sha256Digest = `sha256:${string}`;
export type SolverSettingValue = string | number | boolean;

export interface FlowSolverSettingsInput {
  readonly singularTolerance: number;
  readonly conditionWarningThreshold: number;
}

export interface NnlsSolverSettingsInput {
  readonly tolerance: number;
  readonly kktTolerance: number;
  readonly maxIterations: number;
  readonly adaptationVersion: string;
}

export type SolverSettingsInput = FlowSolverSettingsInput | NnlsSolverSettingsInput;

export interface CompensationMatrixInput {
  readonly sourceChannels: readonly string[];
  readonly receiverChannels: readonly string[];
  readonly matrix: readonly (readonly number[])[];
}

export interface CanonicalCompensationMatrix {
  readonly schema: typeof COMPENSATION_MATRIX_SCHEMA;
  readonly orientation: typeof COMPENSATION_MATRIX_ORIENTATION;
  readonly sourceChannels: readonly string[];
  readonly receiverChannels: readonly string[];
  readonly matrix: readonly (readonly number[])[];
}

export type MatrixValidationCode =
  | "empty-source-channels"
  | "empty-receiver-channels"
  | "invalid-matrix-input"
  | "invalid-channel-axis"
  | "invalid-channel-type"
  | "invalid-matrix-row"
  | "blank-channel"
  | "duplicate-channel"
  | "matrix-row-count"
  | "matrix-column-count"
  | "non-finite-coefficient"
  | "negative-coefficient"
  | "coefficient-over-one"
  | "flow-matrix-not-square"
  | "flow-channel-set-mismatch"
  | "source-missing-receiver"
  | "non-unit-diagonal"
  | "singular-matrix"
  | "ill-conditioned-matrix";

export interface MatrixValidationIssue {
  readonly code: MatrixValidationCode;
  readonly message: string;
  readonly sourceChannel?: string;
  readonly receiverChannel?: string;
  readonly row?: number;
  readonly column?: number;
}

export interface MatrixDiagnostics {
  readonly sourceCount: number;
  readonly receiverCount: number;
  readonly isSquare: boolean;
  readonly coefficientMin: number | null;
  readonly coefficientMax: number | null;
  readonly conditionEstimate: number | null;
}

export type MatrixValidationResult =
  | {
      readonly ok: true;
      readonly value: CanonicalCompensationMatrix;
      readonly errors: readonly [];
      readonly warnings: readonly MatrixValidationIssue[];
      readonly diagnostics: MatrixDiagnostics;
    }
  | {
      readonly ok: false;
      readonly errors: readonly MatrixValidationIssue[];
      readonly warnings: readonly MatrixValidationIssue[];
      readonly diagnostics: MatrixDiagnostics;
    };

export type CompensationProfileHashInput =
  | {
      readonly kind: "flow-spillover";
      readonly method: "matrix-inverse";
      readonly solverVersion: string;
      readonly solverSettings: FlowSolverSettingsInput;
      readonly matrix: CanonicalCompensationMatrix;
    }
  | {
      readonly kind: "cytof-spillover";
      readonly method: "nnls";
      readonly solverVersion: string;
      readonly solverSettings: NnlsSolverSettingsInput;
      readonly matrix: CanonicalCompensationMatrix;
      readonly includedChannels: readonly string[];
    };

export interface CanonicalSolverSetting {
  readonly key: string;
  readonly value: SolverSettingValue;
}

export interface CanonicalCompensationProfileHashInput {
  readonly schema: typeof COMPENSATION_PROFILE_SCHEMA;
  readonly kind: CompensationKind;
  readonly method: CompensationMethod;
  readonly solverVersion: string;
  readonly solverSettings: readonly CanonicalSolverSetting[];
  readonly matrix: CanonicalCompensationMatrix;
  readonly includedChannels: readonly string[];
}

function normalizeChannel(channel: string): string {
  return channel.trim().normalize("NFC");
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const delta = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

function duplicateChannels(channels: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const channel of channels) {
    if (seen.has(channel)) duplicates.add(channel);
    seen.add(channel);
  }
  return duplicates;
}

function infinityNorm(matrix: readonly (readonly number[])[]): number {
  let norm = 0;
  for (const row of matrix) {
    let sum = 0;
    for (const value of row) sum += Math.abs(value);
    norm = Math.max(norm, sum);
  }
  return norm;
}

function conditionEstimate(matrix: readonly (readonly number[])[]): number | null {
  const mutable = matrix.map((row) => Array.from(row));
  const inverse = invertMatrix(mutable);
  if (!inverse) return null;
  return infinityNorm(matrix) * infinityNorm(inverse);
}

function issue(
  code: MatrixValidationCode,
  message: string,
  details: Omit<MatrixValidationIssue, "code" | "message"> = {},
): MatrixValidationIssue {
  return Object.freeze({ code, message, ...details });
}

function freezeCanonicalMatrix(
  sourceChannels: string[],
  receiverChannels: string[],
  matrix: number[][],
): CanonicalCompensationMatrix {
  const frozenRows = matrix.map((row) => Object.freeze(Array.from(row)));
  return Object.freeze({
    schema: COMPENSATION_MATRIX_SCHEMA,
    orientation: COMPENSATION_MATRIX_ORIENTATION,
    sourceChannels: Object.freeze(Array.from(sourceChannels)),
    receiverChannels: Object.freeze(Array.from(receiverChannels)),
    matrix: Object.freeze(frozenRows),
  });
}

export function validateAndCanonicalizeCompensationMatrix(
  input: CompensationMatrixInput,
  kind: CompensationKind,
): MatrixValidationResult {
  const errors: MatrixValidationIssue[] = [];
  const warnings: MatrixValidationIssue[] = [];
  const rawInput =
    input != null && typeof input === "object"
      ? (input as unknown as Record<string, unknown>)
      : {};
  if (input == null || typeof input !== "object") {
    errors.push(issue("invalid-matrix-input", "Compensation matrix input must be an object."));
  }

  const rawSources = Array.isArray(rawInput.sourceChannels)
    ? rawInput.sourceChannels
    : [];
  const rawReceivers = Array.isArray(rawInput.receiverChannels)
    ? rawInput.receiverChannels
    : [];
  const rawRows = Array.isArray(rawInput.matrix) ? rawInput.matrix : [];
  if (!Array.isArray(rawInput.sourceChannels)) {
    errors.push(issue("invalid-channel-axis", "sourceChannels must be an array."));
  }
  if (!Array.isArray(rawInput.receiverChannels)) {
    errors.push(issue("invalid-channel-axis", "receiverChannels must be an array."));
  }
  if (!Array.isArray(rawInput.matrix)) {
    errors.push(issue("invalid-matrix-input", "matrix must be an array of rows."));
  }

  const normalizeAxis = (values: unknown[], axis: "source" | "receiver") =>
    values.map((value, index) => {
      if (typeof value !== "string") {
        errors.push(
          issue("invalid-channel-type", `${axis} channel ${index + 1} must be a string.`,
            axis === "source" ? { row: index } : { column: index }),
        );
        return "";
      }
      return normalizeChannel(value);
    });
  const sources = normalizeAxis(rawSources, "source");
  const receivers = normalizeAxis(rawReceivers, "receiver");
  const copiedMatrix: number[][] = rawRows.map((row, rowIndex) => {
    if (!Array.isArray(row)) {
      errors.push(
        issue("invalid-matrix-row", `Matrix row ${rowIndex + 1} must be an array.`, {
          row: rowIndex,
        }),
      );
      return [];
    }
    return Array.from(row) as number[];
  });

  if (sources.length === 0) {
    errors.push(issue("empty-source-channels", "At least one source channel is required."));
  }
  if (receivers.length === 0) {
    errors.push(issue("empty-receiver-channels", "At least one receiver channel is required."));
  }

  for (const [axis, channels] of [
    ["source", sources],
    ["receiver", receivers],
  ] as const) {
    for (let index = 0; index < channels.length; index++) {
      if (channels[index].length === 0) {
        errors.push(
          issue("blank-channel", `${axis} channel ${index + 1} is blank after trimming.`,
            axis === "source" ? { row: index } : { column: index }),
        );
      }
    }
    for (const channel of duplicateChannels(channels)) {
      errors.push(
        issue("duplicate-channel", `Duplicate ${axis} channel '${channel}'.`,
          axis === "source" ? { sourceChannel: channel } : { receiverChannel: channel }),
      );
    }
  }

  if (copiedMatrix.length !== sources.length) {
    errors.push(
      issue(
        "matrix-row-count",
        `Matrix has ${copiedMatrix.length} rows but ${sources.length} source channels.`,
      ),
    );
  }

  let coefficientMin = Number.POSITIVE_INFINITY;
  let coefficientMax = Number.NEGATIVE_INFINITY;
  for (let row = 0; row < copiedMatrix.length; row++) {
    if (copiedMatrix[row].length !== receivers.length) {
      errors.push(
        issue(
          "matrix-column-count",
          `Matrix row ${row + 1} has ${copiedMatrix[row].length} values but ${receivers.length} receiver channels.`,
          { row },
        ),
      );
    }
    for (let column = 0; column < copiedMatrix[row].length; column++) {
      const value = copiedMatrix[row][column];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(
          issue("non-finite-coefficient", "Matrix coefficients must be finite numbers.", {
            row,
            column,
            sourceChannel: sources[row],
            receiverChannel: receivers[column],
          }),
        );
        continue;
      }
      coefficientMin = Math.min(coefficientMin, value);
      coefficientMax = Math.max(coefficientMax, value);
      if (value < 0) {
        errors.push(
          issue("negative-coefficient", "Negative spillover coefficients are not supported.", {
            row,
            column,
            sourceChannel: sources[row],
            receiverChannel: receivers[column],
          }),
        );
      }
      if (value > 1) {
        const entry = issue(
          "coefficient-over-one",
          kind === "flow-spillover"
            ? "This flow coefficient exceeds 100%; review it carefully and confirm the file uses fractional values."
            : "CyTOF coefficients must be within the fractional range 0–1.",
          {
            row,
            column,
            sourceChannel: sources[row],
            receiverChannel: receivers[column],
          },
        );
        if (kind === "flow-spillover") warnings.push(entry);
        else errors.push(entry);
      }
    }
  }

  const sourceSet = new Set(sources);
  const receiverSet = new Set(receivers);
  const isSquare = sources.length > 0 && sources.length === receivers.length;
  if (kind === "flow-spillover") {
    if (!isSquare) {
      errors.push(
        issue("flow-matrix-not-square", "Conventional-flow spillover matrices must be square."),
      );
    }
    if (
      sourceSet.size !== receiverSet.size ||
      sources.some((channel) => !receiverSet.has(channel)) ||
      receivers.some((channel) => !sourceSet.has(channel))
    ) {
      errors.push(
        issue(
          "flow-channel-set-mismatch",
          "Flow source and receiver channel identities must be the same set.",
        ),
      );
    }
  }

  for (let row = 0; row < sources.length; row++) {
    const receiverColumn = receivers.indexOf(sources[row]);
    if (receiverColumn < 0) {
      errors.push(
        issue(
          "source-missing-receiver",
          `Source channel '${sources[row]}' has no matching receiver column.`,
          { row, sourceChannel: sources[row] },
        ),
      );
      continue;
    }
    const diagonal = copiedMatrix[row]?.[receiverColumn];
    if (Number.isFinite(diagonal) && Math.abs(diagonal - 1) > DIAGONAL_TOLERANCE) {
      errors.push(
        issue(
          "non-unit-diagonal",
          `Diagonal coefficient for '${sources[row]}' must equal 1.`,
          {
            row,
            column: receiverColumn,
            sourceChannel: sources[row],
            receiverChannel: sources[row],
          },
        ),
      );
    }
  }

  let estimatedCondition: number | null = null;
  const dimensionsValid =
    copiedMatrix.length === sources.length &&
    copiedMatrix.every((row) => row.length === receivers.length);
  const coefficientsFinite = copiedMatrix.every((row) => row.every(Number.isFinite));
  if (kind === "flow-spillover" && isSquare && dimensionsValid && coefficientsFinite) {
    estimatedCondition = conditionEstimate(copiedMatrix);
    if (estimatedCondition == null) {
      errors.push(issue("singular-matrix", "The flow spillover matrix is singular."));
    } else if (estimatedCondition > ILL_CONDITIONED_THRESHOLD) {
      warnings.push(
        issue(
          "ill-conditioned-matrix",
          `The estimated matrix condition number is ${estimatedCondition.toExponential(3)}; preview and Apply require careful review.`,
        ),
      );
    }
  }

  const diagnostics: MatrixDiagnostics = Object.freeze({
    sourceCount: sources.length,
    receiverCount: receivers.length,
    isSquare,
    coefficientMin: coefficientMin === Number.POSITIVE_INFINITY ? null : coefficientMin,
    coefficientMax: coefficientMax === Number.NEGATIVE_INFINITY ? null : coefficientMax,
    conditionEstimate: estimatedCondition,
  });

  if (errors.length > 0) {
    return Object.freeze({
      ok: false,
      errors: Object.freeze(errors),
      warnings: Object.freeze(warnings),
      diagnostics,
    });
  }

  const sourceOrder = sources
    .map((channel, index) => ({ channel, index }))
    .sort((left, right) => compareCodePoints(left.channel, right.channel));
  const receiverOrder = receivers
    .map((channel, index) => ({ channel, index }))
    .sort((left, right) => compareCodePoints(left.channel, right.channel));
  const canonical = freezeCanonicalMatrix(
    sourceOrder.map(({ channel }) => channel),
    receiverOrder.map(({ channel }) => channel),
    sourceOrder.map(({ index: row }) =>
      receiverOrder.map(({ index: column }) => copiedMatrix[row][column]),
    ),
  );

  return Object.freeze({
    ok: true,
    value: canonical,
    errors: Object.freeze([]) as readonly [],
    warnings: Object.freeze(warnings),
    diagnostics,
  });
}

function float64Hex(value: number): string {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, Object.is(value, -0) ? 0 : value, false);
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertCanonicalCompensationMatrix(
  matrix: CanonicalCompensationMatrix,
): void {
  const candidate = matrix as unknown as Record<string, unknown>;
  if (candidate.schema !== COMPENSATION_MATRIX_SCHEMA) {
    throw new Error(`Unsupported compensation matrix schema '${String(candidate.schema)}'.`);
  }
  if (candidate.orientation !== COMPENSATION_MATRIX_ORIENTATION) {
    throw new Error(`Unsupported compensation matrix orientation '${String(candidate.orientation)}'.`);
  }
  if (
    !Array.isArray(candidate.sourceChannels) ||
    !Array.isArray(candidate.receiverChannels) ||
    !Array.isArray(candidate.matrix)
  ) {
    throw new Error("Canonical compensation matrix arrays are missing.");
  }

  const sources = candidate.sourceChannels as unknown[];
  const receivers = candidate.receiverChannels as unknown[];
  const rows = candidate.matrix as unknown[];
  if (sources.length === 0 || receivers.length === 0) {
    throw new Error("Canonical compensation matrix axes must not be empty.");
  }
  if (
    sources.some((channel) => typeof channel !== "string") ||
    receivers.some((channel) => typeof channel !== "string")
  ) {
    throw new Error("Canonical compensation matrix channels must be strings.");
  }
  const sourceChannels = sources as string[];
  const receiverChannels = receivers as string[];
  const sourceNormalized = sourceChannels.map(normalizeChannel);
  const receiverNormalized = receiverChannels.map(normalizeChannel);
  if (
    sourceChannels.some((channel) => channel.length === 0) ||
    receiverChannels.some((channel) => channel.length === 0) ||
    sourceChannels.some((channel, index) => channel !== sourceNormalized[index]) ||
    receiverChannels.some((channel, index) => channel !== receiverNormalized[index]) ||
    duplicateChannels(sourceChannels).size > 0 ||
    duplicateChannels(receiverChannels).size > 0 ||
    sourceChannels.some((channel, index) => index > 0 && compareCodePoints(sourceChannels[index - 1], channel) >= 0) ||
    receiverChannels.some((channel, index) => index > 0 && compareCodePoints(receiverChannels[index - 1], channel) >= 0)
  ) {
    throw new Error("Compensation matrix channel axes are not canonical.");
  }
  if (rows.length !== sourceChannels.length) {
    throw new Error("Canonical compensation matrix row count does not match its source axis.");
  }
  for (let row = 0; row < rows.length; row++) {
    const rawRow = rows[row];
    if (!Array.isArray(rawRow) || rawRow.length !== receiverChannels.length) {
      throw new Error(`Canonical compensation matrix row ${row + 1} has the wrong length.`);
    }
    const values = rawRow as unknown[];
    for (let column = 0; column < values.length; column++) {
      const value = values[column];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`Canonical compensation matrix coefficient [${row},${column}] is invalid.`);
      }
    }
    const diagonalColumn = receiverChannels.indexOf(sourceChannels[row]);
    if (
      diagonalColumn < 0 ||
      Math.abs((values[diagonalColumn] as number) - 1) > DIAGONAL_TOLERANCE
    ) {
      throw new Error(`Canonical compensation matrix diagonal for '${sourceChannels[row]}' is invalid.`);
    }
  }
}

export function serializeCanonicalCompensationMatrix(
  matrix: CanonicalCompensationMatrix,
): string {
  assertCanonicalCompensationMatrix(matrix);
  return JSON.stringify({
    schema: COMPENSATION_MATRIX_SCHEMA,
    orientation: COMPENSATION_MATRIX_ORIENTATION,
    sourceChannels: matrix.sourceChannels,
    receiverChannels: matrix.receiverChannels,
    matrixHex: matrix.matrix.map((row) => row.map(float64Hex)),
  });
}

async function sha256(value: string): Promise<Sha256Digest> {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "SHA-256 profile hashing requires Web Crypto in a secure browser context (HTTPS or localhost).",
    );
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}

export async function hashCompensationMatrix(
  matrix: CanonicalCompensationMatrix,
): Promise<Sha256Digest> {
  return sha256(serializeCanonicalCompensationMatrix(matrix));
}

function canonicalizeUniqueChannels(channels: readonly string[], label: string): string[] {
  if (!Array.isArray(channels) || channels.some((channel) => typeof channel !== "string")) {
    throw new Error(`${label} must be an array of channel strings.`);
  }
  const normalized = channels.map(normalizeChannel);
  if (normalized.some((channel) => channel.length === 0)) {
    throw new Error(`${label} must not contain blank channels.`);
  }
  if (duplicateChannels(normalized).size > 0) {
    throw new Error(`${label} must contain unique channels.`);
  }
  return normalized.sort(compareCodePoints);
}

function canonicalizeSolverSettings(
  settings: SolverSettingsInput,
  method: CompensationMethod,
): CanonicalSolverSetting[] {
  if (settings == null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("solverSettings must be an object.");
  }
  const canonical: CanonicalSolverSetting[] = [];
  const normalizedKeys = new Set<string>();
  for (const [rawKey, rawValue] of Object.entries(settings)) {
    const key = rawKey.trim().normalize("NFC");
    if (!key) throw new Error("solverSettings keys must not be blank.");
    if (normalizedKeys.has(key)) {
      throw new Error(`Duplicate solverSettings key '${key}' after normalization.`);
    }
    normalizedKeys.add(key);
    let value: SolverSettingValue;
    if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue)) {
        throw new Error(`solverSettings '${key}' must be finite.`);
      }
      value = Object.is(rawValue, -0) ? 0 : rawValue;
    } else if (typeof rawValue === "string") {
      value = rawValue.trim().normalize("NFC");
    } else if (typeof rawValue === "boolean") {
      value = rawValue;
    } else {
      throw new Error(`solverSettings '${key}' has an unsupported value.`);
    }
    canonical.push(Object.freeze({ key, value }));
  }
  canonical.sort((left, right) => compareCodePoints(left.key, right.key));

  const expectedKeys =
    method === "matrix-inverse"
      ? ["conditionWarningThreshold", "singularTolerance"]
      : ["adaptationVersion", "kktTolerance", "maxIterations", "tolerance"];
  const actualKeys = canonical.map(({ key }) => key);
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  const extra = actualKeys.filter((key) => !expectedKeys.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${method} solverSettings require exactly [${expectedKeys.join(", ")}].` +
        (missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "") +
        (extra.length > 0 ? ` Unexpected: ${extra.join(", ")}.` : ""),
    );
  }

  const valueFor = (key: string) => canonical.find((entry) => entry.key === key)!.value;
  if (method === "matrix-inverse") {
    const singularTolerance = valueFor("singularTolerance");
    const conditionWarningThreshold = valueFor("conditionWarningThreshold");
    if (
      typeof singularTolerance !== "number" ||
      singularTolerance <= 0 ||
      typeof conditionWarningThreshold !== "number" ||
      conditionWarningThreshold < 1
    ) {
      throw new Error(
        "matrix-inverse tolerances must be positive and conditionWarningThreshold must be at least 1.",
      );
    }
  } else {
    const tolerance = valueFor("tolerance");
    const kktTolerance = valueFor("kktTolerance");
    const maxIterations = valueFor("maxIterations");
    const adaptationVersion = valueFor("adaptationVersion");
    if (
      typeof tolerance !== "number" ||
      tolerance <= 0 ||
      typeof kktTolerance !== "number" ||
      kktTolerance <= 0 ||
      typeof maxIterations !== "number" ||
      !Number.isInteger(maxIterations) ||
      maxIterations <= 0 ||
      typeof adaptationVersion !== "string" ||
      adaptationVersion.length === 0
    ) {
      throw new Error(
        "NNLS tolerances must be positive, maxIterations must be a positive integer, and adaptationVersion is required.",
      );
    }
  }
  return canonical;
}

function serializeCanonicalSolverSettings(
  settings: readonly CanonicalSolverSetting[],
): readonly (readonly [string, "boolean" | "number" | "string", boolean | string])[] {
  return settings.map(({ key, value }) => {
    if (typeof value === "number") return [key, "number", float64Hex(value)] as const;
    if (typeof value === "boolean") return [key, "boolean", value] as const;
    return [key, "string", value] as const;
  });
}

export function canonicalizeCompensationProfileHashInput(
  input: CompensationProfileHashInput,
): CanonicalCompensationProfileHashInput {
  const runtimeInput = input as unknown as Record<string, unknown>;
  if (runtimeInput.kind !== "flow-spillover" && runtimeInput.kind !== "cytof-spillover") {
    throw new Error(`Unsupported compensation kind '${String(runtimeInput.kind)}'.`);
  }
  const expectedMethod =
    runtimeInput.kind === "flow-spillover" ? "matrix-inverse" : "nnls";
  if (runtimeInput.method !== expectedMethod) {
    throw new Error(
      `${runtimeInput.kind} profiles require the '${expectedMethod}' method.`,
    );
  }
  if (runtimeInput.matrix == null || typeof runtimeInput.matrix !== "object") {
    throw new Error("A canonical compensation matrix is required.");
  }
  const suppliedMatrix = runtimeInput.matrix as CanonicalCompensationMatrix;
  assertCanonicalCompensationMatrix(suppliedMatrix);
  const matrixValidation = validateAndCanonicalizeCompensationMatrix(
    suppliedMatrix,
    runtimeInput.kind,
  );
  if (!matrixValidation.ok) {
    throw new Error(
      `Compensation matrix is invalid for ${runtimeInput.kind}: ${matrixValidation.errors
        .map(({ message }) => message)
        .join(" ")}`,
    );
  }

  if (typeof runtimeInput.solverVersion !== "string") {
    throw new Error("solverVersion must be a string.");
  }
  const solverVersion = runtimeInput.solverVersion.trim().normalize("NFC");
  if (!solverVersion) throw new Error("solverVersion is required.");
  const solverSettings = canonicalizeSolverSettings(
    runtimeInput.solverSettings as SolverSettingsInput,
    expectedMethod,
  );
  const includedChannels =
    input.kind === "cytof-spillover"
      ? canonicalizeUniqueChannels(
          Array.isArray(input.includedChannels) ? input.includedChannels : [],
          "includedChannels",
        )
      : [];
  if (input.kind === "cytof-spillover" && includedChannels.length === 0) {
    throw new Error("CyTOF profiles require at least one included channel.");
  }
  const receiverSet = new Set(matrixValidation.value.receiverChannels);
  for (const channel of includedChannels) {
    if (!receiverSet.has(channel)) {
      throw new Error(`Included channel '${channel}' is not a matrix receiver channel.`);
    }
  }

  return Object.freeze({
    schema: COMPENSATION_PROFILE_SCHEMA,
    kind: input.kind,
    method: input.method,
    solverVersion,
    solverSettings: Object.freeze(solverSettings),
    matrix: matrixValidation.value,
    includedChannels: Object.freeze(includedChannels),
  });
}

export async function hashCompensationProfile(
  input: CompensationProfileHashInput,
): Promise<Sha256Digest> {
  const canonical = canonicalizeCompensationProfileHashInput(input);
  const matrixHash = await hashCompensationMatrix(canonical.matrix);
  return sha256(
    JSON.stringify({
      schema: canonical.schema,
      kind: canonical.kind,
      method: canonical.method,
      solverVersion: canonical.solverVersion,
      solverSettings: serializeCanonicalSolverSettings(canonical.solverSettings),
      matrixHash,
      includedChannels: canonical.includedChannels,
    }),
  );
}
