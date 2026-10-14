// derivedChannels.ts — per-event columns GateLab computed rather than read from the file (the
// objects counted in each cell image, the single-cell class, the mask area), carried as channels
// like any other so they can be plotted, gated, counted and exported, and saved in the workspace
// by value, so reopening needs no recount. Small integer columns, so a record is a few kilobytes.

import type { NumericColumn } from "./fcs";

export type DerivedDtype = "u8" | "u16" | "u32" | "f32";

/** What a derived channel is made of. `name` is the channel's name and key; it must not be a name the file has. */
export interface DerivedChannelSpec {
  readonly name: string;
  /** The $PnFEATURE-like tag that says what was measured ("ObjectCount", "CellClass", "ObjectArea"). */
  readonly feature: string;
  /** The axis range, as $PnR: one past the largest value. */
  readonly range: number;
  readonly values: NumericColumn;
}

/** A derived channel as a workspace records it. */
export interface DerivedChannelRecord {
  readonly name: string;
  readonly feature: string;
  readonly range: number;
  readonly dtype: DerivedDtype;
  /** The column's bytes, little-endian, base64. */
  readonly values: string;
}

const DTYPES: ReadonlySet<string> = new Set(["u8", "u16", "u32", "f32"]);

export function isDerivedChannelRecord(value: unknown): value is DerivedChannelRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return typeof r.name === "string" && r.name.trim().length > 0 &&
    typeof r.feature === "string" &&
    typeof r.range === "number" && Number.isFinite(r.range) && r.range > 0 &&
    typeof r.dtype === "string" && DTYPES.has(r.dtype) &&
    typeof r.values === "string";
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function base64ToBytes(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function dtypeOf(values: NumericColumn): DerivedDtype {
  if (values instanceof Uint8Array) return "u8";
  if (values instanceof Uint16Array) return "u16";
  if (values instanceof Uint32Array) return "u32";
  return "f32";
}

/** The record for a channel; a Float64 column is written as float32. */
export function encodeDerivedChannel(spec: DerivedChannelSpec): DerivedChannelRecord {
  const dtype = dtypeOf(spec.values);
  const typed = dtype === "f32" && !(spec.values instanceof Float32Array) ? Float32Array.from(spec.values) : spec.values;
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  return { name: spec.name, feature: spec.feature, range: spec.range, dtype, values: bytesToBase64(bytes) };
}

/** The channels GateLab derives from a file's cell images once its objects are counted (App adds them). */
export const DERIVED_OBJECT_COUNT = "Objects in image";
export const DERIVED_OBJECT_AREA = "Object area (GateLab mask)";
export const DERIVED_CELL_CLASS = "Single cell class";
/** What the counted objects' mask measures (imaging/objectCount.ts maskFeatures), as channels: key, name, $PnFEATURE tag. */
export const DERIVED_MASK_FEATURES: readonly [key: string, name: string, feature: string][] = [
  ["perimeter", "Perimeter (GateLab mask)", "MaskPerimeter"],
  ["circularity", "Circularity (GateLab mask)", "MaskCircularity"],
  ["majorAxis", "Major axis (GateLab mask)", "MaskMajorAxis"],
  ["minorAxis", "Minor axis (GateLab mask)", "MaskMinorAxis"],
  ["axisRatio", "Axis ratio (GateLab mask)", "MaskAxisRatio"],
  ["diameter", "Diameter (GateLab mask)", "MaskDiameter"],
  ["meanIntensity", "Mean intensity (GateLab mask)", "MaskMeanIntensity"],
  ["sdIntensity", "SD intensity (GateLab mask)", "MaskSdIntensity"],
];

/** The worker's count as App holds it (imaging/imageService.ts Classification), rebuilt from the channels. */
export interface CountFromChannels {
  readonly objectCount: Uint8Array;
  readonly objectArea: Uint32Array;
  readonly features?: Readonly<Record<string, Float32Array>>;
}

/** A sample's channels, as the reconstruction needs them. */
export interface DerivedChannelReader {
  index(key: string): number | undefined;
  isDerivedChannel(idx: number): boolean;
  rawColumnData(idx: number): ArrayLike<number>;
  readonly fcs: { readonly nEvents: number };
}

/**
 * The count a reopened workspace saved as channels, so the colourings, the class and the wall's
 * borders need no second count: the objects per event (255 for an event without an image, which
 * the channel holds as 0), the mask area, and whichever mask features the file carries. Null when
 * the file was saved before it was counted.
 */
export function countFromDerivedChannels(sample: DerivedChannelReader, imaged: ArrayLike<number> | null): CountFromChannels | null {
  const countIdx = sample.index(DERIVED_OBJECT_COUNT);
  const areaIdx = sample.index(DERIVED_OBJECT_AREA);
  if (countIdx === undefined || areaIdx === undefined || !sample.isDerivedChannel(countIdx) || !sample.isDerivedChannel(areaIdx)) return null;
  const n = sample.fcs.nEvents;
  const countColumn = sample.rawColumnData(countIdx);
  const areaColumn = sample.rawColumnData(areaIdx);
  if (countColumn.length !== n || areaColumn.length !== n) return null;
  const objectCount = new Uint8Array(n);
  const objectArea = new Uint32Array(n);
  for (let e = 0; e < n; e++) {
    objectCount[e] = imaged && !imaged[e] ? 255 : Math.max(0, Math.min(254, Math.round(countColumn[e])));
    objectArea[e] = Math.max(0, Math.round(areaColumn[e]));
  }
  const features: Record<string, Float32Array> = {};
  for (const [key, name] of DERIVED_MASK_FEATURES) {
    const idx = sample.index(name);
    if (idx === undefined || !sample.isDerivedChannel(idx)) continue;
    const column = sample.rawColumnData(idx);
    if (column.length !== n) continue;
    features[key] = column instanceof Float32Array ? column : Float32Array.from(column);
  }
  return { objectCount, objectArea, ...(Object.keys(features).length ? { features } : {}) };
}

/** The channel a record describes, for a file of `nEvents` events; throws when the bytes do not fit. */
export function decodeDerivedChannel(record: DerivedChannelRecord, nEvents: number): DerivedChannelSpec {
  const bytes = base64ToBytes(record.values);
  const width = record.dtype === "u8" ? 1 : record.dtype === "u16" ? 2 : 4;
  if (bytes.length !== nEvents * width) {
    throw new Error(`derived channel "${record.name}" holds ${bytes.length / width} values for a file of ${nEvents} events.`);
  }
  // A fresh, aligned buffer: the base64 bytes may start at any offset.
  const copy = bytes.slice().buffer;
  const values: NumericColumn =
    record.dtype === "u8" ? new Uint8Array(copy) :
    record.dtype === "u16" ? new Uint16Array(copy) :
    record.dtype === "u32" ? new Uint32Array(copy) : new Float32Array(copy);
  return { name: record.name, feature: record.feature, range: record.range, values };
}
