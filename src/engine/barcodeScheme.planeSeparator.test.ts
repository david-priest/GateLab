// A plane declaration is split at the "x" that stands alone between its two channels, not at an
// "x" inside a channel name or inside the "(axis)" marker.
import { describe, expect, it } from "vitest";
import { parseBarcodeTable } from "./barcodeScheme";

const planes = (declaration: string) => {
  const table = parseBarcodeTable(`${declaration}\nname,89Y\nS1,1\nS2,0\n`);
  return { planes: table.planeDeclarations.map((p) => [p.x, p.y, p.xDisplay, p.yDisplay]), problems: table.problems };
};

describe("the separator of a barcode plane declaration", () => {
  it("reads the (axis) marker as it reads (display)", () => {
    expect(planes("# plane: 103Rh(axis) x 89Y")).toEqual(planes("# plane: 103Rh(display) x 89Y"));
    expect(planes("# plane: 103Rh(axis) x 89Y")).toEqual({ planes: [["103Rh", "89Y", true, false]], problems: [] });
  });

  it("keeps an x inside a channel name", () => {
    expect(planes("# plane: Xe131 x 89Y").planes).toEqual([["Xe131", "89Y", false, false]]);
    expect(planes("# plane: 89Y × Xe131").planes).toEqual([["89Y", "Xe131", false, false]]);
  });

  it("still reads the forms without spaces", () => {
    expect(planes("# plane: 195Ptx194Pt").planes).toEqual([["195Pt", "194Pt", false, false]]);
    expect(planes("# plane: 195Pt/194Pt").planes).toEqual([["195Pt", "194Pt", false, false]]);
    expect(planes("# plane: 195Pt, 194Pt").planes).toEqual([["195Pt", "194Pt", false, false]]);
  });
});
