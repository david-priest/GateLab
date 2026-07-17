import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLOW_SOLVER_SETTINGS,
  FlowCompensationError,
  applyFlowMatrixEdits,
  compareFlowCompensation,
  compareFlowLeaveOneEditOut,
  compensateFlowColumns,
  explainSingleFlowEdit,
  inspectFlowMatrix,
  prepareFlowCompensation,
  solveFlowCompensation,
} from "./flowCompensationEngine";

const BASELINE = [
  [1, 0.2, 0],
  [0, 1, 0.3],
  [0, 0, 1],
] as const;
const SINGLE_EDIT = [
  [1, 0.1, 0],
  [0, 1, 0.3],
  [0, 0, 1],
] as const;
const MULTI_EDIT = [
  [1, 0.1, 0],
  [0, 1, 0.15],
  [0, 0, 1],
] as const;
const MEASURED_EVENTS = [
  [100, 20, 0],
  [0, 50, 15],
  [10, 22, 36],
] as const;
const BASELINE_EVENTS = [
  [100, 0, 0],
  [0, 50, 0],
  [10, 20, 30],
] as const;
const SINGLE_EDIT_EVENTS = [
  [100, 10, -3],
  [0, 50, 0],
  [10, 21, 29.7],
] as const;
const MULTI_EDIT_EVENTS = [
  [100, 10, -1.5],
  [0, 50, 7.5],
  [10, 21, 32.85],
] as const;

function eventRowsToColumns(events: readonly (readonly number[])[]): Float64Array[] {
  const channelCount = events[0]?.length ?? 0;
  return Array.from(
    { length: channelCount },
    (_, channel) => Float64Array.from(events.map((event) => event[channel])),
  );
}

function columnsToEventRows(columns: readonly ArrayLike<number>[]): number[][] {
  const eventCount = columns[0]?.length ?? 0;
  return Array.from(
    { length: eventCount },
    (_, event) => columns.map((column) => column[event]),
  );
}

