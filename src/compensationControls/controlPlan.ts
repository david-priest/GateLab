// controlPlan.ts — from the files to the events each control is calculated from.
//
// Joins the parts: the role of each file (controlDetection.ts), the split of each control on its
// own channel (controlSplit.ts) and the choice of negative events, giving the ControlSpec list
// spilloverEstimate.ts takes. Every choice made here is the starting value of something the user
// can change: the file for a channel, the two boundaries, and where the negative events come from.
//
// Negative events, when left to choose ("auto"): the control's own negative population where it
// has one, because those events are the same particles through the same tube as the positive
// ones; otherwise the unstained control. Three things are read against an unstained control of the
// same particles (its scatter matches the control's), where there is one:
//
//   - a bead control with no negative peak uses it (a "universal negative": tubes of positive
//     beads alone and one tube of unstained beads). Against an unstained tube of other particles
//     (cells) a bead control is not calculated, and the missing negative beads are reported;
//   - a control whose lower peak sits above the unstained events has no negative population: the
//     two peaks are both positive (single beads and doublets, a dim and a bright population);
//   - a control with only a few negative events of its own uses the unstained control's many.

import {
  eventIndices,
  medianSorted,
  sortedValues,
  strideEvents,
  type ControlFile,
  type EventSet,
} from "./controlFile";
import { detectControls, type ControlDetection } from "./controlDetection";
import { namedParticle } from "./controlNames";
import { positiveLowerFromNegative, splitControl, type ControlSplit } from "./controlSplit";
import { FEW_EVENTS, type ControlSpec } from "./spilloverEstimate";

export type NegativeChoice = "auto" | "internal" | "unstained";
/** What the control is made of. Compensation beads carry their own negative beads; cells may have no negative population. */
export type ControlKind = "beads" | "cells";

/**
 * A control whose positive peak is narrower than this (robust SD on the arcsinh scale), with a
 * negative peak beside it, is read as beads where neither the user nor its name says. On the lab's
 * two FACSDiva bead sets the positive peaks are 0.04 to 0.15 wide.
 */
const BEAD_PEAK_SPREAD = 0.25;

/** Median scatter of two files differing by more than this factor, either way, is taken as different particles. */
const SCATTER_FACTOR = 1.5;
const SCATTER_EVENTS = 20_000;

export interface PlannedControl {
  readonly channel: string;
  readonly fileId: string;
  /** Beads or cells, and what said so: the option given, the file's name, or the shape of its peaks. */
  readonly kind: ControlKind;
  readonly kindFrom: "chosen" | "name" | "peaks";
  /** The control's split on its own channel; null where it has too few events to split. */
  readonly split: ControlSplit | null;
  /** Where the negative events come from; null where there are none to use. */
  readonly negativeSource: "internal" | "unstained" | null;
  readonly negativeFileId: string | null;
  /**
   * Why the negative events are those: the user's choice; the control's own negative peak; the
   * unstained control because the control has no negative peak, because its lower peak is not
   * negative (it sits above the unstained events), or because its own negative events are few.
   */
  readonly negativeReason: "chosen" | "own-peak" | "no-own-peak" | "own-peak-not-negative" | "own-peak-small" | null;
  /** Null where the control cannot be calculated: `problem` says why. */
  readonly spec: ControlSpec | null;
  readonly problem: "no-negative-population" | "no-unstained-control" | null;
  /**
   * True where the negative events come from the unstained control and its scatter differs from
   * this control's (beads against cells): their background is then not this control's.
   */
  readonly scatterDiffers: boolean;
}

export interface ControlPlanOptions {
  /**
   * Beads or cells, for every control planned with these options; "auto" (the default) reads each
   * control's name and then its peaks. It decides one thing: a bead control without a negative
   * peak is a fault and is not calculated against an unstained tube, where a cell control without
   * a negative population is ordinary and is.
   */
  readonly kind?: "auto" | ControlKind;
  readonly negative?: NegativeChoice;
  /** A population per file id (one byte per event), where the user has gated one: only its events are used. */
  readonly populations?: Readonly<Record<string, Uint8Array | undefined>>;
}

function scatterMedians(file: ControlFile): [number, number] | null {
  const forward = file.scatter?.forward;
  const side = file.scatter?.side;
  if (!forward || !side) return null;
  const events = strideEvents(file.eventCount, SCATTER_EVENTS);
  return [medianSorted(sortedValues(forward, events)), medianSorted(sortedValues(side, events))];
}

/** True where both files have scatter and their medians differ by more than SCATTER_FACTOR. */
export function scatterDiffers(a: ControlFile, b: ControlFile): boolean {
  const ma = scatterMedians(a);
  const mb = scatterMedians(b);
  if (!ma || !mb) return false;
  return ma.some((value, k) => {
    const other = mb[k];
    if (!(value > 0) || !(other > 0)) return false;
    return value / other > SCATTER_FACTOR || other / value > SCATTER_FACTOR;
  });
}

/** The unstained control for a control file: one whose scatter matches it, else the one with most events. */
export function unstainedFor(control: ControlFile, unstained: readonly ControlFile[]): ControlFile | null {
  if (unstained.length === 0) return null;
  const byEvents = [...unstained].sort((a, b) => b.eventCount - a.eventCount);
  return byEvents.find((file) => !scatterDiffers(control, file)) ?? byEvents[0];
}

