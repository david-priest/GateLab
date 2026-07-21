/**
 * Exact conventional-flow compensation engine.
 *
 * Matrix orientation is always source/emitter rows -> receiver/destination columns.
 * Measured input columns are therefore receiver-ordered and compensated output columns are
 * source-ordered.  Every production candidate is solved from immutable measured values using
 * the complete candidate matrix; the Sherman-Morrison path below is explanation-only.
 */

export const FLOW_SOLVER_VERSION = "flow-lu-v1" as const;

export interface FlowSolverSettings {
  /** Relative pivot/rcond threshold below which a matrix is blocked. */
  readonly singularTolerance: number;
  /** Infinity-norm condition number above which a valid solve carries a warning. */
  readonly conditionWarningThreshold: number;
}

export const DEFAULT_FLOW_SOLVER_SETTINGS: FlowSolverSettings = Object.freeze({
  singularTolerance: 1e-12,
  conditionWarningThreshold: 1e8,
});

export type FlowMatrixStability = "stable" | "warning" | "unstable";

export interface FlowMatrixDiagnostics {
  readonly size: number;
  readonly matrixInfinityNorm: number;
  readonly inverseInfinityNorm: number;
  readonly conditionInfinity: number;
  readonly reciprocalConditionInfinity: number;
  readonly minimumRelativePivot: number;
  readonly pivotGrowth: number;
  readonly inverseResidualInfinity: number;
  readonly normalizedInverseResidual: number;
  readonly stability: FlowMatrixStability;
  readonly warnings: readonly string[];
}

export interface FlowReconstructionDiagnostics {
  readonly maximumAbsoluteResidual: number;
  readonly residualInfinityNorm: number;
  readonly measuredInfinityNorm: number;
  readonly compensatedInfinityNorm: number;
  readonly relativeBackwardError: number;
}

export type FlowOutputPrecision = "float64" | "float32";
export type FlowNumericColumn = Float64Array | Float32Array;

export interface FlowSolveOptions {
  readonly output?: FlowOutputPrecision;
  readonly computeReconstructionResidual?: boolean;
  readonly validateMeasuredValues?: boolean;
}

export interface FlowRangeWriteOptions {
  readonly inputStart?: number;
  readonly inputEnd?: number;
  readonly outputStart?: number;
  readonly validateMeasuredValues?: boolean;
  readonly validateOutputValues?: boolean;
}

export interface FlowSolveResult {
  readonly columns: readonly FlowNumericColumn[];
  readonly eventCount: number;
  readonly factorization: FlowCompensationPlan;
  readonly reconstruction: FlowReconstructionDiagnostics | null;
}

export interface FlowCoefficientEdit {
  readonly sourceIndex: number;
  readonly receiverIndex: number;
  /** Absolute candidate coefficient, not a delta. */
  readonly value: number;
}

export interface FlowChannelImpact {
  readonly channelIndex: number;
  readonly channel: string;
  readonly medianAbsoluteDelta: number;
  readonly upperTailAbsoluteDelta: number;
  readonly meanAbsoluteDelta: number;
  readonly rootMeanSquareDelta: number;
  readonly maximumAbsoluteDelta: number;
  readonly changedCount: number;
  readonly fractionChanged: number;
  readonly negativeToNonNegativeCount: number;
  readonly nonNegativeToNegativeCount: number;
  readonly signCrossingCount: number;
}

export interface FlowComparisonOptions extends FlowSolveOptions {
  readonly sourceChannels?: readonly string[];
  readonly absoluteDifferenceTolerance?: number;
  readonly relativeDifferenceTolerance?: number;
  /** Values at or above -tolerance are treated as non-negative for crossing counts. */
  readonly signZeroTolerance?: number;
  readonly solverSettings?: FlowSolverSettings;
}

export interface FlowCompensationComparison {
  readonly current: FlowSolveResult;
  readonly candidate: FlowSolveResult;
  /** Candidate - current, in source-channel order. */
  readonly deltas: readonly Float64Array[];
  /** Impact summaries in source-channel order. */
  readonly impacts: readonly FlowChannelImpact[];
  /** The same immutable summaries ranked by measured exact impact. */
  readonly impactRanking: readonly FlowChannelImpact[];
}

export type FlowRankOneFailureReason =
  | "denominator-too-small"
  | "candidate-unstable";

export type FlowRankOneSensitivity =
  | {
      readonly ok: true;
      readonly delta: number;
      readonly denominator: number;
      readonly relativeDenominator: number;
      readonly current: FlowSolveResult;
      readonly candidateColumns: readonly Float64Array[];
      readonly candidateInverse: readonly (readonly number[])[];
      readonly candidateDiagnostics: FlowMatrixDiagnostics;
    }
  | {
      readonly ok: false;
      readonly reason: FlowRankOneFailureReason;
      readonly delta: number;
      readonly denominator: number;
      readonly relativeDenominator: number;
      readonly current: FlowSolveResult;
      readonly candidateDiagnostics: FlowMatrixDiagnostics | null;
    };

