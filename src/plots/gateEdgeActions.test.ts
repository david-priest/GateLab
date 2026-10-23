// "Close gaps" and "Extend to edges" for one gate, from its menu: run the renderer's own patched
// functions on gates drawn at known positions and check where every vertex lands. Synthetic
// gates g1 to g3 on channels A and B; the scales are the identity, so pixels are data.

import { describe, expect, it } from "vitest";
import cytofSrc from "../../vendor/GateLabR/inst/app/www/cytof_plot.js?raw";
import { patchCytofForGateLab } from "./loadPlots";

/** The source of one top-level function of the patched renderer, by brace counting. */
function functionSource(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} not closed`);
}

type Gate = { gate_id: string; gate_type: string; x_channel: string; y_channel: string; vertices: number[][] };
const patched = patchCytofForGateLab(cytofSrc);
const run = new Function(`
  var _plotData = null, _xBase = true, notified = [];
  var scale = function (v) { return v; }; scale.invert = function (v) { return v; };
  var _zx = function () { return scale; }, _zy = function () { return scale; };
  function _notifyGateEdit(g) { notified.push(g.gate_id); }
  function _drawGates() {}
  ${functionSource(patched, "_closeGateGaps")}
  ${functionSource(patched, "_extendSelectedGateToEdges")}
  return {
    close: function (data, ids, focus) { _plotData = data; notified = []; return { changed: _closeGateGaps(ids, focus), notified: notified }; },
    extend: function (data, id) { _plotData = data; notified = []; return { changed: _extendSelectedGateToEdges(id), notified: notified }; },
  };
`)() as {
  close(data: unknown, ids?: string[], focus?: string): { changed: boolean; notified: string[] };
  extend(data: unknown, id?: string): { changed: boolean; notified: string[] };
};

const square = (id: string, x0: number, y0: number, x1: number, y1: number): Gate => ({
  gate_id: id, gate_type: "polygon", x_channel: "A", y_channel: "B", vertices: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
});
/** g2 sits 10 to the right of g1, g3 10 above it: two gaps, neither touching the other. */
function plot(selected: string | null = null) {
  return {
    x_label: "A", y_label: "B", x_range: [0, 400], y_range: [0, 400], selected_gate_id: selected,
    gates: [square("g1", 0, 0, 100, 100), square("g2", 110, 0, 210, 100), square("g3", 0, 110, 100, 210)],
  };
}
const verts = (data: { gates: Gate[] }, id: string) => data.gates.find((g) => g.gate_id === id)!.vertices.map((v) => v.map((n) => Math.round(n * 1000) / 1000));

describe("close gaps and extend to edges for one gate", () => {
  it("closes only the gaps between the focus gate and its neighbours", () => {
    const data = plot();
    const out = run.close(data, undefined, "g2");
    expect(out.changed).toBe(true);
    // g1's right side and g2's left side meet on one line between them; g3 does not move.
    expect(verts(data, "g1").map((v) => v[0])).toEqual([0, 105, 105, 0]);
    expect(verts(data, "g2").map((v) => v[0])).toEqual([105, 210, 210, 105]);
    expect(verts(data, "g3")).toEqual([[0, 110], [100, 110], [100, 210], [0, 210]]);
    expect(out.notified.sort()).toEqual(["g1", "g2"]);
  });

  it("closes every gap without a focus, as the strip's button did", () => {
    const data = plot();
    expect(run.close(data).changed).toBe(true);
    expect(verts(data, "g3").map((v) => v[1])).toEqual([105, 105, 210, 210]);
    expect(verts(data, "g2").map((v) => v[0])).toEqual([105, 210, 210, 105]);
  });

  it("extends the gate it is given, whichever gate is selected", () => {
    const data = plot("g3");
    const out = run.extend(data, "g2");
    expect(out.changed).toBe(true);
    expect(out.notified).toEqual(["g2"]);
    // g2 grows to the plot's right edge and its bottom edge, and stops at g1 on its left.
    const xs = verts(data, "g2").map((v) => v[0]), ys = verts(data, "g2").map((v) => v[1]);
    expect(Math.min(...xs)).toBe(100);
    expect(Math.max(...xs)).toBe(400);
    expect(Math.min(...ys)).toBe(0);
    expect(verts(data, "g3")).toEqual([[0, 110], [100, 110], [100, 210], [0, 210]]);
    // Without one, it extends the selected gate, as before.
    const again = plot("g1");
    expect(run.extend(again).notified).toEqual(["g1"]);
  });
});
