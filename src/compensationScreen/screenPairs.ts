// screenPairs.ts — every channel pair of a mass-cytometry spillover matrix against the events.
//
// For each source → receiver pair the matrix could hold, the screen reads from the stored counts
// the coefficient the events support (floorEstimate.ts) and sets it beside the matrix's value:
//
//   above-data     the matrix value is more than the events allow (too high). One-sided, and it
//                  holds whatever the cells express.
//   below-floor    the receiver's floor rises faster than the matrix value explains, on a pair
//                  with a physical route for spillover, with a floor as tight as counting noise
//                  (too low, or missing where the matrix holds 0).
//   upper-bound-only  the floor rises faster than the matrix value explains, but it is as wide
//                  as a stained population, or steeper than spillover is: a marker on the same
//                  cells. The events give only an upper bound, and the matrix is inside it.
//   consistent     the matrix value lies between the floor and the upper bound.
//   too-dim        the source is not bright enough in these events for the pair to be read.
//
// Nothing here changes a matrix or solves a compensation. A verdict is a reading of one file's
// events: a prompt to look at the pair, with the numbers it rests on.
//
// The value of a pair is read with the rest of the matrix taken as given: every other source's
// first-order contribution to the receiver is taken off before the floor is fitted, so a pair is
// not charged with a neighbour's spillover.

import { cytofInteractionType, parseCytofIsotope, type CytofInteractionType } from "../engine/compensationMatrixView";
import {
  estimateFloor,
  groupEventsBySource,
  type FloorEstimate,
  type SourceGroups,
} from "./floorEstimate";

export interface ScreenChannel {
  /** $PnN, the channel's identity in the file and in the matrix. */
  readonly pnn: string;
  /** $PnS, where the file gives one. */
  readonly marker: string | null;
}

/** The events a screen reads: stored raw counts for one fixed set of events. */
export interface ScreenData {
  readonly eventCount: number;
  readonly channels: readonly ScreenChannel[];
  /** One value per screened event, by $PnN; null where the file has no such channel. */
  values(pnn: string): ArrayLike<number> | null;
}

/** A spillover matrix, rows the source and columns the receiver, as a profile stores it. */
export interface ScreenMatrix {
  readonly sourceChannels: readonly string[];
  readonly receiverChannels: readonly string[];
  readonly matrix: readonly (readonly number[])[];
}

export interface ScreenSettings {
  /** A pair is read only where the coefficient in question is worth this many counts over the source's range. */
  readonly minimumCounts: number;
  /** The matrix and the events disagree only beyond this factor … */
  readonly ratioMargin: number;
  /** … and beyond this absolute difference in the coefficient. */
  readonly absoluteMargin: number;
  /** A floor wider than this many times counting noise is a stained population, not spill. */
  readonly tightnessLimit: number;
  /** A floor slope above this is steeper than spillover in mass cytometry is taken to be. */
  readonly plausibleMaximum: number;
  /** Where the matrix holds 0, a source that could not show a spill of this size is too dim to say so. */
  readonly dimLimit: number;
  /** `physical`: pairs with a non-zero coefficient or a physical route. `all`: every pair. */
  readonly pairs: "physical" | "all";
}

/**
 * The defaults. `plausibleMaximum` follows CytoSpill's bound ("spillover effects are generally
 * less than 10%", Miao et al. 2021, Cytometry A, Methods 2.4.1). The others were set on
 * simulated panels (spikeIn tests) and are open to change.
 */
export const DEFAULT_SCREEN_SETTINGS: ScreenSettings = Object.freeze({
  minimumCounts: 10,
  ratioMargin: 1.5,
  absoluteMargin: 0.002,
  tightnessLimit: 3,
  plausibleMaximum: 0.1,
  dimLimit: 0.01,
  pairs: "physical",
});

export type ScreenVerdict =
  | "above-data"
  | "below-floor"
  | "upper-bound-only"
  | "consistent"
  | "too-dim";

