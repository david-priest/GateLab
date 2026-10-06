// @vitest-environment jsdom
//
// The scatter scale is a DISPLAY control. Flow gates are stored and evaluated in raw
// space, so switching a scatter axis between linear and arcsinh must not move a gate or
// change a single event's membership. These tests pin that, and pin that CyTOF is
// excluded from the control entirely — arcsinh cofactor 5 is the field convention there.
// Scatter is linear unless switched (since 2026-10-06; arcsinh unless switched before).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
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

describe("flow scatter scale", () => {
  const sample = load(ARIA_SMALL);
  const fscIdx = sample.index("FSC-A")!;
  const sscIdx = sample.index("SSC-A")!;

  it("identifies scatter axes and nothing else", () => {
    expect(sample.isScatterAxis(fscIdx)).toBe(true);
    expect(sample.isScatterAxis(sscIdx)).toBe(true);
    const fluor = sample.channels.findIndex((_, i) => sample.isLogicleChannel(i));
    expect(fluor).toBeGreaterThanOrEqual(0);
    expect(sample.isScatterAxis(fluor)).toBe(false);
  });

  it("defaults to linear, as FlowJo and Cytobank draw scatter", () => {
    expect(sample.scatterScale(fscIdx)).toBe("linear");
    expect(sample.scatterScale(sscIdx)).toBe("linear");
    expect(sample.transformKind(fscIdx)).toBe("identity");
    expect(sample.rawToDisplay("FSC-A", 12345)).toBeCloseTo(12345, 6);
    // The cofactor waits for the switch.
    expect(sample.currentScatterCofactor(fscIdx)).toBe(150);
  });

  it("draws arcsinh at cofactor 150 when switched, and raw again when switched back", () => {
    const s = load(ARIA_SMALL);
    const idx = s.index("FSC-A")!;
    s.setScatterScale(idx, "arcsinh");
    expect(s.scatterScale(idx)).toBe("arcsinh");
    expect(s.transformKind(idx)).toBe("asinh");
    expect(s.rawToDisplay("FSC-A", 150)).toBeCloseTo(Math.asinh(1), 6);
    s.setScatterScale(idx, "linear");
    expect(s.scatterScale(idx)).toBe("linear");
    expect(s.transformKind(idx)).toBe("identity");
    expect(s.rawToDisplay("FSC-A", 12345)).toBeCloseTo(12345, 6);
    s.setScatterScale(idx, "arcsinh");
    expect(s.transformKind(idx)).toBe("asinh");
  });

  it("does not move a gate or change membership when the scale changes", () => {
    // The invariant the whole feature rests on.
    const s = load(ARIA_SMALL);
    const gate: Gate = {
      gate_id: "g", name: "Cells", gate_type: "rectangle",
      x_channel: "FSC-A", y_channel: "SSC-A",
      vertices: [[20000, 10000], [80000, 10000], [80000, 90000], [20000, 90000]],
      color: "#e41a1c", label_offset: null,
    };
    const before = Array.from(getGateMask(gate, s.gatingData()));
    const nIn = before.reduce((acc, v) => acc + v, 0);
    expect(nIn).toBeGreaterThan(0);
    expect(nIn).toBeLessThan(before.length); // not a vacuous all-in gate

    s.setScatterScale(s.index("FSC-A")!, "arcsinh");
    s.setScatterScale(s.index("SSC-A")!, "arcsinh");
    expect(Array.from(getGateMask(gate, s.gatingData()))).toEqual(before);

    s.setScatterCofactor(s.index("FSC-A")!, 1500);
    expect(Array.from(getGateMask(gate, s.gatingData()))).toEqual(before);

    s.setScatterScale(s.index("FSC-A")!, "linear");
    expect(Array.from(getGateMask(gate, s.gatingData()))).toEqual(before);
  });

  it("round-trips the scatter choice through the workspace keys, which list the linear channels", () => {
    const s = load(ARIA_SMALL);
    const scatter = s.channels.filter((_, i) => s.isScatterAxis(i)).map((c) => c.key);
    expect(s.scatterLinearKeys()).toEqual(scatter);
    s.setScatterScale(s.index("SSC-A")!, "arcsinh");
    const saved = s.scatterLinearKeys();
    expect(saved).toEqual(scatter.filter((key) => key !== "SSC-A"));

    const reopened = load(ARIA_SMALL);
    reopened.applyScatterLinearKeys(saved);
    expect(reopened.scatterScale(reopened.index("FSC-A")!)).toBe("linear");
    expect(reopened.scatterScale(reopened.index("SSC-A")!)).toBe("arcsinh");
    // A workspace saved when arcsinh was the default lists nothing: every axis opens arcsinh.
    reopened.applyScatterLinearKeys([]);
    expect(reopened.scatterScale(reopened.index("FSC-A")!)).toBe("arcsinh");
    expect(reopened.scatterLinearKeys()).toEqual([]);
  });

  it("resets the cofactor to 150 without touching the scale", () => {
    const s = load(ARIA_SMALL);
    const idx = s.index("FSC-A")!;
    s.setScatterScale(idx, "arcsinh");
    s.setScatterCofactor(idx, 900);
    s.resetScatterCofactor(idx);
    expect(s.scatterScale(idx)).toBe("arcsinh");
    expect(s.currentScatterCofactor(idx)).toBe(150);
    s.setScatterScale(idx, "linear");
    expect(s.scatterScale(idx)).toBe("linear");
  });
});

