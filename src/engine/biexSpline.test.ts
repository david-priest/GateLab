// A GatingSet's biexponential is evaluated as cytolib evaluates it: R's natural cubic spline
// through the table's nodes. The fixture is one 256-channel parameter set written by
// flowWorkspace 4.16: its nodes, R's coefficients b, c, d, and the transform's values at probe
// points inside and beyond the table.
import { describe, expect, it } from "vitest";
import spline from "./__fixtures__/flowworkspace_biexp_spline.json";
import oracle from "./__fixtures__/flowworkspace_transform_oracle.json";
import { biexTransform, generateBiexLut, naturalSpline } from "./biex";
import { transformFromSpec } from "./sample";

describe("cytolib's biexponential spline", () => {
  // The nodes agree to about 4e-8 of their value (cytolib's float arithmetic against the app's),
  // below the precision of the float32 values the app gates on.
  it("builds the same nodes as cytolib without tableChannels", () => {
    const lut = generateBiexLut(spline.params);
    expect(lut.x.length).toBe(spline.x.length);
    spline.x.forEach((x, i) => expect(Math.abs(lut.x[i] - x)).toBeLessThan(1e-6 * Math.max(1, Math.abs(x))));
    spline.y.forEach((y, i) => expect(lut.y[i]).toBe(y));
  });

  it("reproduces R's natural spline coefficients and values, extrapolating beyond the table as R does", () => {
    const f = naturalSpline(spline.x, spline.y);
    // Values at the nodes are the nodes; at R's probe points they are R's, 300,000 beyond the table included.
    spline.x.forEach((x, i) => expect(f(x)).toBeCloseTo(spline.y[i], 9));
    spline.probe.forEach((u, i) => expect(f(u)).toBeCloseTo(spline.value[i], 7));
  });

  // To a millionth relative: the nodes agree to about 1e-7 of their value, and far outside the
  // table (x = −5000, channel −16,278) the linear extrapolation magnifies that to 1e-3 absolute.
  it("is flowWorkspace's transform at every oracle point with spline: true, and its inverse within flowWorkspace's own round trip", () => {
    for (const set of oracle.biexp) {
      const t = transformFromSpec({ kind: "biex", ...set.params, spline: true });
      set.x.forEach((x, i) => expect(Math.abs(t.forward(x) - set.y[i])).toBeLessThan(1e-6 * Math.max(1, Math.abs(set.y[i]))));
      const b = biexTransform({ ...set.params, spline: true });
      set.y.forEach((y, i) => expect(Math.abs(b.inverse(y) - set.back[i])).toBeLessThan(Math.max(1e-3, Math.abs(set.back[i]) * 1e-6)));
    }
  });
});
