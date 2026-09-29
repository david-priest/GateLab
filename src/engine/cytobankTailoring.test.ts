// @vitest-environment jsdom
//
// Cytobank writes a gate it tailored for one FCS file as a further element with the same gate_id,
// <tailored>true</tailored> and that file's <fcs_file_filename>. Those elements are the file's
// coordinates, not further gates: imported as gates, they put a second "CD4_positive" carrying D2's
// geometry into the tree of whatever file was loaded. Synthetic file, gate and file names.

import { describe, expect, it } from "vitest";
import { cytobankDocumentForFile, cytobankTailoredFiles, importGatingML } from "./gatingml";
import { CYTOBANK_TAILORED } from "./cytobankTailoring.fixture";

const channels = ["FSC-A", "SSC-A"];
const pnn = { "FSC-A": "FSC-A", "SSC-A": "SSC-A" };
const maxOf = (text: string) => {
  const res = importGatingML(text, channels, pnn, "flow");
  return Object.values(res.gates).map((g) => [g.name, Math.max(...(g as { vertices: [number, number][] }).vertices.map((v) => v[0]))]);
};

describe("a Cytobank file's per-file tailored gates", () => {
  it("names the files it tailors gates for", () => {
    expect(cytobankTailoredFiles(CYTOBANK_TAILORED)).toEqual([{ fileName: "D2.fcs", gates: 1 }]);
  });

  it("imports the experiment's gate once, and never a file's tailored copy as another gate", () => {
    const res = importGatingML(CYTOBANK_TAILORED, channels, pnn, "flow");
    expect(Object.values(res.gates).map((g) => g.name)).toEqual(["CD4_positive"]);
    expect(maxOf(cytobankDocumentForFile(CYTOBANK_TAILORED, null))).toEqual([["CD4_positive", 500]]);
  });

  it("gives the file it was tailored for that file's coordinates, under the experiment gate", () => {
    expect(maxOf(cytobankDocumentForFile(CYTOBANK_TAILORED, "D2.fcs"))).toEqual([["CD4_positive", 900]]);
    expect(maxOf(cytobankDocumentForFile(CYTOBANK_TAILORED, "D1.fcs"))).toEqual([["CD4_positive", 500]]);
  });
});