function expectNumbersClose(
  actual: number,
  expected: number,
  absoluteTolerance = 1e-10,
  relativeTolerance = 1e-12,
): void {
  const tolerance = absoluteTolerance + relativeTolerance * Math.max(Math.abs(actual), Math.abs(expected));
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function expectColumnsCloseToEvents(
  columns: readonly ArrayLike<number>[],
  events: readonly (readonly number[])[],
): void {
  expect(columns).toHaveLength(events[0]?.length ?? 0);
  for (let event = 0; event < events.length; event++) {
    for (let channel = 0; channel < columns.length; channel++) {
      expectNumbersClose(columns[channel][event], events[event][channel]);
    }
  }
}

function forwardSpill(
  compensatedEvents: readonly (readonly number[])[],
  matrix: readonly (readonly number[])[],
): number[][] {
  return compensatedEvents.map((event) =>
    matrix[0].map((_, receiver) =>
      event.reduce(
        (total, value, source) => total + value * matrix[source][receiver],
        0,
      ),
    ),
  );
}

describe("flow matrix preparation and diagnostics", () => {
  it("prepares an immutable LU inverse with a low two-sided residual", () => {
    const input = BASELINE.map((row) => Array.from(row));
    const before = structuredClone(input);
    const plan = prepareFlowCompensation(input);

    expect(input).toEqual(before);
    expect(plan.diagnostics.stability).toBe("stable");
    expect(plan.diagnostics.conditionInfinity).toBeGreaterThanOrEqual(1);
    expect(plan.diagnostics.normalizedInverseResidual).toBeLessThan(1e-14);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.matrix)).toBe(true);
    expect(Object.isFrozen(plan.inverse[0])).toBe(true);
  });

  it("warns for an ill-conditioned but solvable matrix", () => {
    const plan = prepareFlowCompensation([
      [1, 1 - 1e-9],
      [1, 1],
    ]);
    expect(plan.diagnostics.stability).toBe("warning");
    expect(plan.diagnostics.conditionInfinity).toBeGreaterThan(1e8);
    expect(plan.diagnostics.warnings.join(" ")).toMatch(/condition number/i);
  });

  it("solves a valid flow matrix that requires an LU row pivot", () => {
    const matrix = [[1, 0.2], [2, 1]];
    const truth = [[3, -4]];
    const measured = forwardSpill(truth, matrix);
    const result = solveFlowCompensation(eventRowsToColumns(measured), matrix);
    expectColumnsCloseToEvents(result.columns, truth);
    expect(result.factorization.diagnostics.stability).toBe("stable");
  });

  it("blocks singular, unsafe, non-finite, and malformed matrices", () => {
    const cases: readonly (readonly (readonly number[])[])[] = [
      [[1, 2], [2, 4]],
      [[1, 1 - 1e-13], [1, 1]],
      [[1, Number.NaN], [0, 1]],
      [[1, 0], [0]],
      [],
    ];
    for (const matrix of cases) {
      expect(() => prepareFlowCompensation(matrix)).toThrow(FlowCompensationError);
    }
  });

  it("exposes diagnostics but never a solve plan for an unstable matrix", () => {
    const matrix = [[1, 1 - 2e-10], [1, 1]];
    const settings = {
      singularTolerance: 1e-10,
      conditionWarningThreshold: 1e8,
    };
    expect(inspectFlowMatrix(matrix, settings).stability).toBe("unstable");
    try {
      prepareFlowCompensation(matrix, settings);
      throw new Error("Expected unstable preparation to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(FlowCompensationError);
      expect((error as FlowCompensationError).code).toBe("unstable-matrix");
    }
    expect(() => solveFlowCompensation(
      eventRowsToColumns([[1, 2]]),
      matrix,
      settings,
    )).toThrow(/too ill-conditioned/);
  });

  it("rejects inconsistent scientific thresholds", () => {
    expect(() => prepareFlowCompensation([[1]], {
      singularTolerance: 1e-6,
      conditionWarningThreshold: 1e7,
    })).toThrow(/conditionWarningThreshold/);
  });
});

