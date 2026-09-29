import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { parseFcs, type FcsFile } from "./fcs";
import { Sample } from "./sample";
import {
  exportPopulationFcs,
  exportPopulationFcsCombined,
  inspectCombinedFcsCompatibility,
  passesPopulationFcsExportThreshold,
  sanitizeFcsName,
  writeFcs,
} from "./fcsExport";
import { ARIA_SMALL, VENDOR_MATRIX_DIR } from "../testFixtures";

const CALIBUR = `${VENDOR_MATRIX_DIR}/curated-from-fcsparser/BD_FACSCalibur_FCS2.0.fcs`;
const MUSE = `${VENDOR_MATRIX_DIR}/curated-from-fcsparser/Guava_Muse.fcs`;


function loadArrayBuffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
const toAB = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

describe("passesPopulationFcsExportThreshold", () => {
  it("uses an exclusive, non-negative whole-event threshold", () => {
    expect(passesPopulationFcsExportThreshold(0, 0)).toBe(false);
    expect(passesPopulationFcsExportThreshold(1, 0)).toBe(true);
    expect(passesPopulationFcsExportThreshold(100, 100)).toBe(false);
    expect(passesPopulationFcsExportThreshold(101, 100)).toBe(true);
    expect(passesPopulationFcsExportThreshold(1, -10)).toBe(true);
    expect(passesPopulationFcsExportThreshold(null, 0)).toBe(false);
  });
});

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

  it("writes a valid FCS 3.1 the parser accepts", () => {
    expect(re.version).toBe("FCS3.1");
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

  it("writes a $PnR covering the data, and float32 data for a float32 source", () => {
    // The Aria file declares 262144 on every channel, which FSC-W, SSC-A and SSC-W exceed; the
    // export raises the range to cover them and keeps the source's where it already does.
    re.channels.forEach((c, j) => {
      const src = sample.fcs.channels[sample.channels[j].columnIndex];
      let max = -Infinity;
      for (const v of re.columns[j]) if (v > max) max = v;
      expect(c.range).toBeGreaterThanOrEqual(max);
      if (max <= src.range) expect(c.range).toBe(src.range);
    });
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
    expect(re.version).toBe("FCS3.1");
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

describe("inspectCombinedFcsCompatibility", () => {
  it("accepts the same channel set in a different order", () => {
    const first = syntheticSample([
      { name: "A", values: [1] },
      { name: "B", values: [2] },
    ]);
    const second = syntheticSample([
      { name: "B", values: [3] },
      { name: "A", values: [4] },
    ]);
    expect(inspectCombinedFcsCompatibility([
      { sample: first, name: "first.fcs" },
      { sample: second, name: "second.fcs" },
    ])).toEqual({ compatible: true, reason: null });
  });

  it("disables pooled export and names the mismatched FCS", () => {
    const full = syntheticSample([
      { name: "A", values: [1] },
      { name: "B", values: [2] },
    ]);
    const missing = syntheticSample([{ name: "A", values: [3] }]);
    const result = inspectCombinedFcsCompatibility([
      { sample: full, name: "full.fcs" },
      { sample: missing, name: "missing.fcs" },
    ]);
    expect(result.compatible).toBe(false);
    expect(result.reason).toMatch(/missing\.fcs.*missing B/i);
  });
});

describe("sanitizeFcsName", () => {
  it("replaces unsafe chars with _ and joins parts", () => {
    // "+" is kept. It used to become "_", which made CD45RB+IgD+ and CD45RB+IgD- collide on
    // one file name and silently overwrite each other during a multi-population export.
    expect(sanitizeFcsName("exp1", "Sample A/1", "CD4+ T cells", "raw")).toBe(
      "exp1_Sample_A_1_CD4+_T_cells_raw.fcs",
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

// ── What an export carries from its source (2026-09) ─────────────────────────
// Synthetic files only: channels FSC-A/SSC-A/FL1-A/FL2-A, markers M1/M2, donor D1.

interface SynthChannel {
  name: string;
  marker?: string | null;
  values: number[];
  range?: number;
  gain?: number;
  logAmp?: { decades: number; offset: number };
  float64?: boolean;
  extra?: Record<string, string>;
}

function richSample(channels: SynthChannel[], keywords: Record<string, string> = {}): Sample {
  const n = channels[0]?.values.length ?? 0;
  const kw: Record<string, string> = { $TOT: String(n), $PAR: String(channels.length), ...keywords };
  channels.forEach((c, i) => {
    kw[`$P${i + 1}N`] = c.name;
    if (c.marker) kw[`$P${i + 1}S`] = c.marker;
    if (c.gain !== undefined) kw[`$P${i + 1}G`] = String(c.gain);
    for (const [k, v] of Object.entries(c.extra ?? {})) kw[k.replace("{n}", String(i + 1))] = v;
  });
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: n,
    channels: channels.map((c, index) => ({
      index, name: c.name, marker: c.marker ?? null, bits: 32, range: c.range ?? 262144,
      ...(c.gain !== undefined ? { gain: c.gain } : {}),
      ...(c.logAmp ? { logAmp: c.logAmp } : {}),
    })),
    keywords: kw,
    columns: channels.map((c) => (c.float64 ? Float64Array.from(c.values) : Float32Array.from(c.values))),
    spillover: null,
    instrument: "flow",
  };
  return new Sample(fcs);
}

const reparse = (bytes: Uint8Array) => parseFcs(toAB(bytes));

/**
 * Parameter `p` (1-based) as flowio's as_array(preprocess=True) and FlowKit read it: a log $PnE is
 * decoded as 10^(f1·x/$PnR)·f2 (f2 = 0 read as 1) whatever the data type, then any $PnG other
 * than 0 or 1 divides, except on a channel named Time. Taken from flowio 1.4.0 flowdata.py.
 */
function flowioValues(fcs: FcsFile, p: number): number[] {
  const kw = fcs.keywords;
  const [f1, f2raw] = (kw[`$P${p}E`] ?? "0,0").split(",").map(Number);
  const f2 = f1 !== 0 && f2raw === 0 ? 1 : f2raw;
  const r = Number(kw[`$P${p}R`] ?? fcs.channels[p - 1].range);
  const g = /^time$/i.test(kw[`$P${p}N`] ?? "") ? 1 : Number(kw[`$P${p}G`] ?? "1");
  return Array.from(fcs.columns[p - 1], (x) => {
    let v = f1 > 0 ? Math.pow(10, (f1 * x) / r) * f2 : x;
    if (g !== 1 && g !== 0) v /= g;
    return v;
  });
}

describe("exportPopulationFcs — the source's metadata", () => {
  it("carries $TIMESTEP, provenance, $PnG and each kept channel's own keywords, renumbered", () => {
    const s = richSample([
      { name: "Time", values: [1, 2, 3] },
      { name: "FSC-A", values: [10, 20, 30], gain: 2, extra: { "$P{n}V": "450", "P{n}DISPLAY": "LIN" } },
      { name: "FL1-A", marker: "M1", values: [5, 6, 7], extra: { "$P{n}V": "600" } },
    ], { $TIMESTEP: "0.01", $CYT: "Synthetic cytometer", $DATE: "01-JAN-2026", $FIL: "D1.fcs" });
    const re = reparse(exportPopulationFcs(s, Uint8Array.from([1, 0, 1]), "original"));
    expect(re.keywords["$TIMESTEP"]).toBe("0.01");
    expect(re.keywords["$CYT"]).toBe("Synthetic cytometer");
    expect(re.keywords["$FIL"]).toBe("D1.fcs");
    expect(re.keywords["$P2G"]).toBe("2");
    expect(re.keywords["$P2V"]).toBe("450");
    expect(re.keywords["P2DISPLAY"]).toBe("LIN");
    expect(re.keywords["$P3V"]).toBe("600");
    expect(re.keywords["$ORIGINALITY"]).toBe("DataModified");
    expect(re.keywords["GATELAB_ASSAY"]).toBe("original");
    // Values stay as stored: the gain is carried, not applied.
    expect(Array.from(re.columns[1])).toEqual([10, 30]);
  });

  it("writes no $PnG on a hardware log channel, which is written decoded on a linear scale", () => {
    const s = richSample([
      { name: "FSC-H", values: [1, 2] },
      { name: "FL1-H", values: [1, 10], gain: 2, logAmp: { decades: 4, offset: 1 }, range: 10000, float64: true },
    ]);
    const re = reparse(exportPopulationFcs(s, null, "original"));
    expect(re.keywords["$P2G"]).toBeUndefined();
    expect(re.keywords["$P2E"]).toBe("0,0");
  });

  it("writes a GvHD-shaped channel linear: its values exceed the $PnR its log $PnE is stated on", () => {
    // Float data with $PnE 4,0 is out of spec (FCS 3.1: floating point data "shall" have $PnE
    // 0,0), and readers disagree over it: flowCore reads the stored value, flowio and FlowKit
    // decode it as 10^(4x / $PnR). The GvHD files hold values up to 10,000 on $PnR 1024, already
    // linear, which no log $PnE on $PnR 1024 can describe (its channel values run to 1024). So the
    // export is linear with a covering $PnR, and flowCore reads it as it reads the source (a
    // restated $PnR 1024 made its default read clamp the export). Carrying $PnE 4,0 with a raised
    // $PnR made flowio decode the first FL1-H value, 43.48, as 1.04.
    const s = richSample([
      { name: "FSC-H", values: [1, 2] },
      { name: "FL1-H", values: [43.48, 9999.5], range: 1024, extra: { "$P{n}E": "4,0" } },
    ]);
    for (const assay of ["original", "display"] as const) {
      const re = reparse(exportPopulationFcs(s, null, assay));
      expect(re.keywords["$P1E"]).toBe("0,0");
      expect(re.keywords["$P2E"]).toBe("0,0");
      expect(Number(re.keywords["$P2R"])).toBeGreaterThanOrEqual(Math.max(...Array.from(re.columns[1])));
    }
    const original = reparse(exportPopulationFcs(s, null, "original"));
    expect(Array.from(original.columns[1])).toEqual([Math.fround(43.48), 9999.5]);
    // flowio reads the stored, linear values rather than 10^(4 × 9999.5 / 1024).
    expect(flowioValues(original, 2)).toEqual([Math.fround(43.48), 9999.5]);
    // The file's other channel stating $PnE 4,0 is linear too, though its values stay below 1024:
    // they come from the same writer, and a file does not state its channels two ways.
    const two = richSample([
      { name: "FL1-H", values: [43.48, 9999.5], range: 1024, extra: { "$P{n}E": "4,0" } },
      { name: "FL4-H", values: [3.2, 481.2], range: 1024, extra: { "$P{n}E": "4,0" } },
    ]);
    const both = reparse(exportPopulationFcs(two, null, "original"));
    expect([both.keywords["$P1E"], both.keywords["$P2E"]]).toEqual(["0,0", "0,0"]);
  });

  it("keeps a Muse-shaped HLog channel's $PnE, $PnR and $PnG, so flowio reads the export as it reads the source", () => {
    // Guava Muse: float data; FSC-HLin carries $PnG 2.95; FSC-HLog holds log10(FSC-HLin) under
    // $PnE 4.0,1.0, $PnR 10000 and the same $PnG. Until 2026-09 the export wrote HLog with $PnE 0,0
    // and kept $PnG, so flowio read x / 2.95 from the export where it reads 10^(4x/10000) / 2.95
    // from the source.
    const lin = [59.69, 155.8, 3188.3];
    const s = richSample([
      { name: "FSC-HLin", values: lin, range: 10000, gain: 2.95 },
      { name: "FSC-HLog", values: lin.map(Math.log10), range: 10000, gain: 2.95, extra: { "$P{n}E": "4.0,1.0" } },
    ], { $BYTEORD: "1,2,3,4", $DATATYPE: "F", "$P1E": "0.0,0.0" });
    const bytes = exportPopulationFcs(s, null, "original");
    const re = reparse(bytes);
    expect(re.keywords["$P2E"]).toBe("4.0,1.0");
    expect(re.keywords["$P2R"]).toBe("10000");
    expect(re.keywords["$P2G"]).toBe("2.95");
    expect(re.keywords["$P1G"]).toBe("2.95");
    for (const p of [1, 2]) {
      expect(Array.from(re.columns[p - 1])).toEqual(Array.from(s.fcs.columns[p - 1]));
      expect(flowioValues(re, p)).toEqual(flowioValues(s.fcs, p));
    }
    // The DATA are the source's, as stored: NonDataModified.
    expect(re.keywords["$ORIGINALITY"]).toBe("NonDataModified");
    // A display export is GateLab's values, linear and without a gain on the HLog channel.
    const display = reparse(exportPopulationFcs(s, null, "display"));
    expect(display.keywords["$P2E"]).toBe("0,0");
    expect(display.keywords["$P2G"]).toBeUndefined();
  });

  it("keeps the source's $PnS, or the user's rename, never GateLab's display key", () => {
    const s = richSample([
      { name: "Time", marker: "Clock", values: [1] },
      { name: "FL1-A", marker: null, values: [2] },
      { name: "FL2-A", marker: "M2", values: [3] },
    ]);
    s.setChannelLabel(2, "M2 renamed");
    const re = reparse(exportPopulationFcs(s, null, "original"));
    expect(re.channels.map((c) => c.marker)).toEqual(["Clock", null, "M2 renamed"]);
  });

  it("carries the source's spillover on the original assay only, restricted to exported channels", () => {
    const s = richSample([
      { name: "FSC-A", values: [100, 200] },
      { name: "FL1-A", values: [1000, 50] },
      { name: "FL2-A", values: [100, 900] },
    ], { $SPILLOVER: "3,FL1-A,FL2-A,FL3-A,1,0.1,0,0.05,1,0,0,0,1" });
    const original = reparse(exportPopulationFcs(s, null, "original"));
    expect(original.keywords["$SPILLOVER"]).toBe("2,FL1-A,FL2-A,1,0.1,0.05,1");
    expect(original.spillover?.channels).toEqual(["FL1-A", "FL2-A"]);
    s.installExternalSpillover({ channels: ["FL1-A", "FL2-A"], matrix: [[1, 0.1], [0.05, 1]] }, "test matrix", { replaceEmbedded: true });
    s.setCompensation(true);
    for (const assay of ["compensated", "display"] as const) {
      const re = reparse(exportPopulationFcs(s, null, assay));
      expect(re.keywords["$SPILLOVER"]).toBeUndefined();
      expect(re.spillover).toBeNull();
      expect(re.keywords["GATELAB_ASSAY"]).toBe(assay);
    }
  });

  // A file compensated with a matrix it does not carry (a FlowJo workspace's, installed over the
  // file's own; #349 saves it with the workspace) was exported on the original assay with the
  // file's own $SPILLOVER, often acquisition's identity, so the export named a matrix GateLab was
  // not using (the release candidate's browser verifier, FR-FCM-Z2C8 FMO_047; master wrote none).
  it("carries the matrix in force on the original assay, the one a workspace supplied over the file's own", () => {
    const s = richSample([
      { name: "FSC-A", values: [100, 200] },
      { name: "FL1-A", values: [1000, 50] },
      { name: "FL2-A", values: [100, 900] },
    ], { $SPILLOVER: "2,FL1-A,FL2-A,1,0,0,1" });
    s.installExternalSpillover(
      { channels: ["FL1-A", "FL2-A", "FL3-A"], matrix: [[1, 0.2, 0], [0.03, 1, 0], [0, 0, 1]] },
      "Matrix_A", { replaceEmbedded: true },
    );
    const original = reparse(exportPopulationFcs(s, null, "original"));
    expect(original.keywords["$SPILLOVER"]).toBe("2,FL1-A,FL2-A,1,0.2,0.03,1");
    expect(original.keywords["GATELAB_SPILLOVER"]).toBe("Matrix_A");
    // Under the file's own matrix, the export carries the file's own, and no label.
    const own = new Sample(s.fcs);
    const back = reparse(exportPopulationFcs(own, null, "original"));
    expect(back.keywords["$SPILLOVER"]).toBe("2,FL1-A,FL2-A,1,0,0,1");
    expect(back.keywords["GATELAB_SPILLOVER"]).toBeUndefined();
  });

  // FlowJo saves a "/" in a parameter name as "_" in its workspace, the matrix included, and
  // Sample.externalSpilloverPreview maps it back. The export kept only the matrix channels whose
  // names were exactly an exported $PnN, so with every compensated channel carrying a "/" it wrote
  // no $SPILLOVER at all (FR-FCM-Z2C8's Exp2_ST3_matrix, the release candidate's verifier), and
  // with some it wrote a sub-matrix of the others. It now writes the matrix GateLab compensates
  // with under the file's own names, and a reader compensating the export by it gets GateLab's
  // compensated values.
  it("writes an installed workspace matrix under the file's $PnN, a \"/\" the workspace saved as \"_\" included", () => {
    const s = richSample([
      { name: "FSC-A", values: [100, 200, 300] },
      { name: "LIVE/DEAD Aqua-A", values: [1000, 50, 400] },
      { name: "BL1 525/50-A", values: [100, 900, 250] },
      { name: "FL3-A", values: [30, 60, 800] },
    ]);
    const supplied = {
      channels: ["LIVE_DEAD Aqua-A", "BL1 525_50-A", "FL3-A"],
      matrix: [[1, 0.2, 0.05], [0.03, 1, 0.1], [0.01, 0.02, 1]],
    };
    s.installExternalSpillover(supplied, "Matrix_A");
    expect(s.spilloverOrigin.kind).toBe("external");
    s.setCompensation(true);
    const original = reparse(exportPopulationFcs(s, null, "original"));
    expect(original.keywords["$SPILLOVER"]).toBe(
      "3,LIVE/DEAD Aqua-A,BL1 525/50-A,FL3-A,1,0.2,0.05,0.03,1,0.1,0.01,0.02,1",
    );
    expect(original.keywords["GATELAB_SPILLOVER"]).toBe("Matrix_A");
    // A reader of the export compensates with the matrix it names, as GateLab did.
    const reread = new Sample(original);
    expect(reread.spilloverOrigin.kind).toBe("fcs");
    reread.setCompensation(true);
    for (const name of ["LIVE/DEAD Aqua-A", "BL1 525/50-A", "FL3-A"]) {
      const a = s.compensatedColumnData(s.index(name)!);
      const b = reread.compensatedColumnData(reread.index(name)!);
      expect(Array.from(b), name).toEqual(Array.from(a));
    }
    // Only some of the channels saved with "_": the matrix is written whole, not the others' part.
    const t = richSample([
      { name: "FSC-A", values: [100, 200] },
      { name: "LIVE/DEAD Aqua-A", values: [1000, 50] },
      { name: "FL2-A", values: [100, 900] },
    ]);
    t.installExternalSpillover({ channels: ["LIVE_DEAD Aqua-A", "FL2-A"], matrix: [[1, 0.2], [0.03, 1]] }, "Matrix_B");
    expect(reparse(exportPopulationFcs(t, null, "original")).keywords["$SPILLOVER"]).toBe("2,LIVE/DEAD Aqua-A,FL2-A,1,0.2,0.03,1");
  });

  it("keeps a float64 source in float64, exactly", () => {
    const values = [0.1, 16777217, 123456.789012345, 4294967295];
    const s = richSample([{ name: "FSC-A", values, float64: true }, { name: "SSC-A", values: [1, 2, 3, 4] }]);
    const re = reparse(exportPopulationFcs(s, null, "original"));
    expect(re.keywords["$DATATYPE"]).toBe("D");
    expect(re.keywords["$P1B"]).toBe("64");
    expect(Array.from(re.columns[0])).toEqual(values);
    expect(Array.from(re.columns[1])).toEqual([1, 2, 3, 4]);
  });

  it("covers the data with $PnR, where a constant 262144 made flowCore clamp it", () => {
    const s = richSample([
      { name: "FSC-A", values: [100, 3089952.5], range: 4194304 },
      { name: "SSC-A", values: [100, 50621208], range: 262144 },
    ]);
    const re = reparse(exportPopulationFcs(s, null, "original"));
    expect(re.keywords["$P1R"]).toBe("4194304");
    expect(Number(re.keywords["$P2R"])).toBeGreaterThanOrEqual(50621208);
  });

  it("writes UTF-8 labels whole, including characters whose low byte is the delimiter", () => {
    const s = richSample([
      { name: "FSC-A", values: [1] },
      { name: "FL1-A", values: [2] },
      { name: "FL2-A", values: [3] },
      { name: "FL3-A", values: [4] },
    ]);
    // "ż" is U+017C: the byte-truncating writer wrote it as 0x7C, the "|" delimiter.
    s.setChannelLabel(0, "ż-M1");
    s.setChannelLabel(1, "TCRγδ");
    s.setChannelLabel(2, "CD27−");
    const bytes = exportPopulationFcs(s, null, "original");
    const re = reparse(bytes);
    expect(re.channels.map((c) => c.marker)).toEqual(["ż-M1", "TCRγδ", "CD27−", null]);
    expect(re.channels.map((c) => c.name)).toEqual(["FSC-A", "FL1-A", "FL2-A", "FL3-A"]);
    // Offsets are byte offsets of the encoded TEXT.
    expect(Array.from(re.columns[3])).toEqual([4]);
  });

  it("writes an empty population as an empty DATA segment, ending one byte before it begins", () => {
    // As flowCore's write.FCS does. A non-zero $BEGINDATA with $ENDDATA 0 is a negative length,
    // and 0/0 a one-byte segment; flowio and FlowKit refuse both.
    const s = richSample([{ name: "FSC-A", values: [1, 2] }, { name: "SSC-A", values: [3, 4] }]);
    const bytes = exportPopulationFcs(s, new Uint8Array(2), "original");
    const re = reparse(bytes);
    expect(re.nEvents).toBe(0);
    const begin = Number(re.keywords["$BEGINDATA"]);
    expect(begin).toBe(bytes.length);
    expect(Number(re.keywords["$ENDDATA"])).toBe(begin - 1);
    const head = new TextDecoder().decode(bytes.subarray(0, 58));
    expect(Number(head.slice(26, 34))).toBe(begin);
    expect(Number(head.slice(34, 42))).toBe(begin - 1);
  });
});

describe.runIf(existsSync(MUSE))("exportPopulationFcs — the public Guava Muse file's HLog channels", () => {
  // Data set 2 (well A02, 50,081 events): float, little-endian; FSC-, YEL- and RED-HLog state
  // $PnE 4.0,1.0 on $PnR 10000 with $PnG 2.95, 18.22 and 117.38.
  const sample = new Sample(parseFcs(loadArrayBuffer(MUSE), { dataSet: 1 }));
  const bytes = exportPopulationFcs(sample, null, "original");
  const re = reparse(bytes);

  it("is read from the export as from the source by flowio and FlowKit, and by flowCore", () => {
    expect(re.channels.length).toBe(sample.fcs.channels.length);
    for (let p = 1; p <= re.channels.length; p++) {
      // flowCore's read.FCS: the stored value (it decodes integer data only, and divides by $PnG
      // only when asked).
      expect(Array.from(re.columns[p - 1])).toEqual(Array.from(sample.fcs.columns[p - 1]));
      // flowio and FlowKit: decoded by $PnE and $PnR, then divided by $PnG.
      expect(flowioValues(re, p)).toEqual(flowioValues(sample.fcs, p));
    }
    for (const name of ["FSC-HLog", "YEL-HLog", "RED-HLog"]) {
      const p = re.channels.findIndex((c) => c.name === name) + 1;
      const q = sample.fcs.channels.findIndex((c) => c.name === name) + 1;
      expect(re.keywords[`$P${p}E`]).toBe(sample.fcs.keywords[`$P${q}E`]);
      expect(re.keywords[`$P${p}R`]).toBe("10000");
      expect(re.keywords[`$P${p}G`]).toBe(sample.fcs.keywords[`$P${q}G`]);
    }
  });

  it("says NonDataModified for every event, and DataModified for a population", () => {
    expect(re.keywords["$ORIGINALITY"]).toBe("NonDataModified");
    const mask = new Uint8Array(sample.fcs.nEvents);
    for (let i = 0; i < mask.length; i += 2) mask[i] = 1;
    expect(reparse(exportPopulationFcs(sample, mask, "original")).keywords["$ORIGINALITY"]).toBe("DataModified");
  });
});

describe("exportPopulationFcs — $ORIGINALITY says whether the DATA segment is the source's", () => {
  const le = { $BYTEORD: "1,2,3,4", $DATATYPE: "F" };
  const channels = () => [{ name: "FSC-A", values: [1, 2, 3] }, { name: "SSC-A", values: [4, 5, 6] }];
  const originality = (s: Sample, mask: Uint8Array | null = null) =>
    reparse(exportPopulationFcs(s, mask, "original")).keywords["$ORIGINALITY"];

  it("is NonDataModified only when every event and parameter is written as the source stored it", () => {
    expect(originality(richSample(channels(), le))).toBe("NonDataModified");
    // Fewer events, another assay, or a source already modified: not NonDataModified.
    expect(originality(richSample(channels(), le), Uint8Array.from([1, 0, 1]))).toBe("DataModified");
    expect(reparse(exportPopulationFcs(richSample(channels(), le), null, "display")).keywords["$ORIGINALITY"])
      .toBe("DataModified");
    expect(originality(richSample(channels(), { ...le, $ORIGINALITY: "DataModified" }))).toBe("DataModified");
    expect(originality(richSample(channels(), { ...le, $ORIGINALITY: "Appended" }))).toBe("Appended");
    expect(originality(richSample(channels(), { ...le, $ORIGINALITY: "Original" }))).toBe("NonDataModified");
  });

  it("is DataModified when the values' type, width or byte order changed, even with every value equal", () => {
    // Integer data are written as float, so the DATA segment is not the source's.
    expect(originality(richSample(channels(), { ...le, $DATATYPE: "I" }))).toBe("DataModified");
    // FCS 3.2: one integer parameter in a float file.
    expect(originality(richSample(channels(), { ...le, $P2DATATYPE: "I" }))).toBe("DataModified");
    // Big-endian source, written little-endian.
    expect(originality(richSample(channels(), { ...le, $BYTEORD: "4,3,2,1" }))).toBe("DataModified");
    // A float32 channel widened to float64 because another channel needs it.
    const widened = richSample([{ name: "FSC-A", values: [1, 2, 3] }, { name: "SSC-A", values: [0.1, 0.2, 0.3], float64: true }], le);
    expect(reparse(exportPopulationFcs(widened, null, "original")).keywords["$DATATYPE"]).toBe("D");
    expect(originality(widened)).toBe("DataModified");
    // A float64 source written as float64 is its own bytes.
    const double = richSample([{ name: "FSC-A", values: [0.1, 0.2], float64: true }], { ...le, $DATATYPE: "D" });
    expect(originality(double)).toBe("NonDataModified");
  });

  it.runIf(existsSync(CALIBUR))("is DataModified for a FACSCalibur export, whose log channels are written decoded", () => {
    // Integer, big-endian, five channels with $PnE 4,0: written as decoded doubles with $PnE 0,0.
    // Until 2026-09 a full original export of it said NonDataModified.
    const sample = new Sample(parseFcs(loadArrayBuffer(CALIBUR)));
    expect(sample.fcs.channels.filter((c) => c.logAmp).length).toBe(5);
    const re = reparse(exportPopulationFcs(sample, null, "original"));
    expect(re.keywords["$DATATYPE"]).toBe("D");
    expect(re.keywords["$ORIGINALITY"]).toBe("DataModified");
  });

  it("is DataModified when the reader masked flag bits out of an integer channel", () => {
    // 16-bit words on $PnR 1024: the reader keeps the low 10 bits, so 0x8000 | 500 reads as 500.
    const bytes = rawIntegerFcs([500, 0x8000 | 500, 1023], 1024);
    const sample = new Sample(parseFcs(toAB(bytes)));
    expect(Array.from(sample.fcs.columns[0])).toEqual([500, 500, 1023]);
    const re = reparse(exportPopulationFcs(sample, null, "original"));
    expect(Array.from(re.columns[0])).toEqual([500, 500, 1023]);
    expect(re.keywords["$ORIGINALITY"]).toBe("DataModified");
  });
});

/** A one-parameter, little-endian, 16-bit integer FCS 3.1 file holding `values` on `range`. */
function rawIntegerFcs(values: number[], range: number): Uint8Array {
  const data = new Uint8Array(values.length * 2);
  const dv = new DataView(data.buffer);
  values.forEach((v, i) => dv.setUint16(i * 2, v, true));
  let text = "";
  let begin = 0;
  for (let i = 0; i < 4; i++) {
    text = `/$BYTEORD/1,2,3,4/$DATATYPE/I/$MODE/L/$NEXTDATA/0/$PAR/1/$TOT/${values.length}` +
      `/$P1N/FL1-H/$P1B/16/$P1E/0,0/$P1R/${range}/$BEGINDATA/${begin}/$ENDDATA/${begin + data.length - 1}/`;
    begin = 58 + text.length;
  }
  const head = "FCS3.1    " + [58, 58 + text.length - 1, begin, begin + data.length - 1, 0, 0]
    .map((n) => String(n).padStart(8)).join("");
  const out = new Uint8Array(begin + data.length);
  out.set(new TextEncoder().encode(head + text), 0);
  out.set(data, begin);
  return out;
}

/** The TEXT segment of a file writeFcs wrote, as a string. */
function textSegment(bytes: Uint8Array): string {
  const head = new TextDecoder().decode(bytes.subarray(0, 58));
  return new TextDecoder().decode(bytes.subarray(Number(head.slice(10, 18)), Number(head.slice(18, 26)) + 1));
}

/** flowCore's default TEXT split (read.FCS, emptyValue = TRUE): a doubled delimiter is an empty
 *  value, not an escaped delimiter. Returns the keyword names it would find. */
function flowCoreDefaultKeys(text: string): string[] {
  const tokens = text.slice(1, -1).split(text[0]);
  return tokens.filter((_, i) => i % 2 === 0);
}

describe("writeFcs — a TEXT delimiter that no keyword or value contains", () => {
  it("writes a value holding \"|\" without doubling any delimiter, so flowCore's default read accepts it", () => {
    // A BD FACSChorus file's BDCHORUSDATARECORD is JSON holding "|", "/" and "\\". Escaped as
    // "||" under a "|" delimiter it is valid FCS, but flowCore's read.FCS takes "||" for an empty
    // value and refuses the file: "Empty keyword name detected".
    const record = '{"gates":[{"name":"P1|P2","path":"C:\\\\runs/D1"}]}';
    const s = richSample([{ name: "FSC-A", values: [1, 2] }, { name: "SSC-A", values: [3, 4] }],
      { BDCHORUSDATARECORD: record });
    const bytes = exportPopulationFcs(s, null, "original");
    const text = textSegment(bytes);
    const delim = text[0];
    expect(text.slice(0, -1)).not.toContain(delim + delim);
    expect(text.endsWith(delim)).toBe(true);
    expect(record).not.toContain(delim);
    const keys = flowCoreDefaultKeys(text);
    expect(keys.every((k) => k.length > 0)).toBe(true);
    expect(keys).toContain("BDCHORUSDATARECORD");
    const re = reparse(bytes);
    expect(re.keywords["BDCHORUSDATARECORD"]).toBe(record);
    expect(Array.from(re.columns[1])).toEqual([3, 4]);
  });

  it("keeps \"|\" when nothing contains it", () => {
    const plain = richSample([{ name: "FSC-A", values: [1] }], { $CYT: "Synthetic cytometer" });
    expect(textSegment(exportPopulationFcs(plain, null, "original"))[0]).toBe("|");
  });

  it("takes another byte, not a doubled \"|\", when a TEXT holds all seven usual delimiters", () => {
    // Until 2026-09 this fell back to doubling "|", which flowCore's default read refuses and
    // flowio keeps inside the value.
    const every = "a|b\fc/d\\e\rf\tg\nh";
    const crowded = richSample([{ name: "FSC-A", values: [1, 2] }], { NOTE: every });
    const bytes = exportPopulationFcs(crowded, null, "original");
    const text = textSegment(bytes);
    expect(text[0]).toBe("~");
    expect(text.slice(0, -1)).not.toContain(text[0] + text[0]);
    expect(flowCoreDefaultKeys(text).every((k) => k.length > 0)).toBe(true);
    const re = reparse(bytes);
    expect(re.keywords["NOTE"]).toBe(every);
    expect(Array.from(re.columns[0])).toEqual([1, 2]);
  });

  it("uses a control byte after the printable fallbacks, and doubles \"|\" only when every allowed byte occurs", () => {
    const printable = "a|b\fc/d\\e\rf\tg\nh~!#%&;:@_`'\"<>=";
    const s1 = richSample([{ name: "FSC-A", values: [1] }], { NOTE: printable });
    const text1 = textSegment(exportPopulationFcs(s1, null, "original"));
    expect(text1[0]).toBe("\u0001");
    expect(reparse(exportPopulationFcs(s1, null, "original")).keywords["NOTE"]).toBe(printable);
    const controls = Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)).join("");
    const s2 = richSample([{ name: "FSC-A", values: [1] }], { NOTE: printable + controls });
    const bytes = exportPopulationFcs(s2, null, "original");
    expect(textSegment(bytes)[0]).toBe("|");
    expect(reparse(bytes).keywords["NOTE"]).toBe(printable + controls);
  });

  it("writes the public S8 file's original export with no doubled delimiter", () => {
    const sample = new Sample(parseFcs(loadArrayBuffer(`${VENDOR_MATRIX_DIR}/bd_facsdiscover_s8__19221995__Zam36_YFP.fcs`)));
    const mask = new Uint8Array(sample.fcs.nEvents);
    for (let i = 0; i < mask.length; i += 50) mask[i] = 1;
    const bytes = exportPopulationFcs(sample, mask, "original");
    const text = textSegment(bytes);
    expect(text.slice(0, -1)).not.toContain(text[0] + text[0]);
    expect(flowCoreDefaultKeys(text).every((k) => k.length > 0)).toBe(true);
    expect(reparse(bytes).keywords["BDCHORUSDATARECORD"]).toBe(sample.fcs.keywords["BDCHORUSDATARECORD"]);
  });
});

describe("writeFcs — DATA past byte 99,999,999", () => {
  it("zeroes BOTH HEADER data offsets and leaves the segment to $BEGINDATA/$ENDDATA", () => {
    const n = 25_000_001; // one float32 channel: 100,000,004 bytes of DATA
    const bytes = writeFcs([new Float32Array(n)], [{ name: "A", desc: "" }]);
    const head = new TextDecoder().decode(bytes.subarray(0, 58));
    expect(head.slice(26, 34).trim()).toBe("0");
    expect(head.slice(34, 42).trim()).toBe("0");
    const re = parseFcs(toAB(bytes));
    expect(re.nEvents).toBe(n);
    expect(Number(re.keywords["$ENDDATA"])).toBe(bytes.length - 1);
  });
});

describe("exportPopulationFcsCombined — metadata the pooled sources share", () => {
  it("keeps what every file states alike and drops what one file alone states", () => {
    const a = richSample([{ name: "FSC-A", values: [1, 2], gain: 2 }, { name: "SSC-A", values: [3, 4] }],
      { $TIMESTEP: "0.01", $FIL: "D1.fcs", $CYT: "Synthetic cytometer" });
    const b = richSample([{ name: "FSC-A", values: [5], gain: 2 }, { name: "SSC-A", values: [600000] }],
      { $TIMESTEP: "0.01", $FIL: "D2.fcs", $CYT: "Synthetic cytometer" });
    const re = reparse(exportPopulationFcsCombined([
      { sample: a, mask: Uint8Array.from([1, 1]) },
      { sample: b, mask: Uint8Array.from([1]) },
    ]));
    expect(re.keywords["$TIMESTEP"]).toBe("0.01");
    expect(re.keywords["$CYT"]).toBe("Synthetic cytometer");
    expect(re.keywords["$FIL"]).toBeUndefined();
    expect(re.keywords["$P1G"]).toBe("2");
    expect(Number(re.keywords["$P2R"])).toBeGreaterThanOrEqual(600000);
  });
});

describe("exportPopulationFcsCombined — a float channel stating a log $PnE", () => {
  const hlog = (values: number[], pne: string | null, range = 10000) => richSample([
    { name: "FSC-HLin", values: values.map((v) => 10 ** v), range: 10000, gain: 2.95 },
    { name: "FSC-HLog", values, range, gain: 2.95, ...(pne ? { extra: { "$P{n}E": pne } } : {}) },
  ]);

  it("keeps the $PnE, $PnR and $PnG every source states alike", () => {
    const re = reparse(exportPopulationFcsCombined([
      { sample: hlog([1.5, 2.5], "4.0,1.0"), mask: Uint8Array.from([1, 1]) },
      { sample: hlog([3.5], "4.0,1.0"), mask: Uint8Array.from([1]) },
    ]));
    expect(re.keywords["$P2E"]).toBe("4.0,1.0");
    expect(re.keywords["$P2R"]).toBe("10000");
    expect(re.keywords["$P2G"]).toBe("2.95");
    expect(Array.from(re.columns[1])).toEqual([1.5, 2.5, 3.5]);
  });

  it("writes it linear and without a gain when the sources state it differently", () => {
    const re = reparse(exportPopulationFcsCombined([
      { sample: hlog([1.5, 2.5], "4.0,1.0"), mask: Uint8Array.from([1, 1]) },
      { sample: hlog([3.5], null), mask: Uint8Array.from([1]) },
    ]));
    expect(re.keywords["$P2E"]).toBe("0,0");
    expect(re.keywords["$P2G"]).toBeUndefined();
    // The HLin channel is linear with a gain in both, and keeps it.
    expect(re.keywords["$P1G"]).toBe("2.95");
    const differentRange = reparse(exportPopulationFcsCombined([
      { sample: hlog([1.5], "4.0,1.0"), mask: Uint8Array.from([1]) },
      { sample: hlog([3.5], "4.0,1.0", 1024), mask: Uint8Array.from([1]) },
    ]));
    expect(differentRange.keywords["$P2E"]).toBe("0,0");
    expect(differentRange.keywords["$P2G"]).toBeUndefined();
  });
});
