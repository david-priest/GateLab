import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";

const fcs: FcsFile = {
  version: "FCS3.1", nEvents: 5, instrument: "flow", keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
  ],
  columns: [Float32Array.from([10, 20, 30, 40, 50]), Float32Array.from([15, 25, 35, 45, 55])],
  spillover: null,
};

const decode = (b64: string) => Array.from(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

describe("plotPayload point sizes", () => {
  it("carries per-event radii in step with the plotted points, and nothing without them", () => {
    const sample = new Sample(fcs);
    const sizes = Uint8Array.from([0, 12, 24, 36, 48]);
    const all = sample.plotPayload(0, 1, "dots", [], null, null, null, null, Infinity, 5, null, { plotted: true, sizes });
    expect(decode(all.size_b64!)).toEqual([0, 12, 24, 36, 48]);
    // A mask keeps the sizes of the events it keeps.
    const mask = Uint8Array.from([0, 1, 0, 1, 1]);
    const masked = sample.plotPayload(0, 1, "dots", [], mask, null, null, null, Infinity, 5, null, { plotted: true, sizes });
    expect(decode(masked.size_b64!)).toEqual([12, 36, 48]);
    expect(Array.from(masked.plotted!.indices!)).toEqual([1, 3, 4]);
    const plain = sample.plotPayload(0, 1, "dots", [], null, null, null, null, Infinity, 5, null, { plotted: true });
    expect(plain.size_b64).toBeUndefined();
  });
});
