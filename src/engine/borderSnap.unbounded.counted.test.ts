import { describe, expect, it } from "vitest";
import { snapGatesToBorders } from "./borderSnap";
import type { FcsFile } from "./fcs";
import { columnsForGate, getGateMask } from "./gates";
import { UNBOUNDED, type PolyRectGate } from "./models";
import { Sample } from "./sample";

// A rectangle side with no bound is held as a sentinel and drawn far off the plot. The snap takes
// every vertex to the display and back, which must not turn that side into a bound.

function flowFile(): FcsFile {
  return {
    version: "FCS3.0", nEvents: 4, instrument: "flow", keywords: { $FIL: "synthetic.fcs" }, spillover: null,
    channels: ["FSC-A", "FL2-A"].map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    // FL2-A is 0 for two events, which a standard flog places at -Infinity.
    columns: [Float32Array.from([100, 200, 300, 400]), Float32Array.from([0, 0, 50, 500])],
  } as FcsFile;
}
const members = (s: Sample, g: PolyRectGate): number[] => Array.from(getGateMask(g, columnsForGate(s.gateAssayData(), g)));

describe("border snap of a rectangle with a side that has no bound", () => {
  it("lands the near side on the border and leaves the open sides open", () => {
    const s = new Sample(flowFile());
    const gate: PolyRectGate = {
      gate_id: "r", name: "CD4_positive", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "FL2-A", space: "raw", bounds: "half-open",
      vertices: [[50.2, -UNBOUNDED], [UNBOUNDED, -UNBOUNDED], [UNBOUNDED, UNBOUNDED], [50.2, UNBOUNDED]], color: "#000", label_offset: null,
    };
    expect(members(s, gate)).toEqual([1, 1, 1, 1]);
    // The view's x runs from 50 to 1000 over 500 px: the lower x side is 0.1 px from the border.
    const edits = snapGatesToBorders({ r: gate }, s as never, { xKey: "FSC-A", yKey: "FL2-A", xRange: [50, 1000], yRange: [-1, 5], widthPx: 500, heightPx: 400 });
    expect(edits).toEqual([{ gateId: "r", vertices: [[50, -UNBOUNDED], [UNBOUNDED, -UNBOUNDED], [UNBOUNDED, UNBOUNDED], [50, UNBOUNDED]] }]);
    expect(members(s, { ...gate, vertices: edits[0].vertices })).toEqual([1, 1, 1, 1]);
  });

  it("keeps a display-space log gate's open lower side, its events at zero, and vertices a workspace can hold", () => {
    const s = new Sample(flowFile());
    const gate: PolyRectGate = {
      gate_id: "r", name: "CD8_low", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "FL2-A", space: "display", bounds: "half-open",
      vertices: [[50.2, -UNBOUNDED], [1e6, -UNBOUNDED], [1e6, 0.9], [50.2, 0.9]], color: "#000", label_offset: null,
      transforms: { "FSC-A": { kind: "identity" }, "FL2-A": { kind: "flog", T: 262144, M: 4.5, standard: true } },
    };
    const before = members(s, gate);
    expect(before).toEqual([1, 1, 1, 1]);
    const yRange: [number, number] = [s.rawToDisplay("FL2-A", 1), s.rawToDisplay("FL2-A", 262144)];
    const edits = snapGatesToBorders({ r: gate }, s as never, { xKey: "FSC-A", yKey: "FL2-A", xRange: [50, 1000], yRange, widthPx: 500, heightPx: 400 });
    expect(edits).toHaveLength(1);
    const vertices = edits[0].vertices;
    expect(vertices.map((v) => v[0])).toEqual([50, 1e6, 1e6, 50]);
    expect(vertices.map((v) => v[1])).toEqual([-UNBOUNDED, -UNBOUNDED, 0.9, 0.9]);
    expect(JSON.parse(JSON.stringify(vertices))).toEqual(vertices);
    expect(members(s, { ...gate, vertices })).toEqual(before);
  });
});
