// layoutChart.ts — a summary chart for the Layout tab: one statistic of one population, taken
// per file, grouped by a metadata column, drawn as bars with points, points alone, or boxes, with
// a rank test between the groups in the spirit of ggpubr's stat_compare_means (Wilcoxon rank-sum
// for two groups, Kruskal–Wallis for more). The statistics live here, pure; LayoutChart.tsx draws.

export interface ChartPoint {
  sampleId: string;
  name: string;
  /** The metadata value the point is grouped by; "" when ungrouped. */
  group: string;
  value: number;
}

export interface ChartGroup {
  label: string;
  points: ChartPoint[];
  n: number;
  mean: number;
  sd: number;
  median: number;
  q1: number;
  q3: number;
  min: number;
  max: number;
}

export interface ChartTest {
  name: "Wilcoxon rank-sum" | "Kruskal–Wallis";
  statistic: number;
  p: number;
  label: string;
}

const sorted = (values: readonly number[]) => [...values].sort((a, b) => a - b);

/** The p-th quantile of sorted values, linear between order statistics (R's type 7). */
export function quantile(values: readonly number[], p: number): number {
  const s = sorted(values);
  if (!s.length) return NaN;
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (s[hi] - s[lo]) * (h - lo);
}

export function summarise(label: string, points: ChartPoint[]): ChartGroup {
  const values = points.map((p) => p.value);
  const n = values.length;
  const mean = n ? values.reduce((a, b) => a + b, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    label,
    points,
    n,
    mean,
    sd,
    median: quantile(values, 0.5),
    q1: quantile(values, 0.25),
    q3: quantile(values, 0.75),
    min: n ? Math.min(...values) : NaN,
    max: n ? Math.max(...values) : NaN,
  };
}

/** Points into groups in order of first appearance; ungrouped points form one group named "". */
export function groupPoints(points: readonly ChartPoint[]): ChartGroup[] {
  const order: string[] = [];
  const byGroup = new Map<string, ChartPoint[]>();
  for (const point of points) {
    if (!byGroup.has(point.group)) {
      byGroup.set(point.group, []);
      order.push(point.group);
    }
    byGroup.get(point.group)!.push(point);
  }
  return order.map((label) => summarise(label, byGroup.get(label)!));
}

/** Ranks with ties averaged, and the tie correction term Σ(t³ − t). */
function ranks(values: readonly number[]): { rank: number[]; ties: number } {
  const index = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const rank = new Array<number>(values.length);
  let ties = 0;
  for (let i = 0; i < index.length; ) {
    let j = i;
    while (j + 1 < index.length && index[j + 1].v === index[i].v) j++;
    const t = j - i + 1;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank[index[k].i] = r;
    if (t > 1) ties += t ** 3 - t;
    i = j + 1;
  }
  return { rank, ties };
}

/** The upper tail of the standard normal, by the complementary error function (Abramowitz–Stegun 7.1.26). */
export function normalUpperTail(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = poly * Math.exp(-x * x);
  const upper = erfc / 2;
  return z >= 0 ? upper : 1 - upper;
}

/** The regularised lower incomplete gamma P(a, x), by series or continued fraction (Numerical Recipes). */
function lowerGamma(a: number, x: number): number {
  if (x <= 0) return 0;
  const lnGammaA = lnGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGammaA);
  }
  // Lentz's continued fraction for the upper tail.
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lnGammaA) * h;
}

function lnGamma(z: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** The upper tail of a chi-square distribution with `df` degrees of freedom. */
export function chiSquareUpperTail(x: number, df: number): number {
  if (!(x > 0)) return 1;
  return Math.max(0, Math.min(1, 1 - lowerGamma(df / 2, x / 2)));
}

/**
 * The Wilcoxon rank-sum (Mann–Whitney U) test, two-sided, by the normal approximation with the
 * tie correction and a continuity correction, as R's wilcox.test uses for samples with ties or
 * of more than 50. Returns null with fewer than two values on a side.
 */
export function wilcoxonRankSum(a: readonly number[], b: readonly number[]): ChartTest | null {
  if (a.length < 2 || b.length < 2) return null;
  const n1 = a.length;
  const n2 = b.length;
  const { rank, ties } = ranks([...a, ...b]);
  const r1 = rank.slice(0, n1).reduce((s, r) => s + r, 0);
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - ties / (n * (n - 1))));
  if (!(sigma > 0)) return { name: "Wilcoxon rank-sum", statistic: u, p: 1, label: "Wilcoxon p = 1" };
  const z = (Math.abs(u - mu) - 0.5) / sigma;
  const p = Math.min(1, 2 * normalUpperTail(Math.max(0, z)));
  return { name: "Wilcoxon rank-sum", statistic: u, p, label: `Wilcoxon ${formatP(p)}` };
}

/** The Kruskal–Wallis test across groups, tie-corrected, chi-square with k − 1 degrees of freedom. */
export function kruskalWallis(groups: readonly (readonly number[])[]): ChartTest | null {
  const filled = groups.filter((g) => g.length > 0);
  if (filled.length < 2 || filled.some((g) => g.length < 2)) return null;
  const all = filled.flat();
  const n = all.length;
  const { rank, ties } = ranks(all);
  let offset = 0;
  let h = 0;
  for (const g of filled) {
    const r = rank.slice(offset, offset + g.length).reduce((s, v) => s + v, 0);
    h += (r * r) / g.length;
    offset += g.length;
  }
  h = (12 / (n * (n + 1))) * h - 3 * (n + 1);
  const correction = 1 - ties / (n ** 3 - n);
  if (correction > 0) h /= correction;
  const p = chiSquareUpperTail(h, filled.length - 1);
  return { name: "Kruskal–Wallis", statistic: h, p, label: `Kruskal–Wallis ${formatP(p)}` };
}

/** The test for the groups at hand: rank-sum for two, Kruskal–Wallis for more, none for one. */
export function testGroups(groups: readonly ChartGroup[]): ChartTest | null {
  const values = groups.map((g) => g.points.map((p) => p.value));
  if (values.length === 2) return wilcoxonRankSum(values[0], values[1]);
  if (values.length > 2) return kruskalWallis(values);
  return null;
}

export function formatP(p: number): string {
  if (!Number.isFinite(p)) return "p = ?";
  if (p < 0.001) return "p < 0.001";
  return `p = ${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}`;
}

/** A tick scale from 0 (or the minimum, when negative) to just above the maximum, in round steps. */
export function axisTicks(values: readonly number[], count = 5): { min: number; max: number; ticks: number[] } {
  const finite = values.filter((v) => Number.isFinite(v));
  const lo = Math.min(0, ...finite);
  const hi = Math.max(...finite, lo + 1e-9);
  const span = hi - lo || 1;
  const rough = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? magnitude * 10;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil((hi + step * 0.15) / step) * step;
  const ticks: number[] = [];
  for (let t = min; t <= max + step / 2; t += step) ticks.push(Number(t.toFixed(10)));
  return { min, max, ticks };
}
