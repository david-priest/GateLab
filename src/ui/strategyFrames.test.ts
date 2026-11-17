// A flow file with $PnR 2^31, as a FACSDiscover S8 writes, and one event near it: the Strategy tab
// frames its channels as the Gating tab does, not on that event. Synthetic events; nothing here is a
// real file.

import { describe, expect, it } from "vitest";
import { writeFcs } from "../engine/fcsExport";
import { parseFcs } from "../engine/fcs";
import type { Gate } from "../engine/models";
import { Sample } from "../engine/sample";
import { computeRangeFromValues } from "../engine/strategy";
import { strategyFrames } from "./strategyFrames";

const PNR = 2 ** 31;

/** 2,000 cells inside FSC 20K–120K, SSC 10K–100K, and one event at 1.9 billion on both. */
function s8LikeSample(): Sample {
  const n = 2001;
  const fsc = new Float32Array(n);
  const ssc = new Float32Array(n);
  for (let i = 0; i < 2000; i++) {
    fsc[i] = 20_000 + (i % 100) * 1_000;
    ssc[i] = 10_000 + Math.floor(i / 100) * 4_500;
  }
  fsc[2000] = 1.9e9;
  ssc[2000] = 1.9e9;
  const bytes = writeFcs([fsc, ssc], [{ name: "FSC-A", desc: "" }, { name: "SSC-A", desc: "" }]);
  const fcs = parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  for (const c of fcs.channels) c.range = PNR;
  return new Sample(fcs);
}

const cells = {
  gate_id: "cells", name: "Cells", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A",
  vertices: [[15_000, 0], [125_000, 0], [125_000, 200_000], [15_000, 200_000]], color: "#000", label_offset: null,
} as unknown as Gate;

describe("strategyFrames", () => {
  it("frames an unscaled channel as the Gating tab does, where the engine's own fallback reaches the outlier", () => {
    const sample = s8LikeSample();
    const frames = strategyFrames(sample, { cells }, {});
    const fsc = sample.index("FSC-A")!, ssc = sample.index("SSC-A")!;
    expect(frames["FSC-A"]).toEqual(sample.displayRange(fsc));
    expect(frames["SSC-A"]).toEqual(sample.displayRange(ssc));
    // The cells fill the frame: its top is within twice the highest cell.
    expect(frames["FSC-A"][1]).toBeLessThan(240_000);
    expect(frames["SSC-A"][1]).toBeLessThan(200_000);
    // Without it the strategy engine framed the channel on its outermost event.
    expect(computeRangeFromValues(sample.displayColumn(fsc))[1]).toBeGreaterThan(1.9e9);
  });

  it("keeps a global scale, and returns the same object when every channel has one", () => {
    const sample = s8LikeSample();
    const set: Record<string, [number, number]> = { "FSC-A": [0, 2e9] };
    const frames = strategyFrames(sample, { cells }, set);
    expect(frames["FSC-A"]).toEqual([0, 2e9]);
    expect(frames["SSC-A"][1]).toBeLessThan(200_000);
    expect(set).toEqual({ "FSC-A": [0, 2e9] });
    const full: Record<string, [number, number]> = { "FSC-A": [0, 1], "SSC-A": [0, 1] };
    expect(strategyFrames(sample, { cells }, full)).toBe(full);
  });
});