/** Why a floor that rises faster than the matrix explains is not read as spillover. */
export type UpperBoundReason = "wide-floor" | "above-plausible" | "no-physical-route" | "loose-bound";

export interface ScreenPair {
  readonly source: string;
  readonly receiver: string;
  /** The matrix's coefficient; 0 where the matrix holds none. */
  readonly coefficient: number;
  readonly interaction: CytofInteractionType;
  /** The receiver carries no antibody in this file, so nothing but spillover should put counts in it. */
  readonly receiverUnlabelled: boolean;
  readonly verdict: ScreenVerdict;
  readonly upperBoundReason: UpperBoundReason | null;
  /** Absent only where the source gave no groups. */
  readonly floor: FloorEstimate | null;
  /** Lower end of the floor slope's interval, never below 0. */
  readonly floorLower: number | null;
  /** The smallest coefficient this source's events could show. */
  readonly detectionLimit: number | null;
  /**
   * Counts the receiver gains or loses in the source's bright events if the matrix value were
   * replaced by the floor slope, in units of the receiver's own spread in source-dim events.
   * How much the disagreement matters to the data; the screen is ordered by it.
   */
  readonly impact: number;
}

/** The oxide (+16) pairs of a run share their plasma conditions, so they are read together. */
export interface OxideScale {
  /** Oxide pairs with a non-zero coefficient, bright enough, with a tight floor. */
  readonly pairs: readonly Readonly<{ source: string; receiver: string; ratio: number }>[];
  /** Median of floor slope over matrix value across those pairs. */
  readonly ratio: number;
  readonly lowestRatio: number;
  readonly highestRatio: number;
  /** At least two pairs, every one away from 1 in the same direction, within a factor 1.5 of each other. */
  readonly shared: boolean;
}

export interface ScreenResult {
  /** Most consequential first: verdicts that ask for attention, then by impact. */
  readonly pairs: readonly ScreenPair[];
  readonly oxide: OxideScale | null;
  readonly eventCount: number;
  /** Matrix sources the file holds but whose events gave no groups, with the reason. */
  readonly unreadSources: readonly Readonly<{ source: string; reason: "few-events" | "no-range" }>[];
  readonly settings: ScreenSettings;
}

const VERDICT_ORDER: Record<ScreenVerdict, number> = {
  "above-data": 0,
  "below-floor": 0,
  "upper-bound-only": 1,
  consistent: 2,
  "too-dim": 3,
};

/** A channel whose $PnS names no antigen: nothing, the $PnN again, or only the channel's own isotope. */
export function channelIsUnlabelled(channel: ScreenChannel): boolean {
  const marker = channel.marker?.trim() ?? "";
  if (marker === "" || marker === channel.pnn) return true;
  const own = parseCytofIsotope(channel.pnn);
  const named = parseCytofIsotope(marker);
  // "B220" reads as an isotope too: only the channel's own isotope counts as no label.
  if (!own || !named || own.element !== named.element || own.mass !== named.mass) return false;
  const rest = marker
    .replace(String(named.mass), "")
    .replace(named.element, "")
    .replace(/Di\b/, "")
    .replace(/[\s_()\-]/g, "");
  return rest === "";
}

interface PreparedScreen {
  readonly data: ScreenData;
  readonly settings: ScreenSettings;
  readonly coefficient: (source: string, receiver: string) => number;
  readonly sources: readonly string[];
  readonly receivers: readonly string[];
  readonly unlabelled: ReadonlySet<string>;
  /** Per receiver, the first-order spillover the whole matrix puts into it, per screened event. */
  readonly spillIn: Map<string, Float64Array>;
  /** Per channel, its stored counts less the first-order spillover into it. */
  readonly own: Map<string, Float64Array>;
  /** Every matrix source the file holds, whichever of them are being read. */
  readonly emitters: readonly string[];
}

