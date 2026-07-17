import type { ResolvedChannel } from "./channels";
import {
  serializeCanonicalCompensationMatrix,
  validateAndCanonicalizeCompensationMatrix,
  type CanonicalCompensationMatrix,
  type MatrixValidationIssue,
} from "./compensationProfile";

export type SamplePnnChannel = Readonly<Pick<ResolvedChannel, "pnn" | "columnIndex">>;

export type MatrixCompatibilityRequest =
  | {
      readonly kind: "flow-spillover";
      readonly matrix: CanonicalCompensationMatrix;
      readonly sampleChannels: readonly SamplePnnChannel[];
    }
  | {
      readonly kind: "cytof-spillover";
      readonly matrix: CanonicalCompensationMatrix;
      readonly sampleChannels: readonly SamplePnnChannel[];
      readonly includedChannels: readonly string[];
    };

export interface MatrixChannelBinding {
  readonly pnn: string;
  readonly fcsColumnIndex: number;
  /** Null means a rectangular CyTOF receiver-only channel. */
  readonly matrixSourceIndex: number | null;
  readonly matrixReceiverIndex: number;
  readonly included: boolean;
}

export type CompatibilityBlockCode =
  | "invalid-sample-channel"
  | "duplicate-fcs-column-index"
  | "blank-sample-pnn"
  | "duplicate-sample-pnn"
  | "empty-overlap"
  | "missing-flow-channel"
  | "empty-included-channels"
  | "blank-included-channel"
  | "duplicate-included-channel"
  | "included-channel-not-receiver"
  | "missing-included-channel"
  | "ambiguous-included-channel";

export interface MatrixCompatibilityBlock {
  readonly code: CompatibilityBlockCode;
  readonly channels: readonly string[];
  readonly fcsColumnIndices: readonly number[];
  /** Zero-based positions in the supplied request array when no valid FCS index exists. */
  readonly inputPositions: readonly number[];
  readonly message: string;
}

export type CompatibilityWarningCode = "identity-solve" | "nonzero-edges-excluded";

export interface MatrixCompatibilityWarning {
  readonly code: CompatibilityWarningCode;
  readonly channels: readonly string[];
  readonly message: string;
}

export interface ExcludedMatrixEdge {
  readonly sourcePnn: string;
  readonly receiverPnn: string;
  readonly coefficient: number;
}

export interface MatrixCompatibilityReport {
  readonly canApply: boolean;
  readonly requiresReview: boolean;
  /** Unique exact receiver↔FCS matches only; ambiguous duplicates are omitted. */
  readonly matchedChannels: readonly string[];
  /** Matrix receivers with zero FCS occurrences. */
  readonly matrixOnlyChannels: readonly string[];
  /** Non-blank sample PnNs outside the matrix receiver axis. */
  readonly fcsOnlyChannels: readonly string[];
  /** Receiver-axis channels selected for the solve. */
  readonly includedChannels: readonly string[];
  /** Receiver-axis channels deliberately outside the solve. */
  readonly excludedChannels: readonly string[];
  readonly receiverOnlyChannels: readonly string[];
  readonly receiverOnlyIncludedChannels: readonly string[];
  /** Non-zero source→receiver coefficients omitted by the explicit included-channel set. */
  readonly excludedNonzeroEdges: readonly ExcludedMatrixEdge[];
  readonly duplicateSamplePnns: readonly string[];
  readonly blankSampleColumnIndices: readonly number[];
  readonly bindings: readonly MatrixChannelBinding[];
  readonly blockers: readonly MatrixCompatibilityBlock[];
  readonly warnings: readonly MatrixCompatibilityWarning[];
  readonly matrixWarnings: readonly MatrixValidationIssue[];
}

function normalizePnn(value: string): string {
  return value.trim().normalize("NFC");
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

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort(compareCodePoints);
}

function duplicateValues(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return sortedUnique(
    Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([value]) => value),
  );
}

function freezeBlock(
  code: CompatibilityBlockCode,
  message: string,
  channels: readonly string[] = [],
  fcsColumnIndices: readonly number[] = [],
  inputPositions: readonly number[] = [],
): MatrixCompatibilityBlock {
  return Object.freeze({
    code,
    message,
    channels: Object.freeze(Array.from(channels)),
    fcsColumnIndices: Object.freeze(Array.from(fcsColumnIndices).sort((a, b) => a - b)),
    inputPositions: Object.freeze(Array.from(inputPositions).sort((a, b) => a - b)),
  });
}

