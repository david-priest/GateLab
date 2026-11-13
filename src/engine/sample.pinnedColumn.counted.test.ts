import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";
import { columnsForGate, getGateMask } from "./gates";
import type { PolyRectGate } from "./models";

// A display-space gate is evaluated on a column pushed through the gate's own transform, cached
// per assay binding. Every embedded or external matrix shares one binding key, so the cache has
// to be dropped when the values under that key change.

function flowFile(): FcsFile {
  const names = ["FSC-A", "PE-A", "APC-A"];
  return {
    version: "FCS3.0", nEvents: 2, instrument: "flow", keywords: { $FIL: "synthetic.fcs" },
    spillover: { channels: ["PE-A", "APC-A"], matrix: [[1, 0.1], [0, 1]] },
    channels: names.map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: [Float32Array.from([50_000, 60_000]), Float32Array.from([100, 400]), Float32Array.from([200, 800])],
  } as FcsFile;
}

// A display-space rectangle on APC-A in asinh (cofactor 1), spanning raw 170 to 195.
const gate: PolyRectGate = {
  gate_id: "g", name: "CD4_positive", gate_type: "rectangle", x_channel: "PE-A", y_channel: "APC-A",
  vertices: [[0, Math.asinh(170)], [1000, Math.asinh(170)], [1000, Math.asinh(195)], [0, Math.asinh(195)]], space: "display",
  transforms: { "PE-A": { kind: "identity" }, "APC-A": { kind: "asinh", cofactor: 1 } }, color: "#000", label_offset: null, bounds: "closed",
};
const members = (s: Sample, g: PolyRectGate): number[] => Array.from(getGateMask(g, columnsForGate(s.gateAssayData(), g)));

describe("a display-space gate after the values beneath it change", () => {
  it("is counted under the matrix that replaced the file's own", () => {
    const s = new Sample(flowFile());
    s.setCompensation(true);
    // The file's matrix: APC-A = 200 - 0.1 * 100 = 190 and 800 - 0.1 * 400 = 760.
    expect(members(s, gate)).toEqual([1, 0]);
    s.installExternalSpillover({ channels: ["PE-A", "APC-A"], matrix: [[1, 0.5], [0, 1]] }, "M1", { replaceEmbedded: true });
    s.setCompensation(true);
    // The replacing matrix: APC-A = 150 and 600, both outside 170 to 195.
    expect(Array.from(s.rawColumnData(s.index("APC-A")!))).toEqual([150, 600]);
    expect(members(s, gate)).toEqual([0, 0]);
  });

  it("is counted on a derived channel's new values", () => {
    const s = new Sample(flowFile());
    s.addDerivedChannel({ name: "Objects", feature: "", range: 100, values: Float32Array.from([1, 50]) } as never);
    const onDerived: PolyRectGate = {
      ...gate, gate_id: "d", y_channel: "Objects",
      vertices: [[0, Math.asinh(0)], [1000, Math.asinh(0)], [1000, Math.asinh(10)], [0, Math.asinh(10)]],
      transforms: { "PE-A": { kind: "identity" }, Objects: { kind: "asinh", cofactor: 1 } },
    };
    expect(members(s, onDerived)).toEqual([1, 0]);
    s.addDerivedChannel({ name: "Objects", feature: "", range: 100, values: Float32Array.from([50, 1]) } as never);
    expect(members(s, onDerived)).toEqual([0, 1]);
  });
});
