// @vitest-environment jsdom
//
// Tick labels on a biexponential axis whose view reaches past the ends of its table. The table pins
// every value beyond an end to the end channel, so every decade and minor tick beyond it was drawn
// there, a stack of labels; they are dropped wherever an axis is labelled (Sample.channelTicks for
// the Gating, Strategy, Illustration and compensation views, figureDisplaySample for a figure's
// fixed transforms). Labels only: a gate held in raw values and one held on its own biex keep every
// event, counted here against the events themselves. Synthetic channels and events.

import { describe, expect, it } from "vitest";
import type { BiexParams } from "./biex";
import { biexTransform } from "./biex";
import { ChannelScales } from "./channelScales";
import type { FcsFile } from "./fcs";
import { figureDisplaySample } from "./figure";
import type { Gate } from "./models";
import { computeGateMasks, gateMaskKey } from "./populations";
import { Sample } from "./sample";
import { logicleTicks, withoutPiledTicks, type AxisTicks } from "./ticks";

const DEFAULT: BiexParams = { maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -100, channelRange: 256, tableChannels: 4096 };

/** 4000 events over the full biex range, negatives included, the same every run. */
function columns(): Float32Array[] {
  const n = 4000;
  const fl1 = new Float32Array(n);
  const fl2 = new Float32Array(n);
  let seed = 12345;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < n; i++) {
    fl1[i] = Math.pow(10, next() * 5.3) - 2000;
    fl2[i] = Math.pow(10, next() * 5.3) - 2000;
  }
  return [fl1, fl2];
}

