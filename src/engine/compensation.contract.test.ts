import { describe, expect, it } from "vitest";
import contract from "./__fixtures__/compensation_flow_contract.json";
import { compensate, invertMatrix } from "./compensation";

function eventRowsToColumns(events: number[][]): Float64Array[] {
  const channelCount = events[0]?.length ?? 0;
  return Array.from(
    { length: channelCount },
    (_, channel) => Float64Array.from(events.map((event) => event[channel])),
  );
}

function expectColumnsToMatchEvents(
  columns: ArrayLike<number>[],
  events: number[][],
  precision = 5,
): void {
  expect(columns).toHaveLength(events[0]?.length ?? 0);
  for (let event = 0; event < events.length; event++) {
    for (let channel = 0; channel < columns.length; channel++) {
      expect(columns[channel][event]).toBeCloseTo(events[event][channel], precision);
    }
  }
}

function transpose(matrix: number[][]): number[][] {
  return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

describe("conventional-flow compensation contract", () => {
  it("uses source rows, receiver columns, and measured × inverse(spillover)", () => {
    expect(contract.orientation).toBe("source-rows-receiver-columns");
    const measured = eventRowsToColumns(contract.baseline.measuredEvents);
    const inverse = invertMatrix(contract.baseline.spillover);
    expect(inverse).not.toBeNull();

    const compensated = compensate(measured, inverse!);
    expectColumnsToMatchEvents(compensated, contract.baseline.compensatedEvents);

    const transposedInverse = invertMatrix(transpose(contract.baseline.spillover));
    expect(transposedInverse).not.toBeNull();
    const incorrectlyTransposed = compensate(measured, transposedInverse!);
    expect(incorrectlyTransposed[0][0]).not.toBeCloseTo(
      contract.baseline.compensatedEvents[0][0],
      3,
    );
  });

  it("re-solves the full matrix so one edit propagates beyond its receiver", () => {
    const measured = eventRowsToColumns(contract.baseline.measuredEvents);
    const inverse = invertMatrix(contract.singleEdit.spillover);
    expect(inverse).not.toBeNull();

    const preview = compensate(measured, inverse!);
    expectColumnsToMatchEvents(preview, contract.singleEdit.expectedCompensatedEvents, 4);

    // Editing A→B changes B directly and C through B→C. A pair-only preview would miss C.
    expect(preview[1][0]).toBeCloseTo(10, 5);
    expect(preview[2][0]).toBeCloseTo(-3, 5);
  });

  it("can change the source itself when the spill matrix contains a feedback cycle", () => {
    const baseline = [
      [1, 0.2],
      [0.1, 1],
    ];
    const candidate = [
      [1, 0.1],
      [0.1, 1],
    ];
    const measured = eventRowsToColumns([[105, 70]]);

    const baselineValues = compensate(measured, invertMatrix(baseline)!);
    const candidateValues = compensate(measured, invertMatrix(candidate)!);

    expect(baselineValues[0][0]).toBeCloseTo(100, 5);
    expect(baselineValues[1][0]).toBeCloseTo(50, 5);
    expect(candidateValues[0][0]).toBeCloseTo(98.989899, 4);
    expect(candidateValues[1][0]).toBeCloseTo(60.10101, 4);
    expect(candidateValues[0][0]).not.toBeCloseTo(baselineValues[0][0], 3);
  });

  it("does not mutate measured columns or either matrix", () => {
    const measured = eventRowsToColumns(contract.baseline.measuredEvents);
    const measuredBefore = measured.map((column) => Array.from(column));
    const baselineBefore = structuredClone(contract.baseline.spillover);
    const candidateBefore = structuredClone(contract.singleEdit.spillover);

    compensate(measured, invertMatrix(contract.singleEdit.spillover)!);

    expect(measured.map((column) => Array.from(column))).toEqual(measuredBefore);
    expect(contract.baseline.spillover).toEqual(baselineBefore);
    expect(contract.singleEdit.spillover).toEqual(candidateBefore);
  });
});
