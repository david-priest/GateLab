// The shared summaries against the copies they replaced. Each copy below is the code as it stood
// before summaryStats.ts, verbatim; the wrapper that now stands in its place must give the same
// bits (Object.is) on random values and on the edge cases: none, one, ties, negatives, ±0, NaN,
// ±Infinity, odd and even counts, in plain arrays, Float32Array and Float64Array.

import { describe, expect, it } from "vitest";
import { cellBoxStats, cellStatistic, sortedQuantile } from "./cellValuesModel";
import { quantile as proportionsQuantile } from "./proportions";
import { quantile as layoutQuantile, summarise, type ChartPoint } from "./layoutChart";
import { summariseStatistic } from "../ui/StatisticChart";
import { geometricMean, mean, median, medianSorted, quantileSorted, sampleSd } from "./summaryStats";

// --- The copies as they were ---------------------------------------------------------------

// stats.ts
function oldStatsMedian(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  const m = Math.floor(n / 2);
  return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function oldStatsMean(v: number[]): number {
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
}
function oldStatsStddev(v: number[]): number {
  const n = v.length;
  if (n < 2) return NaN;
  const m = oldStatsMean(v);
  let s = 0;
  for (const x of v) s += (x - m) * (x - m);
  return Math.sqrt(s / (n - 1));
}
function oldStatsGeomean(v: number[]): number {
  const pos = v.filter((x) => x > 0);
  if (pos.length === 0) return NaN;
  let s = 0;
  for (const x of pos) s += Math.log(x);
  return Math.exp(s / pos.length);
}

// cellValuesModel.ts
function oldSortedQuantile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}
function oldCellBoxStats(sorted: ArrayLike<number>) {
  const n = sorted.length;
  const q1 = oldSortedQuantile(sorted, 0.25);
  const q3 = oldSortedQuantile(sorted, 0.75);
  const reach = 1.5 * (q3 - q1);
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
    median: oldSortedQuantile(sorted, 0.5),
    q3,
    lo: n ? sorted[Math.min(loIndex, n - 1)] : NaN,
    hi: n ? sorted[Math.max(hiIndex, 0)] : NaN,
    min: n ? sorted[0] : NaN,
    max: n ? sorted[n - 1] : NaN,
  };
}
function oldCellStatistic(sorted: ArrayLike<number>, statistic: "median" | "mean" | "geomean"): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (statistic === "median") {
    const m = Math.floor(n / 2);
    return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  }
  if (statistic === "mean") {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sorted[i];
    return sum / n;
  }
  let logs = 0;
  let positive = 0;
  for (let i = 0; i < n; i++) {
    if (sorted[i] > 0) {
      logs += Math.log(sorted[i]);
      positive++;
    }
  }
  return positive ? Math.exp(logs / positive) : NaN;
}

// proportions.ts
function oldProportionsQuantile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

// layoutChart.ts (summarise's mean and SD; its quantile is unchanged)
function oldSummariseMeanSd(values: number[]): { mean: number; sd: number } {
  const n = values.length;
  const mean = n ? values.reduce((a, b) => a + b, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, sd };
}

// StatisticChart.tsx (summariseStatistic's mean and SD; its box was cellBoxStats already)
function oldSummariseStatistic(values: readonly number[]) {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  const mean = n ? sorted.reduce((a, b) => a + b, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(sorted.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const box = oldCellBoxStats(sorted);
  return { n, mean, sd, sem: n > 0 ? sd / Math.sqrt(n) : 0, median: box.median, q1: box.q1, q3: box.q3, lo: box.lo, hi: box.hi };
}

// --- Inputs --------------------------------------------------------------------------------

/** A deterministic generator (mulberry32), so a failure can be reproduced. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPECIAL = [0, -0, NaN, Infinity, -Infinity, 1, -1, 1e-300, -1e300, 5e-324];

function inputs(): number[][] {
  const r = rng(18);
  const out: number[][] = [[], [0], [-0], [NaN], [Infinity], [-Infinity], [3], [-2.5], [1, 1], [0, -0], [-0, 0], [2, 2, 2], [1, 2], [1, 2, 3], [-3, -1, 0, 4], [1e308, 1e308, -1e308]];
  for (let k = 0; k < 3000; k++) {
    const n = Math.floor(r() * 41);
    const kind = k % 5;
    const values: number[] = [];
    for (let i = 0; i < n; i++) {
      if (kind === 0) values.push((r() - 0.5) * 10 ** Math.floor(r() * 12 - 4)); // spread, signed
      else if (kind === 1) values.push(Math.floor(r() * 6) - 2); // ties, negatives, zero
      else if (kind === 2) values.push(r() * 262144); // a channel's raw range
      else if (kind === 3) values.push(r() < 0.2 ? SPECIAL[Math.floor(r() * SPECIAL.length)] : (r() - 0.3) * 1000); // edge values mixed in
      else values.push(Math.exp(r() * 20 - 5)); // positive, skewed
    }
    out.push(values);
  }
  return out;
}

const INPUTS = inputs();
const PROBS = [0, 0.002, 0.05, 0.25, 0.5, 0.75, 0.95, 0.998, 1];

/** The same values as a plain array, a Float32Array and a Float64Array, each unsorted and sorted. */
function forms(values: number[]): ArrayLike<number>[] {
  const f32 = Float32Array.from(values);
  const f64 = Float64Array.from(values);
  return [values, [...values].sort((a, b) => a - b), f32, Float32Array.from(f32).sort(), f64, Float64Array.from(f64).sort()];
}

function same(a: number, b: number): boolean {
  return Object.is(a, b);
}

function sameFields(a: Record<string, number>, b: Record<string, number>): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => same(a[k], b[k]));
}

