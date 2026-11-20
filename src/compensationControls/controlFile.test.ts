import { describe, expect, it } from "vitest";
import type { FcsFile } from "../engine/fcs";
import { Sample } from "../engine/sample";
import {
  controlFileFromSample,
  eventIndices,
  robustCentre,
  sharedChannels,
  sortedValues,
  strideEvents,
  type ControlFile,
} from "./controlFile";

function fcs(names: Array<[string, string | null]>, keywords: Record<string, string> = {}): FcsFile {
  return {
    version: "FCS3.1", nEvents: 4, instrument: "flow", keywords,
    channels: names.map(([name, marker], index) => ({ index, name, marker, bits: 32, range: 262144 })),
    columns: names.map((_, j) => new Float32Array([j, j + 10, j + 20, j + 30])),
    spillover: null,
  } as unknown as FcsFile;
}

describe("controlFileFromSample", () => {
  const sample = new Sample(fcs([
    ["FSC-A", null], ["FSC-H", null], ["SSC-A", null], ["FITC-A", "CD4"], ["FITC-H", null], ["PE-A", null], ["Time", null],
  ], { "TUBE NAME": "FITC Stained Control", "$SRC": " ", "$P4V": "480", "$P6G": "1.0", "$CYT": "Analyser", "$CYTSN": "R123", "$DATE": "18-NOV-2026" }));
  const control = controlFileFromSample(sample, "f1", "Tube_001.fcs");

  it("keeps the fluorescence area parameters, under the app's channel keys", () => {
    expect(control.channels).toEqual([
      { key: "CD4", pnn: "FITC-A", marker: "CD4", range: 262144, voltage: 480, gain: null },
      { key: "PE-A", pnn: "PE-A", marker: null, range: 262144, voltage: null, gain: 1 },
    ]);
    expect(control).toMatchObject({
      id: "f1", fileName: "Tube_001.fcs", eventCount: 4, labels: ["FITC Stained Control"],
      cytometer: "Analyser R123", acquired: "18-NOV-2026",
    });
  });

  it("reads the stored values of a channel, and nothing for a channel it does not offer", () => {
    expect(Array.from(control.values("FITC-A")!)).toEqual([3, 13, 23, 33]);
    expect(control.values("CD4")).toBeNull();
    expect(Array.from(control.values("PE-A")!)).toEqual([5, 15, 25, 35]);
    expect(control.values("FITC-H")).toBeNull();
    expect(control.values("FSC-A")).toBeNull();
  });

  it("finds forward and side scatter area", () => {
    expect(Array.from(control.scatter!.forward!)).toEqual([0, 10, 20, 30]);
    expect(Array.from(control.scatter!.side!)).toEqual([2, 12, 22, 32]);
  });

  it("keeps every fluorescence channel where none has a pulse suffix", () => {
    const plain = controlFileFromSample(new Sample(fcs([["FS", null], ["SS", null], ["FL1", null], ["FL2", null]])), "f2", "x.fcs");
    expect(plain.channels.map((channel) => channel.key)).toEqual(["FL1", "FL2"]);
    expect(plain.scatter).toEqual({ forward: null, side: null });
  });
});

describe("sharedChannels", () => {
  it("keeps the channels every file has, in the first file's order", () => {
    const file = (pnns: string[], marker: string | null = null): ControlFile => ({
      id: pnns.join(), fileName: "", labels: [], eventCount: 0,
      channels: pnns.map((pnn) => ({ key: marker ? `${marker} ${pnn}` : pnn, pnn, marker, range: 0 })),
      values: () => null,
    });
    expect(sharedChannels([file(["A", "B", "C"]), file(["C", "A"]), file(["A", "C", "D"])]).map((channel) => channel.pnn))
      .toEqual(["A", "C"]);
    expect(sharedChannels([])).toEqual([]);
    // A sample names its channels for their markers; its parameters are still the controls'.
    expect(sharedChannels([file(["A", "B"]), file(["A", "B"], "CD4")]).map((channel) => channel.pnn)).toEqual(["A", "B"]);
  });
});

describe("event helpers", () => {
  it("takes the events of a mask within bounds, lower inclusive and upper exclusive", () => {
    const values = [5, 10, 15, 20, NaN, 10];
    expect(Array.from(eventIndices({ fileId: "f" }, values))).toEqual([0, 1, 2, 3, 5]);
    expect(Array.from(eventIndices({ fileId: "f", lower: 10, upper: 20 }, values))).toEqual([1, 2, 5]);
    expect(Array.from(eventIndices({ fileId: "f", lower: 10, mask: Uint8Array.from([1, 0, 1, 1, 1, 0]) }, values))).toEqual([2, 3]);
  });

  it("sorts finite values numerically, at the events given", () => {
    expect(Array.from(sortedValues([100, 9, NaN, -2, Infinity, 30]))).toEqual([-2, 9, 30, 100]);
    expect(Array.from(sortedValues([100, 9, 30, -2], [0, 3]))).toEqual([-2, 100]);
  });

  it("reads the same evenly spaced events each time", () => {
    expect(Array.from(strideEvents(10, 4))).toEqual([0, 3, 6, 9]);
    expect(Array.from(strideEvents(3, 100))).toEqual([0, 1, 2]);
    expect(strideEvents(0, 100)).toHaveLength(0);
  });

  it("gives the median and 1.4826 times the median absolute deviation", () => {
    expect(robustCentre(Float64Array.from([1, 2, 3, 4, 100]))).toEqual({ median: 3, rsd: 1.4826 });
    expect(robustCentre(new Float64Array(0)).median).toBeNaN();
  });
});
