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

describe("extracted-image folders beside FCS files", () => {
  it("names the tube an image folder belongs to, and pairs folders to FCS files by it", async () => {
    const { imageFolderStem, pairImageFolders } = await import("./sidecarNames");
    expect(imageFolderStem("Tube A_images_20261009_1931_27")).toBe("Tube A");
    expect(imageFolderStem("Tube A_images")).toBe("Tube A");
    expect(imageFolderStem("Tube A")).toBeNull();
    expect(imageFolderStem("notes")).toBeNull();
    const paired = pairImageFolders(["Tube A.fcs", "tube b.fcs", "Tube C.fcs"], [{ name: "Tube A_images_20261009_1931_27" }, { name: "Tube B_images_20261009_1931_33" }, { name: "Other_images_1" }]);
    expect([...paired.keys()]).toEqual(["Tube A.fcs", "tube b.fcs"]);
    expect(paired.get("tube b.fcs")?.name).toBe("Tube B_images_20261009_1931_33");
  });
});
