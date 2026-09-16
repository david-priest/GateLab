// A synthetic FACSChorus statistics export in the shape Chorus 5.4 writes (CRLF, a header block,
// one block per recording), compared against synthetic per-file counts. Nothing here is a real
// experiment; the real check lives in scripts/chorus-count-check.ts.

import { describe, it, expect } from "vitest";
import {
  compareChorusStatistics, isChorusStatisticsFile, parseChorusStatistics, recordingStem, splitCsvLine,
  type ChorusImportRecord, type FileCounts,
} from "./chorusStatistics";

const CSV = [
  "Experiment Name,synthetic panel",
  "Experiment Id,00000000-0000-0000-0000-000000000001",
  "User,operator",
  "Cytometer Name,FACSDiscover S8",
  "Cytometer Serial Number,0",
  "Export Date,02/01/2026 10:30:00",
  ",",
  "Recording Name,D1",
  "Recording Id,00000000-0000-0000-0000-000000000002",
  "Configuration,config.json",
  "",
  "Population,Events,Percent Parent,Percent Total,FSC-A Median,FSC-A RobustPercentCv",
  "All Events,1000,NaN,100,5,1",
  "Saturated,10,1,1,9,1",
  "Unsaturated,990,99,99,5,1",
  "Cells,800,80,80,5,1",
  "Singlets,700,87.5,70,5,1",
  "CD4_positive,300,42.857142857142854,30,5,1",
  "\"Memory, CD4\",100,33.333333333333336,10,5,1",
  "",
  "Recording Name,D2",
  "Recording Id,00000000-0000-0000-0000-000000000003",
  "Configuration,config.json",
  "",
  "Population,Events,Percent Parent,Percent Total",
  "All Events,500,NaN,100",
  "Cells,400,80,80",
  "",
].join("\r\n");

const RECORD: ChorusImportRecord = {
  experimentName: "synthetic panel",
  treeLabel: "Current gates",
  kind: "current",
  sortedAt: null,
  gates: [
    { name: "Cells", kind: "Polygon", axes: [{ name: "FSC-A", scale: "Linear" }, { name: "SSC-A", scale: "Linear" }], approximated: false },
    { name: "Singlets", kind: "Polygon", axes: [{ name: "FSC-H", scale: "Linear" }, { name: "FSC-W", scale: "Linear" }], approximated: false },
    { name: "CD4_positive", kind: "Polygon", axes: [{ name: "FITC-A", scale: "Biexponential" }, { name: "PE-A", scale: "Biexponential" }], approximated: true },
    { name: "Memory, CD4", kind: "Rectangle", axes: [{ name: "FSC-A", scale: "Linear" }, { name: "SSC-A", scale: "Linear" }], approximated: false },
  ],
};

const D1: FileCounts = {
  fileName: "D1.fcs",
  hierarchyName: "Main",
  events: 1000,
  populations: [
    { name: "Cells", depth: 1, parentName: null, events: 800, percentParent: 80 },
    { name: "Singlets", depth: 2, parentName: "Cells", events: 700, percentParent: 87.5 },
    { name: "CD4_positive", depth: 3, parentName: "Singlets", events: 306, percentParent: 43.7 },
    { name: "Memory, CD4", depth: 4, parentName: "CD4_positive", events: 98, percentParent: 32 },
    { name: "Drawn here", depth: 3, parentName: "Singlets", events: 5, percentParent: 0.7 },
  ],
};

