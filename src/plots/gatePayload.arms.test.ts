// A curly quadrant's bent arms run to the edge of what the plot shows, not the edge of the data,
// and are sampled evenly on screen. Synthetic gate on the small Aria fixture.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildPlotGates } from "./gatePayload";
import { parseFcs } from "../engine/fcs";
import { Sample } from "../engine/sample";
import { ARIA_SMALL } from "../testFixtures";
import type { Gate } from "../engine/models";

function sample(): Sample {
  const b = readFileSync(ARIA_SMALL);
  return new Sample(parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}

describe("curly quadrant arms", () => {
  const s = sample();
  const [lo, hi] = s.displayRange(s.index("FSC-A")!);
  const [ylo, yhi] = s.displayRange(s.index("SSC-A")!);
  const gate = {
    gate_id: "q", name: "Q", gate_type: "quadrant", x_channel: "FSC-A", y_channel: "SSC-A", color: "#000",
    center: [s.displayToRaw("FSC-A", lo + (hi - lo) * 0.4), s.displayToRaw("SSC-A", ylo + (yhi - ylo) * 0.4)],
    curl: { power: 1.5, kx: 0.001, ky: 0.001 },
  } as unknown as Gate;
  const build = (frames?: [[number, number], [number, number]]) =>
    buildPlotGates(s, { q: gate }, ["q"], {}, "FSC-A", "SSC-A", null, frames ?? [null, null])[0];

  it("reach the data's extent when the plot's ranges are not given", () => {
    const g = build();
    expect(g.arms).toBeDefined();
    const hEnd = g.arms!.h.at(-1)!;
    expect(hEnd[0]).toBeCloseTo(hi, 6);
    const vEnd = g.arms!.v.at(-1)!;
    expect(vEnd[1]).toBeCloseTo(yhi, 6);
  });

  it("reach the plot's own edge when its ranges are given, sampled evenly on screen", () => {
    const xFrame: [number, number] = [lo, hi * 3];
    const yFrame: [number, number] = [ylo, yhi * 2];
    const g = build([xFrame, yFrame]);
    const h = g.arms!.h;
    expect(h.at(-1)![0]).toBeCloseTo(hi * 3, 6);
    expect(g.arms!.v.at(-1)![1]).toBeCloseTo(yhi * 2, 6);
    // Evenly spaced along the arm's own axis on screen.
    const steps = h.slice(1).map((p, i) => p[0] - h[i][0]);
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(1e-6);
    // The bend grows monotonically away from the crosshair.
    const bends = h.map((p) => p[1]);
    for (let i = 1; i < bends.length; i++) expect(bends[i]).toBeGreaterThanOrEqual(bends[i - 1] - 1e-9);
  });
});
