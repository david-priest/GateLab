import { describe, expect, it } from "vitest";
import { compensate, invertMatrix } from "../engine/compensation";
import { storableFlowMatrix } from "../ui/compensationLibrary";
import type { ControlFile } from "./controlFile";
import { planControls } from "./controlPlan";
import { compareSpillover, estimateSpillover, type ControlSpec } from "./spilloverEstimate";
import {
  BEADS,
  beadControl,
  CELLS,
  cellControl,
  PANEL,
  syntheticControl,
  TRUE_SPILLOVER,
} from "./syntheticControls.fixture";

/** A file from columns written out by hand. */
function handFile(id: string, columns: Record<string, number[]>, range = 262144): ControlFile {
  const keys = Object.keys(columns);
  return {
    id,
    fileName: `${id}.fcs`,
    labels: [],
    eventCount: columns[keys[0]].length,
    channels: keys.map((key) => ({ key, pnn: key, marker: null, range })),
    values: (key) => columns[key] ?? null,
  };
}

function expectMatrixNear(actual: readonly (readonly number[])[], expected: number[][], tolerance: (value: number) => number) {
  expected.forEach((row, i) => row.forEach((value, j) => {
    expect(Math.abs(actual[i][j] - value), `${PANEL[i]} into ${PANEL[j]}: ${actual[i][j]} against ${value}`)
      .toBeLessThanOrEqual(tolerance(value));
  }));
}

