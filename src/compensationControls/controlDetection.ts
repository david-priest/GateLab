// controlDetection.ts — what each loaded file is, for a compensation calculation.
//
// Every file is given a role: the single-stained control for one channel, an unstained control, a
// fluorescence-minus-one control (by its name only: used to check a matrix, never to calculate
// one), a file stained with more than one fluorochrome (a sample, or a contaminated control: not
// used), or unknown. The file's names are read first (controlNames.ts) and its signal second:
//
//   - the negative level of each channel is taken from the files named unstained, or without one
//     from the low end of every file (its 5th to 25th percentile: the negative events of a control
//     that has any, whatever spills into the channel from its positive ones), the middle file
//     deciding;
//   - a file with no channel above that level is unstained;
//   - a file is the control for the channel a name gives it, or else for a channel that holds at
//     least half its largest signal, one file per channel, matched so that as many files as
//     possible get a channel. A control whose spillover into a neighbour exceeds 1 is brightest
//     in the neighbour's channel; the neighbour's own control can go nowhere else, so the first
//     is moved to its own;
//   - a file is stained with more than one fluorochrome where a second channel is bright on a
//     twentieth of its events that are not positive in the first, or on a tenth of the events
//     positive in the first at more than three times the ratio the rest of them show. Spillover
//     is one ratio for every positive event; a second stain is not. A few events of another
//     stain (beads carried over from the tube before, a few autofluorescent cells) do not make a
//     control a sample;
//   - a file with strong signal in a channel whose control is named, and with no channel named
//     itself, is a sample and not a second control (a sorted population positive for one marker).
//
// Everything here is a proposal for the user to confirm: each result says how it was reached.

import {
  quantileSorted,
  sharedChannels,
  sortedValues,
  strideEvents,
  type ControlChannel,
  type ControlFile,
} from "./controlFile";
import { namedChannel, namedFmo, namedParticle, namedUnstained } from "./controlNames";

/** Events read per file for detection: every n-th event, the same ones each time. */
const DETECTION_EVENTS = 20_000;
/** A channel is above the negative level where its excess is more than this many times the level's scale. */
export const ELEVATED_FOLD = 2;
/** A file is given a channel on its signal alone only at this fold or more. */
export const STRONG_FOLD = 10;
/** A channel can be a file's own only where it holds this fraction of the file's largest excess. */
const OWN_CHANNEL_FRACTION = 0.5;
/** A second stain's ratio to the first channel is more than this many times the ratio of the events that only spill. */
const INDEPENDENT_RATIO = 3;
/** A second stain on particles negative in the first channel: at least this fraction of the events read. */
const ALONE_FRACTION = 0.05;
/** A second stain on particles positive in the first channel: at least this fraction of them. */
const TOGETHER_FRACTION = 0.1;
/** Without an unstained file, the negative 99th percentile is the 25th plus this many times the 5th-to-25th distance. */
const LOW_END_WIDTHS = 3;
/** Fewest events for a second stain, whatever the fractions give. */
const TOP_EVENTS = 20;

export type ControlRole = "single-stain" | "unstained" | "fmo" | "mixed" | "unknown";

export type ControlNote =
  /** A name gives a channel the file is not brightest in. */
  | "name-and-signal-disagree"
  /** A name gives a channel in which the file has no signal above the negative level. */
  | "named-channel-has-no-signal"
  /** The names fit several channels equally; the signal chose, or nothing did. */
  | "name-fits-several-channels"
  /** Signal above the negative level, but too little to give the file a channel without a name. */
  | "weak-signal";

export interface DetectedControl {
  readonly fileId: string;
  readonly role: ControlRole;
  /**
   * The channel the file is (or, for a mixed file, would be) the control for; for an FMO control
   * the channel left out; null where none.
   */
  readonly channel: string | null;
  /** What decided the role and channel. */
  readonly matchedBy: "name" | "signal" | "name-and-signal" | null;
  /** True where a brighter file is the control for the same channel: this one is not used unless chosen. */
  readonly duplicate: boolean;
  /** Beads or cells, where a name says so. */
  readonly particle: "beads" | "cells" | null;
  /** The channel the file is furthest above the negative level in, in raw units, and by what fold. */
  readonly brightest: Readonly<{ channel: string; fold: number }> | null;
  /** How far above the negative level the file is in `channel`. */
  readonly fold: number | null;
  /** The channels holding a second stain (role "mixed"). */
  readonly independentChannels: readonly string[];
  readonly notes: readonly ControlNote[];
}

