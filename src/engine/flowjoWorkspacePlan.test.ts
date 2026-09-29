// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  flowJoWorkspaceToGatingML,
  listFlowJoWorkspaceSamples,
  matchFlowJoSamples,
  pairFlowJoWorkspaceFiles,
  resolveFlowJoWorkspaceFiles,
  ungatedWorkspaceFiles,
  type FlowJoSampleSummary,
  type FlowJoWorkspaceFile,
} from "./flowjoWorkspace";

const ROOT =
  "/Users/davidpriest/My Drive (davidpriest@cider.osaka-u.ac.jp)/Wing Lab/Large Projects/" +
  "GateLab Paper/GateLab-2026-08-15-B flowjo-and-cytobank-concordance/data";
const S6 = `${ROOT}/bass12-priest2024-s6/source/flowjo-workspace/25-Sep-2023.wsp`;
const S8 = `${ROOT}/lp4-igcb-s8/source/flowjo-workspace/17-Dec-2025 new.wsp`;

/**
 * What an importer needs to open a workspace without an FCS already loaded: which files each
 * sample could be, and which independent strategies it holds. Both are read from real
 * workspaces because the two vendors disagree about every one of these fields.
 */
describe("planning a FlowJo workspace before any FCS is loaded", () => {
  (existsSync(S6) ? it : it.skip)("prefers the recorded path over the sample's own name", () => {
    const [s] = listFlowJoWorkspaceSamples(readFileSync(S6, "utf8"));
    // The node is named after the acquisition, not the file. Matching on it alone finds nothing.
    expect(s.name).toBe("19319.fcs");
    // The DataSet URI is the path FlowJo read, so its basename is the real file name, and it
    // must come first.
    expect(s.candidateFileNames[0]).toBe("Specimen_001_B cell presort.fcs");
    expect(s.candidateFileNames).toContain("19319.fcs");
  });

  (existsSync(S6) ? it : it.skip)("finds the sample from the file name on disk", () => {
    const samples = listFlowJoWorkspaceSamples(readFileSync(S6, "utf8"));
    const { matches, matchedOn } = matchFlowJoSamples(samples, {
      fileName: "Specimen_001_B cell presort.fcs",
    });
    expect(matchedOn).toBe("name");
    expect(matches).toHaveLength(1);
  });

  (existsSync(S6) ? it : it.skip)("summarises the one tree it holds", () => {
    const [s] = listFlowJoWorkspaceSamples(readFileSync(S6, "utf8"));
    expect(s.trees).toHaveLength(1);
    expect(s.rootCount).toBe(1);
    expect(s.trees[0]).toMatchObject({ index: 0, name: "FSC SSC", gateCount: 18, unsupportedCount: 0 });
    expect(s.trees[0].populations).toHaveLength(18);
    expect(s.trees[0].populations).toContain("CD45RB+ Actmem");
  });

  // A real workspace: 2.3 s alone, and past the default 5 s in full runs on a loaded machine.
  (existsSync(S8) ? it : it.skip)("falls back to the node name where no $FIL exists", () => {
    const samples = listFlowJoWorkspaceSamples(readFileSync(S8, "utf8"));
    expect(samples.length).toBeGreaterThan(1);
    for (const s of samples) {
      expect(s.candidateFileNames.length).toBeGreaterThan(0);
      // This vendor records no $FIL at all, so the URI basename and the node name are all there is.
      expect(s.candidateFileNames[0]).toBe(s.name);
      expect(s.trees).toHaveLength(s.rootCount);
    }
  }, 30_000);
});

