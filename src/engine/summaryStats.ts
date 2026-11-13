// summaryStats.ts — the summaries of a set of values that the Statistics tab, the per-cell chart
// and the Layout chart share: the type-7 quantile, the median, the mean, the sample SD, the
// geometric mean of the positive values, and Tukey's box. One definition of each, pure; the
// modules that show them keep their own names for them and call these.

/** The p-th quantile of ascending values, linear between order statistics (R's type 7); NaN for none. */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

/** The median of ascending values: the middle value, or the mean of the middle two for an even count; NaN for none. */
export function medianSorted(sorted: ArrayLike<number>): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const m = Math.floor(n / 2);
  return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/** The median of values in any order (as R's median); the values are not changed. */
export function median(values: readonly number[]): number {
  return medianSorted([...values].sort((a, b) => a - b));
}

/** The mean, summed in the order given; NaN for none. */
export function mean(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return NaN;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  return sum / n;
}

/** The sample standard deviation (denominator n - 1, as R's sd); NaN for fewer than two values. */
export function sampleSd(values: ArrayLike<number>): number {
  const n = values.length;
  if (n < 2) return NaN;
  const m = mean(values);
  let s = 0;
  for (let i = 0; i < n; i++) s += (values[i] - m) * (values[i] - m);
  return Math.sqrt(s / (n - 1));
}

/** The geometric mean of the positive values, and how many there were; NaN when none is positive. */
export function geometricMean(values: ArrayLike<number>): { value: number; used: number } {
  let logs = 0;
  let used = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > 0) {
      logs += Math.log(values[i]);
      used++;
    }
  }
  return { value: used ? Math.exp(logs / used) : NaN, used };
}

export interface TukeyBox {
  q1: number;
  median: number;
  q3: number;
  /** Whisker ends: the most extreme values within 1.5 × IQR of the quartiles. */
  lo: number;
  hi: number;
  min: number;
  max: number;
}

/** Tukey's box of ascending values: type-7 quartiles and median, and the whisker ends; NaN for none. */
export function tukeyBox(sorted: ArrayLike<number>): TukeyBox {
  const n = sorted.length;
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  const reach = 1.5 * (q3 - q1);
  // The first value at or above the lower fence, and the last at or below the upper one.
  let a = 0;
  let b = n;
  while (a < b) {
    const m = (a + b) >> 1;
    if (sorted[m] < q1 - reach) a = m + 1;
    else b = m;
  }
  const loIndex = a;
  a = 0;
  b = n;
  while (a < b) {
    const m = (a + b) >> 1;
    if (sorted[m] <= q3 + reach) a = m + 1;
    else b = m;
  }
  const hiIndex = a - 1;
  return {
    q1,
    median: quantileSorted(sorted, 0.5),
    q3,
    lo: n ? sorted[Math.min(loIndex, n - 1)] : NaN,
    hi: n ? sorted[Math.max(hiIndex, 0)] : NaN,
    min: n ? sorted[0] : NaN,
    max: n ? sorted[n - 1] : NaN,
  };
}