// --- Bit-for-bit ---------------------------------------------------------------------------

describe("summaryStats against the copies it replaced", () => {
  it("gives stats.ts's median, mean, SD and geometric mean bit for bit", () => {
    let checked = 0;
    for (const values of INPUTS) {
      for (const form of forms(values)) {
        const v = Array.from(form);
        expect(same(median(v), oldStatsMedian(v)), `median ${v}`).toBe(true);
        expect(same(mean(v), oldStatsMean(v)), `mean ${v}`).toBe(true);
        expect(same(sampleSd(v), oldStatsStddev(v)), `sd ${v}`).toBe(true);
        expect(same(geometricMean(v).value, oldStatsGeomean(v)), `geomean ${v}`).toBe(true);
        expect(geometricMean(v).used).toBe(v.filter((x) => x > 0).length);
        checked++;
      }
    }
    expect(checked).toBe(INPUTS.length * 6);
  });

  it("gives cellValuesModel.ts's quantile, box and statistic bit for bit", () => {
    for (const values of INPUTS) {
      for (const form of forms(values)) {
        for (const p of PROBS) expect(same(sortedQuantile(form, p), oldSortedQuantile(form, p)), `q${p} ${Array.from(form)}`).toBe(true);
        expect(sameFields({ ...cellBoxStats(form) }, oldCellBoxStats(form)), `box ${Array.from(form)}`).toBe(true);
        for (const s of ["median", "mean", "geomean"] as const) expect(same(cellStatistic(form, s), oldCellStatistic(form, s)), `${s} ${Array.from(form)}`).toBe(true);
        expect(same(medianSorted(form), oldCellStatistic(form, "median"))).toBe(true);
      }
    }
  });

  it("gives proportions.ts's quantile bit for bit, 0 for no values as before", () => {
    for (const values of INPUTS) {
      for (const form of forms(values)) {
        const v = Array.from(form);
        for (const p of PROBS) expect(same(proportionsQuantile(v, p), oldProportionsQuantile(v, p)), `q${p} ${v}`).toBe(true);
      }
    }
    expect(proportionsQuantile([], 0.5)).toBe(0);
  });

  it("gives layoutChart.ts's summarise bit for bit", () => {
    for (const values of INPUTS) {
      const points: ChartPoint[] = values.map((value, i) => ({ sampleId: `F${i}`, name: `F${i}.fcs`, group: "control", value }));
      const now = summarise("control", points);
      const was = oldSummariseMeanSd(values);
      expect(same(now.mean, was.mean), `mean ${values}`).toBe(true);
      expect(same(now.sd, was.sd), `sd ${values}`).toBe(true);
    }
  });

  it("gives StatisticChart.tsx's summariseStatistic bit for bit", () => {
    for (const values of INPUTS) {
      for (const form of forms(values)) {
        const v = Array.from(form);
        expect(sameFields({ ...summariseStatistic(v) }, oldSummariseStatistic(v)), `summary ${v}`).toBe(true);
      }
    }
  });

  it("keeps layoutChart.ts's quantile apart: it differs from the shared type-7 form", () => {
    // layoutChart's quantile takes the upper neighbour as ceil(h) and has no shortcut for one
    // value, so at a whole h it adds (x - x) × 0; the shared form returns a single value as it is
    // and otherwise takes lo + 1, adding (next - x) × 0, which is NaN when that step is infinite.
    expect(layoutQuantile([1, 2, Infinity], 0.5)).toBe(2);
    expect(quantileSorted([1, 2, Infinity], 0.5)).toBeNaN();
    expect(layoutQuantile([-1e308, 1e308], 0)).toBe(-1e308);
    expect(quantileSorted([-1e308, 1e308], 0)).toBeNaN();
    expect(Object.is(layoutQuantile([-0], 0.5), 0)).toBe(true);
    expect(Object.is(quantileSorted([-0], 0.5), -0)).toBe(true);
  });
});

