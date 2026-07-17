// heatmap.ts — population × channel expression summaries for the Illustration tab.
// Values are calculated from every event in each population in display/transformed
// space, matching GateLabR's Illustration data. Rendering and preview point caps do
// not alter these summaries.

import type { Sample } from "./sample";
import type { PopulationMap } from "./models";

export type HeatmapSummaryStat = "median" | "mean";
export type HeatmapScaleMode = "none" | "column_minmax" | "row_minmax" | "column_zscore";
export type HeatmapPalette = "heat" | "viridis" | "blue_white_yellow_red";

export interface HeatmapChannel {
  id: string;
  label: string;
}

export interface HeatmapRow {
  id: string;
  name: string;
  count: number;
  values: Array<number | null>;
  raw_values: Array<number | null>;
}

export interface HeatmapPayload {
  rows: HeatmapRow[];
  channels: HeatmapChannel[];
  summary_stat: HeatmapSummaryStat;
  scale_mode: HeatmapScaleMode;
  palette: HeatmapPalette;
  cell_size: number;
  show_values: boolean;
  z_limit: number;
  legend_min: number;
  legend_max: number;
}

function swap(values: number[], a: number, b: number): void {
  const x = values[a];
  values[a] = values[b];
  values[b] = x;
}

/** In-place deterministic quickselect (median-of-three pivot). */
function selectKth(values: number[], k: number): number {
  let left = 0;
  let right = values.length - 1;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (values[mid] < values[left]) swap(values, mid, left);
    if (values[right] < values[left]) swap(values, right, left);
    if (values[right] < values[mid]) swap(values, right, mid);
    const pivot = values[mid];

    let i = left;
    let j = right;
    while (i <= j) {
      while (values[i] < pivot) i++;
      while (values[j] > pivot) j--;
      if (i <= j) {
        swap(values, i, j);
        i++;
        j--;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else return values[k];
  }
  return values[left];
}

/** Exact median without the O(n log n) full sort used by the Statistics table. */
export function exactMedian(values: number[]): number {
  if (!values.length) return NaN;
  const middle = Math.floor(values.length / 2);
  const upper = selectKth(values, middle);
  if (values.length % 2) return upper;
  let lower = -Infinity;
  for (let i = 0; i < middle; i++) if (values[i] > lower) lower = values[i];
  return (lower + upper) / 2;
}

function minmax(values: Array<number | null>): Array<number | null> {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!finite.length) return [...values];
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of finite) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  if (hi <= lo) return values.map((v) => (typeof v === "number" && Number.isFinite(v) ? 0.5 : null));
  return values.map((v) => (typeof v === "number" && Number.isFinite(v) ? (v - lo) / (hi - lo) : null));
}

/** Scale a raw summary matrix while preserving missing cells. */
export function scaleHeatmapValues(
  raw: Array<Array<number | null>>,
  mode: HeatmapScaleMode,
  zLimit = 2.5,
): Array<Array<number | null>> {
  const out = raw.map((row) => [...row]);
  if (mode === "none" || !out.length || !out[0]?.length) return out;

  if (mode === "row_minmax") return out.map(minmax);

  const nRows = out.length;
  const nCols = out[0].length;
  for (let col = 0; col < nCols; col++) {
    const values = Array.from({ length: nRows }, (_, row) => out[row][col]);
    if (mode === "column_minmax") {
      const scaled = minmax(values);
      for (let row = 0; row < nRows; row++) out[row][col] = scaled[row];
      continue;
    }

    const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (!finite.length) continue;
    const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
    let sd = 0;
    if (finite.length > 1) {
      let ss = 0;
      for (const value of finite) ss += (value - mean) * (value - mean);
      sd = Math.sqrt(ss / (finite.length - 1));
    }
    const limit = Number.isFinite(zLimit) && zLimit > 0 ? zLimit : 2.5;
    for (let row = 0; row < nRows; row++) {
      const value = values[row];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        out[row][col] = null;
      } else if (!(sd > 0)) {
        out[row][col] = 0;
      } else {
        out[row][col] = Math.max(-limit, Math.min(limit, (value - mean) / sd));
      }
    }
  }
  return out;
}

function indicesFor(mask: Uint8Array | undefined, nEvents: number): number[] {
  if (!mask) return Array.from({ length: nEvents }, (_, i) => i);
  const indices: number[] = [];
  for (let i = 0; i < Math.min(mask.length, nEvents); i++) if (mask[i]) indices.push(i);
  return indices;
}

function summarizeColumn(column: ArrayLike<number>, indices: number[], stat: HeatmapSummaryStat): number | null {
  if (stat === "mean") {
    let sum = 0;
    let count = 0;
    for (const index of indices) {
      const value = column[index];
      if (Number.isFinite(value)) {
        sum += value;
        count++;
      }
    }
    return count ? sum / count : null;
  }

  const values: number[] = [];
  for (const index of indices) {
    const value = column[index];
    if (Number.isFinite(value)) values.push(value);
  }
  const value = exactMedian(values);
  return Number.isFinite(value) ? value : null;
}

/** Build the shared mini_plot.js heatmap payload. */
export function buildHeatmapPayload(
  sample: Sample,
  populations: PopulationMap,
  masks: Record<string, Uint8Array>,
  eventCount: Record<string, number | null>,
  popIds: string[],
  channelKeys: string[],
  options: {
    summaryStat: HeatmapSummaryStat;
    scaleMode: HeatmapScaleMode;
    palette: HeatmapPalette;
    cellSize: number;
    showValues: boolean;
    zLimit?: number;
  },
): HeatmapPayload {
  const channels = channelKeys.flatMap((key) => {
    const index = sample.index(key);
    return index === undefined ? [] : [{ id: key, label: sample.labelForKey(key), index }];
  });
  const columns = channels.map((channel) => sample.displayColumn(channel.index));
  const validPopIds = popIds.filter((id) => populations[id]);
  const raw = validPopIds.map((popId) => {
    const indices = indicesFor(masks[popId], sample.fcs.nEvents);
    return columns.map((column) => summarizeColumn(column, indices, options.summaryStat));
  });
  const zLimit = Number.isFinite(options.zLimit) && (options.zLimit ?? 0) > 0 ? options.zLimit! : 2.5;
  const scaled = scaleHeatmapValues(raw, options.scaleMode, zLimit);
  const finite = scaled.flat().filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  let legendMin: number;
  let legendMax: number;
  if (options.scaleMode === "column_zscore") {
    legendMin = -zLimit;
    legendMax = zLimit;
  } else if (options.scaleMode === "column_minmax" || options.scaleMode === "row_minmax") {
    legendMin = 0;
    legendMax = 1;
  } else if (finite.length) {
    legendMin = Math.min(...finite);
    legendMax = Math.max(...finite);
    if (legendMax <= legendMin) {
      legendMin -= 0.5;
      legendMax += 0.5;
    }
  } else {
    legendMin = 0;
    legendMax = 1;
  }

  return {
    rows: validPopIds.map((id, row) => ({
      id,
      name: populations[id]?.name ?? id,
      count: eventCount[id] ?? indicesFor(masks[id], sample.fcs.nEvents).length,
      values: scaled[row],
      raw_values: raw[row],
    })),
    channels: channels.map(({ id, label }) => ({ id, label })),
    summary_stat: options.summaryStat,
    scale_mode: options.scaleMode,
    palette: options.palette,
    cell_size: Math.max(16, Math.min(72, Math.round(options.cellSize) || 30)),
    show_values: options.showValues,
    z_limit: zLimit,
    legend_min: legendMin,
    legend_max: legendMax,
  };
}