function prepare(data: ScreenData, matrix: ScreenMatrix, settings: ScreenSettings): PreparedScreen {
  const sourceIndex = new Map(matrix.sourceChannels.map((channel, index) => [channel, index]));
  const receiverIndex = new Map(matrix.receiverChannels.map((channel, index) => [channel, index]));
  const coefficient = (source: string, receiver: string): number => {
    const row = sourceIndex.get(source);
    const column = receiverIndex.get(receiver);
    if (row === undefined || column === undefined) return 0;
    const value = matrix.matrix[row]?.[column];
    return Number.isFinite(value) ? value : 0;
  };
  const inFile = new Set(data.channels.map((channel) => channel.pnn));
  return {
    data,
    settings,
    coefficient,
    sources: matrix.sourceChannels.filter((channel) => inFile.has(channel)),
    receivers: matrix.receiverChannels.filter((channel) => inFile.has(channel)),
    unlabelled: new Set(data.channels.filter(channelIsUnlabelled).map((channel) => channel.pnn)),
    spillIn: new Map(),
    own: new Map(),
    emitters: matrix.sourceChannels.filter((channel) => inFile.has(channel)),
  };
}

/**
 * A channel's own signal: its stored counts less the first-order spillover the matrix puts into
 * it. Taking a neighbour's spill off with the neighbour's stored counts would take off, as well,
 * the spill the neighbour itself received.
 */
function ownSignal(prepared: PreparedScreen, channel: string): Float64Array | null {
  const cached = prepared.own.get(channel);
  if (cached) return cached;
  const stored = prepared.data.values(channel);
  if (!stored) return null;
  const own = Float64Array.from(stored);
  for (const source of prepared.emitters) {
    if (source === channel) continue;
    const value = prepared.coefficient(source, channel);
    if (!(value > 0)) continue;
    const signal = prepared.data.values(source);
    if (!signal) continue;
    for (let event = 0; event < own.length; event++) own[event] -= value * signal[event];
  }
  prepared.own.set(channel, own);
  return own;
}

function spillInto(prepared: PreparedScreen, receiver: string): Float64Array {
  const cached = prepared.spillIn.get(receiver);
  if (cached) return cached;
  const total = new Float64Array(prepared.data.eventCount);
  for (const source of prepared.emitters) {
    if (source === receiver) continue;
    const value = prepared.coefficient(source, receiver);
    if (!(value > 0)) continue;
    const signal = ownSignal(prepared, source);
    if (!signal) continue;
    for (let event = 0; event < total.length; event++) total[event] += value * signal[event];
  }
  prepared.spillIn.set(receiver, total);
  return total;
}

function classify(
  coefficient: number,
  interaction: CytofInteractionType,
  floor: FloorEstimate,
  settings: ScreenSettings,
): Pick<ScreenPair, "verdict" | "upperBoundReason" | "floorLower" | "detectionLimit"> {
  const floorLower = Math.max(0, floor.slope - 1.96 * floor.standardError);
  const detectionLimit = settings.minimumCounts / floor.span;
  const base = { floorLower, detectionLimit, upperBoundReason: null };

  const above = coefficient - floor.upperBound > settings.absoluteMargin &&
    coefficient > floor.upperBound * settings.ratioMargin &&
    coefficient >= detectionLimit;
  if (above) return { ...base, verdict: "above-data" };

  const below = floorLower - coefficient > settings.absoluteMargin &&
    floorLower > coefficient * settings.ratioMargin &&
    floorLower - coefficient >= detectionLimit;
  if (below) {
    const physical = interaction !== "other" && interaction !== "self";
    const upperBoundReason: UpperBoundReason | null = !physical
      ? "no-physical-route"
      : floor.slope > settings.plausibleMaximum
        ? "above-plausible"
        : floor.tightness > settings.tightnessLimit
          ? "wide-floor"
          : null;
    return upperBoundReason
      ? { ...base, verdict: "upper-bound-only", upperBoundReason }
      : { ...base, verdict: "below-floor" };
  }
  // The matrix value is under what these events could show, or, where it is 0, the source could
  // not show even a spill of `dimLimit`.
  const unread = coefficient > 0 ? coefficient < detectionLimit : detectionLimit > settings.dimLimit;
  if (unread) return { ...base, verdict: "too-dim" };
  // Events that could not rule out even the largest spillover expected say nothing for or
  // against the matrix value: a cap, not agreement.
  if (floor.upperBound > settings.plausibleMaximum && coefficient <= settings.plausibleMaximum) {
    return { ...base, verdict: "upper-bound-only", upperBoundReason: "loose-bound" };
  }
  return { ...base, verdict: "consistent" };
}