export interface ControlDetection {
  /** The channels every file has: what a matrix from these files covers. */
  readonly channels: readonly ControlChannel[];
  /** One entry per file, in the order given. */
  readonly controls: readonly DetectedControl[];
  /** Channels with no single-stained control (duplicates and mixed files not counted). */
  readonly channelsWithoutControl: readonly string[];
}

interface FileSignal {
  readonly events: Uint32Array;
  readonly p05: Float64Array;
  readonly p25: Float64Array;
  readonly p50: Float64Array;
  readonly p99: Float64Array;
}

function fileSignal(file: ControlFile, channels: readonly ControlChannel[]): FileSignal {
  const events = strideEvents(file.eventCount, DETECTION_EVENTS);
  const quantiles = [0.05, 0.25, 0.5, 0.99].map(() => new Float64Array(channels.length));
  channels.forEach((channel, j) => {
    const sorted = sortedValues(file.values(channel.pnn) ?? [], events);
    [0.05, 0.25, 0.5, 0.99].forEach((p, q) => { quantiles[q][j] = quantileSorted(sorted, p); });
  });
  const [p05, p25, p50, p99] = quantiles;
  return { events, p05, p25, p50, p99 };
}

function middle(values: number[], few: boolean): number {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return NaN;
  return few ? finite[0] : quantileSorted(finite, 0.5);
}

