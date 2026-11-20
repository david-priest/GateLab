// spilloverEstimate.ts — a spillover matrix from single-stained controls, by medians.
//
// For the control of channel i and every receiver j:
//
//   S[i][j] = (median_j(positive) - median_j(negative)) / (median_i(positive) - median_i(negative))
//
// Rows are the source and columns the receiver, with a diagonal of exactly 1: the orientation and
// the form GateLab stores and applies (compensated = measured · inverse(S)). Medians are R's
// median (the mean of the middle two for an even count), so the same events through
// flowCore::spillover's median method give the same numbers.
//
// A stored flow matrix holds no negative coefficient, so an estimate below zero is stored as 0;
// the estimate as calculated is kept beside it in the report. A channel with no control takes its
// row from a fallback matrix where one is given (the files' embedded matrix) and otherwise has no
// spillover, and the report says which.
//
// Nothing here applies a matrix: the result is a candidate for the Matrices list.

import { inspectFlowMatrix, type FlowMatrixDiagnostics } from "../engine/flowCompensationEngine";
import { eventIndices, medianSorted, robustCentre, sortedValues, type ControlFile, type EventSet } from "./controlFile";

/** Fewer positive or negative events than this is reported. */
export const FEW_EVENTS = 200;
/** Fewer than this and the control gives no row at all. */
export const MIN_EVENTS = 5;
/** Positive events at or above this fraction of the channel's range count as at the top of the range. */
const TOP_OF_RANGE = 0.99;
/** More than this fraction of positive events at the top of the range is reported. */
const SATURATED_FRACTION = 0.01;

/** One control: its channel, and the positive and negative events to compare. */
export interface ControlSpec {
  readonly channel: string;
  readonly positive: EventSet;
  readonly negative: EventSet;
}

export type EstimateWarning =
  | Readonly<{ code: "few-positive-events"; count: number }>
  | Readonly<{ code: "few-negative-events"; count: number }>
  /** The control is brighter in another channel than in its own: check it is assigned to the right channel. */
  | Readonly<{ code: "coefficient-above-one"; receiver: string; value: number }>
  | Readonly<{ code: "negative-set-to-zero"; count: number; receiver: string; lowest: number }>
  | Readonly<{ code: "positive-at-top-of-range"; fraction: number }>
  /** The median of the positive events is at the top of the range: the detector was saturated, and there is no row. */
  | Readonly<{ code: "saturated" }>
  /** The positive events are not above the negative events in the control's own channel: no row. */
  | Readonly<{ code: "no-signal" }>;

export interface ControlRow {
  readonly channel: string;
  /** Where the matrix row came from: a control, the fallback matrix, or nowhere (no spillover). */
  readonly source: "control" | "fallback" | "none";
  readonly positiveFileId: string | null;
  readonly negativeFileId: string | null;
  readonly positiveCount: number;
  readonly negativeCount: number;
  /** Medians in the control's own channel, raw units. */
  readonly positiveMedian: number;
  readonly negativeMedian: number;
  /** The row as calculated, before negative estimates are set to 0; null where no row was calculated. */
  readonly calculated: readonly number[] | null;
  /**
   * About one standard error of each calculated coefficient, from the spread of the receiver and of
   * the control's own channel in the two sets of events (the standard error of a median, 1.2533
   * robust SDs over the root of the count); null where no row was calculated.
   */
  readonly uncertainty: readonly number[] | null;
  readonly warnings: readonly EstimateWarning[];
}

export interface SpilloverEstimate {
  readonly channels: readonly string[];
  /** Rows source, columns receiver, diagonal 1, no negative coefficient. */
  readonly matrix: readonly (readonly number[])[];
  /** One per channel, in matrix order. */
  readonly rows: readonly ControlRow[];
  /** Condition and stability of the matrix; null where it cannot be inverted. */
  readonly diagnostics: FlowMatrixDiagnostics | null;
}

export interface SpilloverReference {
  readonly channels: readonly string[];
  readonly matrix: readonly (readonly number[])[];
}