describe("estimateSpillover", () => {
  it("is the ratio of median differences, with R's median for an even count", () => {
    // Positive events (A at or above 500): the middle two of A are 1000 and 1100 -> 1050; of B 110
    // and 130 -> 120. Negative events: of A 0 and 20 -> 10; of B 10 and 30 -> 20.
    const file = handFile("a", {
      A: [900, 1000, 1000, 1100, 1100, 1200, -10, 0, 0, 20, 20, 30],
      B: [100, 110, 110, 130, 130, 150, 0, 10, 10, 30, 30, 40],
    });
    const spec: ControlSpec = {
      channel: "A",
      positive: { fileId: "a", lower: 500 },
      negative: { fileId: "a", upper: 500 },
    };
    const estimate = estimateSpillover([file], ["A", "B"], [spec]);
    expect(estimate.matrix[0]).toEqual([1, (120 - 20) / (1050 - 10)]);
    expect(estimate.matrix[1]).toEqual([0, 1]);
    expect(estimate.rows[0]).toMatchObject({
      source: "control", positiveCount: 6, negativeCount: 6, positiveMedian: 1050, negativeMedian: 10,
    });
    expect(estimate.rows[1]).toMatchObject({ source: "none", calculated: null });
  });

  it("takes the negative events from another file, and only the events of a mask", () => {
    const control = handFile("a", { A: [1000, 1000, 1000, 1000, 1000, 1000], B: [210, 210, 210, 210, 210, 999] });
    const unstained = handFile("u", { A: [0, 0, 0, 0, 0, 500], B: [10, 10, 10, 10, 10, 700] });
    const mask = Uint8Array.from([1, 1, 1, 1, 1, 0]);
    const estimate = estimateSpillover([control, unstained], ["A", "B"], [{
      channel: "A",
      positive: { fileId: "a", mask },
      negative: { fileId: "u", mask },
    }]);
    expect(estimate.matrix[0][1]).toBeCloseTo(0.2, 12);
    expect(estimate.rows[0]).toMatchObject({ positiveFileId: "a", negativeFileId: "u", positiveCount: 5, negativeCount: 5 });
  });

  it("recovers a known matrix from bead controls, each with its own negative beads", () => {
    const files = PANEL.map((_, fluor) => beadControl(fluor, { id: `c${fluor}`, fileName: `${PANEL[fluor]}.fcs` }));
    const plan = planControls(files);
    expect(plan.controls.map((control) => control.negativeSource)).toEqual(PANEL.map(() => "internal"));
    const estimate = estimateSpillover(files, [...PANEL], plan.specs);
    expectMatrixNear(estimate.matrix, TRUE_SPILLOVER, (value) => 0.002 + 0.02 * value);
    expect(estimate.rows.every((row) => row.source === "control")).toBe(true);
    expect(estimate.diagnostics?.conditionInfinity).toBeGreaterThan(1);
  });

  it("recovers a known matrix from cell controls against an unstained file of the same cells", () => {
    const files = [
      ...PANEL.map((_, fluor) => cellControl(fluor, { id: `c${fluor}`, fileName: `t${fluor}.fcs`, events: 20_000 })),
      syntheticControl({ id: "u", fileName: "unstained.fcs", particle: CELLS, seed: 51, events: 20_000 }),
    ];
    const plan = planControls(files, { negative: "unstained" });
    expect(plan.controls.map((control) => control.negativeFileId)).toEqual(PANEL.map(() => "u"));
    const estimate = estimateSpillover(files, [...PANEL], plan.specs);
    expectMatrixNear(estimate.matrix, TRUE_SPILLOVER, (value) => 0.003 + 0.03 * value);
  });

  it("gives a matrix GateLab stores as it is", () => {
    const files = PANEL.map((_, fluor) => beadControl(fluor, { id: `c${fluor}`, fileName: `${PANEL[fluor]}.fcs` }));
    const estimate = estimateSpillover(files, [...PANEL], planControls(files).specs);
    const stored = storableFlowMatrix({
      sourceChannels: estimate.channels,
      receiverChannels: estimate.channels,
      matrix: estimate.matrix,
    });
    expect(stored.validation.ok).toBe(true);
    expect(stored.roundedCoefficients).toBe(0);
  });

  it("stores an estimate below zero as 0 and keeps the value calculated", () => {
    const file = handFile("a", {
      A: [1000, 1000, 1000, 1000, 1000, 0, 0, 0, 0, 0],
      B: [5, 5, 5, 5, 5, 25, 25, 25, 25, 25],
      C: [100, 100, 100, 100, 100, 0, 0, 0, 0, 0],
    });
    const estimate = estimateSpillover([file], ["A", "B", "C"], [{
      channel: "A", positive: { fileId: "a", lower: 500 }, negative: { fileId: "a", upper: 500 },
    }]);
    expect(estimate.matrix[0]).toEqual([1, 0, 0.1]);
    expect(estimate.rows[0].calculated).toEqual([1, -0.02, 0.1]);
    expect(estimate.rows[0].warnings).toContainEqual({ code: "negative-set-to-zero", count: 1, receiver: "B", lowest: -0.02 });
  });

  it("warns where a control is brighter in another channel than in its own", () => {
    const file = handFile("a", {
      A: [1000, 1000, 1000, 1000, 1000, 0, 0, 0, 0, 0],
      B: [1500, 1500, 1500, 1500, 1500, 0, 0, 0, 0, 0],
    });
    const estimate = estimateSpillover([file], ["A", "B"], [{
      channel: "A", positive: { fileId: "a", lower: 500 }, negative: { fileId: "a", upper: 500 },
    }]);
    expect(estimate.matrix[0][1]).toBe(1.5);
    expect(estimate.rows[0].warnings).toContainEqual({ code: "coefficient-above-one", receiver: "B", value: 1.5 });
  });

  it("warns of few events, and gives no row for almost none or for no signal", () => {
    const file = handFile("a", {
      A: [1000, 1000, 1000, 1000, 1000, 1000, 0, 0, 0, 0, 0, 0],
      B: [100, 100, 100, 100, 100, 100, 0, 0, 0, 0, 0, 0],
    });
    const few = estimateSpillover([file], ["A", "B"], [{
      channel: "A", positive: { fileId: "a", lower: 500 }, negative: { fileId: "a", upper: 500 },
    }]);
    expect(few.matrix[0][1]).toBe(0.1);
    expect(few.rows[0].warnings).toEqual([
      { code: "few-positive-events", count: 6 },
      { code: "few-negative-events", count: 6 },
    ]);

    const almostNone = estimateSpillover([file], ["A", "B"], [{
      channel: "A", positive: { fileId: "a", lower: 5000 }, negative: { fileId: "a", upper: 500 },
    }]);
    expect(almostNone.matrix[0]).toEqual([1, 0]);
    expect(almostNone.rows[0]).toMatchObject({ source: "none", calculated: null, positiveCount: 0 });

    // The "positive" events are the dimmer ones.
    const noSignal = estimateSpillover([file], ["A", "B"], [{
      channel: "A", positive: { fileId: "a", upper: 500 }, negative: { fileId: "a", lower: 500 },
    }]);
    expect(noSignal.matrix[0]).toEqual([1, 0]);
    expect(noSignal.rows[0].warnings).toContainEqual({ code: "no-signal" });
  });

  it("warns where positive events sit at the top of the channel's range", () => {
    const n = 400;
    const file = handFile("a", {
      A: Array.from({ length: n }, (_, k) => (k < 200 ? (k < 20 ? 999 : 800) : 0)),
      B: Array.from({ length: n }, (_, k) => (k < 200 ? 80 : 0)),
    }, 1000);
    const estimate = estimateSpillover([file], ["A", "B"], [{
      channel: "A", positive: { fileId: "a", lower: 500 }, negative: { fileId: "a", upper: 500 },
    }]);
    expect(estimate.rows[0].warnings).toEqual([{ code: "positive-at-top-of-range", fraction: 0.1 }]);
  });

  it("takes the row of a channel without a control from the fallback matrix, and says so", () => {
    const files = [0, 1].map((fluor) => beadControl(fluor, { id: `c${fluor}`, fileName: `${PANEL[fluor]}.fcs` }));
    const channels = [PANEL[0], PANEL[1], PANEL[2]];
    const fallback = { channels: [PANEL[2], PANEL[1], PANEL[0]], matrix: [[1, 0.015, -0.001], [0.08, 1, 0.02], [0.01, 0.12, 1]] };
    const withFallback = estimateSpillover(files, channels, planControls(files).specs, fallback);
    expect(withFallback.rows.map((row) => row.source)).toEqual(["control", "control", "fallback"]);
    // PE-Cy7's row, reordered to the matrix's channels, its negative coefficient stored as 0.
    expect(withFallback.matrix[2]).toEqual([0, 0.015, 1]);
    const without = estimateSpillover(files, channels, planControls(files).specs);
    expect(without.rows[2].source).toBe("none");
    expect(without.matrix[2]).toEqual([0, 0, 1]);
  });

  it("refuses two controls for one channel, and a channel the matrix does not have", () => {
    const file = handFile("a", { A: [1, 2], B: [1, 2] });
    const spec: ControlSpec = { channel: "A", positive: { fileId: "a" }, negative: { fileId: "a" } };
    expect(() => estimateSpillover([file], ["A", "B"], [spec, spec])).toThrow(/Two controls/);
    expect(() => estimateSpillover([file], ["A", "B"], [{ ...spec, channel: "C" }])).toThrow(/not a channel/);
  });
});