function screenSource(
  prepared: PreparedScreen,
  source: string,
  groups: SourceGroups,
  only?: (source: string, receiver: string) => boolean,
): ScreenPair[] {
  const { data, settings } = prepared;
  const signal = ownSignal(prepared, source)!;
  const pairs: ScreenPair[] = [];
  const adjusted = new Float64Array(data.eventCount);
  for (const receiver of prepared.receivers) {
    if (receiver === source) continue;
    if (only && !only(source, receiver)) continue;
    const coefficient = prepared.coefficient(source, receiver);
    const interaction = cytofInteractionType(source, receiver);
    const physical = interaction !== "other" && interaction !== "self";
    if (settings.pairs === "physical" && !physical && !(coefficient > 0)) continue;
    const measured = data.values(receiver);
    if (!measured) continue;
    // The receiver with every other source's spillover taken off, this pair's left in.
    const others = spillInto(prepared, receiver);
    for (let event = 0; event < adjusted.length; event++) {
      adjusted[event] = measured[event] - others[event] + coefficient * signal[event];
    }
    const floor = estimateFloor(groups, adjusted);
    const reading = classify(coefficient, interaction, floor, settings);
    const scale = Math.max(1, floor.referenceSpread);
    pairs.push({
      source,
      receiver,
      coefficient,
      interaction,
      receiverUnlabelled: prepared.unlabelled.has(receiver),
      floor,
      ...reading,
      impact: reading.verdict === "above-data"
        ? (coefficient - floor.upperBound) * floor.span / scale
        : reading.verdict === "below-floor" || reading.verdict === "upper-bound-only"
          ? (floor.slope - coefficient) * floor.span / scale
          : 0,
    });
  }
  return pairs;
}

function oxideScale(pairs: readonly ScreenPair[], settings: ScreenSettings): OxideScale | null {
  const members = pairs.flatMap((pair) => {
    if (pair.interaction !== "oxide (+16)" || !(pair.coefficient > 0) || !pair.floor) return [];
    if (pair.coefficient < (pair.detectionLimit ?? Infinity)) return [];
    if (pair.floor.tightness > settings.tightnessLimit) return [];
    if (pair.floor.slope > settings.plausibleMaximum) return [];
    return [{ source: pair.source, receiver: pair.receiver, ratio: pair.floor.slope / pair.coefficient }];
  });
  if (members.length === 0) return null;
  const ratios = members.map((member) => member.ratio).sort((left, right) => left - right);
  const middle = ratios.length / 2;
  const ratio = ratios.length % 2 === 1
    ? ratios[Math.floor(middle)]
    : (ratios[middle - 1] + ratios[middle]) / 2;
  const lowestRatio = ratios[0];
  const highestRatio = ratios[ratios.length - 1];
  const sameSide = lowestRatio > settings.ratioMargin || highestRatio < 1 / settings.ratioMargin;
  return {
    pairs: members,
    ratio,
    lowestRatio,
    highestRatio,
    shared: members.length >= 2 && sameSide && lowestRatio > 0 && highestRatio / lowestRatio <= 1.5,
  };
}

/**
 * A screen in steps, one source at a time, so a caller can give way between steps and stop when
 * its view is hidden. `runCompensationScreen` runs every step at once.
 */
