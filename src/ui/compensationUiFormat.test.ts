import { describe, expect, it } from "vitest";
import {
  compensationMatrixCellAppearance,
  isMarkerNamedChannel,
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

describe("a mass-cytometry channel with a marker name", () => {
  it("is named when its name says more than its isotope", () => {
    for (const [name, pnn] of [["141Pr_CCR6", "Pr141Di"], ["103Rh_DNA", "Rh103Di"], ["CD45", "Y89Di"], ["Pr141_CCR6", "Pr141Di"], ["191Ir DNA1", "Ir191Di"]]) {
      expect(isMarkerNamedChannel(name, pnn), name).toBe(true);
    }
  });

  it("is not named when its name is empty, its $PnN, or an isotope only", () => {
    const unnamed: [string | null, string][] = [["", "Cs133Di"], [null, "Cs133Di"], ["Cs133Di", "Cs133Di"], ["131Xe", "Xe131Di"], ["140Ce", "Ce140Di"], [" 127I ", "I127Di"], ["Pb208Di", "Pb208Di"], ["120Sn_", "Sn120Di"], ["(Gd157Di)", "Gd157Di"]];
    for (const [name, pnn] of unnamed) {
      expect(isMarkerNamedChannel(name, pnn), String(name)).toBe(false);
    }
  });
});
