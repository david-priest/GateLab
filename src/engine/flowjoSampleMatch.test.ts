import { describe, expect, it } from "vitest";
import { matchFlowJoSamples, type FlowJoSampleSummary } from "./flowjoWorkspace";

function sample(name: string, index = 0, candidates?: string[]): FlowJoSampleSummary {
  return {
    index, name, owningGroup: "", duplicateName: false,
    rootCount: 1, eventCount: 1000, gateCount: 5, unsupportedCount: 0,
    candidateFileNames: candidates ?? [name],
    trees: [{ index: 0, name: "root", rootCount: 1000, gateCount: 5, unsupportedCount: 0, populations: [] }],
  };
}

describe("matching a workspace sample to the loaded file", () => {
  it("matches on the file name, ignoring case and the extension", () => {
    const r = matchFlowJoSamples([sample("LP4 rec.fcs"), sample("LP6 rec.fcs", 1)], {
      fileName: "lp4 rec.FCS",
    });
    expect(r.matchedOn).toBe("name");
    expect(r.matches.map((s) => s.name)).toEqual(["LP4 rec.fcs"]);
  });

  it("falls back to $FIL when the workspace names samples by acquisition id", () => {
    // A FACSDiva export names its samples "19319.fcs" while the file on disk is
    // "Specimen_001_B cell presort.fcs". Without this the user gets a picker for a
    // single-sample workspace, and no indication of why nothing matched.
    const r = matchFlowJoSamples([sample("19319.fcs")], {
      fileName: "Specimen_001_B cell presort.fcs",
      fil: "19319.fcs",
    });
    expect(r.matchedOn).toBe("fil");
    expect(r.matches).toHaveLength(1);
  });

  it("prefers the file name when the two keys disagree", () => {
    // Both resolve, to different samples. The file name is what the user chose to load.
    const r = matchFlowJoSamples([sample("mine.fcs"), sample("19319.fcs", 1)], {
      fileName: "mine.fcs",
      fil: "19319.fcs",
    });
    expect(r.matchedOn).toBe("name");
    expect(r.matches[0].index).toBe(0);
  });

  it("never resolves an ambiguous match by either key", () => {
    // FlowJo allows the same file twice; taking the first would import another sample's gates.
    const dupes = [sample("19319.fcs", 0), sample("19319.fcs", 1)];
    expect(matchFlowJoSamples(dupes, { fileName: "19319.fcs" }).matchedOn).toBeNull();
    expect(
      matchFlowJoSamples(dupes, { fileName: "other.fcs", fil: "19319.fcs" }).matchedOn,
    ).toBeNull();
  });

  it("does not match on an empty or absent key", () => {
    // An unnamed sample must not become a wildcard that matches a file with no $FIL.
    expect(matchFlowJoSamples([sample("")], { fileName: "" }).matchedOn).toBeNull();
    expect(matchFlowJoSamples([sample(".fcs")], { fileName: "x.fcs", fil: null }).matchedOn)
      .toBeNull();
  });
});
