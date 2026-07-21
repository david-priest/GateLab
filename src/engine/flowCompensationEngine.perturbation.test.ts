import { describe, expect, it } from "vitest";
import oracle from "./__fixtures__/flowcore_compensation_oracle.json";
import {
  applyFlowMatrixEdits,
  compareFlowCompensation,
  solveFlowCompensation,
} from "./flowCompensationEngine";

function oracleCase(name: string) {
  const fixture = oracle.cases.find((candidate) => candidate.name === name);
  if (!fixture) throw new Error(`Missing committed flowCore oracle case: ${name}`);
  return fixture;
}

function eventRowsToColumns(events: readonly (readonly number[])[]): Float64Array[] {
  const channelCount = events[0]?.length ?? 0;
  return Array.from(
    { length: channelCount },
    (_, channel) => Float64Array.from(events.map((event) => event[channel])),
  );
}

function expectClose(actual: number, expected: number): void {
  const tolerance = 1e-9 + 2e-12 * Math.max(Math.abs(actual), Math.abs(expected));
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function expectColumnsMatchEvents(
  columns: readonly ArrayLike<number>[],
  events: readonly (readonly number[])[],
): void {
  expect(columns).toHaveLength(events[0]?.length ?? 0);
  for (let event = 0; event < events.length; event++) {
    for (let channel = 0; channel < columns.length; channel++) {
      expectClose(columns[channel][event], events[event][channel]);
    }
  }
}

function respill(
  compensatedColumns: readonly ArrayLike<number>[],
  matrix: readonly (readonly number[])[],
): number[][] {
  const eventCount = compensatedColumns[0]?.length ?? 0;
  return Array.from({ length: eventCount }, (_, event) =>
    matrix.map((_, receiver) =>
      matrix.reduce(
        (total, sourceRow, source) =>
          total + compensatedColumns[source][event] * sourceRow[receiver],
        0,
      ),
    ),
  );
}

function addUncoupledChannel(
  matrix: readonly (readonly number[])[],
): number[][] {
  return [
    ...matrix.map((row) => [...row, 0]),
    [...matrix.map(() => 0), 1],
  ];
}

describe("scientific flow-compensation coefficient perturbations", () => {
  it("moves the directly affected channel in the expected direction while preserving an uncoupled channel", () => {
    const fixture = oracleCase("three-channel chain single edit");
    const matrix = addUncoupledChannel(fixture.currentMatrix);
    const extraValues = [7, -11, 42];
    const measuredEvents = fixture.measuredEvents.map((event, index) => [
      ...event,
      extraValues[index],
    ]);
    const measured = eventRowsToColumns(measuredEvents);
    const coefficientSweep = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3];
    let previousDirectValue = Number.POSITIVE_INFINITY;

    for (const coefficient of coefficientSweep) {
      const candidateMatrix = applyFlowMatrixEdits(matrix, [
        { sourceIndex: 0, receiverIndex: 1, value: coefficient },
      ]);
      const comparison = compareFlowCompensation(measured, matrix, candidateMatrix, {
        sourceChannels: ["A", "B", "C", "unrelated"],
      });

      // For this source A -> receiver B coefficient, A is unchanged and the inferred B signal
      // is measured_B - coefficient * A. Increasing the coefficient must therefore lower B.
      const expectedB = measuredEvents[0][1] - coefficient * measuredEvents[0][0];
      expectClose(comparison.candidate.columns[1][0], expectedB);
      expect(comparison.candidate.columns[1][0]).toBeLessThan(previousDirectValue);
      previousDirectValue = comparison.candidate.columns[1][0];

      // A is the source driving the edit. The fourth channel is deliberately block-diagonal and
      // must remain bit-for-bit unaffected by edits elsewhere in the matrix.
      expect(Array.from(comparison.deltas[0])).toEqual([0, 0, 0]);
      expect(Array.from(comparison.deltas[3])).toEqual([0, 0, 0]);
      expect(Array.from(comparison.candidate.columns[3])).toEqual(extraValues);
      expect(comparison.impacts[3].changedCount).toBe(0);

      expect(comparison.candidate.reconstruction?.relativeBackwardError).toBeLessThan(1e-14);
      const reconstructed = respill(comparison.candidate.columns, candidateMatrix);
      for (let event = 0; event < measuredEvents.length; event++) {
        for (let receiver = 0; receiver < measuredEvents[event].length; receiver++) {
          expectClose(reconstructed[event][receiver], measuredEvents[event][receiver]);
        }
      }
    }
  });

  it("captures downstream propagation and both direct and downstream overcompensation crossings", () => {
    const fixture = oracleCase("three-channel chain single edit");
    const measured = eventRowsToColumns(fixture.measuredEvents);

    const lowerDirectCoefficient = compareFlowCompensation(
      measured,
      fixture.currentMatrix,
      fixture.candidateMatrix,
      { sourceChannels: fixture.channels },
    );
    // Lowering A -> B from 0.20 to 0.10 leaves A fixed and adds 10 units to B for event 1.
    // Since B still spills into C at 0.30, the exact complete solve propagates -3 into C.
    expectClose(lowerDirectCoefficient.deltas[0][0], 0);
    expectClose(lowerDirectCoefficient.deltas[1][0], 10);
    expectClose(lowerDirectCoefficient.deltas[2][0], -3);
    expectClose(
      lowerDirectCoefficient.deltas[2][0],
      -fixture.currentMatrix[1][2] * lowerDirectCoefficient.deltas[1][0],
    );
    expect(lowerDirectCoefficient.current.columns[2][0]).toBeGreaterThanOrEqual(0);
    expect(lowerDirectCoefficient.candidate.columns[2][0]).toBeLessThan(0);
    expect(lowerDirectCoefficient.impacts[2].nonNegativeToNegativeCount).toBe(1);

    const excessiveDirectCoefficient = applyFlowMatrixEdits(fixture.currentMatrix, [
      { sourceIndex: 0, receiverIndex: 1, value: 0.25 },
    ]);
    const overcompensated = compareFlowCompensation(
      measured,
      fixture.currentMatrix,
      excessiveDirectCoefficient,
      { sourceChannels: fixture.channels },
    );
    // Event 1 has measured A=100 and B=20. A coefficient of 0.25 subtracts 25 from B,
    // driving the directly affected compensated value from zero to -5.
    expectClose(overcompensated.current.columns[1][0], 0);
    expectClose(overcompensated.candidate.columns[1][0], -5);
    expect(overcompensated.impacts[1].nonNegativeToNegativeCount).toBe(1);
    expect(overcompensated.candidate.reconstruction?.relativeBackwardError).toBeLessThan(1e-14);
  });

  it("matches flowCore after simultaneous edits and reconstructs measured events only with the full candidate matrix", () => {
    const fixture = oracleCase("three-channel chain two simultaneous edits");
    const measured = eventRowsToColumns(fixture.measuredEvents);
    const comparison = compareFlowCompensation(
      measured,
      fixture.currentMatrix,
      fixture.candidateMatrix,
      { sourceChannels: fixture.channels },
    );

    expectColumnsMatchEvents(comparison.current.columns, fixture.currentCompensatedEvents);
    expectColumnsMatchEvents(comparison.candidate.columns, fixture.candidateCompensatedEvents);
    expect(comparison.current.reconstruction?.relativeBackwardError).toBeLessThan(1e-14);
    expect(comparison.candidate.reconstruction?.relativeBackwardError).toBeLessThan(1e-14);
    expectColumnsMatchEvents(
      eventRowsToColumns(respill(comparison.candidate.columns, fixture.candidateMatrix)),
      fixture.measuredEvents,
    );

    // The two coefficient effects interact through the A -> B -> C path. The exact joint
    // candidate is therefore not the baseline plus two independently calculated deltas.
    const firstOnly = solveFlowCompensation(
      measured,
      applyFlowMatrixEdits(fixture.currentMatrix, [
        { sourceIndex: 0, receiverIndex: 1, value: fixture.candidateMatrix[0][1] },
      ]),
    );
    const secondOnly = solveFlowCompensation(
      measured,
      applyFlowMatrixEdits(fixture.currentMatrix, [
        { sourceIndex: 1, receiverIndex: 2, value: fixture.candidateMatrix[1][2] },
      ]),
    );
    const event = 2;
    const baselineC = comparison.current.columns[2][event];
    const independentlyAddedC =
      baselineC +
      (firstOnly.columns[2][event] - baselineC) +
      (secondOnly.columns[2][event] - baselineC);
    expectClose(comparison.candidate.columns[2][event], 32.85);
    expectClose(independentlyAddedC, 32.7);
    expect(comparison.candidate.columns[2][event]).not.toBeCloseTo(independentlyAddedC, 12);
  });
});
