// @vitest-environment jsdom
//
// Arcsinh 150 as an alternative to logicle on FLUORESCENCE channels. Like the scatter scale it
// is a DISPLAY control: flow gates are stored and evaluated in raw space, so switching it must
// not move a gate or change one event's membership. Every test here asserts the display
// coordinate genuinely moved as well, so none of them can pass vacuously by doing nothing.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFcs } from "./fcs";
import { Sample, transformFromSpec, FLUOR_ARCSINH_COFACTOR } from "./sample";
import { getGateMask } from "./gates";
import { ChannelScales } from "./channelScales";
import { ARIA_SMALL, FIXTURES_ROOT } from "../testFixtures";
import type { Gate } from "./models";

const BODENMILLER = join(
  FIXTURES_ROOT, "PUBLIC - Screenshot Safe", "Bodenmiller BCR-XL CyTOF benchmark",
  "source-fcs", "PBMC8_30min_patient1_BCR-XL.fcs",
);

function load(path: string): Sample {
  const b = readFileSync(path);
  return new Sample(parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}

/** First channel the control applies to, and a raw value inside its data. */
function firstFluor(s: Sample): { idx: number; key: string } {
  const idx = s.channels.findIndex((_, i) => s.isFluorChannel(i));
  expect(idx).toBeGreaterThanOrEqual(0);
  return { idx, key: s.channels[idx].key };
}

describe("fluorescence display scale", () => {
  it("classifies fluorescence channels, and only those", () => {
    const s = load(ARIA_SMALL);
    expect(s.isFluorChannel(s.index("FSC-A")!)).toBe(false);
    expect(s.isFluorChannel(s.index("SSC-A")!)).toBe(false);
    const { idx } = firstFluor(s);
    expect(s.isScatterAxis(idx)).toBe(false);
    // Classification is independent of what the channel currently displays: that is what keeps
    // the control on screen after switching, and what lets the W override survive the trip.
    s.setFluorScale(idx, "arcsinh");
    expect(s.isFluorChannel(idx)).toBe(true);
    expect(s.isLogicleChannel(idx)).toBe(false);
  });

  it("defaults to logicle", () => {
    const s = load(ARIA_SMALL);
    const { idx } = firstFluor(s);
    expect(s.fluorScale(idx)).toBe("logicle");
    expect(s.transformKind(idx)).toBe("logicle");
    expect(s.fluorArcsinhKeys()).toEqual([]);
  });

  it("actually changes the display coordinate when switched", () => {
    const s = load(ARIA_SMALL);
    const { idx, key } = firstFluor(s);
    const raw = s.displayToRaw(key, s.rawToDisplay(key, 1000)); // a value the channel really holds
    const before = s.rawToDisplay(key, raw);

    s.setFluorScale(idx, "arcsinh");
    expect(s.fluorScale(idx)).toBe("arcsinh");
    expect(s.transformKind(idx)).toBe("asinh");
    const after = s.rawToDisplay(key, raw);
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeCloseTo(Math.asinh(raw / FLUOR_ARCSINH_COFACTOR), 9);
    // ...and inverts, so pan/zoom and the axis window still resolve to raw values.
    expect(s.displayToRaw(key, after)).toBeCloseTo(raw, 6);
  });

  it("does not move a gate or change membership", () => {
    // The invariant the whole feature rests on.
    const s = load(ARIA_SMALL);
    const { idx, key } = firstFluor(s);
    const gate: Gate = {
      gate_id: "g", name: "Positive", gate_type: "rectangle",
      x_channel: key, y_channel: "SSC-A",
      // Chosen from the fixture's own quantiles (PE-A upper quartile × SSC-A interquartile
      // range) so the gate holds a real, partial population rather than everything or nothing.
      vertices: [[11, 32294], [6000, 32294], [6000, 49802], [11, 49802]],
      color: "#e41a1c", label_offset: null,
    };
    const before = Array.from(getGateMask(gate, s.gatingData()));
    const nIn = before.reduce((acc, v) => acc + v, 0);
    expect(nIn).toBeGreaterThan(0);
    expect(nIn).toBeLessThan(before.length); // not a vacuous all-in gate

    const displayBefore = s.rawToDisplay(key, 1000);
    s.setFluorScale(idx, "arcsinh");
    expect(s.rawToDisplay(key, 1000)).not.toBeCloseTo(displayBefore, 6); // the view really moved
    expect(Array.from(getGateMask(gate, s.gatingData()))).toEqual(before); // membership did not
  });

  it("keeps the logicle W across a switch to arcsinh and back", () => {
    // Setting W while a channel is on arcsinh must still be recorded — otherwise a workspace
    // that restored its arcsinh keys before its W overrides would silently drop every W.
    const s = load(ARIA_SMALL);
    const { idx } = firstFluor(s);
    s.setLogicleW(idx, 1.35);
    s.setFluorScale(idx, "arcsinh");
    expect(s.currentLogicleW(idx)).toBeCloseTo(1.35, 9);
    s.setLogicleW(idx, 0.85);
    s.setFluorScale(idx, "logicle");
    expect(s.fluorScale(idx)).toBe("logicle");
    expect(s.transformKind(idx)).toBe("logicle");
    expect(s.currentLogicleW(idx)).toBeCloseTo(0.85, 9);
  });

  it("re-keys the display-transform identity, so no stale coordinates are reused", () => {
    // Omitting this for linear scatter is what once let the plot draw cached arcsinh points
    // under a live linear gate outline; the gate appeared to jump off its own events.
    const s = load(ARIA_SMALL);
    const { idx, key } = firstFluor(s);
    const identityBefore = s.displayTransformContextKey;
    const bindingBefore = s.displayCoordinateBindingKey(key);
    s.setFluorScale(idx, "arcsinh");
    expect(s.displayTransformContextKey).not.toBe(identityBefore);
    expect(s.displayCoordinateBindingKey(key)).not.toBe(bindingBefore);
  });

  it("reports a transform spec that reproduces the transform", () => {
    // gatingmlExport plans every dimension through transformSpec(), so a drift here exports
    // a gate under a transformation-ref that is not the one GateLab applied.
    const s = load(ARIA_SMALL);
    const { idx, key } = firstFluor(s);
    s.setFluorScale(idx, "arcsinh");
    const spec = s.transformSpec(key);
    expect(spec).toEqual({ kind: "asinh", cofactor: FLUOR_ARCSINH_COFACTOR });
    const rebuilt = transformFromSpec(spec);
    for (const raw of [-200, 0, 37, 1000, 250000]) {
      expect(rebuilt.forward(raw)).toBeCloseTo(s.rawToDisplay(key, raw), 9);
    }
  });

  it("labels the arcsinh axis in raw decades, not display units", () => {
    // Falling through to D3's linear ticks labelled the axis -2, 0, 2, 4 … — display units,
    // which name nothing a cytometrist can read off a plot.
    const s = load(ARIA_SMALL);
    const { idx } = firstFluor(s);
    expect(s.channelTicks(idx, [0, 1])?.tick_mode).toBe("logicle");
    s.setFluorScale(idx, "arcsinh");
    const ticks = s.channelTicks(idx, [Math.asinh(-500 / 150), Math.asinh(200000 / 150)]);
    expect(ticks?.tick_mode).toBe("scatter_log10");
    expect(ticks!.major_labels.length).toBeGreaterThan(2);
    expect(ticks!.major_labels).toContain("0");
  });

  it("compresses the low end as the cofactor rises", () => {
    // The cofactor is the ONLY thing separating arcsinh from a log axis: it sets where the
    // linear region around zero gives way to log behaviour. Below the cofactor the axis is
    // linear, which packs near-zero events together; above it the axis is log, which spreads
    // them. So RAISING the cofactor pulls the low end into a tighter band, and lowering it
    // blows the zero-noise out across the plot. At 150 on data reaching millions almost the
    // whole axis is already log, which is why it looked so much like the logicle it replaced.
    const s = load(ARIA_SMALL);
    const { idx, key } = firstFluor(s);
    s.setFluorScale(idx, "arcsinh");
    expect(s.currentFluorCofactor(idx)).toBe(FLUOR_ARCSINH_COFACTOR);

    // Share of a symmetric ±1e6 axis given to everything under 1000.
    const share = () => {
      const span = s.rawToDisplay(key, 1_000_000) - s.rawToDisplay(key, -1_000_000);
      return (s.rawToDisplay(key, 1000) - s.rawToDisplay(key, -1000)) / span;
    };
    const at150 = share();
    s.setFluorCofactor(idx, 10000);
    expect(s.currentFluorCofactor(idx)).toBe(10000);
    expect(share()).toBeLessThan(at150 / 2); // materially compressed, not a nudge
    expect(s.transformSpec(key)).toEqual({ kind: "asinh", cofactor: 10000 });

    // ...and the other direction, so the assertion is about the cofactor and not about 10000.
    s.setFluorCofactor(idx, 10);
    expect(share()).toBeGreaterThan(at150);

    s.resetFluorCofactor(idx);
    expect(s.currentFluorCofactor(idx)).toBe(FLUOR_ARCSINH_COFACTOR);
    expect(share()).toBeCloseTo(at150, 12);
  });

  it("moves the axis ticks and the identity with the cofactor", () => {
    const s = load(ARIA_SMALL);
    const { idx, key } = firstFluor(s);
    s.setFluorScale(idx, "arcsinh");
    const identity = s.displayTransformContextKey;
    const binding = s.displayCoordinateBindingKey(key);
    const range: [number, number] = [Math.asinh(-500 / 150), Math.asinh(200000 / 150)];
    const before = s.channelTicks(idx, range)!.major_pos.slice();

    s.setFluorCofactor(idx, 5000);
    expect(s.displayTransformContextKey).not.toBe(identity);
    expect(s.displayCoordinateBindingKey(key)).not.toBe(binding);
    expect(s.channelTicks(idx, range)!.major_pos).not.toEqual(before);
  });

  it("keeps the cofactor out of channels the control does not own", () => {
    const s = load(ARIA_SMALL);
    const fsc = s.index("FSC-A")!;
    s.setFluorCofactor(fsc, 9999);
    expect(s.currentScatterCofactor(fsc)).toBe(150); // scatter keeps its own default
  });

  it("round-trips through the workspace keys", () => {
    const s = load(ARIA_SMALL);
    const { idx, key } = firstFluor(s);
    s.setFluorScale(idx, "arcsinh");
    const saved = s.fluorArcsinhKeys();
    expect(saved).toEqual([key]);

    const reopened = load(ARIA_SMALL);
    reopened.applyFluorArcsinhKeys(saved);
    expect(reopened.fluorScale(reopened.index(key)!)).toBe("arcsinh");
    const other = reopened.channels.findIndex((c, i) => reopened.isFluorChannel(i) && c.key !== key);
    expect(other).toBeGreaterThanOrEqual(0);
    expect(reopened.fluorScale(other)).toBe("logicle"); // one channel, not all of them
  });

  it("saves the cofactor with the workspace", () => {
    // It shares the per-channel cofactor record with scatter, so the on-disk format is
    // unchanged and a workspace written now still opens in a build that predates this control.
    const s = load(ARIA_SMALL);
    const { idx, key } = firstFluor(s);
    s.setFluorScale(idx, "arcsinh");
    s.setFluorCofactor(idx, 3000);
    expect(s.scatterCofactorOverrides()[key]).toBe(3000);

    const reopened = load(ARIA_SMALL);
    reopened.applyFluorArcsinhKeys(s.fluorArcsinhKeys());
    reopened.setFluorCofactor(reopened.index(key)!, s.scatterCofactorOverrides()[key]);
    expect(reopened.currentFluorCofactor(reopened.index(key)!)).toBe(3000);
    expect(reopened.rawToDisplay(key, 5000)).toBeCloseTo(s.rawToDisplay(key, 5000), 12);
  });

  it("refuses scatter and QC channels", () => {
    const s = load(ARIA_SMALL);
    const fsc = s.index("FSC-A")!;
    s.setFluorScale(fsc, "arcsinh");
    expect(s.fluorScale(fsc)).toBe("logicle"); // the accessor's "not arcsinh" answer
    expect(s.transformKind(fsc)).toBe("asinh"); // still scatter arcsinh, at ITS cofactor
    expect(s.currentScatterCofactor(fsc)).toBe(150);
    expect(s.fluorArcsinhKeys()).toEqual([]);
  });

  it("applies workspace-wide, so a pooled cloud is never drawn under two transforms", () => {
    // The reason the setting lives in ChannelScales rather than on one Sample.
    const scales = new ChannelScales();
    const a = load(ARIA_SMALL);
    const b = load(ARIA_SMALL);
    a.attachChannelScales(scales);
    b.attachChannelScales(scales);
    const { idx, key } = firstFluor(a);
    const before = b.rawToDisplay(key, 1000);

    a.setFluorScale(idx, "arcsinh");
    expect(b.fluorScale(b.index(key)!)).toBe("arcsinh");
    const after = b.rawToDisplay(key, 1000);
    expect(after).not.toBeCloseTo(before, 6); // b's coordinates were invalidated, not just its flag
    expect(after).toBeCloseTo(a.rawToDisplay(key, 1000), 12);
  });
});

describe("CyTOF is excluded from the fluorescence scale control", () => {
  it("offers no fluorescence channel and ignores an attempt to set one", () => {
    // Every CyTOF channel is already arcsinh (cofactor 5, the field convention). Offering a
    // choice between arcsinh and a logicle it never uses would be meaningless.
    const s = load(BODENMILLER);
    expect(s.instrument).toBe("cytof");
    expect(s.channels.some((_, i) => s.isFluorChannel(i))).toBe(false);

    const idx = s.channels.findIndex((_, i) => s.transformKind(i) === "asinh");
    expect(idx).toBeGreaterThanOrEqual(0);
    const before = s.rawToDisplay(s.channels[idx].key, 10);
    s.setFluorScale(idx, "arcsinh");
    expect(s.rawToDisplay(s.channels[idx].key, 10)).toBeCloseTo(before, 12); // cofactor 5 intact
    expect(s.fluorArcsinhKeys()).toEqual([]);
  });
});
