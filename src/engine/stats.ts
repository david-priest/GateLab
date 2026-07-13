// stats.ts — population × channel statistics for the Statistics tab.
// Ported from GateLabR stats_utils.R (compute_population_stats): one row per population in
// tree order; Count / % Parent / % Total; and per-channel MFI stats (Median/Mean/GeoMean/
// SD/CV%) computed over the population's events in raw (default) or transformed space.

import type { Sample } from "./sample";
import type { PopulationMap } from "./models";
import { populationTreeOrder } from "./populations";

export type StatType = "count" | "pct_parent" | "pct_total" | "median" | "mean" | "geomean" | "sd" | "cv";
export type ValueSpace = "raw" | "transformed";

export const MFI_STATS: { key: StatType; label: string; suffix: string }[] = [
  { key: "median", label: "Median MFI", suffix: "Median" },
  { key: "mean", label: "Mean MFI", suffix: "Mean" },
  { key: "geomean", label: "Geometric Mean", suffix: "GeoMean" },
  { key: "sd", label: "Std Dev", suffix: "SD" },
  { key: "cv", label: "CV%", suffix: "CV%" },
];

export interface StatsColumn {
  key: string; // unique column id
  label: string; // header text
  channel?: string; // set for MFI columns
}
export interface StatsRow {
  popId: string;
  depth: number;
  isLastPath: boolean[]; // per-ancestor "is last child" flags → tree connector glyphs
  name: string;
  cells: Record<string, number | null>;
}
export interface StatsTable {
  columns: StatsColumn[];
  rows: StatsRow[];
}

const round = (x: number, d: number): number => {
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
};

/** Stats over a finite-filtered numeric sample (mirrors R median/mean/geomean/sd/cv). */
function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  const m = Math.floor(n / 2);
  return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(v: number[]): number {
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
}
function stddev(v: number[]): number {
  const n = v.length;
  if (n < 2) return NaN;
  const m = mean(v);
  let s = 0;
  for (const x of v) s += (x - m) * (x - m);
  return Math.sqrt(s / (n - 1)); // sample SD, matches R sd()
}
function geomean(v: number[]): number {
  const pos = v.filter((x) => x > 0);
  if (pos.length === 0) return NaN;
  let s = 0;
  for (const x of pos) s += Math.log(x);
  return Math.exp(s / pos.length);
}

export function computePopulationStats(
  sample: Sample,
  populations: PopulationMap,
  rootId: string,
  masks: Record<string, Uint8Array>,
  eventCount: Record<string, number | null>,
  channelKeys: string[],
  statTypes: StatType[],
  valueSpace: ValueSpace,
): StatsTable {
  const order = populationTreeOrder(populations, rootId);

  // Column layout: base stats, then per-channel MFI stats (channel-major, GateLabR order).
  const columns: StatsColumn[] = [];
  if (statTypes.includes("count")) columns.push({ key: "count", label: "Count" });
  if (statTypes.includes("pct_parent")) columns.push({ key: "pct_parent", label: "% Parent" });
  if (statTypes.includes("pct_total")) columns.push({ key: "pct_total", label: "% Total" });
  const activeMfi = MFI_STATS.filter((s) => statTypes.includes(s.key));
  for (const ch of channelKeys) {
    for (const s of activeMfi) columns.push({ key: `${ch}::${s.suffix}`, label: `${ch} ${s.suffix}`, channel: ch });
  }

  // Per-channel value columns (raw or display) — fetch once.
  const chanCols = channelKeys.map((ch) => {
    const idx = sample.index(ch);
    if (idx === undefined) return null;
    return valueSpace === "transformed" ? sample.displayColumn(idx) : sample.rawColumnData(idx);
  });

  const nTotal = eventCount[rootId] ?? sample.fcs.nEvents;

  const rows: StatsRow[] = order.map(({ popId, depth, isLastPath }) => {
    const pop = populations[popId];
    const mask = masks[popId] ?? null;
    const n = eventCount[popId] ?? (mask ? countMask(mask) : sample.fcs.nEvents);
    const cells: Record<string, number | null> = {};

    if (statTypes.includes("count")) cells.count = n;
    if (statTypes.includes("pct_parent")) {
      if (popId === rootId || !pop?.parent_id) cells.pct_parent = 100;
      else {
        const pn = eventCount[pop.parent_id] ?? 0;
        cells.pct_parent = pn > 0 ? round((n / pn) * 100, 2) : null;
      }
    }
    if (statTypes.includes("pct_total")) cells.pct_total = nTotal > 0 ? round((n / nTotal) * 100, 2) : null;

    if (activeMfi.length && channelKeys.length) {
      channelKeys.forEach((ch, ci) => {
        const col = chanCols[ci];
        const vals: number[] = [];
        if (col && mask) {
          for (let i = 0; i < mask.length; i++) if (mask[i]) { const x = col[i]; if (Number.isFinite(x)) vals.push(x); }
        } else if (col && !mask) {
          for (let i = 0; i < col.length; i++) { const x = col[i]; if (Number.isFinite(x)) vals.push(x); }
        }
        for (const s of activeMfi) {
          const key = `${ch}::${s.suffix}`;
          if (vals.length === 0) { cells[key] = null; continue; }
          let val: number;
          if (s.key === "median") val = median(vals);
          else if (s.key === "mean") val = mean(vals);
          else if (s.key === "geomean") val = geomean(vals);
          else if (s.key === "sd") val = stddev(vals);
          else {
            const m = mean(vals);
            const sd = stddev(vals);
            val = Number.isFinite(m) && m !== 0 ? (sd / Math.abs(m)) * 100 : NaN;
          }
          cells[key] = Number.isFinite(val) ? round(val, 1) : null;
        }
      });
    }
    return { popId, depth, isLastPath, name: pop?.name ?? popId, cells };
  });

  return { columns, rows };
}

function countMask(m: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) c++;
  return c;
}