describe("FACSChorus statistics export", () => {
  it("splits quoted fields", () => {
    expect(splitCsvLine('"Memory, CD4",100,"a ""b"" c"')).toEqual(["Memory, CD4", "100", 'a "b" c']);
  });

  it("recognises and parses the header block and every recording", () => {
    expect(isChorusStatisticsFile(CSV)).toBe(true);
    expect(isChorusStatisticsFile("Population,Events\nCells,3\n")).toBe(false);
    const stats = parseChorusStatistics(CSV);
    expect(stats.experimentName).toBe("synthetic panel");
    expect(stats.cytometer).toBe("FACSDiscover S8");
    expect(stats.exportedAt).toBe("02/01/2026 10:30:00");
    expect(stats.recordings.map((r) => r.name)).toEqual(["D1", "D2"]);
    const d1 = stats.recordings[0];
    expect(d1.populations.map((p) => p.name)).toEqual(["All Events", "Saturated", "Unsaturated", "Cells", "Singlets", "CD4_positive", "Memory, CD4"]);
    expect(d1.populations[0].percentParent).toBeNull();
    expect(d1.populations[5]).toEqual({ name: "CD4_positive", events: 300, percentParent: 42.857142857142854, percentTotal: 30 });
    expect(stats.recordings[1].populations).toHaveLength(2);
  });

  it("refuses something else", () => {
    expect(() => parseChorusStatistics("a,b\n1,2\n")).toThrow(/not a FACSChorus statistics export/);
  });

  it("matches files to recordings by stem", () => {
    expect(recordingStem("D1.fcs")).toBe("d1");
    expect(recordingStem(" D1 ")).toBe("d1");
  });

  it("pairs populations in tree order and explains each difference", () => {
    const stats = parseChorusStatistics(CSV);
    const cmp = compareChorusStatistics(stats, [D1, { fileName: "D3.fcs", hierarchyName: "Main", events: 7, populations: [] }], RECORD);
    expect(cmp.unmatchedFiles).toEqual(["D3.fcs"]);
    expect(cmp.unmatchedRecordings).toEqual(["D2"]);
    expect(cmp.recordings).toHaveLength(1);
    const r = cmp.recordings[0];
    expect(r.recordingName).toBe("D1");
    expect(r.fileEvents).toBe(1000);
    expect(r.recordingEvents).toBe(1000);
    const byName = Object.fromEntries(r.rows.map((row) => [row.name, row]));
    expect(byName["Cells"].delta).toBe(0);
    expect(byName["Cells"].reason).toEqual({ kind: "exact" });
    expect(byName["Singlets"].reason).toEqual({ kind: "exact" });
    expect(byName["CD4_positive"].delta).toBe(6);
    expect(byName["CD4_positive"].relative).toBeCloseTo(0.02, 6);
    expect(byName["CD4_positive"].reason).toEqual({ kind: "biexponential", axes: ["FITC-A", "PE-A"] });
    expect(byName["Memory, CD4"].delta).toBe(-2);
    expect(byName["Memory, CD4"].reason).toEqual({ kind: "inherited", from: "CD4_positive" });
    expect(byName["Memory, CD4"].chorusPercentParent).toBeCloseTo(33.33, 1);
    expect(byName["Drawn here"].reason).toEqual({ kind: "gatelab-only" });
    expect(byName["Drawn here"].chorusEvents).toBeNull();
    expect(byName["Saturated"].reason).toEqual({ kind: "automatic" });
    expect(byName["Unsaturated"].reason).toEqual({ kind: "automatic" });
    expect(r.rows.map((row) => row.name).slice(0, 5)).toEqual(["Cells", "Singlets", "CD4_positive", "Memory, CD4", "Drawn here"]);
    expect(r.compared).toBe(4);
    expect(r.exact).toBe(2);
    expect(r.largest).toEqual({ name: "CD4_positive", delta: 6, relative: 0.02 });
  });

  it("names a gate that moved after the tree was taken, and what sits beneath it", () => {
    const stats = parseChorusStatistics(CSV);
    const moved: ChorusImportRecord = {
      ...RECORD,
      kind: "recording",
      gates: RECORD.gates.map((g) => (g.name === "Singlets" ? { ...g, differsFromCurrent: true } : { ...g, differsFromCurrent: false })),
    };
    const cmp = compareChorusStatistics(stats, [D1], moved);
    const byName = Object.fromEntries(cmp.recordings[0].rows.map((row) => [row.name, row]));
    expect(byName["Cells"].reason).toEqual({ kind: "exact" });
    expect(byName["Singlets"].reason).toEqual({ kind: "moved" });
    expect(byName["CD4_positive"].reason).toEqual({ kind: "inherited", from: "Singlets" });
  });

  it("says nothing about axes it was not told about", () => {
    const stats = parseChorusStatistics(CSV);
    const cmp = compareChorusStatistics(stats, [D1], null);
    expect(cmp.recordings[0].rows.find((r) => r.name === "Cells")!.reason).toEqual({ kind: "unknown" });
    // A tree with populations the record does not name is unknown from that point up.
    const partial = { ...RECORD, gates: RECORD.gates.filter((g) => g.name !== "Singlets") };
    const cmp2 = compareChorusStatistics(stats, [D1], partial);
    expect(cmp2.recordings[0].rows.find((r) => r.name === "Singlets")!.reason).toEqual({ kind: "unknown" });
    expect(cmp2.recordings[0].rows.find((r) => r.name === "Memory, CD4")!.reason).toEqual({ kind: "inherited", from: "CD4_positive" });
  });

  it("pairs a qualified name with Chorus's unqualified row", () => {
    const stats = parseChorusStatistics(CSV);
    const file: FileCounts = {
      ...D1,
      populations: D1.populations.map((p) => (p.name === "CD4_positive" ? { ...p, name: "Singlets/CD4_positive" } : p)),
    };
    const cmp = compareChorusStatistics(stats, [file], null);
    expect(cmp.recordings[0].rows.find((r) => r.name === "Singlets/CD4_positive")!.chorusEvents).toBe(300);
  });

  it("flags a file that is not the recording by its event total", () => {
    const stats = parseChorusStatistics(CSV);
    const cmp = compareChorusStatistics(stats, [{ ...D1, events: 999 }], RECORD);
    expect(cmp.recordings[0].fileEvents).toBe(999);
    expect(cmp.recordings[0].recordingEvents).toBe(1000);
  });
});
