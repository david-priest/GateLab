// cellClass.ts — which imaged events are single cells, from the instrument's own image features
// and GateLab's object count. A single cell is one object whose SSC image is a typical one for
// the file: its size, eccentricity, long-axis moment, diffusivity and the agreement of its
// centres across the image channels all sit within the main mode of the one-object events. Each
// feature's mode is found robustly (median and MAD over the one-object events) and an event that
// is further than `strictness` robust standard deviations from it on any feature is single but
// irregular, with the failing features recorded. Two or more objects are "multiple objects";
// none is "no object"; an event the instrument did not image is "no image".
//
// Chorus writes one copy of each feature per image channel, named `<Feature> (<channel>)`, and
// $PnFEATURE names the feature kind; the mask channel (SSC (Imaging) unless the file says
// otherwise) is the one its own mask was computed on, so its features are used first.

import type { FcsFile } from "./fcs";

export const CELL_CLASS_LABELS = ["single", "single, irregular", "multiple objects", "no object", "no image"] as const;
export const CELL_CLASS = { single: 0, irregular: 1, multiple: 2, noObject: 3, noImage: 4 } as const;
export type CellClass = (typeof CELL_CLASS)[keyof typeof CELL_CLASS];

/** Why a one-object event is irregular, as bits. */
export const CELL_REASON = { small: 1, large: 2, eccentric: 4, elongated: 8, centresDisagree: 16, diffuse: 32 } as const;
export const CELL_REASON_LABELS: Readonly<Record<number, string>> = {
  1: "smaller than usual",
  2: "larger than usual",
  4: "eccentric",
  8: "elongated",
  16: "centres disagree between channels",
  32: "diffuse",
};

/** A feature column the rule reads, with the robust mode found for it. */
export interface CellClassFeature {
  readonly key: "size" | "eccentricity" | "longAxis" | "deltaCoM" | "diffusivity";
  readonly channel: string;
  readonly median: number;
  /** 1.4826 × MAD, the robust standard deviation; 0 when the feature could not be used. */
  readonly scale: number;
}

export interface CellClasses {
  readonly classes: Uint8Array;
  readonly reasons: Uint8Array;
  /** Events in each class, indexed like CELL_CLASS_LABELS. */
  readonly counts: readonly number[];
  readonly features: readonly CellClassFeature[];
  readonly strictness: number;
}

export interface CellClassOptions {
  /** Robust standard deviations from the mode a one-object event may sit at and still be single; 3 by default. */
  readonly strictness?: number;
  /** The image channel the rule reads features for; SSC (Imaging) by default. */
  readonly maskChannel?: string;
}

