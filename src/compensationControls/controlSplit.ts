// controlSplit.ts — where a control's negative events end and its positive events begin.
//
// On the control's own channel, read on an arcsinh scale: the deepest valley between two peaks of
// the histogram is the cut. The control has a negative population of its own ("bimodal") where the
// valley is deep and the two sides are far apart for their widths. The two boundaries the user can
// drag start from the cut and are drawn in to within three robust SDs of each peak, so events in
// the valley belong to neither set.
//
// A spillover coefficient is a ratio of differences, and any subset of the positive events gives
// the same ratio in expectation, so where exactly the boundaries sit changes the noise of the
// estimate and not its target.

import { quantileSorted, robustCentre, sortedValues } from "./controlFile";

/** Histogram bins on the arcsinh scale, between the 0.1st and 99.9th percentiles. */
const BINS = 64;
/** Fewest events either side of a cut, and as a fraction of the events: a few outliers past a gap are not a population. */
export const MIN_SIDE_EVENTS = 20;
const MIN_SIDE_FRACTION = 0.005;
/** The valley's count as a fraction of the lower of the two peaks, at most, for two populations. */
const MAX_VALLEY_RATIO = 0.5;
/** Ashman's D between the two sides, at least, for two populations. A single normal peak cut at its middle gives about 2.3. */
const MIN_SEPARATION = 3;
/** Boundaries are drawn in to this many robust SDs from each peak. */
const PEAK_WIDTHS = 3;

export interface ControlSplit {
  /** True where the values hold a negative and a positive population of their own. */
  readonly bimodal: boolean;
  /** The cut between the two sides, raw units. */
  readonly cut: number;
  /** Negative events: values below this. Raw units. */
  readonly negativeUpper: number;
  /** Positive events: values at or above this. Raw units. */
  readonly positiveLower: number;
  readonly negativeCount: number;
  readonly positiveCount: number;
  /** Ashman's D between the sides of the cut, on the arcsinh scale. */
  readonly separation: number;
  /** The valley's count over the lower peak's count. */
  readonly valleyRatio: number;
  /** The arcsinh cofactor the split was read at. */
  readonly cofactor: number;
  /**
   * Robust SD of each side of the cut on the arcsinh scale. For a bright peak this is close to its
   * coefficient of variation: about 0.1 for a bead peak, several times that for a cell population.
   */
  readonly negativeSpread: number;
  readonly positiveSpread: number;
}

/**
 * The cofactor a channel's split is read at: the range over 2000 (131 for an 18-bit instrument),
 * and never less than the width of the lowest values (5th minus 0.5th percentile, about one SD of
 * a negative population), so that noise around zero stays in the linear part of the scale and is
 * not pulled apart into two peaks.
 */
export function splitCofactor(sorted: Float64Array, range: number): number {
  const lowWidth = quantileSorted(sorted, 0.05) - quantileSorted(sorted, 0.005);
  return Math.max(range > 0 ? range / 2000 : 0, Number.isFinite(lowWidth) ? lowWidth : 0, 1e-6);
}

function countBelow(sorted: Float64Array, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Splits a control's values on its own channel. `events` limits the split to a population (the
 * events of a scatter gate). Null where there are too few values to cut, or they are all equal.
 */
