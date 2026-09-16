// @vitest-environment jsdom
//
// A gate label must never end up "in the nether". Its offset is a delta in DISPLAY units, so it
// silently changes meaning whenever the axis transform does — and a label flung outside the plot
// used to drag the axis out with it, shrinking a whole dataset into the opposite corner. Reported
// on a .wsp workspace after switching a fluorescence channel from arcsinh to logicle.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildPlotGates } from "./gatePayload";
import { includePlotGatesInAxisRange } from "../engine/axisRange";
import { parseFcs } from "../engine/fcs";
import { Sample } from "../engine/sample";
import { ARIA_SMALL } from "../testFixtures";
import type { Gate } from "../engine/models";

function load(): Sample {
  const b = readFileSync(ARIA_SMALL);
  return new Sample(parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}

const build = (s: Sample, gate: Gate) =>
  buildPlotGates(s, { g: gate }, ["g"], {}, gate.x_channel, gate.y_channel)[0];

describe("a label offset recorded under another transform", () => {
  it("is dropped on a QUADRANT, which has no extent of its own to judge against", () => {
    // The reported case. A quadrant is a single point, so judging the offset against the gate's
    // own extent gave a limit of zero and every stale offset survived.
    const s = load();
    const fluor = s.channels.findIndex((_, i) => s.isFluorChannel(i));
    const key = s.channels[fluor].key;
    const CENTRE: [number, number] = [100, 40000];

    // Place the label at the far edge of the ARCSINH axis — a perfectly ordinary placement
    // there. The offset is derived from the axis rather than guessed, so the test says what it
    // means on any fixture.
    s.setFluorScale(fluor, "arcsinh");
    const frame = s.displayRange(s.index(key)!);
    const offsetX = frame[1] - s.rawToDisplay(key, CENTRE[0]);
    const gate: Gate = {
      gate_id: "g", name: "Q", gate_type: "quadrant",
      x_channel: key, y_channel: "SSC-A",
      center: CENTRE,
      label_offset: [offsetX, 1],
      vertices: [], color: "#888888",
    } as unknown as Gate;

    expect(build(s, gate).label_offset).toEqual([offsetX, 1]);   // kept where it was placed

    // Now read the SAME offset on the logicle axis, which spans a fraction as much: the label
    // would land well outside the plot, so it returns to its default position instead.
    s.setFluorScale(fluor, "logicle");
    const logicleFrame = s.displayRange(s.index(key)!);
    expect(logicleFrame[1] - logicleFrame[0]).toBeLessThan(frame[1] - frame[0]);
    expect(build(s, gate).label_offset).toBeNull();
  });

  it("is judged the same way for each of a quadrant's four labels", () => {
    const s = load();
    const fluor = s.channels.findIndex((_, i) => s.isFluorChannel(i));
    const key = s.channels[fluor].key;
    const CENTRE: [number, number] = [100, 40000];
    s.setFluorScale(fluor, "arcsinh");
    const frame = s.displayRange(s.index(key)!);
    const offsetX = frame[1] - s.rawToDisplay(key, CENTRE[0]);
    const gate: Gate = {
      gate_id: "g", name: "Q", gate_type: "quadrant",
      x_channel: key, y_channel: "SSC-A",
      center: CENTRE, label_offset: null,
      quadrant_label_offsets: [[offsetX, 1], null, [0.2, 0.2], null],
      vertices: [], color: "#888888",
    } as unknown as Gate;
    expect(build(s, gate).quadrant_label_offsets).toEqual([[offsetX, 1], null, [0.2, 0.2], null]);
    // On the logicle axis the far-edge one lands off the plot and returns to its midpoint; the
    // small one still means something and stays.
    s.setFluorScale(fluor, "logicle");
    expect(build(s, gate).quadrant_label_offsets).toEqual([null, null, [0.2, 0.2], null]);
    // A gate without any is passed through without the field.
    const plain = { ...gate } as Gate & { quadrant_label_offsets?: unknown };
    delete plain.quadrant_label_offsets;
    expect("quadrant_label_offsets" in build(s, plain)).toBe(false);
  });

  it("is dropped on a polygon too, judged by where the label lands", () => {
    const s = load();
    const key = s.channels[s.channels.findIndex((_, i) => s.isFluorChannel(i))].key;
    const gate: Gate = {
      gate_id: "g", name: "P", gate_type: "polygon",
      x_channel: key, y_channel: "SSC-A",
      vertices: [[10, 20000], [400, 20000], [400, 60000], [10, 60000]],
      label_offset: [6, 5], color: "#888888",
    } as unknown as Gate;
    expect(build(s, gate).label_offset).not.toEqual([6, 5]);
  });

  it("keeps a modest offset that lands inside the plot", () => {
    // The control: the filter must not throw away ordinary placements.
    const s = load();
    const key = s.channels[s.channels.findIndex((_, i) => s.isFluorChannel(i))].key;
    const [lo, hi] = s.displayRange(s.index(key)!);
    const gate: Gate = {
      gate_id: "g", name: "P", gate_type: "polygon",
      x_channel: key, y_channel: "SSC-A",
      vertices: [[10, 20000], [400, 20000], [400, 60000], [10, 60000]],
      label_offset: [(hi - lo) * 0.1, 0], color: "#888888",
    } as unknown as Gate;
    expect(build(s, gate).label_offset).toEqual([(hi - lo) * 0.1, 0]);
  });
});

describe("a label can never take the axis over", () => {
  const gateWithLabelAt = (offset: number) => ({
    vertices: [[2, 2], [8, 8]],
    label_offset: [offset, offset],
  });

  it("is allowed to nudge the range out, so it is not clipped", () => {
    const out = includePlotGatesInAxisRange([0, 10], [gateWithLabelAt(6)], "x");
    expect(out[1]).toBeGreaterThan(10);
  });

  it("cannot drag the range to reach a label far outside — the reported failure", () => {
    // Geometry spans 2..8 inside a 0..10 base, so the fitted range is 0..10 and a label may add
    // at most a quarter of that. Without the cap this returned a range out past 500.
    const out = includePlotGatesInAxisRange([0, 10], [gateWithLabelAt(500)], "x");
    expect(out[1]).toBeLessThan(10 + 10 * 0.25 + 1);
    // ...and the data still occupies most of the plot rather than a sliver in the corner.
    expect((10 - 0) / (out[1] - out[0])).toBeGreaterThan(0.5);
  });

  it("still lets GEOMETRY set the range without limit", () => {
    // A gate really does belong in view, however far out it sits. Only labels are capped.
    const out = includePlotGatesInAxisRange([0, 10], [{ vertices: [[500, 1], [501, 2]] }], "x");
    expect(out[1]).toBeGreaterThan(500);
  });

  it("measures the allowance against the geometry, so one label cannot enlarge its own room", () => {
    const near = includePlotGatesInAxisRange([0, 10], [gateWithLabelAt(20)], "x");
    const far = includePlotGatesInAxisRange([0, 10], [gateWithLabelAt(2000)], "x");
    expect(far[1]).toBeCloseTo(near[1], 9);
  });
});

describe("a label moved into the plotted range beyond the data", () => {
  it("keeps its offset when the plot's ranges are given, and drops it against the data alone", () => {
    const s = load();
    const xIdx = s.index("FSC-A")!, yIdx = s.index("SSC-A")!;
    const [xlo, xhi] = s.displayRange(xIdx), [ylo, yhi] = s.displayRange(yIdx);
    const gate = {
      gate_id: "g", name: "G", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A", color: "#000",
      vertices: [[s.displayToRaw("FSC-A", xlo + (xhi - xlo) * 0.3), s.displayToRaw("SSC-A", ylo + (yhi - ylo) * 0.3)],
                 [s.displayToRaw("FSC-A", xlo + (xhi - xlo) * 0.6), s.displayToRaw("SSC-A", ylo + (yhi - ylo) * 0.6)]],
      // Far above the data's extent, but inside a plot zoomed out to three times it.
      label_offset: [0, (yhi - ylo) * 1.2],
    } as unknown as Gate;
    const zoomedOut: [[number, number], [number, number]] = [[xlo, xhi], [ylo, ylo + (yhi - ylo) * 3]];
    const kept = buildPlotGates(s, { g: gate }, ["g"], {}, "FSC-A", "SSC-A", null, zoomedOut)[0];
    expect(kept.label_offset).toEqual([0, (yhi - ylo) * 1.2]);
    // Against the data alone the placement is dropped and the automatic one beside the gate takes over.
    const dropped = buildPlotGates(s, { g: gate }, ["g"], {}, "FSC-A", "SSC-A")[0];
    expect(dropped.label_offset).not.toEqual(kept.label_offset);
    expect(Math.abs((dropped.label_offset as [number, number])[1])).toBeLessThan((yhi - ylo) * 0.5);
  });
});

