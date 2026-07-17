import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFcs, type FcsFile } from "./fcs";
import { Sample } from "./sample";
import { transformChannel } from "./transforms";
import { decodeFloat32Base64 } from "./encode";

const ARIA_SMALL =
  "/Users/davidpriest/code/gatelabr-test-fcs/conventional_comp_AriaIII/sample_Bmem_purity_small.fcs";

function loadArrayBuffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function syntheticFlow(channelNames: string[]): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: 3,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: channelNames.map((name, index) => ({
      index,
      name,
      marker: null,
      bits: 32,
      range: 262144,
    })),
    columns: channelNames.map((_, index) =>
      Float32Array.from([100 + index, 200 + index, 300 + index])),
  };
}

describe("Sample — flow (Aria III), raw gating space", () => {
  const fcs = parseFcs(loadArrayBuffer(ARIA_SMALL));
  const s = new Sample(fcs);

  it("flow gates in raw space", () => {
    expect(s.instrument).toBe("flow");
    expect(s.gatingSpace).toBe("raw");
  });

  it("instrument override flips the effective instrument + gating space, and reverts on auto", () => {
    const s2 = new Sample(fcs);
    expect(s2.instrumentMode).toBe("auto");
    expect(s2.instrument).toBe("flow");
    s2.setInstrumentMode("cytof");
    expect(s2.instrument).toBe("cytof");
    expect(s2.gatingSpace).toBe("display");
    expect(s2.instrumentMode).toBe("cytof");
    s2.setInstrumentMode("auto");
    expect(s2.detectedInstrument).toBe("flow"); // detection preserved
    expect(s2.instrument).toBe("flow"); // effective reverts to detected
    expect(s2.gatingSpace).toBe("raw");
  });

  it("logicle display values are always finite (never the -1 non-convergence sentinel)", () => {
    const peIdx = s.index("PE-A")!;
    const disp = s.displayColumn(peIdx);
    for (let i = 0; i < disp.length; i++) {
      expect(Number.isFinite(disp[i])).toBe(true);
      expect(disp[i]).not.toBe(-1);
    }
  });

  it("displayColumn matches the validated transformChannel", () => {
    const peIdx = s.index("PE-A")!;
    const disp = s.displayColumn(peIdx);
    const ref = transformChannel(fcs.columns[peIdx], "PE-A", "flow");
    for (let i = 0; i < disp.length; i += 37) expect(disp[i]).toBeCloseTo(ref[i], 6);
  });

  it("gatingColumn is the raw FCS column (flow)", () => {
    const peIdx = s.index("PE-A")!;
    const g = s.gatingColumn(peIdx);
    expect(g).toBe(fcs.columns[peIdx]); // raw, same reference
  });

  it("vertex round-trips gating↔display on signal and scatter channels", () => {
    for (const ch of ["PE-A", "FSC-A"]) {
      for (const raw of [-100, 0, 250, 12345, 100000]) {
        const disp = s.gatingToDisplay(ch, raw);
        expect(s.displayToGating(ch, disp)).toBeCloseTo(raw, 2);
      }
    }
  });

  it("scatter gatingToDisplay is arcsinh(x/150)", () => {
    expect(s.gatingToDisplay("FSC-A", 150)).toBeCloseTo(Math.asinh(1), 6);
  });

  it("restores a per-channel scatter cofactor and keeps raw/display conversion invertible", () => {
    const local = new Sample(fcs);
    const idx = local.index("FSC-A")!;
    local.setScatterCofactor(idx, 300);
    expect(local.currentScatterCofactor(idx)).toBe(300);
    expect(local.rawToDisplay("FSC-A", 300)).toBeCloseTo(Math.asinh(1), 6);
    expect(local.displayToRaw("FSC-A", Math.asinh(1))).toBeCloseTo(300, 6);
    expect(local.scatterCofactorOverrides()).toEqual({ "FSC-A": 300 });
  });

  it("opens flow data on FSC-A vs SSC-A", () => {
    const [x, y] = s.defaultChannelIndices();
    expect(s.channels[x].key).toBe("FSC-A");
    expect(s.channels[y].key).toBe("SSC-A");
  });

  it("logicle W override changes the display column, reset restores it", () => {
    const i = s.index("PE-A")!;
    expect(s.isLogicleChannel(i)).toBe(true);
    const auto = s.autoLogicleW(i);
    const before = Array.from(s.displayColumn(i).slice(0, 20));
    s.setLogicleW(i, Math.min(auto + 0.4, 2.0));
    expect(s.currentLogicleW(i)).not.toBeCloseTo(auto, 6);
    const after = Array.from(s.displayColumn(i).slice(0, 20));
    expect(after).not.toEqual(before); // display recomputed with new W
    s.resetLogicleW(i);
    expect(s.currentLogicleW(i)).toBeCloseTo(auto, 6);
    expect(Array.from(s.displayColumn(i).slice(0, 20))).toEqual(before);
  });
});

