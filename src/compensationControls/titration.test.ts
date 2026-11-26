import { describe, expect, it } from "vitest";
import { measureTube, parseDose, readTitrationSeries, type TitrationSeries, type TitrationTube } from "./titration";

const tube: TitrationTube = {
  fileId: "D1", dose: "1:20", replicate: "A", populationId: null,
  negativeLower: null, negativeUpper: 5, positiveLower: 10, positiveUpper: null,
};
const series: TitrationSeries = {
  id: "S1", clone: "C1", conjugate: "PE", lot: "L1", detector: "FL2-A", unit: "dilution",
  tubes: [tube], chosenDose: tube.dose, note: "Reviewed",
};

describe("titration doses", () => {
  it("compares concentrations and dilutions numerically", () => {
    const labels = ["1:20", "10", "0", "1 / 100", ".5", "1e−3"];
    expect(labels.map(parseDose)).toEqual([0.05, 10, 0, 0.01, 0.5, 0.001]);
    expect([...labels].sort((a, b) => parseDose(a)! - parseDose(b)!)).toEqual(["0", "1e−3", "1 / 100", "1:20", ".5", "10"]);
  });

  it("rejects malformed, negative and nonfinite doses", () => {
    for (const dose of ["", "  ", "-1", "−1", "1/0", "1/−2", "1::2", "3e", "2 mg", "0xff", "1e309", "Infinity", "1/Infinity"]) {
      expect(parseDose(dose), dose).toBeNull();
    }
  });
});

describe("titration measurements", () => {
  it("measures raw values in the masked half-open intervals and excludes nonfinite events", () => {
    const values = Float64Array.of(-20, -4, -2, 0, 2, 4, 5, 9, 10, 98, 99, 100, 140, NaN, -Infinity, Infinity);
    const gate = { ...tube, populationId: "cells", negativeLower: -4, positiveUpper: 140 };
    const mask = new Uint8Array(values.length).fill(1);
    mask[11] = 0;
    const stats = measureTube(values, mask, gate, 100)!;
    // Five evenly spaced negative events give P84.13 = 2.7304 and P15.87 = -2.7304.
    expect(stats.negativeCount).toBe(5);
    expect(stats.positiveCount).toBe(3);
    expect(stats.negativeMedian).toBe(0);
    expect(stats.positiveMedian).toBe(98);
    expect(stats.negativeSpread).toBeCloseTo(2.7304, 10);
    expect(stats.stainIndex).toBeCloseTo(98 / (2 * 2.7304), 10);
    expect(stats.saturationFraction).toBeCloseTo(1 / 3);
  });

  it("assigns a shared boundary to the positive interval and preserves a zero negative median", () => {
    const stats = measureTube([-2, 0, 2, 5, 5, 6, -Infinity, Infinity, NaN], null, { ...tube, positiveLower: 5 }, 100);
    expect(stats).toMatchObject({ positiveCount: 3, negativeCount: 3, positiveMedian: 5, negativeMedian: 0, saturationFraction: 0 });
  });

  it("retains independent measurements when an interval is empty, the spread is zero, or range is unknown", () => {
    expect(measureTube([], null, tube, 100)).toEqual({
      negativeCount: 0, positiveCount: 0, negativeMedian: null, positiveMedian: null,
      negativeSpread: null, stainIndex: null, saturationFraction: null,
    });
    expect(measureTube([10], null, tube, 10)).toMatchObject({
      negativeCount: 0, positiveCount: 1, positiveMedian: 10, negativeMedian: null, stainIndex: null, saturationFraction: 1,
    });
    expect(measureTube([2, 2, 12], null, tube, 0)).toMatchObject({
      negativeMedian: 2, positiveMedian: 12, negativeSpread: 0, stainIndex: null, saturationFraction: null,
    });
    expect(measureTube([2], null, tube, Infinity)).toMatchObject({ negativeMedian: 2, positiveMedian: null, stainIndex: null, saturationFraction: null });
  });

  it("refuses inverted, overlapping, missing or nonfinite bounds and masks from the wrong file", () => {
    for (const change of [
      { negativeLower: 5 }, { positiveUpper: 8 }, { positiveLower: 4 },
      { negativeUpper: null }, { positiveLower: null }, { negativeUpper: null, positiveLower: null },
      { negativeLower: -Infinity }, { positiveLower: NaN },
    ]) expect(measureTube([0, 10], null, { ...tube, ...change }, 100)).toBeNull();
    expect(measureTube([0, 10], new Uint8Array(1), tube, 100)).toBeNull();
    expect(measureTube([0, 10], null, { ...tube, populationId: "live" }, 100)).toBeNull();
  });
});

describe("saved titration series", () => {
  const reviewed = {
    detector: series.detector, populationId: null, assay: "original" as const, fileName: "D1.fcs",
    eventCount: 4, statistics: measureTube([1, 2, 3, 10], null, tube, 100)!,
  };
  it("round-trips a review, a draft, and a series saved before review snapshots", () => {
    const draft = { ...tube, fileId: "D2", dose: "", negativeUpper: null, positiveLower: null };
    const saved = [{ ...series, tubes: [{ ...tube, reviewed }, draft] }, { ...series, id: "S2" }];
    expect(readTitrationSeries(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(readTitrationSeries(undefined)).toEqual([]);
    expect(readTitrationSeries({})).toEqual([]);
  });

  it("accepts the first valid record for each ID and never widens a malformed gate", () => {
    const saved = [null, {}, { ...series, clone: 17 }, {
      ...series, tubes: [{ ...tube, positiveUpper: "0" }, tube, { ...tube, dose: "3" },
        { ...tube, fileId: "D2", populationId: [] }, { ...tube, fileId: " " }],
    }, { ...series, lot: "duplicate" }];
    expect(readTitrationSeries(saved)).toEqual([series]);
    expect(readTitrationSeries([{ ...series, chosenDose: "1:50" }])[0].chosenDose).toBeNull();
  });

  it("discards invalid or mismatched historical statistics and keeps the editable tube", () => {
    for (const change of [
      { detector: "FL3-A" }, { assay: "compensated" }, { populationId: "live" }, { eventCount: 2 }, { fileName: "" },
      { statistics: {} }, { statistics: { ...reviewed.statistics, negativeCount: -1 } },
      { statistics: { ...reviewed.statistics, positiveMedian: NaN } }, { statistics: { ...reviewed.statistics, stainIndex: 0 } },
      { statistics: { ...reviewed.statistics, saturationFraction: 2 } },
    ]) {
      const saved = { ...series, tubes: [{ ...tube, reviewed: { ...reviewed, ...change } }] };
      expect(readTitrationSeries([saved])).toEqual([series]);
    }
  });
});
