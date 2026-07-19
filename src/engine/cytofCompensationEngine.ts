import {
  serializeCanonicalCompensationMatrix,
  type CanonicalCompensationMatrix,
  type NnlsSolverSettingsInput,
} from "./compensationProfile";

export const CYTOF_NNLS_SOLVER_VERSION = "coordinate-descent-qr-v1" as const;
export const CYTOF_MATRIX_ADAPTATION_VERSION = "identity-backed-v1" as const;

export const DEFAULT_CYTOF_NNLS_SETTINGS: Readonly<NnlsSolverSettingsInput> =
  Object.freeze({
    tolerance: 1e-10,
    kktTolerance: 1e-9,
    maxIterations: 1000,
    adaptationVersion: CYTOF_MATRIX_ADAPTATION_VERSION,
  });

export type CytofCompensationErrorCode =
  | "dimension-mismatch"
  | "invalid-matrix"
  | "invalid-settings"
  | "rank-deficient-active-set"
  | "non-convergence"
  | "non-finite-input"
  | "non-finite-output";

export class CytofCompensationError extends Error {
  readonly code: CytofCompensationErrorCode;

  constructor(code: CytofCompensationErrorCode, message: string) {
    super(message);
    this.name = "CytofCompensationError";
    this.code = code;
  }
}

export interface CytofNnlsPlanDiagnostics {
  readonly method: "nnls";
  readonly channelCount: number;
  readonly adaptationVersion: string;
  readonly coefficientMin: number;
  readonly coefficientMax: number;
}

export interface CytofNnlsEventDiagnostics {
  readonly iterations: number;
  readonly activeSetSize: number;
  readonly residualNorm: number;
  readonly objective: number;
  readonly kktViolation: number;
  readonly converged: true;
}

export interface CytofNnlsPlan {
  readonly channels: readonly string[];
  /** Identity-backed source-row/receiver-column spillover matrix. */
  readonly matrix: readonly (readonly number[])[];
  /** A = transpose(matrix), used by min ||Ax-u||² with x >= 0. */
  readonly design: readonly (readonly number[])[];
  /** AᵀA, used by the bounded coordinate solver without refactorising per event. */
  readonly gram: readonly (readonly number[])[];
  readonly settings: Readonly<NnlsSolverSettingsInput>;
  readonly diagnostics: CytofNnlsPlanDiagnostics;
}