export type FlowCompensationErrorCode =
  | "invalid-settings"
  | "invalid-matrix-shape"
  | "non-finite-matrix"
  | "singular-matrix"
  | "unstable-matrix"
  | "dimension-mismatch"
  | "overlapping-buffer"
  | "non-finite-measured-value"
  | "non-finite-output"
  | "invalid-edit";

export class FlowCompensationError extends Error {
  readonly code: FlowCompensationErrorCode;
  readonly diagnostics: FlowMatrixDiagnostics | null;

  constructor(
    code: FlowCompensationErrorCode,
    message: string,
    diagnostics: FlowMatrixDiagnostics | null = null,
  ) {
    super(message);
    this.name = "FlowCompensationError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

interface LuDecomposition {
  readonly lu: number[][];
  readonly permutation: Int32Array;
  readonly minimumRelativePivot: number;
  readonly pivotGrowth: number;
}

function validateSettings(settings: FlowSolverSettings): FlowSolverSettings {
  const singularTolerance = settings.singularTolerance;
  const conditionWarningThreshold = settings.conditionWarningThreshold;
  if (
    !Number.isFinite(singularTolerance) ||
    singularTolerance <= 0 ||
    singularTolerance >= 1 ||
    !Number.isFinite(conditionWarningThreshold) ||
    conditionWarningThreshold < 1 ||
    conditionWarningThreshold >= 1 / singularTolerance
  ) {
    throw new FlowCompensationError(
      "invalid-settings",
      "Flow solver settings require 0 < singularTolerance < 1 and " +
        "1 <= conditionWarningThreshold < 1 / singularTolerance.",
    );
  }
  return Object.freeze({ singularTolerance, conditionWarningThreshold });
}

function copySquareFiniteMatrix(
  matrix: readonly (readonly number[])[],
): number[][] {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    throw new FlowCompensationError(
      "invalid-matrix-shape",
      "A flow spillover matrix must be a non-empty square matrix.",
    );
  }
  const size = matrix.length;
  const copied = new Array<number[]>(size);
  for (let row = 0; row < size; row++) {
    if (!Array.isArray(matrix[row]) || matrix[row].length !== size) {
      throw new FlowCompensationError(
        "invalid-matrix-shape",
        `Flow spillover row ${row + 1} must contain exactly ${size} coefficients.`,
      );
    }
    copied[row] = new Array<number>(size);
    for (let column = 0; column < size; column++) {
      const value = matrix[row][column];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new FlowCompensationError(
          "non-finite-matrix",
          `Flow spillover coefficient [${row + 1}, ${column + 1}] must be finite.`,
        );
      }
      copied[row][column] = Object.is(value, -0) ? 0 : value;
    }
  }
  return copied;
}

function freezeMatrix(matrix: readonly (readonly number[])[]): readonly (readonly number[])[] {
  return Object.freeze(matrix.map((row) => Object.freeze(Array.from(row))));
}

export function matrixInfinityNorm(matrix: readonly (readonly number[])[]): number {
  let norm = 0;
  for (const row of matrix) {
    let rowSum = 0;
    for (const value of row) rowSum += Math.abs(value);
    norm = Math.max(norm, rowSum);
  }
  return norm;
}

function maxAbsoluteEntry(matrix: readonly (readonly number[])[]): number {
  let maximum = 0;
  for (const row of matrix) {
    for (const value of row) maximum = Math.max(maximum, Math.abs(value));
  }
  return maximum;
}

function decomposeLu(
  matrix: readonly (readonly number[])[],
  singularTolerance: number,
): LuDecomposition {
  const size = matrix.length;
  const lu = matrix.map((row) => Array.from(row));
  const permutation = Int32Array.from({ length: size }, (_, index) => index);
  const matrixScale = maxAbsoluteEntry(matrix);
  if (matrixScale === 0) {
    throw new FlowCompensationError("singular-matrix", "The flow spillover matrix is singular.");
  }

  let minimumRelativePivot = Number.POSITIVE_INFINITY;
  let maximumUpperEntry = 0;
  for (let column = 0; column < size; column++) {
    let pivotRow = column;
    let pivotMagnitude = Math.abs(lu[column][column]);
    for (let row = column + 1; row < size; row++) {
      const magnitude = Math.abs(lu[row][column]);
      if (magnitude > pivotMagnitude) {
        pivotMagnitude = magnitude;
        pivotRow = row;
      }
    }
    const relativePivot = pivotMagnitude / matrixScale;
    if (!Number.isFinite(relativePivot) || relativePivot <= singularTolerance) {
      throw new FlowCompensationError(
        "singular-matrix",
        `The flow spillover matrix has a singular or unsafe pivot at column ${column + 1}.`,
      );
    }
    minimumRelativePivot = Math.min(minimumRelativePivot, relativePivot);

    if (pivotRow !== column) {
      const row = lu[column];
      lu[column] = lu[pivotRow];
      lu[pivotRow] = row;
      const originalRow = permutation[column];
      permutation[column] = permutation[pivotRow];
      permutation[pivotRow] = originalRow;
    }

    const pivot = lu[column][column];
    for (let row = column + 1; row < size; row++) {
      const multiplier = lu[row][column] / pivot;
      lu[row][column] = multiplier;
      for (let receiver = column + 1; receiver < size; receiver++) {
        lu[row][receiver] -= multiplier * lu[column][receiver];
      }
    }
  }

  for (let row = 0; row < size; row++) {
    for (let column = row; column < size; column++) {
      maximumUpperEntry = Math.max(maximumUpperEntry, Math.abs(lu[row][column]));
    }
  }
  return {
    lu,
    permutation,
    minimumRelativePivot,
    pivotGrowth: maximumUpperEntry / matrixScale,
  };
}

