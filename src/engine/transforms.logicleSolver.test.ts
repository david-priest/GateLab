// The logicle forward is one monotone scale: a value Halley's method does not settle on is still
// placed on it, not on another scale.
import { describe, expect, it } from "vitest";
import { transformFromSpec } from "./sample";

describe("logicle: a finite value the solver does not converge on is shown on an arcsinh(x/150) scale", () => {
  it("W near M/2: forward is monotone across 36.0488", () => {
    const f = transformFromSpec({ kind: "logicle", T: 1000, W: 3.5, M: 7, A: 0 }).forward;
    const a = f(Math.fround(36.04)), b = f(Math.fround(36.04881286621094)), c = f(Math.fround(36.06));
    // b is asinh(36.05 / 150) = 0.238, while its neighbours on the logicle are about 0.63.
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(c);
  });
  it("W = 0, A = 1: a value of 1e-10 sits at the logicle zero (x1 = A / (M + A)), not at 0", () => {
    const f = transformFromSpec({ kind: "logicle", T: 262144, W: 0, M: 4.5, A: 1 }).forward;
    const x1 = 1 / 5.5;
    expect(Math.abs(f(1e-10) - x1)).toBeLessThan(1e-6);
    expect(Math.abs(f(-1e-10) - x1)).toBeLessThan(1e-6);
  });
});