export interface CytofRangeOptions {
  readonly inputStart?: number;
  readonly inputEnd?: number;
  readonly outputStart?: number;
  readonly validateMeasuredValues?: boolean;
  readonly validateOutputValues?: boolean;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validateSettings(
  settings: NnlsSolverSettingsInput,
): Readonly<NnlsSolverSettingsInput> {
  if (
    !finitePositive(settings.tolerance) ||
    !finitePositive(settings.kktTolerance) ||
    !Number.isSafeInteger(settings.maxIterations) ||
    settings.maxIterations <= 0 ||
    settings.adaptationVersion !== CYTOF_MATRIX_ADAPTATION_VERSION
  ) {
    throw new CytofCompensationError(
      "invalid-settings",
      `CyTOF NNLS requires positive tolerances, a positive integer iteration limit, and adaptation ${CYTOF_MATRIX_ADAPTATION_VERSION}.`,
    );
  }
  return Object.freeze({
    tolerance: settings.tolerance,
    kktTolerance: settings.kktTolerance,
    maxIterations: settings.maxIterations,
    adaptationVersion: settings.adaptationVersion,
  });
}

function assertSquareFiniteMatrix(
  matrix: readonly (readonly number[])[],
  channelCount: number,
): void {
  if (!Array.isArray(matrix) || matrix.length !== channelCount || channelCount === 0) {
    throw new CytofCompensationError(
      "dimension-mismatch",
      "The adapted CyTOF spillover matrix must be non-empty and square.",
    );
  }
  for (let row = 0; row < channelCount; row++) {
    if (!Array.isArray(matrix[row]) || matrix[row].length !== channelCount) {
      throw new CytofCompensationError(
        "dimension-mismatch",
        `Adapted CyTOF spillover row ${row + 1} has the wrong length.`,
      );
    }
    for (let column = 0; column < channelCount; column++) {
      const value = matrix[row][column];
      if (!Number.isFinite(value) || value < 0) {
        throw new CytofCompensationError(
          "invalid-matrix",
          `Adapted CyTOF spillover coefficient [${row + 1}, ${column + 1}] must be finite and non-negative.`,
        );
      }
    }
    if (Math.abs(matrix[row][row] - 1) > 1e-8) {
      throw new CytofCompensationError(
        "invalid-matrix",
        `Adapted CyTOF spillover diagonal ${row + 1} must equal 1.`,
      );
    }
  }
}

/**
 * Match seekit/CATALYST's name-based adaptation for an explicit solve set:
 * start with identity, copy imported source→receiver coefficients when both
 * names are included, and retain identity emitters for receiver-only channels.
 */
export function adaptCytofSpilloverMatrix(
  imported: CanonicalCompensationMatrix,
  includedChannels: readonly string[],
): readonly (readonly number[])[] {
  // This assertion rejects forged schemas/orientations/non-canonical axes.
  serializeCanonicalCompensationMatrix(imported);
  if (!Array.isArray(includedChannels) || includedChannels.length === 0) {
    throw new CytofCompensationError(
      "dimension-mismatch",
      "At least one CyTOF receiver channel must be included in the NNLS solve.",
    );
  }
  const receiverIndex = new Map(
    imported.receiverChannels.map((channel, index) => [channel, index] as const),
  );
  const sourceIndex = new Map(
    imported.sourceChannels.map((channel, index) => [channel, index] as const),
  );
  const seen = new Set<string>();
  for (const channel of includedChannels) {
    if (
      typeof channel !== "string" ||
      channel.length === 0 ||
      channel !== channel.trim().normalize("NFC") ||
      seen.has(channel) ||
      !receiverIndex.has(channel)
    ) {
      throw new CytofCompensationError(
        "dimension-mismatch",
        `CyTOF included channel '${String(channel)}' is blank, duplicated, non-canonical, or absent from the receiver axis.`,
      );
    }
    seen.add(channel);
  }

  const adapted = includedChannels.map((sourceChannel, row) =>
    includedChannels.map((receiverChannel, column) => {
      if (row === column) return 1;
      const importedRow = sourceIndex.get(sourceChannel);
      const importedColumn = receiverIndex.get(receiverChannel)!;
      return importedRow === undefined ? 0 : imported.matrix[importedRow][importedColumn];
    }),
  );
  return Object.freeze(adapted.map((row) => Object.freeze(row)));
}

export function prepareCytofNnls(
  channels: readonly string[],
  matrix: readonly (readonly number[])[],
  settings: NnlsSolverSettingsInput = DEFAULT_CYTOF_NNLS_SETTINGS,
): CytofNnlsPlan {
  if (
    !Array.isArray(channels) ||
    channels.length === 0 ||
    channels.some((channel) => typeof channel !== "string" || channel.length === 0) ||
    new Set(channels).size !== channels.length
  ) {
    throw new CytofCompensationError(
      "dimension-mismatch",
      "CyTOF NNLS requires a non-empty, unique channel axis.",
    );
  }
  assertSquareFiniteMatrix(matrix, channels.length);
  const stableSettings = validateSettings(settings);
  const ownedMatrix = Object.freeze(
    matrix.map((row) => Object.freeze(Array.from(row))),
  );
  const design = Object.freeze(
    channels.map((_, receiver) =>
      Object.freeze(channels.map((__, source) => ownedMatrix[source][receiver])),
    ),
  );
  const gram = Object.freeze(
    channels.map((_, leftSource) =>
      Object.freeze(channels.map((__, rightSource) => {
        let value = 0;
        for (let receiver = 0; receiver < channels.length; receiver++) {
          value += design[receiver][leftSource] * design[receiver][rightSource];
        }
        return value;
      })),
    ),
  );
  let coefficientMin = Number.POSITIVE_INFINITY;
  let coefficientMax = Number.NEGATIVE_INFINITY;
  for (const row of ownedMatrix) {
    for (const value of row) {
      coefficientMin = Math.min(coefficientMin, value);
      coefficientMax = Math.max(coefficientMax, value);
    }
  }
  return Object.freeze({
    channels: Object.freeze(Array.from(channels)),
    matrix: ownedMatrix,
    design,
    gram,
    settings: stableSettings,
    diagnostics: Object.freeze({
      method: "nnls" as const,
      channelCount: channels.length,
      adaptationVersion: stableSettings.adaptationVersion,
      coefficientMin,
      coefficientMax,
    }),
  });
}

function dotColumn(
  matrix: readonly (readonly number[])[],
  column: number,
  vector: ArrayLike<number>,
): number {
  let sum = 0;
  for (let row = 0; row < matrix.length; row++) sum += matrix[row][column] * vector[row];
  return sum;
}

/** Householder QR solve for the current active columns; avoids normal equations. */
function solveActiveLeastSquares(
  design: readonly (readonly number[])[],
  measured: ArrayLike<number>,
  activeIndices: readonly number[],
  rankTolerance: number,
): Float64Array {
  const rows = design.length;
  const columns = activeIndices.length;
  const work = Array.from({ length: rows }, (_, row) =>
    Float64Array.from(activeIndices, (source) => design[row][source]),
  );
  const transformed = Float64Array.from(measured);

  for (let column = 0; column < columns; column++) {
    let norm = 0;
    for (let row = column; row < rows; row++) norm = Math.hypot(norm, work[row][column]);
    if (!Number.isFinite(norm) || norm <= rankTolerance) {
      throw new CytofCompensationError(
        "rank-deficient-active-set",
        "The CyTOF NNLS active set is rank deficient at the configured tolerance.",
      );
    }
    const alpha = work[column][column] >= 0 ? -norm : norm;
    const reflector = new Float64Array(rows - column);
    for (let row = column; row < rows; row++) reflector[row - column] = work[row][column];
    reflector[0] -= alpha;
    let reflectorNormSquared = 0;
    for (const value of reflector) reflectorNormSquared += value * value;
    if (!Number.isFinite(reflectorNormSquared) || reflectorNormSquared === 0) {
      throw new CytofCompensationError(
        "rank-deficient-active-set",
        "The CyTOF NNLS QR factorisation could not form a stable reflector.",
      );
    }
    const beta = 2 / reflectorNormSquared;
    for (let targetColumn = column; targetColumn < columns; targetColumn++) {
      let projection = 0;
      for (let row = column; row < rows; row++) {
        projection += reflector[row - column] * work[row][targetColumn];
      }
      projection *= beta;
      for (let row = column; row < rows; row++) {
        work[row][targetColumn] -= projection * reflector[row - column];
      }
    }
    let projectedMeasured = 0;
    for (let row = column; row < rows; row++) {
      projectedMeasured += reflector[row - column] * transformed[row];
    }
    projectedMeasured *= beta;
    for (let row = column; row < rows; row++) {
      transformed[row] -= projectedMeasured * reflector[row - column];
    }
  }

  const solution = new Float64Array(columns);
  for (let row = columns - 1; row >= 0; row--) {
    let rhs = transformed[row];
    for (let column = row + 1; column < columns; column++) {
      rhs -= work[row][column] * solution[column];
    }
    const diagonal = work[row][row];
    if (!Number.isFinite(diagonal) || Math.abs(diagonal) <= rankTolerance) {
      throw new CytofCompensationError(
        "rank-deficient-active-set",
        "The CyTOF NNLS active-set triangular solve is rank deficient.",
      );
    }
    solution[row] = rhs / diagonal;
  }
  return solution;
}

function solveCytofNnlsEventQr(
  plan: CytofNnlsPlan,
  measured: ArrayLike<number>,
  output: Float64Array = new Float64Array(plan.channels.length),
): CytofNnlsEventDiagnostics {
  const count = plan.channels.length;
  if (measured.length !== count || output.length !== count) {
    throw new CytofCompensationError(
      "dimension-mismatch",
      "CyTOF NNLS measured and output vectors must match the plan channel count.",
    );
  }
  for (let index = 0; index < count; index++) {
    if (!Number.isFinite(measured[index])) {
      throw new CytofCompensationError(
        "non-finite-input",
        `CyTOF NNLS input channel ${index + 1} is non-finite.`,
      );
    }
    output[index] = 0;
  }

  const active = new Uint8Array(count);
  const gradient = new Float64Array(count);
  const residual = new Float64Array(count);
  const candidate = new Float64Array(count);
  let measuredScale = 1;
  for (let receiver = 0; receiver < count; receiver++) {
    residual[receiver] = measured[receiver];
    measuredScale = Math.max(measuredScale, Math.abs(measured[receiver]));
  }
  for (let source = 0; source < count; source++) {
    gradient[source] = dotColumn(plan.design, source, residual);
  }
  const kktThreshold = plan.settings.kktTolerance * measuredScale;
  const zeroThreshold = plan.settings.tolerance * measuredScale;
  const rankTolerance = plan.settings.tolerance * Math.max(1, count);
  let iterations = 0;

  while (true) {
    let entering = -1;
    let largestGradient = kktThreshold;
    for (let source = 0; source < count; source++) {
      if (!active[source] && gradient[source] > largestGradient) {
        largestGradient = gradient[source];
        entering = source;
      }
    }
    if (entering < 0) break;
    active[entering] = 1;

    while (true) {
      if (++iterations > plan.settings.maxIterations) {
        throw new CytofCompensationError(
          "non-convergence",
          `CyTOF NNLS exceeded ${plan.settings.maxIterations} active-set iterations.`,
        );
      }
      const activeIndices: number[] = [];
      for (let source = 0; source < count; source++) {
        if (active[source]) activeIndices.push(source);
        candidate[source] = 0;
      }
      const activeSolution = solveActiveLeastSquares(
        plan.design,
        measured,
        activeIndices,
        rankTolerance,
      );
      for (let index = 0; index < activeIndices.length; index++) {
        candidate[activeIndices[index]] = activeSolution[index];
      }

      let allPositive = true;
      for (const source of activeIndices) {
        if (candidate[source] <= zeroThreshold) {
          allPositive = false;
          break;
        }
      }
      if (allPositive) {
        output.set(candidate);
        break;
      }

      let alpha = Number.POSITIVE_INFINITY;
      for (const source of activeIndices) {
        if (candidate[source] <= zeroThreshold) {
          const denominator = output[source] - candidate[source];
          if (denominator > 0) alpha = Math.min(alpha, output[source] / denominator);
        }
      }
      if (!Number.isFinite(alpha)) alpha = 0;
      for (let source = 0; source < count; source++) {
        output[source] += alpha * (candidate[source] - output[source]);
        if (active[source] && output[source] <= zeroThreshold) {
          output[source] = 0;
          active[source] = 0;
        }
      }
    }

    for (let receiver = 0; receiver < count; receiver++) {
      let reconstructed = 0;
      for (let source = 0; source < count; source++) {
        reconstructed += plan.design[receiver][source] * output[source];
      }
      residual[receiver] = measured[receiver] - reconstructed;
    }
    for (let source = 0; source < count; source++) {
      gradient[source] = dotColumn(plan.design, source, residual);
    }
  }

  let residualSquares = 0;
  let kktViolation = 0;
  let activeSetSize = 0;
  for (let receiver = 0; receiver < count; receiver++) residualSquares += residual[receiver] ** 2;
  for (let source = 0; source < count; source++) {
    if (!Number.isFinite(output[source])) {
      throw new CytofCompensationError(
        "non-finite-output",
        `CyTOF NNLS output channel ${source + 1} is non-finite.`,
      );
    }
    if (output[source] < 0 && output[source] >= -zeroThreshold) output[source] = 0;
    if (output[source] < 0) {
      throw new CytofCompensationError(
        "non-finite-output",
        `CyTOF NNLS produced a negative output beyond tolerance in channel ${source + 1}.`,
      );
    }
    if (output[source] > zeroThreshold) {
      activeSetSize++;
      kktViolation = Math.max(kktViolation, Math.abs(gradient[source]));
    } else {
      kktViolation = Math.max(kktViolation, Math.max(0, gradient[source]));
    }
  }
  return Object.freeze({
    iterations,
    activeSetSize,
    residualNorm: Math.sqrt(residualSquares),
    objective: residualSquares,
    kktViolation,
    converged: true as const,
  });
}

/**
 * Solve one event by cyclic coordinate descent on the convex NNLS objective.
 * The fixed AᵀA matrix is prepared once per profile; difficult or unusually
 * conditioned events fall back to the QR block-pivot solver above.
 */
interface CytofCoordinateWorkspace {
  readonly linear: Float64Array;
  readonly gramTimesOutput: Float64Array;
}

function createCytofCoordinateWorkspace(count: number): CytofCoordinateWorkspace {
  return {
    linear: new Float64Array(count),
    gramTimesOutput: new Float64Array(count),
  };
}

function updateCytofCoordinate(
  plan: CytofNnlsPlan,
  source: number,
  zeroThreshold: number,
  output: Float64Array,
  linear: Float64Array,
  gramTimesOutput: Float64Array,
): void {
  let next = output[source] +
    (linear[source] - gramTimesOutput[source]) / plan.gram[source][source];
  if (next <= zeroThreshold) next = 0;
  const delta = next - output[source];
  if (delta === 0) return;
  output[source] = next;
  for (let target = 0; target < output.length; target++) {
    gramTimesOutput[target] += plan.gram[target][source] * delta;
  }
}

function solveCytofNnlsEventWithWorkspace(
  plan: CytofNnlsPlan,
  measured: ArrayLike<number>,
  output: Float64Array,
  workspace: CytofCoordinateWorkspace,
  includeDiagnostics: boolean,
): CytofNnlsEventDiagnostics | null {
  const count = plan.channels.length;
  if (measured.length !== count || output.length !== count) {
    throw new CytofCompensationError(
      "dimension-mismatch",
      "CyTOF NNLS measured and output vectors must match the plan channel count.",
    );
  }

  const { linear, gramTimesOutput } = workspace;
  gramTimesOutput.fill(0);
  let measuredScale = 1;
  for (let receiver = 0; receiver < count; receiver++) {
    if (!Number.isFinite(measured[receiver])) {
      throw new CytofCompensationError(
        "non-finite-input",
        `CyTOF NNLS input channel ${receiver + 1} is non-finite.`,
      );
    }
    measuredScale = Math.max(measuredScale, Math.abs(measured[receiver]));
    output[receiver] = 0;
  }
  for (let source = 0; source < count; source++) {
    linear[source] = dotColumn(plan.design, source, measured);
  }
  const kktThreshold = plan.settings.kktTolerance * measuredScale;
  const zeroThreshold = plan.settings.tolerance * measuredScale;
  const coordinateThreshold = Math.min(
    kktThreshold,
    plan.settings.tolerance * measuredScale * 1e-4,
  );

  for (let iteration = 1; iteration <= plan.settings.maxIterations; iteration++) {
    for (let source = 0; source < count; source++) {
      updateCytofCoordinate(
        plan, source, zeroThreshold, output, linear, gramTimesOutput,
      );
    }
    for (let source = count - 1; source >= 0; source--) {
      updateCytofCoordinate(
        plan, source, zeroThreshold, output, linear, gramTimesOutput,
      );
    }

    let kktViolation = 0;
    let activeSetSize = 0;
    for (let source = 0; source < count; source++) {
      const gradient = linear[source] - gramTimesOutput[source];
      if (output[source] > zeroThreshold) {
        activeSetSize++;
        kktViolation = Math.max(kktViolation, Math.abs(gradient));
      } else {
        kktViolation = Math.max(kktViolation, Math.max(0, gradient));
      }
    }
    if (Number.isFinite(kktViolation) && kktViolation <= coordinateThreshold) {
      if (!includeDiagnostics) return null;
      let residualSquares = 0;
      for (let receiver = 0; receiver < count; receiver++) {
        let reconstructed = 0;
        for (let source = 0; source < count; source++) {
          reconstructed += plan.design[receiver][source] * output[source];
        }
        const residual = measured[receiver] - reconstructed;
        residualSquares += residual * residual;
      }
      for (let source = 0; source < count; source++) {
        if (!Number.isFinite(output[source]) || output[source] < 0) {
          throw new CytofCompensationError(
            "non-finite-output",
            `CyTOF NNLS output channel ${source + 1} is non-finite or negative.`,
          );
        }
      }
      return Object.freeze({
        iterations: iteration,
        activeSetSize,
        residualNorm: Math.sqrt(residualSquares),
        objective: residualSquares,
        kktViolation,
        converged: true as const,
      });
    }
  }

  return solveCytofNnlsEventQr(plan, measured, output);
}

export function solveCytofNnlsEvent(
  plan: CytofNnlsPlan,
  measured: ArrayLike<number>,
  output: Float64Array = new Float64Array(plan.channels.length),
): CytofNnlsEventDiagnostics {
  return solveCytofNnlsEventWithWorkspace(
    plan,
    measured,
    output,
    createCytofCoordinateWorkspace(plan.channels.length),
    true,
  )!;
}

export function compensateCytofRange(
  measuredColumns: readonly Float64Array[],
  plan: CytofNnlsPlan,
  outputColumns: readonly (Float64Array | Float32Array)[],
  options: CytofRangeOptions = {},
): void {
  const count = plan.channels.length;
  if (
    measuredColumns.length !== count ||
    outputColumns.length !== count ||
    measuredColumns.some((column) => !(column instanceof Float64Array)) ||
    outputColumns.some(
      (column) => !(column instanceof Float64Array) && !(column instanceof Float32Array),
    )
  ) {
    throw new CytofCompensationError(
      "dimension-mismatch",
      "CyTOF compensation requires one input and output column per included channel.",
    );
  }
  const eventCount = measuredColumns[0]?.length ?? 0;
  if (measuredColumns.some((column) => column.length !== eventCount)) {
    throw new CytofCompensationError(
      "dimension-mismatch",
      "CyTOF compensation input columns must have equal event counts.",
    );
  }
  const inputStart = options.inputStart ?? 0;
  const inputEnd = options.inputEnd ?? eventCount;
  const outputStart = options.outputStart ?? 0;
  const solveCount = inputEnd - inputStart;
  if (
    !Number.isSafeInteger(inputStart) ||
    !Number.isSafeInteger(inputEnd) ||
    !Number.isSafeInteger(outputStart) ||
    inputStart < 0 ||
    inputEnd < inputStart ||
    inputEnd > eventCount ||
    outputStart < 0 ||
    outputColumns.some((column) => outputStart + solveCount > column.length)
  ) {
    throw new CytofCompensationError(
      "dimension-mismatch",
      "CyTOF compensation range is outside its input or output columns.",
    );
  }
  const measured = new Float64Array(count);
  const solved = new Float64Array(count);
  const workspace = createCytofCoordinateWorkspace(count);
  for (let event = inputStart; event < inputEnd; event++) {
    for (let channel = 0; channel < count; channel++) {
      const value = measuredColumns[channel][event];
      if ((options.validateMeasuredValues ?? true) && !Number.isFinite(value)) {
        throw new CytofCompensationError(
          "non-finite-input",
          `CyTOF compensation event ${event + 1}, channel ${channel + 1} is non-finite.`,
        );
      }
      measured[channel] = value;
    }
    solveCytofNnlsEventWithWorkspace(plan, measured, solved, workspace, false);
    const outputEvent = outputStart + event - inputStart;
    for (let channel = 0; channel < count; channel++) {
      const value = solved[channel];
      if ((options.validateOutputValues ?? true) && !Number.isFinite(value)) {
        throw new CytofCompensationError(
          "non-finite-output",
          `CyTOF compensation output event ${event + 1}, channel ${channel + 1} is non-finite.`,
        );
      }
      outputColumns[channel][outputEvent] = value;
    }
  }
}