describe("CyTOF is excluded from the scatter scale control", () => {
  it("offers no scatter axis and ignores an attempt to set one", () => {
    const s = load(BODENMILLER);
    expect(s.instrument).toBe("cytof");
    // Every CyTOF channel is arcsinh, but none is a *scatter axis*, so the control never
    // renders and the cofactor-5 convention cannot be overridden per channel here.
    expect(s.channels.some((_, i) => s.isScatterAxis(i))).toBe(false);

    const idx = s.channels.findIndex((_, i) => s.transformKind(i) === "asinh");
    expect(idx).toBeGreaterThanOrEqual(0);
    s.setScatterScale(idx, "linear");
    expect(s.scatterScale(idx)).toBe("arcsinh");
    expect(s.transformKind(idx)).toBe("asinh");
    expect(s.scatterLinearKeys()).toEqual([]);
  });
});

describe("the display-transform context key", () => {
  // This key is what the plot uses to decide a cached display coordinate is still valid.
  // Omitting the linear-scatter set from it let the plot keep arcsinh coordinates while
  // the gate outline — transformed live out of raw space — moved to the linear scale, so
  // a gate visibly jumped off its own events while its event count stayed correct.
  it("changes when a scatter axis switches to arcsinh", () => {
    const s = load(ARIA_SMALL);
    const before = s.displayTransformContextKey;
    s.setScatterScale(s.index("FSC-A")!, "arcsinh");
    expect(s.displayTransformContextKey).not.toBe(before);
  });

  it("changes when a scatter cofactor changes", () => {
    const s = load(ARIA_SMALL);
    const before = s.displayTransformContextKey;
    s.setScatterCofactor(s.index("FSC-A")!, 900);
    expect(s.displayTransformContextKey).not.toBe(before);
  });

  it("returns to the original key when the change is undone", () => {
    const s = load(ARIA_SMALL);
    const before = s.displayTransformContextKey;
    const idx = s.index("FSC-A")!;
    s.setScatterScale(idx, "arcsinh");
    s.setScatterScale(idx, "linear");
    expect(s.displayTransformContextKey).toBe(before);
  });

  it("does not change for a CyTOF sample, which has no scatter axis", () => {
    const s = load(BODENMILLER);
    const before = s.displayTransformContextKey;
    s.setScatterScale(0, "linear");
    expect(s.displayTransformContextKey).toBe(before);
  });
});

describe("gate display coordinates follow the transform", () => {
  // The App memoises the plotted gates. If that memo does not depend on the display
  // transform, the gate keeps coordinates computed under the previous scale while the
  // event cloud and axis move to the new one, and the gate slides off its own events.
  // These assert the inputs really do change, so the memo must track them.
  function rectOnScatter(): Gate {
    return {
      gate_id: "g", name: "Cells", gate_type: "rectangle",
      x_channel: "FSC-A", y_channel: "SSC-A",
      vertices: [[20000, 10000], [80000, 10000], [80000, 90000], [20000, 90000]],
      color: "#e41a1c", label_offset: null,
    };
  }
  const displayX = (s: Sample, g: Gate) =>
    (g.gate_type === "polygon" || g.gate_type === "rectangle" ? g.vertices : []).map(([vx]) => s.gatingToDisplay("FSC-A", vx));

  it("moves the gate outline when the scatter cofactor changes on an arcsinh axis", () => {
    const s = load(ARIA_SMALL);
    const g = rectOnScatter();
    s.setScatterScale(s.index("FSC-A")!, "arcsinh");
    const before = displayX(s, g);
    s.setScatterCofactor(s.index("FSC-A")!, 900);
    expect(displayX(s, g)).not.toEqual(before);
  });

  it("moves the gate outline when the axis switches to arcsinh, and back to raw units on linear", () => {
    const s = load(ARIA_SMALL);
    const g = rectOnScatter();
    const before = displayX(s, g);
    // Linear is the identity, so the outline starts in raw units.
    expect(before[0]).toBeCloseTo(20000, 6);
    s.setScatterScale(s.index("FSC-A")!, "arcsinh");
    const bowed = displayX(s, g);
    expect(bowed).not.toEqual(before);
    expect(bowed[0]).toBeCloseTo(Math.asinh(20000 / 150), 6);
    s.setScatterScale(s.index("FSC-A")!, "linear");
    expect(displayX(s, g)).toEqual(before);
  });
});