describe("Sample — default flow overview axes", () => {
  it("prefers area scatter even when fluorescence and H/W channels appear first", () => {
    const sample = new Sample(syntheticFlow([
      "Time", "FITC-A", "FSC-H", "SSC-W", "SSC-A", "FSC-A",
    ]));
    const [x, y] = sample.defaultChannelIndices();

    expect(sample.channels[x].key).toBe("FSC-A");
    expect(sample.channels[y].key).toBe("SSC-A");
  });

  it("falls back to the available forward and side scatter variants", () => {
    const sample = new Sample(syntheticFlow(["Time", "CD3-A", "SS LOG", "FS INT"]));
    const [x, y] = sample.defaultChannelIndices();

    expect(sample.channels[x].key).toBe("FS INT");
    expect(sample.channels[y].key).toBe("SS LOG");
  });
});

describe("Sample — CyTOF, display gating space", () => {
  // Minimal synthetic CyTOF file: metal channels + acquisition params.
  const n = 5;
  const mk = (vals: number[]) => Float32Array.from(vals);
  const cytof: FcsFile = {
    version: "FCS3.1",
    nEvents: n,
    instrument: "cytof",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "Time", marker: null, bits: 32, range: 1 },
      { index: 1, name: "Ce140Di", marker: "CD3", bits: 32, range: 1 },
      { index: 2, name: "Nd144Di", marker: "CD19", bits: 32, range: 1 },
      { index: 3, name: "Er167Di", marker: "CD27", bits: 32, range: 1 },
    ],
    columns: [
      mk([1, 2, 3, 4, 5]),
      mk([0, 5, 50, 500, 5000]),
      mk([0, 10, 100, 1000, 10000]),
      mk([2, 4, 8, 16, 32]),
    ],
  };
  const s = new Sample(cytof);

  it("CyTOF keys channels by marker; gates in display (asinh) space; identity conversion", () => {
    expect(s.instrument).toBe("cytof");
    expect(s.gatingSpace).toBe("display");
    // metal $PnN with a marker → keyed by the marker
    expect(s.channels.map((c) => c.key)).toEqual(["Time", "CD3", "CD19", "CD27"]);
    expect(s.gatingToDisplay("CD3", 3.14)).toBe(3.14);
    expect(s.displayToGating("CD3", 3.14)).toBe(3.14);
  });

  it("keeps the first two non-QC markers as the CyTOF overview axes", () => {
    const [x, y] = s.defaultChannelIndices();
    expect(s.channels[x].key).toBe("CD3");
    expect(s.channels[y].key).toBe("CD19");
  });

  it("metal displayColumn is asinh(raw/5); Time is raw", () => {
    const cd3 = s.displayColumn(1);
    expect(cd3[3]).toBeCloseTo(Math.asinh(500 / 5), 6);
    const time = s.displayColumn(0);
    expect(Array.from(time)).toEqual([1, 2, 3, 4, 5]);
  });

  it("restores a non-default CyTOF cofactor and rebuilds display/gating columns", () => {
    const local = new Sample(cytof);
    const before = local.displayColumn(1)[3];
    local.setCytofCofactor(10);
    expect(local.arcsinhCofactor).toBe(10);
    expect(local.displayColumn(1)[3]).toBeCloseTo(Math.asinh(500 / 10), 6);
    expect(local.displayColumn(1)[3]).not.toBe(before);
    expect(local.gatingColumn(1)[3]).toBeCloseTo(Math.asinh(500 / 10), 6);
  });

  it("gatingColumn equals displayColumn for CyTOF", () => {
    expect(Array.from(s.gatingColumn(1))).toEqual(Array.from(s.displayColumn(1)));
  });

  it("downsamples a masked population directly to the plot cap", () => {
    const mask = Uint8Array.from([1, 0, 1, 1, 0]);
    const payload = s.plotPayload(1, 2, "dots", [], mask, null, null, null, 2);
    const plottedX = decodeFloat32Base64(payload.x_b64);
    const fullX = s.displayColumn(1);

    expect(payload.n_events).toBe(3); // title/count still reports the full population
    expect(Array.from(plottedX)).toEqual([fullX[0], fullX[3]]); // ranks 0 and 2 of mask
  });
});