function fileById(files: readonly ControlFile[], id: string): ControlFile {
  const file = files.find((candidate) => candidate.id === id);
  if (!file) throw new Error(`Compensation control file "${id}" is not among the files given.`);
  return file;
}

function column(file: ControlFile, channel: string): ArrayLike<number> {
  const values = file.values(channel);
  if (!values) throw new Error(`File "${file.fileName}" has no channel "${channel}".`);
  return values;
}

const emptyRow = (channel: string, source: "fallback" | "none"): ControlRow => ({
  channel,
  source,
  positiveFileId: null,
  negativeFileId: null,
  positiveCount: 0,
  negativeCount: 0,
  positiveMedian: NaN,
  negativeMedian: NaN,
  calculated: null,
  uncertainty: null,
  warnings: [],
});

/**
 * The matrix over `channels` from the controls given, at most one per channel. `fallback` supplies
 * the row of a channel that has no control or whose control gives no row.
 */
export function estimateSpillover(
  files: readonly ControlFile[],
  channels: readonly string[],
  controls: readonly ControlSpec[],
  fallback?: SpilloverReference | null,
): SpilloverEstimate {
  const specByChannel = new Map<string, ControlSpec>();
  for (const spec of controls) {
    if (!channels.includes(spec.channel)) throw new Error(`"${spec.channel}" is not a channel of the matrix.`);
    if (specByChannel.has(spec.channel)) throw new Error(`Two controls were given for "${spec.channel}".`);
    specByChannel.set(spec.channel, spec);
  }
  const fallbackIndex = new Map((fallback?.channels ?? []).map((channel, index) => [channel, index]));
  const fallbackRow = (i: number): number[] | null => {
    const source = fallbackIndex.get(channels[i]);
    if (fallback == null || source === undefined) return null;
    return channels.map((channel, j) => {
      const receiver = fallbackIndex.get(channel);
      return j === i ? 1 : receiver === undefined ? 0 : Math.max(0, fallback.matrix[source][receiver]);
    });
  };

  const matrix: number[][] = [];
  const rows: ControlRow[] = [];
  channels.forEach((channel, i) => {
    const spec = specByChannel.get(channel);
    const control = spec ? controlRow(files, channels, i, spec) : null;
    if (control?.calculated) {
      matrix.push(control.calculated.map((value, j) => (j === i ? 1 : Math.max(0, value))));
      rows.push(control);
      return;
    }
    const substitute = fallbackRow(i);
    matrix.push(substitute ?? channels.map((_, j) => (j === i ? 1 : 0)));
    rows.push({ ...(control ?? emptyRow(channel, "none")), source: substitute ? "fallback" : "none" });
  });

  let diagnostics: FlowMatrixDiagnostics | null = null;
  try {
    diagnostics = inspectFlowMatrix(matrix);
  } catch {
    diagnostics = null;
  }
  return { channels: [...channels], matrix, rows, diagnostics };
}

