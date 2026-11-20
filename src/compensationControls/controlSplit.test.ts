import { describe, expect, it } from "vitest";
import { sortedValues } from "./controlFile";
import { positiveLowerFromNegative, splitControl } from "./controlSplit";
import { BEADS, beadControl, CELLS, cellControl, seededNormal, seededRandom, syntheticControl } from "./syntheticControls.fixture";

const FITC = 0;
const RANGE = 262144;

describe("splitControl", () => {
  it("cuts a bead control between its two peaks and keeps valley events out of both sets", () => {
    const file = beadControl(FITC, { id: "fitc" });
    const split = splitControl(file.columns[FITC], RANGE)!;
    expect(split.bimodal).toBe(true);
    // Negative beads sit near 60 with an SD near 23, positive beads near 40,000.
    expect(split.negativeUpper).toBeGreaterThan(100);
    expect(split.negativeUpper).toBeLessThan(5000);
    expect(split.positiveLower).toBeGreaterThan(5000);
    expect(split.positiveLower).toBeLessThan(35_000);
    expect(split.negativeUpper).toBeLessThanOrEqual(split.cut);
    expect(split.positiveLower).toBeGreaterThanOrEqual(split.cut);
    const positives = file.positive[0].reduce((sum, flag) => sum + flag, 0);
    expect(Math.abs(split.positiveCount - positives)).toBeLessThanOrEqual(0.01 * positives);
    expect(Math.abs(split.negativeCount - (file.eventCount - positives))).toBeLessThanOrEqual(0.01 * file.eventCount);
  });

  it("finds a small, broad positive population on cells", () => {
    const file = cellControl(FITC, { id: "fitc" }, 0.05);
    const split = splitControl(file.columns[FITC], RANGE)!;
    expect(split.bimodal).toBe(true);
    const positives = file.positive[0].reduce((sum, flag) => sum + flag, 0);
    // A broad population reaches down to the cut, so a few of its dimmest events are left out.
    expect(split.positiveCount).toBeGreaterThan(0.85 * positives);
    expect(split.positiveCount).toBeLessThanOrEqual(positives + 5);
  });

  it("reports one population for an unstained file", () => {
    const file = syntheticControl({ id: "unstained", particle: CELLS, seed: 7 });
    for (const column of file.columns) expect(splitControl(column, RANGE)!.bimodal).toBe(false);
  });

  it("reports one population where every event is positive", () => {
    const file = syntheticControl({
      id: "all-positive", particle: CELLS, seed: 8,
      stains: [{ fluor: FITC, fraction: 1, brightness: 20_000, spread: 0.5 }],
    });
    expect(splitControl(file.columns[FITC], RANGE)!.bimodal).toBe(false);
  });

  it("does not split noise around zero into a negative and a positive peak", () => {
    // Baseline-subtracted background: centred on zero, half the values negative, on an instrument
    // that states no range.
    const normal = seededNormal(seededRandom(11));
    const values = Float32Array.from({ length: 5000 }, () => 12 * normal());
    expect(splitControl(values, 0)!.bimodal).toBe(false);
    expect(splitControl(values, RANGE)!.bimodal).toBe(false);
  });

  it("does not take a few bright outliers for a positive population", () => {
    const file = syntheticControl({ id: "outliers", particle: BEADS, seed: 12, events: 5000 });
    const values = Float32Array.from(file.columns[FITC]);
    for (let k = 0; k < 15; k++) values[k * 300] = 60_000 + 100 * k;
    expect(splitControl(values, RANGE)!.bimodal).toBe(false);
  });

  it("splits only the events it is given", () => {
    const file = beadControl(FITC, { id: "fitc" });
    const negatives = Uint32Array.from(
      Array.from({ length: file.eventCount }, (_, event) => event).filter((event) => !file.positive[0][event]),
    );
    expect(splitControl(file.columns[FITC], RANGE)!.bimodal).toBe(true);
    expect(splitControl(file.columns[FITC], RANGE, negatives)!.bimodal).toBe(false);
  });

  it("returns nothing for too few events or a constant column", () => {
    expect(splitControl(new Float32Array(30).fill(1).map((_, k) => k), RANGE)).toBeNull();
    expect(splitControl(new Float32Array(500).fill(42), RANGE)).toBeNull();
  });
});

describe("positiveLowerFromNegative", () => {
  it("sits above the negative file's values", () => {
    const unstained = syntheticControl({ id: "unstained", particle: CELLS, seed: 7 });
    const sorted = sortedValues(unstained.columns[FITC]);
    const lower = positiveLowerFromNegative(sorted);
    const above = sorted.filter((value) => value >= lower).length;
    expect(above).toBeLessThan(0.002 * sorted.length);
    expect(lower).toBeLessThan(5000);
  });
});
