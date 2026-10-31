// After Swap X and Y, the gates drawn on the two channels the other way round stay on the plot:
// each is given in its own orientation and marked flipped, in gate order, and the axis fit reads
// it in the plot's terms. Synthetic gates on the small Aria fixture.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildPlotGates, plotGatesInPlotOrientation } from "./gatePayload";
import { includePlotGatesInAxisRange } from "../engine/axisRange";
import { parseFcs } from "../engine/fcs";
import { Sample } from "../engine/sample";
import { ARIA_SMALL } from "../testFixtures";
import type { Gate } from "../engine/models";

function sample(): Sample {
  const b = readFileSync(ARIA_SMALL);
  return new Sample(parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}

describe("gates on swapped axes", () => {
  const s = sample();
  const rect = {
    gate_id: "r", name: "R", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A", color: "#000",
    vertices: [[10000, 20000], [60000, 20000], [60000, 90000], [10000, 90000]], label_offset: null,
  } as unknown as Gate;
  const poly = {
    gate_id: "p", name: "P", gate_type: "polygon", x_channel: "SSC-A", y_channel: "FSC-A", color: "#000",
    vertices: [[5000, 5000], [40000, 8000], [30000, 50000]], label_offset: null,
  } as unknown as Gate;
  const other = {
    gate_id: "o", name: "O", gate_type: "polygon", x_channel: "FSC-A", y_channel: "FSC-H", color: "#000",
    vertices: [[1, 1], [2, 1], [2, 2]], label_offset: null,
  } as unknown as Gate;
  const gates = { r: rect, p: poly, o: other };
  const order = ["p", "o", "r"];

  it("draws both orientations, in gate order, the reversed one in its own terms", () => {
    const built = buildPlotGates(s, gates, order, {}, "SSC-A", "FSC-A");
    expect(built.map((g) => [g.gate_id, !!g.flipped])).toEqual([["p", false], ["r", true]]);
    const r = built[1];
    // Its own channels and coordinates: the renderer transposes it on screen.
    expect([r.x_channel, r.y_channel]).toEqual(["FSC-A", "SSC-A"]);
    const unswapped = buildPlotGates(s, { r: rect }, ["r"], {}, "FSC-A", "SSC-A")[0];
    expect(r.vertices).toEqual(unswapped.vertices);
    expect(r.label_offset).toEqual(unswapped.label_offset);
  });

  it("is unchanged on the gate's own axes", () => {
    const built = buildPlotGates(s, gates, order, {}, "FSC-A", "SSC-A");
    expect(built.map((g) => [g.gate_id, !!g.flipped])).toEqual([["p", true], ["r", false]]);
  });

  it("gives the axis fit a reversed gate in the plot's terms", () => {
    const built = buildPlotGates(s, { r: rect }, ["r"], {}, "SSC-A", "FSC-A");
    const [onAxes] = plotGatesInPlotOrientation(built);
    expect([onAxes.x_channel, onAxes.y_channel]).toEqual(["SSC-A", "FSC-A"]);
    expect(onAxes.vertices).toEqual(built[0].vertices!.map(([a, b]) => [b, a]));
    // The SSC-A extent of the gate widens X, where SSC-A now is.
    const ssc = built[0].vertices!.map((v) => v[1]);
    const fitted = includePlotGatesInAxisRange([0, 1], plotGatesInPlotOrientation(built), "x");
    expect(fitted[1]).toBeGreaterThanOrEqual(Math.max(...ssc));
  });

  it("has no other orientation for a range on one channel", () => {
    const range = { ...rect, gate_id: "h", x_channel: "FSC-A", y_channel: "FSC-A" } as unknown as Gate;
    const built = buildPlotGates(s, { h: range }, ["h"], {}, "FSC-A", "FSC-A");
    expect(built).toHaveLength(1);
    expect(built[0].flipped).toBeUndefined();
  });
});