function controlRow(
  files: readonly ControlFile[],
  channels: readonly string[],
  i: number,
  spec: ControlSpec,
): ControlRow {
  const positiveFile = fileById(files, spec.positive.fileId);
  const negativeFile = fileById(files, spec.negative.fileId);
  const positiveOwn = column(positiveFile, spec.channel);
  const positiveEvents = eventIndices(spec.positive, positiveOwn);
  const negativeEvents = eventIndices(spec.negative, column(negativeFile, spec.channel));
  const base = {
    channel: spec.channel,
    source: "control" as const,
    positiveFileId: positiveFile.id,
    negativeFileId: negativeFile.id,
    positiveCount: positiveEvents.length,
    negativeCount: negativeEvents.length,
  };
  const warnings: EstimateWarning[] = [];
  if (positiveEvents.length < FEW_EVENTS) warnings.push({ code: "few-positive-events", count: positiveEvents.length });
  if (negativeEvents.length < FEW_EVENTS) warnings.push({ code: "few-negative-events", count: negativeEvents.length });
  if (positiveEvents.length < MIN_EVENTS || negativeEvents.length < MIN_EVENTS) {
    return { ...base, positiveMedian: NaN, negativeMedian: NaN, calculated: null, uncertainty: null, warnings };
  }

  // Per channel: the difference of the two medians, and about one standard error of it.
  const error = (sorted: Float64Array): number => (1.2533 * robustCentre(sorted).rsd) / Math.sqrt(sorted.length);
  const differenceError: number[] = [];
  const difference = channels.map((channel) => {
    const positive = sortedValues(column(positiveFile, channel), positiveEvents);
    const negative = sortedValues(column(negativeFile, channel), negativeEvents);
    differenceError.push(Math.hypot(error(positive), error(negative)));
    return medianSorted(positive) - medianSorted(negative);
  });
  const positiveSorted = sortedValues(positiveOwn, positiveEvents);
  const positiveMedian = medianSorted(positiveSorted);
  const negativeMedian = positiveMedian - difference[i];
  if (!(difference[i] > 0)) {
    return { ...base, positiveMedian, negativeMedian, calculated: null, uncertainty: null, warnings: [...warnings, { code: "no-signal" }] };
  }

  const range = positiveFile.channels.find((channel) => channel.pnn === spec.channel)?.range ?? 0;
  if (range > 0 && positiveMedian >= TOP_OF_RANGE * range) {
    // Most of the positive events are clipped at the top of the range: their true signal is not known.
    return { ...base, positiveMedian, negativeMedian, calculated: null, uncertainty: null, warnings: [...warnings, { code: "saturated" }] };
  }
  if (range > 0) {
    let atTop = 0;
    for (let k = positiveSorted.length - 1; k >= 0 && positiveSorted[k] >= TOP_OF_RANGE * range; k--) atTop++;
    const fraction = atTop / positiveSorted.length;
    if (fraction > SATURATED_FRACTION) warnings.push({ code: "positive-at-top-of-range", fraction });
  }

  const calculated = difference.map((value, j) => (j === i ? 1 : value / difference[i]));
  const uncertainty = calculated.map((value, j) =>
    (j === i ? 0 : Math.hypot(differenceError[j], value * differenceError[i]) / difference[i]));
  let lowest = -1;
  let negatives = 0;
  calculated.forEach((value, j) => {
    if (j === i) return;
    if (value > 1) warnings.push({ code: "coefficient-above-one", receiver: channels[j], value });
    if (value < 0) {
      negatives++;
      if (lowest < 0 || value < calculated[lowest]) lowest = j;
    }
  });
  if (negatives > 0) {
    warnings.push({ code: "negative-set-to-zero", count: negatives, receiver: channels[lowest], lowest: calculated[lowest] });
  }
  return { ...base, positiveMedian, negativeMedian, calculated, uncertainty, warnings };
}

export interface CoefficientDifference {
  readonly source: string;
  readonly receiver: string;
  readonly calculated: number;
  readonly reference: number;
  /** Calculated minus reference. */
  readonly difference: number;
  /** About one standard error of the calculated coefficient, where the calculated matrix is an estimate with rows. */
  readonly uncertainty: number | null;
}

/**
 * The calculated matrix against another over the channels both have (the files' embedded matrix):
 * every off-diagonal pair, the largest absolute difference first.
 */
export function compareSpillover(
  calculated: SpilloverReference & { readonly rows?: readonly ControlRow[] },
  reference: SpilloverReference,
): CoefficientDifference[] {
  const referenceIndex = new Map(reference.channels.map((channel, index) => [channel, index]));
  const out: CoefficientDifference[] = [];
  calculated.channels.forEach((source, i) => {
    const ri = referenceIndex.get(source);
    if (ri === undefined) return;
    calculated.channels.forEach((receiver, j) => {
      const rj = referenceIndex.get(receiver);
      if (i === j || rj === undefined) return;
      const value = calculated.matrix[i][j];
      const other = reference.matrix[ri][rj];
      out.push({
        source,
        receiver,
        calculated: value,
        reference: other,
        difference: value - other,
        uncertainty: calculated.rows?.[i]?.uncertainty?.[j] ?? null,
      });
    });
  });
  return out.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
}
