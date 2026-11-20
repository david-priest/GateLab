// controlHistogram.ts — a control's events on its own channel, binned for drawing.
//
// The scale is the one the split is read at (controlSplit.ts): arcsinh of the value over a
// cofactor, linear around zero and logarithmic above, so a negative peak around zero and a positive
// peak four decades up are both seen as peaks. The two boundaries the user drags are positions on
// this scale; they are stored in raw units.

import { quantileSorted, sortedValues } from "./controlFile";

export interface HistogramScale {
  readonly cofactor: number;
  /** The drawn extent, on the arcsinh scale. */
  readonly lo: number;
  readonly hi: number;
}

export const toScale = (value: number, cofactor: number): number => Math.asinh(value / cofactor);
export const fromScale = (position: number, cofactor: number): number => Math.sinh(position) * cofactor;

/**
 * The extent that shows the given columns: from the 0.1st to the 99.9th percentile of all of them
 * together, widened by a twentieth either side.
 */
export function histogramScale(columns: readonly (ArrayLike<number> | null)[], cofactor: number): HistogramScale | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const column of columns) {
    if (!column) continue;
    const sorted = sortedValues(column);
    if (sorted.length === 0) continue;
    lo = Math.min(lo, toScale(quantileSorted(sorted, 0.001), cofactor));
    hi = Math.max(hi, toScale(quantileSorted(sorted, 0.999), cofactor));
  }
  if (!(hi > lo)) return null;
  const pad = (hi - lo) / 20;
  return { cofactor, lo: lo - pad, hi: hi + pad };
}

/** Counts per bin over the scale's extent; values outside it are counted in the first and last bins. */
export function histogramCounts(
  column: ArrayLike<number>,
  scale: HistogramScale,
  bins: number,
  events?: ArrayLike<number> | null,
): Uint32Array {
  const counts = new Uint32Array(bins);
  const width = (scale.hi - scale.lo) / bins;
  const n = events ? events.length : column.length;
  for (let k = 0; k < n; k++) {
    const value = column[events ? events[k] : k];
    if (!Number.isFinite(value)) continue;
    const bin = Math.floor((toScale(value, scale.cofactor) - scale.lo) / width);
    counts[Math.max(0, Math.min(bins - 1, bin))]++;
  }
  return counts;
}

export interface ScaleTick {
  /** Raw value. */
  readonly value: number;
  /** Position between 0 (lo) and 1 (hi). */
  readonly at: number;
  readonly label: string;
}

const SUPERSCRIPT = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];

/** Zero and the powers of ten within the extent, negative ones included, that are not crowded into the linear part. */
export function scaleTicks(scale: HistogramScale): ScaleTick[] {
  const ticks: ScaleTick[] = [];
  const place = (value: number, label: string) => {
    const at = (toScale(value, scale.cofactor) - scale.lo) / (scale.hi - scale.lo);
    if (at >= 0 && at <= 1) ticks.push({ value, at, label });
  };
  place(0, "0");
  for (let exponent = 1; exponent <= 9; exponent++) {
    const value = 10 ** exponent;
    // A decade inside the linear part of the scale sits on top of zero.
    if (value < 3 * scale.cofactor) continue;
    const label = `10${String(exponent).split("").map((digit) => SUPERSCRIPT[Number(digit)]).join("")}`;
    place(value, label);
    place(-value, `-${label}`);
  }
  return ticks.sort((a, b) => a.at - b.at);
}