export function detectControls(files: readonly ControlFile[]): ControlDetection {
  const channels = sharedChannels(files);
  const keys = channels.map((channel) => channel.pnn);
  const signals = files.map((file) => fileSignal(file, channels));
  const unstainedByName = files.map((file) => namedUnstained(file));
  // A marker is read from any file that gives one for the channel: control tubes often carry no
  // $PnS, and an FMO control is named for the marker its samples carry ("FMO CD45RA").
  const markers = new Map<string, string>();
  for (const file of files) {
    for (const channel of file.channels) {
      if (channel.marker && !markers.has(channel.pnn)) markers.set(channel.pnn, channel.marker);
    }
  }
  const named = channels.map((channel) => ({ ...channel, marker: channel.marker ?? markers.get(channel.pnn) ?? null }));
  const names = files.map((file, f) =>
    unstainedByName[f] ? { channel: null, candidates: [] as readonly string[] } : namedChannel(file, named));

  // The negative level of each channel (the median and 99th percentile of negative events) and
  // its scale. From the files named unstained those are read directly. Without one, the median is
  // the middle file's 25th percentile and the 99th percentile is that plus three times the middle
  // file's distance from its 5th to its 25th percentile: for a file of negative events alone that
  // overstates the 99th percentile a little, and it is not moved by positive events until they
  // are three quarters of a file.
  const unstainedFiles = files.map((_, f) => f).filter((f) => unstainedByName[f]);
  const few = files.length < 3;
  const ref50 = keys.map((_, j) => unstainedFiles.length > 0
    ? middle(unstainedFiles.map((f) => signals[f].p50[j]), false)
    : middle(signals.map((signal) => signal.p25[j]), few));
  const ref99 = keys.map((_, j) => unstainedFiles.length > 0
    ? middle(unstainedFiles.map((f) => signals[f].p99[j]), false)
    : ref50[j] + LOW_END_WIDTHS * middle(signals.map((signal) => signal.p25[j] - signal.p05[j]), few));
  const scale = keys.map((_, j) => Math.max(ref99[j], 2 * (ref99[j] - ref50[j]), 1e-9));
  const excess = (f: number, j: number): number => signals[f].p99[j] - ref99[j];
  const fold = (f: number, j: number): number => excess(f, j) / scale[j];

  const brightestOf = files.map((_, f) => {
    let best = -1;
    for (let j = 0; j < keys.length; j++) {
      if (Number.isFinite(excess(f, j)) && (best < 0 || excess(f, j) > excess(f, best))) best = j;
    }
    return best;
  });
  const isOwn = (f: number, j: number): boolean =>
    fold(f, j) > ELEVATED_FOLD && excess(f, j) >= OWN_CHANNEL_FRACTION * excess(f, brightestOf[f]);

  // A second stain: channel j against the file's first channel i.
  const independent = (f: number, i: number): string[] => {
    const file = files[f];
    const own = file.values(keys[i]);
    if (!own) return [];
    const { events } = signals[f];
    const ownPositive: number[] = [];
    const ownNegative: number[] = [];
    for (const event of events) {
      (own[event] - ref50[i] > ELEVATED_FOLD * scale[i] ? ownPositive : ownNegative).push(event);
    }
    const out: string[] = [];
    for (let j = 0; j < keys.length; j++) {
      if (j === i || fold(f, j) < STRONG_FOLD) continue;
      const other = file.values(keys[j]);
      if (!other) continue;
      const strong = (event: number): boolean => other[event] - ref99[j] >= STRONG_FOLD * scale[j];
      const alone = ownNegative.filter(strong).length;
      if (alone >= Math.max(TOP_EVENTS, ALONE_FRACTION * events.length)) {
        out.push(keys[j]);
        continue;
      }
      // The ratio of the events that only spill: the lower quartile of the positive events' ratios.
      const ratios = ownPositive.map((event) => (other[event] - ref50[j]) / (own[event] - ref50[i]));
      const spill = Math.max(quantileSorted(Float64Array.from(ratios).sort(), 0.25), 0);
      const together = ownPositive.filter((event, k) => strong(event) && ratios[k] > INDEPENDENT_RATIO * spill).length;
      if (together >= Math.max(TOP_EVENTS, TOGETHER_FRACTION * ownPositive.length)) out.push(keys[j]);
    }
    return out;
  };

  type Draft = {
    role: ControlRole;
    channel: number;
    matchedBy: DetectedControl["matchedBy"];
    duplicate: boolean;
    independentChannels: string[];
    notes: ControlNote[];
  };
  const drafts: Array<Draft | null> = files.map(() => null);
  const claimedBy = new Map<number, number>();
  const draft = (role: ControlRole, channel: number, matchedBy: Draft["matchedBy"], notes: ControlNote[] = []): Draft =>
    ({ role, channel, matchedBy, duplicate: false, independentChannels: [], notes });

  // 1. Unstained by name; files with a second stain, judged against the channel a name gives or the brightest.
  files.forEach((_, f) => {
    if (unstainedByName[f]) {
      drafts[f] = draft("unstained", -1, "name");
      return;
    }
    if (namedFmo(files[f])) {
      const omitted = names[f].channel === null ? -1 : keys.indexOf(names[f].channel as string);
      drafts[f] = draft("fmo", omitted, "name", names[f].candidates.length > 1 ? ["name-fits-several-channels"] : []);
      return;
    }
    if (keys.length < 2 || brightestOf[f] < 0) return;
    const named = names[f].channel === null ? -1 : keys.indexOf(names[f].channel as string);
    // A name is judged in its own channel only where the file is strong there: a word in a
    // sample's name ("higher APC voltage") does not make APC the channel its stains are read against.
    const first = named >= 0 && fold(f, named) >= STRONG_FOLD ? named : brightestOf[f];
    if (fold(f, first) < STRONG_FOLD) return;
    const second = independent(f, first);
    if (second.length > 0) {
      drafts[f] = { ...draft("mixed", first, null), independentChannels: second };
    }
  });

  // 2. Files a name gives one channel. Of two files named for a channel, one whose signal agrees
  // with its name keeps it over one whose signal does not, and then the brighter.
  const byName = files
    .map((_, f) => ({ f, j: names[f].channel === null ? -1 : keys.indexOf(names[f].channel as string) }))
    .filter(({ f, j }) => drafts[f] === null && j >= 0)
    .sort((a, b) => Number(isOwn(b.f, b.j)) - Number(isOwn(a.f, a.j)) || excess(b.f, b.j) - excess(a.f, a.j));
  for (const { f, j } of byName) {
    const confirmed = isOwn(f, j);
    const notes: ControlNote[] = confirmed
      ? []
      : [fold(f, j) > ELEVATED_FOLD ? "name-and-signal-disagree" : "named-channel-has-no-signal"];
    drafts[f] = draft("single-stain", j, confirmed ? "name-and-signal" : "name", notes);
    if (claimedBy.has(j)) (drafts[f] as Draft).duplicate = true;
    else claimedBy.set(j, f);
  }

  // 3. The rest by signal, one file per channel, so that as many files as possible get a channel
  // (augmenting paths). Files are taken brightest first and each tries its channels brightest
  // first; a file already placed is moved to its next channel when that frees one for another.
  const open = new Map<number, { channels: number[]; tied: boolean }>();
  files.forEach((_, f) => {
    if (drafts[f] !== null) return;
    const own = keys.map((_, j) => j).filter((j) => isOwn(f, j) && fold(f, j) >= STRONG_FOLD && !claimedBy.has(j));
    const tie = names[f].candidates.map((key) => keys.indexOf(key)).filter((j) => own.includes(j));
    const eligible = (tie.length > 0 ? tie : own).sort((a, b) => excess(f, b) - excess(f, a));
    if (eligible.length > 0) open.set(f, { channels: eligible, tied: tie.length > 0 });
  });
  const owner = new Map<number, number>();
  const place = (f: number, visited: Set<number>): boolean => {
    for (const j of open.get(f)?.channels ?? []) {
      if (visited.has(j)) continue;
      visited.add(j);
      const holder = owner.get(j);
      if (holder === undefined || place(holder, visited)) {
        owner.set(j, f);
        return true;
      }
    }
    return false;
  };
  [...open.keys()]
    .sort((a, b) => excess(b, brightestOf[b]) - excess(a, brightestOf[a]))
    .forEach((f) => place(f, new Set()));
  for (const [j, f] of owner) {
    drafts[f] = draft("single-stain", j, open.get(f)?.tied ? "name-and-signal" : "signal");
    claimedBy.set(j, f);
  }

  // 4. What is left: unstained, a second control for a channel already taken, or unknown.
  files.forEach((_, f) => {
    if (drafts[f] !== null) return;
    const tiedName: ControlNote[] = names[f].candidates.length > 1 ? ["name-fits-several-channels"] : [];
    const best = brightestOf[f];
    if (best < 0 || fold(f, best) <= ELEVATED_FOLD) {
      drafts[f] = draft("unstained", -1, "signal", tiedName);
    } else if (fold(f, best) >= STRONG_FOLD) {
      const holder = claimedBy.get(best);
      const holderNamed = holder !== undefined && drafts[holder]?.matchedBy !== "signal";
      if (holderNamed && names[f].candidates.length === 0) {
        // The channel's control is named and this file is not: a sample, not a second control.
        drafts[f] = draft("mixed", best, null);
      } else {
        drafts[f] = { ...draft("single-stain", best, "signal", tiedName), duplicate: holder !== undefined };
        if (holder === undefined) claimedBy.set(best, f);
      }
    } else {
      drafts[f] = draft("unknown", -1, null, [...tiedName, "weak-signal"]);
    }
  });

  const controls = files.map((file, f): DetectedControl => {
    const d = drafts[f] as Draft;
    const best = brightestOf[f];
    return {
      fileId: file.id,
      role: d.role,
      channel: d.channel >= 0 ? keys[d.channel] : null,
      matchedBy: d.matchedBy,
      duplicate: d.duplicate,
      particle: namedParticle(file),
      brightest: best >= 0 && fold(f, best) > ELEVATED_FOLD ? { channel: keys[best], fold: fold(f, best) } : null,
      fold: d.channel >= 0 ? fold(f, d.channel) : null,
      independentChannels: d.independentChannels,
      notes: d.notes,
    };
  });
  return {
    channels,
    controls,
    channelsWithoutControl: keys.filter((_, j) => !claimedBy.has(j)),
  };
}
