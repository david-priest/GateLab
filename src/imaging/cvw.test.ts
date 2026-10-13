import { describe, expect, it } from "vitest";
import {
  CVW_HEADER_BYTES,
  CVW_INDEX_ENTRY_BYTES,
  cvwBlockRange,
  hasImageFlags,
  openCvw,
  parseCvwHeader,
  parseCvwIndex,
  parseCvwMetadata,
} from "./cvw";
import { buildSyntheticCvw, gaussianBlob } from "./cvwFixture";
import { memoryFile } from "../testDirectory";
import { readRange } from "./readRange";

const threeEvents = () => buildSyntheticCvw([
  { samples: 1024, carriers: [{ slot: 4, row: 50, amplitude: gaussianBlob(50, 512, 4, 120)(50) }] },
  { noWaveform: true },
  { samples: 1536, eventId: 7777 },
], { recordingId: "00000000-0000-4000-8000-00000000abcd", recordingName: "tube B" });

describe("cvw header", () => {
  it("reads the event count and the three offsets", () => {
    const file = threeEvents();
    const header = parseCvwHeader(file.buffer.slice(0, CVW_HEADER_BYTES), file.byteLength);
    expect(header.version).toBe(2);
    expect(header.eventCount).toBe(3);
    expect(header.dataOffset).toBe(256);
    expect(header.indexOffset).toBe(256 + (1024 * 16 + 4096) + (1536 * 16 + 4096));
    expect(header.metadataOffset).toBe(header.indexOffset + 3 * CVW_INDEX_ENTRY_BYTES);
  });

  it("refuses a file without the magic, an unknown version, and a truncated file", () => {
    const foreign = buildSyntheticCvw([{ samples: 256 }], { magic: "NOTCHORW" });
    expect(() => parseCvwHeader(foreign.buffer.slice(0, CVW_HEADER_BYTES))).toThrow(/CHORWAVE/);
    const newer = buildSyntheticCvw([{ samples: 256 }], { version: 3 });
    expect(() => parseCvwHeader(newer.buffer.slice(0, CVW_HEADER_BYTES))).toThrow(/version 3/);
    const file = threeEvents();
    expect(() => parseCvwHeader(file.buffer.slice(0, CVW_HEADER_BYTES), 1000)).toThrow(/truncated/);
    expect(() => parseCvwHeader(new ArrayBuffer(64))).toThrow(/shorter than its header/);
  });
});

describe("cvw index and metadata", () => {
  it("lists every event's block, with size 0 for an event that was not imaged", () => {
    const file = threeEvents();
    const header = parseCvwHeader(file.buffer.slice(0, CVW_HEADER_BYTES));
    const index = parseCvwIndex(file.buffer.slice(header.indexOffset, header.metadataOffset), 3);
    expect(Array.from(index.sizes)).toEqual([1024 * 16 + 4096, 0, 1536 * 16 + 4096]);
    expect(index.offsets[0]).toBe(256);
    expect(index.offsets[2]).toBe(256 + 1024 * 16 + 4096);
    expect(Array.from(index.eventIds)).toEqual([1000, 1001, 7777]);
    expect(Array.from(hasImageFlags(index))).toEqual([1, 0, 1]);
  });

  it("parses the channel names, the laser and the phasors from the tail", () => {
    const file = threeEvents();
    const header = parseCvwHeader(file.buffer.slice(0, CVW_HEADER_BYTES));
    const metadata = parseCvwMetadata(file.buffer.slice(header.metadataOffset));
    expect(metadata.recordingId).toBe("00000000-0000-4000-8000-00000000abcd");
    expect(metadata.recordingName).toBe("tube B");
    expect(metadata.channelNames.get(2)).toBe("LightLoss (Imaging)");
    expect(metadata.channelNames.get(7)).toBe("Imaging_C");
    expect(metadata.lasers[0].frameIndexes).toEqual([4, 5, 6, 7, 2, 3]);
    expect(metadata.lasers[0].lightlossIndex).toBe(2);
    expect(metadata.lasers[0].pixelAspectRatio).toBe(0.3);
    expect(metadata.lasers[0].refPhasors).toHaveLength(258);
    expect(metadata.lasers[0].intrinsicPhasors.get(5)).toHaveLength(208);
  });

  it("refuses metadata that is not JSON or names no channels", () => {
    expect(() => parseCvwMetadata("\r\n{not json")).toThrow(/not valid JSON/);
    expect(() => parseCvwMetadata('{"version":"2.1.0","lasers":[]}')).toThrow(/names no image channels/);
    expect(() => parseCvwMetadata('{"namesForImageChannels":{"2":"LightLoss"},"lasers":[]}')).toThrow(/no imaging laser/);
  });
});

describe("openCvw", () => {
  it("reads only the header, index and tail, and gives each event's block range", async () => {
    const bytes = threeEvents();
    const opened = await openCvw({ kind: "file", file: memoryFile("tube B.cvw", bytes) });
    expect(opened.header.eventCount).toBe(3);
    expect(cvwBlockRange(opened, 0)).toEqual({ offset: 256, length: 1024 * 16 + 4096 });
    expect(cvwBlockRange(opened, 1)).toBeNull();
    expect(cvwBlockRange(opened, 2)).toEqual({ offset: 256 + 1024 * 16 + 4096, length: 1536 * 16 + 4096 });
    expect(cvwBlockRange(opened, 3)).toBeNull();
    const block = await readRange(opened.source, 256, 1024 * 16 + 4096);
    expect(block.byteLength).toBe(1024 * 16 + 4096);
  });

  it("refuses a range beyond the end of the file as a truncation", async () => {
    const bytes = threeEvents();
    const source = { kind: "file" as const, file: memoryFile("tube B.cvw", bytes) };
    await expect(readRange(source, bytes.byteLength - 10, 20)).rejects.toThrow(/truncated/);
  });
});
