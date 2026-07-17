// axisRange.ts — robust initial axis limits for cytometry display data.
//
// A handful of extreme compensated events should not determine the whole view. GateLabR
// frames axes from the 0.1st–99.9th percentiles with 5% breathing room; this browser port
// uses the same rule. Very large files are sampled deterministically so opening a two-million
// event file does not add another full-column sort to initial rendering.

import { quantileType7 } from "./transforms";

const LOWER_QUANTILE = 0.001;
const UPPER_QUANTILE = 0.999;
const PADDING_FRACTION = 0.05;
const MAX_QUANTILE_SAMPLES = 100_000;

function finiteQuantileSample(values: ArrayLike<number>): number[] {
  const n = values.length;
  if (n === 0) return [];

  const sampleN = Math.min(n, MAX_QUANTILE_SAMPLES);
  const out: number[] = [];
  const denom = sampleN > 1 ? sampleN - 1 : 1;
  for (let i = 0; i < sampleN; i++) {
    const index = sampleN === n ? i : Math.round((i * (n - 1)) / denom);
    const value = values[index];
    if (Number.isFinite(value)) out.push(value);
  }

  // FCS display columns should be finite, but recover sensibly from a malformed column whose
  // sparse finite values happened to fall between the deterministic sample positions.
  if (out.length === 0 && sampleN < n) {
    for (let i = 0; i < n && out.length < MAX_QUANTILE_SAMPLES; i++) {
      const value = values[i];
      if (Number.isFinite(value)) out.push(value);
    }
  }

  out.sort((a, b) => a - b);
  return out;
}

/**
 * Initial display-space range. Outliers beyond the returned limits remain visible because the
 * main plot clamps event marks (but not gates) to the corresponding axis edge.
 */
export function robustAxisRange(values: ArrayLike<number>): [number, number] {
  const sorted = finiteQuantileSample(values);
  if (sorted.length === 0) return [0, 1];

  const lo = quantileType7(sorted, LOWER_QUANTILE);
  const hi = quantileType7(sorted, UPPER_QUANTILE);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];

  const span = hi - lo;
  const padding = (span < 1e-10 ? 1 : span) * PADDING_FRACTION;
  return [lo - padding, hi + padding];
}