function biexSample(): Sample {
  const [fl1, fl2] = columns();
  const sample = new Sample({
    version: "FCS3.1", nEvents: fl1.length, instrument: "flow", keywords: {}, spillover: null,
    channels: [
      { index: 0, name: "FL1-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL2-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [fl1, fl2],
  } as unknown as FcsFile);
  sample.attachChannelScales(new ChannelScales());
  sample.applyFluorBiex({ "FL1-A": DEFAULT, "FL2-A": DEFAULT });
  return sample;
}

/** A rectangle held in raw values, and a polygon held on its own biex, as an import holds one. */
const RAW_RECT = { x: [1000, 100000], y: [-500, 20000] };
const GATES: Record<string, Gate> = {
  raw: {
    gate_id: "raw", name: "CD4_positive", gate_type: "rectangle", x_channel: "FL1-A", y_channel: "FL2-A",
    vertices: [[RAW_RECT.x[0], RAW_RECT.y[0]], [RAW_RECT.x[1], RAW_RECT.y[0]], [RAW_RECT.x[1], RAW_RECT.y[1]], [RAW_RECT.x[0], RAW_RECT.y[1]]],
    space: "raw", color: "#e41a1c", label_offset: null,
  },
  imported: {
    gate_id: "imported", name: "CD8_positive", gate_type: "rectangle", x_channel: "FL1-A", y_channel: "FL2-A",
    vertices: [[60, 100], [200, 100], [200, 230], [60, 230]],
    space: "display",
    transforms: { "FL1-A": { kind: "biex", ...DEFAULT }, "FL2-A": { kind: "biex", ...DEFAULT } },
    color: "#377eb8", label_offset: null,
  },
};

function counts(sample: Sample): Record<string, number> {
  const masks = computeGateMasks(GATES, sample.gateAssayData());
  const out: Record<string, number> = {};
  for (const id of Object.keys(GATES)) out[id] = masks[gateMaskKey(id)].reduce((sum, v) => sum + v, 0);
  return out;
}

/** The same two gates counted from the events themselves, without the gate code. */
function expectedCounts(): Record<string, number> {
  const [fl1, fl2] = columns();
  const t = biexTransform(DEFAULT);
  let raw = 0;
  let imported = 0;
  for (let i = 0; i < fl1.length; i++) {
    if (fl1[i] >= RAW_RECT.x[0] && fl1[i] <= RAW_RECT.x[1] && fl2[i] >= RAW_RECT.y[0] && fl2[i] <= RAW_RECT.y[1]) raw++;
    const dx = t.forward(fl1[i]);
    const dy = t.forward(fl2[i]);
    if (dx >= 60 && dx <= 200 && dy >= 100 && dy <= 230) imported++;
  }
  return { raw, imported };
}

const positions = (ticks: AxisTicks | null) => (ticks ? [...ticks.major_pos, ...ticks.minor_pos] : []);
const shared = (ticks: AxisTicks | null) => {
  const all = positions(ticks).sort((a, b) => a - b);
  return all.filter((p, i) => i > 0 && p - all[i - 1] <= 1e-9).length;
};

/** Views on one axis of the 0 … 256 table: inside, at each end, past each end, past both. */
const VIEWS: [number, number][] = [[35, 210], [0, 175], [80, 256], [-40, 200], [100, 300], [-100, 400]];

describe("ticks that land on one another", () => {
  it("drops every tick at a shared position and keeps the rest", () => {
    const ticks: AxisTicks = {
      major_pos: [0, 0, 21, 69, 75, 256, 256],
      major_labels: ["-10K", "-100K", "-1K", "-100", "0", "1M", "10M"],
      minor_pos: [0, 0, 40, 50, 256],
      tick_mode: "logicle",
    };
    expect(withoutPiledTicks(ticks)).toEqual({
      major_pos: [21, 69, 75],
      major_labels: ["-1K", "-100", "0"],
      minor_pos: [40, 50],
      tick_mode: "logicle",
    });
  });

  it("returns ticks with nothing shared unchanged", () => {
    const ticks: AxisTicks = { major_pos: [1, 2], major_labels: ["a", "b"], minor_pos: [1.5], tick_mode: "logicle" };
    expect(withoutPiledTicks(ticks)).toBe(ticks);
    expect(withoutPiledTicks(null)).toBeNull();
  });
});

describe("tick labels on a biex axis whose view reaches past the table", () => {
  it("piled at the ends before the fix: the decade ticks alone stack there", () => {
    const t = biexTransform(DEFAULT);
    const raw = logicleTicks((v) => t.forward(v), (v) => t.inverse(v), [-40, 300], DEFAULT.maxValue);
    expect(shared(raw)).toBeGreaterThan(2);
  });

  it("are never stacked on the Gating plot, in any view", () => {
    const sample = biexSample();
    const x = sample.index("FL1-A")!;
    const y = sample.index("FL2-A")!;
    for (const view of VIEWS) {
      const ticks = sample.channelTicks(x, view);
      expect(shared(ticks)).toBe(0);
      // Every tick kept is on the table, where its label says.
      expect(positions(ticks).every((p) => p > 0 && p < 256)).toBe(true);
      const payload = sample.plotPayload(x, y, "pseudocolor", [], null, null, view, view);
      expect(shared(payload.x_logicle_ticks)).toBe(0);
      expect(shared(payload.y_logicle_ticks)).toBe(0);
    }
    // The labels in view are still there.
    expect(sample.channelTicks(x, [-40, 300])!.major_labels).toEqual(expect.arrayContaining(["-1K", "-100", "0", "100", "1K", "10K", "100K"]));
  });

  it("are labelled on a figure's fixed biex axis as on the live one, and never stacked", () => {
    const sample = biexSample();
    const x = sample.index("FL1-A")!;
    const fixed = figureDisplaySample(sample, { "FL1-A": { kind: "biex", ...DEFAULT } });
    for (const view of VIEWS) {
      expect(shared(fixed.channelTicks(x, view))).toBe(0);
      expect(fixed.channelTicks(x, view)).toEqual(sample.channelTicks(x, view));
    }
  });

  it("move no gate: every count matches the events before and after every axis is labelled", () => {
    const sample = biexSample();
    const expected = expectedCounts();
    // Neither gate is vacuous.
    for (const n of Object.values(expected)) {
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(4000);
    }
    expect(counts(sample)).toEqual(expected);
    const x = sample.index("FL1-A")!;
    const y = sample.index("FL2-A")!;
    const fixed = figureDisplaySample(sample, { "FL1-A": { kind: "biex", ...DEFAULT }, "FL2-A": { kind: "biex", ...DEFAULT } });
    for (const view of VIEWS) {
      sample.channelTicks(x, view);
      sample.plotPayload(x, y, "pseudocolor", Object.values(GATES), null, null, view, view);
      fixed.channelTicks(y, view);
    }
    expect(counts(sample)).toEqual(expected);
    expect(counts(fixed)).toEqual(expected);
  });
});
