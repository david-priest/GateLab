import { describe, expect, it } from "vitest";
import { gatedTree, type PopulationSpec } from "./__fixtures__/gatedTree";
import { compareMemberships, membershipComparisonCsv, type ComparedPopulation } from "./membershipComparison";
import { membershipTable, parseMembershipCsv, exportMemberships } from "./membershipExport";

// x = 0..19; y = 0 on even events, 10 on odd ones.
const REFERENCE: PopulationSpec[] = [
  { id: "lym", name: "Lymphocytes", parent: null, x: [0, 15] },
  { id: "cd4", name: "CD4_positive", parent: "lym", x: [0, 7] },
  { id: "cd8", name: "CD8_positive", parent: "lym", x: [10, 19] },
  { id: "act", name: "Activated", parent: "cd8", x: [11, 19] },
  { id: "none", name: "Empty", parent: "lym", x: [100, 200] },
];

/** The reference tree with some populations' x ranges replaced. */
const withRanges = (ranges: Record<string, [number, number]>): PopulationSpec[] =>
  REFERENCE.map((spec) => (ranges[spec.id] ? { ...spec, x: ranges[spec.id] } : spec));

const table = (specs: PopulationSpec[]) => membershipTable(gatedTree(specs));

const numbers = (row: ComparedPopulation) => ({
  test: row.testEvents, reference: row.referenceEvents, both: row.both, testOnly: row.testOnly, referenceOnly: row.referenceOnly,
});