function solveLu(decomposition: LuDecomposition, rightHandSide: ArrayLike<number>): number[] {
  const { lu, permutation } = decomposition;
  const size = lu.length;
  const solution = new Array<number>(size);

  // Forward solve L y = P b. L has an implicit unit diagonal.
  for (let row = 0; row < size; row++) {
    let value = rightHandSide[permutation[row]];
    for (let column = 0; column < row; column++) value -= lu[row][column] * solution[column];
    solution[row] = value;
  }
  // Back solve U x = y.
  for (let row = size - 1; row >= 0; row--) {
    let value = solution[row];
    for (let column = row + 1; column < size; column++) value -= lu[row][column] * solution[column];
    solution[row] = value / lu[row][row];
  }
  return solution;
}

function invertFromLu(decomposition: LuDecomposition): number[][] {
  const size = decomposition.lu.length;
  const inverse = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const basis = new Float64Array(size);
  for (let column = 0; column < size; column++) {
    basis.fill(0);
    basis[column] = 1;
    const solution = solveLu(decomposition, basis);
    for (let row = 0; row < size; row++) inverse[row][column] = solution[row];
  }
  return inverse;
}

function inverseResiduals(
  matrix: readonly (readonly number[])[],
  inverse: readonly (readonly number[])[],
): { infinity: number; normalized: number } {
  const size = matrix.length;
  let leftInfinity = 0;
  let rightInfinity = 0;
  for (let row = 0; row < size; row++) {
    let leftRowSum = 0;
    let rightRowSum = 0;
    for (let column = 0; column < size; column++) {
      let left = 0;
      let right = 0;
      for (let inner = 0; inner < size; inner++) {
        left += matrix[row][inner] * inverse[inner][column];
        right += inverse[row][inner] * matrix[inner][column];
      }
      const identity = row === column ? 1 : 0;
      leftRowSum += Math.abs(left - identity);
      rightRowSum += Math.abs(right - identity);
    }
    leftInfinity = Math.max(leftInfinity, leftRowSum);
    rightInfinity = Math.max(rightInfinity, rightRowSum);
  }
  const infinity = Math.max(leftInfinity, rightInfinity);
  const scale = matrixInfinityNorm(matrix) * matrixInfinityNorm(inverse) + 1;
  return { infinity, normalized: infinity / scale };
}

function diagnosticsFor(
  matrix: readonly (readonly number[])[],
  inverse: readonly (readonly number[])[],
  decomposition: LuDecomposition,
  settings: FlowSolverSettings,
): FlowMatrixDiagnostics {
  const matrixNorm = matrixInfinityNorm(matrix);
  const inverseNorm = matrixInfinityNorm(inverse);
  const condition = matrixNorm * inverseNorm;
  const reciprocalCondition = condition === 0 ? Number.POSITIVE_INFINITY : 1 / condition;
  const residual = inverseResiduals(matrix, inverse);
  const residualLimit = Math.max(
    settings.singularTolerance,
    64 * matrix.length * Number.EPSILON,
  );
  let stability: FlowMatrixStability = "stable";
  const warnings: string[] = [];
  if (
    !Number.isFinite(condition) ||
    reciprocalCondition <= settings.singularTolerance ||
    !Number.isFinite(residual.normalized) ||
    residual.normalized > residualLimit
  ) {
    stability = "unstable";
    warnings.push(
      "The spillover matrix is numerically unstable; an exact candidate cannot be reported safely.",
    );
  } else if (condition > settings.conditionWarningThreshold) {
    stability = "warning";
    warnings.push(
      `The spillover matrix condition number is ${condition.toExponential(3)}; review the candidate carefully.`,
    );
  }
  if (decomposition.pivotGrowth > 1e6) {
    warnings.push(
      `LU pivot growth is ${decomposition.pivotGrowth.toExponential(3)}, indicating possible numerical sensitivity.`,
    );
    if (stability === "stable") stability = "warning";
  }
  return Object.freeze({
    size: matrix.length,
    matrixInfinityNorm: matrixNorm,
    inverseInfinityNorm: inverseNorm,
    conditionInfinity: condition,
    reciprocalConditionInfinity: reciprocalCondition,
    minimumRelativePivot: decomposition.minimumRelativePivot,
    pivotGrowth: decomposition.pivotGrowth,
    inverseResidualInfinity: residual.infinity,
    normalizedInverseResidual: residual.normalized,
    stability,
    warnings: Object.freeze(warnings),
  });
}

