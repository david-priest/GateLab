import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFcs, type FcsFile } from "./fcs";
import { Sample } from "./sample";
import {
  exportPopulationFcs,
  exportPopulationFcsCombined,
  sanitizeFcsName,
  writeFcs,
} from "./fcsExport";

const ARIA_SMALL =
  "/Users/davidpriest/code/gatelabr-test-fcs/conventional_comp_AriaIII/sample_Bmem_purity_small.fcs";

function loadArrayBuffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
const toAB = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

function syntheticSample(channels: { name: string; values: number[] }[]): Sample {
  const nEvents = channels[0]?.values.length ?? 0;
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents,
    channels: channels.map((ch, index) => ({ index, name: ch.name, marker: null, bits: 32, range: 262144 })),
    keywords: {},
    columns: channels.map((ch) => Float32Array.from(ch.values)),
    spillover: null,
    instrument: "flow",
  };
  return new Sample(fcs);
}

describe("writeFcs — round-trips through parseFcs", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const nAll = sample.fcs.nEvents;

  // Mask: keep every third event (a genuine subset, order preserved).
  const mask = new Uint8Array(nAll);
  const keep: number[] = [];
  for (let i = 0; i < nAll; i++) if (i % 3 === 0) { mask[i] = 1; keep.push(i); }

  const bytes = exportPopulationFcs(sample, mask, "original");
  const re = parseFcs(toAB(bytes));

  it("writes a valid FCS 3.0 the parser accepts", () => {
    expect(re.version).toBe("FCS3.0");
    expect(re.nEvents).toBe(keep.length);
    expect(re.channels.length).toBe(sample.channels.length);
  });

  it("uses ORIGINAL $PnN names and display $PnS descriptions", () => {
    re.channels.forEach((c, i) => {
      expect(c.name).toBe(sample.channels[i].pnn || sample.channels[i].key);
    });
  });

  it("preserves the raw values (event order preserved) for the kept subset", () => {
    for (let j = 0; j < sample.channels.length; j++) {
      const orig = sample.rawColumnData(j);
      for (let k = 0; k < keep.length; k += 37) {
        expect(re.columns[j][k]).toBeCloseTo(orig[keep[k]], 2);
      }
    }
  });

  it("writes $PnR = 262144 and float32 data", () => {
    expect(re.keywords["$P1R"]).toBe("262144");
    expect(re.keywords["$DATATYPE"]).toBe("F");
    expect(re.keywords["$P1B"]).toBe("32");
    expect(re.keywords["$TOT"]).toBe(String(keep.length));
    expect(re.keywords["$PAR"]).toBe(String(sample.channels.length));
  });

  it("null mask exports every event", () => {
    const all = parseFcs(toAB(exportPopulationFcs(sample, null, "original")));
    expect(all.nEvents).toBe(nAll);
  });

  it("rejects a population mask with the wrong event count", () => {
    expect(() => exportPopulationFcs(sample, new Uint8Array(nAll - 1), "original"))
      .toThrow(/mask has .* events but the sample has/i);
  });

  it("writeFcs handles a tiny hand-built matrix exactly", () => {
    const cols = [Float32Array.from([1, 2, 3]), Float32Array.from([-0.5, 0, 12345.5])];
    const chans = [
      { name: "FSC-A", desc: "" },
      { name: "V1", desc: "CD3" },
    ];
    const r = parseFcs(toAB(writeFcs(cols, chans)));
    expect(r.nEvents).toBe(3);
    expect(r.channels.map((c) => c.name)).toEqual(["FSC-A", "V1"]);
    expect(Array.from(r.columns[0])).toEqual([1, 2, 3]);
    expect(r.columns[1][2]).toBeCloseTo(12345.5, 3);
  });

  it("$PnS follows a Panel-tab channel rename; $PnN stays the original", () => {
    const s = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
    s.setChannelLabel(0, "RenamedMarker");
    const r = parseFcs(toAB(exportPopulationFcs(s, null, "original")));
    expect(r.channels[0].marker).toBe("RenamedMarker"); // $PnS = the new label
    expect(r.channels[0].name).toBe(s.channels[0].pnn || s.channels[0].key); // $PnN unchanged
  });

  it("separates original, compensated-linear, and transformed display exports", () => {
    const s = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
    const idx = s.channels.findIndex((c) => c.pnn === "PE-A");
    expect(idx).toBeGreaterThanOrEqual(0);
    const original = s.originalColumnData(idx)[0];
    s.setCompensation(true);
    expect(s.compensationEnabled).toBe(true);
    const compensated = s.compensatedColumnData(idx)[0];
    const display = s.displayColumn(idx)[0];
    expect(compensated).not.toBe(original);
    expect(display).not.toBe(compensated);

    const originalBack = parseFcs(toAB(exportPopulationFcs(s, null, "original")));
    const compensatedBack = parseFcs(toAB(exportPopulationFcs(s, null, "compensated")));
    const displayBack = parseFcs(toAB(exportPopulationFcs(s, null, "display")));
    expect(originalBack.columns[idx][0]).toBeCloseTo(original, 6);
    expect(compensatedBack.columns[idx][0]).toBeCloseTo(compensated, 6);
    expect(displayBack.columns[idx][0]).toBeCloseTo(display, 6);
  });
});

