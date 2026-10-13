// GateLabR hands the app a GatingSet's transforms by their parameters (hostedHierarchy.ts),
// so the app's functions must be flowWorkspace's: its biexponential against flowWorkspace's
// flowjo_biexp spline (4096 channels), its FlowJo log against flowjo_log_trans, and its asinh
// against flowjo_fasinh through the affine map GateLabR applies. The oracle was written by
// flowWorkspace 4.16 at 17 probe points (gatingset_host.R says how).
import { describe, expect, it } from "vitest";
import oracle from "./__fixtures__/flowworkspace_transform_oracle.json";
import { transformFromSpec } from "./sample";

describe("flowWorkspace's transforms, by parameters", () => {
  // The app holds two tables (biex.ts): without `tableChannels`, cytolib's port at channelRange
  // channels, which is the function flowWorkspace runs; with `tableChannels: 4096`, FlowJo's own
  // table with the negative range solved exactly. A GatingSet's spec carries no tableChannels
  // and so gets flowWorkspace's function to five thousandths of a channel (measured 2026-10-13:
  // 0.0003 in 4096, 0.005 in 256). FlowJo's table differs from the spline by a quarter channel
  // in 4096 and by up to six channels in 256, which is why the field matters. Outside the
  // table flowWorkspace extrapolates the spline (an event of −1000 goes to channel −2961) and the
  // app pins at the table's ends as FlowJo does, under either table.
  it("biexponential without tableChannels is flowjo_biexp to five thousandths of a channel inside the table, and pins outside it", () => {
    for (const set of oracle.biexp) {
      const t = transformFromSpec({ kind: "biex", ...set.params });
      set.x.forEach((x, i) => {
        const inside = set.y[i] >= 0 && set.y[i] <= set.params.channelRange;
        if (inside) expect(Math.abs(t.forward(x) - set.y[i])).toBeLessThan(0.01);
        else expect(t.forward(x)).toBe(set.y[i] < 0 ? 0 : set.params.channelRange);
      });
    }
  });

  it("FlowJo's 4096-channel table is the spline to a quarter channel in 4096, and not in 256", () => {
    for (const set of oracle.biexp) {
      const t = transformFromSpec({ kind: "biex", ...set.params, tableChannels: 4096 });
      let worst = 0;
      set.x.forEach((x, i) => {
        if (set.y[i] >= 0 && set.y[i] <= set.params.channelRange) worst = Math.max(worst, Math.abs(t.forward(x) - set.y[i]));
      });
      if (set.params.channelRange === 4096) expect(worst).toBeLessThan(0.3);
      else expect(worst).toBeGreaterThan(1);
    }
  });

  it("FlowJo log: wsplog(offset, decades) is flowjo_log_trans divided by its scale", () => {
    for (const set of oracle.log) {
      const t = transformFromSpec({ kind: "wsplog", offset: set.params.offset, decades: set.params.decade });
      set.x.forEach((x, i) => {
        expect(t.forward(x)).toBeCloseTo(set.y[i] / set.params.scale, 10);
      });
    }
  });

  it("fasinh: asinh at T / sinh(M ln10), with y · (M + A) ln10 / length − A ln10, is flowjo_fasinh", () => {
    for (const set of oracle.fasinh) {
      const { m, t: T, a, length } = set.params;
      const cofactor = T / Math.sinh(m * Math.LN10);
      const transform = transformFromSpec({ kind: "asinh", cofactor });
      set.x.forEach((x, i) => {
        const inAppSpace = set.y[i] * ((m + a) * Math.LN10) / length - a * Math.LN10;
        expect(transform.forward(x)).toBeCloseTo(inAppSpace, 9);
      });
    }
  });
});
