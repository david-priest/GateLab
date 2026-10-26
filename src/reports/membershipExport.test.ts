import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { gatedTree, members, ROOT_ID, type PopulationSpec } from "./__fixtures__/gatedTree";
import {
  escapePathSegment,
  exportMemberships,
  joinPopulationPath,
  membershipCsv,
  membershipTable,
  parentPopulationPath,
  parseMembershipCsv,
  populationKeys,
  splitPopulationPath,
} from "./membershipExport";

// x = 0..19; y = 0 on even events, 10 on odd ones.
const TREE: PopulationSpec[] = [
  { id: "lym", name: "Lymphocytes", parent: null, x: [0, 15] },
  { id: "cd4", name: "CD4_positive", parent: "lym", x: [0, 7] },
  { id: "naive", name: "Naive", parent: "cd4", x: [0, 19], y: [0, 0] },
  { id: "dbl", name: "CD4/CD8 double", parent: "lym", x: [6, 11] },
  { id: "odd", name: "odd\\name", parent: null, x: [18, 19] },
  { id: "comma", name: "treated, B1", parent: null, x: [16, 17] },
];

const PATHS = [
  "Lymphocytes",
  "Lymphocytes/CD4_positive",
  "Lymphocytes/CD4_positive/Naive",
  "Lymphocytes/CD4\\/CD8 double",
  "odd\\\\name",
  "treated, B1",
];

describe("population paths", () => {
  it("escapes '/' and '\\' in a name and splits a path back into its names", () => {
    expect(escapePathSegment("CD4/CD8")).toBe("CD4\\/CD8");
    expect(escapePathSegment("a\\b")).toBe("a\\\\b");
    const names = ["Lymphocytes", "CD4/CD8 double", "a\\b", "x\\/y"];
    const path = joinPopulationPath(names);
    expect(path).toBe("Lymphocytes/CD4\\/CD8 double/a\\\\b/x\\\\\\/y");
    expect(splitPopulationPath(path)).toEqual(names);
    expect(parentPopulationPath(path)).toBe("Lymphocytes/CD4\\/CD8 double/a\\\\b");
    expect(parentPopulationPath("Lymphocytes")).toBeNull();
    expect(() => splitPopulationPath("Lymphocytes\\")).toThrow(/unfinished escape/);
  });

  it("keys every population below the root by its path, in tree order", () => {
    const gating = gatedTree(TREE);
    const keys = populationKeys(gating.populations, ROOT_ID);
    expect(keys.map((key) => [key.populationId, key.path, key.parentPath, key.depth])).toEqual([
      ["lym", PATHS[0], null, 1],
      ["cd4", PATHS[1], "Lymphocytes", 2],
      ["naive", PATHS[2], "Lymphocytes/CD4_positive", 3],
      ["dbl", PATHS[3], "Lymphocytes", 2],
      ["odd", PATHS[4], null, 1],
      ["comma", PATHS[5], null, 1],
    ]);
  });

  it("writes a second population of one name under one parent as 'name (2)', and its children under that", () => {
    const gating = gatedTree([
      { id: "lym", name: "Lymphocytes", parent: null, x: [0, 15] },
      { id: "a", name: "CD4_positive", parent: "lym", x: [0, 7] },
      { id: "b", name: "CD4_positive", parent: "lym", x: [3, 9] },
      { id: "c", name: "Live", parent: "b", x: [3, 5] },
    ]);
    const keys = populationKeys(gating.populations, ROOT_ID);
    expect(keys.map((k) => [k.populationId, k.path, k.renamedFrom])).toEqual([
      ["lym", "Lymphocytes", undefined],
      ["a", "Lymphocytes/CD4_positive", undefined],
      ["b", "Lymphocytes/CD4_positive (2)", "CD4_positive"],
      ["c", "Lymphocytes/CD4_positive (2)/Live", undefined],
    ]);
    // Each column still holds its own population's events: 8 (0..7) and 7 (3..9).
    const table = membershipTable(gating);
    expect(table.masks.get("Lymphocytes/CD4_positive")!.reduce((s, v) => s + v, 0)).toBe(8);
    expect(table.masks.get("Lymphocytes/CD4_positive (2)")!.reduce((s, v) => s + v, 0)).toBe(7);
  });
});

