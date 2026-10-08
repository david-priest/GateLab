import { describe, expect, it } from "vitest";
import type { FileCounts } from "./chorusStatistics";
import { checkAgainstFlowJo, flowJoCountCheckCsv, type FlowJoReference } from "./flowjoCountCheck";

const file = (over: Partial<FileCounts> = {}): FileCounts => ({
  entryId: "f1",
  fileName: "D1.fcs",
  hierarchyName: "Main",
  events: 1000,
  populations: [
    { name: "Lymphocytes", depth: 1, parentName: null, events: 800, percentParent: 80 },
    { name: "CD4_positive", depth: 2, parentName: "Lymphocytes", events: 400, percentParent: 50 },
    { name: "Naive", depth: 3, parentName: "CD4_positive", events: 100, percentParent: 25 },
  ],
  ...over,
});

const reference = (over: Partial<FlowJoReference> = {}): FlowJoReference => ({
  entryId: "f1",
  fileName: "D1.fcs",
  sampleName: "D1.fcs",
  events: 1000,
  counts: { Lymphocytes: 800, CD4_positive: 400, Naive: 100 },
  ...over,
});

describe("checkAgainstFlowJo", () => {
  it("finds every population exact where the counts are FlowJo's", () => {
    const check = checkAgainstFlowJo([reference()], [file()]);
    expect(check.compared).toBe(3);
    expect(check.exact).toBe(3);
    expect(check.largest).toBeNull();
    expect(check.unmatched).toEqual([]);
    expect(check.files[0].rows.map((row) => [row.name, row.delta, row.reason.kind])).toEqual([
      ["Lymphocytes", 0, "exact"], ["CD4_positive", 0, "exact"], ["Naive", 0, "exact"],
    ]);
    // FlowJo's share of the parent is worked out from its own counts: of the sample for a
    // top-level population, of the recorded parent below that.
    expect(check.files[0].rows.map((row) => row.flowJoPercentParent)).toEqual([80, 50, 25]);
  });

  it("tells a difference that arises at a gate from one counted within a population that already differs", () => {
    const check = checkAgainstFlowJo(
      [reference({ counts: { Lymphocytes: 800, CD4_positive: 403, Naive: 101 } })],
      [file()],
    );
    const rows = check.files[0].rows;
    expect(rows.map((row) => [row.name, row.delta, row.reason])).toEqual([
      ["Lymphocytes", 0, { kind: "exact" }],
      ["CD4_positive", -3, { kind: "own" }],
      ["Naive", -1, { kind: "inherited", from: "CD4_positive" }],
    ]);
    expect(rows[1].relative).toBeCloseTo(-3 / 403, 12);
    expect(check.exact).toBe(1);
    expect(check.files[0].largest?.name).toBe("CD4_positive");
    expect(check.largest).toEqual({ fileName: "D1.fcs", row: rows[1] });
  });

  it("names what only one side holds, and takes -1 for a count FlowJo never calculated", () => {
    const check = checkAgainstFlowJo(
      [reference({ counts: { Lymphocytes: 800, CD4_positive: -1, Memory: 55 } })],
      [file()],
    );
    expect(check.files[0].rows.map((row) => [row.name, row.flowJoEvents, row.gatelabEvents, row.reason.kind])).toEqual([
      ["Lymphocytes", 800, 800, "exact"],
      ["CD4_positive", null, 400, "unrecorded"],
      ["Naive", null, 100, "gatelab-only"],
      ["Memory", 55, null, "flowjo-only"],
    ]);
    expect(check.compared).toBe(1);
    expect(check.flowJoOnly).toBe(1);
  });

  it("pairs a sample with its file by id, else by a name only one loaded file has", () => {
    const twin = file({ entryId: "f2", events: 900 });
    // Two loaded files of one name: the id says which.
    expect(checkAgainstFlowJo([reference({ entryId: "f2" })], [file(), twin]).files[0].fileEvents).toBe(900);
    // No id and two files of the name: not compared, and said so.
    const unsure = checkAgainstFlowJo([reference({ entryId: null })], [file(), twin]);
    expect(unsure.files).toEqual([]);
    expect(unsure.unmatched).toEqual(["D1.fcs"]);
    // No id and one file of the name.
    expect(checkAgainstFlowJo([reference({ entryId: null })], [file()]).files).toHaveLength(1);
    // The file is not loaded any more.
    expect(checkAgainstFlowJo([reference({ entryId: "gone", fileName: "D2.fcs" })], [file()]).unmatched).toEqual(["D2.fcs"]);
  });

  it("keeps FlowJo's event total for the sample beside the file's", () => {
    const check = checkAgainstFlowJo([reference({ events: 1200 })], [file()]);
    expect(check.files[0].flowJoEvents).toBe(1200);
    expect(check.files[0].fileEvents).toBe(1000);
    // A top-level population's FlowJo share is of FlowJo's own total.
    expect(check.files[0].rows[0].flowJoPercentParent).toBeCloseTo((800 / 1200) * 100, 12);
  });

  it("compares a name the tree holds twice once, at its first place", () => {
    const again = file({
      populations: [
        { name: "Lymphocytes", depth: 1, parentName: null, events: 800, percentParent: 80 },
        { name: "Lymphocytes", depth: 2, parentName: "Lymphocytes", events: 10, percentParent: 1.25 },
      ],
    });
    const rows = checkAgainstFlowJo([reference({ counts: { Lymphocytes: 800 } })], [again]).files[0].rows;
    expect(rows.map((row) => row.reason.kind)).toEqual(["exact", "gatelab-only"]);
  });
});

describe("flowJoCountCheckCsv", () => {
  it("writes one row per population, quoting a name that holds a comma", () => {
    const check = checkAgainstFlowJo(
      [reference({ counts: { Lymphocytes: 800, CD4_positive: 403, Naive: 101, "treated, B1": 5 } })],
      [file()],
    );
    expect(flowJoCountCheckCsv(check).split("\n")).toEqual([
      "file,flowjo_sample,population,flowjo_events,gatelab_events,difference,difference_of_flowjo,status,differs_below",
      "D1.fcs,D1.fcs,Lymphocytes,800,800,0,0,exact,",
      "D1.fcs,D1.fcs,CD4_positive,403,400,-3,-0.007444,own,",
      "D1.fcs,D1.fcs,Naive,101,100,-1,-0.009901,inherited,CD4_positive",
      'D1.fcs,D1.fcs,"treated, B1",5,,,,flowjo-only,',
      "",
    ]);
  });
});
