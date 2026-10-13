// cvwFixture.ts — a synthetic FACSChorus waveform file for the tests, written to the layout
// cvw.ts documents: header, contiguous event blocks with their trailer page, the index and the
// metadata JSON. Test-only: nothing in the app imports this. Identifiers are made up.

import {
  CARRIER_FIRST_BIN,
  CVW_BYTES_PER_SAMPLE,
  CVW_CHANNELS,
  CVW_FRAME,
  CVW_PAGE_BYTES,
  IMAGE_ROWS,
} from "./cvwDecode";
import { CVW_HEADER_BYTES, CVW_INDEX_ENTRY_BYTES } from "./cvw";

/** A carrier on one channel: its row, and its amplitude as a function of the sample index. */
export interface SyntheticCarrier {
  readonly slot: number;
  readonly row: number;
  readonly amplitude: (t: number) => number;
  readonly phase?: number;
}

export interface SyntheticEvent {
  /** Samples per channel; a multiple of 256. */
  readonly samples?: number;
  readonly carriers?: readonly SyntheticCarrier[];
  /** Baseline per slot (slot → level), 2048 by default. */
  readonly baseline?: Readonly<Record<number, number>>;
  /** An event the instrument did not image: a zero-size index entry. */
  readonly noWaveform?: boolean;
  readonly eventId?: number;
}

export interface SyntheticCvwOptions {
  readonly channelNames?: Readonly<Record<number, string>>;
  readonly pixelAspectRatio?: number;
  readonly recordingId?: string;
  readonly recordingName?: string;
  readonly lightlossIndex?: number;
  readonly version?: number;
  readonly magic?: string;
}

export const SYNTHETIC_CHANNEL_NAMES: Readonly<Record<number, string>> = {
  2: "LightLoss (Imaging)",
  3: "FSC",
  4: "SSC (Imaging)",
  5: "Imaging_A",
  6: "Imaging_B",
  7: "Imaging_C",
};

/** A Gaussian blob centred on (row0, t0) with the given widths, for a known picture. */
export const gaussianBlob = (row0: number, t0: number, rowSigma: number, tSigma: number, peak = 1000) =>
  (row: number) => (t: number) =>
    peak * Math.exp(-((row - row0) ** 2) / (2 * rowSigma ** 2) - ((t - t0) ** 2) / (2 * tSigma ** 2));

/** Build the event's waveform block: interleaved u16 samples and the trailer page. */
export function buildSyntheticBlock(event: SyntheticEvent, eventId: number): Uint8Array {
  const samples = event.samples ?? 1024;
  if (samples % CVW_FRAME !== 0) throw new Error("synthetic block: samples must be a multiple of 256");
  const dataBytes = samples * CVW_BYTES_PER_SAMPLE;
  if (dataBytes % CVW_PAGE_BYTES !== 0) throw new Error("synthetic block: samples must fill whole pages");
  const dataPages = dataBytes / CVW_PAGE_BYTES;
  const block = new Uint8Array(dataBytes + CVW_PAGE_BYTES);
  const u16 = new Uint16Array(block.buffer, 0, samples * CVW_CHANNELS);
  const baseline = event.baseline ?? {};
  for (let slot = 0; slot < CVW_CHANNELS; slot++) {
    const level = baseline[slot] ?? 2048;
    for (let t = 0; t < samples; t++) u16[t * CVW_CHANNELS + slot] = level;
  }
  for (const carrier of event.carriers ?? []) {
    const bin = CARRIER_FIRST_BIN + carrier.row;
    if (carrier.row < 0 || carrier.row >= IMAGE_ROWS) throw new Error(`synthetic block: row ${carrier.row} is off the image`);
    const phase = carrier.phase ?? 0;
    for (let t = 0; t < samples; t++) {
      const at = t * CVW_CHANNELS + carrier.slot;
      const v = u16[at] + carrier.amplitude(t) * Math.cos((2 * Math.PI * bin * t) / CVW_FRAME + phase);
      u16[at] = Math.max(0, Math.min(65535, Math.round(v)));
    }
  }
  const trailer = new DataView(block.buffer, dataBytes, CVW_PAGE_BYTES);
  trailer.setUint32(0, 0xbdbdbdbd, true);
  trailer.setUint32(4, CVW_CHANNELS, true);
  trailer.setUint32(8, CVW_FRAME, true);
  trailer.setUint32(12, dataPages, true);
  trailer.setUint32(16, eventId, true);
  return block;
}

