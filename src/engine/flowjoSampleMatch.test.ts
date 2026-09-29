// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  flowJoSampleNamesFile,
  listFlowJoWorkspaceSamples,
  matchFlowJoSamples,
  resolveFlowJoWorkspaceFiles,
  ungatedWorkspaceFiles,
  type FlowJoSampleSummary,
} from "./flowjoWorkspace";

function sample(name: string, index = 0, candidates?: string[], extra: Partial<FlowJoSampleSummary> = {}): FlowJoSampleSummary {
  return {
    index, name, owningGroup: "", duplicateName: false,
    rootCount: 1, eventCount: 1000, gateCount: 5, unsupportedCount: 0,
    candidateFileNames: candidates ?? [name],
    trees: [{ index: 0, name: "root", rootCount: 1000, gateCount: 5, unsupportedCount: 0, populations: [] }],
    ...extra,
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

  // Both keys resolve, to different samples. The file's name used to win whatever the keywords
  // said; a sample of its name that records nothing then took the file from the sample its $FIL
  // names and its keywords confirm. Two names that disagree are decided by the keywords, and
  // where they cannot decide, the user is asked.
  it("asks when the file name and its $FIL name different samples and nothing recorded tells which", () => {
    const r = matchFlowJoSamples([sample("mine.fcs"), sample("19319.fcs", 1)], {
      fileName: "mine.fcs",
      fil: "19319.fcs",
    });
    expect(r.matchedOn).toBeNull();
    expect(r.matches.map((m) => m.index)).toEqual([0, 1]);
  });

  it("takes the sample the $FIL names when its keywords confirm the file and the name's confirm nothing", () => {
    const own = { ...sample("19319.fcs", 1), recorded: { $BTIM: "10:00:00", $TOT: "3" } };
    const r = matchFlowJoSamples([sample("mine.fcs"), own], {
      fileName: "mine.fcs",
      fil: "19319.fcs",
      keywords: { $BTIM: "10:00:00", $TOT: "3" },
    });
    expect(r.matchedOn).toBe("fil");
    expect(r.matches.map((m) => m.index)).toEqual([1]);
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

describe("the keywords decide which sample named like the file IS the file", () => {
  // Synthetic re-creations of the FlowRepository cases the audit found (2026-09-24).
  const withRecord = (s: FlowJoSampleSummary, recorded: FlowJoSampleSummary["recorded"]) => ({ ...s, recorded });
  const d1 = { $TOT: "36988", $BTIM: "11:02:10", $DATE: "13-OCT-2018" };
  const d2 = { $TOT: "43641", $BTIM: "11:56:55", $DATE: "13-OCT-2018" };

  it("takes the sample the keywords confirm, not the first in document order", () => {
    // Two samples named h1.fcs; the file is the second's acquisition. Document order gave the first.
    const samples = [withRecord(sample("h1.fcs", 0), d1), withRecord(sample("h1.fcs", 1), d2)];
    const r = matchFlowJoSamples(samples, { fileName: "h1.fcs", keywords: d2 });
    expect(r.matchedOn).toBe("name");
    expect(r.matches.map((s) => s.index)).toEqual([1]);
  });

  it("pairs nothing with a same-named file of another acquisition, and says what differs", () => {
    // The only sample of the file's name records another experiment's acquisition.
    const r = matchFlowJoSamples([withRecord(sample("specimen_001_tube_006.fcs"), d1)], {
      fileName: "specimen_001_tube_006.fcs", keywords: d2,
    });
    expect(r.matchedOn).toBeNull();
    expect(r.matches).toEqual([]);
    expect(r.pairing.kind).toBe("contradicted");
    if (r.pairing.kind === "contradicted") expect(r.pairing.candidates[0].comparison.differ.map((d) => d.key)).toEqual(["$TOT", "$BTIM"]);
  });

  it("finds the file's own sample among ungated ones too, so a gated twin does not take it", () => {
    const gated = { ...withRecord(sample("cd4 stained control.fcs", 0), { $TOT: "10000", $BTIM: "09:00:00" }) };
    const ungated = { ...withRecord(sample("cd4 stained control.fcs", 1), { $TOT: "10000", $BTIM: "09:40:00" }), gateCount: 0 };
    const r = matchFlowJoSamples([gated, ungated], { fileName: "cd4 stained control.fcs", keywords: { $TOT: "10000", $BTIM: "09:40:00" } });
    expect(r.matches.map((s) => s.index)).toEqual([1]);
    expect(r.matches[0].gateCount).toBe(0);
  });

  it("does not let a shared $TOT confirm a fixed-count acquisition", () => {
    const r = matchFlowJoSamples([withRecord(sample("comp.fcs"), { $TOT: "5000", $BTIM: "10:00:00" })], {
      fileName: "comp.fcs", keywords: { $TOT: "5000", $BTIM: "12:00:00" },
    });
    expect(r.pairing.kind).toBe("contradicted");
  });
});

// A workspace over a multi-data-set file (a plate with one data set per well) records every data
// set under the file's name. GateLab opens each as a sample named "plate (data set k of N, well).fcs".
describe("matching a workspace sample to one data set of a multi-data-set file", () => {
  const well = (index: number, label: string | null, events: number) =>
    sample("plate.fcs", index, ["plate.fcs"], { dataSetLabel: label, eventCount: events });
  const A01 = "plate (data set 1 of 2, A01).fcs";
  const A02 = "plate (data set 2 of 2, A02).fcs";

  it("tells the data sets apart by the well label, else the event count, and never by the file alone", () => {
    expect(flowJoSampleNamesFile(well(0, "A01", 2), { name: A01 })).toBe(true);
    expect(flowJoSampleNamesFile(well(0, "A01", 2), { name: A02 })).toBe(false);
    // Labels decide over counts where both sides carry one.
    expect(flowJoSampleNamesFile(well(0, "A01", 3), { name: A02, events: 3 })).toBe(false);
    // No label in the workspace: the event count.
    expect(flowJoSampleNamesFile(well(0, null, 3), { name: A02, events: 3 })).toBe(true);
    expect(flowJoSampleNamesFile(well(0, null, 3), { name: A01, events: 2 })).toBe(false);
    // Neither: not a match.
    expect(flowJoSampleNamesFile(well(0, null, 3), { name: A02 })).toBe(false);
    // Another file of the same well is not this one.
    expect(flowJoSampleNamesFile(sample("other.fcs", 0, ["other.fcs"], { dataSetLabel: "A02" }), { name: A02 })).toBe(false);
  });

  it("matches the viewed data set to its own well's sample, where the file's name alone is ambiguous", () => {
    const samples = [well(0, "A01", 2), well(1, "A02", 3)];
    const open = [{ name: A01, events: 2 }, { name: A02, events: 3 }];
    const r = matchFlowJoSamples(samples, { fileName: A02, fil: "plate.fcs", events: 3, open });
    expect(r.matchedOn).toBe("name");
    expect(r.matches.map((s) => s.index)).toEqual([1]);
    // With the file's other data set not known to be open, nothing says it is not A02 as well.
    expect(matchFlowJoSamples(samples, { fileName: A02, fil: "plate.fcs", events: 3 }))
      .toMatchObject({ matchedOn: null, tiedUnopened: 1 });
  });

  it("keeps GateLab's own export, which names each data set's sample after it, on exact names", () => {
    // $FIL still names the plate, so the A01 sample is recorded under plate.fcs too.
    const samples = [
      sample(A01, 0, [A01, "plate.fcs"], { dataSetLabel: "A01" }),
      sample(A02, 1, [A02, "plate.fcs"], { dataSetLabel: "A02" }),
    ];
    expect(matchFlowJoSamples(samples, { fileName: A02, events: 3 }).matches.map((s) => s.index)).toEqual([1]);
    const resolved = resolveFlowJoWorkspaceFiles(samples, [A01, A02]);
    expect(resolved.map((r) => r.fileName)).toEqual([A01, A02]);
  });

  it("resolves each well's sample to its data set once open, and to the file before it is read", () => {
    const samples = [well(0, "A01", 2), well(1, "A02", 3)];
    const open = resolveFlowJoWorkspaceFiles(samples, [A01, A02], {}, { events: new Map([[A01, 2], [A02, 3]]) });
    expect(open.map((r) => [r.fileName, r.matchedName])).toEqual([[A01, "plate.fcs"], [A02, "plate.fcs"]]);
    // Not yet read, plate.fcs may hold both wells.
    expect(resolveFlowJoWorkspaceFiles(samples, ["plate.fcs"], {}, { shareAcrossWells: true }).map((r) => r.fileName))
      .toEqual(["plate.fcs", "plate.fcs"]);
    // Without that allowance, and for samples naming one file under ONE well (FlowJo's same file
    // added twice), a file is still given to no more than one sample -- and, with fix/multitree-
    // import's rule that document order never decides, to neither where nothing says which.
    expect(resolveFlowJoWorkspaceFiles(samples, ["plate.fcs"]).map((r) => r.fileName)).toEqual([null, null]);
    const twice = [well(0, "A01", 2), well(1, "A01", 2)];
    expect(resolveFlowJoWorkspaceFiles(twice, ["plate.fcs"], {}, { shareAcrossWells: true }).map((r) => r.fileName))
      .toEqual([null, null]);
  });

  it("never pairs on an event count two data sets or two samples share, and names the data sets it could be", () => {
    // Three events in each data set and no well label anywhere: nothing says which sample is which.
    const d1 = "plate (data set 1 of 2).fcs";
    const d2 = "plate (data set 2 of 2).fcs";
    const events = new Map([[d1, 3], [d2, 3]]);
    const samples = [well(0, null, 3), well(1, null, 3)];
    expect(resolveFlowJoWorkspaceFiles(samples, [d1, d2], {}, { events }).map((r) => [r.fileName, r.tiedWith]))
      .toEqual([[null, [d1, d2]], [null, [d1, d2]]]);
    // One sample of that count is no better: either data set could be it.
    expect(resolveFlowJoWorkspaceFiles([well(0, null, 3)], [d1, d2], {}, { events })[0])
      .toMatchObject({ fileName: null, tiedWith: [d1, d2] });
    // Nor one data set two samples could be.
    expect(resolveFlowJoWorkspaceFiles(samples, [d1], {}, { events: new Map([[d1, 3]]) }).map((r) => r.fileName))
      .toEqual([null, null]);
    // A count one data set and one sample alone hold still pairs them.
    expect(resolveFlowJoWorkspaceFiles([well(0, null, 3), well(1, null, 4)], [d1, d2], {}, { events: new Map([[d1, 3], [d2, 4]]) })
      .map((r) => [r.fileName, r.tiedWith])).toEqual([[d1, undefined], [d2, undefined]]);
  });

  it("asks rather than taking the one sample of a count another open data set shares", () => {
    const d1 = "plate (data set 1 of 2).fcs";
    const d2 = "plate (data set 2 of 2).fcs";
    const open = [{ name: d1, events: 3 }, { name: d2, events: 3 }];
    const r = matchFlowJoSamples([well(0, null, 3)], { fileName: d1, fil: "plate.fcs", events: 3, open });
    expect(r.matchedOn).toBeNull();
    expect(r.matches.map((s) => s.index)).toEqual([0]);
    expect(r.tiedWith).toEqual([d2]);
    // Two samples of that count: the same question, which $FIL, naming the plate, cannot answer.
    expect(matchFlowJoSamples([well(0, null, 3), well(1, null, 3)], { fileName: d1, fil: "plate.fcs", events: 3, open }))
      .toMatchObject({ matchedOn: null, tiedWith: [d2] });
    // Nor is a sample whose count says it is another data set taken on $FIL.
    expect(matchFlowJoSamples([well(0, null, 2)], { fileName: d1, fil: "plate.fcs", events: 3, open }).matchedOn).toBeNull();
    // Alone of its count, it is still found without asking.
    expect(matchFlowJoSamples([well(0, null, 3)], { fileName: d1, fil: "plate.fcs", events: 3, open: [{ name: d1, events: 3 }, { name: d2, events: 4 }] }))
      .toMatchObject({ matchedOn: "name" });
  });

  it("takes no $FIL another data set of the file carries, and no count a sample without gates shares", () => {
    const d1 = "plate (data set 1 of 2).fcs";
    const d2 = "plate (data set 2 of 2).fcs";
    // $FIL is an acquisition name, not the file on disk, and both data sets carry it.
    const acq = (index: number, events: number) =>
      sample("plate.fcs", index, ["plate.fcs", "acq_run1.fcs"], { dataSetLabel: null, eventCount: events });
    const open = [{ name: d1, events: 3, fil: "acq_run1.fcs" }, { name: d2, events: 3, fil: "acq_run1.fcs" }];
    expect(matchFlowJoSamples([acq(0, 3)], { fileName: d1, fil: "acq_run1.fcs", events: 3, open }))
      .toMatchObject({ matchedOn: null, tiedWith: [d2], tiedOn: "count" });
    // With the counts apart, the shared $FIL still says nothing about which data set this is.
    const apart = [{ name: d1, events: 3, fil: "acq_run1.fcs" }, { name: d2, events: 4, fil: "acq_run1.fcs" }];
    expect(matchFlowJoSamples([acq(0, 5)], { fileName: d1, fil: "acq_run1.fcs", events: 3, open: apart }))
      .toMatchObject({ matchedOn: null, tiedWith: [d2], tiedOn: "fil" });
    // An open data set whose $FIL is not known might carry it too.
    expect(matchFlowJoSamples([acq(0, 5)], { fileName: d1, fil: "acq_run1.fcs", events: 3, open: [{ name: d1, events: 3 }, { name: d2, events: 4 }] })
      .matchedOn).toBeNull();
    // A $FIL naming this data set alone still picks its sample, even where the counts tie.
    const own = (index: number, fil: string) =>
      sample("plate.fcs", index, ["plate.fcs", fil], { dataSetLabel: null, eventCount: 3 });
    expect(matchFlowJoSamples([own(0, "acq_a.fcs"), own(1, "acq_b.fcs")], {
      fileName: d2, fil: "acq_b.fcs", events: 3,
      open: [{ name: d1, events: 3, fil: "acq_a.fcs" }, { name: d2, events: 3, fil: "acq_b.fcs" }],
    }).matches.map((s) => s.index)).toEqual([1]);

    // One gated sample of the count and one without gates: either could be this data set.
    const gated = well(0, null, 3);
    const ungated = { ...well(1, null, 3), gateCount: 0 };
    const alone = [{ name: d1, events: 3, fil: "plate.fcs" }, { name: d2, events: 4, fil: "plate.fcs" }];
    expect(matchFlowJoSamples([gated], { fileName: d1, fil: "plate.fcs", events: 3, open: alone, ungated: [ungated] }))
      .toMatchObject({ matchedOn: null, tiedWith: [], tiedOn: "count", tiedUngated: 1 });
    // One without gates of another count changes nothing.
    expect(matchFlowJoSamples([gated], { fileName: d1, fil: "plate.fcs", events: 3, open: alone, ungated: [{ ...ungated, eventCount: 4 }] }))
      .toMatchObject({ matchedOn: "name" });
  });

  it("resolves a data set a sample without gates could be as unpaired, and counts it as data only when no gated sample could be it", () => {
    const d1 = "plate (data set 1 of 2).fcs";
    const d2 = "plate (data set 2 of 2).fcs";
    const events = new Map([[d1, 3], [d2, 2]]);
    const gated = [well(0, null, 2), well(1, null, 3)];
    const ungated = [{ ...well(2, null, 3), gateCount: 0 }];
    // Resolved together, as the open dialog and the open itself both do: d1 could be either sample of 3.
    expect(resolveFlowJoWorkspaceFiles([...gated, ...ungated], [d1, d2], {}, { events }).map((r) => [r.fileName, r.tiedWith]))
      .toEqual([[d2, undefined], [null, [d1]], [null, [d1]]]);
    // A gated sample could be it, so it is not set aside as data.
    expect([...ungatedWorkspaceFiles(gated, ungated, [d1, d2], {}, { events })]).toEqual([]);
    // Two samples without gates of one count, over two data sets of it: data whichever each is.
    const controls = [{ ...well(2, null, 3), gateCount: 0 }, { ...well(3, null, 3), gateCount: 0 }];
    expect([...ungatedWorkspaceFiles([well(0, null, 2)], controls, [d1, d2], {}, { events: new Map([[d1, 3], [d2, 3]]) })].sort())
      .toEqual([d1, d2]);
  });

  // $SMNO names the tube, and a plate can write the same one on every data set.
  it("takes a well label as saying which data set only where no other data set of the file carries it", () => {
    const t1 = "plate (data set 1 of 2, tube1).fcs";
    const t2 = "plate (data set 2 of 2, tube1).fcs";
    // One count each: the labels say nothing, the counts say which. The first sample holds the
    // second data set's count, so list order pairs each with the other's data set.
    const samples = [well(0, "tube1", 4), well(1, "tube1", 3)];
    expect(resolveFlowJoWorkspaceFiles(samples, [t1, t2], {}, { events: new Map([[t1, 3], [t2, 4]]) }).map((r) => r.fileName))
      .toEqual([t2, t1]);
    const open = [{ name: t1, events: 3 }, { name: t2, events: 4 }];
    expect(matchFlowJoSamples(samples, { fileName: t1, fil: "plate.fcs", events: 3, open }))
      .toMatchObject({ matchedOn: "name", matches: [samples[1]] });
    // One count for both: nothing says which, so neither is paired, in the open or on import.
    const tied = [well(0, "tube1", 3), well(1, "tube1", 3)];
    expect(resolveFlowJoWorkspaceFiles(tied, [t1, t2], {}, { events: new Map([[t1, 3], [t2, 3]]) }).map((r) => [r.fileName, r.tiedWith]))
      .toEqual([[null, [t1, t2]], [null, [t1, t2]]]);
    expect(matchFlowJoSamples([tied[0]], { fileName: t1, fil: "plate.fcs", events: 3, open: [{ name: t1, events: 3 }, { name: t2, events: 3 }] }))
      .toMatchObject({ matchedOn: null, tiedWith: [t2], tiedOn: "count" });
    // A well label the other data set does not carry still says which, whatever the counts.
    const a1 = "plate (data set 1 of 2, A01).fcs";
    const a2 = "plate (data set 2 of 2, A02).fcs";
    expect(resolveFlowJoWorkspaceFiles([well(0, "A02", 3), well(1, "A01", 3)], [a1, a2], {}, { events: new Map([[a1, 3], [a2, 3]]) })
      .map((r) => r.fileName)).toEqual([a2, a1]);
  });

  it("never lets a well label override an event count that disagrees", () => {
    expect(flowJoSampleNamesFile(well(0, "A01", 3), { name: A01, events: 2 })).toBe(false);
    // A count one side does not know leaves the label to decide.
    expect(flowJoSampleNamesFile(well(0, "A01", 3), { name: A01 })).toBe(true);
    expect(flowJoSampleNamesFile({ ...well(0, "A01", 3), eventCount: null }, { name: A01, events: 2 })).toBe(true);
    // The A01 sample holds 3 events and data set A01 two: it is not A01's, and nothing else is.
    const open = [{ name: A01, events: 2 }, { name: A02, events: 3 }];
    expect(matchFlowJoSamples([well(0, "A01", 3)], { fileName: A01, fil: "plate.fcs", events: 2, open }).matches).toEqual([]);
    expect(resolveFlowJoWorkspaceFiles([well(0, "A01", 3)], [A01, A02], {}, { events: new Map([[A01, 2], [A02, 3]]) })[0].fileName)
      .toBeNull();
  });

  it("counts a data set of the file whose count is not known as possibly the sample's", () => {
    const d = (k: number, n = 3) => `plate (data set ${k} of ${n}).fcs`;
    // Data set 3 of 3 is not open: its count is not known, so it could be either sample.
    const samples = [well(0, null, 3), well(1, null, 4)];
    expect(resolveFlowJoWorkspaceFiles(samples, [d(1), d(2)], {}, { events: new Map([[d(1), 3], [d(2), 4]]) })
      .map((r) => [r.fileName, r.tiedWith])).toEqual([[null, [d(1)]], [null, [d(2)]]]);
    expect(matchFlowJoSamples([samples[0]], { fileName: d(1), fil: "plate.fcs", events: 3, open: [{ name: d(1), events: 3 }, { name: d(2), events: 4 }] }))
      .toMatchObject({ matchedOn: null, tiedWith: [], tiedOn: "count", tiedUnopened: 1 });
    // All three open, it is the one data set of its count.
    const all = new Map([[d(1), 3], [d(2), 4], [d(3), 5]]);
    expect(resolveFlowJoWorkspaceFiles(samples, [d(1), d(2), d(3)], {}, { events: all }).map((r) => r.fileName)).toEqual([d(1), d(2)]);
    // Open, with its count not known.
    expect(resolveFlowJoWorkspaceFiles(samples, [d(1), d(2), d(3)], {}, { events: new Map([[d(1), 3], [d(2), 4]]) })
      .map((r) => [r.fileName, r.tiedWith])).toEqual([[null, [d(1), d(3)]], [null, [d(2), d(3)]]]);
    expect(matchFlowJoSamples([samples[0]], {
      fileName: d(1), fil: "plate.fcs", events: 3, open: [{ name: d(1), events: 3 }, { name: d(2), events: 4 }, { name: d(3), events: null }],
    })).toMatchObject({ matchedOn: null, tiedWith: [d(3)], tiedOn: "count" });
    // Nor does a well label say which while a data set that might carry it is not open.
    const w = (k: number, label: string) => `plate (data set ${k} of 3, ${label}).fcs`;
    expect(resolveFlowJoWorkspaceFiles([well(0, "A01", 3)], [w(1, "A01"), w(2, "A02")], {}, { events: new Map([[w(1, "A01"), 3], [w(2, "A02"), 4]]) })[0])
      .toMatchObject({ fileName: null, tiedWith: [w(1, "A01")] });
    // A $FIL no open data set shares may still be carried by one that is not open.
    const own = sample("plate.fcs", 0, ["plate.fcs", "acq_a.fcs"], { dataSetLabel: null, eventCount: 5 });
    expect(matchFlowJoSamples([own], { fileName: d(1), fil: "acq_a.fcs", events: 3, open: [{ name: d(1), events: 3, fil: "acq_a.fcs" }, { name: d(2), events: 4, fil: "acq_b.fcs" }] }))
      .toMatchObject({ matchedOn: null, tiedOn: "fil", tiedUnopened: 1 });
  });

  it("reads each sample's well from its keywords", () => {
    const xml = `<Workspace><SampleList>
      <Sample><DataSet uri="file:/data/plate.fcs" sampleID="1"/><Keywords><Keyword name="$WELLID" value="A01"/></Keywords>
        <SampleNode name="plate.fcs" count="2" sampleID="1"/></Sample>
      <Sample><DataSet uri="file:/data/plate.fcs" sampleID="2"/><Keywords><Keyword name="$SMNO" value="tube 2"/></Keywords>
        <SampleNode name="plate.fcs" count="3" sampleID="2"/></Sample>
      <Sample><DataSet uri="file:/data/d1.fcs" sampleID="3"/><SampleNode name="d1.fcs" count="4" sampleID="3"/></Sample>
    </SampleList></Workspace>`;
    expect(listFlowJoWorkspaceSamples(xml).map((s) => s.dataSetLabel)).toEqual(["A01", "tube 2", null]);
  });
});
