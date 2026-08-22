// @vitest-environment jsdom
//
// The logicle W is a DISPLAY control. Flow gates are stored and evaluated in RAW space, so
// dragging the W slider must not move a single event in or out of a gate — only how the gate is
// drawn. This is the invariant that separates GateLab from a display-space gating app, where
// changing an axis scale silently changes every downstream percentage.
//
// Pinned after a competing app was observed to change its gate percentages on a scale change:
// the failure is silent by construction, since nothing about a redrawn axis announces that the
// statistics underneath it moved. The scatter half of the same guarantee is in scatterScale.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
import { getGateMask } from "./gates";
import { ARIA_SMALL } from "../testFixtures";
import type { Gate } from "./models";

function load(): Sample {
  const b = readFileSync(ARIA_SMALL);
  return new Sample(parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}

/** Quantile of a channel's gating-space column, so the gate is built from the data, not guessed. */
function q(sample: Sample, key: string, p: number): number {
  const col = sample.gatingData().column(key)!;
  const v = Array.from(col).filter(Number.isFinite).sort((a, b) => a - b);
  return v[Math.floor((v.length - 1) * p)];
}

describe("logicle W is a display control only", () => {
  const probe = load();
  const fluor = probe.channels
    .map((c, i) => ({ key: c.key, i }))
    .filter(({ i }) => probe.isLogicleChannel(i));

  it("the fixture has at least two logicle fluorescence channels", () => {
    expect(fluor.length).toBeGreaterThanOrEqual(2);
  });

  it("does not change one event's membership when W is dragged", () => {
    const s = load();
    const [x, y] = [fluor[0].key, fluor[1].key];
    // A polygon spanning the bulk of the data on both axes, in RAW space where flow gates live.
    const gate: Gate = {
      gate_id: "g", name: "W invariance", gate_type: "polygon",
      x_channel: x, y_channel: y,
      vertices: [
        [q(s, x, 0.10), q(s, y, 0.10)],
        [q(s, x, 0.90), q(s, y, 0.10)],
        [q(s, x, 0.90), q(s, y, 0.90)],
        [q(s, x, 0.10), q(s, y, 0.90)],
      ],
      color: "#377eb8", label_offset: null,
    };

    const before = Array.from(getGateMask(gate, s.gatingData()));
    const nIn = before.reduce((acc, v) => acc + v, 0);
    expect(nIn).toBeGreaterThan(0);
    expect(nIn).toBeLessThan(before.length); // not a vacuous all-in gate

    const xi = s.index(x)!, yi = s.index(y)!;
    const displayBefore = s.rawToDisplay(x, q(s, x, 0.5));

    for (const w of [0.1, 0.5, 1.0, 2.0]) {
      s.setLogicleW(xi, w);
      s.setLogicleW(yi, w);
      expect(Array.from(getGateMask(gate, s.gatingData())), `W=${w} moved events`).toEqual(before);
    }

    // The test would pass vacuously if setLogicleW did nothing, so prove the display DID move.
    expect(s.rawToDisplay(x, q(s, x, 0.5))).not.toBeCloseTo(displayBefore, 6);
  });

  it("changes the display-transform context key, so the plot redraws", () => {
    const s = load();
    const idx = s.index(fluor[0].key)!;
    const before = s.displayTransformContextKey;
    s.setLogicleW(idx, 1.25);
    expect(s.displayTransformContextKey).not.toBe(before);
  });
});