/** One control's events: the file `fileId` as the control for `channel`. */
export function planControl(
  files: readonly ControlFile[],
  fileId: string,
  channel: string,
  unstained: readonly ControlFile[],
  options: ControlPlanOptions = {},
): PlannedControl {
  const file = files.find((candidate) => candidate.id === fileId);
  const own = file?.values(channel);
  if (!file || !own) throw new Error(`No file "${fileId}" with channel "${channel}".`);
  const mask = options.populations?.[file.id] ?? null;
  const population: EventSet = { fileId: file.id, mask };
  const range = file.channels.find((candidate) => candidate.pnn === channel)?.range ?? 0;
  const split = splitControl(own, range, mask ? eventIndices(population, own) : null);
  const choice = options.negative ?? "auto";
  const negativeFile = unstainedFor(file, unstained);
  const named = namedParticle(file);
  const kind: ControlKind =
    options.kind === "beads" || options.kind === "cells"
      ? options.kind
      : named ?? (split?.bimodal && split.positiveSpread < BEAD_PEAK_SPREAD ? "beads" : "cells");
  const kindFrom: PlannedControl["kindFrom"] =
    options.kind === "beads" || options.kind === "cells" ? "chosen" : named ? "name" : "peaks";
  const base = { channel, fileId: file.id, kind, kindFrom, split };

  // The unstained control's events on this channel, and where positive events begin above them.
  const negativeOwn = negativeFile?.values(channel) ?? null;
  const negative: EventSet | null = negativeFile && negativeOwn
    ? { fileId: negativeFile.id, mask: options.populations?.[negativeFile.id] ?? null }
    : null;
  const aboveUnstained = negative && negativeOwn
    ? positiveLowerFromNegative(sortedValues(negativeOwn, eventIndices(negative, negativeOwn)))
    : null;
  const sameParticles = negativeFile !== null && negative !== null && !scatterDiffers(file, negativeFile);

  // Whether the control's own lower peak is its negative population.
  let ownReason: "own-peak" | "own-peak-not-negative" | "own-peak-small" | "no-own-peak" = split?.bimodal ? "own-peak" : "no-own-peak";
  if (split?.bimodal && choice === "auto" && sameParticles && aboveUnstained !== null) {
    const lower = sortedValues(own, eventIndices({ ...population, upper: split.cut }, own));
    if (medianSorted(lower) > aboveUnstained) ownReason = "own-peak-not-negative";
    else if (split.negativeCount < FEW_EVENTS) ownReason = "own-peak-small";
  }

  if (choice !== "unstained" && split?.bimodal && ownReason === "own-peak") {
    return {
      ...base,
      negativeSource: "internal",
      negativeFileId: file.id,
      negativeReason: choice === "internal" ? "chosen" : "own-peak",
      spec: {
        channel,
        positive: { ...population, lower: split.positiveLower },
        negative: { ...population, upper: split.negativeUpper },
      },
      problem: null,
      scatterDiffers: false,
    };
  }
  const none = { ...base, negativeSource: null, negativeFileId: null, negativeReason: null, spec: null, scatterDiffers: false } as const;
  // Beads with no negative beads: an unstained tube of the same beads serves; one of other particles does not.
  if (choice === "internal" || (choice === "auto" && kind === "beads" && !sameParticles)) {
    return { ...none, problem: "no-negative-population" };
  }
  if (!negativeFile || !negative || aboveUnstained === null) return { ...none, problem: "no-unstained-control" };
  // With a negative population of its own (the unstained control was asked for, or its own is
  // small) the positive events are its positive peak; otherwise every event above the unstained ones.
  const ownPositive = split?.bimodal && ownReason !== "own-peak-not-negative";
  return {
    ...base,
    negativeSource: "unstained",
    negativeFileId: negativeFile.id,
    negativeReason: choice === "unstained" ? "chosen" : ownReason === "own-peak" ? "no-own-peak" : ownReason,
    spec: { channel, positive: { ...population, lower: ownPositive ? split.positiveLower : aboveUnstained }, negative },
    problem: null,
    scatterDiffers: scatterDiffers(file, negativeFile),
  };
}

export interface ControlPlan {
  readonly detection: ControlDetection;
  /** One per channel that has a single-stained control (duplicates and mixed files left out), in matrix order. */
  readonly controls: readonly PlannedControl[];
  /** The controls that can be calculated, as estimateSpillover takes them. */
  readonly specs: readonly ControlSpec[];
}

/** Detects what each file is and plans every single-stained control found. */
export function planControls(files: readonly ControlFile[], options: ControlPlanOptions = {}): ControlPlan {
  const detection = detectControls(files);
  const unstained = files.filter((_, f) => detection.controls[f].role === "unstained");
  const controls: PlannedControl[] = [];
  for (const channel of detection.channels) {
    const found = detection.controls.find((control) =>
      control.role === "single-stain" && !control.duplicate && control.channel === channel.pnn);
    if (found) controls.push(planControl(files, found.fileId, channel.pnn, unstained, options));
  }
  return {
    detection,
    controls,
    specs: controls.flatMap((control) => (control.spec ? [control.spec] : [])),
  };
}
