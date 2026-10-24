// proportions.ts — the Proportions-tab composition statistic, ported from GateLabR
// (app.R:4374-4439). Category composition per Unit, with three stacked-bar denominators and a
// boxplot of per-unit fractions. Operates on per-sample Category counts + per-sample Group/Unit/
// Facet scalars (GateLab's per-sample factor model), so it never needs a combined per-event index.

import type { PopulationMap } from "./models";

export interface SampleComposition {
  unit: string;
  group: string;
  facet: string | null;
  catCounts: number[]; // aligned to the shared catLevels (length = nCat)
  /**
   * Each selected population's whole count within the parent, aligned to the population levels
   * (the categories before the rest): everything it holds, whatever a nested or overlapping
   * selection claims in `catCounts`. Absent for division categories, which are a partition.
   */
  popCounts?: number[];
}

/** One rect in a nested stacked bar: a selected population's SUBTREE extent (cumulative fractions). */
export interface NestedBarNode {
  cat: number; // index into catLevels (colour)
  popId: string;
  depth: number; // nesting depth within the selection (0 = shallowest selected), for left-inset
  y0: number; // bottom of this node's subtree, cumulative fraction in [0,1]
  y1: number; // top of this node's subtree (y1 - y0 = subtree fraction)
}

/**
 * Lay out a stacked bar as a NESTED hierarchy so daughter populations sit inside their parent's
 * segment. `segments[i].value` is the deepest-wins OWN fraction of level `i` (mutually exclusive).
 * Each node's subtree = own + Σ children subtree; children stack above the parent's own slice.
 * Returned shallow-first so the caller can paint parents first and children (inset) on top — the
 * parent's colour then shows through as its OWN cells (bottom) plus a left stripe beside its children.
 */
export function nestedBarLayout(
  levels: { popId: string; depth: number }[],
  segments: { cat: number; value: number }[],
  populations: PopulationMap,
): NestedBarNode[] {
  const own = new Map<string, number>();
  const catOf = new Map<string, number>();
  levels.forEach((l, i) => { own.set(l.popId, segments[i]?.value ?? 0); catOf.set(l.popId, i); });
  const selected = new Set(levels.map((l) => l.popId));

  const nearestSelectedAncestor = (popId: string): string | null => {
    let p = populations[popId]?.parent_id ?? null;
    while (p) { if (selected.has(p)) return p; p = populations[p]?.parent_id ?? null; }
    return null;
  };
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const l of levels) {
    const par = nearestSelectedAncestor(l.popId);
    if (par) (childrenOf.get(par) ?? childrenOf.set(par, []).get(par)!).push(l.popId);
    else roots.push(l.popId);
  }
  const subtree = new Map<string, number>();
  const computeSubtree = (popId: string): number => {
    const hit = subtree.get(popId);
    if (hit !== undefined) return hit;
    let s = own.get(popId) ?? 0;
    for (const c of childrenOf.get(popId) ?? []) s += computeSubtree(c);
    subtree.set(popId, s);
    return s;
  };

  const out: NestedBarNode[] = [];
  const layout = (popId: string, y0: number, depth: number) => {
    const sub = computeSubtree(popId);
    out.push({ cat: catOf.get(popId)!, popId, depth, y0, y1: y0 + sub });
    let cursor = y0 + (own.get(popId) ?? 0); // OWN slice at the bottom, children above
    for (const c of childrenOf.get(popId) ?? []) { layout(c, cursor, depth + 1); cursor += computeSubtree(c); }
  };
  let base = 0;
  for (const r of roots) { layout(r, base, 0); base += computeSubtree(r); }
  return out.sort((a, b) => a.depth - b.depth);
}

export interface UnitRow {
  unit: string;
  group: string;
  facet: string | null;
  props: number[]; // per-category fraction, sums to 1 (nCat)
  /**
   * Each category's whole share of the unit: a population with every event it holds, as the gate
   * list counts it, where `props` gives an event to one category only. Equal to `props` for a
   * partition (the rest, division levels).
   */
  shares: number[];
  nEvents: number;
}

const SEP = "\0";

/**
 * Pool events by Unit within each Group and Facet, and normalise each to sum 1. A unit is one
 * observation per group it has files in: a donor with a reference and a stimulated file is a
 * point in each condition, never one point of both conditions' events pooled.
 */
export function perUnitProps(samples: SampleComposition[], nCat: number): UnitRow[] {
  const byUnit = new Map<string, { unit: string; group: string; facet: string | null; counts: number[]; whole: number[]; n: number }>();
  for (const s of samples) {
    const key = s.unit + SEP + s.group + SEP + (s.facet ?? "");
    let u = byUnit.get(key);
    if (!u) { u = { unit: s.unit, group: s.group, facet: s.facet, counts: new Array(nCat).fill(0), whole: new Array(nCat).fill(0), n: 0 }; byUnit.set(key, u); }
    const sN = s.catCounts.reduce((a, b) => a + b, 0);
    for (let c = 0; c < nCat; c++) {
      u.counts[c] += s.catCounts[c];
      u.whole[c] += s.popCounts?.[c] ?? s.catCounts[c];
    }
    u.n += sN;
  }
  // A unit with no events in the parent has no composition: left out, not averaged in as 0%.
  return [...byUnit.values()].filter((u) => u.n > 0).map((u) => ({
    unit: u.unit,
    group: u.group,
    facet: u.facet,
    props: u.counts.map((c) => c / u.n),
    shares: u.whole.map((c) => c / u.n),
    nEvents: u.n,
  }));
}

