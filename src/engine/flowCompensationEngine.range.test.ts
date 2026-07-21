import { describe, expect, it } from "vitest";
import {
  FlowCompensationError,
  compensateFlowColumns,
  compensateFlowRange,
  prepareFlowCompensation,
} from "./flowCompensationEngine";

const MATRIX = [
  [1, 0.18, 0.02],
  [0.03, 1, 0.14],
  [0.01, 0.04, 1],
] as const;

const MEASURED = [
  Float64Array.from({ length: 23 }, (_, event) => 50 + event * 3.25),
  Float64Array.from({ length: 23 }, (_, event) => -7 + event * 1.75),
  Float64Array.from({ length: 23 }, (_, event) => 100 - event * 2.5),
] as const;

describe("bounded flow compensation", () => {
  it.each([1, 5, 11, 23])(
    "is bit-identical to the complete Float32 solve with %i-event chunks",
    (chunkSize) => {
      const plan = prepareFlowCompensation(MATRIX);
      const expected = compensateFlowColumns(MEASURED, plan, { output: "float32" });
      const actual = MATRIX.map(() => new Float32Array(MEASURED[0].length));

      for (let start = 0; start < MEASURED[0].length; start += chunkSize) {
        const end = Math.min(start + chunkSize, MEASURED[0].length);
        expect(compensateFlowRange(MEASURED, plan, actual, {
          inputStart: start,
          inputEnd: end,
          outputStart: start,
        })).toBe(end - start);
      }

      for (let channel = 0; channel < actual.length; channel++) {
        expect(new Uint8Array(actual[channel].buffer)).toEqual(
          new Uint8Array(expected.columns[channel].buffer),
        );
      }
    },
  );

  it("writes a measured subrange at an independent output offset", () => {
    const plan = prepareFlowCompensation(MATRIX);
    const complete = compensateFlowColumns(MEASURED, plan, { output: "float64" });
    const output = MATRIX.map(() => new Float64Array(12).fill(Number.NaN));

    compensateFlowRange(MEASURED, plan, output, {
      inputStart: 7,
      inputEnd: 12,
      outputStart: 3,
    });

    for (let channel = 0; channel < output.length; channel++) {
      expect(Array.from(output[channel].slice(0, 3))).toEqual([
        Number.NaN,
        Number.NaN,
        Number.NaN,
      ]);
      expect(Array.from(output[channel].slice(3, 8))).toEqual(
        Array.from(complete.columns[channel].slice(7, 12)),
      );
      expect(Array.from(output[channel].slice(8))).toEqual(
        Array.from({ length: 4 }, () => Number.NaN),
      );
    }
  });

  it("reports non-finite input using the original event coordinate", () => {
    const plan = prepareFlowCompensation(MATRIX);
    const measured = MEASURED.map((column) => Float64Array.from(column));
    measured[1][9] = Number.NaN;
    const output = MATRIX.map(() => new Float64Array(3));

    expect(() => compensateFlowRange(measured, plan, output, {
      inputStart: 8,
      inputEnd: 11,
      outputStart: 0,
    })).toThrow(/receiver 2, event 10/);
  });

  it("blocks a finite Float64 result that overflows installed Float32 precision", () => {
    const plan = prepareFlowCompensation([[1]]);
    const output = [new Float32Array(1)];

    try {
      compensateFlowRange([new Float64Array([Number.MAX_VALUE])], plan, output);
      throw new Error("Expected Float32 overflow to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(FlowCompensationError);
      expect((error as FlowCompensationError).code).toBe("non-finite-output");
      expect((error as Error).message).toMatch(/source 1, event 1/);
    }
  });

  it("rejects input/output and output/output buffer aliasing before any write", () => {
    const plan = prepareFlowCompensation([[1, 0.1], [0.2, 1]]);
    const measured = [
      new Float64Array([10, 20, 30]),
      new Float64Array([4, 5, 6]),
    ];
    const untouched = measured.map((column) => column.slice());

    expect(() => compensateFlowRange(measured, plan, measured)).toThrow(
      /input and output intervals must not overlap/,
    );
    expect(measured).toEqual(untouched);

    const sharedOutput = new Float64Array(3);
    expect(() => compensateFlowRange(measured, plan, [sharedOutput, sharedOutput])).toThrow(
      /output intervals must not overlap/,
    );
    expect(sharedOutput).toEqual(new Float64Array(3));

    const backing = new ArrayBuffer(8 * 8);
    const overlappingInput = new Float64Array(backing, 0, 3);
    const overlappingOutput = new Float64Array(backing, 8, 3);
    expect(() => compensateFlowRange(
      [overlappingInput, measured[1]],
      plan,
      [overlappingOutput, new Float64Array(3)],
    )).toThrow(/input and output intervals must not overlap/);
  });

  it("rejects invalid ranges, output shapes, and unsupported output arrays", () => {
    const plan = prepareFlowCompensation(MATRIX);
    const output = MATRIX.map(() => new Float64Array(MEASURED[0].length));

    expect(() => compensateFlowRange(MEASURED, plan, output, {
      inputStart: -1,
    })).toThrow(/valid contiguous/);
    expect(() => compensateFlowRange(MEASURED, plan, output, {
      inputStart: 8,
      inputEnd: 7,
    })).toThrow(/valid contiguous/);
    expect(() => compensateFlowRange(MEASURED, plan, output.slice(1))).toThrow(
      /requires 3 source columns/,
    );
    expect(() => compensateFlowRange(MEASURED, plan, [
      new Float64Array(1),
      new Float64Array(1),
      new Float64Array(1),
    ], {
      inputStart: 0,
      inputEnd: 2,
    })).toThrow(/too short/);
    expect(() => compensateFlowRange(MEASURED, plan, [
      new Int32Array(MEASURED[0].length) as unknown as Float64Array,
      output[1],
      output[2],
    ])).toThrow(/Float32Array or Float64Array/);
  });
});
