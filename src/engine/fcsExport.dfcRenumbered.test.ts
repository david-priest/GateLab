// An export of some of a file's parameters writes each FCS 2.0 $DFCiTOj under the export's parameter
// numbers when both parameters are exported, and leaves it out when either is not.
import { describe, expect, it } from "vitest";
import { parseFcs, type FcsFile } from "./fcs";
import { Sample } from "./sample";
import { exportPopulationFcs } from "./fcsExport";

const toAB = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

describe("$DFCiTOj in an export of a channel subset", () => {
  it("renumbers a pair that is exported and drops a pair that is not", () => {
    // Two raw detectors, which GateLab does not offer as channels, and two unmixed channels,
    // which are exported as $P1 and $P2.
    const names = ["V1-A", "V2-A", "FL3-A", "FL4-A"];
    const fcs: FcsFile = {
      version: "FCS2.0",
      nEvents: 2,
      channels: names.map((name, index) => ({ index, name, marker: [null, null, "FITC-A", "PE-A"][index], bits: 32, range: 262144 })),
      keywords: { $DFC3TO4: "12.5", $DFC4TO3: "3.5", $DFC1TO3: "7", $DFC2TO1: "9" },
      columns: names.map((_, c) => Float32Array.from([c + 1, c + 5])),
      spillover: null,
      instrument: "flow",
    };
    const sample = new Sample(fcs);
    expect(sample.channels.map((c) => c.pnn)).toEqual(["FL3-A", "FL4-A"]);

    const out = parseFcs(toAB(exportPopulationFcs(sample, null, "original")));
    expect(out.channels.map((c) => c.name)).toEqual(["FL3-A", "FL4-A"]);
    const dfc = Object.fromEntries(Object.entries(out.keywords).filter(([k]) => /^\$DFC\d+TO\d+$/i.test(k)));
    expect(dfc).toEqual({ $DFC1TO2: "12.5", $DFC2TO1: "3.5" });
  });
});