describe("exact complete-matrix flow solving", () => {
  it("matches the analytic source-row/receiver-column chain", () => {
    const result = solveFlowCompensation(
      eventRowsToColumns(MEASURED_EVENTS),
      BASELINE,
      DEFAULT_FLOW_SOLVER_SETTINGS,
      { computeReconstructionResidual: true },
    );
    expectColumnsCloseToEvents(result.columns, BASELINE_EVENTS);
    expect(result.columns.every((column) => column instanceof Float64Array)).toBe(true);
    expect(result.reconstruction?.relativeBackwardError).toBeLessThan(1e-14);
  });

  it("preserves signed compensated values and casts only the requested output", () => {
    const matrix = [[1, 0.25], [0.1, 1]];
    const measured = eventRowsToColumns([[5, 100], [-20, 5], [50, 5]]);
    const expected = [
      [-200 / 39, 3950 / 39],
      [-820 / 39, 400 / 39],
      [660 / 13, -100 / 13],
    ];
    const plan = prepareFlowCompensation(matrix);
    const preview = compensateFlowColumns(measured, plan, { output: "float64" });
    const applied = compensateFlowColumns(measured, plan, {
      output: "float32",
      computeReconstructionResidual: true,
    });

    expectColumnsCloseToEvents(preview.columns, expected);
    expect(applied.columns.every((column) => column instanceof Float32Array)).toBe(true);
    expect(preview.columns[0][0]).toBeLessThan(0);
    expect(preview.columns[1][2]).toBeLessThan(0);
    expect(applied.reconstruction?.maximumAbsoluteResidual).toBeCloseTo(
      8.583068833445395e-7,
      15,
    );
    expect(applied.reconstruction?.residualInfinityNorm).toBeCloseTo(
      1.0490417494679605e-6,
      15,
    );
    expect(applied.reconstruction?.measuredInfinityNorm).toBe(105);
    expect(applied.reconstruction?.compensatedInfinityNorm).toBeCloseTo(
      106.41025638580322,
      12,
    );
    expect(applied.reconstruction?.relativeBackwardError).toBeCloseTo(
      4.407501021761876e-9,
      15,
    );
  });

  it("solves multiple edits together from immutable measured values", () => {
    const measured = eventRowsToColumns(MEASURED_EVENTS);
    const measuredBefore = measured.map((column) => Array.from(column));
    const baselineBefore = structuredClone(BASELINE);
    const candidate = applyFlowMatrixEdits(BASELINE, [
      { sourceIndex: 0, receiverIndex: 1, value: 0.1 },
      { sourceIndex: 1, receiverIndex: 2, value: 0.15 },
    ]);
    const reversed = applyFlowMatrixEdits(BASELINE, [
      { sourceIndex: 1, receiverIndex: 2, value: 0.15 },
      { sourceIndex: 0, receiverIndex: 1, value: 0.1 },
    ]);

    const first = solveFlowCompensation(measured, candidate);
    const second = solveFlowCompensation(measured, reversed);
    expect(candidate).toEqual(MULTI_EDIT);
    expectColumnsCloseToEvents(first.columns, MULTI_EDIT_EVENTS);
    expect(columnsToEventRows(second.columns)).toEqual(columnsToEventRows(first.columns));
    expect(measured.map((column) => Array.from(column))).toEqual(measuredBefore);
    expect(BASELINE).toEqual(baselineBefore);
  });

  it("rejects duplicate edits, dimension mismatches, and non-finite measured data", () => {
    expect(() => applyFlowMatrixEdits(BASELINE, [
      { sourceIndex: 0, receiverIndex: 1, value: 0.1 },
      { sourceIndex: 0, receiverIndex: 1, value: 0.12 },
    ])).toThrow(/more than once/);
    expect(() => solveFlowCompensation([new Float64Array([1])], BASELINE)).toThrow(
      /requires 3 measured receiver columns/,
    );
    expect(() => solveFlowCompensation([
      new Float64Array([1]),
      new Float64Array([Number.NaN]),
      new Float64Array([1]),
    ], BASELINE)).toThrow(/must be finite/);
  });

  it("recovers deterministic signed truth across dimensions and scales", () => {
    let state = 0x5eed1234;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x1_0000_0000;
    };

    for (let caseIndex = 0; caseIndex < 24; caseIndex++) {
      const size = 2 + (caseIndex % 11);
      const matrix = Array.from({ length: size }, (_, source) =>
        Array.from({ length: size }, (_, receiver) =>
          source === receiver ? 1 : random() * (0.08 / (size - 1)),
        ),
      );
      const truth = Array.from({ length: 7 }, (_, event) =>
        Array.from({ length: size }, (_, channel) => {
          const sign = random() < 0.35 ? -1 : 1;
          const exponent = -3 + random() * 9;
          return sign * (1 + event * 0.01 + channel * 0.001) * 10 ** exponent;
        }),
      );
      const measured = forwardSpill(truth, matrix);
      const solved = solveFlowCompensation(
        eventRowsToColumns(measured),
        matrix,
        DEFAULT_FLOW_SOLVER_SETTINGS,
        { computeReconstructionResidual: true },
      );
      for (let event = 0; event < truth.length; event++) {
        for (let channel = 0; channel < size; channel++) {
          expectNumbersClose(solved.columns[channel][event], truth[event][channel], 1e-8, 5e-12);
        }
      }
      expect(solved.reconstruction?.relativeBackwardError).toBeLessThan(1e-13);
    }
  });
});

