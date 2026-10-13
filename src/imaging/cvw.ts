// cvw.ts — the BD FACSChorus "Chorwave" (.cvw) file a FACSDiscover S8 exports beside each FCS
// when images were recorded. BD documents nothing about it; this layout was read off the files
// themselves (Chorus 5.4 and 6.2 exports, 2026-10-13) and holds on every file checked:
//
//   0x00  "CHORWAVE"            magic
//   0x08  u32 version           2
//   0x3C  u32 eventCount
//   0x40  u64 indexOffset       -> eventCount × 24-byte entries (u64 eventId, u64 offset, u64 size)
//   0x48  u64 dataOffset        256; the event blocks follow, contiguous, each a multiple of 4096
//   0x50  u64 metadataOffset    -> "\r\n" + a JSON document to the end of the file
//   0x80  u32 128, "BDMOSAIC", u32 (255, 256, 16, 120, 1, …)   a descriptor the decoder does not need
//
// An index entry whose size is 0 is an event with no waveform; it is the same event the FCS
// marks with WaveformPresent = 0, and index entry i is FCS event i (same order). The JSON names
// the image channels (2 LightLoss, 3 FSC, 4 SSC, 5–7 fluorescence), gives the pixel aspect ratio
// and the demodulation phasors. What is inside a block is cvwDecode.ts's business.

import { type ByteSource, byteSourceSize, readRange } from "./readRange";

export const CVW_MAGIC = "CHORWAVE";
export const CVW_HEADER_BYTES = 128;
export const CVW_INDEX_ENTRY_BYTES = 24;
export const CVW_VERSION = 2;

export interface CvwHeader {
  readonly version: number;
  readonly eventCount: number;
  readonly dataOffset: number;
  readonly indexOffset: number;
  readonly metadataOffset: number;
}

export interface CvwIndex {
  /** The acquisition's event number for each entry; informational (the FCS carries no copy). */
  readonly eventIds: Float64Array;
  /** Byte offset of each event's block; Float64 because files pass 4 GB. */
  readonly offsets: Float64Array;
  /** Byte length of each block; 0 for an event with no waveform. */
  readonly sizes: Float64Array;
}

export interface CvwLaser {
  readonly laserName: string;
  /** Channel slots in the order Chorus lays frames out: SSC, the fluorescence channels, LightLoss, FSC. */
  readonly frameIndexes: readonly number[];
  readonly lightlossIndex: number;
  /** Column pitch over row pitch at the decoder's native hop; 0.3 on every file seen. */
  readonly pixelAspectRatio: number;
  /** The reference beam's spectrum, 129 complex values (re, im) for the 129 bins of a 256-point frame. */
  readonly refPhasors: Float64Array;
  /** Per channel slot, 104 unit complex values (re, im): one phase per carrier. */
  readonly intrinsicPhasors: ReadonlyMap<number, Float64Array>;
}

export interface CvwMetadata {
  readonly version: string;
  readonly recordingId: string;
  readonly recordingName: string;
  /** Channel slot (2–7) → the name Chorus gives it. */
  readonly channelNames: ReadonlyMap<number, string>;
  readonly lasers: readonly CvwLaser[];
}

export interface CvwFile {
  readonly header: CvwHeader;
  readonly index: CvwIndex;
  readonly metadata: CvwMetadata;
  readonly source: ByteSource;
}

const u64 = (view: DataView, offset: number): number => {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`cvw: offset at 0x${offset.toString(16)} is not representable`);
  return Number(value);
};

/** Read the 128-byte header. `fileSize`, when given, checks the offsets fit the file. */
export function parseCvwHeader(bytes: ArrayBufferLike, fileSize?: number): CvwHeader {
  if (bytes.byteLength < CVW_HEADER_BYTES) throw new Error("cvw: the file is shorter than its header");
  const view = new DataView(bytes);
  const magic = String.fromCharCode(...new Uint8Array(bytes, 0, 8));
  if (magic !== CVW_MAGIC) throw new Error("cvw: not a FACSChorus waveform file (no CHORWAVE magic)");
  const version = view.getUint32(0x08, true);
  if (version !== CVW_VERSION) throw new Error(`cvw: unsupported version ${version}; GateLab reads version ${CVW_VERSION}`);
  const header: CvwHeader = {
    version,
    eventCount: view.getUint32(0x3c, true),
    indexOffset: u64(view, 0x40),
    dataOffset: u64(view, 0x48),
    metadataOffset: u64(view, 0x50),
  };
  const indexEnd = header.indexOffset + header.eventCount * CVW_INDEX_ENTRY_BYTES;
  if (header.dataOffset < CVW_HEADER_BYTES || header.indexOffset < header.dataOffset || header.metadataOffset < indexEnd) {
    throw new Error("cvw: the header's offsets are out of order");
  }
  if (fileSize !== undefined && header.metadataOffset >= fileSize) {
    throw new Error(`cvw: the file is truncated (metadata at ${header.metadataOffset}, file is ${fileSize} bytes)`);
  }
  return header;
}

/** Read the index: `eventCount` entries of (eventId, offset, size). */
export function parseCvwIndex(bytes: ArrayBufferLike, eventCount: number): CvwIndex {
  if (bytes.byteLength < eventCount * CVW_INDEX_ENTRY_BYTES) throw new Error("cvw: the index is shorter than the event count");
  const view = new DataView(bytes);
  const eventIds = new Float64Array(eventCount);
  const offsets = new Float64Array(eventCount);
  const sizes = new Float64Array(eventCount);
  for (let i = 0; i < eventCount; i++) {
    const at = i * CVW_INDEX_ENTRY_BYTES;
    eventIds[i] = u64(view, at);
    offsets[i] = u64(view, at + 8);
    sizes[i] = u64(view, at + 16);
  }
  return { eventIds, offsets, sizes };
}

