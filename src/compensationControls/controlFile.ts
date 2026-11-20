// controlFile.ts — a compensation control as the calculator reads it.
//
// The calculator (controlDetection, controlSplit, spilloverEstimate, controlPlan) works on plain
// columns, so it can be tested without an FCS file and run without the app. This file holds that
// shape and the one place a loaded file is turned into it.
//
// Values are the stored measurements (the Original layer) in raw linear units, whatever assay the
// file is showing: a spillover coefficient estimated from already-compensated values would be the
// residual after that compensation, not the spillover.
//
// Design: vault note "GateLab — compensation matrix from single-stained controls, plan (2026-11-18)".

import type { Sample } from "../engine/sample";
import { medianSorted, quantileSorted } from "../engine/summaryStats";
import { isScatterChannel } from "../engine/transforms";

export interface ControlChannel {
  /** The channel's name in the app (Sample.channels[].key): the marker where the file gives one. */
  readonly key: string;
  /**
   * $PnN: the channel's identity here and in the matrix. A control and a sample of one experiment
   * share it where their app names differ (a sample's channel is named for its marker).
   */
  readonly pnn: string;
  /** $PnS, where the file gives one. */
  readonly marker: string | null;
  /** $PnR; 0 where the file gives none. */
  readonly range: number;
  /** $PnV, the detector voltage, where the file records one. */
  readonly voltage?: number | null;
  /** $PnG, the amplifier gain, where the file records one. */
  readonly gain?: number | null;
}

export interface ControlFile {
  readonly id: string;
  readonly fileName: string;
  /** Other names the file carries for itself (TUBE NAME, $SMNO, $SRC), read with the file name. */
  readonly labels: readonly string[];
  readonly eventCount: number;
  /** The fluorescence channels a matrix could cover: area parameters where the file has pulse suffixes. */
  readonly channels: readonly ControlChannel[];
  /** Stored raw linear values of a channel, by $PnN; null where the file has no such channel. */
  values(pnn: string): ArrayLike<number> | null;
  /** Forward and side scatter area, where the file has them: used only to compare particles. */
  readonly scatter?: Readonly<{ forward: ArrayLike<number> | null; side: ArrayLike<number> | null }>;
  /** $CYT and $CYTSN, the instrument, where the file names it. */
  readonly cytometer?: string | null;
  /** $DATE, as the file writes it. */
  readonly acquired?: string | null;
  /** The file's embedded spillover matrix ($SPILLOVER), by $PnN, where it carries one. */
  readonly embedded?: Readonly<{ channels: readonly string[]; matrix: readonly (readonly number[])[] }> | null;
}

const AREA_SUFFIX = /-A$/i;
const PULSE_SUFFIX = /-(A|H|W)$/i;

/**
 * A loaded flow file as a control. Channels: every fluorescence channel that is an area parameter;
 * where no fluorescence channel carries a pulse suffix (FL1, FL2, …) every fluorescence channel.
 * Height and width are left out because embedded matrices cover area only.
 */
