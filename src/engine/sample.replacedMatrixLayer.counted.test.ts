// A compensated layer left installed and inactive by an instrument-mode round trip does not
// survive the replacement of its matrix: compensation turned on afterwards uses the matrix now
// installed.
import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";

function flowFile(): FcsFile {
  return {
    version: "FCS3.1", nEvents: 2, instrument: "flow", keywords: { $FIL: "S1.fcs" },
    spillover: { channels: ["PE-A", "APC-A"], matrix: [[1, 0.1], [0, 1]] },
    channels: ["FSC-A", "PE-A", "APC-A"].map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: [Float32Array.from([50_000, 60_000]), Float32Array.from([100, 400]), Float32Array.from([200, 800])],
  } as FcsFile;
}
const M2 = { channels: ["PE-A", "APC-A"], matrix: [[1, 0.5], [0, 1]] };

describe("matrix replaced after an instrument-mode round trip", () => {
  it("compensates with the matrix now installed, as a fresh sample does", () => {
    const s = new Sample(flowFile());
    s.setCompensation(true); // APC-A = 190, 760 under the file's matrix
    s.setInstrumentMode("cytof"); // layer goes stale and inactive, but stays installed
    s.setInstrumentMode("auto"); // flow again: compensation shows as off
    expect(s.compensationEnabled).toBe(false);
    s.installExternalSpillover(M2, "M2", { replaceEmbedded: true });
    s.setCompensation(true);

    const f = new Sample(flowFile());
    f.installExternalSpillover(M2, "M2", { replaceEmbedded: true });
    f.setCompensation(true);
    const apc = (x: Sample) => Array.from(x.rawColumnData(x.index("APC-A")!));
    // M2: APC-A = 200 - 0.5 * 100 = 150 and 800 - 0.5 * 400 = 600.
    expect(apc(f)).toEqual([150, 600]);
    expect(apc(s)).toEqual([150, 600]);
  });

  it("restoreSpillover to a snapshot with another matrix does not revive the old layer", () => {
    const s = new Sample(flowFile());
    const ownSnapshot = s.spilloverSnapshot();
    s.installExternalSpillover(M2, "M2", { replaceEmbedded: true });
    s.setCompensation(true); // M2 layer
    s.setInstrumentMode("cytof");
    s.setInstrumentMode("auto");
    s.restoreSpillover({ ...ownSnapshot, compensationEnabled: true });
    // The file's own matrix: APC-A = 190, 760.
    expect(Array.from(s.rawColumnData(s.index("APC-A")!))).toEqual([190, 760]);
  });
});