/** A workspace holding two independent strategies for one sample. GateLab can hold only one. */
const TWO_TREES = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0" flowJoVersion="10.9.0"
    xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
    xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <SampleList><Sample>
    <DataSet uri="file:/data/on%20disk.fcs" />
    <Keywords><Keyword name="$FIL" value="acquired.fcs" /></Keywords>
    <SampleNode name="node.fcs" count="1000">
      <Subpopulations>
        <Population name="Lymphocytes" count="800"><Gate><gating:RectangleGate>
          <gating:dimension gating:min="1" gating:max="9"><data-type:fcs-dimension data-type:name="FSC-A" /></gating:dimension>
          <gating:dimension gating:min="1" gating:max="9"><data-type:fcs-dimension data-type:name="SSC-A" /></gating:dimension>
        </gating:RectangleGate></Gate>
          <Subpopulations><Population name="T cells" count="400"><Gate><gating:RectangleGate>
            <gating:dimension gating:min="1" gating:max="9"><data-type:fcs-dimension data-type:name="FSC-A" /></gating:dimension>
            <gating:dimension gating:min="1" gating:max="9"><data-type:fcs-dimension data-type:name="SSC-A" /></gating:dimension>
          </gating:RectangleGate></Gate></Population></Subpopulations>
        </Population>
        <Population name="Beads" count="60"><Gate><gating:RectangleGate>
          <gating:dimension gating:min="2" gating:max="8"><data-type:fcs-dimension data-type:name="FSC-A" /></gating:dimension>
          <gating:dimension gating:min="2" gating:max="8"><data-type:fcs-dimension data-type:name="SSC-A" /></gating:dimension>
        </gating:RectangleGate></Gate></Population>
      </Subpopulations>
    </SampleNode>
  </Sample></SampleList>