/** One byte per event: 1 when the event has a waveform (an index entry with a non-zero size). */
export function hasImageFlags(index: CvwIndex): Uint8Array {
  const flags = new Uint8Array(index.sizes.length);
  for (let i = 0; i < flags.length; i++) flags[i] = index.sizes[i] > 0 ? 1 : 0;
  return flags;
}

const numberArray = (value: unknown, what: string): Float64Array => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "number")) throw new Error(`cvw: ${what} is not a list of numbers`);
  return Float64Array.from(value as number[]);
};

/** Parse the JSON at the tail of the file (it starts with a CRLF before the opening brace). */
export function parseCvwMetadata(bytes: ArrayBufferLike | string): CvwMetadata {
  const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8").decode(bytes);
  const start = text.indexOf("{");
  if (start < 0) throw new Error("cvw: no metadata document at the end of the file");
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start));
  } catch (cause) {
    throw new Error(`cvw: the metadata is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error("cvw: the metadata is not an object");
  const doc = raw as Record<string, unknown>;
  const names = doc.namesForImageChannels;
  const channelNames = new Map<number, string>();
  if (typeof names === "object" && names !== null) {
    for (const [slot, name] of Object.entries(names as Record<string, unknown>)) {
      if (typeof name === "string" && /^\d+$/.test(slot)) channelNames.set(Number(slot), name);
    }
  }
  if (channelNames.size === 0) throw new Error("cvw: the metadata names no image channels");
  const lasersRaw = Array.isArray(doc.lasers) ? (doc.lasers as unknown[]) : [];
  const lasers: CvwLaser[] = lasersRaw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`cvw: laser ${i} is not an object`);
    const laser = entry as Record<string, unknown>;
    const frames = Array.isArray(laser.frameIndexes) ? (laser.frameIndexes as unknown[]) : [];
    if (frames.some((f) => typeof f !== "number")) throw new Error(`cvw: laser ${i} frameIndexes are not numbers`);
    const intrinsic = new Map<number, Float64Array>();
    if (typeof laser.intrinsicPhasors === "object" && laser.intrinsicPhasors !== null) {
      for (const [slot, values] of Object.entries(laser.intrinsicPhasors as Record<string, unknown>)) {
        if (/^\d+$/.test(slot)) intrinsic.set(Number(slot), numberArray(values, `intrinsicPhasors[${slot}]`));
      }
    }
    const aspect = typeof laser.pixelAspectRatio === "number" && laser.pixelAspectRatio > 0 ? laser.pixelAspectRatio : 1;
    return {
      laserName: typeof laser.laserName === "string" ? laser.laserName : `laser ${i}`,
      frameIndexes: frames as number[],
      lightlossIndex: typeof laser.lightlossIndex === "number" ? laser.lightlossIndex : -1,
      pixelAspectRatio: aspect,
      refPhasors: laser.refPhasors === undefined ? new Float64Array(0) : numberArray(laser.refPhasors, "refPhasors"),
      intrinsicPhasors: intrinsic,
    };
  });
  if (lasers.length === 0) throw new Error("cvw: the metadata describes no imaging laser");
  return {
    version: typeof doc.version === "string" ? doc.version : "",
    recordingId: typeof doc.recordingId === "string" ? doc.recordingId : "",
    recordingName: typeof doc.recordingName === "string" ? doc.recordingName : "",
    channelNames,
    lasers,
  };
}

/**
 * Open a `.cvw`: the header, the index and the metadata, which together cost 24 bytes per event
 * plus a few kilobytes. No event block is read here.
 */
export async function openCvw(source: ByteSource): Promise<CvwFile> {
  const size = byteSourceSize(source);
  const header = parseCvwHeader(await readRange(source, 0, Math.min(CVW_HEADER_BYTES, size)), size);
  const index = parseCvwIndex(
    await readRange(source, header.indexOffset, header.eventCount * CVW_INDEX_ENTRY_BYTES),
    header.eventCount,
  );
  const metadata = parseCvwMetadata(await readRange(source, header.metadataOffset, size - header.metadataOffset));
  for (let i = 0; i < header.eventCount; i++) {
    if (index.sizes[i] > 0 && index.offsets[i] + index.sizes[i] > header.indexOffset) {
      throw new Error(`cvw: event ${i}'s block runs past the data region`);
    }
  }
  return { header, index, metadata, source };
}

/** The header and metadata only (a few kilobytes), for checking a file before the worker opens it. */
export async function openCvwSummary(source: ByteSource): Promise<{ header: CvwHeader; metadata: CvwMetadata }> {
  const size = byteSourceSize(source);
  const header = parseCvwHeader(await readRange(source, 0, Math.min(CVW_HEADER_BYTES, size)), size);
  const metadata = parseCvwMetadata(await readRange(source, header.metadataOffset, size - header.metadataOffset));
  return { header, metadata };
}

/** The byte range of event `i`'s block, or null when it has no waveform. */
export function cvwBlockRange(file: CvwFile, eventIndex: number): { offset: number; length: number } | null {
  if (eventIndex < 0 || eventIndex >= file.header.eventCount) return null;
  const length = file.index.sizes[eventIndex];
  if (length === 0) return null;
  return { offset: file.index.offsets[eventIndex], length };
}
