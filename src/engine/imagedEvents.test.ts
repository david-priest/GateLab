import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { imagedEventFlags } from "./imagedEvents";

const file = (withColumn: boolean): FcsFile => ({
  version: "FCS3.2", nEvents: 4, instrument: "flow", keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    ...(withColumn ? [{ index: 1, name: "WaveformPresent", marker: null, bits: 32, range: 2 }] : []),
  ],
  columns: [Float32Array.from([1, 2, 3, 4]), ...(withColumn ? [Uint32Array.from([1, 0, 1, 0])] : [])],
  spillover: null,
});

describe("imagedEventFlags", () => {
  it("reads the instrument's WaveformPresent column", () => {
    expect(Array.from(imagedEventFlags(file(true))!)).toEqual([1, 0, 1, 0]);
  });
  it("is null for a file without the column", () => {
    expect(imagedEventFlags(file(false))).toBeNull();
  });
});
