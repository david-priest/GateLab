// A matrix table whose every line ends in a delimiter, as some spreadsheets save it, reads as the
// same matrix without one.
import { describe, expect, it } from "vitest";
import { CompensationMatrixTableError, parseCompensationMatrixTable } from "./compensationMatrixImport";

const PLAIN = ",FL1-A,FL2-A\nFL1-A,1,0.2\nFL2-A,0.05,1\n";

describe("a compensation matrix table with a trailing delimiter", () => {
  it("reads a comma closing every line as no column", () => {
    const closed = parseCompensationMatrixTable(",FL1-A,FL2-A,\nFL1-A,1,0.2,\nFL2-A,0.05,1,\n");
    expect(closed.input).toEqual(parseCompensationMatrixTable(PLAIN).input);
    expect(closed.input.matrix).toEqual([[1, 0.2], [0.05, 1]]);
  });

  it("reads a tab closing every line as no column", () => {
    const closed = parseCompensationMatrixTable("\tFL1-A\tFL2-A\t\nFL1-A\t1\t0.2\t\nFL2-A\t0.05\t1\t\n");
    expect(closed.input).toEqual(parseCompensationMatrixTable(PLAIN).input);
  });

  it("still refuses a line of another width and a coefficient left empty", () => {
    expect(() => parseCompensationMatrixTable(",FL1-A,FL2-A,\nFL1-A,1,0.2\nFL2-A,0.05,1\n")).toThrow(CompensationMatrixTableError);
    expect(() => parseCompensationMatrixTable(",FL1-A,FL2-A\nFL1-A,1,\nFL2-A,0.05,1\n")).toThrow(/not a finite decimal number/);
  });
});