interface PreparedFlowComponents {
  readonly matrix: readonly (readonly number[])[];
  readonly inverse: readonly (readonly number[])[];
  readonly settings: FlowSolverSettings;
  readonly diagnostics: FlowMatrixDiagnostics;
}

function prepareFlowComponents(
  matrix: readonly (readonly number[])[],
  settings: FlowSolverSettings,
): PreparedFlowComponents {
  const checkedSettings = validateSettings(settings);
  const copied = copySquareFiniteMatrix(matrix);
  const decomposition = decomposeLu(copied, checkedSettings.singularTolerance);
  const inverse = invertFromLu(decomposition);
  if (inverse.some((row) => row.some((value) => !Number.isFinite(value)))) {
    throw new FlowCompensationError(
      "singular-matrix",
      "The flow spillover matrix produced a non-finite inverse.",
    );
  }
  const diagnostics = diagnosticsFor(copied, inverse, decomposition, checkedSettings);
  return {
    matrix: freezeMatrix(copied),
    inverse: freezeMatrix(inverse),
    settings: checkedSettings,
    diagnostics,
  };
}

/** Immutable factor/inverse prepared once for a complete flow matrix. */
export class FlowCompensationPlan {
  readonly matrix: readonly (readonly number[])[];
  readonly inverse: readonly (readonly number[])[];
  readonly settings: FlowSolverSettings;
  readonly diagnostics: FlowMatrixDiagnostics;

  private constructor(
    matrix: readonly (readonly number[])[],
    inverse: readonly (readonly number[])[],
    settings: FlowSolverSettings,
    diagnostics: FlowMatrixDiagnostics,
  ) {
    this.matrix = matrix;
    this.inverse = inverse;
    this.settings = settings;
    this.diagnostics = diagnostics;
    Object.freeze(this);
  }

  static prepare(
    matrix: readonly (readonly number[])[],
    settings: FlowSolverSettings = DEFAULT_FLOW_SOLVER_SETTINGS,
  ): FlowCompensationPlan {
    const prepared = prepareFlowComponents(matrix, settings);
    if (prepared.diagnostics.stability === "unstable") {
      throw new FlowCompensationError(
        "unstable-matrix",
        "The flow spillover matrix is too ill-conditioned for a trustworthy solve.",
        prepared.diagnostics,
      );
    }
    return new FlowCompensationPlan(
      prepared.matrix,
      prepared.inverse,
      prepared.settings,
      prepared.diagnostics,
    );
  }
}

export function prepareFlowCompensation(
  matrix: readonly (readonly number[])[],
  settings: FlowSolverSettings = DEFAULT_FLOW_SOLVER_SETTINGS,
): FlowCompensationPlan {
  return FlowCompensationPlan.prepare(matrix, settings);
}

/**
 * Calculate diagnostics without exposing an unsafe factorization to compensation callers.
 * Singular matrices still throw; numerically unstable invertible matrices return diagnostics.
 */
export function inspectFlowMatrix(
  matrix: readonly (readonly number[])[],
  settings: FlowSolverSettings = DEFAULT_FLOW_SOLVER_SETTINGS,
): FlowMatrixDiagnostics {
  return prepareFlowComponents(matrix, settings).diagnostics;
}

function measuredShape(
  measuredColumns: readonly ArrayLike<number>[],
  expectedChannels: number,
  validateValues: boolean,
): number {
  if (measuredColumns.length !== expectedChannels) {
    throw new FlowCompensationError(
      "dimension-mismatch",
      `Flow compensation requires ${expectedChannels} measured receiver columns, received ${measuredColumns.length}.`,
    );
  }
  const eventCount = measuredColumns[0]?.length ?? 0;
  for (let channel = 0; channel < measuredColumns.length; channel++) {
    const column = measuredColumns[channel];
    if (column == null || column.length !== eventCount) {
      throw new FlowCompensationError(
        "dimension-mismatch",
        "Every measured receiver column must contain the same number of events.",
      );
    }
    if (validateValues) {
      for (let event = 0; event < eventCount; event++) {
        if (!Number.isFinite(column[event])) {
          throw new FlowCompensationError(
            "non-finite-measured-value",
            `Measured value at receiver ${channel + 1}, event ${event + 1} must be finite.`,
          );
        }
      }
    }
  }
  return eventCount;
}

interface NumericByteRange {
  readonly buffer: ArrayBufferLike;
  readonly start: number;
  readonly end: number;
}

