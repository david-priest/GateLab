// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  flowJoWorkspaceToGatingML,
  listFlowJoWorkspaceSamples,
  matchFlowJoSamples,
  resolveFlowJoWorkspaceFiles,
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

  (existsSync(S8) ? it : it.skip)("falls back to the node name where no $FIL exists", () => {
    const samples = listFlowJoWorkspaceSamples(readFileSync(S8, "utf8"));
    expect(samples.length).toBeGreaterThan(1);
    for (const s of samples) {
      expect(s.candidateFileNames.length).toBeGreaterThan(0);
      // This vendor records no $FIL at all, so the URI basename and the node name are all there is.
      expect(s.candidateFileNames[0]).toBe(s.name);
      expect(s.trees).toHaveLength(s.rootCount);
    }
  });
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
    expect(r).toEqual({ sampleIndex: 0, fileName: "on disk.fcs", matchedName: "on disk.fcs" });

    // ...and equally if only the acquisition name survived on disk.
    const [byFil] = resolveFlowJoWorkspaceFiles(samples, ["acquired.fcs"]);
    expect(byFil.matchedName).toBe("acquired.fcs");
  });

  it("reports an unmatched sample rather than dropping or guessing it", () => {
    // Partial resolution is normal: import what resolved, name what did not.
    const [r] = resolveFlowJoWorkspaceFiles(samples, ["something else.fcs"]);
    expect(r).toEqual({ sampleIndex: 0, fileName: null, matchedName: null });
  });

  it("never gives one file to two samples", () => {
    // A workspace can list the same file twice. Handing it to both would import one sample's
    // gates under the other's name with nothing to show for it.
    const twice = [...samples.map((s) => ({ ...s })), { ...samples[0], index: 1 }];
    const out = resolveFlowJoWorkspaceFiles(twice, ["on disk.fcs"]);
    expect(out.filter((r) => r.fileName !== null)).toHaveLength(1);
    expect(out[out.length - 1].fileName).toBeNull();
  });

  it("ignores case and extension, as the rest of the matching does", () => {
    const [r] = resolveFlowJoWorkspaceFiles(samples, ["ON DISK.FCS"]);
    expect(r.fileName).toBe("ON DISK.FCS");
  });
});