describe("exact candidate deltas and impact summaries", () => {
  it("reports complete downstream propagation, ranking, crossings, and residuals", () => {
    const comparison = compareFlowCompensation(
      eventRowsToColumns(MEASURED_EVENTS),
      BASELINE,
      SINGLE_EDIT,
      { sourceChannels: ["A", "B", "C"] },
    );
    expectColumnsCloseToEvents(comparison.candidate.columns, SINGLE_EDIT_EVENTS);
    expectColumnsCloseToEvents(comparison.deltas, [
      [0, 10, -3],
      [0, 0, 0],
      [0, 1, -0.3],
    ]);
    expect(comparison.impactRanking.map(({ channel }) => channel)).toEqual(["B", "C", "A"]);
    expect(comparison.impacts[1].medianAbsoluteDelta).toBeCloseTo(1, 12);
    expect(comparison.impacts[1].upperTailAbsoluteDelta).toBeCloseTo(9.1, 12);
    expect(comparison.impacts[1].fractionChanged).toBeCloseTo(2 / 3, 12);
    expect(comparison.impacts[2].nonNegativeToNegativeCount).toBe(1);
    expect(comparison.impacts[2].signCrossingCount).toBe(1);
    expect(comparison.current.reconstruction?.relativeBackwardError).toBeLessThan(1e-14);
    expect(comparison.candidate.reconstruction?.relativeBackwardError).toBeLessThan(1e-14);
  });

  it("returns exact zero deltas for no change and after an undo", () => {
    const measured = eventRowsToColumns(MEASURED_EVENTS);
    const unchanged = compareFlowCompensation(measured, BASELINE, BASELINE);
    const undone = compareFlowCompensation(
      measured,
      BASELINE,
      applyFlowMatrixEdits(SINGLE_EDIT, [
        { sourceIndex: 0, receiverIndex: 1, value: 0.2 },
      ]),
    );
    for (const comparison of [unchanged, undone]) {
      expect(columnsToEventRows(comparison.current.columns)).toEqual(
        columnsToEventRows(comparison.candidate.columns),
      );
      expect(comparison.deltas.every((column) =>
        Array.from(column).every((value) => value === 0)
      )).toBe(true);
    }
  });

  it("does not report a sign crossing for a change below the impact tolerance", () => {
    const measured = eventRowsToColumns([
      [1e-9, 1.5e-15],
      [1, 2e-6],
    ]);
    const comparison = compareFlowCompensation(
      measured,
      [[1, 0], [0, 1]],
      [[1, 3e-6], [0, 1]],
      {
        absoluteDifferenceTolerance: 1e-12,
        relativeDifferenceTolerance: 0,
        signZeroTolerance: 0,
      },
    );
    const receiverImpact = comparison.impacts[1];
    expect(receiverImpact.changedCount).toBe(1);
    expect(receiverImpact.nonNegativeToNegativeCount).toBe(1);
    expect(receiverImpact.signCrossingCount).toBe(1);
    expect(receiverImpact.signCrossingCount).toBeLessThanOrEqual(receiverImpact.changedCount);
  });

  it("explicitly disproves SpillQC's pair-only preview on a coupled chain", () => {
    const exact = compareFlowCompensation(
      eventRowsToColumns(MEASURED_EVENTS),
      BASELINE,
      SINGLE_EDIT,
    );
    const currentRows = columnsToEventRows(exact.current.columns);
    const pairOnly = currentRows.map((event) => {
      const copy = Array.from(event);
      copy[1] += (0.2 - 0.1) * event[0];
      return copy;
    });

    // The focal B change happens to agree, but the approximation leaves downstream C untouched.
    expect(pairOnly.map((event) => event[1])).toEqual(
      columnsToEventRows(exact.candidate.columns).map((event) => event[1]),
    );
    expect(pairOnly.map((event) => event[2])).not.toEqual(
      columnsToEventRows(exact.candidate.columns).map((event) => event[2]),
    );
    expect(exact.candidate.columns[2][0]).toBeCloseTo(-3, 12);
  });
});