describe("compareMemberships", () => {
  it("(a) finds identical sets exact everywhere, F1 = 1 even for a population both leave empty", () => {
    const check = compareMemberships(table(REFERENCE), table(REFERENCE));
    expect(check.compared).toBe(5);
    expect(check.exact).toBe(5);
    expect(check.largest).toBeNull();
    expect(check.testOnlyPaths).toEqual([]);
    expect(check.referenceOnlyPaths).toEqual([]);
    expect(check.rows.map((row) => [row.path, row.f1, row.attribution.kind])).toEqual([
      ["Lymphocytes", 1, "exact"],
      ["Lymphocytes/CD4_positive", 1, "exact"],
      ["Lymphocytes/CD8_positive", 1, "exact"],
      ["Lymphocytes/CD8_positive/Activated", 1, "exact"],
      ["Lymphocytes/Empty", 1, "exact"],
    ]);
    expect(check.rows.filter((row) => row.attribution.kind === "own" || row.attribution.kind === "inherited")).toEqual([]);
    const empty = check.rows[4];
    expect(numbers(empty)).toEqual({ test: 0, reference: 0, both: 0, testOnly: 0, referenceOnly: 0 });
    // Precision and recall are undefined where neither side holds an event; F1 is 1.
    expect([empty.precision, empty.recall, empty.f1]).toEqual([null, null, 1]);
    expect(check.rows[1].precision).toBe(1);
    expect(check.rows[1].recall).toBe(1);
  });

  it("(b) attributes a parent gate that holds 3 fewer events as own, and its descendants as inherited", () => {
    // The test set's Lymphocytes stops at x = 12, so it lacks events 13, 14 and 15.
    const check = compareMemberships(table(withRanges({ lym: [0, 12] })), table(REFERENCE));
    const [lym, cd4, cd8, act, empty] = check.rows;
    expect(numbers(lym)).toEqual({ test: 13, reference: 16, both: 13, testOnly: 0, referenceOnly: 3 });
    expect(lym.attribution).toEqual({ kind: "own" });
    expect(lym.precision).toBe(1);
    expect(lym.recall).toBeCloseTo(13 / 16, 12);
    expect(lym.f1).toBeCloseTo(26 / 29, 12);
    expect(lym.withinAgreedParent).toBe(3);

    // CD4_positive lies wholly inside the part both Lymphocytes hold.
    expect(numbers(cd4)).toEqual({ test: 8, reference: 8, both: 8, testOnly: 0, referenceOnly: 0 });
    expect(cd4.attribution).toEqual({ kind: "exact" });

    // CD8_positive (x >= 10): the reference holds 10..15, the test set 10..12.
    expect(numbers(cd8)).toEqual({ test: 3, reference: 6, both: 3, testOnly: 0, referenceOnly: 3 });
    expect(cd8.attribution).toEqual({ kind: "inherited", from: "Lymphocytes" });
    expect(cd8.f1).toBeCloseTo(6 / 9, 12);
    // Its gate agrees on every event both parents hold.
    expect(cd8.withinAgreedParent).toBe(0);

    // Activated (x >= 11): the reference holds 11..15, the test set 11..12; inherited from the
    // nearest disagreeing population above it.
    expect(numbers(act)).toEqual({ test: 2, reference: 5, both: 2, testOnly: 0, referenceOnly: 3 });
    expect(act.attribution).toEqual({ kind: "inherited", from: "Lymphocytes/CD8_positive" });
    expect(act.f1).toBeCloseTo(4 / 7, 12);
    expect(act.withinAgreedParent).toBe(0);

    expect(empty.attribution).toEqual({ kind: "exact" });
    expect(check.compared).toBe(5);
    expect(check.exact).toBe(2);
    expect(check.largest?.path).toBe("Lymphocytes");
  });

  it("counts a child's own disagreement within an inherited one", () => {
    // Lymphocytes differs as in (b), and CD8_positive's own gate also starts at 9 instead of 10.
    const check = compareMemberships(table(withRanges({ lym: [0, 12], cd8: [9, 19] })), table(REFERENCE));
    const cd8 = check.rows[2];
    expect(numbers(cd8)).toEqual({ test: 4, reference: 6, both: 3, testOnly: 1, referenceOnly: 3 });
    expect(cd8.attribution).toEqual({ kind: "inherited", from: "Lymphocytes" });
    // Event 9 is in both Lymphocytes and only the test set's CD8_positive.
    expect(cd8.withinAgreedParent).toBe(1);
  });

  it("(c) compares two populations of one name under different parents each with its own counterpart", () => {
    const tree = (cd4UnderMonocytes: [number, number]): PopulationSpec[] => [
      { id: "lym", name: "Lymphocytes", parent: null, x: [0, 9] },
      { id: "lcd4", name: "CD4_positive", parent: "lym", x: [0, 4] },
      { id: "mono", name: "Monocytes", parent: null, x: [10, 19] },
      { id: "mcd4", name: "CD4_positive", parent: "mono", x: cd4UnderMonocytes },
    ];
    const check = compareMemberships(table(tree([12, 19])), table(tree([10, 14])));
    const byPath = new Map(check.rows.map((row) => [row.path, row]));
    expect(check.rows.map((row) => row.path)).toEqual([
      "Lymphocytes", "Lymphocytes/CD4_positive", "Monocytes", "Monocytes/CD4_positive",
    ]);
    const lymphoid = byPath.get("Lymphocytes/CD4_positive")!;
    expect(numbers(lymphoid)).toEqual({ test: 5, reference: 5, both: 5, testOnly: 0, referenceOnly: 0 });
    expect(lymphoid.attribution).toEqual({ kind: "exact" });
    // Test 12..19, reference 10..14: both hold 12..14, the test set alone 15..19, the reference alone 10..11.
    const myeloid = byPath.get("Monocytes/CD4_positive")!;
    expect(numbers(myeloid)).toEqual({ test: 8, reference: 5, both: 3, testOnly: 5, referenceOnly: 2 });
    expect(myeloid.attribution).toEqual({ kind: "own" });
    expect(myeloid.f1).toBeCloseTo(6 / 13, 12);
    expect(myeloid.name).toBe("CD4_positive");
    expect(myeloid.parentPath).toBe("Monocytes");
  });

  it("(d) finds populations of equal counts that hold different events", () => {
    // The test set's CD4_positive is 2..9 and the reference's 0..7: eight events each, six shared.
    const check = compareMemberships(table(withRanges({ cd4: [2, 9] })), table(REFERENCE));
    const cd4 = check.rows[1];
    expect(cd4.testEvents).toBe(cd4.referenceEvents);
    expect(numbers(cd4)).toEqual({ test: 8, reference: 8, both: 6, testOnly: 2, referenceOnly: 2 });
    expect(cd4.precision).toBeCloseTo(0.75, 12);
    expect(cd4.recall).toBeCloseTo(0.75, 12);
    expect(cd4.f1).toBeCloseTo(0.75, 12);
    expect(cd4.f1!).toBeLessThan(1);
    expect(cd4.attribution).toEqual({ kind: "own" });
    expect(check.exact).toBe(4);
  });

  it("reports populations only one side has, and compares the rest", () => {
    const test = table([...REFERENCE.filter((spec) => spec.id !== "act"), { id: "extra", name: "Extra", parent: "cd4", x: [0, 3] }]);
    const check = compareMemberships(test, table(REFERENCE));
    expect(check.referenceOnlyPaths).toEqual(["Lymphocytes/CD8_positive/Activated"]);
    expect(check.testOnlyPaths).toEqual(["Lymphocytes/CD4_positive/Extra"]);
    expect(check.compared).toBe(4);
    const onlyRows = check.rows.filter((row) => row.both === null);
    expect(onlyRows.map((row) => [row.path, row.testEvents, row.referenceEvents, row.f1, row.attribution.kind])).toEqual([
      ["Lymphocytes/CD8_positive/Activated", null, 5, null, "reference-only"],
      ["Lymphocytes/CD4_positive/Extra", 4, null, null, "test-only"],
    ]);
  });

  it("compares a set read back from its CSV", () => {
    const reference = parseMembershipCsv(exportMemberships(gatedTree(REFERENCE), { fileName: "D1.fcs" }).csv);
    const check = compareMemberships(table(withRanges({ cd4: [2, 9] })), reference);
    expect(numbers(check.rows[1])).toEqual({ test: 8, reference: 8, both: 6, testOnly: 2, referenceOnly: 2 });
  });

  it("refuses sets over different numbers of events", () => {
    const short = parseMembershipCsv("event_index,Lymphocytes\n0,1\n1,0\n");
    expect(() => compareMemberships(short, table(REFERENCE))).toThrow(
      "The two membership sets cover different events: the test set has 2 and the reference 20. " +
        "They can only be compared over the same events.",
    );
  });
});

describe("membershipComparisonCsv", () => {
  it("writes one row per population with its counts, F1 and where the difference arises", () => {
    // CD4_positive three events short in the test set: 0..4 against the reference's 0..7.
    const check = compareMemberships(table(withRanges({ cd4: [0, 4] })), table(REFERENCE));
    const lines = membershipComparisonCsv(check, "D1.fcs").trimEnd().split("\n");
    expect(lines[0]).toBe("file,population,gatelab_events,reference_events,both,gatelab_only,reference_only,precision,recall,f1,within_agreed_parent,where");
    expect(lines).toHaveLength(check.rows.length + 1);
    expect(lines[2]).toBe("D1.fcs,Lymphocytes/CD4_positive,5,8,5,0,3,1.000000,0.625000,0.769231,3,at its own gate");
  });
});
