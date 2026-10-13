import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";
import { buildCombinedSamplePointCloud } from "./multiSamplePlot";

function fileOf(n: number, seed = 0): FcsFile {
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = i * 10 + seed;
    b[i] = 1000 - i * 10 + seed;
  }
  return {
    version: "FCS3.1",
    nEvents: n,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [a, b],
    spillover: null,
  };
}

describe("plotPayload plotted points", () => {
  it("is absent unless asked for, and then names plotted point k as event k when nothing is masked", () => {
    const sample = new Sample(fileOf(5));
    expect(sample.plotPayload(0, 1, "dots", [], null, null, null, null).plotted).toBeUndefined();
    const plotted = sample.plotPayload(0, 1, "dots", [], null, null, null, null, Infinity, 5, null, { plotted: true }).plotted!;
    expect(plotted.indices).toBeNull();
    expect(plotted.xd).toHaveLength(5);
    expect(plotted.xd[3]).toBe(sample.displayColumn(0)[3]);
  });

  it("carries the event index of each plotted point under a mask and under the cap", () => {
    const sample = new Sample(fileOf(10));
    const mask = new Uint8Array(10);
    for (const i of [1, 4, 7, 9]) mask[i] = 1;
    const masked = sample.plotPayload(0, 1, "dots", [], mask, null, null, null, Infinity, 5, null, { plotted: true }).plotted!;
    expect(Array.from(masked.indices!)).toEqual([1, 4, 7, 9]);
    expect(masked.xd[2]).toBe(sample.displayColumn(0)[7]);
    const capped = sample.plotPayload(0, 1, "dots", [], null, null, null, null, 4, 5, null, { plotted: true }).plotted!;
    expect(Array.from(capped.indices!)).toEqual([0, 3, 6, 9]);
    expect(capped.yd[1]).toBe(sample.displayColumn(1)[3]);
  });
});

describe("buildCombinedSamplePointCloud origins", () => {
  it("says which file and which event each pooled point came from, only when asked", () => {
    const a = new Sample(fileOf(4));
    const b = new Sample(fileOf(3, 0.5));
    const maskA = Uint8Array.from([1, 0, 1, 1]);
    const inputs = [
      { id: "A", name: "A", sample: a, xIndex: 0, yIndex: 1, mask: maskA },
      { id: "B", name: "B", sample: b, xIndex: 0, yIndex: 1, mask: null },
    ];
    const plain = buildCombinedSamplePointCloud(inputs, Infinity);
    expect(plain.sampleOf).toBeUndefined();
    expect(plain.eventIndex).toBeUndefined();
    const cloud = buildCombinedSamplePointCloud(inputs, Infinity, { origins: true });
    expect(Array.from(cloud.sampleOf!)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(Array.from(cloud.eventIndex!)).toEqual([0, 2, 3, 0, 1, 2]);
    expect(cloud.x[1]).toBe(a.displayColumn(0)[2]);
    expect(cloud.x[4]).toBe(b.displayColumn(0)[1]);
  });
});