</Workspace>`;

describe("choosing one of several gating trees", () => {
  it("lists each tree with its own shape", () => {
    const [s] = listFlowJoWorkspaceSamples(TWO_TREES);
    expect(s.rootCount).toBe(2);
    expect(s.trees.map((t) => [t.name, t.gateCount, t.rootCount])).toEqual([
      ["Lymphocytes", 2, 800],
      ["Beads", 1, 60],
    ]);
    // Every recorded name is offered, best first.
    expect(s.candidateFileNames).toEqual(["on disk.fcs", "node.fcs", "acquired.fcs"]);
  });

  it("imports only the chosen tree", () => {
    const one = flowJoWorkspaceToGatingML(TWO_TREES, 0, 0);
    expect(Object.keys(one.flowJoCounts).sort()).toEqual(["Lymphocytes", "T cells"]);
    expect(one.warnings).toEqual([]);

    const two = flowJoWorkspaceToGatingML(TWO_TREES, 0, 1);
    expect(Object.keys(two.flowJoCounts)).toEqual(["Beads"]);
  });

  it("says so when no choice is made and the strategies are merged", () => {
    // Importing everything silently would combine strategies FlowJo deliberately kept apart.
    const all = flowJoWorkspaceToGatingML(TWO_TREES, 0, null);
    expect(Object.keys(all.flowJoCounts).sort()).toEqual(["Beads", "Lymphocytes", "T cells"]);
    expect(all.warnings.join(" ")).toMatch(/2 independent gating trees/);
  });

  it("refuses a tree that does not exist rather than importing the wrong one", () => {
    expect(() => flowJoWorkspaceToGatingML(TWO_TREES, 0, 5)).toThrow(/no gating tree at position 6/);
  });
});

describe("resolving a workspace's samples against the files a user supplies", () => {
  const samples = listFlowJoWorkspaceSamples(TWO_TREES);

  it("matches on any recorded name, and says which one it used", () => {
    // The user picks the file as it is on disk; the workspace calls the sample something else.
    const [r] = resolveFlowJoWorkspaceFiles(samples, ["on disk.fcs"]);
    expect(r).toMatchObject({ sampleIndex: 0, fileName: "on disk.fcs", matchedName: "on disk.fcs", status: "own" });

    // ...and equally if only the acquisition name survived on disk.
    const [byFil] = resolveFlowJoWorkspaceFiles(samples, ["acquired.fcs"]);
    expect(byFil.matchedName).toBe("acquired.fcs");
  });

  it("reports an unmatched sample rather than dropping or guessing it", () => {
    // Partial resolution is normal: import what resolved, name what did not.
    const [r] = resolveFlowJoWorkspaceFiles(samples, ["something else.fcs"]);
    expect(r).toMatchObject({ sampleIndex: 0, fileName: null, matchedName: null, status: "missing" });
  });

  it("never gives one file to two samples, nor to the first of two it could be", () => {
    // A workspace can list the same file twice. Handing it to both would import one sample's
    // gates under the other's name; handing it to the first in document order was a guess. With
    // nothing recorded to tell them apart, the user is asked.
    const twice = [...samples.map((s) => ({ ...s })), { ...samples[0], index: 1 }];
    const pairing = pairFlowJoWorkspaceFiles(twice, ["on disk.fcs"]);
    expect(pairing.resolutions.filter((r) => r.fileName !== null)).toHaveLength(0);
    expect(pairing.ambiguous).toEqual([{ fileKey: "on disk.fcs", fileName: "on disk.fcs", candidates: [0, 1] }]);
    // The user's answer pairs it.
    const chosen = pairFlowJoWorkspaceFiles(twice, ["on disk.fcs"], { "on disk.fcs": 1 }).resolutions;
    expect(chosen.map((r) => r.status)).toEqual(["missing", "chosen"]);
  });

  it("gives a read single-data-set file that two wells' samples name to the one its keywords confirm, sharing or not", () => {
    // Two samples named like one file under different well labels. The open dialog lets such a
    // file stand for each (shareAcrossWells) because a file not yet read may hold one data set per
    // well. This file has been read: its $NEXTDATA is 0, so it holds one data set, and its keywords
    // say which sample it is. Shared anyway, it went to both as unconfirmed, and the dialog took
    // the other acquisition's tree for it by position.
    const recordedA = { $TOT: "5", $BTIM: "10:00:00", $DATE: "01-JAN-2020" };
    const recordedB = { $TOT: "7", $BTIM: "11:00:00", $DATE: "02-JAN-2020" };
    const s0 = { ...samples[0], index: 0, candidateFileNames: ["D1.fcs"], dataSetLabel: "A01", recorded: recordedA };
    const s1 = { ...samples[0], index: 1, candidateFileNames: ["D1.fcs"], dataSetLabel: "B02", recorded: recordedB };
    const read: FlowJoWorkspaceFile = { key: "k-d1", name: "D1.fcs", keywords: { ...recordedB, $NEXTDATA: "0" } };
    for (const opts of [{}, { shareAcrossWells: true }]) {
      const pairing = pairFlowJoWorkspaceFiles([s0, s1], [read], {}, opts);
      expect(pairing.resolutions.map((r) => [r.sampleIndex, r.status, r.fileKey])).toEqual([[0, "contradicted", null], [1, "own", "k-d1"]]);
      expect(pairing.resolutions[1].comparison?.verdict).toBe("confirmed");
    }
    // Not yet read, or read and pointing to a further data set, it may hold both wells: it stands
    // for each until it is read and split.
    for (const keywords of [null, { ...recordedA, $NEXTDATA: "4096" }]) {
      const shared = pairFlowJoWorkspaceFiles([s0, s1], [{ ...read, keywords }], {}, { shareAcrossWells: true });
      expect(shared.resolutions.map((r) => r.fileKey)).toEqual(["k-d1", "k-d1"]);
    }
  });

  it("pairs a file and a copy of it under another name with their sample, both of them", () => {
    // D1.fcs is the sample by its name; copy.fcs is the same acquisition, found by its $FIL. Two
    // files claiming one sample left it with neither, and both followed another sample's tree.
    const kw = { $TOT: "3", $BTIM: "10:00:00", $ETIM: "10:01:00", GUID: "g-1" };
    const s0 = { ...samples[0], candidateFileNames: ["D1.fcs", "acquired D1.fcs"], recorded: kw };
    const files = [
      { key: "k-copy", name: "copy.fcs", keywords: { ...kw, $FIL: "acquired D1.fcs" } },
      { key: "k-d1", name: "D1.fcs", keywords: { ...kw, $FIL: "acquired D1.fcs" } },
    ];
    const pairing = pairFlowJoWorkspaceFiles([s0], files);
    // The file named like the sample stands for it; the copy is the sample too.
    expect(pairing.resolutions[0]).toMatchObject({ status: "own", fileKey: "k-d1", copies: [{ fileKey: "k-copy", fileName: "copy.fcs" }] });
    expect(pairing.unpaired).toEqual([]);
    expect(pairing.contested).toEqual([]);
  });

  it("asks once which file is the sample when two could be and they are not one acquisition", () => {
    // The sample records nothing, and the two files record different acquisitions: either could
    // be it. The row read "could be this sample or , and ...", naming no other sample.
    const s0 = { ...samples[0], candidateFileNames: ["D1.fcs"], recorded: {} };
    const files: FlowJoWorkspaceFile[] = [
      { key: "k-a", name: "D1.fcs", keywords: { $BTIM: "10:00:00" } },
      { key: "k-b", name: "other.fcs", keywords: { $BTIM: "11:00:00", $FIL: "D1.fcs" } },
    ];
    const pairing = pairFlowJoWorkspaceFiles([s0], files);
    expect(pairing.resolutions[0]).toMatchObject({ status: "ambiguous", fileKey: null });
    expect(pairing.resolutions[0].near?.rivals?.map((f) => f.fileName)).toEqual(["D1.fcs", "other.fcs"]);
    expect(pairing.contested).toEqual([{ sampleIndex: 0, files: [{ fileKey: "k-a", fileName: "D1.fcs" }, { fileKey: "k-b", fileName: "other.fcs" }] }]);
    expect(pairing.unpaired.map((u) => u.rivals)).toEqual([["other.fcs"], ["D1.fcs"]]);
    // Saying which pairs it, and the other file is named as not it.
    const chosen = pairFlowJoWorkspaceFiles([s0], files, { "k-b": 0 });
    expect(chosen.resolutions[0]).toMatchObject({ status: "chosen", fileKey: "k-b" });
    expect(chosen.unpaired).toEqual([expect.objectContaining({ fileKey: "k-a", pairedWith: "other.fcs" })]);
    expect(chosen.contested).toEqual([]);
  });

  it("asks once per acquisition, and pairs the chosen file's copy with it", () => {
    // The sample records nothing. D1.fcs and copy.fcs are one acquisition (copy.fcs by its $FIL);
    // the second D1.fcs is another. The question offered the copy as a third rival, and once the
    // first D1.fcs was chosen the copy was left unpaired and followed another sample's tree.
    const s0 = { ...samples[0], candidateFileNames: ["D1.fcs"], recorded: {} };
    const acq1 = { $BTIM: "10:00:00", $ETIM: "10:01:00" };
    const files: FlowJoWorkspaceFile[] = [
      { key: "k-a", name: "D1.fcs", keywords: acq1 },
      { key: "k-copy", name: "copy.fcs", keywords: { ...acq1, $FIL: "D1.fcs" } },
      { key: "k-b", name: "D1.fcs", keywords: { $BTIM: "11:00:00" } },
    ];
    const pairing = pairFlowJoWorkspaceFiles([s0], files);
    expect(pairing.contested).toEqual([{ sampleIndex: 0, files: [
      { fileKey: "k-a", fileName: "D1.fcs", copies: [{ fileKey: "k-copy", fileName: "copy.fcs" }] },
      { fileKey: "k-b", fileName: "D1.fcs" },
    ] }]);
    // The copy is said to go with its file, not listed as a rival of it.
    expect(pairing.unpaired.find((u) => u.fileKey === "k-copy")).toMatchObject({ copyOf: "D1.fcs", copyOfKey: "k-a", rivals: ["D1.fcs"], rivalKeys: ["k-b"] });
    const chosen = pairFlowJoWorkspaceFiles([s0], files, { "k-a": 0 });
    expect(chosen.resolutions[0]).toMatchObject({ status: "chosen", fileKey: "k-a", copies: [{ fileKey: "k-copy", fileName: "copy.fcs" }] });
    expect(chosen.unpaired).toEqual([expect.objectContaining({ fileKey: "k-b", pairedWith: "D1.fcs", pairedWithKey: "k-a" })]);
    expect(chosen.contested).toEqual([]);
    // Choosing the copy chooses its acquisition: the file named like the sample goes with it.
    const byCopy = pairFlowJoWorkspaceFiles([s0], files, { "k-copy": 0 });
    expect(byCopy.resolutions[0]).toMatchObject({ status: "chosen", fileKey: "k-a", copies: [{ fileKey: "k-copy", fileName: "copy.fcs" }] });
  });

  it("names a file that could be the sample, though another could more surely", () => {
    // The sample records $TOT; the two D1.fcs files agree on it, and copy.fcs, which carries no
    // $TOT, is named by its $FIL. It was in no pairing and in no list of unpaired files.
    const s0 = { ...samples[0], candidateFileNames: ["D1.fcs"], recorded: { $TOT: "3" } };
    const files: FlowJoWorkspaceFile[] = [
      { key: "k-a", name: "D1.fcs", keywords: { $TOT: "3", $BTIM: "10:00:00" } },
      { key: "k-b", name: "D1.fcs", keywords: { $TOT: "3", $BTIM: "11:00:00" } },
      { key: "k-c", name: "copy.fcs", keywords: { $BTIM: "12:00:00", $FIL: "D1.fcs" } },
    ];
    const pairing = pairFlowJoWorkspaceFiles([s0], files);
    expect(pairing.contested.map((c) => c.files.map((f) => f.fileKey))).toEqual([["k-a", "k-b"]]);
    expect(pairing.unpaired.find((u) => u.fileKey === "k-c")).toMatchObject({ why: "ambiguous", candidates: [0], rivalKeys: ["k-a", "k-b"] });
  });

  it("names every file two samples of one name could each be, not the last one read", () => {
    // Two samples of one name record nothing; D1.fcs and copy.fcs could each be either. The row
    // named only copy.fcs: each file read overwrote the one before it.
    const twins = [
      { ...samples[0], index: 0, candidateFileNames: ["D1.fcs"], recorded: {} },
      { ...samples[0], index: 1, candidateFileNames: ["D1.fcs"], recorded: {} },
    ];
    const acq1 = { $BTIM: "10:00:00", $ETIM: "10:01:00" };
    const pairing = pairFlowJoWorkspaceFiles(twins, [
      { key: "k-a", name: "D1.fcs", keywords: acq1 },
      { key: "k-copy", name: "copy.fcs", keywords: { ...acq1, $FIL: "D1.fcs" } },
    ]);
    expect(pairing.resolutions.map((r) => r.near?.files?.map((f) => f.fileKey))).toEqual([["k-a", "k-copy"], ["k-a", "k-copy"]]);
    expect(pairing.resolutions.map((r) => r.near?.others)).toEqual([[1], [0]]);
  });

  it("ignores case and extension, as the rest of the matching does", () => {
    const [r] = resolveFlowJoWorkspaceFiles(samples, ["ON DISK.FCS"]);
    expect(r.fileName).toBe("ON DISK.FCS");
  });
});

describe("the files of samples that carry no gates", () => {
  const summary = (index: number, name: string, gateCount: number): FlowJoSampleSummary => ({
    index, name, owningGroup: "", duplicateName: false,
    rootCount: 1, eventCount: 1000, gateCount, unsupportedCount: 0,
    candidateFileNames: [name],
    trees: [],
  });
  const gated = [summary(0, "stained D1.fcs", 6)];
  const ungated = [summary(1, "unstained.fcs", 0), summary(2, "single stain B1.fcs", 0)];

  it("names the files that load as data, and not the one the strategy was drawn on", () => {
    // Compensation controls come in beside the stained sample with no gates of their own, so
    // they must stay out of a pooled view gated by a strategy that was never drawn on them.
    const out = ungatedWorkspaceFiles(gated, ungated,
      ["STAINED D1.fcs", "unstained.fcs", "single stain B1.fcs", "unrelated.fcs"]);
    expect([...out].sort()).toEqual(["single stain B1.fcs", "unstained.fcs"]);
  });

  it("names both copies of an ungated sample's acquisition as data", () => {
    const kw = { $TOT: "3", $BTIM: "09:00:00" };
    const u = { ...summary(1, "unstained.fcs", 0), recorded: kw };
    const out = ungatedWorkspaceFiles(gated, [u], [
      { key: "a", name: "unstained.fcs", keywords: kw },
      { key: "b", name: "unstained copy.fcs", keywords: { ...kw, $FIL: "unstained.fcs" } },
    ]);
    expect([...out].sort()).toEqual(["a", "b"]);
  });

  it("gives a file both could claim to neither, when nothing tells them apart", () => {
    const twin = [summary(3, "stained D1.fcs", 0)];
    expect(ungatedWorkspaceFiles(gated, twin, ["stained D1.fcs"]).size).toBe(0);
  });

  it("gives a file to the ungated sample its keywords say it is, not to a gated one of the same name", () => {
    // A compensation control added twice, once gated and once not; the file is the ungated one's
    // acquisition. The gated sample used to win it, and its gates went onto the control.
    const g = { ...summary(0, "cd4 stained control.fcs", 3), recorded: { $TOT: "10000", $BTIM: "10:00:00" } };
    const u = { ...summary(1, "cd4 stained control.fcs", 0), recorded: { $TOT: "10000", $BTIM: "11:30:00" } };
    const file = { key: "k1", name: "cd4 stained control.fcs", keywords: { $TOT: "10000", $BTIM: "11:30:00" } };
    expect([...ungatedWorkspaceFiles([g], [u], [file])]).toEqual(["k1"]);
    const [gr] = resolveFlowJoWorkspaceFiles([g, u], [file]);
    expect(gr.status).toBe("contradicted");
  });
});