describe("a calculated matrix, applied", () => {
  it("returns single-positive cells of a stained sample to the negative level in every other channel", () => {
    const controls = PANEL.map((_, fluor) => beadControl(fluor, { id: `c${fluor}`, fileName: `${PANEL[fluor]}.fcs` }));
    const estimate = estimateSpillover(controls, [...PANEL], planControls(controls).specs);
    // A sample: 40% of cells BV421+, 30% BV510+, independently. BV421 spills into BV510 at 0.25.
    const sample = syntheticControl({
      id: "sample", particle: CELLS, seed: 90, events: 20_000,
      stains: [
        { fluor: 4, fraction: 0.4, brightness: 25_000, spread: 0.4 },
        { fluor: 5, fraction: 0.3, brightness: 6000, spread: 0.4 },
      ],
    });
    const inverse = invertMatrix(estimate.matrix.map((row) => [...row]))!;
    const compensated = compensate([...sample.columns], inverse);

    // A BV510+ gate drawn at 2,500: its count is the BV510+ cells only once compensated.
    const gate = (column: ArrayLike<number>): number => {
      let count = 0;
      for (let event = 0; event < column.length; event++) if (column[event] >= 2500) count++;
      return count;
    };
    let bv510Positive = 0;
    let dimBv510 = 0;
    for (let event = 0; event < sample.eventCount; event++) {
      if (!sample.positive[1][event]) continue;
      bv510Positive++;
      if (compensated[5][event] < 2500) dimBv510++;
    }
    const measured = gate(sample.columns[5]);
    const afterCompensation = gate(compensated[5]);
    // Measured, the gate also holds the BV421+ BV510- cells whose spillover passes 2,500.
    expect(measured).toBeGreaterThan(bv510Positive + 4000);
    // Compensated, it holds the BV510+ cells that are bright enough, and a handful of others.
    expect(afterCompensation).toBeGreaterThanOrEqual(bv510Positive - dimBv510);
    expect(afterCompensation).toBeLessThanOrEqual(bv510Positive - dimBv510 + 40);
  });
});