describe("scatter axis ticks follow the scale", () => {
  it("uses raw-unit decade ticks on an arcsinh scatter axis", () => {
    const s = load(ARIA_SMALL);
    const idx = s.index("FSC-A")!;
    s.setScatterScale(idx, "arcsinh");
    expect(s.channelTicks(idx, s.displayRange(idx))).not.toBeNull();
  });

  it("uses evenly spaced K/M ticks on a linear scatter axis", () => {
    // Decade labels on a linear axis crowd into the low end and overlap illegibly, but
    // D3's default formatter would print "10,000,000" where every other axis reads "10M".
    const s = load(ARIA_SMALL);
    const idx = s.index("FSC-A")!;
    s.setScatterScale(idx, "linear");
    const ticks = s.channelTicks(idx, s.displayRange(idx));
    expect(ticks).not.toBeNull();
    expect(ticks!.major_labels.some((l) => /[KM]$/.test(l))).toBe(true);
    expect(ticks!.major_labels.some((l) => l.includes(","))).toBe(false);
    // Evenly spaced: every gap identical.
    const gaps = ticks!.major_pos.slice(1).map((v, i) => v - ticks!.major_pos[i]);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 6);
  });

  it("restores decade ticks when the axis goes to arcsinh after linear", () => {
    const s = load(ARIA_SMALL);
    const idx = s.index("FSC-A")!;
    s.setScatterScale(idx, "arcsinh");
    s.setScatterScale(idx, "linear");
    s.setScatterScale(idx, "arcsinh");
    expect(s.channelTicks(idx, s.displayRange(idx))).not.toBeNull();
  });
});

// The app always attaches a shared ChannelScales; the tests above do not. That difference hid a
// real bug: with scales attached, setScatterScale / setLogicleW write to the shared store and
// return EARLY, without invalidating the channel's cached transform, display column and range.
// The plot then kept drawing the old coordinates while the axis was refitted to the new ones —
// which collapsed the view to a single tick at 0, and Fit data + gates could not recover it
// because the stale range came back every time.
describe("a shared ChannelScales still invalidates the channel's caches", () => {
  it("changes the display coordinate and the auto range when scatter goes arcsinh, and back", () => {
    const s = load(ARIA_SMALL);
    const scales = new ChannelScales();
    s.attachChannelScales(scales);
    const idx = s.index("FSC-A")!;

    // Warm every cache the way the app does before the user touches the control.
    const beforeDisplay = s.rawToDisplay("FSC-A", 12345);
    const beforeRange = s.displayRange(idx);
    expect(s.transformKind(idx)).toBe("identity");
    expect(beforeRange[1]).toBeGreaterThan(1000);

    s.setScatterScale(idx, "arcsinh");

    expect(s.scatterScale(idx)).toBe("arcsinh");
    expect(s.transformKind(idx)).toBe("asinh");
    expect(s.rawToDisplay("FSC-A", 12345)).toBeCloseTo(Math.asinh(12345 / 150), 6);
    expect(s.rawToDisplay("FSC-A", 12345)).not.toBeCloseTo(beforeDisplay, 6);
    // The auto range must move with it, or the axis is fitted to coordinates nothing is drawn at.
    expect(s.displayRange(idx)[1]).not.toBeCloseTo(beforeRange[1], 6);
    expect(s.displayRange(idx)[1]).toBeLessThan(20);

    s.setScatterScale(idx, "linear");
    expect(s.transformKind(idx)).toBe("identity");
    expect(s.rawToDisplay("FSC-A", 12345)).toBeCloseTo(12345, 6);
    expect(s.displayRange(idx)[1]).toBeCloseTo(beforeRange[1], 6);
  });

  it("changes the display coordinate when the logicle W moves", () => {
    const s = load(ARIA_SMALL);
    s.attachChannelScales(new ChannelScales());
    const idx = s.channels.findIndex((_c, i) => s.isLogicleChannel(i));
    expect(idx).toBeGreaterThanOrEqual(0);
    const key = s.channels[idx].key;
    const before = s.rawToDisplay(key, 5000);
    s.setLogicleW(idx, 1.75);
    expect(s.rawToDisplay(key, 5000)).not.toBeCloseTo(before, 6);
  });
});
