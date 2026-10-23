// A flow file whose SSC holds a few events far above $PnR: the automatic frame stops at $PnR, as
// FlowJo's axis does, and no gate's count moves. Synthetic events; nothing here is a real file.

import { describe, expect, it } from "vitest";
import { robustAxisRange } from "./axisRange";
import { writeFcs } from "./fcsExport";
import { parseFcs } from "./fcs";
import { columnsForGate, getGateMask } from "./gates";
import type { Gate } from "./models";
import { buildWorkspaceAxisRanges } from "./multiSamplePlot";
import { Sample } from "./sample";

const PNR = 262144;

/** 1,000 cells inside FSC 20K–120K, SSC 10K–100K, and 20 events with SSC 5M–12M. */
function sampleWithOutliers(): Sample {
  const n = 1020;
  const fsc = new Float32Array(n);
  const ssc = new Float32Array(n);
  for (let i = 0; i < 1000; i++) {
    fsc[i] = 20_000 + (i % 100) * 1_000;
    ssc[i] = 10_000 + Math.floor(i / 100) * 9_000;
  }
  for (let i = 1000; i < n; i++) {
    fsc[i] = 60_000;
    ssc[i] = 5_000_000 + (i - 1000) * 350_000;
  }
  const bytes = writeFcs([fsc, ssc], [{ name: "FSC-A", desc: "" }, { name: "SSC-A", desc: "" }]);
  const fcs = parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  // writeFcs raises $PnR to hold the data; the instrument's own range is what is under test.
  for (const c of fcs.channels) c.range = PNR;
  return new Sample(fcs);
}

const cells: Gate = {
  gate_id: "cells", name: "Cells", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A",
  vertices: [[15_000, 0], [125_000, 0], [125_000, 200_000], [15_000, 200_000]], color: "#000", label_offset: null,
} as unknown as Gate;

const count = (s: Sample) => getGateMask(cells, columnsForGate(s.gateAssayData(), cells)).reduce((a, b) => a + b, 0);

describe("a flow channel's automatic frame", () => {
  it("stops at $PnR when events lie above it, and the gate around the cells keeps its count", () => {
    const s = sampleWithOutliers();
    const y = s.index("SSC-A")!;
    s.setScatterScale(y, "linear");
    s.setScatterScale(s.index("FSC-A")!, "linear");
    expect(count(s)).toBe(1000);
    const [, hi] = s.displayRange(y);
    expect(hi).toBeGreaterThan(PNR);
    expect(hi).toBeLessThan(PNR * 1.1);
    // Without the ceiling the 20 events (2%) set the frame at millions.
    expect(robustAxisRange(s.displayColumn(y))[1]).toBeGreaterThan(5_000_000);
    expect(count(s)).toBe(1000);
  });

  it("stops there in the frame the workspace's files share", () => {
    const a = sampleWithOutliers();
    const b = sampleWithOutliers();
    for (const s of [a, b]) for (const ch of ["FSC-A", "SSC-A"]) s.setScatterScale(s.index(ch)!, "linear");
    const inputs = [a, b].map((sample, i) => ({
      id: `f${i}`, name: `D${i + 1}.fcs`, sample, xIndex: sample.index("FSC-A")!, yIndex: sample.index("SSC-A")!, mask: null,
    }));
    const ranges = buildWorkspaceAxisRanges(inputs)!;
    expect(ranges.yRange[1]).toBeLessThan(PNR * 1.1);
  });

  it("is not capped for mass cytometry, whose $PnR says nothing about its counts", () => {
    const s = sampleWithOutliers();
    s.setInstrumentMode("cytof");
    expect(s.displayCeiling(s.index("SSC-A")!)).toBeUndefined();
  });
});