const KIND_OF_FEATURE: Readonly<Record<string, CellClassFeature["key"]>> = {
  masksize: "size",
  eccentricity: "eccentricity",
  radialmomentlongestaxis: "longAxis",
  "delta com": "deltaCoM",
  diffusivity: "diffusivity",
};
const NAME_OF_FEATURE: readonly [RegExp, CellClassFeature["key"]][] = [
  [/^Size \(/i, "size"],
  [/^Eccentricity \(/i, "eccentricity"],
  [/^Long Axis Moment \(/i, "longAxis"],
  [/^Delta CoM \(/i, "deltaCoM"],
  [/^Diffusivity \(/i, "diffusivity"],
];

const featureKeyOf = (name: string, feature?: string): CellClassFeature["key"] | null => {
  const kind = (feature ?? "").trim().toLowerCase();
  if (kind && KIND_OF_FEATURE[kind]) return KIND_OF_FEATURE[kind];
  for (const [re, key] of NAME_OF_FEATURE) if (re.test(name)) return key;
  return null;
};

/** The feature columns the rule reads: the mask channel's copy of each, every Delta CoM pair that involves it. */
export function cellClassColumns(fcs: FcsFile, maskChannel = "SSC (Imaging)"): { key: CellClassFeature["key"]; channel: string; index: number }[] {
  const mask = maskChannel.toLowerCase();
  const found: { key: CellClassFeature["key"]; channel: string; index: number; onMask: boolean }[] = [];
  fcs.channels.forEach((channel, index) => {
    const key = featureKeyOf(channel.name, channel.feature);
    if (!key) return;
    const inner = /\((.*)\)\s*$/.exec(channel.name)?.[1] ?? "";
    const onMask = inner.toLowerCase().includes(mask);
    found.push({ key, channel: channel.name, index, onMask });
  });
  const out: { key: CellClassFeature["key"]; channel: string; index: number }[] = [];
  for (const key of ["size", "eccentricity", "longAxis", "diffusivity"] as const) {
    const pick = found.find((f) => f.key === key && f.onMask) ?? found.find((f) => f.key === key);
    if (pick) out.push({ key, channel: pick.channel, index: pick.index });
  }
  const pairs = found.filter((f) => f.key === "deltaCoM" && f.onMask);
  for (const pair of pairs.length ? pairs : found.filter((f) => f.key === "deltaCoM")) out.push({ key: "deltaCoM", channel: pair.channel, index: pair.index });
  return out;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Classify every event. `objectCount` is the worker's count per event (255 where unknown); when
 * null, every imaged event is taken as one object and only the feature rules apply. `imaged`
 * marks the events the instrument imaged; when null, every event with a known count is imaged.
 */
export function classifyCells(
  fcs: FcsFile,
  objectCount: Uint8Array | null,
  imaged: Uint8Array | null,
  options: CellClassOptions = {},
): CellClasses {
  const n = fcs.nEvents;
  const strictness = options.strictness ?? 3;
  const classes = new Uint8Array(n).fill(CELL_CLASS.noImage);
  const reasons = new Uint8Array(n);
  const hasImage = (e: number): boolean => (imaged ? imaged[e] === 1 : objectCount ? objectCount[e] !== 255 : true);
  const candidates: number[] = [];
  for (let e = 0; e < n; e++) {
    if (!hasImage(e)) continue;
    const count = objectCount ? objectCount[e] : 1;
    if (count === 255) continue;
    if (count === 0) classes[e] = CELL_CLASS.noObject;
    else if (count >= 2) classes[e] = CELL_CLASS.multiple;
    else { classes[e] = CELL_CLASS.single; candidates.push(e); }
  }

  const features: CellClassFeature[] = [];
  const columns = cellClassColumns(fcs, options.maskChannel);
  for (const column of columns) {
    const source = fcs.columns[column.index];
    if (!source) continue;
    const log = column.key === "size" || column.key === "longAxis";
    const value = (e: number): number => {
      const v = source[e];
      return log ? (v > 0 ? Math.log10(v) : NaN) : v;
    };
    const sample = candidates.map(value).filter((v) => Number.isFinite(v));
    const median = medianOf(sample);
    const mad = medianOf(sample.map((v) => Math.abs(v - median)));
    const scale = Number.isFinite(mad) ? 1.4826 * mad : 0;
    features.push({ key: column.key, channel: column.channel, median, scale });
    if (!(scale > 0)) continue;
    for (const e of candidates) {
      const z = (value(e) - median) / scale;
      if (!Number.isFinite(z)) continue;
      switch (column.key) {
        case "size":
          if (z < -strictness) reasons[e] |= CELL_REASON.small;
          else if (z > strictness) reasons[e] |= CELL_REASON.large;
          break;
        case "eccentricity":
          if (z > strictness) reasons[e] |= CELL_REASON.eccentric;
          break;
        case "longAxis":
          if (z > strictness) reasons[e] |= CELL_REASON.elongated;
          break;
        case "deltaCoM":
          if (z > strictness) reasons[e] |= CELL_REASON.centresDisagree;
          break;
        case "diffusivity":
          if (z > strictness) reasons[e] |= CELL_REASON.diffuse;
          break;
      }
    }
  }
  for (const e of candidates) if (reasons[e]) classes[e] = CELL_CLASS.irregular;

  const counts = new Array<number>(CELL_CLASS_LABELS.length).fill(0);
  for (let e = 0; e < n; e++) counts[classes[e]]++;
  return { classes, reasons, counts, features, strictness };
}

/** The reasons an event is irregular, as labels. */
export function cellReasonLabels(reasons: number): string[] {
  const out: string[] = [];
  for (const bit of [1, 2, 4, 8, 16, 32]) if (reasons & bit) out.push(CELL_REASON_LABELS[bit]);
  return out;
}
