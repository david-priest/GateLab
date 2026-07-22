import { describe, expect, it } from "vitest";
import type { Sample } from "./sample";
import type { PopulationMap } from "./models";
import {
  buildHeatmapPayload,
  exactMedian,
  heatmapScaleNeedsPopulationComparison,
  scaleHeatmapValues,
} from "./heatmap";

describe("illustration heatmap", () => {
  it("calculates exact odd/even medians without sorting the caller's array", () => {
    const odd = [9, 1, 5];
    const even = [10, 2, 8, 4];
    expect(exactMedian([...odd])).toBe(5);
    expect(exactMedian([...even])).toBe(6);
    expect(odd).toEqual([9, 1, 5]);
    expect(even).toEqual([10, 2, 8, 4]);
  });

  it("matches a sorted median across deterministic duplicate-heavy inputs", () => {
    let state = 0x5eed1234;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    for (let length = 1; length <= 200; length++) {
      const values = Array.from({ length }, () => Math.floor(random() * 17) - 8);
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(length / 2);
      const expected = length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
      expect(exactMedian([...values])).toBe(expected);
    }
  });

  it("supports explicit per-channel, per-population, and z-score scaling", () => {
    const raw = [[2, 8, null], [8, 2, null], [5, 5, null]];
    expect(scaleHeatmapValues(raw, "column_minmax")).toEqual([
      [0, 1, null], [1, 0, null], [0.5, 0.5, null],
    ]);
    expect(scaleHeatmapValues(raw, "row_minmax")).toEqual([
      [0, 1, null], [1, 0, null], [0.5, 0.5, null],
    ]);
    const z = scaleHeatmapValues(raw, "column_zscore");
    expect(z[0][0]).toBeCloseTo(-1, 12);
    expect(z[1][0]).toBeCloseTo(1, 12);
    expect(z[2][0]).toBeCloseTo(0, 12);
    expect(z[0][2]).toBeNull();
  });

  it("identifies scale modes that become uninformative with one population", () => {
    expect(heatmapScaleNeedsPopulationComparison("column_minmax", 1)).toBe(true);
    expect(heatmapScaleNeedsPopulationComparison("column_zscore", 1)).toBe(true);
    expect(heatmapScaleNeedsPopulationComparison("row_minmax", 1)).toBe(false);
    expect(heatmapScaleNeedsPopulationComparison("none", 1)).toBe(false);
    expect(heatmapScaleNeedsPopulationComparison("column_minmax", 2)).toBe(false);
  });

  it("builds ordered all-event median rows and keeps empty populations", () => {
    const columns = [
      Float32Array.from([0, 2, 4, 6, 8, 10]),
      Float32Array.from([10, 8, 6, 4, 2, 0]),
    ];
    const keys = ["BarcodeA", "BarcodeB"];
    const sample = {
      fcs: { nEvents: 6 },
      index: (key: string) => keys.indexOf(key) >= 0 ? keys.indexOf(key) : undefined,
      labelForKey: (key: string) => key.replace("Barcode", "Barcode "),
      displayColumn: (index: number) => columns[index],
    } as unknown as Sample;
    const populations: PopulationMap = {
      low: { population_id: "low", name: "Low barcode" } as PopulationMap[string],
      high: { population_id: "high", name: "High barcode" } as PopulationMap[string],
      empty: { population_id: "empty", name: "No events" } as PopulationMap[string],
    };
    const masks = {
      low: Uint8Array.from([1, 1, 1, 0, 0, 0]),
      high: Uint8Array.from([0, 0, 0, 1, 1, 1]),
      empty: new Uint8Array(6),
    };
    const payload = buildHeatmapPayload(
      sample, populations, masks, { low: 3, high: 3, empty: 0 },
      ["high", "low", "empty"], ["BarcodeB", "BarcodeA"],
      {
        summaryStat: "median", scaleMode: "column_minmax",
        palette: "blue_white_yellow_red", cellSize: 30, showValues: false,
      },
    );

    expect(payload.channels.map((channel) => channel.label)).toEqual(["Barcode B", "Barcode A"]);
    expect(payload.rows.map((row) => row.name)).toEqual(["High barcode", "Low barcode", "No events"]);
    expect(payload.rows.map((row) => row.raw_values)).toEqual([[2, 8], [8, 2], [null, null]]);
    expect(payload.rows.map((row) => row.values)).toEqual([[0, 1], [1, 0], [null, null]]);
    expect([payload.legend_min, payload.legend_max]).toEqual([0, 1]);
  });
});
