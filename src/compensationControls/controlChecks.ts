// controlChecks.ts — three checks on a set of controls and the matrix calculated from them.
//
// 1. Settings. A spillover coefficient is a ratio of two detectors' signals, so it holds only at
//    the detector voltages (or gains) the controls were run at. The files record them ($PnV,
//    $PnG): every control and sample is compared, with the cytometer and the date.
// 2. Brightness. Beyond the brightness of a control's positive events the matrix is extrapolated.
//    A stained sample, compensated with the matrix, is compared channel by channel with the
//    brightest events of that channel's control.
// 3. Fluorescence-minus-one. In an FMO control nothing is stained in the channel left out, so
//    after compensation the events bright in any other channel should sit, in that channel, where
//    the dim ones do. The difference, per unit of the other channel, is what is left of that one
//    coefficient's error. Two things other than the coefficient can move it: a third stain carried
//    by the same cells whose own coefficient is wrong, and background that differs between the
//    bright and the dim cells. It is a residual to look at, not a correction to apply.
//
// None of these changes a matrix: each returns findings for the report.

import { invertMatrix } from "../engine/compensation";
import {
  eventIndices,
  medianSorted,
  quantileSorted,
  robustCentre,
  sortedValues,
  strideEvents,
  type ControlFile,
} from "./controlFile";
import { splitControl } from "./controlSplit";
import type { ControlSpec } from "./spilloverEstimate";

/** Events read from a sample or an FMO control: every n-th, the same each time. */
const CHECK_EVENTS = 50_000;
/** An FMO residual of this size or more is flagged, where it is also three times its own uncertainty. */
export const FMO_RESIDUAL_FLAG = 0.01;
/** Fewest bright and dim events for an FMO residual. */
const FMO_MIN_EVENTS = 50;

export type SettingsFinding =
  /** A file was run at another voltage or gain than the rest, in a channel of the matrix. */
  | Readonly<{
      code: "setting-differs";
      setting: "voltage" | "gain";
      fileId: string;
      channel: string;
      value: number;
      expected: number;
    }>
  /** No file records a voltage or a gain for these channels: they cannot be compared. */
  | Readonly<{ code: "settings-not-recorded"; channels: readonly string[] }>
  | Readonly<{ code: "cytometer-differs"; fileId: string; cytometer: string; expected: string }>
  | Readonly<{ code: "date-differs"; fileId: string; acquired: string; expected: string }>;

function mostCommon<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  let best: T | undefined;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (best === undefined || count > (counts.get(best) ?? 0)) best = value;
  }
  return best;
}

/**
 * Compares the acquisition settings of the controls and the samples over the matrix's channels.
 * What is expected is what most of the files have (the samples' value where two are as common);
 * every file that records something else is a finding.
 */
export function checkSettings(
  controls: readonly ControlFile[],
  samples: readonly ControlFile[],
  channels: readonly string[],
): SettingsFinding[] {
  const files = [...controls, ...samples];
  // Samples first, so that of two values as common as each other the samples' is the expected one.
  const reference = [...samples, ...controls];
  const findings: SettingsFinding[] = [];
  const unrecorded: string[] = [];
  const recorded = <T>(values: readonly (T | null | undefined)[]): T[] =>
    values.filter((value): value is T => value !== null && value !== undefined);

  for (const channel of channels) {
    let any = false;
    for (const setting of ["voltage", "gain"] as const) {
      const of = (file: ControlFile) => file.channels.find((candidate) => candidate.pnn === channel)?.[setting];
      const expected = mostCommon(recorded(reference.map(of))) ?? mostCommon(recorded(files.map(of)));
      if (expected === undefined) continue;
      any = true;
      for (const file of files) {
        const value = of(file);
        if (value !== null && value !== undefined && value !== expected) {
          findings.push({ code: "setting-differs", setting, fileId: file.id, channel, value, expected });
        }
      }
    }
    if (!any) unrecorded.push(channel);
  }
  if (unrecorded.length > 0) findings.push({ code: "settings-not-recorded", channels: unrecorded });

  const cytometer = mostCommon(recorded(reference.map((file) => file.cytometer))) ?? mostCommon(recorded(files.map((file) => file.cytometer)));
  const acquired = mostCommon(recorded(reference.map((file) => file.acquired))) ?? mostCommon(recorded(files.map((file) => file.acquired)));
  for (const file of files) {
    if (cytometer !== undefined && file.cytometer && file.cytometer !== cytometer) {
      findings.push({ code: "cytometer-differs", fileId: file.id, cytometer: file.cytometer, expected: cytometer });
    }
    if (acquired !== undefined && file.acquired && file.acquired !== acquired) {
      findings.push({ code: "date-differs", fileId: file.id, acquired: file.acquired, expected: acquired });
    }
  }
  return findings;
}

/** The file's values compensated with the matrix, one column per channel, at the events given. */
function compensatedAt(
  file: ControlFile,
  channels: readonly string[],
  inverse: readonly (readonly number[])[],
  events: Uint32Array,
): Float64Array[] | null {
  const columns = channels.map((channel) => file.values(channel));
  if (columns.some((column) => column === null)) return null;
  const out = channels.map(() => new Float64Array(events.length));
  for (let k = 0; k < events.length; k++) {
    const event = events[k];
    for (let j = 0; j < channels.length; j++) {
      let value = 0;
      for (let i = 0; i < channels.length; i++) value += (columns[i] as ArrayLike<number>)[event] * inverse[i][j];
      out[j][k] = value;
    }
  }
  return out;
}

