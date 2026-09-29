// @vitest-environment jsdom
//
// FlowJo's biex and log, ported from cytolib (itself "directly translated from java routine from
// tree star" — TreeStar wrote FlowJo). Validated against FlowJo's OWN exported populations on the
// S6 workspace: applying an imported gate in biex space scored J=0.99988 / 0.99998 against
// FlowJo's population, versus 0.99985 / 0.99981 straight-in-raw.

import { describe, it, expect } from "vitest";
import { biexBreakpoints, biexTransform, generateBiexLut, logRoot, wspLogTransform } from "./biex";

// PE-Cy7-A from 25-Sep-2023.wsp — real parameters, not invented ones.
const S6_PE_CY7 = {
  maxValue: 316227.7660168379, pos: 4.5, neg: 0,
  widthBasis: -22.6786880536, channelRange: 256,
};

describe("FlowJo biex", () => {
  it("builds a strictly increasing calibration table spanning the input range", () => {
    const { x, y } = generateBiexLut(S6_PE_CY7);
    expect(x.length).toBe(S6_PE_CY7.channelRange + 1);
    expect(y[0]).toBe(0);
    expect(y[y.length - 1]).toBe(S6_PE_CY7.channelRange);
    for (let i = 1; i < x.length; i++) expect(x[i]).toBeGreaterThan(x[i - 1]);
    // Negative input range, which is the whole point of a biexponential display.
    expect(x[0]).toBeLessThan(0);
    expect(x[x.length - 1]).toBeGreaterThan(3e5);
  });

  it("is monotonic and round-trips through its inverse", () => {
    const t = biexTransform(S6_PE_CY7);
    let last = -Infinity;
    for (const v of [-200, -50, 0, 10, 100, 1000, 20000, 200000]) {
      const f = t.forward(v);
      expect(f).toBeGreaterThan(last);
      last = f;
      expect(t.inverse(f)).toBeCloseTo(v, 0);
    }
  });

  it("puts zero at the zero channel, not at the bottom of the scale", () => {
    // The linear region around zero is what distinguishes biex from a log scale: raw 0 must land
    // well inside the axis so that negative events remain visible.
    const t = biexTransform(S6_PE_CY7);
    const zero = t.forward(0);
    expect(zero).toBeGreaterThan(10);
    expect(zero).toBeLessThan(S6_PE_CY7.channelRange / 2);
    expect(t.forward(-100)).toBeLessThan(zero);
    expect(t.forward(100)).toBeGreaterThan(zero);
  });

  it("clamps out-of-range input rather than extrapolating", () => {
    const t = biexTransform(S6_PE_CY7);
    expect(t.forward(-1e9)).toBe(0);
    expect(t.forward(1e9)).toBe(S6_PE_CY7.channelRange);
  });

  it("agrees with FlowKit's step rule to well under a channel", () => {
    // cytolib truncates the convergence step to an integer (a faithful echo of the Java);
    // FlowKit deliberately does not. Measured on real parameters the two differ by <0.1 of 256
    // channels and score identically against FlowJo's own populations, so the choice is immaterial
    // — recorded here so nobody re-litigates it from source-reading alone.
    const a = biexTransform(S6_PE_CY7, false);
    const b = biexTransform(S6_PE_CY7, true);
    for (const v of [-100, 0, 100, 1000, 10000, 100000]) {
      expect(Math.abs(a.forward(v) - b.forward(v))).toBeLessThan(0.1);
    }
  });

  it("returns b unchanged when the width is zero", () => {
    expect(logRoot(7.3, 0)).toBe(7.3);
  });

  it("rejects parameters that would walk off the table", () => {
    expect(() => generateBiexLut({ ...S6_PE_CY7, channelRange: 0 })).toThrow(/invalid zero channel/);
  });
});

