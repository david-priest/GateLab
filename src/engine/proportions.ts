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
  group: string; // dominant (modal by events) group among the unit's samples
  facet: string | null;
  props: number[]; // per-category fraction, sums to 1 (nCat)
  nEvents: number;
}

const SEP = "\0";
const domOf = (m: Map<string, number>): string | null => {
  let best: string | null = null;
  let bv = -1;
  for (const [k, v] of m) if (v > bv) { best = k; bv = v; }
  return best;
};

/** Pool events by Unit, normalise each unit to sum 1, and assign each unit its dominant Group/Facet. */
export function perUnitProps(samples: SampleComposition[], nCat: number): UnitRow[] {
  const byUnit = new Map<string, { counts: number[]; n: number; grp: Map<string, number>; fac: Map<string, number> }>();
  for (const s of samples) {
    let u = byUnit.get(s.unit);
    if (!u) { u = { counts: new Array(nCat).fill(0), n: 0, grp: new Map(), fac: new Map() }; byUnit.set(s.unit, u); }
    const sN = s.catCounts.reduce((a, b) => a + b, 0);
    for (let c = 0; c < nCat; c++) u.counts[c] += s.catCounts[c];
    u.n += sN;
    u.grp.set(s.group, (u.grp.get(s.group) ?? 0) + sN);
    if (s.facet != null) u.fac.set(s.facet, (u.fac.get(s.facet) ?? 0) + sN);
  }
  const rows: UnitRow[] = [];
  for (const [unit, u] of byUnit) {
    rows.push({
      unit,
      group: domOf(u.grp) ?? "",
      facet: domOf(u.fac),
      props: u.n > 0 ? u.counts.map((c) => c / u.n) : u.counts.map(() => 0),
      nEvents: u.n,
    });
  }
  return rows;
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

export interface BoxStats { min: number; q1: number; med: number; q3: number; max: number }
export interface BoxDatum {
  cat: number;
  group: string;
  facet: string | null;
  values: number[]; // per-unit fractions
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
  return { min: s[0] ?? 0, q1: quantile(s, 0.25), med: quantile(s, 0.5), q3: quantile(s, 0.75), max: s[s.length - 1] ?? 0 };
}

/** Boxplot data: per-unit fractions grouped by (Category, Group[, Facet]). */
export function computeBoxes(units: UnitRow[], nCat: number, hasFacet: boolean): BoxDatum[] {
  const map = new Map<string, BoxDatum>();
  for (const u of units) {
    for (let c = 0; c < nCat; c++) {
      const key = c + SEP + u.group + SEP + (hasFacet ? u.facet ?? "" : "");
      let d = map.get(key);
      if (!d) { d = { cat: c, group: u.group, facet: hasFacet ? u.facet : null, values: [], stats: { min: 0, q1: 0, med: 0, q3: 0, max: 0 } }; map.set(key, d); }
      d.values.push(u.props[c]);
    }
  }
  for (const d of map.values()) d.stats = boxStats(d.values);
  return [...map.values()];
}