describe("Sample — singular spillover disables compensation", () => {
  const mk = (vals: number[]) => Float32Array.from(vals);
  // Flow file with a scatter channel (→ instrument stays flow) + two fluor channels
  // whose $SPILLOVER is singular ([[1,1],[1,1]]): non-identity (so it extracts) but
  // non-invertible (so setCompensation(true) must fail closed).
  const singular = (): FcsFile => ({
    version: "FCS3.1",
    nEvents: 4,
    instrument: "flow",
    keywords: {},
    spillover: { channels: ["PE-A", "APC-A"], matrix: [[1, 1], [1, 1]] },
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "PE-A", marker: null, bits: 32, range: 262144 },
      { index: 2, name: "APC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [mk([100, 200, 300, 400]), mk([10, 20, 30, 40]), mk([5, 15, 25, 35])],
  });

  it("extracts the non-identity spillover but leaves compensation off (singular)", () => {
    const s = new Sample(singular());
    expect(s.hasCompensation).toBe(true); // non-identity → spillover present
    expect(s.compensationEnabled).toBe(false);
    s.setCompensation(true);
    expect(s.compensationEnabled).toBe(false); // invertMatrix returned null → disabled
  });

  it("gating values are unchanged after the failed compensation toggle", () => {
    const s = new Sample(singular());
    const peIdx = s.index("PE-A")!;
    const before = Array.from(s.gatingColumn(peIdx));
    s.setCompensation(true);
    expect(Array.from(s.gatingColumn(peIdx))).toEqual(before); // raw, uncompensated
  });
});

describe("Sample — Panel display labels (identity `key` is preserved)", () => {
  const mk = (vals: number[]) => Float32Array.from(vals);
  const base = (): FcsFile => ({
    version: "FCS3.1",
    nEvents: 5,
    instrument: "cytof",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "Time", marker: null, bits: 32, range: 1 },
      { index: 1, name: "Ce140Di", marker: "CD3", bits: 32, range: 1 },
      { index: 2, name: "Nd144Di", marker: "CD19", bits: 32, range: 1 },
    ],
    columns: [mk([1, 2, 3, 4, 5]), mk([0, 5, 50, 500, 5000]), mk([0, 10, 100, 1000, 10000])],
  });

  it("channelLabel defaults to the key; rename changes only the label", () => {
    const s = new Sample(base());
    const cd3 = s.index("CD3")!;
    expect(s.channelLabel(cd3)).toBe("CD3");
    s.setChannelLabel(cd3, "CD3 (T cells)");
    expect(s.channelLabel(cd3)).toBe("CD3 (T cells)");
    expect(s.channels[cd3].key).toBe("CD3"); // identity unchanged
    expect(s.index("CD3")).toBe(cd3); // byName still keyed by identity
  });

  it("labelForKey / keyForLabel round-trip (drives the cytof gate/axis translation)", () => {
    const s = new Sample(base());
    s.setChannelLabel(s.index("CD3")!, "T");
    expect(s.labelForKey("CD3")).toBe("T");
    expect(s.keyForLabel("T")).toBe("CD3");
    expect(s.keyForLabel("CD19")).toBe("CD19"); // un-renamed → identity
    expect(s.keyForLabel("nope")).toBe("nope"); // unknown → passthrough
  });

  it("empty / key-equal label clears the override", () => {
    const s = new Sample(base());
    const cd3 = s.index("CD3")!;
    s.setChannelLabel(cd3, "X");
    s.setChannelLabel(cd3, "");
    expect(s.channels[cd3].label).toBeUndefined();
    s.setChannelLabel(cd3, "CD3");
    expect(s.channels[cd3].label).toBeUndefined();
  });

  it("scatter/QC channels are not renamable; markers are", () => {
    const s = new Sample(base());
    expect(s.isRenamable(s.index("Time")!)).toBe(false); // QC
    expect(s.isRenamable(s.index("CD3")!)).toBe(true);
  });

  it("renaming does NOT change the display transform (cosmetic only)", () => {
    const s = new Sample(base());
    const cd3 = s.index("CD3")!;
    const before = Array.from(s.displayColumn(cd3));
    s.setChannelLabel(cd3, "FSC-A"); // even a scatter-looking label must not flip the transform
    expect(Array.from(s.displayColumn(cd3))).toEqual(before);
  });

  it("labelOverrides / applyLabelOverrides round-trip (workspace save/restore)", () => {
    const s = new Sample(base());
    s.setChannelLabel(s.index("CD3")!, "T");
    s.setChannelLabel(s.index("CD19")!, "B");
    expect(s.labelOverrides()).toEqual({ CD3: "T", CD19: "B" });
    const s2 = new Sample(base());
    s2.applyLabelOverrides(s.labelOverrides());
    expect(s2.channelLabel(s2.index("CD3")!)).toBe("T");
    expect(s2.channelLabel(s2.index("CD19")!)).toBe("B");
  });
});
