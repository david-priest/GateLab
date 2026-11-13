// rankTests.ts — rank tests between more than two groups and between paired values, matching R:
// Holm's adjustment as p.adjust(p, "holm"), every pair of groups by the Wilcoxon rank-sum test as
// pairwise.wilcox.test(values, groups, p.adjust.method = "holm"), and the Wilcoxon signed-rank
// test as wilcox.test(a, b, paired = TRUE). Pure; the rank-sum test itself is layoutChart's.

import { formatP, normalUpperTail, wilcoxonRankSum } from "./layoutChart";

export interface PairwiseComparison {
  /** Indices of the two groups compared, a < b. */
  a: number;
  b: number;
  /** The Mann–Whitney U of group a against group b; null when the pair was not tested. */
  statistic: number | null;
  p: number | null;
  pAdjusted: number | null;
}

export interface SignedRankTest {
  name: "Wilcoxon signed-rank";
  /** V, the sum of the ranks of the positive differences a − b. */
  statistic: number;
  p: number;
  /** The number of non-zero differences. */
  n: number;
  label: string;
}

/**
 * Holm's step-down adjustment, as R's p.adjust(p, "holm"): the i-th smallest of n p values is
 * multiplied by n − i + 1, kept from falling below the ones before it and capped at 1. Nulls stay
 * null and are not counted in n.
 */
export function holmAdjust(p: readonly (number | null)[]): (number | null)[] {
  const order = p
    .map((value, index) => ({ value, index }))
    .filter((e): e is { value: number; index: number } => e.value !== null)
    .sort((x, y) => x.value - y.value || x.index - y.index);
  const n = order.length;
  const out: (number | null)[] = p.map(() => null);
  let running = 0;
  order.forEach(({ value, index }, i) => {
    running = Math.max(running, (n - i) * value);
    out[index] = Math.min(1, running);
  });
  return out;
}

/**
 * Every pair of groups (i < j) by the Wilcoxon rank-sum test, Holm-adjusted across the pairs
 * tested, as R's pairwise.wilcox.test(values, groups, p.adjust.method = "holm"). Unlike R, which
 * tests a pair with a single value on a side, a pair with fewer than two values on a side is not
 * tested here (wilcoxonRankSum declines it): its p and adjusted p are null and it is not counted
 * in the adjustment.
 */
export function pairwiseWilcoxon(groups: readonly (readonly number[])[]): PairwiseComparison[] {
  const pairs: PairwiseComparison[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const test = wilcoxonRankSum(groups[i], groups[j]);
      pairs.push({ a: i, b: j, statistic: test?.statistic ?? null, p: test?.p ?? null, pAdjusted: null });
    }
  }
  const adjusted = holmAdjust(pairs.map((pair) => pair.p));
  pairs.forEach((pair, k) => (pair.pAdjusted = adjusted[k]));
  return pairs;
}

/**
 * The number of subsets of the ranks 1..n with each rank sum s, the distribution of V under the
 * null hypothesis times 2^n, as R's psignrank counts it. Counted by adding only, so every count up
 * to 2^49 is exact.
 */
function signedRankCounts(n: number): Float64Array {
  const maxSum = (n * (n + 1)) / 2;
  const ways = new Float64Array(maxSum + 1);
  ways[0] = 1;
  for (let rank = 1; rank <= n; rank++) {
    for (let s = (rank * (rank + 1)) / 2; s >= rank; s--) ways[s] += ways[s - rank];
  }
  return ways;
}

/**
 * The Wilcoxon signed-rank test on paired values, two-sided, as R's wilcox.test(a, b, paired =
 * TRUE) computes it by default. Zero differences are dropped. Exact when fewer than 50 non-zero
 * differences remain, none was dropped as zero and no absolute differences are tied; otherwise by
 * the normal approximation with the tie correction and a continuity correction. Both tails of
 * the exact distribution are counted, so a far tail keeps its precision. Returns null when the
 * arrays differ in length or fewer than two non-zero differences remain.
 */
export function wilcoxonSignedRank(a: readonly number[], b: readonly number[]): SignedRankTest | null {
  if (a.length !== b.length) return null;
  const all = a.map((v, i) => v - b[i]);
  const zeroes = all.some((d) => d === 0);
  const diffs = all.filter((d) => d !== 0);
  const n = diffs.length;
  if (n < 2) return null;
  // Ranks of the absolute differences, ties averaged, and the tie term Σ(t³ − t).
  const index = diffs.map((d, i) => ({ v: Math.abs(d), i })).sort((x, y) => x.v - y.v);
  const rank = new Array<number>(n);
  let ties = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && index[j + 1].v === index[i].v) j++;
    const t = j - i + 1;
    for (let k = i; k <= j; k++) rank[index[k].i] = (i + j) / 2 + 1;
    if (t > 1) ties += t ** 3 - t;
    i = j + 1;
  }
  const v = diffs.reduce((s, d, i) => (d > 0 ? s + rank[i] : s), 0);
  const centre = (n * (n + 1)) / 4;
  let p: number;
  if (n < 50 && !zeroes && ties === 0) {
    // R: psignrank(V - 1, n, lower.tail = FALSE) above the centre, psignrank(V, n) below it.
    const ways = signedRankCounts(n);
    let tail = 0;
    if (v > centre) for (let s = v; s < ways.length; s++) tail += ways[s];
    else for (let s = 0; s <= v; s++) tail += ways[s];
    p = Math.min(1, (2 * tail) / 2 ** n);
  } else {
    const sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - ties / 48);
    const d = v - centre;
    const z = (d - 0.5 * Math.sign(d)) / sigma;
    p = Math.min(1, 2 * normalUpperTail(Math.abs(z)));
  }
  return { name: "Wilcoxon signed-rank", statistic: v, p, n, label: `Wilcoxon signed-rank ${formatP(p)}` };
}