/** A whole `.cvw` file. */
export function buildSyntheticCvw(events: readonly SyntheticEvent[], options: SyntheticCvwOptions = {}): Uint8Array {
  const dataOffset = 256;
  const blocks: Uint8Array[] = [];
  const offsets: number[] = [];
  const sizes: number[] = [];
  const eventIds: number[] = [];
  let at = dataOffset;
  events.forEach((event, i) => {
    const eventId = event.eventId ?? 1000 + i;
    eventIds.push(eventId);
    if (event.noWaveform) {
      offsets.push(at);
      sizes.push(0);
      return;
    }
    const block = buildSyntheticBlock(event, eventId);
    blocks.push(block);
    offsets.push(at);
    sizes.push(block.byteLength);
    at += block.byteLength;
  });
  const indexOffset = at;
  const metadataOffset = indexOffset + events.length * CVW_INDEX_ENTRY_BYTES;
  const refPhasors: number[] = [];
  for (let k = 0; k < 129; k++) refPhasors.push(k >= CARRIER_FIRST_BIN && k < CARRIER_FIRST_BIN + IMAGE_ROWS ? 50000 : 10, 0);
  const intrinsic: Record<string, number[]> = {};
  for (const slot of [2, 3, 4, 5, 6, 7]) {
    const values: number[] = [];
    for (let r = 0; r < IMAGE_ROWS; r++) values.push(Math.cos(r * 0.7 + slot), Math.sin(r * 0.7 + slot));
    intrinsic[String(slot)] = values;
  }
  const metadata = {
    version: "2.1.0",
    recordingId: options.recordingId ?? "00000000-0000-4000-8000-000000000001",
    recordingName: options.recordingName ?? "tube A",
    namesForImageChannels: options.channelNames ?? SYNTHETIC_CHANNEL_NAMES,
    lasers: [{
      laserName: "Imaging",
      frameIndexes: [4, 5, 6, 7, 2, 3],
      lightlossIndex: options.lightlossIndex ?? 2,
      pixelAspectRatio: options.pixelAspectRatio ?? 0.3,
      refPhasors,
      intrinsicPhasors: intrinsic,
    }],
    wells: null,
    appendedWaveformMetadata: null,
  };
  const metadataBytes = new TextEncoder().encode("\r\n" + JSON.stringify(metadata));
  const file = new Uint8Array(metadataOffset + metadataBytes.byteLength);
  const view = new DataView(file.buffer);
  file.set(new TextEncoder().encode(options.magic ?? "CHORWAVE"), 0);
  view.setUint32(0x08, options.version ?? 2, true);
  view.setUint32(0x0c, 8, true);
  view.setUint32(0x14, 8, true);
  view.setUint32(0x18, 16, true);
  view.setUint32(0x38, 1, true);
  view.setUint32(0x3c, events.length, true);
  view.setBigUint64(0x40, BigInt(indexOffset), true);
  view.setBigUint64(0x48, BigInt(dataOffset), true);
  view.setBigUint64(0x50, BigInt(metadataOffset), true);
  view.setUint32(0x80, CVW_HEADER_BYTES, true);
  file.set(new TextEncoder().encode("BDMOSAIC"), 0x84);
  [255, 256, 16, 120, 1].forEach((v, i) => view.setUint32(0x8c + i * 4, v, true));
  let cursor = dataOffset;
  for (const block of blocks) {
    file.set(block, cursor);
    cursor += block.byteLength;
  }
  for (let i = 0; i < events.length; i++) {
    const entry = indexOffset + i * CVW_INDEX_ENTRY_BYTES;
    view.setBigUint64(entry, BigInt(eventIds[i]), true);
    view.setBigUint64(entry + 8, BigInt(offsets[i]), true);
    view.setBigUint64(entry + 16, BigInt(sizes[i]), true);
  }
  file.set(metadataBytes, metadataOffset);
  return file;
}
