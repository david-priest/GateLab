import { describe, expect, it } from "vitest";
import {
  compensationMatrixCellAppearance,
  percentText,
  significantNumber,
} from "./compensationUiFormat";

describe("compensation UI formatting", () => {
  it("formats scientific coefficients without inventing precision", () => {
    expect(significantNumber(0.000001, 3)).toBe("0.000001");
    expect(percentText(0.0291234)).toBe("2.91%");
  });

  it("uses white text for dark saturated red and dark text for lighter cells", () => {
    expect(compensationMatrixCellAppearance(0.2, 0.2)).toMatchObject({
      backgroundColor: expect.stringContaining("rgba(211,47,47"),
      color: "#ffffff",
    });
    expect(compensationMatrixCellAppearance(0.0001, 0.2)).toMatchObject({
      color: "#26384e",
    });
    expect(compensationMatrixCellAppearance(-0.2, 0.2)).toMatchObject({
      backgroundColor: expect.stringContaining("rgba(47,128,237"),
      color: "#26384e",
    });
  });

  it("leaves diagonal and zero cells to the base matrix styling", () => {
    expect(compensationMatrixCellAppearance(1, 1, true)).toEqual({});
    expect(compensationMatrixCellAppearance(0, 1)).toEqual({});
    expect(compensationMatrixCellAppearance(Number.NaN, 1)).toEqual({
      backgroundColor: "#ae3e3e",
      color: "#ffffff",
    });
  });
});
