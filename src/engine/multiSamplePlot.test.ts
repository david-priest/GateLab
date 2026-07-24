import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";
import {
  allocateCombinedSampleCaps,
  buildCombinedSamplePointCloud,
  type CombinedSamplePlotInput,
} from "./multiSamplePlot";

function sample(name: string, values: readonly number[]): Sample {
  const columns = [
    Float32Array.from(values),
    Float32Array.from(values.map((value) => value + 100)),
  ];
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: values.length,
    instrument: "cytof",
    keywords: { "$FIL": name },
    spillover: null,
    channels: [
      { index: 0, name: "X", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "Y", marker: null, bits: 32, range: 262144 },
    ],
    columns,
  };
  return new Sample(fcs);
}

function input(
  id: string,
  values: readonly number[],
  mask: Uint8Array | null = null,
  colorIndex?: number,
): CombinedSamplePlotInput {
  const s = sample(`${id}.fcs`, values);
  return {
    id,
    name: `${id}.fcs`,
    sample: s,
    xIndex: s.index("X")!,
    yIndex: s.index("Y")!,
    mask,
    ...(colorIndex === undefined ? {} : { colorIndex }),
  };
}

describe("allocateCombinedSampleCaps", () => {
  it("shares one exact cap proportionally without multiplying it per file", () => {
    expect(allocateCombinedSampleCaps([4, 6], 5)).toEqual([2, 3]);
    expect(allocateCombinedSampleCaps([100, 100, 100], 2)).toEqual([1, 1, 0]);
  });

  it("keeps every point when the combined data fit or the cap is unlimited", () => {
    expect(allocateCombinedSampleCaps([2, 3], 10)).toEqual([2, 3]);
    expect(allocateCombinedSampleCaps([2, 3], Infinity)).toEqual([2, 3]);
  });
});

describe("buildCombinedSamplePointCloud", () => {
  it("combines checked-file masks, reports the full count, and downsamples deterministically", () => {
    const first = input("a", [1, 2, 3, 4], Uint8Array.from([1, 0, 1, 1]), 0);
    const second = input("b", [10, 20, 30, 40], Uint8Array.from([0, 1, 1, 0]), 1);
    const cloud = buildCombinedSamplePointCloud([first, second], 4);

    expect(cloud.eventCount).toBe(5);
    expect(cloud.x).toHaveLength(4);
    expect(cloud.y).toHaveLength(4);
    expect(Array.from(cloud.colors!)).toEqual([0, 0, 1, 1]);
    expect(cloud.sampleEventCounts).toEqual([
      { id: "a", name: "a.fcs", eventCount: 3 },
      { id: "b", name: "b.fcs", eventCount: 2 },
    ]);
  });

  it("supports an empty checked set without falling back to the active file", () => {
    const cloud = buildCombinedSamplePointCloud([], 50_000);
    expect(cloud.eventCount).toBe(0);
    expect(cloud.x).toHaveLength(0);
    expect(cloud.y).toHaveLength(0);
    expect(cloud.colors).toBeNull();
  });
});
