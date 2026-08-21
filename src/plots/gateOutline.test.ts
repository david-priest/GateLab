import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseFcs } from "../engine/fcs";
import { Sample } from "../engine/sample";
import { buildPlotGates } from "./gatePayload";
import { ARIA_SMALL } from "../testFixtures";
import type { Gate } from "../engine/models";

function loadArrayBuffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/**
 * The drawn boundary must be the gate's real one. A polygon's edges are straight in gating
 * space, so on a non-linear axis the drawn path has to follow the transformed curve rather than
 * join the transformed vertices with chords.
 */
describe("polygon outlines follow the transformed boundary", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const x = sample.channels.find((c) => /^SSC-W/.test(c.key)) ?? sample.channels[0];
  const y = sample.channels.find((c) => /^SSC-A/.test(c.key)) ?? sample.channels[1];

  const polygon = (verts: [number, number][]): Record<string, Gate> => ({
    g1: {
      gate_id: "g1", gate_type: "polygon", name: "p", color: "#f00",
      x_channel: x.key, y_channel: y.key, vertices: verts, label_offset: null,
    } as unknown as Gate,
  });
  const build = (gates: Record<string, Gate>) =>
    buildPlotGates(sample, gates, Object.keys(gates), {}, x.key, y.key);

  // Spans zero on the y axis, where an arcsinh display bends hardest.
  const SPANNING: [number, number][] = [
    [221541, 266938], [-1595, 12344], [12909, -3073], [252485, 252673],
  ];

  it("densifies where the transform bends, and every point sits on the true curve", () => {
    const [g] = build(polygon(SPANNING));
    expect(g.vertices).toHaveLength(4);
    expect(g.outline!.length).toBeGreaterThan(20);

    // Each outline point must be the transform of a point on the straight gating-space edge.
    // Walk the outline and check it never strays from the polyline of true positions.
    const toDisplay = (p: [number, number]): [number, number] => [
      sample.gatingToDisplay(x.key, p[0]),
      sample.gatingToDisplay(y.key, p[1]),
    ];
    const onCurve = g.outline!.every((pt) =>
      SPANNING.some((a, i) => {
        const b = SPANNING[(i + 1) % SPANNING.length];
        for (let k = 0; k <= 512; k++) {
          const t = k / 512;
          const q = toDisplay([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
          if (Math.hypot(q[0] - pt[0], q[1] - pt[1]) < 1e-6) return true;
        }
        return false;
      }),
    );
    expect(onCurve).toBe(true);
  });

  it("leaves the editable vertices exactly as they were", () => {
    // Densifying the drawing must not add drag handles or move the stored gate.
    const [g] = build(polygon(SPANNING));
    expect(g.vertices).toEqual(SPANNING.map((v) => [
      sample.gatingToDisplay(x.key, v[0]),
      sample.gatingToDisplay(y.key, v[1]),
    ]));
  });

  it("adds nothing for a gate the transform does not bend", () => {
    // A tiny polygon in a locally-linear region needs no densification; omitting the outline
    // keeps the payload small and the renderer on its existing path.
    const [g] = build(polygon([[100000, 200000], [101000, 200000], [101000, 201000]]));
    expect(g.outline === undefined || g.outline.length <= 8).toBe(true);
  });

  it("never densifies a rectangle, whose edges stay axis-parallel", () => {
    const rect: Record<string, Gate> = {
      r1: {
        gate_id: "r1", gate_type: "rectangle", name: "r", color: "#00f",
        x_channel: x.key, y_channel: y.key, label_offset: null,
        vertices: [[1000, -500], [50000, 90000]],
      } as unknown as Gate,
    };
    const [g] = build(rect);
    expect(g.outline).toBeUndefined();
    expect(g.vertices).toHaveLength(4);
  });

  it("densifies when only ONE axis is non-linear", () => {
    // The case that shipped broken. Measuring the chord error as a single distance in display
    // space lets the larger axis swallow it: a linear scatter axis spans ~265,000 display units
    // while an arcsinh one spans ~14, so the tolerance was ~530 against a largest-possible error
    // of ~14 and nothing ever subdivided. Both-arcsinh worked only because its axes happen to be
    // commensurate, which is why the bug survived the first round of tests.
    sample.applyScatterLinearKeys([x.key]);
    try {
      const spanOf = (key: string, vs: [number, number][], i: 0 | 1) => {
        const d = vs.map((v) => sample.gatingToDisplay(key, v[i]));
        return Math.max(...d) - Math.min(...d);
      };
      // Confirm the premise: the two axes really are incommensurate here.
      const sx = spanOf(x.key, SPANNING, 0);
      const sy = spanOf(y.key, SPANNING, 1);
      expect(sx / sy).toBeGreaterThan(1000);

      const [g] = build(polygon(SPANNING));
      expect(g.outline!.length).toBeGreaterThan(20);

      // The y axis is the one that bends, so the outline must deviate from the straight chord
      // there — that deviation IS the curve the user sees.
      const chordY = (t: number) => {
        const a = g.vertices![1], b = g.vertices![2];
        return a[1] + (b[1] - a[1]) * t;
      };
      const bend = g.outline!.some((pt, i) => {
        const t = i / g.outline!.length;
        return Math.abs(pt[1] - chordY(t)) > sy * 0.01;
      });
      expect(bend).toBe(true);
    } finally {
      sample.applyScatterLinearKeys([]);
    }
  });
});
