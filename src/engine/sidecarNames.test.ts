import { describe, expect, it } from "vitest";
import { isSidecarName, pairSidecars, sidecarNameFor } from "./sidecarNames";

describe("sidecar names", () => {
  it("names the waveform file beside an FCS", () => {
    expect(sidecarNameFor("tube A.fcs")).toBe("tube A.cvw");
    expect(sidecarNameFor("tube.A.FCS")).toBe("tube.A.cvw");
    expect(sidecarNameFor("noext")).toBe("noext.cvw");
    expect(isSidecarName("x.CVW")).toBe(true);
    expect(isSidecarName("x.fcs")).toBe(false);
  });

  it("pairs each FCS with the .cvw of the same stem in the same folder", () => {
    const a = { name: "A.fcs", relativePath: "Tubes/A.fcs" };
    const aCvw = { name: "A.cvw", relativePath: "Tubes/A.cvw" };
    const b = { name: "B.fcs", relativePath: "Tubes/B.fcs" };
    const bElsewhere = { name: "B.cvw", relativePath: "Other/B.cvw" };
    const c = { name: "c.FCS", relativePath: "Tubes/c.FCS" };
    const cCvw = { name: "C.cvw", relativePath: "Tubes/C.cvw" };
    const zip = { name: "A.zip", relativePath: "Tubes/A.zip" };
    const paired = pairSidecars([a, aCvw, b, bElsewhere, c, cCvw, zip]);
    expect(paired.fcs).toEqual([a, b, c]);
    expect(paired.sidecarOf.get(a)).toBe(aCvw);
    expect(paired.sidecarOf.has(b)).toBe(false);
    expect(paired.sidecarOf.get(c)).toBe(cCvw);
  });

  it("pairs dropped files, which have no folder, by stem alone", () => {
    const a = { name: "A.fcs" };
    const aCvw = { name: "A.cvw" };
    const paired = pairSidecars([aCvw, a]);
    expect(paired.fcs).toEqual([a]);
    expect(paired.sidecarOf.get(a)).toBe(aCvw);
  });

  it("matches stems across Unicode normalisation", () => {
    const a = { name: "café.fcs" };
    const aCvw = { name: "café.cvw" };
    expect(pairSidecars([a, aCvw]).sidecarOf.get(a)).toBe(aCvw);
  });
});