describe("membership CSV", () => {
  it("writes the header of paths and one 0/1 row per event, 0-based", () => {
    const { csv } = exportMemberships(gatedTree(TREE), { fileName: "D1.fcs" });
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      'event_index,Lymphocytes,Lymphocytes/CD4_positive,Lymphocytes/CD4_positive/Naive,Lymphocytes/CD4\\/CD8 double,odd\\\\name,"treated, B1"',
    );
    expect(lines[1]).toBe("0,1,1,1,0,0,0");
    expect(lines[2]).toBe("1,1,1,0,0,0,0");
    expect(lines[7]).toBe("6,1,1,1,1,0,0");
    expect(lines[17]).toBe("16,0,0,0,0,0,1");
    expect(lines[20]).toBe("19,0,0,0,0,1,0");
    expect(lines).toHaveLength(22); // header, 20 events, and the empty string after the final "\n"
    expect(lines[21]).toBe("");
  });

  it("round-trips drawn gates to identical masks and exact counts", () => {
    const gating = gatedTree(TREE);
    const { csv, manifest, table } = exportMemberships(gating, {
      fileName: "D1.fcs",
      keywords: { $FIL: " D1_original.fcs ", $TOT: "20" },
    });
    const back = parseMembershipCsv(csv);
    expect(back.totalEvents).toBe(20);
    expect(back.paths).toEqual(PATHS);
    for (const path of PATHS) expect(back.masks.get(path)).toEqual(table.masks.get(path));

    // The events each drawn gate holds, known from the synthetic values.
    expect(members(back.masks.get(PATHS[0])!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(members(back.masks.get(PATHS[1])!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(members(back.masks.get(PATHS[2])!)).toEqual([0, 2, 4, 6]);
    expect(members(back.masks.get(PATHS[3])!)).toEqual([6, 7, 8, 9, 10, 11]);
    expect(members(back.masks.get(PATHS[4])!)).toEqual([18, 19]);
    expect(members(back.masks.get(PATHS[5])!)).toEqual([16, 17]);

    expect(manifest).toEqual({
      format: "gatelab-membership-csv",
      formatVersion: 1,
      fileName: "D1.fcs",
      fil: "D1_original.fcs",
      totalEvents: 20,
      eventIndexBase: 0,
      rootPopulationId: ROOT_ID,
      rootName: "All events",
      populations: [
        { populationId: "lym", path: PATHS[0], events: 16 },
        { populationId: "cd4", path: PATHS[1], events: 8 },
        { populationId: "naive", path: PATHS[2], events: 4 },
        { populationId: "dbl", path: PATHS[3], events: 6 },
        { populationId: "odd", path: PATHS[4], events: 2 },
        { populationId: "comma", path: PATHS[5], events: 2 },
      ],
      gatelabVersion: pkg.version,
    });
    // The engine's own counts agree with the exported ones.
    for (const entry of manifest.populations) {
      expect(gating.populations[entry.populationId].event_count).toBe(entry.events);
    }
    // Writing the read-back table gives the same text.
    expect(membershipCsv(back)).toBe(csv);
  });

  it("leaves $FIL null when there is none, and lets the caller state the version", () => {
    const { manifest } = exportMemberships(gatedTree(TREE), { fileName: "D2.fcs" }, { gatelabVersion: null });
    expect(manifest.fil).toBeNull();
    expect(manifest.gatelabVersion).toBeNull();
  });

  it("reads CRLF line endings and a byte-order mark", () => {
    const { csv, table } = exportMemberships(gatedTree(TREE), { fileName: "D1.fcs" });
    const back = parseMembershipCsv(`﻿${csv.replace(/\n/g, "\r\n")}`);
    expect(back.paths).toEqual(PATHS);
    for (const path of PATHS) expect(back.masks.get(path)).toEqual(table.masks.get(path));
  });

  it("refuses a ragged row, a value other than 0 or 1, an out-of-order index and a bad header", () => {
    const header = "event_index,CD4_positive,CD8_positive";
    expect(() => parseMembershipCsv(`${header}\n0,1,0\n1,1\n`)).toThrow(
      "Line 3 of the membership CSV has 2 fields; the header has 3.",
    );
    expect(() => parseMembershipCsv(`${header}\n0,1,0,1\n`)).toThrow(/Line 2 .* has 4 fields; the header has 3/);
    expect(() => parseMembershipCsv(`${header}\n0,1,2\n`)).toThrow(/'2' for 'CD8_positive'; only 0 or 1/);
    expect(() => parseMembershipCsv(`${header}\n0,1,0\n2,1,0\n`)).toThrow(/event_index '2'; expected 1/);
    expect(() => parseMembershipCsv("index,CD4_positive\n0,1\n")).toThrow(/must be 'event_index'/);
    expect(() => parseMembershipCsv("event_index,CD4_positive,CD4_positive\n0,1,1\n")).toThrow(/twice/);
    expect(() => parseMembershipCsv("")).toThrow(/empty/);
  });

  it("refuses a population without a mask of the file's length", () => {
    const gating = gatedTree(TREE);
    expect(() => membershipTable({ ...gating, masks: { ...gating.masks, cd4: new Uint8Array(5) } })).toThrow(
      "Population 'Lymphocytes/CD4_positive' has a mask of 5 events; the file has 20.",
    );
    const { cd4: _dropped, ...rest } = gating.masks;
    expect(() => membershipTable({ ...gating, masks: rest })).toThrow(/has no mask/);
  });
});