export function splitControl(
  values: ArrayLike<number>,
  range: number,
  events?: ArrayLike<number> | null,
): ControlSplit | null {
  const sorted = sortedValues(values, events);
  if (sorted.length < 2 * MIN_SIDE_EVENTS) return null;
  const cofactor = splitCofactor(sorted, range);
  const scaled = sorted.map((value) => Math.asinh(value / cofactor));
  const low = quantileSorted(scaled, 0.001);
  const high = quantileSorted(scaled, 0.999);
  if (!(high > low)) return null;

  const counts = new Float64Array(BINS);
  const width = (high - low) / BINS;
  for (let k = 0; k < scaled.length; k++) {
    counts[Math.min(BINS - 1, Math.max(0, Math.floor((scaled[k] - low) / width)))]++;
  }
  const smooth = counts.map((_, bin) =>
    (counts[Math.max(0, bin - 1)] + counts[bin] + counts[Math.min(BINS - 1, bin + 1)]) / 3);
  const peakLeft = new Float64Array(BINS);
  const peakRight = new Float64Array(BINS);
  for (let bin = 1; bin < BINS; bin++) peakLeft[bin] = Math.max(peakLeft[bin - 1], smooth[bin - 1]);
  for (let bin = BINS - 2; bin >= 0; bin--) peakRight[bin] = Math.max(peakRight[bin + 1], smooth[bin + 1]);

  // The deepest valley: the bin whose count is furthest below the lower of the peaks either side.
  // A wide empty valley gives a run of equal depths; its middle bin is taken.
  let bestDepth = -Infinity;
  let runStart = 0;
  let runEnd = 0;
  for (let bin = 1; bin < BINS - 1; bin++) {
    const depth = Math.min(peakLeft[bin], peakRight[bin]) - smooth[bin];
    if (depth > bestDepth + 1e-9) {
      bestDepth = depth;
      runStart = bin;
      runEnd = bin;
    } else if (Math.abs(depth - bestDepth) <= 1e-9 && bin === runEnd + 1) {
      runEnd = bin;
    }
  }
  const valleyBin = (runStart + runEnd) >> 1;
  const cutScaled = low + (valleyBin + 0.5) * width;
  const below = countBelow(scaled, cutScaled);
  const lowerPeak = Math.min(peakLeft[valleyBin], peakRight[valleyBin]);
  const valleyRatio = lowerPeak > 0 ? smooth[valleyBin] / lowerPeak : 1;

  const negative = robustCentre(scaled.slice(0, below));
  const positive = robustCentre(scaled.slice(below));
  const spread = Math.hypot(negative.rsd, positive.rsd);
  const separation = below === 0 || below === scaled.length
    ? 0
    : spread > 0 ? (Math.SQRT2 * (positive.median - negative.median)) / spread : Infinity;
  const minSide = Math.max(MIN_SIDE_EVENTS, MIN_SIDE_FRACTION * scaled.length);
  const bimodal =
    below >= minSide &&
    scaled.length - below >= minSide &&
    valleyRatio <= MAX_VALLEY_RATIO &&
    separation >= MIN_SEPARATION;

  const raw = (value: number): number => Math.sinh(value) * cofactor;
  const cut = raw(cutScaled);
  let negativeUpper = bimodal ? Math.min(cut, raw(negative.median + PEAK_WIDTHS * negative.rsd)) : cut;
  let positiveLower = bimodal ? Math.max(cut, raw(positive.median - PEAK_WIDTHS * positive.rsd)) : cut;
  // A side whose values are all but equal (a pile at the top of the range) has no width, and a
  // boundary drawn in to it would leave the side empty: such a boundary stays at the cut.
  if (countBelow(sorted, negativeUpper) < below / 2) negativeUpper = cut;
  if (sorted.length - countBelow(sorted, positiveLower) < (sorted.length - below) / 2) positiveLower = cut;
  return {
    bimodal,
    cut,
    negativeUpper,
    positiveLower,
    negativeCount: countBelow(sorted, negativeUpper),
    positiveCount: sorted.length - countBelow(sorted, positiveLower),
    separation,
    valleyRatio,
    cofactor,
    negativeSpread: negative.rsd,
    positiveSpread: positive.rsd,
  };
}

/**
 * Where positive events begin when the negative events come from another file: the negative
 * file's 99th percentile on the control's channel, plus twice the distance from its median to
 * that percentile.
 */
export function positiveLowerFromNegative(sortedNegative: Float64Array): number {
  const p99 = quantileSorted(sortedNegative, 0.99);
  return p99 + 2 * (p99 - quantileSorted(sortedNegative, 0.5));
}
