import { describe, expect, it } from "vitest";
import { mergeExportFiles, sanitizeFilePart } from "./fcsExport";

describe("export file naming keeps sibling populations apart", () => {
  // The real LP4 tree. Every one of these was previously "CD45RB_IgD_" or "EarlyMem_CD27_",
  // so exporting twelve populations produced eight files and four were lost without an error.
  const POPS = [
    "Scatter", "SSC Singlets", "FSC Singlets", "CD19+CD3−",
    "CD45RB+IgD+", "EarlyMem CD27+", "EarlyMem CD27−",
    "CD45RB+IgD−", "csMem CD27+", "csMem CD27−",
    "CD45RB−IgD+", "Naive",
  ];

  it("gives all twelve LP4 populations distinct names", () => {
    const names = POPS.map(sanitizeFilePart);
    expect(new Set(names).size).toBe(POPS.length);
  });

  it("keeps the signs, mapping the Unicode minus to ASCII", () => {
    expect(sanitizeFilePart("CD45RB+IgD−")).toBe("CD45RB+IgD-");
    expect(sanitizeFilePart("CD45RB−IgD+")).toBe("CD45RB-IgD+");
    expect(sanitizeFilePart("CD19+CD3−")).toBe("CD19+CD3-");
  });

  it("still removes characters a filesystem should not carry", () => {
    expect(sanitizeFilePart("a/b:c*d?e")).toBe("a_b_c_d_e");
  });

  it("never drops a file when two names still collide", () => {
    const into: Record<string, Uint8Array> = {};
    mergeExportFiles(into, { "pop.fcs": Uint8Array.from([1]) });
    mergeExportFiles(into, { "pop.fcs": Uint8Array.from([2]) });
    mergeExportFiles(into, { "pop.fcs": Uint8Array.from([3]) });
    expect(Object.keys(into).sort()).toEqual(["pop.fcs", "pop_2.fcs", "pop_3.fcs"]);
    expect([...into["pop.fcs"]]).toEqual([1]);
    expect([...into["pop_2.fcs"]]).toEqual([2]);
    expect([...into["pop_3.fcs"]]).toEqual([3]);
  });
});