export interface ScreenJob {
  /** Number of steps (one per matrix source the file holds). */
  readonly stepCount: number;
  /** Read the pairs of the next source. False once every source has been read. */
  step(): boolean;
  /** The result so far; complete once `step` has returned false. */
  result(): ScreenResult;
}

/** Which pairs to read: all the settings allow, or only those `only` accepts (one pair after an edit). */
export interface ScreenScope {
  readonly only?: (source: string, receiver: string) => boolean;
}

export function createScreenJob(
  data: ScreenData,
  matrix: ScreenMatrix,
  settings: Partial<ScreenSettings> = {},
  scope: ScreenScope = {},
): ScreenJob {
  const resolved: ScreenSettings = { ...DEFAULT_SCREEN_SETTINGS, ...settings };
  const whole = prepare(data, matrix, resolved);
  const only = scope.only;
  const prepared: PreparedScreen = only
    ? { ...whole, sources: whole.sources.filter((source) => whole.receivers.some((receiver) => only(source, receiver))) }
    : whole;
  const pairs: ScreenPair[] = [];
  const unreadSources: Array<{ source: string; reason: "few-events" | "no-range" }> = [];
  let next = 0;
  return {
    stepCount: prepared.sources.length,
    step() {
      if (next >= prepared.sources.length) return false;
      const source = prepared.sources[next++];
      // Grouped by the source's own signal: counts it received from a neighbour spill nothing.
      const grouped = groupEventsBySource(ownSignal(prepared, source)!);
      if (grouped.usable) pairs.push(...screenSource(prepared, source, grouped.source, only));
      else unreadSources.push({ source, reason: grouped.reason });
      return next < prepared.sources.length;
    },
    result() {
      const ordered = [...pairs].sort((left, right) =>
        VERDICT_ORDER[left.verdict] - VERDICT_ORDER[right.verdict] ||
        right.impact - left.impact ||
        right.coefficient - left.coefficient);
      return {
        pairs: ordered,
        oxide: oxideScale(pairs, resolved),
        eventCount: data.eventCount,
        unreadSources,
        settings: resolved,
      };
    },
  };
}

export function runCompensationScreen(
  data: ScreenData,
  matrix: ScreenMatrix,
  settings: Partial<ScreenSettings> = {},
  scope: ScreenScope = {},
): ScreenResult {
  const job = createScreenJob(data, matrix, settings, scope);
  while (job.step()) { /* every source */ }
  return job.result();
}

/**
 * The value to stage for a pair the screen asks attention for, and null for any other pair.
 * Above the data: the largest coefficient the events allow, the smallest change that brings the
 * matrix inside them. Below the floor: the floor's own slope, which the events show even where
 * some of the source's cells carry the receiver's marker; it is never more than they support.
 */
export function suggestedCoefficient(pair: ScreenPair): number | null {
  if (!pair.floor) return null;
  if (pair.verdict === "above-data") return pair.floor.upperBound;
  if (pair.verdict === "below-floor") return Math.max(0, pair.floor.slope);
  return null;
}

/**
 * The events of one pair as the screen fitted them, for drawing: the source's own signal, and
 * the receiver with every other source's spillover taken off and this pair's left in.
 */
export function screenPairEvents(
  data: ScreenData,
  matrix: ScreenMatrix,
  source: string,
  receiver: string,
): Readonly<{ source: Float64Array; receiver: Float64Array }> | null {
  const prepared = prepare(data, matrix, DEFAULT_SCREEN_SETTINGS);
  const signal = ownSignal(prepared, source);
  const measured = data.values(receiver);
  if (!signal || !measured) return null;
  const others = spillInto(prepared, receiver);
  const coefficient = prepared.coefficient(source, receiver);
  const adjusted = new Float64Array(data.eventCount);
  for (let event = 0; event < adjusted.length; event++) {
    adjusted[event] = measured[event] - others[event] + coefficient * signal[event];
  }
  return { source: signal, receiver: adjusted };
}
