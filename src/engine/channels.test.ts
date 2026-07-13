import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolveChannels } from "./channels";
import { parseFcs, type FcsFile, type FcsChannel } from "./fcs";

function mkFcs(
  instrument: "flow" | "cytof",
  chans: { name: string; marker: string | null }[],
): FcsFile {
  const channels: FcsChannel[] = chans.map((c, i) => ({
    index: i,
    name: c.name,
    marker: c.marker,
    bits: 32,
    range: 262144,
  }));
  return {
    version: "FCS3.1",
    nEvents: 1,
    instrument,
    keywords: {},
    spillover: null,
    channels,
    columns: chans.map(() => Float32Array.of(0)),
  };
}

describe("resolveChannels — spectral-unmixed flow", () => {
  it("keeps scatter + unmixed (renamed) + Time, drops raw detectors", () => {
    const fcs = mkFcs("flow", [
      { name: "FSC-A", marker: "FSC-A" },
      { name: "SSC (Violet)-A", marker: "SSC (Violet)-A" },
      { name: "B1-A", marker: null }, // raw spectral detector → drop
      { name: "B2-A", marker: "" }, // raw spectral detector → drop
      { name: "V500-A", marker: "CD4-A" }, // unmixed → keep, renamed
      { name: "PE-A", marker: "CD25-A" }, // unmixed → keep, renamed
      { name: "Time", marker: null },
    ]);
    const keys = resolveChannels(fcs).map((c) => c.key);
    expect(keys).toEqual([
      "FSC-A",
      "SSC (Violet)-A",
      "CD4-A (V500-A)",
      "CD25-A (PE-A)",
      "Time",
    ]);
  });

  it("preserves $PnN on the renamed unmixed channels", () => {
    const fcs = mkFcs("flow", [
      { name: "V500-A", marker: "CD4-A" },
      { name: "PE-A", marker: "CD25-A" },
    ]);
    const r = resolveChannels(fcs);
    expect(r.map((c) => c.pnn)).toEqual(["V500-A", "PE-A"]);
  });
});

describe("resolveChannels — conventional flow (no unmixed)", () => {
  it("keeps all channels; key = marker if present else $PnN", () => {
    const fcs = mkFcs("flow", [
      { name: "FSC-A", marker: null },
      { name: "B530-A", marker: "CD3" }, // marker not ending -A → not 'unmixed'
      { name: "PE-A", marker: "" },
    ]);
    const keys = resolveChannels(fcs).map((c) => c.key);
    expect(keys).toEqual(["FSC-A", "CD3", "PE-A"]);
  });
});

const SPECTRAL = "/Users/davidpriest/Desktop/LP1p pbmc pre rec.fcs";

describe.runIf(existsSync(SPECTRAL))("resolveChannels — real BD S8 spectral file", () => {
  it("keeps 33 of 422 channels, matching GateLabR", () => {
    const b = readFileSync(SPECTRAL);
    const fcs = parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    expect(fcs.channels.length).toBe(422);
    const r = resolveChannels(fcs);
    expect(r.length).toBe(33);
    const keys = r.map((c) => c.key);
    expect(keys).toContain("FSC-A");
    expect(keys).toContain("SSC (Violet)-A");
    expect(keys).toContain("CD4-A (V500-A)");
    expect(keys).toContain("CD25-A (PE-A)");
    // no raw detector keys survive (unmixed markers are all "-A (…)")
    expect(keys.some((k) => k === "B1-A" || /^UV\d/.test(k))).toBe(false);
  });
});