describe("compareSpillover", () => {
  it("lists every shared off-diagonal pair, the largest difference first", () => {
    const calculated = { channels: ["A", "B", "C"], matrix: [[1, 0.1, 0.02], [0.03, 1, 0.5], [0, 0, 1]] };
    const reference = { channels: ["B", "A"], matrix: [[1, 0.01], [0.3, 1]] };
    expect(compareSpillover(calculated, reference)).toEqual([
      { source: "A", receiver: "B", calculated: 0.1, reference: 0.3, difference: 0.1 - 0.3, uncertainty: null },
      { source: "B", receiver: "A", calculated: 0.03, reference: 0.01, difference: 0.03 - 0.01, uncertainty: null },
    ]);
  });

  it("carries the standard error of an estimate's coefficients", () => {
    const files = PANEL.map((_, fluor) => beadControl(fluor, { id: `c${fluor}` }));
    const estimate = estimateSpillover(files, [...PANEL], planControls(files).specs);
    const reference = { channels: [...PANEL], matrix: TRUE_SPILLOVER };
    const differences = compareSpillover(estimate, reference);
    expect(differences).toHaveLength(30);
    for (const difference of differences) {
      expect(difference.uncertainty).toBeGreaterThan(0);
      expect(difference.uncertainty).toBeLessThan(0.003);
      // The true coefficient is within five standard errors of the estimate.
      expect(Math.abs(difference.difference)).toBeLessThan(5 * difference.uncertainty! + 1e-4);
    }
    expect(estimate.rows[0].uncertainty![0]).toBe(0);
  });
});

describe("unstained controls of other particles", () => {
  it("leaves an unnamed file of unstained cells among bead controls for the user to place", () => {
    const files = [
      ...PANEL.map((_, fluor) => beadControl(fluor, { id: `c${fluor}`, fileName: `t${fluor}.fcs` })),
      syntheticControl({ id: "cells", fileName: "t9.fcs", particle: CELLS, seed: 51 }),
    ];
    const plan = planControls(files);
    expect(plan.detection.controls[6].role).not.toBe("single-stain");
    expect(plan.controls).toHaveLength(PANEL.length);
    // Named, it is the unstained control, and the bead controls still use their own negative beads.
    files[6] = syntheticControl({ id: "cells", fileName: "unstained cells.fcs", particle: CELLS, seed: 51 });
    const named = planControls(files);
    expect(named.detection.controls[6]).toMatchObject({ role: "unstained", matchedBy: "name", particle: "cells" });
    expect(named.controls.every((control) => control.negativeSource === "internal")).toBe(true);
    expect(BEADS.scatter[0]).not.toBe(CELLS.scatter[0]);
  });
});

describe("a saturated control", () => {
  it("gives no row where most positive events are clipped at the top of the range", () => {
    const files = [
      syntheticControl({ id: "bright", stains: [{ fluor: 0, fraction: 0.5, brightness: 400_000 }], particle: BEADS, seed: 5 }),
      beadControl(1, { id: "c1" }),
    ];
    const plan = planControls(files);
    // The clipped events are one value: the boundary stays at the cut, so they are still counted.
    const split = plan.controls[0].split!;
    expect(split.bimodal).toBe(true);
    expect(split.positiveCount).toBeGreaterThan(2000);
    const estimate = estimateSpillover(files, ["FITC-A", "PE-A"], plan.specs);
    expect(estimate.rows[0]).toMatchObject({ source: "none", calculated: null, uncertainty: null });
    expect(estimate.rows[0].warnings).toContainEqual({ code: "saturated" });
    expect(estimate.rows[1].source).toBe("control");
  });
});