// FlowJo's own table: cytolib's construction at 4096 channels with the negative range solved to
// convergence (biex.ts). FlowKit 1.3.1 ported the same table (generate_biex_lut, channel_range
// 4096); the values below are FlowKit's, for FlowKit's default parameters and for a second set
// with extra negative decades, and GateLab's table must agree with them to the last digits. FlowKit
// omits cytolib's width clamp, so the sets here are ones the clamp leaves alone.
describe("FlowJo's 4096-channel biex table", () => {
  const cases = [
    {
      params: { maxValue: 262144, pos: 4.41854, neg: 0, widthBasis: -10, channelRange: 256, tableChannels: 4096 },
      flowkit: [[0, -132.28732101758237], [1, -131.9343055537847], [1000, 159.89723441077697], [2048, 1711.3352341471102],
        [3000, 17268.02519464779], [4095, 260973.07125569566], [4096, 261622.33557944972]],
    },
    {
      params: { maxValue: 316227.7660168379, pos: 4.5, neg: 1, widthBasis: -100, channelRange: 256, tableChannels: 4096 },
      flowkit: [[0, -10997.091836409316], [1, -10965.98168657169], [1000, -878.5136464736884], [2048, 1048.5268044426925],
        [3000, 11706.00617146712], [4095, 315659.4281718165], [4096, 316632.8783683861]],
    },
  ];

  it("has 4097 entries and matches FlowKit's port entry for entry", () => {
    for (const { params, flowkit } of cases) {
      const { x, y } = generateBiexLut(params);
      expect(x.length).toBe(4097);
      for (const [j, v] of flowkit) {
        expect(Math.abs(x[j] - v) / Math.max(1, Math.abs(v)), `entry ${j}`).toBeLessThan(1e-12);
      }
      // Scaled to the declared length for display: a sixteenth of a channel apart.
      expect(y[16]).toBe(1);
      expect(y[4096]).toBe(256);
    }
  });

  it("differs from the 256-channel table a spec saved before carries, which keeps its own", () => {
    const { tableChannels: _t, ...saved } = cases[0].params;
    void _t;
    const old = generateBiexLut(saved);
    expect(old.x.length).toBe(257);
    const flowjo = biexTransform(cases[0].params);
    const legacy = biexTransform(saved);
    // Near zero the two tables disagree by more than a channel: the saved gate's coordinates
    // were placed on the old one, so it keeps it (models.ts, TransformSpec).
    let worst = 0;
    for (const v of [-100, -20, 0, 20, 100, 1000, 10000, 100000]) worst = Math.max(worst, Math.abs(flowjo.forward(v) - legacy.forward(v)));
    expect(worst).toBeGreaterThan(1);
  });

  it("solves the negative range exactly, not with cytolib's truncated steps", () => {
    const exact = generateBiexLut({ ...cases[0].params });
    const truncated = generateBiexLut({ ...cases[0].params, tableChannels: undefined, channelRange: 4096 });
    // The same resolution, the root the only difference: the tables part below zero.
    expect(exact.x[0]).not.toBeCloseTo(truncated.x[0], 6);
  });

  it("exposes its breakpoints, between which the display map is exactly linear", () => {
    const { raw, display } = biexBreakpoints(cases[0].params);
    expect(raw.length).toBe(4097);
    expect(display.length).toBe(4097);
    const t = biexTransform(cases[0].params);
    for (const j of [0, 100, 2048, 4000]) {
      const mid = (raw[j] + raw[j + 1]) / 2;
      expect(t.forward(mid)).toBeCloseTo((display[j] + display[j + 1]) / 2, 10);
      expect(t.forward(raw[j])).toBe(display[j]);
    }
  });
});

describe("FlowJo log", () => {
  // SSC (Imaging)-A from 17-Dec-2025 new.wsp.
  const P = { offset: 31622.7766016838, decades: 3.6278098797 };

  it("maps the offset to zero and spans the declared decades", () => {
    const t = wspLogTransform(P);
    expect(t.forward(P.offset)).toBeCloseTo(0, 12);
    expect(t.forward(P.offset * Math.pow(10, P.decades))).toBeCloseTo(1, 12);
  });

  it("clamps at the offset instead of diverging on zero and negatives", () => {
    // Real scatter carries zeros and negatives; log10 of those is -Infinity, which would take the
    // whole gate with it. FlowJo clamps, so reproducing the clamp is part of reproducing the gate.
    const t = wspLogTransform(P);
    expect(t.forward(0)).toBeCloseTo(0, 12);
    expect(t.forward(-5000)).toBeCloseTo(0, 12);
    expect(Number.isFinite(t.forward(-1e9))).toBe(true);
  });

  it("round-trips above the offset", () => {
    const t = wspLogTransform(P);
    for (const v of [40000, 100000, 1e6]) expect(t.inverse(t.forward(v))).toBeCloseTo(v, 3);
  });
});