export function controlFileFromSample(sample: Sample, id: string, fileName: string): ControlFile {
  const fluorescence = sample.channels
    .map((channel, index) => ({ channel, index }))
    .filter(({ index }) => sample.isFluorChannel(index));
  const suffixed = fluorescence.some(({ channel }) => PULSE_SUFFIX.test(channel.pnn));
  const kept = suffixed ? fluorescence.filter(({ channel }) => AREA_SUFFIX.test(channel.pnn)) : fluorescence;
  const indexByPnn = new Map(kept.map(({ channel, index }) => [channel.pnn, index]));
  const scatterColumn = (prefix: RegExp): ArrayLike<number> | null => {
    const index = sample.channels.findIndex((channel) =>
      prefix.test(channel.pnn) && AREA_SUFFIX.test(channel.pnn) && isScatterChannel(channel.pnn));
    return index < 0 ? null : sample.originalColumnData(index);
  };
  const keywords = sample.fcs.keywords;
  const labels = ["TUBE NAME", "$SMNO", "$SRC"]
    .map((keyword) => (keywords[keyword] ?? "").trim())
    .filter((value) => value.length > 0);
  // $PnV and $PnG are numbered by parameter, one more than the column.
  const setting = (columnIndex: number, letter: "V" | "G"): number | null => {
    const text = (keywords[`$P${columnIndex + 1}${letter}`] ?? "").trim();
    const value = text.length > 0 ? Number(text) : NaN;
    return Number.isFinite(value) ? value : null;
  };
  const cytometer = [keywords["$CYT"], keywords["$CYTSN"]]
    .map((value) => (value ?? "").trim())
    .filter((value) => value.length > 0)
    .join(" ");
  return {
    id,
    fileName,
    labels,
    eventCount: sample.fcs.nEvents,
    channels: kept.map(({ channel }) => ({
      key: channel.key,
      pnn: channel.pnn,
      marker: channel.marker,
      range: channel.range,
      voltage: setting(channel.columnIndex, "V"),
      gain: setting(channel.columnIndex, "G"),
    })),
    values: (pnn) => {
      const index = indexByPnn.get(pnn);
      return index === undefined ? null : sample.originalColumnData(index);
    },
    scatter: { forward: scatterColumn(/^FSC/i), side: scatterColumn(/^SSC/i) },
    cytometer: cytometer.length > 0 ? cytometer : null,
    acquired: (keywords["$DATE"] ?? "").trim() || null,
    embedded: sample.fcs.spillover,
  };
}

/** The channels every file has, by $PnN, in the first file's order: the channels a matrix from these files can cover. */
export function sharedChannels(files: readonly ControlFile[]): ControlChannel[] {
  if (files.length === 0) return [];
  return files[0].channels.filter((channel) =>
    files.every((file) => file.channels.some((other) => other.pnn === channel.pnn)));
}

/** Events of one file: all of them, or those in a mask (a gated population), within bounds on one channel. */
export interface EventSet {
  readonly fileId: string;
  /** One byte per event, non-zero for the events to take; all events where absent. */
  readonly mask?: Uint8Array | null;
  /** Bounds on the control's own channel, in raw units: lower inclusive, upper exclusive. */
  readonly lower?: number;
  readonly upper?: number;
}

/** The event indices of a set, given the bounded channel's values. */
export function eventIndices(set: EventSet, bounded: ArrayLike<number>): Uint32Array {
  const lower = set.lower ?? -Infinity;
  const upper = set.upper ?? Infinity;
  const mask = set.mask ?? null;
  const out = new Uint32Array(bounded.length);
  let count = 0;
  for (let event = 0; event < bounded.length; event++) {
    if (mask && !mask[event]) continue;
    const value = bounded[event];
    if (value >= lower && value < upper) out[count++] = event;
  }
  return out.subarray(0, count);
}

/** The finite values of a column at the given events (all events where none are given), ascending. */
export function sortedValues(column: ArrayLike<number>, events?: ArrayLike<number> | null): Float64Array {
  const n = events ? events.length : column.length;
  const out = new Float64Array(n);
  let count = 0;
  for (let k = 0; k < n; k++) {
    const value = column[events ? events[k] : k];
    if (Number.isFinite(value)) out[count++] = value;
  }
  return out.subarray(0, count).sort();
}

/** Every `stride`-th event, so that at most `limit` are read: the same events on every call. */
export function strideEvents(eventCount: number, limit: number): Uint32Array {
  const stride = Math.max(1, Math.ceil(eventCount / limit));
  const out = new Uint32Array(Math.ceil(eventCount / stride));
  for (let k = 0; k < out.length; k++) out[k] = k * stride;
  return out;
}

/** Median and robust SD (1.4826 × the median absolute deviation) of ascending values. */
export function robustCentre(sorted: Float64Array): { median: number; rsd: number } {
  const median = medianSorted(sorted);
  if (!Number.isFinite(median)) return { median: NaN, rsd: NaN };
  const deviations = new Float64Array(sorted.length);
  for (let k = 0; k < sorted.length; k++) deviations[k] = Math.abs(sorted[k] - median);
  return { median, rsd: 1.4826 * medianSorted(deviations.sort()) };
}

export { medianSorted, quantileSorted };
