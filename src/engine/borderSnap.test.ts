// A pan or stretch that leaves a gate side within the snap distance of a plot border lands it
// there; anything further away is left where the view put it. Synthetic gates throughout.

import { describe, expect, it } from "vitest";
import { snapGatesToBorders } from "./borderSnap";
import type { Gate } from "./models";

const identity = { gateToDisplay: (_g: unknown, _c: string, v: number) => v, displayToGate: (_g: unknown, _c: string, v: number) => v };
const view = { xKey: "FSC-A", yKey: "SSC-A", xRange: [0, 100] as [number, number], yRange: [0, 200] as [number, number], widthPx: 500, heightPx: 400 };
const poly = (id: string, vertices: [number, number][], x = "FSC-A", y = "SSC-A"): Gate =>
  ({ gate_id: id, name: id, gate_type: "polygon", x_channel: x, y_channel: y, vertices, color: "#000", label_offset: null });

describe("snap to the plot borders after a pan or stretch", () => {
  it("lands a vertex within 6 px of a border on it and leaves the rest alone", () => {
    // 5 px per x unit, 2 px per y unit: 1 unit in x is 5 px, 2 units in y is 4 px.
    const gates = { a: poly("a", [[0.5, 50], [60, 50], [60, 198], [0.5, 198]]), far: poly("far", [[10, 50], [60, 50], [60, 150]]) };
    const edits = snapGatesToBorders(gates, identity, view);
    expect(edits).toEqual([{ gateId: "a", vertices: [[0, 50], [60, 50], [60, 200], [0, 200]] }]);
  });

  it("uses the gate's own axes when the plot shows it flipped, and skips gates on other channels", () => {
    const flipped = poly("f", [[199, 1], [199, 60], [100, 60]], "SSC-A", "FSC-A");
    const other = poly("o", [[0.5, 1], [10, 10], [1, 10]], "FSC-A", "FL1-A");
    expect(snapGatesToBorders({ f: flipped, o: other }, identity, view)).toEqual([{ gateId: "f", vertices: [[200, 0], [200, 60], [100, 60]] }]);
  });

  it("snaps a rectangle's bounds, so it stays a rectangle", () => {
    const rect: Gate = { gate_id: "r", name: "r", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A", vertices: [[0.4, 10], [99.2, 10], [99.2, 199], [0.4, 199]], color: "#000", label_offset: null };
    expect(snapGatesToBorders({ r: rect }, identity, view)).toEqual([{ gateId: "r", vertices: [[0, 10], [100, 10], [100, 200], [0, 200]] }]);
  });

  it("does nothing on a degenerate view", () => {
    expect(snapGatesToBorders({ a: poly("a", [[0.5, 1], [2, 2], [1, 3]]) }, identity, { ...view, widthPx: 0 })).toEqual([]);
  });
});
