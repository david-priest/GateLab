// The format as a real FACSDiscover S8 export has it. Runs only where a tube is available:
// GATELAB_S8_CVW names its waveform file, with the FCS of the same name beside it. Nothing in
// this file names an experiment; the tube is whatever the environment points at.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFcs } from "../engine/fcs";
import { CVW_HEADER_BYTES, CVW_INDEX_ENTRY_BYTES, hasImageFlags, parseCvwHeader, parseCvwIndex, parseCvwMetadata } from "./cvw";
import { CVW_PAGE_BYTES, IMAGE_ROWS, decodeEvent, parseBlockTrailer } from "./cvwDecode";

const CVW_PATH = process.env.GATELAB_S8_CVW ?? "";
const FCS_PATH = CVW_PATH.replace(/\.cvw$/i, ".fcs");
const available = CVW_PATH !== "" && existsSync(CVW_PATH) && existsSync(FCS_PATH);

function readAt(path: string, offset: number, length: number): ArrayBuffer {
  const fd = openSync(path, "r");
  try {
    const buffer = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const n = readSync(fd, buffer, done, length - done, offset + done);
      if (n <= 0) break;
      done += n;
    }
    if (done !== length) throw new Error(`short read at ${offset}`);
    return buffer.buffer;
  } finally {
    closeSync(fd);
  }
}

describe.runIf(available)("a real S8 waveform file", () => {
  const size = available ? statSync(CVW_PATH).size : 0;
  const header = available ? parseCvwHeader(readAt(CVW_PATH, 0, CVW_HEADER_BYTES), size) : null!;
  const index = available
    ? parseCvwIndex(readAt(CVW_PATH, header.indexOffset, header.eventCount * CVW_INDEX_ENTRY_BYTES), header.eventCount)
    : null!;
  const metadata = available ? parseCvwMetadata(readAt(CVW_PATH, header.metadataOffset, size - header.metadataOffset)) : null!;

  it("lays its blocks out contiguously in whole pages, each with its trailer", () => {
    expect(header.dataOffset).toBe(256);
    let at = header.dataOffset;
    let misplaced = 0;
    for (let i = 0; i < header.eventCount; i++) {
      if (index.offsets[i] !== at || index.sizes[i] % CVW_PAGE_BYTES !== 0) misplaced++;
      at += index.sizes[i];
    }
    expect(misplaced).toBe(0);
    expect(at).toBe(header.indexOffset);
    // Every block's trailer agrees with the index; a spread of them is read here, since every
    // block of a real file costs more time than a test should.
    const probe = Array.from({ length: 64 }, (_, k) => Math.floor((k * (header.eventCount - 1)) / 63));
    for (const i of probe) {
      if (index.sizes[i] === 0) continue;
      const trailer = parseBlockTrailer(readAt(CVW_PATH, index.offsets[i], index.sizes[i]));
      expect(trailer.eventId).toBe(index.eventIds[i]);
      expect(trailer.sampleCount * 16 + CVW_PAGE_BYTES).toBe(index.sizes[i]);
    }
  });

  it("names six image channels and carries the phasors the demodulation needs", () => {
    expect([...metadata.channelNames.keys()].sort()).toEqual([2, 3, 4, 5, 6, 7]);
    expect(metadata.lasers[0].refPhasors).toHaveLength(258);
    for (const slot of [2, 3, 4, 5, 6, 7]) expect(metadata.lasers[0].intrinsicPhasors.get(slot)).toHaveLength(2 * IMAGE_ROWS);
    expect(metadata.lasers[0].pixelAspectRatio).toBeGreaterThan(0);
  });

  it("marks the same events as imaged as the FCS's WaveformPresent column", () => {
    const fcs = parseFcs(readFileSync(FCS_PATH).buffer as ArrayBuffer);
    expect(fcs.nEvents).toBe(header.eventCount);
    const column = fcs.channels.findIndex((c) => c.name === "WaveformPresent");
    expect(column).toBeGreaterThanOrEqual(0);
    const present = fcs.columns[column];
    const flags = hasImageFlags(index);
    let differ = 0;
    for (let i = 0; i < header.eventCount; i++) if (flags[i] !== (present[i] ? 1 : 0)) differ++;
    expect(differ).toBe(0);
  });

  it("decodes a spread of events to finite planes with signal on the FSC channel", () => {
    // What the format guarantees; how the picture compares with Chorus's own is a visual
    // check. Chorus's mask and centre-of-mass features are measured in frames it does not
    // document, and neither follows a simple threshold on these planes.
    let decoded = 0;
    for (let i = 0; i < header.eventCount && decoded < 100; i += Math.max(1, Math.floor(header.eventCount / 100))) {
      if (index.sizes[i] === 0) continue;
      const image = decodeEvent(readAt(CVW_PATH, index.offsets[i], index.sizes[i]), metadata, { hop: 16 });
      expect(image.rows).toBe(IMAGE_ROWS);
      expect(image.cols).toBeGreaterThan(100);
      const fsc = image.planes[image.slots.indexOf(3)];
      let max = 0;
      let finite = true;
      for (const v of fsc) {
        if (!Number.isFinite(v)) finite = false;
        if (v > max) max = v;
      }
      expect(finite).toBe(true);
      expect(max).toBeGreaterThan(0);
      const lightLoss = image.planes[image.slots.indexOf(2)];
      let negative = 0;
      for (const v of lightLoss) if (v < 0) negative++;
      expect(negative).toBe(0);
      decoded++;
    }
    expect(decoded).toBeGreaterThan(50);
  }, 60_000);
});
