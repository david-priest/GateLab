// @vitest-environment jsdom
//
// The ISAC Gating-ML 2.0 compliance suite (gatingMLData 2.38.0, the standard's own test data),
// read by GateLab's importer and evaluated through the sample's own gating path
// (Sample.gateAssayData), every population against the suite's truth, event by event, with no
// tolerance. The fixtures, their licence (GPL) and what was repacked are described in
// __fixtures__/isac-gatingml/README.md; how a case is built is in isacGatingML.harness.ts.
//
// Every one of the suite's 190 cases lands in exactly one list below, so a case that changes
// outcome, in either direction, fails here and has to be moved on purpose. GateLab with the
// Gating-ML PRs before this one (#341, #342, #345) matched 44 of them; with #344's half-open
// ranges, 80 (Range2 and And1 as well). Of the 34 more #350 alone matched, 18 it imported wrongly (a fasinh with A other than 0 or M other than log10 e, a
// transformation's bounds), 2 were ellipses it left out, and 14 it refused (FCS compensation asked
// of a file with no matrix, flin). Eleven it refused outright, ratio and OR gates, are left out by
// name now, so a file that holds one imports the rest.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ISAC_DIR, ISAC_SETS, isacCase, isacExpected, isacSample, type IsacOutcome } from "./isacGatingML.harness";