function numericByteRange(
  column: ArrayLike<number>,
  startElement: number,
  endElement: number,
): NumericByteRange | null {
  if (!ArrayBuffer.isView(column) || column instanceof DataView) return null;
  const view = column as unknown as {
    readonly buffer: ArrayBufferLike;
    readonly byteOffset: number;
    readonly BYTES_PER_ELEMENT: number;
  };
  if (!Number.isSafeInteger(view.BYTES_PER_ELEMENT) || view.BYTES_PER_ELEMENT <= 0) {
    return null;
  }
  return {
    buffer: view.buffer,
    start: view.byteOffset + startElement * view.BYTES_PER_ELEMENT,
    end: view.byteOffset + endElement * view.BYTES_PER_ELEMENT,
  };
}

function byteRangesOverlap(left: NumericByteRange, right: NumericByteRange): boolean {
  return left.buffer === right.buffer && left.start < right.end && right.start < left.end;
}

function calculateReconstruction(
  measuredColumns: readonly ArrayLike<number>[],
  compensatedColumns: readonly ArrayLike<number>[],
  matrix: readonly (readonly number[])[],
): FlowReconstructionDiagnostics {
  const channelCount = matrix.length;
  const eventCount = measuredColumns[0]?.length ?? 0;
  let maximumAbsoluteResidual = 0;
  let residualInfinityNorm = 0;
  let measuredInfinityNorm = 0;
  let compensatedInfinityNorm = 0;

  for (let event = 0; event < eventCount; event++) {
    let eventResidualSum = 0;
    let measuredEventSum = 0;
    let compensatedEventSum = 0;
    for (let source = 0; source < channelCount; source++) {
      compensatedEventSum += Math.abs(compensatedColumns[source][event]);
    }
    for (let receiver = 0; receiver < channelCount; receiver++) {
      let reconstructed = 0;
      for (let source = 0; source < channelCount; source++) {
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

  const denominator =
    compensatedInfinityNorm * matrixInfinityNorm(matrix) + measuredInfinityNorm;
  const relativeBackwardError =
    denominator === 0
      ? residualInfinityNorm === 0
        ? 0
        : Number.POSITIVE_INFINITY
      : residualInfinityNorm / denominator;
  return Object.freeze({
    maximumAbsoluteResidual,
    residualInfinityNorm,
    measuredInfinityNorm,
    compensatedInfinityNorm,
    relativeBackwardError,
  });
}

export function compensateFlowColumns(
  measuredColumns: readonly ArrayLike<number>[],
  plan: FlowCompensationPlan,
  options: FlowSolveOptions = {},
): FlowSolveResult {
  const output = options.output ?? "float64";
  const eventCount = measuredShape(
    measuredColumns,
    plan.matrix.length,
    options.validateMeasuredValues ?? true,
  );
  const columns: FlowNumericColumn[] = Array.from(
    { length: plan.matrix.length },
    () => output === "float32" ? new Float32Array(eventCount) : new Float64Array(eventCount),
  );
  compensateFlowRange(measuredColumns, plan, columns, {
    inputStart: 0,
    inputEnd: eventCount,
    outputStart: 0,
    // measuredShape() already performed the optional complete validation above.
    validateMeasuredValues: false,
    validateOutputValues: true,
  });

  const reconstruction = options.computeReconstructionResidual
    ? calculateReconstruction(measuredColumns, columns, plan.matrix)
    : null;
  return Object.freeze({
    columns: Object.freeze(columns),
    eventCount,
    factorization: plan,
    reconstruction,
  });
}

/**
 * Solve a bounded event range directly into caller-owned output arrays. Workers use this to
 * yield between small compute slices without changing the exact arithmetic or allocating an
 * intermediate result for every slice.
 */
export function compensateFlowRange(
  measuredColumns: readonly ArrayLike<number>[],
  plan: FlowCompensationPlan,
  outputColumns: readonly FlowNumericColumn[],
  options: FlowRangeWriteOptions = {},
): number {
  const eventCount = measuredShape(measuredColumns, plan.matrix.length, false);
  const inputStart = options.inputStart ?? 0;
  const inputEnd = options.inputEnd ?? eventCount;
  const outputStart = options.outputStart ?? inputStart;
  if (
    !Number.isSafeInteger(inputStart) ||
    !Number.isSafeInteger(inputEnd) ||
    !Number.isSafeInteger(outputStart) ||
    inputStart < 0 ||
    inputEnd < inputStart ||
    inputEnd > eventCount ||
    outputStart < 0
  ) {
    throw new FlowCompensationError(
      "dimension-mismatch",
      "Flow range bounds must identify a valid contiguous measured-event interval.",
    );
  }
  if (outputColumns.length !== plan.matrix.length) {
    throw new FlowCompensationError(
      "dimension-mismatch",
      `Flow range output requires ${plan.matrix.length} source columns.`,
    );
  }
  const rangeLength = inputEnd - inputStart;
  for (const column of outputColumns) {
    if (
      !(column instanceof Float32Array) &&
      !(column instanceof Float64Array)
    ) {
      throw new FlowCompensationError(
        "dimension-mismatch",
        "Flow range outputs must be Float32Array or Float64Array columns.",
      );
    }
    if (outputStart + rangeLength > column.length) {
      throw new FlowCompensationError(
        "dimension-mismatch",
        "Flow range output columns are too short for the requested write interval.",
      );
    }
  }

  const measuredRanges = measuredColumns.map((column) =>
    numericByteRange(column, inputStart, inputEnd)
  );
  const outputRanges = outputColumns.map((column) =>
    numericByteRange(column, outputStart, outputStart + rangeLength)!
  );
  for (let source = 0; source < outputRanges.length; source++) {
    for (let receiver = 0; receiver < measuredRanges.length; receiver++) {
      const measuredRange = measuredRanges[receiver];
      if (measuredRange !== null && byteRangesOverlap(outputRanges[source], measuredRange)) {
        throw new FlowCompensationError(
          "overlapping-buffer",
          "Flow range input and output intervals must not overlap in memory.",
        );
      }
    }
    for (let otherSource = 0; otherSource < source; otherSource++) {
      if (byteRangesOverlap(outputRanges[source], outputRanges[otherSource])) {
        throw new FlowCompensationError(
          "overlapping-buffer",
          "Flow range output intervals must not overlap in memory.",
        );
      }
    }
  }

  const validateMeasured = options.validateMeasuredValues ?? true;
  const validateOutput = options.validateOutputValues ?? true;
  for (let inputEvent = inputStart; inputEvent < inputEnd; inputEvent++) {
    if (validateMeasured) {
      for (let receiver = 0; receiver < plan.matrix.length; receiver++) {
        if (!Number.isFinite(measuredColumns[receiver][inputEvent])) {
          throw new FlowCompensationError(
            "non-finite-measured-value",
            `Measured value at receiver ${receiver + 1}, event ${inputEvent + 1} must be finite.`,
          );
        }
      }
    }
    const outputEvent = outputStart + inputEvent - inputStart;
    // Preserve the validated event/source/receiver accumulation order exactly.
    for (let source = 0; source < plan.matrix.length; source++) {
      let value = 0;
      for (let receiver = 0; receiver < plan.matrix.length; receiver++) {
        value += measuredColumns[receiver][inputEvent] * plan.inverse[receiver][source];
      }
      outputColumns[source][outputEvent] = value;
      if (validateOutput && !Number.isFinite(outputColumns[source][outputEvent])) {
        throw new FlowCompensationError(
          "non-finite-output",
          `Compensated value at source ${source + 1}, event ${inputEvent + 1} is not finite.`,
        );
      }
    }
  }
  return rangeLength;
}

export function solveFlowCompensation(
  measuredColumns: readonly ArrayLike<number>[],
  matrix: readonly (readonly number[])[],
  settings: FlowSolverSettings = DEFAULT_FLOW_SOLVER_SETTINGS,
  options: FlowSolveOptions = {},
): FlowSolveResult {
  const plan = prepareFlowCompensation(matrix, settings);
  return compensateFlowColumns(measuredColumns, plan, options);
}

export function applyFlowMatrixEdits(
  matrix: readonly (readonly number[])[],
  edits: readonly FlowCoefficientEdit[],
): number[][] {
  const candidate = copySquareFiniteMatrix(matrix);
  const seen = new Set<string>();
  for (const edit of edits) {
    const { sourceIndex, receiverIndex, value } = edit;
    if (
      !Number.isInteger(sourceIndex) ||
      !Number.isInteger(receiverIndex) ||
      sourceIndex < 0 ||
      receiverIndex < 0 ||
      sourceIndex >= candidate.length ||
      receiverIndex >= candidate.length ||
      !Number.isFinite(value)
    ) {
      throw new FlowCompensationError(
        "invalid-edit",
        "Every flow matrix edit requires valid source/receiver indices and a finite value.",
      );
    }
    const key = `${sourceIndex}:${receiverIndex}`;
    if (seen.has(key)) {
      throw new FlowCompensationError(
        "invalid-edit",
        `Flow matrix cell [${sourceIndex + 1}, ${receiverIndex + 1}] was edited more than once.`,
      );
    }
    seen.add(key);
    candidate[sourceIndex][receiverIndex] = Object.is(value, -0) ? 0 : value;
  }
  return candidate;
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

function compareSolvedColumns(
  current: FlowSolveResult,
  candidate: FlowSolveResult,
  sourceChannels: readonly string[] | undefined,
  absoluteTolerance: number,
  relativeTolerance: number,
  signZeroTolerance: number,
): Pick<FlowCompensationComparison, "deltas" | "impacts" | "impactRanking"> {
  const channelCount = current.columns.length;
  if (candidate.columns.length !== channelCount || candidate.eventCount !== current.eventCount) {
    throw new FlowCompensationError(
      "dimension-mismatch",
      "Current and candidate flow results must have the same dimensions.",
    );
  }
  if (sourceChannels && sourceChannels.length !== channelCount) {
    throw new FlowCompensationError(
      "dimension-mismatch",
      "sourceChannels must match the number of compensated output channels.",
    );
  }

  const deltas: Float64Array[] = [];
  const impacts: FlowChannelImpact[] = [];
  for (let channel = 0; channel < channelCount; channel++) {
    const delta = new Float64Array(current.eventCount);
    const absoluteDeltas = new Array<number>(current.eventCount);
    let sumAbsolute = 0;
    let sumSquares = 0;
    let maximumAbsolute = 0;
    let changedCount = 0;
    let negativeToNonNegativeCount = 0;
    let nonNegativeToNegativeCount = 0;
    for (let event = 0; event < current.eventCount; event++) {
      const before = current.columns[channel][event];
      const after = candidate.columns[channel][event];
      const difference = after - before;
      const absolute = Math.abs(difference);
      delta[event] = difference;
      absoluteDeltas[event] = absolute;
      sumAbsolute += absolute;
      sumSquares += difference * difference;
      maximumAbsolute = Math.max(maximumAbsolute, absolute);
      const tolerance = absoluteTolerance + relativeTolerance * Math.max(Math.abs(before), Math.abs(after));
      if (absolute > tolerance) {
        changedCount++;
        const beforeNegative = before < -signZeroTolerance;
        const afterNegative = after < -signZeroTolerance;
        if (beforeNegative && !afterNegative) negativeToNonNegativeCount++;
        else if (!beforeNegative && afterNegative) nonNegativeToNegativeCount++;
      }
    }
    absoluteDeltas.sort((left, right) => left - right);
    const eventCount = current.eventCount;
    const impact = Object.freeze({
      channelIndex: channel,
      channel: sourceChannels?.[channel] ?? String(channel + 1),
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

/**
 * Exact complete-matrix comparison from immutable measured values.  This is the production
 * preview rule for one or many edits; candidate values are never derived recursively from the
 * current compensated layer.
 */
export function compareFlowCompensation(
  measuredColumns: readonly ArrayLike<number>[],
  currentMatrix: readonly (readonly number[])[],
  candidateMatrix: readonly (readonly number[])[],
  options: FlowComparisonOptions = {},
): FlowCompensationComparison {
  const settings = options.solverSettings ?? DEFAULT_FLOW_SOLVER_SETTINGS;
  const solveOptions: FlowSolveOptions = {
    output: "float64",
    computeReconstructionResidual: options.computeReconstructionResidual ?? true,
    validateMeasuredValues: options.validateMeasuredValues,
  };
  const absoluteTolerance = options.absoluteDifferenceTolerance ?? 0;
  const relativeTolerance = options.relativeDifferenceTolerance ?? 64 * Number.EPSILON;
  const signZeroTolerance = options.signZeroTolerance ?? absoluteTolerance;
  if (
    !Number.isFinite(absoluteTolerance) ||
    absoluteTolerance < 0 ||
    !Number.isFinite(relativeTolerance) ||
    relativeTolerance < 0 ||
    !Number.isFinite(signZeroTolerance) ||
    signZeroTolerance < 0
  ) {
    throw new FlowCompensationError(
      "invalid-settings",
      "Flow comparison tolerances must be finite non-negative numbers.",
    );
  }
  const current = solveFlowCompensation(measuredColumns, currentMatrix, settings, solveOptions);
  const candidate = solveFlowCompensation(measuredColumns, candidateMatrix, settings, solveOptions);
  const comparison = compareSolvedColumns(
    current,
    candidate,
    options.sourceChannels,
    absoluteTolerance,
    relativeTolerance,
    signZeroTolerance,
  );
  return Object.freeze({ current, candidate, ...comparison });
}

function validateSingleEdit(
  plan: FlowCompensationPlan,
  edit: FlowCoefficientEdit,
): void {
  if (
    !Number.isInteger(edit.sourceIndex) ||
    !Number.isInteger(edit.receiverIndex) ||
    edit.sourceIndex < 0 ||
    edit.receiverIndex < 0 ||
    edit.sourceIndex >= plan.matrix.length ||
    edit.receiverIndex >= plan.matrix.length ||
    !Number.isFinite(edit.value)
  ) {
    throw new FlowCompensationError(
      "invalid-edit",
      "A single flow edit requires valid source/receiver indices and a finite candidate value.",
    );
  }
}

/**
 * Exact rank-one sensitivity for one edit.  It exists for explanation/ranking and verification;
 * production preview and Apply must still call compareFlowCompensation/full solving.
 */
export function explainSingleFlowEdit(
  measuredColumns: readonly ArrayLike<number>[],
  currentMatrix: readonly (readonly number[])[],
  edit: FlowCoefficientEdit,
  settings: FlowSolverSettings = DEFAULT_FLOW_SOLVER_SETTINGS,
  options: { readonly denominatorTolerance?: number } = {},
): FlowRankOneSensitivity {
  const currentPlan = prepareFlowCompensation(currentMatrix, settings);
  validateSingleEdit(currentPlan, edit);
  const current = compensateFlowColumns(measuredColumns, currentPlan, {
    output: "float64",
    validateMeasuredValues: true,
  });
  const delta = edit.value - currentPlan.matrix[edit.sourceIndex][edit.receiverIndex];
  const coupling = delta * currentPlan.inverse[edit.receiverIndex][edit.sourceIndex];
  const denominator = 1 + coupling;
  const relativeDenominator = Math.abs(denominator) / (1 + Math.abs(coupling));
  const denominatorTolerance = options.denominatorTolerance ?? settings.singularTolerance;
  if (
    !Number.isFinite(denominator) ||
    !Number.isFinite(relativeDenominator) ||
    relativeDenominator <= denominatorTolerance
  ) {
    return Object.freeze({
      ok: false,
      reason: "denominator-too-small" as const,
      delta,
      denominator,
      relativeDenominator,
      current,
      candidateDiagnostics: null,
    });
  }

  const candidateMatrix = applyFlowMatrixEdits(currentPlan.matrix, [edit]);
  let candidateDiagnostics: FlowMatrixDiagnostics;
  try {
    candidateDiagnostics = inspectFlowMatrix(candidateMatrix, settings);
  } catch (error) {
    if (error instanceof FlowCompensationError && error.code === "singular-matrix") {
      return Object.freeze({
        ok: false,
        reason: "candidate-unstable" as const,
        delta,
        denominator,
        relativeDenominator,
        current,
        candidateDiagnostics: error.diagnostics,
      });
    }
    throw error;
  }
  // A warning candidate remains available through the complete solver, but the explanatory
  // rank-one shortcut is deliberately more conservative near a sensitive matrix.
  if (candidateDiagnostics.stability !== "stable") {
    return Object.freeze({
      ok: false,
      reason: "candidate-unstable" as const,
      delta,
      denominator,
      relativeDenominator,
      current,
      candidateDiagnostics,
    });
  }

  const size = currentPlan.matrix.length;
  const candidateInverse = Array.from({ length: size }, () => new Array<number>(size));
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      candidateInverse[row][column] =
        currentPlan.inverse[row][column] -
        (delta *
          currentPlan.inverse[row][edit.sourceIndex] *
          currentPlan.inverse[edit.receiverIndex][column]) /
          denominator;
    }
  }

  const candidateColumns = Array.from(
    { length: size },
    () => new Float64Array(current.eventCount),
  );
  const factor = delta / denominator;
  for (let source = 0; source < size; source++) {
    const propagation = factor * currentPlan.inverse[edit.receiverIndex][source];
    for (let event = 0; event < current.eventCount; event++) {
      candidateColumns[source][event] =
        current.columns[source][event] -
        propagation * current.columns[edit.sourceIndex][event];
    }
  }
  return Object.freeze({
    ok: true,
    delta,
    denominator,
    relativeDenominator,
    current,
    candidateColumns: Object.freeze(candidateColumns),
    candidateInverse: freezeMatrix(candidateInverse),
    candidateDiagnostics,
  });
}

/**
 * Exact marginal of one pending edit given all other edits.  Both sides are complete solves from
 * the same measured values.  Marginals are intentionally not presented as additive effects.
 */
export function compareFlowLeaveOneEditOut(
  measuredColumns: readonly ArrayLike<number>[],
  baselineMatrix: readonly (readonly number[])[],
  candidateMatrix: readonly (readonly number[])[],
  edit: Pick<FlowCoefficientEdit, "sourceIndex" | "receiverIndex">,
  options: FlowComparisonOptions = {},
): FlowCompensationComparison {
  const baseline = copySquareFiniteMatrix(baselineMatrix);
  const candidate = copySquareFiniteMatrix(candidateMatrix);
  if (
    !Number.isInteger(edit.sourceIndex) ||
    !Number.isInteger(edit.receiverIndex) ||
    edit.sourceIndex < 0 ||
    edit.receiverIndex < 0 ||
    edit.sourceIndex >= baseline.length ||
    edit.receiverIndex >= baseline.length ||
    candidate.length !== baseline.length
  ) {
    throw new FlowCompensationError(
      "invalid-edit",
      "Leave-one-out comparison requires a valid edited matrix cell.",
    );
  }
  if (
    candidate[edit.sourceIndex][edit.receiverIndex] ===
    baseline[edit.sourceIndex][edit.receiverIndex]
  ) {
    throw new FlowCompensationError(
      "invalid-edit",
      "Leave-one-out comparison requires a cell that differs from the baseline matrix.",
    );
  }
  const withoutSelectedEdit = candidate.map((row) => Array.from(row));
  withoutSelectedEdit[edit.sourceIndex][edit.receiverIndex] =
    baseline[edit.sourceIndex][edit.receiverIndex];
  return compareFlowCompensation(
    measuredColumns,
    withoutSelectedEdit,
    candidate,
    options,
  );
}
