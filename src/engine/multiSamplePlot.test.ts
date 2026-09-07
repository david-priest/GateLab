import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";
import {
  aggregateGateCounts,
  aggregatePopulationTreeStats,
  allocateCombinedSampleCaps,
  buildCombinedSamplePointCloud,
  buildWorkspaceAxisRanges,
  type CombinedSamplePlotInput,
} from "./multiSamplePlot";
import type { Gate, PopulationMap } from "./models";
import { gateMaskKey } from "./populations";

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

describe("buildWorkspaceAxisRanges", () => {
  it("uses every compatible file and ignores population masks", () => {
    const first = input("a", [1, 2, 3], Uint8Array.from([1, 0, 0]));
    const second = input("b", [100, 110, 120], Uint8Array.from([0, 0, 1]));
    const ranges = buildWorkspaceAxisRanges([first, second], 100);
    const firstX = first.sample.displayColumn(first.xIndex);
    const firstY = first.sample.displayColumn(first.yIndex);
    const secondX = second.sample.displayColumn(second.xIndex);
    const secondY = second.sample.displayColumn(second.yIndex);
    expect(ranges).not.toBeNull();
    expect(ranges!.xRange[0]).toBeLessThan(firstX[0]);
    expect(ranges!.xRange[1]).toBeGreaterThan(secondX[secondX.length - 1]);
    expect(ranges!.yRange[0]).toBeLessThan(firstY[0]);
    expect(ranges!.yRange[1]).toBeGreaterThan(secondY[secondY.length - 1]);
  });
});

describe("aggregatePopulationTreeStats", () => {
  it("sums file-specific populations and derives percentages from pooled parents", () => {
    const populations = {
      root: {
        population_id: "root",
        name: "All Events",
        gate_refs: [],
        gate_logic: "and",
        parent_id: null,
        children: ["cells"],
        event_count: null,
        percent_of_parent: null,
      },
      cells: {
        population_id: "cells",
        name: "Cells",
        gate_refs: [],
        gate_logic: "and",
        parent_id: "root",
        children: ["f0", "f1"],
        event_count: null,
        percent_of_parent: null,
      },
      f0: {
        population_id: "f0",
        name: "F0",
        gate_refs: [],
        gate_logic: "and",
        parent_id: "cells",
        children: [],
        event_count: null,
        percent_of_parent: null,
      },
      f1: {
        population_id: "f1",
        name: "F1",
        gate_refs: [],
        gate_logic: "and",
        parent_id: "cells",
        children: [],
        event_count: null,
        percent_of_parent: null,
      },
    } satisfies PopulationMap;
    const pooled = aggregatePopulationTreeStats(populations, "root", [
      {
        event_count: { root: 100, cells: 80, f0: 30, f1: 0 },
        percent_of_parent: {},
        percent_of_total: {},
      },
      {
        event_count: { root: 200, cells: 120, f0: 0, f1: 60 },
        percent_of_parent: {},
        percent_of_total: {},
      },
    ]);

    expect(pooled.event_count).toEqual({ root: 300, cells: 200, f0: 30, f1: 60 });
    expect(pooled.percent_of_parent).toEqual({ root: 100, cells: 66.67, f0: 15, f1: 30 });
    expect(pooled.percent_of_total).toEqual({ root: 100, cells: 66.67, f0: 10, f1: 20 });
  });
});

describe("aggregateGateCounts", () => {
  const gates = {
    g1: { gate_id: "g1", name: "G1", gate_type: "polygon", x_channel: "a", y_channel: "b", vertices: [] },
    q1: { gate_id: "q1", name: "Q1", gate_type: "quadrant", x_channel: "a", y_channel: "b", center: [0, 0] },
  } as unknown as Record<string, Gate>;

  // The case the pooled label exists for: the blue file has no events in the gate, the other
  // checked file has three of its four there. Per file that is 0%; pooled it is 3 of 7.
  it("sums gate members and the active population across files", () => {
    const counts = aggregateGateCounts(gates, [
      {
        gateMasks: { g1: Uint8Array.from([0, 0, 0]), [gateMaskKey("q1", 1)]: Uint8Array.from([1, 0, 0]),
          [gateMaskKey("q1", 2)]: Uint8Array.from([0, 1, 0]), [gateMaskKey("q1", 3)]: Uint8Array.from([0, 0, 1]), [gateMaskKey("q1", 4)]: Uint8Array.from([0, 0, 0]) },
        activeMask: null,
        eventCount: 3,
      },
      {
        gateMasks: { g1: Uint8Array.from([1, 1, 1, 0]), [gateMaskKey("q1", 1)]: Uint8Array.from([0, 0, 0, 0]),
          [gateMaskKey("q1", 2)]: Uint8Array.from([1, 1, 0, 0]), [gateMaskKey("q1", 3)]: Uint8Array.from([0, 0, 1, 1]), [gateMaskKey("q1", 4)]: Uint8Array.from([0, 0, 0, 0]) },
        activeMask: null,
        eventCount: 4,
      },
    ]);
    expect(counts.g1).toEqual({ event_count: 3, percent_of_parent: 42.86 });
    expect(counts.q1.quadrants!.map((q) => q.event_count)).toEqual([1, 3, 3, 0]);
    expect(counts.q1.quadrants![1].percent_of_parent).toBe(42.86);
  });

  it("counts only events in each file's active population, with the denominator pooled the same way", () => {
    const counts = aggregateGateCounts({ g1: gates.g1 }, [
      { gateMasks: { g1: Uint8Array.from([1, 1, 1]) }, activeMask: Uint8Array.from([1, 0, 0]), eventCount: 3 },
      { gateMasks: { g1: Uint8Array.from([1, 0, 0, 0]) }, activeMask: Uint8Array.from([1, 1, 1, 0]), eventCount: 4 },
    ]);
    expect(counts.g1).toEqual({ event_count: 2, percent_of_parent: 50 });
  });

  it("reports 0% rather than NaN when no file has events in the active population", () => {
    const counts = aggregateGateCounts({ g1: gates.g1 }, [
      { gateMasks: { g1: Uint8Array.from([1]) }, activeMask: Uint8Array.from([0]), eventCount: 1 },
    ]);
    expect(counts.g1).toEqual({ event_count: 0, percent_of_parent: 0 });
  });
});