const OUTCOMES: Record<string, string[]> = {
  "match": [
    "1/And1", "1/And2", "1/And3", "1/And4", "1/Ellipse1", "1/Not1", "1/ParAnd2", "1/ParAnd3", "1/Polygon1",
    "1/Polygon2", "1/Polygon3NS", "1/Polygon4", "1/Range1", "1/Range2", "1/Rectangle1", "1/Rectangle2",
    "1/Rectangle3", "1/Rectangle4", "1/Rectangle5", "1/ScaleRange1", "1/ScaleRange1Bound",
    "1/ScaleRange1c", "1/ScaleRange3", "1/ScaleRange3Bound", "1/ScaleRange3c", "1/ScaleRange4",
    "1/ScaleRange4Bound", "1/ScaleRange4c", "1/ScaleRange5", "1/ScaleRange5c", "1/ScaleRange6",
    "1/ScaleRange6Bound", "1/ScaleRange6c", "1/ScaleRange8c", "1/ScaleRect1", "1/ScaleRect1Bound",
    "1/ScaleRect1Bound2", "2/Ellipseca", "2/Ellipsecl", "2/Ellipseclb", "2/Ellipseua",
    "2/Ellipseul", "2/Ellipseulb", "2/Ellipseulb2", "2/NotRectcl", "2/Poly1c", "2/Poly1ca",
    "2/Poly1cab", "2/Poly1cl", "2/Poly1clb", "2/Poly1u", "2/Poly1ua", "2/Poly1uab", "2/Poly1uab2",
    "2/Poly1ul", "2/Poly1ulb", "2/RectMix1", "2/Rectcl", "2/RectclAgain", "2/Rectul",
    "3/myEllipseGate", "3/myPolygonGate", "3/myPolygonGate2ArcSinHLin", "3/myPolygonGate3LogLin",
    "3/myPolygonGateWithCustomSpillover", "3/myPolygonGateWithFCSSpillover",
    "3/myPolygonGateWithSpilloverSameAsFCS", "3/myPolygonGateWithoutSpillover", "3/myRangeGate1",
    "3/myRangeGate2", "3/myRectangleGate", "3/myRectangleGate2Logicle",
    "3/myRectangleGate3LogicleArcSinH", "5/myAnd1", "5/myAnd2", "5/myAnd3", "5/myAnd4",
    "5/myNotNot", "5/myPolygon1", "5/myPolygon2",
  ],
  "left out: ratio": [
    "1/RatRange1", "1/RatRange1Bound", "1/RatRange1a", "1/RatRange1aBound", "1/RatRange2",
    "4/myRange1", "4/myRange2", "4/myRange3", "4/myRange4", "4/myRange5",
  ],
  "left out: OR": [
    "1/Or1", "5/myOr1", "5/myOr2", "5/myOr3", "5/myOr4",
  ],
  "refused: quadrant": [
    "1/FL2N-FL4N", "1/FL2N-FL4P", "1/FL2P-FL4N", "1/FL2P-FL4P", "1/FSCD-FL1P", "1/FSCD-SSCN-FL1N",
    "1/FSCN-SSCN", "1/FSCN-SSCP-FL1P", "1/FSCP-SSCN-FL1N", "1/Or2", "3/Q1", "3/Q1A", "3/Q1B",
    "3/Q1C", "3/Q1D", "3/Q1E", "3/Q2", "3/Q2A", "3/Q2B", "3/Q2C", "3/Q2D", "3/Q2E", "3/Q3", "3/Q3A",
    "3/Q3B", "3/Q3C", "3/Q3D", "3/Q3E", "3/Q4", "3/Q4A", "3/Q4B", "3/Q4C", "3/Q4D", "3/Q4E", "3/Q5",
    "3/Q6", "3/Q7", "3/myBooleanAnd", "3/myBooleanNot", "3/myBooleanOr", "3/myBooleanOrWithParent",
    "4/myQuadrant2_NN", "4/myQuadrant2_NP", "4/myQuadrant2_PN", "4/myQuadrant2_PP",
    "4/myQuadrant3_NN", "4/myQuadrant3_NP", "4/myQuadrant3_PN", "4/myQuadrant3_PP",
    "4/myQuadrant4_NN", "4/myQuadrant4_NP", "4/myQuadrant4_PN", "4/myQuadrant4_PP",
    "4/myQuadrant_NN", "4/myQuadrant_NP", "4/myQuadrant_PN", "4/myQuadrant_PP",
  ],
  "refused: hyperlog": [
    "1/ScalePar1", "1/ScaleRange2", "1/ScaleRange2Bound", "1/ScaleRange2c", "1/ScaleRange2cBound",
    "1/ScaleRange7c", "2/Ellipsech", "2/Ellipseuh", "2/Poly1ch", "2/Poly1chb", "2/Poly1uh",
    "2/Poly1uhb", "2/Rectch", "2/RectchAndNotRectcl", "2/RectchAndNotRectcl2", "2/RectclAndRectch",
    "2/RectclOrRectch", "2/Rectuh", "3/myRectangleGate2bHyperlog",
    "3/myRectangleGate3bHyperlogArcSinH",
  ],
  "refused: more than two dimensions": [
    "1/Ellipsoid3D", "2/Cube3Du", "2/Cube3DuP", "2/Cube3DuPAsBool", "2/Cube3Dul", "2/HyperCube1",
    "3/my3DRectangleGate", "3/myEllipsoidGate",
  ],
  "not in the file": [
    "3/myPolygonWCustNonSqSpecArcSinH", "3/myPolygonWCustNonSqSpecInvAlrd",
    "3/myPolygonWCustSpillAndArcSinH", "3/myPolygonWFCSSpillAndArcSinH",
    "3/myPolygonWithCustInvAlrSpil", "3/myPolygonWithCustNonSqSpecMat",
    "3/myRect4LogicleArcSinHFCSComp", "3/myRect4bHyperlogArcSinHFCSComp", "5/Not_myPolygon1",
    "5/Not_myPolygon2",
  ],
};