export interface BarSegment { cat: number; value: number }
export interface BarGroup {
  key: string;
  group: string;
  facet: string | null;
  segments: BarSegment[]; // value in [0,1], sums to ~1
  total: number; // pooled event count (bar denominator) — 1 for the averaged mode
}

/**
 * Stacked-bar data. Three denominators (app.R:4406-4425):
 *  • averagePerUnit + hasUnit → per-unit props then MEAN across units per Group[/Facet].
 *  • pooled                   → sum catCounts per Group[/Facet], normalise within each.
 */
export function computeStackedBars(
  samples: SampleComposition[],
  nCat: number,
  opts: { averagePerUnit: boolean; hasUnit: boolean; hasFacet: boolean },
): BarGroup[] {
  if (opts.averagePerUnit && opts.hasUnit) {
    const units = perUnitProps(samples, nCat);
    const byGF = new Map<string, { group: string; facet: string | null; sum: number[]; count: number }>();
    for (const u of units) {
      const key = u.group + SEP + (opts.hasFacet ? u.facet ?? "" : "");
      let g = byGF.get(key);
      if (!g) { g = { group: u.group, facet: opts.hasFacet ? u.facet : null, sum: new Array(nCat).fill(0), count: 0 }; byGF.set(key, g); }
      for (let c = 0; c < nCat; c++) g.sum[c] += u.props[c];
      g.count++;
    }
    return [...byGF.values()].map((g) => ({
      key: g.group + "|" + (g.facet ?? ""),
      group: g.group,
      facet: g.facet,
      segments: g.sum.map((s, c) => ({ cat: c, value: g.count ? s / g.count : 0 })),
      total: 1,
    }));
  }
  const byGF = new Map<string, { group: string; facet: string | null; sum: number[] }>();
  for (const s of samples) {
    const key = s.group + SEP + (opts.hasFacet ? s.facet ?? "" : "");
    let g = byGF.get(key);
    if (!g) { g = { group: s.group, facet: opts.hasFacet ? s.facet : null, sum: new Array(nCat).fill(0) }; byGF.set(key, g); }
    for (let c = 0; c < nCat; c++) g.sum[c] += s.catCounts[c];
  }
  return [...byGF.values()].map((g) => {
    const tot = g.sum.reduce((a, b) => a + b, 0);
    return {
      key: g.group + "|" + (g.facet ?? ""),
      group: g.group,
      facet: g.facet,
      segments: g.sum.map((s, c) => ({ cat: c, value: tot ? s / tot : 0 })),
      total: tot,
    };
  });
}

/**
 * A box's five numbers and its whisker ends. The whiskers follow Tukey: each reaches the most
 * extreme value within 1.5 × IQR of its quartile, as ggplot2's geom_boxplot draws them.
 */
export interface BoxStats { min: number; q1: number; med: number; q3: number; max: number; lo: number; hi: number }
export interface BoxDatum {
  cat: number;
  group: string;
  facet: string | null;
  values: number[]; // per-unit whole shares
  units: string[]; // the replicate unit of each value, so a unit's points can be joined across groups
  stats: BoxStats;
}

/** Type-7 quantile (R default). `sorted` must be ascending. */
export function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}
function boxStats(vals: number[]): BoxStats {
  const s = [...vals].sort((a, b) => a - b);
  const q1 = quantile(s, 0.25), q3 = quantile(s, 0.75);
  const reach = 1.5 * (q3 - q1);
  const within = s.filter((v) => v >= q1 - reach && v <= q3 + reach);
  return {
    min: s[0] ?? 0,
    q1,
    med: quantile(s, 0.5),
    q3,
    max: s[s.length - 1] ?? 0,
    lo: within[0] ?? q1,
    hi: within[within.length - 1] ?? q3,
  };
}

/**
 * Boxplot data: per-unit shares grouped by (Category, Group[, Facet]). A box is a population's
 * whole share in each unit, as the gate list counts it, not the part a stacked bar can give it.
 */
export function computeBoxes(units: UnitRow[], nCat: number, hasFacet: boolean): BoxDatum[] {
  const map = new Map<string, BoxDatum>();
  for (const u of units) {
    for (let c = 0; c < nCat; c++) {
      const key = c + SEP + u.group + SEP + (hasFacet ? u.facet ?? "" : "");
      let d = map.get(key);
      if (!d) { d = { cat: c, group: u.group, facet: hasFacet ? u.facet : null, values: [], units: [], stats: { min: 0, q1: 0, med: 0, q3: 0, max: 0, lo: 0, hi: 0 } }; map.set(key, d); }
      d.values.push(u.shares[c]);
      d.units.push(u.unit);
    }
  }
  for (const d of map.values()) d.stats = boxStats(d.values);
  return [...map.values()];
}
