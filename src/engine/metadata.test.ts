import { describe, it, expect } from "vitest";
import { parseMetadataTable, lookupMetadataRow, distinctValues } from "./metadata";

describe("parseMetadataTable", () => {
  it("parses CSV: first column = filename key, rest = fields", () => {
    const p = parseMetadataTable("file,condition,donor\nA.fcs,stim,d1\nB.fcs,unstim,d2\n");
    expect(p.fileNameColumn).toBe("file");
    expect(p.columns).toEqual(["condition", "donor"]);
    expect(p.rowCount).toBe(2);
    expect(p.byFileName["A.fcs"]).toEqual({ condition: "stim", donor: "d1" });
    expect(p.byFileName["B.fcs"]).toEqual({ condition: "unstim", donor: "d2" });
  });

  it("auto-detects TSV", () => {
    const p = parseMetadataTable("file\tgroup\nA.fcs\tctrl\n");
    expect(p.columns).toEqual(["group"]);
    expect(p.byFileName["A.fcs"]).toEqual({ group: "ctrl" });
  });

  it("honours quoted fields containing the delimiter", () => {
    const p = parseMetadataTable('file,label\n"my, file.fcs","a, b"\n');
    expect(p.byFileName["my, file.fcs"]).toEqual({ label: "a, b" });
  });

  it("fills missing trailing cells with empty strings and skips blank lines", () => {
    const p = parseMetadataTable("file,a,b\nX.fcs,1\n\nY.fcs,2,3\n");
    expect(p.byFileName["X.fcs"]).toEqual({ a: "1", b: "" });
    expect(p.rowCount).toBe(2);
  });

  it("throws on empty or single-column input", () => {
    expect(() => parseMetadataTable("")).toThrow();
    expect(() => parseMetadataTable("file\nA.fcs\n")).toThrow();
  });
});

describe("lookupMetadataRow", () => {
  const p = parseMetadataTable("file,cond\nSample_A.fcs,stim\n");
  it("matches exactly", () => {
    expect(lookupMetadataRow(p, "Sample_A.fcs")).toEqual({ cond: "stim" });
  });
  it("matches extension-insensitively and case-insensitively", () => {
    expect(lookupMetadataRow(p, "Sample_A")).toEqual({ cond: "stim" });
    expect(lookupMetadataRow(p, "sample_a.FCS")).toEqual({ cond: "stim" });
  });
  it("returns null when nothing matches", () => {
    expect(lookupMetadataRow(p, "Other.fcs")).toBeNull();
  });
});

describe("distinctValues", () => {
  it("returns non-empty values in first-seen order", () => {
    const md = { s1: { cond: "stim" }, s2: { cond: "unstim" }, s3: { cond: "stim" }, s4: { cond: "" } };
    expect(distinctValues(md, "cond")).toEqual(["stim", "unstim"]);
  });
});
