// Division codes and division counts agree on values that are not finite: NaN has no level,
// and an infinite value has one.
import { describe, expect, it } from "vitest";
import { divisionEventCodes, divisionLevelCounts, DIVISION_NA_CODE } from "./division";

describe("division: the per-event codes and the per-level counts disagree on non-finite values", () => {
  it("an event with no value (NaN) gets the NA code, not the dimmest division", () => {
    const codes = divisionEventCodes([NaN, 5, 50], [10, 20], null);
    expect(codes[0]).toBe(DIVISION_NA_CODE);
  });
  it("the counts of each level equal the number of events coded with it", () => {
    const values = [Infinity, -Infinity, 5, 15, 25];
    const bounds = [10, 20];
    const codes = divisionEventCodes(values, bounds, null);
    const counts = divisionLevelCounts(values, bounds);
    const fromCodes = counts.map((_, level) => codes.filter((c) => c === level).length);
    expect(counts).toEqual(fromCodes);
  });
});
