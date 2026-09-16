import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ChannelScales } from "./channelScales";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";

/** Two flow files that differ in their negative tail, so their auto W estimates differ. */
function flowFile(negativeTail: number): FcsFile {
  const names = ["FSC-A", "SSC-A", "CD19-A"];
  const n = 512;
  return {
    version: "FCS3.1",
    nEvents: n,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: names.map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: names.map((_, ci) =>
      Float32Array.from({ length: n }, (_, i) =>
        ci === 2 ? (i < n / 4 ? -negativeTail * (1 + (i % 7)) : 500 * (1 + (i % 90)))
                 : 1000 + ((i * 31) % 5000))),
  };
}

const LP4_DIR = "/Users/davidpriest/My Drive (davidpriest@cider.osaka-u.ac.jp)/Wing Lab/Large Projects/GateLab Paper/GateLab-2026-08-15-B flowjo-and-cytobank-concordance/data/lp4-igcb-s8/source/fcs";
const loadReal = (name: string) => {
  const b = readFileSync(`${LP4_DIR}/${name}`);
  return new Sample(parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
};

describe("workspace-wide channel scales", () => {
  it("uses the same fluorescence transform and ticks when files have different positive ranges", () => {
    const a = new Sample(flowFile(50));
    const fcs = flowFile(50);
    fcs.columns[2] = Float32Array.from(fcs.columns[2], v => v * 100);
    const b = new Sample(fcs);
    const idx = a.index("CD19-A")!;
    expect(a.logicleT(idx)).not.toEqual(b.logicleT(idx));
    const scales = new ChannelScales();
    a.attachChannelScales(scales);
    // Warm the first file before adding another: existing cached coordinates must update too.
    const before = a.displayColumn(idx);
    b.attachChannelScales(scales);
    expect(a.displayColumn(idx)).not.toBe(before);
    expect(a.transformSpec("CD19-A")).toEqual(b.transformSpec("CD19-A"));
    a.setLogicleW(idx, 1.5);
    expect(a.transformSpec("CD19-A")).toEqual(b.transformSpec("CD19-A"));
    expect(a.rawToDisplay("CD19-A", 10000)).toBeCloseTo(b.rawToDisplay("CD19-A", 10000), 10);
    expect(a.channelTicks(idx, [-0.1, 1.1])).toEqual(b.channelTicks(idx, [-0.1, 1.1]));
  });

  it("gives files with different data one shared auto W", () => {
    const a = new Sample(flowFile(50));
    const b = new Sample(flowFile(4000));
    const ia = a.index("CD19-A")!, ib = b.index("CD19-A")!;

    // Unattached, each file estimates its own W from its own 5th percentile — the split.
    expect(a.currentLogicleW(ia)).not.toBeCloseTo(b.currentLogicleW(ib), 3);

    const scales = new ChannelScales();
    a.attachChannelScales(scales);
    b.attachChannelScales(scales);
    expect(a.currentLogicleW(ia)).toBeCloseTo(b.currentLogicleW(ib), 10);
    // The widest request wins, so no file's negative population is squashed off-axis.
    expect(a.currentLogicleW(ia)).toBeCloseTo(Math.max(a.ownAutoLogicleW(ia), b.ownAutoLogicleW(ib)), 10);
  });

  it("applies an explicit W to every attached file", () => {
    const scales = new ChannelScales();
    const a = new Sample(flowFile(50)); const b = new Sample(flowFile(4000));
    a.attachChannelScales(scales); b.attachChannelScales(scales);
    const ia = a.index("CD19-A")!, ib = b.index("CD19-A")!;

    a.setLogicleW(ia, 1.75);
    expect(b.currentLogicleW(ib)).toBeCloseTo(1.75, 10);
  });

  it("gives a file loaded AFTER the change the current setting", () => {
    // The case a fan-out over existing samples can never cover.
    const scales = new ChannelScales();
    const a = new Sample(flowFile(50));
    a.attachChannelScales(scales);
    a.setLogicleW(a.index("CD19-A")!, 1.6);

    const late = new Sample(flowFile(4000));
    late.attachChannelScales(scales);
    expect(late.currentLogicleW(late.index("CD19-A")!)).toBeCloseTo(1.6, 10);
  });

  it("rebuilds a late file's cached display coordinates under the shared scale", () => {
    const scales = new ChannelScales();
    const first = new Sample(flowFile(50));
    first.attachChannelScales(scales);
    first.setScatterScale(first.index("FSC-A")!, "linear");

    const late = new Sample(flowFile(4000));
    const idx = late.index("FSC-A")!;
    const raw = 2_345;
    const cachedArcsinh = late.rawToDisplay("FSC-A", raw);
    const cachedRange = late.displayRange(idx);
    expect(cachedArcsinh).not.toBeCloseTo(raw, 6);

    late.attachChannelScales(scales);

    expect(late.scatterScale(idx)).toBe("linear");
    expect(late.transformKind(idx)).toBe("identity");
    expect(late.rawToDisplay("FSC-A", raw)).toBeCloseTo(raw, 6);
    expect(late.displayRange(idx)).not.toEqual(cachedRange);
  });

  it("resets to the shared estimate, never back to each file's own", () => {
    const scales = new ChannelScales();
    const a = new Sample(flowFile(50)); const b = new Sample(flowFile(4000));
    a.attachChannelScales(scales); b.attachChannelScales(scales);
    const ia = a.index("CD19-A")!, ib = b.index("CD19-A")!;

    a.setLogicleW(ia, 1.2);
    a.resetLogicleW(ia);
    expect(a.currentLogicleW(ia)).toBeCloseTo(b.currentLogicleW(ib), 10);
  });

  it("keeps an explicit choice per instrument, and shares it between the assay layers", () => {
    const scales = new ChannelScales();
    const flow = new Sample(flowFile(50));
    flow.attachChannelScales(scales);
    const ia = flow.index("CD19-A")!;
    flow.setLogicleW(ia, 1.4);
    expect(scales.logicleW(flow.workspaceScaleContextKey, "CD19-A")).toBeCloseTo(1.4, 10);
    // The user's W follows the channel onto the compensated layer: applying a matrix must not
    // reset an axis. Only the auto estimates are per layer.
    expect(scales.logicleW(JSON.stringify(["compensated", "flow"]), "CD19-A")).toBeCloseTo(1.4, 10);
    expect(scales.logicleW(JSON.stringify(["original", "cytof"]), "CD19-A")).toBeUndefined();
  });

  it("ignores a W written to a channel that is not logicle in that file", () => {
    const scales = new ChannelScales();
    const a = new Sample(flowFile(50));
    a.attachChannelScales(scales);
    const scatter = a.index("FSC-A")!;
    expect(a.isLogicleChannel(scatter)).toBe(false);
    a.setLogicleW(scatter, 1.9);
    expect(scales.logicleW(a.workspaceScaleContextKey, "FSC-A")).toBeUndefined();
  });

  it("unifies the real LP4 files, which open split", () => {
    if (!existsSync(`${LP4_DIR}/LP4 rec.fcs`)) return; // fixtures are local-only
    const files = ["LP4 rec.fcs", "LP4 sort rec.fcs", "LP4.3 purity after bflush.fcs", "LP4.4 purity.fcs"];
    const samples = files.map(loadReal);
    const key = "CD19-A (BV421-A)";

    const before = samples.map((s) => s.currentLogicleW(s.index(key)!));
    expect(Math.max(...before) - Math.min(...before)).toBeGreaterThan(0.5); // 0.500 vs 1.143

    const scales = new ChannelScales();
    for (const s of samples) s.attachChannelScales(scales);
    const after = samples.map((s) => s.currentLogicleW(s.index(key)!));
    expect(Math.max(...after) - Math.min(...after)).toBe(0);
  });
});

describe("explicit choices carry across assay layers", () => {
  const original = JSON.stringify(["original", "flow"]);
  const compensated = JSON.stringify(["compensated", "flow"]);
  const participant = (contextKey: string, w: number) => ({
    workspaceScaleContextKey: contextKey,
    invalidated: [] as number[],
    index: (key: string) => (key === "CD19-A" ? 2 : key === "FSC-A" ? 0 : undefined),
    ownAutoLogicleW: () => w,
    ownAutoLogicleT: () => 262144,
    invalidateChannelForScales(idx: number) { this.invalidated.push(idx); },
  });

  it("a linear axis, an arcsinh channel, a cofactor and an explicit W chosen on one layer are read on the other", () => {
    const scales = new ChannelScales();
    scales.setScatterLinear(original, "FSC-A", true);
    scales.setFluorArcsinh(original, "CD19-A", true);
    scales.setScatterCofactor(original, "FSC-A", 300);
    scales.setLogicleW(original, "CD19-A", 1.2);
    expect(scales.isScatterLinear(compensated, "FSC-A")).toBe(true);
    expect(scales.isFluorArcsinh(compensated, "CD19-A")).toBe(true);
    expect(scales.scatterCofactor(compensated, "FSC-A")).toBe(300);
    expect(scales.logicleW(compensated, "CD19-A")).toBeCloseTo(1.2, 10);
    expect(scales.logicleWEntries(compensated)).toEqual({ "CD19-A": 1.2 });
    expect(scales.identityFor(compensated, ["CD19-A", "FSC-A"]))
      .toEqual(scales.identityFor(original, ["CD19-A", "FSC-A"]));
    scales.resetLogicleW(compensated, "CD19-A");
    expect(scales.logicleW(original, "CD19-A")).toBeUndefined();
  });

  it("the auto W stays per layer, and a change reaches the files on both layers", () => {
    const scales = new ChannelScales();
    const a = participant(original, 0.5);
    const b = participant(compensated, 1.4);
    scales.register(a);
    scales.register(b);
    expect(scales.autoLogicleW(original, "CD19-A")).toBe(0.5);
    expect(scales.autoLogicleW(compensated, "CD19-A")).toBe(1.4);
    scales.setLogicleW(original, "CD19-A", 1.0);
    expect(a.invalidated).toEqual([2]);
    expect(b.invalidated).toEqual([2]);
  });

  it("a key that is not a layered context is its own scope", () => {
    const scales = new ChannelScales();
    scales.setScatterLinear("ctx-a", "FSC-A", true);
    expect(scales.isScatterLinear("ctx-a", "FSC-A")).toBe(true);
    expect(scales.isScatterLinear("ctx-b", "FSC-A")).toBe(false);
  });
});