function freezeWarning(
  code: CompatibilityWarningCode,
  message: string,
  channels: readonly string[],
): MatrixCompatibilityWarning {
  return Object.freeze({
    code,
    message,
    channels: Object.freeze(Array.from(channels)),
  });
}

/**
 * Report exact matrix-to-FCS `$PnN` compatibility without changing either the
 * matrix or the requested solve set. Cosmetic keys, labels, and markers are
 * intentionally absent from this scientific identity boundary.
 */
export function reportMatrixCompatibility(
  request: MatrixCompatibilityRequest,
): MatrixCompatibilityReport {
  if (request == null || typeof request !== "object") {
    throw new Error("A compensation matrix compatibility request is required.");
  }
  const runtimeKind = (request as unknown as Record<string, unknown>).kind;
  if (runtimeKind !== "flow-spillover" && runtimeKind !== "cytof-spillover") {
    throw new Error(`Unsupported compensation kind '${String(runtimeKind)}'.`);
  }
  // This function accepts only the canonical output of the profile boundary.
  // The serialization assertion catches forged schemas/orientations/axes at runtime.
  serializeCanonicalCompensationMatrix(request.matrix);
  const matrixValidation = validateAndCanonicalizeCompensationMatrix(
    request.matrix,
    request.kind,
  );
  if (!matrixValidation.ok) {
    throw new Error(
      `Compensation matrix is not valid for ${request.kind}: ${matrixValidation.errors
        .map(({ message }) => message)
        .join(" ")}`,
    );
  }

  const blockers: MatrixCompatibilityBlock[] = [];
  const warnings: MatrixCompatibilityWarning[] = [];
  const sampleGroups = new Map<string, number[]>();
  const blankSampleColumnIndices: number[] = [];
  const invalidSampleEntries: number[] = [];
  const sampleColumnIndices: number[] = [];

  const runtimeChannels = request.sampleChannels as unknown;
  if (!Array.isArray(runtimeChannels)) {
    blockers.push(
      freezeBlock(
        "invalid-sample-channel",
        "Sample channels must be an array of exact $PnN identities and FCS column indices.",
      ),
    );
  } else {
    for (let sampleIndex = 0; sampleIndex < runtimeChannels.length; sampleIndex++) {
      const candidate = runtimeChannels[sampleIndex] as unknown;
      if (candidate == null || typeof candidate !== "object") {
        invalidSampleEntries.push(sampleIndex);
        continue;
      }
      const channel = candidate as Record<string, unknown>;
      if (
        typeof channel.pnn !== "string" ||
        typeof channel.columnIndex !== "number" ||
        !Number.isSafeInteger(channel.columnIndex) ||
        channel.columnIndex < 0
      ) {
        invalidSampleEntries.push(sampleIndex);
        continue;
      }
      const pnn = normalizePnn(channel.pnn);
      const columnIndex = channel.columnIndex;
      sampleColumnIndices.push(columnIndex);
      if (pnn.length === 0) {
        blankSampleColumnIndices.push(columnIndex);
        continue;
      }
      const columns = sampleGroups.get(pnn) ?? [];
      columns.push(columnIndex);
      sampleGroups.set(pnn, columns);
    }
  }

  if (invalidSampleEntries.length > 0) {
    blockers.push(
      freezeBlock(
        "invalid-sample-channel",
        "One or more sample channel records lack a string $PnN or a non-negative integer FCS column index.",
        [],
        [],
        invalidSampleEntries,
      ),
    );
  }
  const duplicateColumnIndices = duplicateValues(sampleColumnIndices.map(String)).map(Number);
  if (duplicateColumnIndices.length > 0) {
    blockers.push(
      freezeBlock(
        "duplicate-fcs-column-index",
        "More than one resolved sample channel points to the same FCS data column.",
        [],
        duplicateColumnIndices,
      ),
    );
  }
  blankSampleColumnIndices.sort((a, b) => a - b);
  if (blankSampleColumnIndices.length > 0) {
    blockers.push(
      freezeBlock(
        "blank-sample-pnn",
        "Every sample channel needs a non-blank $PnN identity before compensation can be applied.",
        [],
        blankSampleColumnIndices,
      ),
    );
  }

  const duplicateSamplePnns = sortedUnique(
    Array.from(sampleGroups.entries())
      .filter(([, columns]) => columns.length > 1)
      .map(([pnn]) => pnn),
  );
  if (duplicateSamplePnns.length > 0) {
    blockers.push(
      freezeBlock(
        "duplicate-sample-pnn",
        "Duplicate sample $PnN identities are ambiguous and cannot be matched by display name or position.",
        duplicateSamplePnns,
        duplicateSamplePnns.flatMap((pnn) => sampleGroups.get(pnn) ?? []),
      ),
    );
  }

  const receiverChannels = matrixValidation.value.receiverChannels;
  const sourceChannels = matrixValidation.value.sourceChannels;
  const receiverSet = new Set(receiverChannels);
  const sourceSet = new Set(sourceChannels);
  const uniqueSamplePnns = sortedUnique(sampleGroups.keys());
  const matrixOnlyChannels = receiverChannels.filter((pnn) => !sampleGroups.has(pnn));
  const fcsOnlyChannels = uniqueSamplePnns.filter((pnn) => !receiverSet.has(pnn));
  const matchedChannels = receiverChannels.filter(
    (pnn) => sampleGroups.get(pnn)?.length === 1,
  );

  if (matchedChannels.length === 0) {
    blockers.push(
      freezeBlock(
        "empty-overlap",
        "The matrix receiver channels have no unique exact $PnN matches in this FCS file.",
      ),
    );
  }

  let includedChannels: string[];
  let excludedChannels: string[];
  if (request.kind === "flow-spillover") {
    includedChannels = Array.from(receiverChannels);
    excludedChannels = [];
    if (matrixOnlyChannels.length > 0) {
      blockers.push(
        freezeBlock(
          "missing-flow-channel",
          "Conventional-flow compensation requires every matrix channel to be present in the FCS file.",
          matrixOnlyChannels,
        ),
      );
    }
  } else {
    const runtimeIncluded = request.includedChannels as unknown;
    const includedInput = Array.isArray(runtimeIncluded) ? runtimeIncluded : [];
    const normalizedIncluded: string[] = [];
    const invalidIncludedPositions: number[] = [];
    for (let index = 0; index < includedInput.length; index++) {
      if (typeof includedInput[index] !== "string") {
        invalidIncludedPositions.push(index);
      } else {
        normalizedIncluded.push(normalizePnn(includedInput[index]));
      }
    }
    if (!Array.isArray(runtimeIncluded) || invalidIncludedPositions.length > 0) {
      blockers.push(
        freezeBlock(
          "included-channel-not-receiver",
          "Included CyTOF channels must be an array of exact matrix receiver $PnN identities.",
          [],
          [],
          invalidIncludedPositions,
        ),
      );
    }
    const blankIncluded = normalizedIncluded.filter((pnn) => pnn.length === 0);
    if (blankIncluded.length > 0) {
      blockers.push(
        freezeBlock(
          "blank-included-channel",
          "The CyTOF included-channel set contains a blank identity.",
        ),
      );
    }
    const duplicateIncluded = duplicateValues(normalizedIncluded.filter(Boolean));
    if (duplicateIncluded.length > 0) {
      blockers.push(
        freezeBlock(
          "duplicate-included-channel",
          "The CyTOF included-channel set contains duplicate identities.",
          duplicateIncluded,
        ),
      );
    }
    const requestedSet = new Set(normalizedIncluded.filter(Boolean));
    const unknownIncluded = sortedUnique(
      Array.from(requestedSet).filter((pnn) => !receiverSet.has(pnn)),
    );
    if (unknownIncluded.length > 0) {
      blockers.push(
        freezeBlock(
          "included-channel-not-receiver",
          "Included CyTOF channels must exist on the matrix receiver axis.",
          unknownIncluded,
        ),
      );
    }
    includedChannels = receiverChannels.filter((pnn) => requestedSet.has(pnn));
    excludedChannels = receiverChannels.filter((pnn) => !requestedSet.has(pnn));
    if (includedChannels.length === 0) {
      blockers.push(
        freezeBlock(
          "empty-included-channels",
          "At least one matrix receiver channel must be explicitly included in the CyTOF solve.",
        ),
      );
    }
    const missingIncluded = includedChannels.filter((pnn) => !sampleGroups.has(pnn));
    if (missingIncluded.length > 0) {
      blockers.push(
        freezeBlock(
          "missing-included-channel",
          "One or more included CyTOF channels are absent from the FCS file.",
          missingIncluded,
        ),
      );
    }
    const ambiguousIncluded = includedChannels.filter(
      (pnn) => (sampleGroups.get(pnn)?.length ?? 0) > 1,
    );
    if (ambiguousIncluded.length > 0) {
      blockers.push(
        freezeBlock(
          "ambiguous-included-channel",
          "One or more included CyTOF channels have duplicate sample $PnN identities.",
          ambiguousIncluded,
          ambiguousIncluded.flatMap((pnn) => sampleGroups.get(pnn) ?? []),
        ),
      );
    }
  }

  const includedSet = new Set(includedChannels);
  const receiverOnlyChannels = receiverChannels.filter((pnn) => !sourceSet.has(pnn));
  const receiverOnlyIncludedChannels = receiverOnlyChannels.filter((pnn) =>
    includedSet.has(pnn),
  );
  const excludedNonzeroEdges: ExcludedMatrixEdge[] = [];
  let hasIncludedOffDiagonal = false;
  for (let sourceIndex = 0; sourceIndex < sourceChannels.length; sourceIndex++) {
    const sourcePnn = sourceChannels[sourceIndex];
    for (let receiverIndex = 0; receiverIndex < receiverChannels.length; receiverIndex++) {
      const receiverPnn = receiverChannels[receiverIndex];
      const coefficient = matrixValidation.value.matrix[sourceIndex][receiverIndex];
      if (sourcePnn === receiverPnn || coefficient === 0) continue;
      if (includedSet.has(sourcePnn) && includedSet.has(receiverPnn)) {
        hasIncludedOffDiagonal = true;
      } else if (request.kind === "cytof-spillover") {
        excludedNonzeroEdges.push(
          Object.freeze({ sourcePnn, receiverPnn, coefficient }),
        );
      }
    }
  }
  if (includedChannels.length > 0 && !hasIncludedOffDiagonal) {
    warnings.push(
      freezeWarning(
        "identity-solve",
        request.kind === "flow-spillover"
          ? "The selected channels produce an identity-only solve, so applying this profile cannot change event values."
          : "The selected channels produce an identity-only NNLS solve: it cannot redistribute spill between channels and can only enforce non-negativity.",
        includedChannels,
      ),
    );
  }
  if (excludedNonzeroEdges.length > 0) {
    warnings.push(
      freezeWarning(
        "nonzero-edges-excluded",
        `${excludedNonzeroEdges.length} non-zero source→receiver spill coefficients are omitted by the included-channel set.`,
        sortedUnique(
          excludedNonzeroEdges.flatMap(({ sourcePnn, receiverPnn }) => [sourcePnn, receiverPnn]),
        ),
      ),
    );
  }

  const bindings = matchedChannels.map((pnn) => {
    const columns = sampleGroups.get(pnn)!;
    return Object.freeze({
      pnn,
      fcsColumnIndex: columns[0],
      matrixSourceIndex: sourceSet.has(pnn) ? sourceChannels.indexOf(pnn) : null,
      matrixReceiverIndex: receiverChannels.indexOf(pnn),
      included: includedSet.has(pnn),
    });
  });

  const frozenBlockers = Object.freeze(Array.from(blockers));
  const frozenWarnings = Object.freeze(Array.from(warnings));
  return Object.freeze({
    canApply: frozenBlockers.length === 0,
    requiresReview: frozenWarnings.length > 0 || matrixValidation.warnings.length > 0,
    matchedChannels: Object.freeze(Array.from(matchedChannels)),
    matrixOnlyChannels: Object.freeze(Array.from(matrixOnlyChannels)),
    fcsOnlyChannels: Object.freeze(Array.from(fcsOnlyChannels)),
    includedChannels: Object.freeze(Array.from(includedChannels)),
    excludedChannels: Object.freeze(Array.from(excludedChannels)),
    receiverOnlyChannels: Object.freeze(Array.from(receiverOnlyChannels)),
    receiverOnlyIncludedChannels: Object.freeze(Array.from(receiverOnlyIncludedChannels)),
    excludedNonzeroEdges: Object.freeze(Array.from(excludedNonzeroEdges)),
    duplicateSamplePnns: Object.freeze(Array.from(duplicateSamplePnns)),
    blankSampleColumnIndices: Object.freeze(Array.from(blankSampleColumnIndices)),
    bindings: Object.freeze(bindings),
    blockers: frozenBlockers,
    warnings: frozenWarnings,
    matrixWarnings: Object.freeze(Array.from(matrixValidation.warnings)),
  });
}