/** Each case's outcome, by set/gate id, and where it belongs among OUTCOMES. */
function run(): { outcomes: Record<string, IsacOutcome>; lists: Record<string, string[]> } {
  const outcomes: Record<string, IsacOutcome> = {};
  const lists: Record<string, string[]> = {};
  for (const { set, gates, fcs } of ISAC_SETS) {
    const xml = readFileSync(`${ISAC_DIR}/${gates}`, "utf8");
    const truth = isacExpected(set);
    for (const id of Object.keys(truth.gates).sort()) {
      // A fresh sample for each case: a case that turns compensation on must not carry it into the next.
      const outcome = isacCase(xml, id, isacSample(fcs), truth.gates[id]);
      const key = `${set}/${id}`;
      outcomes[key] = outcome;
      const why = outcome.kind === "refused" ? outcome.message : outcome.kind === "left out" ? outcome.warning : "";
      const list = outcome.kind === "match" ? "match"
        : outcome.kind === "differ" ? "differ"
        : outcome.kind === "not in the file" ? "not in the file"
        : outcome.kind === "left out"
          ? (/has the ratio dimension/.test(why) ? "left out: ratio" : /combines its references with OR/.test(why) ? "left out: OR" : "unexpected")
          : /QuadrantGate \S+ is not supported/.test(why) ? "refused: quadrant"
          : /unsupported or missing transformation \S*[Hh]yperlog/.test(why) ? "refused: hyperlog"
          : /has [34] dimensions|EllipsoidGate \S+ could not be parsed/.test(why) ? "refused: more than two dimensions"
          : "unexpected";
      (lists[list] ??= []).push(key);
    }
  }
  for (const l of Object.values(lists)) l.sort();
  return { outcomes, lists };
}

describe("the ISAC Gating-ML 2.0 compliance suite", () => {
  const { outcomes, lists } = run();

  it("puts every case where it was put, and none where it was not", () => {
    expect(lists.unexpected ?? []).toEqual([]);
    expect(lists).toEqual(OUTCOMES);
  });

  it("matches the suite's truth event for event wherever GateLab imports the gate", () => {
    for (const key of OUTCOMES.match) expect(outcomes[key], key).toMatchObject({ kind: "match" });
  });

  it("reads a range half-open, leaving out the events on its upper edge as the suite does", () => {
    // Gating-ML reads a range as min <= x < max. Range2 (Time 20 to 80, integer ticks) leaves out
    // the 60 events at 80, and And1 the 7 of them inside Polygon1. With #344's rectangle edge rules
    // an unidentified file's rectangle is half-open, and both match; before it, GateLab held the
    // upper edge and both differed by exactly those events.
    const sample = isacSample("data1.fcs");
    const time = sample.rawColumnData(sample.channels.findIndex((c) => c.pnn === "Time"));
    const truth = isacExpected(1);
    for (const key of ["1/Range2", "1/And1"]) expect(outcomes[key], key).toMatchObject({ kind: "match" });
    const r2 = truth.gates.Range2;
    expect(Array.from(time).filter((t, i) => t === 80 && !r2[i]).length).toBe(60);
  });

  it("names every gate it leaves out", () => {
    for (const key of [...OUTCOMES["left out: ratio"], ...OUTCOMES["left out: OR"]]) {
      const o = outcomes[key];
      expect(o.kind === "left out" && o.warning.startsWith(`"${key.split("/")[1]}"`), key).toBe(true);
    }
  });
});

describe("the ISAC fixtures' licence", () => {
  it("states, dated, every change made to a file (GPL-2 section 2a, GPL-3 section 5a)", () => {
    // The package is GPL; a modified copy must carry a prominent notice of the change and its date.
    // The repacked truths and the gzipped FCS files did not say when (verifier).
    const readme = readFileSync(`${ISAC_DIR}/README.md`, "utf8");
    const notice = (readme.split("\n## Changes\n")[1] ?? "").split("\n## ")[0];
    for (const file of ["data1.fcs.gz", "data2.fcs.gz", "9399_1_3_NKR.fcs.gz", ...[1, 2, 3, 4, 5].map((k) => `expected-set${k}.json.gz`)]) {
      expect(notice, file).toMatch(new RegExp(`\`${file.replace(/\./g, "\\.")}\`[^\\n]*\\b\\d{4}-\\d{2}-\\d{2}\\b`));
    }
  });
});
