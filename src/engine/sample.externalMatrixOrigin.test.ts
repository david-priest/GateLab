// The record of an external matrix says it replaced the file's own matrix only where the file
// has one, however many external matrices came before.
import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";

function fileWithoutMatrix(): FcsFile {
  return {
    version: "FCS3.1", nEvents: 2, instrument: "flow", keywords: { $FIL: "S1.fcs" }, spillover: null,
    channels: ["FSC-A", "PE-A", "APC-A"].map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: [Float32Array.from([50_000, 60_000]), Float32Array.from([100, 400]), Float32Array.from([200, 800])],
  } as FcsFile;
}
const M1 = { channels: ["PE-A", "APC-A"], matrix: [[1, 0.1], [0, 1]] };
const M2 = { channels: ["PE-A", "APC-A"], matrix: [[1, 0.5], [0, 1]] };

describe("external matrix origin on a file with no matrix of its own", () => {
  it("does not claim to replace the file's own matrix after a second external matrix", () => {
    const fresh = new Sample(fileWithoutMatrix());
    fresh.installExternalSpillover(M2, "M2");
    expect(fresh.spilloverOrigin).toMatchObject({ kind: "external", replacedEmbedded: false, maxDeviationFromEmbedded: null });

    const s = new Sample(fileWithoutMatrix());
    s.installExternalSpillover(M1, "M1");
    // App.tsx passes replaceEmbedded: target.spillover !== null, true here.
    s.installExternalSpillover(M2, "M2", { replaceEmbedded: true });
    expect(s.spilloverOrigin).toMatchObject({ kind: "external", replacedEmbedded: false, maxDeviationFromEmbedded: null });
  });
});