export interface BrightnessFinding {
  readonly channel: string;
  /** The 99th percentile of the control's positive events above its negative median, raw units. */
  readonly controlTop: number;
  /** The 99th percentile of the sample in this channel, compensated with the matrix. */
  readonly sampleTop: number;
  /** sampleTop over controlTop. */
  readonly ratio: number;
  /** True where the sample is brighter than the control reaches. */
  readonly exceeds: boolean;
}

/**
 * For every channel with a control: how the brightest events of a stained sample compare with the
 * brightest events of that control. Empty where the matrix cannot be inverted or the sample lacks
 * a channel.
 */
export function checkBrightness(
  files: readonly ControlFile[],
  channels: readonly string[],
  controls: readonly ControlSpec[],
  matrix: readonly (readonly number[])[],
  sample: ControlFile,
): BrightnessFinding[] {
  const inverse = invertMatrix(matrix.map((row) => [...row]));
  if (!inverse) return [];
  const compensated = compensatedAt(sample, channels, inverse, strideEvents(sample.eventCount, CHECK_EVENTS));
  if (!compensated) return [];
  const findings: BrightnessFinding[] = [];
  for (const spec of controls) {
    const j = channels.indexOf(spec.channel);
    const positiveFile = files.find((file) => file.id === spec.positive.fileId);
    const negativeFile = files.find((file) => file.id === spec.negative.fileId);
    const positiveOwn = positiveFile?.values(spec.channel);
    const negativeOwn = negativeFile?.values(spec.channel);
    if (j < 0 || !positiveOwn || !negativeOwn) continue;
    const positive = sortedValues(positiveOwn, eventIndices(spec.positive, positiveOwn));
    const negative = sortedValues(negativeOwn, eventIndices(spec.negative, negativeOwn));
    const controlTop = quantileSorted(positive, 0.99) - medianSorted(negative);
    const sampleTop = quantileSorted(compensated[j].slice().sort(), 0.99);
    if (!(controlTop > 0) || !Number.isFinite(sampleTop)) continue;
    const ratio = sampleTop / controlTop;
    findings.push({ channel: spec.channel, controlTop, sampleTop, ratio, exceeds: ratio > 1 });
  }
  return findings;
}

export interface FmoResidual {
  /** The stained channel whose bright and dim events are compared. */
  readonly source: string;
  /** The channel left out of the FMO control. */
  readonly receiver: string;
  /**
   * What is left in the receiver per unit of the source, after compensation: positive where the
   * coefficient source-into-receiver looks too small, negative where it looks too large.
   */
  readonly residual: number;
  /** The same in the receiver's own units: median of the bright events minus median of the dim. */
  readonly shift: number;
  /** About one standard error of the residual, from the receiver's spread in the two sets. */
  readonly uncertainty: number;
  readonly brightCount: number;
  readonly dimCount: number;
  readonly flagged: boolean;
}

/**
 * The residuals of an FMO control for the channel it leaves out, one per other channel in which the
 * control has a dim and a bright population of its own (a channel with one population gives none).
 * Empty where the matrix cannot be inverted or the control lacks a channel.
 */
export function fmoResiduals(
  fmo: ControlFile,
  omitted: string,
  channels: readonly string[],
  matrix: readonly (readonly number[])[],
): FmoResidual[] {
  const receiver = channels.indexOf(omitted);
  const inverse = invertMatrix(matrix.map((row) => [...row]));
  if (receiver < 0 || !inverse) return [];
  const compensated = compensatedAt(fmo, channels, inverse, strideEvents(fmo.eventCount, CHECK_EVENTS));
  if (!compensated) return [];
  const residuals: FmoResidual[] = [];
  channels.forEach((source, i) => {
    if (i === receiver) return;
    const range = fmo.channels.find((channel) => channel.pnn === source)?.range ?? 0;
    const split = splitControl(compensated[i], range);
    if (!split?.bimodal) return;
    const dim = eventIndices({ fileId: fmo.id, upper: split.negativeUpper }, compensated[i]);
    const bright = eventIndices({ fileId: fmo.id, lower: split.positiveLower }, compensated[i]);
    if (dim.length < FMO_MIN_EVENTS || bright.length < FMO_MIN_EVENTS) return;
    const span = medianSorted(sortedValues(compensated[i], bright)) - medianSorted(sortedValues(compensated[i], dim));
    if (!(span > 0)) return;
    const brightReceiver = robustCentre(sortedValues(compensated[receiver], bright));
    const dimReceiver = robustCentre(sortedValues(compensated[receiver], dim));
    const shift = brightReceiver.median - dimReceiver.median;
    // The standard error of a median is about 1.25 SD over the square root of the count.
    const uncertainty =
      (1.2533 * Math.hypot(brightReceiver.rsd / Math.sqrt(bright.length), dimReceiver.rsd / Math.sqrt(dim.length))) / span;
    const residual = shift / span;
    residuals.push({
      source,
      receiver: omitted,
      residual,
      shift,
      uncertainty,
      brightCount: bright.length,
      dimCount: dim.length,
      flagged: Math.abs(residual) >= FMO_RESIDUAL_FLAG && Math.abs(residual) >= 3 * uncertainty,
    });
  });
  return residuals.sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));
}
