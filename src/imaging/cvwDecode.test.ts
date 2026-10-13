import { describe, expect, it } from "vitest";
import { parseCvwHeader, parseCvwMetadata, parseCvwIndex } from "./cvw";
import {
  CARRIER_FIRST_BIN,
  IMAGE_ROWS,
  decodeEvent,
  fft256,
  parseBlockTrailer,
  stftColumns,
} from "./cvwDecode";
import { buildSyntheticBlock, buildSyntheticCvw, gaussianBlob } from "./cvwFixture";

const correlation = (a: Float32Array | number[], b: Float32Array | number[]): number => {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  return sab / Math.sqrt(saa * sbb);
};

describe("fft256", () => {
  it("puts a cosine at bin k into bin k alone", () => {
    for (const k of [1, 15, 64, 118, 127]) {
      const re = new Float32Array(256);
      const im = new Float32Array(256);
      for (let t = 0; t < 256; t++) re[t] = Math.cos((2 * Math.PI * k * t) / 256);
      fft256(re, im);
      const mags = Array.from({ length: 129 }, (_, b) => Math.hypot(re[b], im[b]));
      expect(mags[k]).toBeCloseTo(128, 2);
      mags.forEach((m, b) => { if (b !== k) expect(m).toBeLessThan(1e-3); });
    }
  });
});

describe("block trailer", () => {
  it("reads the channel count, frame, data pages and event id", () => {
    const block = buildSyntheticBlock({ samples: 1024 }, 4242);
    const trailer = parseBlockTrailer(block.buffer);
    expect(trailer).toEqual({ channels: 8, frame: 256, dataPages: 4, eventId: 4242, sampleCount: 1024 });
  });

  it("refuses a block without a trailer or with the wrong page count", () => {
    const block = buildSyntheticBlock({ samples: 1024 }, 1);
    const bad = block.slice();
    bad[bad.byteLength - 4096] = 0;
    expect(() => parseBlockTrailer(bad.buffer)).toThrow(/no trailer/);
    expect(() => parseBlockTrailer(block.buffer.slice(4096))).toThrow(/data pages/);
    expect(() => parseBlockTrailer(new ArrayBuffer(100))).toThrow(/whole number of pages/);
  });
});

describe("decodeEvent", () => {
  const metadataOf = (file: Uint8Array) => {
    const header = parseCvwHeader(file.buffer.slice(0, 128));
    return { header, metadata: parseCvwMetadata(file.buffer.slice(header.metadataOffset)), index: parseCvwIndex(file.buffer.slice(header.indexOffset, header.metadataOffset), header.eventCount) };
  };
  const blockOf = (file: Uint8Array, i: number) => {
    const { index } = metadataOf(file);
    return file.buffer.slice(index.offsets[i], index.offsets[i] + index.sizes[i]);
  };

  it("lands a carrier at bin b on row b − 15 of its channel, and nowhere else", () => {
    const file = buildSyntheticCvw([{
      samples: 1024,
      carriers: [{ slot: 5, row: 40, amplitude: () => 500 }],
    }]);
    const { metadata } = metadataOf(file);
    const image = decodeEvent(blockOf(file, 0), metadata, { hop: 16 });
    expect(image.rows).toBe(IMAGE_ROWS);
    expect(image.cols).toBe(stftColumns(1024, 16));
    expect(image.cols).toBe(49);
    expect(image.slots).toEqual([2, 3, 4, 5, 6, 7]);
    expect(CARRIER_FIRST_BIN + 40).toBe(55);
    const plane = image.planes[image.slots.indexOf(5)];
    for (let r = 0; r < image.rows; r++) {
      for (let c = 0; c < image.cols; c++) {
        const v = plane[r * image.cols + c];
        if (r === 40) expect(v).toBeGreaterThan(500 * 128 * 0.95);
        else expect(v).toBeLessThan(500 * 128 * 0.02);
      }
    }
    // The other channels see only their flat baseline.
    const fsc = image.planes[image.slots.indexOf(3)];
    expect(Math.max(...fsc)).toBeLessThan(500 * 128 * 0.01);
  });

  it("recovers a blob drawn on the SSC channel, and a dip on LightLoss as transmitted light", () => {
    // A cell crosses the line over thousands of samples, so the amplitude barely moves within
    // one 256-sample frame; a blob that changed much faster would leak between rows.
    const samples = 4096;
    const blob = gaussianBlob(60, 2048, 6, 500, 800);
    // 104 carriers add up, so the channels sit at mid-range and the amplitudes keep the sum
    // inside 16 bits: the blob's rows total about 15 × 800 on SSC, and LightLoss carries 104 × 200.
    const carriers = [];
    for (let row = 0; row < IMAGE_ROWS; row++) {
      carriers.push({ slot: 4, row, amplitude: blob(row) });
      // LightLoss: every carrier present at 200, dipping by the blob.
      carriers.push({ slot: 2, row, amplitude: (t: number) => 200 - 0.18 * blob(row)(t), phase: row * 0.3 });
    }
    const file = buildSyntheticCvw([{ samples, carriers, baseline: { 2: 32768, 4: 32768 } }]);
    const { metadata } = metadataOf(file);
    for (const hop of [16, 32]) {
      const image = decodeEvent(blockOf(file, 0), metadata, { hop });
      expect(image.cols).toBe(stftColumns(samples, hop));
      expect(image.aspect).toBeCloseTo(0.3 * (hop / 16), 6);
      // A frame's magnitude is the amplitude averaged over the frame's 256 samples.
      const expected: number[] = [];
      for (let r = 0; r < IMAGE_ROWS; r++) {
        const profile = blob(r);
        for (let c = 0; c < image.cols; c++) {
          let sum = 0;
          for (let t = c * hop; t < c * hop + 256; t++) sum += profile(t);
          expected.push(sum / 256);
        }
      }
      const ssc = image.planes[image.slots.indexOf(4)];
      expect(correlation(ssc, expected)).toBeGreaterThan(0.95);
      // Light loss is transmitted light: 1 away from the cell and dipping where it is.
      const lightLoss = image.planes[image.slots.indexOf(2)];
      expect(correlation(lightLoss, expected)).toBeLessThan(-0.95);
      expect(Math.min(...lightLoss)).toBeGreaterThanOrEqual(0);
      expect(lightLoss[0]).toBeGreaterThan(0.95);
      expect(lightLoss[0]).toBeLessThan(1.05);
    }
  });

  it("decodes only the requested slots", () => {
    const file = buildSyntheticCvw([{ samples: 512 }]);
    const { metadata } = metadataOf(file);
    const image = decodeEvent(blockOf(file, 0), metadata, { hop: 16, slots: [3, 4] });
    expect(image.slots).toEqual([3, 4]);
    expect(image.planes).toHaveLength(2);
  });
});
