// The logicle W shared by the files of a context is the largest of theirs after a file changes
// context or values, as it is after a file is added.
import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";
import { ChannelScales } from "./channelScales";

// PE-A with a wide negative tail (large W) in S2, a narrow one in S1.
function file(name: string, pe: number[]): FcsFile {
  const n = pe.length;
  return {
    version: "FCS3.1", nEvents: n, instrument: "flow", keywords: { $FIL: name },
    spillover: { channels: ["PE-A", "APC-A"], matrix: [[1, 0.2], [0.1, 1]] },
    channels: ["FSC-A", "PE-A", "APC-A"].map((nm, index) => ({ index, name: nm, marker: null, bits: 32, range: 262144 })),
    columns: [Float32Array.from(pe.map((_, i) => 1000 + i)), Float32Array.from(pe), Float32Array.from(pe.map((v) => v * 2 + 500))],
  } as FcsFile;
}
const ramp = (lo: number, hi: number, n = 200) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
const S1 = () => file("S1.fcs", ramp(-20, 50000));
const S2 = () => file("S2.fcs", ramp(-3000, 50000));
const W = (s: Sample) => (s.transformSpec("PE-A") as { W: number }).W;

describe("shared auto W after a file changes context", () => {
  it("is the largest W of the files in the context, whatever was viewed in between", () => {
    const fresh = new ChannelScales();
    const f1 = new Sample(S1()), f2 = new Sample(S2());
    f1.attachChannelScales(fresh); f2.attachChannelScales(fresh);
    const expected = W(f1);
    expect(expected).toBe(Math.max(f1.ownAutoLogicleW(1), f2.ownAutoLogicleW(1)));
    expect(W(f2)).toBe(expected);

    const scales = new ChannelScales();
    const a = new Sample(S1()), b = new Sample(S2());
    a.attachChannelScales(scales); b.attachChannelScales(scales);
    b.setCompensation(true); // S2 viewed compensated...
    W(a); // ...while S1's plot draws on Original
    b.setCompensation(false); // S2 back on Original: same configuration as `fresh`
    expect(W(b)).toBe(expected);
    expect(W(a)).toBe(expected);
  });
});