describe("Sherman-Morrison explanation path", () => {
  it("equals a complete solve for the chain while exposing downstream coupling", () => {
    const measured = eventRowsToColumns(MEASURED_EVENTS);
    const sensitivity = explainSingleFlowEdit(measured, BASELINE, {
      sourceIndex: 0,
      receiverIndex: 1,
      value: 0.1,
    });
    expect(sensitivity.ok).toBe(true);
    if (!sensitivity.ok) return;
    const full = solveFlowCompensation(measured, SINGLE_EDIT);
    expect(sensitivity.denominator).toBeCloseTo(1, 15);
    expectColumnsCloseToEvents(sensitivity.candidateColumns, SINGLE_EDIT_EVENTS);
    for (let channel = 0; channel < full.columns.length; channel++) {
      for (let event = 0; event < full.eventCount; event++) {
        expectNumbersClose(
          sensitivity.candidateColumns[channel][event],
          full.columns[channel][event],
        );
      }
    }
    for (let row = 0; row < SINGLE_EDIT.length; row++) {
      for (let column = 0; column < SINGLE_EDIT.length; column++) {
        expectNumbersClose(
          sensitivity.candidateInverse[row][column],
          full.factorization.inverse[row][column],
        );
      }
    }
  });

  it("uses the correct source/receiver indices for a feedback cycle", () => {
    const baseline = [[1, 0.2], [0.1, 1]];
    const candidate = [[1, 0.1], [0.1, 1]];
    const measured = eventRowsToColumns([[105, 70]]);
    const sensitivity = explainSingleFlowEdit(measured, baseline, {
      sourceIndex: 0,
      receiverIndex: 1,
      value: 0.1,
    });
    expect(sensitivity.ok).toBe(true);
    if (!sensitivity.ok) return;
    expect(sensitivity.denominator).toBeCloseTo(99 / 98, 12);
    expectColumnsCloseToEvents(sensitivity.candidateColumns, [[9800 / 99, 5950 / 99]]);
    expectColumnsCloseToEvents(solveFlowCompensation(measured, candidate).columns, [
      [9800 / 99, 5950 / 99],
    ]);
  });

  it("returns the exact baseline for a zero edit", () => {
    const sensitivity = explainSingleFlowEdit(
      eventRowsToColumns(MEASURED_EVENTS),
      BASELINE,
      { sourceIndex: 0, receiverIndex: 1, value: 0.2 },
    );
    expect(sensitivity.ok).toBe(true);
    if (!sensitivity.ok) return;
    expect(sensitivity.delta).toBe(0);
    expect(sensitivity.denominator).toBe(1);
    expect(columnsToEventRows(sensitivity.candidateColumns)).toEqual(
      columnsToEventRows(sensitivity.current.columns),
    );
  });

  it("blocks a singular denominator and a warning-condition candidate", () => {
    const measured = eventRowsToColumns([[2, 3]]);
    const singular = explainSingleFlowEdit(measured, [[1, 0.1], [1, 1]], {
      sourceIndex: 0,
      receiverIndex: 1,
      value: 1,
    });
    expect(singular.ok).toBe(false);
    if (!singular.ok) expect(singular.reason).toBe("denominator-too-small");

    const warning = explainSingleFlowEdit(measured, [[1, 0.1], [1, 1]], {
      sourceIndex: 0,
      receiverIndex: 1,
      value: 0.9999999999,
    });
    expect(warning.ok).toBe(false);
    if (!warning.ok) {
      expect(warning.reason).toBe("candidate-unstable");
      expect(warning.candidateDiagnostics?.stability).toBe("warning");
    }
  });

  it("matches complete solves across deterministic safe random single edits", () => {
    let state = 0xc0ffee12;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x1_0000_0000;
    };

    for (let caseIndex = 0; caseIndex < 20; caseIndex++) {
      const size = 2 + (caseIndex % 7);
      const baseline = Array.from({ length: size }, (_, source) =>
        Array.from({ length: size }, (_, receiver) =>
          source === receiver ? 1 : random() * (0.06 / (size - 1)),
        ),
      );
      const sourceIndex = caseIndex % size;
      let receiverIndex = (caseIndex * 3 + 1) % size;
      if (receiverIndex === sourceIndex) receiverIndex = (receiverIndex + 1) % size;
      const value = baseline[sourceIndex][receiverIndex] + (random() - 0.5) * 0.02;
      const candidate = applyFlowMatrixEdits(baseline, [
        { sourceIndex, receiverIndex, value },
      ]);
      const truth = Array.from({ length: 9 }, () =>
        Array.from({ length: size }, () => (random() - 0.35) * 1e4),
      );
      const measured = eventRowsToColumns(forwardSpill(truth, baseline));
      const sensitivity = explainSingleFlowEdit(measured, baseline, {
        sourceIndex,
        receiverIndex,
        value,
      });
      expect(sensitivity.ok).toBe(true);
      if (!sensitivity.ok) continue;
      const full = solveFlowCompensation(measured, candidate);
      for (let channel = 0; channel < size; channel++) {
        for (let event = 0; event < truth.length; event++) {
          expectNumbersClose(
            sensitivity.candidateColumns[channel][event],
            full.columns[channel][event],
            1e-8,
            1e-11,
          );
        }
      }
    }
  });
});

