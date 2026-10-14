import { describe, expect, it } from "vitest";
import { eventsInRange, formatWallValue, valueSpan, wallHistogram } from "./wallBins";

const column = Float32Array.from([0, 10, 20, 30, 40, NaN, 50, 60, 70, 80, 90, 100]);
const events = Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

describe("wallHistogram", () => {
  it("spans the finite values and bins them evenly, the top value in the last bin", () => {
    expect(valueSpan(column, events)).toEqual([0, 100]);
    const h = wallHistogram(column, events, 10)!;
    expect(h.lo).toBe(0);
    expect(h.hi).toBe(100);
    expect(h.total).toBe(11);
    expect(Array.from(h.counts)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
    expect(h.peak).toBe(2);
  });
  it("is null with nothing finite and makes one bin of a single value", () => {
    expect(wallHistogram(Float32Array.from([NaN]), Int32Array.from([0]))).toBeNull();
    expect(wallHistogram(column, new Int32Array(0))).toBeNull();
    const one = wallHistogram(Float32Array.from([7]), Int32Array.from([0]), 4)!;
    expect([one.lo, one.hi]).toEqual([6.5, 7.5]);
    expect(Array.from(one.counts)).toEqual([0, 0, 1, 0]);
  });
  it("keeps the events in a range, in order, and drops the rest", () => {
    expect(Array.from(eventsInRange(column, Int32Array.from([11, 3, 7, 5, 0]), 25, 70))).toEqual([3, 7]);
  });
  it("formats values to three figures", () => {
    expect(formatWallValue(123456)).toBe("123456");
    expect(formatWallValue(1234567)).toBe("1.23e+6");
    expect(formatWallValue(0.5)).toBe("0.5");
    expect(formatWallValue(3.14159)).toBe("3.14");
    expect(formatWallValue(-42.5)).toBe("-42.5");
    expect(formatWallValue(0)).toBe("0");
    expect(formatWallValue(NaN)).toBe("–");
  });
});
