import { describe, expect, it } from "vitest";
import { Hyperlog, validHyperlog } from "./hyperlog";
import oracle from "./__fixtures__/hyperlog-oracle.json";

describe("Hyperlog against independent FlowUtils vectors", () => {
  for (const c of oracle.cases) {
    const { t, w, m, a } = c.params;
    const h = new Hyperlog(t, w, m, a);
    it(`forward T=${t} W=${w} M=${m} A=${a}`, () => {
      c.raw.forEach((v, i) => expect(h.scale(v), `raw ${v}`).toBeCloseTo(c.forward[i], 12));
    });
    it(`inverse T=${t} W=${w} M=${m} A=${a}`, () => {
      c.display.forEach((v, i) => {
        expect(Math.abs(h.inverse(v) - c.inverse[i]) / Math.max(1, Math.abs(c.inverse[i])), `display ${v}`).toBeLessThan(3e-12);
      });
    });
  }
});

describe("Hyperlog mathematical domain and conditioning", () => {
  it("has the prescribed zero, unit top, reflection and a monotonic inverse", () => {
    const h = new Hyperlog(1000, 1, 4, 1);
    expect(h.scale(0)).toBe(.4);
    expect(h.inverse(.4)).toBe(0);
    expect(h.scale(1000)).toBe(1);
    expect(h.inverse(1)).toBe(1000);
    let previous = -Infinity;
    for (let i = 0; i <= 500; i++) {
      const y = -1 + i / 200;
      const value = h.inverse(y);
      expect(value).toBeGreaterThan(previous);
      expect(h.scale(value)).toBeCloseTo(y, 12);
      expect(h.scale(-value)).toBeCloseTo(.8 - y, 12);
      previous = value;
    }
  });

  it("satisfies the defining exponential-plus-linear equation independently", () => {
    const [T, W, M, A] = [10000, .7, 4.5, .2];
    const h = new Hyperlog(T, W, M, A);
    const w = W / (M + A), x1 = (A + W) / (M + A), x0 = (A + 2 * W) / (M + A);
    const b = (M + A) * Math.LN10, ca = Math.exp(b * x0) / w;
    const fa = Math.exp(b * x1) + ca * x1, aa = T / (Math.exp(b) + ca - fa);
    for (const value of [1, 30, 300, 3000, 30000]) {
      const y = h.scale(value);
      expect(Math.abs(aa * Math.exp(b * y) + ca * aa * y - fa * aa - value) / value).toBeLessThan(1e-12);
    }
  });

  it("preserves values immediately around zero without cancellation or clipping", () => {
    const h = new Hyperlog(1000, .01, 4, 1);
    for (const value of [-1e-8, -1e-6, -1e-4, 1e-8, 1e-6, 1e-4]) {
      expect(Math.abs(h.inverse(h.scale(value)) - value)).toBeLessThan(1e-12);
    }
    expect(h.scale(1e8)).toBeGreaterThan(1);
    expect(h.scale(-1e8)).toBeLessThan(0);
    expect(h.scale(Infinity)).toBe(Infinity);
    expect(h.scale(-Infinity)).toBe(-Infinity);
    expect(h.scale(NaN)).toBeNaN();
  });

  it("solves values whose Halley terms or exp(b*d) overflow, rather than stopping early", () => {
    // Expected coordinates from section 6.5's equation bisected in 80-digit mpmath. The solver
    // returned 34.43, 7.8, 1.84 and 0.75 here: the step overflowed to -0 and was taken for
    // convergence. With M = 300 that happens from 1e15, inside float32's range.
    for (const [T, W, M, A, value, positive, negative] of [
      [262144, 2.25, 4.5, 0, 1.7e308, 68.358159148109741, -67.358159148109741],
      [10000, 1, 20, 0, 1e295, 15.55, -15.45],
      [262144, .5, 100, 0, 1e215, 3.0958146007804834, -3.0858146007804834],
      [262144, .5, 300, 0, 1e15, 1.0319382002601611, -1.0286048669268278],
    ]) {
      const h = new Hyperlog(T, W, M, A);
      expect(h.scale(value), `T=${T} M=${M} at ${value}`).toBeCloseTo(positive, 12);
      expect(h.scale(-value), `T=${T} M=${M} at ${-value}`).toBeCloseTo(negative, 12);
    }
  });

  it("requires positive W and admits the standard's negative-A range and rounded bounds", () => {
    for (const [T, W, M, A] of [[1000, 0, 4, 0], [0, 1, 4, 0], [1000, -1, 4, 0],
      [1000, 2.1, 4, 0], [1000, 1, 4, -1.01], [1000, 1, 4, 2.01], [Infinity, 1, 4, 0]]) {
      expect(validHyperlog({ T, W, M, A })).toBe(false);
      expect(() => new Hyperlog(T, W, M, A)).toThrow(/Invalid Hyperlog/);
    }
    expect(() => new Hyperlog(1000, .5, 4, -.5)).not.toThrow();
    expect(() => new Hyperlog(1000, .87, 4.42, 2.68)).not.toThrow();
  });
});