describe("leave-one-edit-out marginal effects", () => {
  it("re-solves both sides from measured data and keeps coupled marginals non-additive", () => {
    const measured = eventRowsToColumns(MEASURED_EVENTS);
    const firstGivenSecond = compareFlowLeaveOneEditOut(
      measured,
      BASELINE,
      MULTI_EDIT,
      { sourceIndex: 0, receiverIndex: 1 },
    );
    const secondGivenFirst = compareFlowLeaveOneEditOut(
      measured,
      BASELINE,
      MULTI_EDIT,
      { sourceIndex: 1, receiverIndex: 2 },
    );
    expectColumnsCloseToEvents(firstGivenSecond.deltas, [
      [0, 10, -1.5],
      [0, 0, 0],
      [0, 1, -0.15],
    ]);
    expectColumnsCloseToEvents(secondGivenFirst.deltas, [
      [0, 0, 1.5],
      [0, 0, 7.5],
      [0, 0, 3.15],
    ]);

    const total = compareFlowCompensation(measured, BASELINE, MULTI_EDIT);
    let foundInteraction = false;
    for (let channel = 0; channel < total.deltas.length; channel++) {
      for (let event = 0; event < total.current.eventCount; event++) {
        const marginalSum =
          firstGivenSecond.deltas[channel][event] +
          secondGivenFirst.deltas[channel][event];
        if (Math.abs(marginalSum - total.deltas[channel][event]) > 1e-12) {
          foundInteraction = true;
        }
      }
    }
    expect(foundInteraction).toBe(true);
  });

  it("a single edit's marginal equals its total exact delta", () => {
    const measured = eventRowsToColumns(MEASURED_EVENTS);
    const marginal = compareFlowLeaveOneEditOut(
      measured,
      BASELINE,
      SINGLE_EDIT,
      { sourceIndex: 0, receiverIndex: 1 },
    );
    const total = compareFlowCompensation(measured, BASELINE, SINGLE_EDIT);
    expect(columnsToEventRows(marginal.deltas)).toEqual(columnsToEventRows(total.deltas));
  });

  it("rejects a cell that is not actually part of the pending candidate", () => {
    expect(() => compareFlowLeaveOneEditOut(
      eventRowsToColumns(MEASURED_EVENTS),
      BASELINE,
      SINGLE_EDIT,
      { sourceIndex: 1, receiverIndex: 2 },
    )).toThrow(/differs from the baseline/);
  });
});
