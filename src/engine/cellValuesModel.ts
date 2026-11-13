// cellValuesModel.ts — the Plotting tab's per-cell chart as data: a channel's value in every cell
// of each selected population, pooled by group and facet, for a violin or a box per population.
// Populations are found in each file's own tree by provenance, as the proportion chart finds them,
// so the cells of a population are the events the gate list counts for it.

import { recompute, type CoreState } from "../store";
import type { Sample } from "./sample";
import { populationDisplayNames, resolvePartitionLevels, resolvePerSampleValue, type PerSampleFactor } from "./factors";
import { SAMPLE_ID_FIELD, sampleDisplayId } from "./metadata";
import { figureHierarchies, resolveFigurePopulation } from "./figure";
import { fileListOrder } from "./levelOrder";
import type { AxisTicks } from "./ticks";
import { PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "./proportionsSettings";
import { filePopulationId, proportionsArmIds, proportionsParentId, proportionsSelection, type FilePopulations, type ProportionsSampleRef } from "./proportionsModel";
import { geometricMean, mean, medianSorted, quantileSorted, tukeyBox } from "./summaryStats";

/** The cells of one population in one group (and facet), every file of the group pooled. */
export interface CellViolin {
  /** Index into the model's categories (the populations). */
  cat: number;
  group: string;
  facet: string | null;
  /** The replicate unit whose cells it pools, when pooled by unit; null when pooled by group. */
  unit: string | null;
  /**
   * The cells' values, ascending: on the channel's display scale, or its linear ("raw") values
   * when asked for; cells without a finite value are left out.
   */
  values: Float32Array;
  /** The files whose cells it pools. */
  files: string[];
}

export interface CellValuesModel {
  /** The populations, by name, in tree order. */
  catLevels: string[];
  levels: { popId: string; depth: number }[];
  violins: CellViolin[];
  hasFacet: boolean;
  /** The channel's label on the files drawn. */
  channelLabel: string;
  /** Files left out whole: their tree is unknown, lacks the parent or holds it changed, or has none of the selected populations. */
  excluded: string[];
  /** Files drawn without some selected populations their tree lacks or holds changed: each file's name and those populations' names, in file order. */
  partial?: { file: string; populations: string[] }[];
  /** Files left out because they have no such channel. */
  noChannel: string[];
  /** Lowest and highest value drawn, on the display scale; null when nothing is drawn. */
  extent: [number, number] | null;
  /** A file with the channel, whose transform reads the display scale back as measured values. */
  axisSource: { sample: Sample; index: number } | null;
}

function parseFactor(value: string): PerSampleFactor | null {
  if (value === PROPORTIONS_NO_FACTOR) return null;
  if (value === PROPORTIONS_SAMPLE_FACTOR) return { kind: "sample" };
  return { kind: "metadata", field: value };
}

const SEP = "\0";

export interface CellValuesOptions {
  /**
   * Pool each group's files (a violin per population and group), or each replicate unit's files
   * within a group (a statistic per unit, as the proportion boxplot takes a share per unit).
   */
  poolBy?: "group" | "unit";
  /** The channel's display values, as drawn, or its linear values, as the Statistics tab's "Raw" takes them. */
  values?: "display" | "raw";
  /** Where each selected population is found in a named file's own tree, in place of provenance. */
  filePopulations?: FilePopulations;
}

/**
 * The per-cell model: for each selected population, each group and each facet, the channel's
 * value in every cell the population holds within the parent, pooled over the group's files
 * (or over each replicate unit's files in the group).
 * A population a file's tree lacks, or holds changed, takes no cells from that file, which is
 * listed in `partial`. A file whose tree is unknown, lacks the parent or holds it changed, or has
 * none of the populations, is listed as excluded, and a file without the channel as without it,
 * rather than drawn wrong.
 */
export function buildCellValuesModel(
  settings: ProportionsSettings,
  files: readonly ProportionsSampleRef[],
  activeState: CoreState,
  metadata: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
  options: CellValuesOptions = {},
): CellValuesModel {
  const byUnit = options.poolBy === "unit";
  const raw = options.values === "raw";
  const trees = figureHierarchies(activeState);
  const tree = trees[settings.hierarchy] ?? trees[activeState.active_hierarchy_id];
  const state = { ...activeState, ...tree };
  const rootId = state.root_population_id ?? "";
  const samples = fileListOrder(files, settings.files);
  const groupSpec = parseFactor(settings.groupSel) ?? { kind: "sample" as const };
  const unitSpec = parseFactor(settings.unitSel) ?? { kind: "sample" as const };
  const facetSpec = parseFactor(settings.facetSel);
  const parentId = proportionsParentId(state.populations, settings.parent, rootId);
  // The root is a population like any other here (every cell of the file), though a proportion
  // chart leaves it out: kept, first in tree order, when selected with the root as the parent.
  const rootSelected = !!rootId && parentId === rootId && settings.selectedPops.includes(rootId);
  const arm = rootSelected ? proportionsArmIds(state.populations, parentId) : null;
  const selectedPops = arm
    ? settings.selectedPops.filter((id) => arm.has(id))
    : proportionsSelection(state.populations, parentId, settings.selectedPops);
  const displayNames = populationDisplayNames(state.populations);
  const levels = [
    ...(rootSelected ? [{ popId: rootId, name: state.populations[rootId]?.name ?? rootId, depth: 0 }] : []),
    ...resolvePartitionLevels(state.populations, rootId, selectedPops),
  ];
  const empty: CellValuesModel = {
    catLevels: [],
    levels: [],
    violins: [],
    hasFacet: !!facetSpec,
    channelLabel: settings.channel,
    excluded: [],
    partial: [],
    noChannel: [],
    extent: null,
    axisSource: null,
  };
  if (!levels.length || !settings.channel) return empty;
  const catLevels = levels.map((level) => displayNames[level.popId] ?? level.name);
  const excluded: string[] = [];
  const partial: { file: string; populations: string[] }[] = [];
  const noChannel: string[] = [];
  let axisSource: CellValuesModel["axisSource"] = null;
  const pooled = new Map<string, { cat: number; group: string; facet: string | null; unit: string | null; chunks: Float32Array[]; n: number; files: string[] }>();

  for (const entry of samples) {
    const own = trees[entry.hierarchyId ?? tree.id];
    if (!own) {
      excluded.push(entry.name);
      continue;
    }
    const named = options.filePopulations?.[entry.id];
    const ids = levels.map((level) =>
      level.popId === rootId && !(named && Object.prototype.hasOwnProperty.call(named, rootId))
        ? own.root_population_id ?? null
        : filePopulationId(level, tree.id, own, trees, named),
    );
    const localParent = parentId === rootId
      ? null
      : resolveFigurePopulation({ hierarchyId: tree.id, populationId: parentId, label: state.populations[parentId]?.name ?? "" }, own, trees);
    if (
      ids.every((id) => !id) ||
      (parentId !== rootId && (!localParent?.id || localParent.status === "changed"))
    ) {
      excluded.push(entry.name);
      continue;
    }
    const index = entry.sample.index(settings.channel);
    if (index === undefined) {
      noChannel.push(entry.name);
      continue;
    }
    axisSource ??= { sample: entry.sample, index };
    // Files pooled on one axis are drawn on one display scale, the axis file's. Two files in a
    // workspace can display a channel differently (ChannelScales keeps the auto logicle W and T
    // per assay layer, so a compensated file and an uncompensated one differ), so a file whose
    // transform is not the axis file's has its measured values put on the axis file's transform.
    const axis = axisSource;
    const sameScale = entry.sample === axis.sample
      || JSON.stringify(entry.sample.transformSpec(settings.channel)) === JSON.stringify(axis.sample.transformSpec(settings.channel));
    const column = raw
      ? entry.sample.rawColumnData(index)
      : sameScale
        ? entry.sample.displayColumn(index)
        : Float32Array.from(entry.sample.rawColumnData(index), (value) => axis.sample.rawToDisplay(settings.channel, value));
    const masks = recompute(entry.sample, { ...activeState, ...own }).masks;
    const parentMask = localParent?.id ? masks[localParent.id] ?? null : null;
    const row = { ...metadata[entry.id], [SAMPLE_ID_FIELD]: sampleDisplayId(entry.name, metadata[entry.id]) };
    const group = resolvePerSampleValue(groupSpec, entry.name, row);
    const facet = facetSpec ? resolvePerSampleValue(facetSpec, entry.name, row) : null;
    // A unit is the file itself, as the proportion boxplot takes it, or a metadata value.
    const unit = byUnit ? (unitSpec.kind === "sample" ? entry.id : resolvePerSampleValue(unitSpec, entry.name, row)) : null;
    const nEvents = entry.sample.fcs.nEvents;
    if (ids.some((id) => !id)) partial.push({ file: entry.name, populations: catLevels.filter((_, cat) => !ids[cat]) });
    ids.forEach((id, cat) => {
      // A population the file does not draw takes nothing from it, not even its name in the violin's files.
      if (!id) return;
      const mask = masks[id] ?? (levels[cat].popId === rootId ? new Uint8Array(nEvents).fill(1) : undefined);
      const key = cat + SEP + group + SEP + (facet ?? "") + SEP + (unit ?? "");
      let violin = pooled.get(key);
      if (!violin) {
        violin = { cat, group, facet, unit, chunks: [], n: 0, files: [] };
        pooled.set(key, violin);
      }
      violin.files.push(entry.name);
      if (!mask) return;
      let count = 0;
      for (let e = 0; e < nEvents; e++) if (mask[e] && (!parentMask || parentMask[e]) && Number.isFinite(column[e])) count++;
      const values = new Float32Array(count);
      let at = 0;
      for (let e = 0; e < nEvents; e++) if (mask[e] && (!parentMask || parentMask[e]) && Number.isFinite(column[e])) values[at++] = column[e];
      violin.chunks.push(values);
      violin.n += count;
    });
  }

  let lo = Infinity;
  let hi = -Infinity;
  const violins: CellViolin[] = [...pooled.values()].map((violin) => {
    const values = new Float32Array(violin.n);
    let at = 0;
    for (const chunk of violin.chunks) {
      values.set(chunk, at);
      at += chunk.length;
    }
    values.sort();
    if (values.length) {
      lo = Math.min(lo, values[0]);
      hi = Math.max(hi, values[values.length - 1]);
    }
    return { cat: violin.cat, group: violin.group, facet: violin.facet, unit: violin.unit, values, files: violin.files };
  });
  return {
    catLevels,
    levels: levels.map((level) => ({ popId: level.popId, depth: level.depth })),
    violins,
    hasFacet: !!facetSpec,
    channelLabel: axisSource ? axisSource.sample.channelLabel(axisSource.index) : settings.channel,
    excluded,
    partial,
    noChannel,
    extent: Number.isFinite(lo) ? [lo, hi] : null,
    axisSource,
  };
}

/** Type-7 quantile (R's default) of ascending values. */
export function sortedQuantile(sorted: ArrayLike<number>, p: number): number {
  return quantileSorted(sorted, p);
}

export interface CellBoxStats {
  q1: number;
  median: number;
  q3: number;
  /** Whisker ends: the most extreme cells within 1.5 × IQR of the quartiles (Tukey). */
  lo: number;
  hi: number;
  min: number;
  max: number;
}

/** A box's numbers from ascending values, on the scale the values are on. */
export function cellBoxStats(sorted: ArrayLike<number>): CellBoxStats {
  return tukeyBox(sorted);
}

/**
 * The median as measured: the middle cell's value (the mean of the middle two for an even count)
 * read back through the channel's transform. Display order is measured order, so the middle cells
 * are the same cells on either scale; this is the median the Statistics tab gives on raw values.
 */
export function measuredMedian(sorted: ArrayLike<number>, toMeasured: (display: number) => number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const m = Math.floor(n / 2);
  return n % 2 ? toMeasured(sorted[m]) : (toMeasured(sorted[m - 1]) + toMeasured(sorted[m])) / 2;
}

/**
 * Silverman's rule of thumb (R's bw.nrd0, ggplot2's default for a violin) on ascending values:
 * 0.9 × min(SD, IQR / 1.34) × n^-1/5, falling back as bw.nrd0 does when the spread is zero.
 */
export function silvermanBandwidth(sorted: ArrayLike<number>): number {
  const n = sorted.length;
  if (n < 2) return 1;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += sorted[i];
  mean /= n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (sorted[i] - mean) ** 2;
  const sd = Math.sqrt(ss / (n - 1));
  const iqr = sortedQuantile(sorted, 0.75) - sortedQuantile(sorted, 0.25);
  let lo = Math.min(sd, iqr / 1.34);
  if (!(lo > 0)) lo = sd || Math.abs(sorted[0]) || 1;
  return 0.9 * lo * n ** -0.2;
}

/**
 * A violin's outline: a Gaussian kernel density of ascending values from the lowest value to the
 * highest (trimmed to the cells, as ggplot2 trims), scaled so its widest point is 1. The body, the
 * cells between the Tukey whisker ends, is evaluated at `points` even positions; each tail beyond
 * a whisker adds `points / 8` positions, closer together near the body, so a cell far from the
 * rest neither leaves the body unresolved nor is cut off. The cells are binned first (512 bins
 * over the body, 64 over each tail, a tail bin placed at the mean of its cells), so the cost grows
 * with the number of cells only once, however many cells there are.
 */
export function violinOutline(
  sorted: ArrayLike<number>,
  points = 96,
  adjust = 1,
): { at: number[]; width: number[] } {
  const n = sorted.length;
  if (n === 0) return { at: [], width: [] };
  const lo = sorted[0];
  const hi = sorted[n - 1];
  if (!(hi > lo)) return { at: [lo], width: [1] };
  // With no spread between the whiskers (most cells alike), the body is the whole range.
  const whiskers = cellBoxStats(sorted);
  const [bodyLo, bodyHi] = whiskers.hi > whiskers.lo ? [whiskers.lo, whiskers.hi] : [lo, hi];
  const bins = 512;
  const step = (bodyHi - bodyLo) / bins;
  const tailBins = 64;
  const binAt: number[] = [];
  const binCount: number[] = [];
  const bodyCounts = new Float64Array(bins);
  const lowTail = { sum: new Float64Array(tailBins), count: new Float64Array(tailBins), step: (bodyLo - lo) / tailBins };
  const highTail = { sum: new Float64Array(tailBins), count: new Float64Array(tailBins), step: (hi - bodyHi) / tailBins };
  for (let i = 0; i < n; i++) {
    const v = sorted[i];
    if (v < bodyLo) {
      const b = Math.min(tailBins - 1, Math.floor((v - lo) / lowTail.step));
      lowTail.sum[b] += v;
      lowTail.count[b]++;
    } else if (v > bodyHi) {
      const b = Math.min(tailBins - 1, Math.floor((v - bodyHi) / highTail.step));
      highTail.sum[b] += v;
      highTail.count[b]++;
    } else bodyCounts[Math.min(bins - 1, Math.floor((v - bodyLo) / step))]++;
  }
  for (let b = 0; b < bins; b++) {
    if (!bodyCounts[b]) continue;
    binAt.push(bodyLo + (b + 0.5) * step);
    binCount.push(bodyCounts[b]);
  }
  for (const tail of [lowTail, highTail]) {
    for (let b = 0; b < tailBins; b++) {
      if (!tail.count[b]) continue;
      binAt.push(tail.sum[b] / tail.count[b]);
      binCount.push(tail.count[b]);
    }
  }
  const bw = silvermanBandwidth(sorted) * adjust;
  const tailPoints = Math.max(2, Math.ceil(points / 8));
  const positions: number[] = [];
  // The low tail from the lowest cell towards the body, the body evenly, then the high tail.
  if (bodyLo > lo) for (let k = tailPoints; k >= 1; k--) positions.push(k === tailPoints ? lo : bodyLo - (bodyLo - lo) * (k / tailPoints) ** 2);
  for (let p = 0; p < points; p++) positions.push(bodyLo + ((bodyHi - bodyLo) * p) / (points - 1));
  if (hi > bodyHi) for (let k = 1; k <= tailPoints; k++) positions.push(k === tailPoints ? hi : bodyHi + (hi - bodyHi) * (k / tailPoints) ** 2);
  const at: number[] = [];
  const width: number[] = [];
  let peak = 0;
  for (const x of positions) {
    let density = 0;
    for (let b = 0; b < binAt.length; b++) {
      const z = (binAt[b] - x) / bw;
      if (z * z < 64) density += binCount[b] * Math.exp(-0.5 * z * z);
    }
    at.push(x);
    width.push(density);
    peak = Math.max(peak, density);
  }
  return { at, width: width.map((d) => (peak > 0 ? d / peak : 0)) };
}

export interface CellValueAxis {
  range: [number, number];
  /** Major ticks on the display scale, labelled in measured units where the scale has decades. */
  major: { at: number; label: string }[];
  minor: number[];
}

/** Five or so evenly spaced round ticks from lo to hi. */
export function linearTicks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((candidate) => candidate >= raw)!;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/**
 * The value axis of a per-cell chart: the channel's range on the Gating tab when asked for and
 * known, else the cells' own range with a margin; ticked as the Gating tab ticks the channel
 * (decades in measured units on a logicle or log scale, plain numbers otherwise).
 */
export function cellValueAxis(
  model: Pick<CellValuesModel, "extent" | "axisSource">,
  mode: ProportionsSettings["cellRange"],
  gatingRange: [number, number] | undefined,
): CellValueAxis | null {
  let range: [number, number] | null = null;
  if (mode === "gating" && gatingRange && gatingRange[1] > gatingRange[0]) range = [gatingRange[0], gatingRange[1]];
  else if (model.extent) {
    const [lo, hi] = model.extent;
    const pad = hi > lo ? (hi - lo) * 0.04 : Math.max(1, Math.abs(lo) * 0.1);
    range = [lo - pad, hi + pad];
  }
  if (!range) return null;
  const ticks: AxisTicks | null = model.axisSource ? model.axisSource.sample.channelTicks(model.axisSource.index, range) : null;
  if (ticks && ticks.major_pos.length >= 2) {
    return {
      range,
      major: ticks.major_pos.map((at, i) => ({ at, label: ticks.major_labels[i] ?? "" })),
      minor: ticks.minor_pos,
    };
  }
  const values = linearTicks(range[0], range[1]);
  const decimals = Math.max(0, ...values.map((v) => (String(v).split(".")[1] ?? "").length));
  return {
    range,
    major: values.map((at) => ({ at, label: at.toLocaleString("en-US", { maximumFractionDigits: Math.min(4, decimals) }) })),
    minor: [],
  };
}

/**
 * A statistic of ascending linear values, as the Statistics tab computes it (stats.ts): the median
 * (the mean of the middle two for an even count), the mean, or the geometric mean of the positive
 * values; NaN with no value to take it of.
 */
export function cellStatistic(sorted: ArrayLike<number>, statistic: ProportionsSettings["statistic"]): number {
  if (sorted.length === 0) return NaN;
  if (statistic === "median") return medianSorted(sorted);
  if (statistic === "mean") return mean(sorted);
  return geometricMean(sorted).value;
}