describe("exportPopulationFcsCombined — concatenates masked events across samples", () => {
  const sampleA = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const sampleB = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const nA = sampleA.fcs.nEvents;
  const nB = sampleB.fcs.nEvents;

  const maskFirstK = (n: number, k: number): { mask: Uint8Array; count: number } => {
    const mask = new Uint8Array(n);
    const c = Math.min(k, n);
    for (let i = 0; i < c; i++) mask[i] = 1;
    return { mask, count: c };
  };

  it("concatenates event counts across 2 samples", () => {
    const a = maskFirstK(nA, 10);
    const b = maskFirstK(nB, 7);
    const bytes = exportPopulationFcsCombined(
      [
        { sample: sampleA, mask: a.mask },
        { sample: sampleB, mask: b.mask },
      ],
      "original",
    );
    const re = parseFcs(toAB(bytes));
    expect(re.version).toBe("FCS3.0");
    expect(re.nEvents).toBe(a.count + b.count);
    expect(re.channels.length).toBe(sampleA.channels.length);

    // Values are the two samples' kept rows back-to-back, in list order, per channel.
    const orig = sampleA.rawColumnData(0);
    expect(re.columns[0][0]).toBeCloseTo(orig[0], 2); // first event of sample A
    expect(re.columns[0][a.count]).toBeCloseTo(orig[0], 2); // first event of sample B
  });

  it("skips a sample whose mask is empty", () => {
    const a = maskFirstK(nA, 5);
    const emptyB = new Uint8Array(nB); // no bits set
    const bytes = exportPopulationFcsCombined(
      [
        { sample: sampleA, mask: a.mask },
        { sample: sampleB, mask: emptyB },
      ],
      "original",
    );
    const re = parseFcs(toAB(bytes));
    expect(re.nEvents).toBe(a.count);
  });

  it("uses the first non-empty sample for channel layout even if listed first is empty", () => {
    const emptyA = new Uint8Array(nA);
    const b = maskFirstK(nB, 4);
    const bytes = exportPopulationFcsCombined(
      [
        { sample: sampleA, mask: emptyA },
        { sample: sampleB, mask: b.mask },
      ],
      "original",
    );
    const re = parseFcs(toAB(bytes));
    expect(re.nEvents).toBe(b.count);
    expect(re.channels.length).toBe(sampleB.channels.length);
  });

  it("aligns identical channel sets when sample column order differs", () => {
    const first = syntheticSample([
      { name: "A", values: [1, 2] },
      { name: "B", values: [10, 20] },
    ]);
    const second = syntheticSample([
      { name: "B", values: [30] },
      { name: "A", values: [3] },
    ]);
    const bytes = exportPopulationFcsCombined([
      { sample: first, name: "first.fcs", mask: Uint8Array.from([1, 1]) },
      { sample: second, name: "second.fcs", mask: Uint8Array.from([1]) },
    ]);
    const re = parseFcs(toAB(bytes));
    expect(re.channels.map((ch) => ch.name)).toEqual(["A", "B"]);
    expect(Array.from(re.columns[0])).toEqual([1, 2, 3]);
    expect(Array.from(re.columns[1])).toEqual([10, 20, 30]);
  });

  it("rejects a contributing sample with missing channels instead of omitting it", () => {
    const full = syntheticSample([
      { name: "A", values: [1] },
      { name: "B", values: [2] },
    ]);
    const missing = syntheticSample([{ name: "A", values: [3] }]);
    expect(() => exportPopulationFcsCombined([
      { sample: full, name: "full.fcs", mask: Uint8Array.from([1]) },
      { sample: missing, name: "missing.fcs", mask: Uint8Array.from([1]) },
    ])).toThrow(/missing\.fcs.*missing: B.*split zip/i);
  });

  it("rejects a contributing sample with extra channels instead of dropping them", () => {
    const narrow = syntheticSample([{ name: "A", values: [1] }]);
    const extra = syntheticSample([
      { name: "A", values: [2] },
      { name: "B", values: [3] },
    ]);
    expect(() => exportPopulationFcsCombined([
      { sample: narrow, name: "narrow.fcs", mask: Uint8Array.from([1]) },
      { sample: extra, name: "extra.fcs", mask: Uint8Array.from([1]) },
    ])).toThrow(/extra\.fcs.*extra: B.*split zip/i);
  });

  it("rejects wrong-length masks and an all-empty combined selection", () => {
    const one = syntheticSample([{ name: "A", values: [1, 2] }]);
    expect(() => exportPopulationFcsCombined([
      { sample: one, name: "one.fcs", mask: Uint8Array.from([1]) },
    ])).toThrow(/mask.*one\.fcs.*1 events.*2/i);
    expect(() => exportPopulationFcsCombined([
      { sample: one, name: "one.fcs", mask: new Uint8Array(2) },
    ])).toThrow(/contains no events/i);
  });
});

describe("sanitizeFcsName", () => {
  it("replaces unsafe chars with _ and joins parts", () => {
    expect(sanitizeFcsName("exp1", "Sample A/1", "CD4+ T cells", "raw")).toBe(
      "exp1_Sample_A_1_CD4__T_cells_raw.fcs",
    );
  });

  it("drops empty prefix/suffix (no stray separators)", () => {
    expect(sanitizeFcsName("", "S1", "Live", "")).toBe("S1_Live.fcs");
    expect(sanitizeFcsName(null, "S1", "Live", undefined)).toBe("S1_Live.fcs");
  });

  it("keeps allowed chars . _ - and digits", () => {
    expect(sanitizeFcsName("", "donor-01.v2", "pop_3", "")).toBe("donor-01.v2_pop_3.fcs");
  });
});
