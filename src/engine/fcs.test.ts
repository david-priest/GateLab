import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  extractFcsDataSet,
  fcsDataSetFileName,
  FcsMultipleDataSetsError,
  listFcsDataSets,
  parseFcs,
  parseFcsDataSetFileName,
} from "./fcs";
import { ARIA_SMALL, VENDOR_MATRIX_DIR } from "../testFixtures";

// Ground truth extracted independently (fcsparser for metadata; a raw big-endian
// struct read for the data values) from the real Aria III test file. This is a
// "don't guess" cross-check: the parser must reproduce these exactly.

function loadArrayBuffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function replaceAsciiInPlace(buffer: ArrayBuffer, from: string, to: string): void {
  if (from.length !== to.length) throw new Error("replacement must preserve byte offsets");
  const bytes = new Uint8Array(buffer);
  outer: for (let start = 0; start <= bytes.length - from.length; start++) {
    for (let i = 0; i < from.length; i++) {
      if (bytes[start + i] !== from.charCodeAt(i)) continue outer;
    }
    for (let i = 0; i < to.length; i++) bytes[start + i] = to.charCodeAt(i);
    return;
  }
  throw new Error(`fixture text not found: ${from}`);
}

describe("parseFcs — Aria III (FCS3.1, big-endian float32)", () => {
  const fcs = parseFcs(loadArrayBuffer(ARIA_SMALL));

  it("reads version + event count", () => {
    expect(fcs.version).toBe("FCS3.1");
    expect(fcs.nEvents).toBe(1080);
  });

  it("reads the 13 channels in order", () => {
    expect(fcs.channels.map((c) => c.name)).toEqual([
      "FSC-A", "FSC-H", "FSC-W", "SSC-A", "SSC-H", "SSC-W",
      "PE-A", "PE-Cy7-A", "APC-A", "APC-Cy7-A", "BV786-A", "BV711-A", "Time",
    ]);
    expect(fcs.channels.every((c) => c.bits === 32)).toBe(true);
  });

  it("detects a flow instrument (has FSC/SSC)", () => {
    expect(fcs.instrument).toBe("flow");
  });

  it("decodes the big-endian data correctly (event 0 + event 1)", () => {
    // event 0: FSC-A, PE-A, Time
    expect(fcs.columns[0][0]).toBeCloseTo(70200.31, 1);
    expect(fcs.columns[6][0]).toBeCloseTo(6.885, 2);
    expect(fcs.columns[12][0]).toBeCloseTo(562.921, 2);
    // event 1: FSC-A
    expect(fcs.columns[0][1]).toBeCloseTo(23897.33, 1);
    // every column has nEvents values
    expect(fcs.columns[0].length).toBe(1080);
  });

  it("parses the 6-channel $SPILLOVER matrix", () => {
    expect(fcs.spillover).not.toBeNull();
    expect(fcs.spillover!.channels).toEqual([
      "PE-A", "PE-Cy7-A", "APC-A", "APC-Cy7-A", "BV786-A", "BV711-A",
    ]);
    expect(fcs.spillover!.matrix.length).toBe(6);
    expect(fcs.spillover!.matrix.every((r) => r.length === 6)).toBe(true);
    // diagonal is 1 (self-spill)
    for (let i = 0; i < 6; i++) expect(fcs.spillover!.matrix[i][i]).toBeCloseTo(1, 9);
  });
});

// ── Synthetic FCS3.1 byte-buffer fixtures ─────────────────────────────────────
// Build a minimal-but-valid FCS3.1 buffer from scratch so we can exercise the
// $DATATYPE=I (integer) and $DATATYPE=D (float64) decode paths without a real file.
// HEADER (58 bytes) → 6 offset fields; TEXT segment (delimiter-separated keywords);
// DATA segment (event-major, nEvents × nChannels).

interface SynthOpts {
  datatype: "I" | "D";
  bits: number; // $PnB (per channel): 16 for I here, 64 for D
  channels: string[]; // $PnN names
  markers?: Array<string | null>; // optional $PnS descriptions
  events: number[][]; // event-major rows
  littleEndian?: boolean;
  dataOffsetsInText?: boolean; // zero HEADER DATA offsets; use $BEGINDATA/$ENDDATA
  /** $PnR; defaults to the full width of an integer word (2^bits), 262144 for D. */
  range?: number;
}

function buildFcs(opts: SynthOpts): ArrayBuffer {
  const le = opts.littleEndian ?? true;
  const byteord = le ? "1,2,3,4" : "4,3,2,1";
  const par = opts.channels.length;
  const tot = opts.events.length;
  const bytesPerVal = opts.datatype === "D" ? 8 : opts.bits / 8;

  // TEXT segment: "/KEY/VALUE/KEY/VALUE/…/"
  const delim = "/";
  const kv: string[] = [
    "$PAR", String(par),
    "$TOT", String(tot),
    "$DATATYPE", opts.datatype,
    "$BYTEORD", byteord,
    "$MODE", "L",
  ];
  opts.channels.forEach((nm, i) => {
    const p = i + 1;
    // An integer word holds ceil(log2($PnR)) meaningful bits and readers mask the rest (FCS 3.1
    // §3.2.20), so the declared range must cover the stored values.
    const range = opts.range ?? (opts.datatype === "I" ? 2 ** opts.bits : 262144);
    kv.push(`$P${p}N`, nm, `$P${p}B`, String(opts.bits), `$P${p}R`, String(range), `$P${p}E`, "0,0");
    const marker = opts.markers?.[i];
    if (marker !== undefined && marker !== null) kv.push(`$P${p}S`, marker);
  });
  if (opts.dataOffsetsInText) kv.push("$BEGINDATA", "00000000", "$ENDDATA", "00000000");
  const encodeText = () => delim + kv.map((token) => token.replaceAll(delim, delim + delim)).join(delim) + delim;
  let textBody = encodeText();

  const textStart = 256; // leave the standard header room + slack
  let textEnd = textStart + textBody.length - 1; // inclusive index of last TEXT byte
  let dataStart = textEnd + 1;
  const dataBytes = tot * par * bytesPerVal;
  let dataEnd = dataStart + dataBytes - 1;
  if (opts.dataOffsetsInText) {
    kv[kv.indexOf("$BEGINDATA") + 1] = String(dataStart).padStart(8, "0");
    kv[kv.indexOf("$ENDDATA") + 1] = String(dataEnd).padStart(8, "0");
    textBody = encodeText();
    textEnd = textStart + textBody.length - 1;
    dataStart = textEnd + 1;
    dataEnd = dataStart + dataBytes - 1;
  }

  const buf = new ArrayBuffer(dataEnd + 1);
  const u8 = new Uint8Array(buf);
  const putAscii = (s: string, off: number) => {
    for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i) & 0xff;
  };
  const pad8 = (n: number) => String(n).padStart(8, " ");

  // HEADER: version + spaces, then six 8-byte right-justified offset fields.
  putAscii("FCS3.1    ", 0); // 6-char version + 4 pad spaces (through byte 9)
  putAscii(pad8(textStart), 10);
  putAscii(pad8(textEnd), 18);
  putAscii(pad8(opts.dataOffsetsInText ? 0 : dataStart), 26);
  putAscii(pad8(opts.dataOffsetsInText ? 0 : dataEnd), 34);
  // analysis start/end (42..57) left as spaces/zeros — unused here.

  putAscii(textBody, textStart);

  const dv = new DataView(buf);
  let off = dataStart;
  for (const ev of opts.events) {
    for (const v of ev) {
      if (opts.datatype === "D") {
        dv.setFloat64(off, v, le);
        off += 8;
      } else {
        const width = opts.bits / 8;
        for (let byte = 0; byte < width; byte++) {
          const power = le ? byte : width - byte - 1;
          dv.setUint8(off + byte, Math.floor(v / (256 ** power)) % 256);
        }
        off += width;
      }
    }
  }
  return buf;
}

describe("parseFcs — synthetic $DATATYPE=I (16-bit int)", () => {
  const events = [
    [10, 20, 300],
    [40, 500, 6000],
    [7, 65535, 1],
  ];
  const fcs = parseFcs(
    buildFcs({ datatype: "I", bits: 16, channels: ["A", "B", "C"], events }),
  );

  it("reads header + channel metadata", () => {
    expect(fcs.version).toBe("FCS3.1");
    expect(fcs.nEvents).toBe(3);
    expect(fcs.channels.map((c) => c.name)).toEqual(["A", "B", "C"]);
    expect(fcs.channels.every((c) => c.bits === 16)).toBe(true);
  });

  it("decodes every 16-bit integer column exactly (event-major → column-major)", () => {
    for (let c = 0; c < 3; c++) {
      for (let e = 0; e < 3; e++) {
        expect(fcs.columns[c][e]).toBe(events[e][c]);
      }
    }
  });
});

describe("parseFcs — synthetic $DATATYPE=D (float64)", () => {
  const events = [
    [1.5, -2.25],
    [3.125, 4096.5],
    [0.0009765625, -12345.75],
  ];
  const fcs = parseFcs(
    buildFcs({ datatype: "D", bits: 64, channels: ["FL1", "FL2"], events }),
  );

  it("reads header + channel metadata", () => {
    expect(fcs.version).toBe("FCS3.1");
    expect(fcs.nEvents).toBe(3);
    expect(fcs.channels.map((c) => c.name)).toEqual(["FL1", "FL2"]);
    expect(fcs.channels.every((c) => c.bits === 64)).toBe(true);
  });

  it("preserves values that cannot be represented as float32", () => {
    const precise = [
      [123456789.12345679, Math.PI],
      [-987654321.9876543, Number.EPSILON],
    ];
    const parsed = parseFcs(
      buildFcs({ datatype: "D", bits: 64, channels: ["FL1", "FL2"], events: precise }),
    );
    expect(parsed.columns[0]).toBeInstanceOf(Float64Array);
    expect(parsed.columns[0][0]).toBe(precise[0][0]);
    expect(parsed.columns[0][1]).toBe(precise[1][0]);
    expect(parsed.columns[1][0]).toBe(precise[0][1]);
    expect(parsed.columns[1][1]).toBe(precise[1][1]);
  });

  it("decodes float64 columns (all values are exact dyadic doubles)", () => {
    for (let c = 0; c < 2; c++) {
      for (let e = 0; e < 3; e++) {
        // Float32 storage of the parser widens; these values are exactly representable.
        expect(fcs.columns[c][e]).toBeCloseTo(events[e][c], 3);
      }
    }
  });

  it("honours $BYTEORD for big-endian float64 too", () => {
    const be = parseFcs(
      buildFcs({ datatype: "D", bits: 64, channels: ["FL1", "FL2"], events, littleEndian: false }),
    );
    expect(be.columns[0][0]).toBeCloseTo(1.5, 6);
    expect(be.columns[1][1]).toBeCloseTo(4096.5, 6);
  });
});

describe("parseFcs — synthetic $DATATYPE=I (32-bit int)", () => {
  it("preserves unsigned integers beyond float32's exact range without extra memory", () => {
    const events = [
      [16777217, 123456789],
      [4294967295, 2147483649],
    ];
    const fcs = parseFcs(
      buildFcs({ datatype: "I", bits: 32, channels: ["A", "B"], events }),
    );
    expect(fcs.columns[0]).toBeInstanceOf(Uint32Array);
    expect(fcs.columns[0].BYTES_PER_ELEMENT).toBe(4);
    for (let c = 0; c < 2; c++) {
      for (let e = 0; e < 2; e++) expect(fcs.columns[c][e]).toBe(events[e][c]);
    }
  });
});

describe("parseFcs — rare but valid FCS encodings", () => {
  it("decodes 24-bit unsigned integers in both byte orders", () => {
    const events = [
      [0x000001, 0x123456],
      [0xabcdef, 0xffffff],
    ];
    for (const littleEndian of [true, false]) {
      const fcs = parseFcs(buildFcs({
        datatype: "I", bits: 24, channels: ["A", "B"], events, littleEndian,
      }));
      expect(fcs.columns[0]).toBeInstanceOf(Uint32Array);
      expect(Array.from(fcs.columns[0])).toEqual([0x000001, 0xabcdef]);
      expect(Array.from(fcs.columns[1])).toEqual([0x123456, 0xffffff]);
    }
  });

  it("unescapes doubled TEXT delimiters in marker labels", () => {
    const fcs = parseFcs(buildFcs({
      datatype: "I", bits: 8, channels: ["V1-A"], markers: ["CD/3"], events: [[7]],
    }));
    expect(fcs.channels[0].marker).toBe("CD/3");
    expect(Array.from(fcs.columns[0])).toEqual([7]);
  });

  it("uses $BEGINDATA/$ENDDATA when large-file HEADER offsets are zero", () => {
    const fcs = parseFcs(buildFcs({
      datatype: "I", bits: 16, channels: ["A", "B"],
      events: [[10, 20], [300, 400]], dataOffsetsInText: true,
    }));
    expect(Array.from(fcs.columns[0])).toEqual([10, 300]);
    expect(Array.from(fcs.columns[1])).toEqual([20, 400]);
    expect(Number(fcs.keywords["$BEGINDATA"])).toBeGreaterThan(0);
  });

  it("accepts an empty dataset without manufacturing events", () => {
    const fcs = parseFcs(buildFcs({
      datatype: "I", bits: 8, channels: ["A", "B"], events: [],
    }));
    expect(fcs.nEvents).toBe(0);
    expect(fcs.columns.map((column) => column.length)).toEqual([0, 0]);
  });

  it("rejects non-byte-aligned integer widths instead of misreading the stream", () => {
    const buffer = buildFcs({
      datatype: "I", bits: 16, channels: ["A"], events: [[123]],
    });
    replaceAsciiInPlace(buffer, "$P1B/16", "$P1B/12");
    expect(() => parseFcs(buffer)).toThrow(/only byte-aligned integer widths/i);
  });
});

describe("parseFcs — $PnE hardware log amplification", () => {
  /** Minimal FCS 3.0, one channel, 1-byte integers, with the given $PnE and $PnR. */
  function logAmpFile(pne: string, pnr: string, values: number[]): ArrayBuffer {
    const text =
      `/$BEGINANALYSIS/0/$ENDANALYSIS/0/$BYTEORD/1,2,3,4/$DATATYPE/I/$MODE/L` +
      `/$NEXTDATA/0/$PAR/1/$TOT/${values.length}` +
      `/$P1B/8/$P1E/${pne}/$P1N/FL1-H/$P1R/${pnr}/$P1S/FITC-H/`;
    const HEAD = 256;
    const textStart = HEAD;
    const textEnd = textStart + text.length - 1;
    const dataStart = textEnd + 1;
    const dataEnd = dataStart + values.length - 1;
    const buf = new Uint8Array(dataEnd + 1);
    const put = (s: string, at: number) => {
      for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i);
    };
    put("FCS3.0  ", 0);
    put(String(textStart).padStart(8), 10);
    put(String(textEnd).padStart(8), 18);
    put(String(dataStart).padStart(8), 26);
    put(String(dataEnd).padStart(8), 34);
    put(text, textStart);
    values.forEach((v, i) => (buf[dataStart + i] = v));
    return buf.buffer;
  }

  it("linearises a log-amplified channel as 10^(f1 x / r) * f2", () => {
    // 4 decades over a range of 256: stored 0 -> 1, stored 64 -> 10, stored 256 -> 10^4.
    const fcs = parseFcs(logAmpFile("4,1", "256", [0, 64, 128, 255]));
    expect(fcs.channels[0].logAmp).toEqual({ decades: 4, offset: 1 });
    const col = Array.from(fcs.columns[0]);
    expect(col[0]).toBeCloseTo(1, 12);
    expect(col[1]).toBeCloseTo(10, 10);
    expect(col[2]).toBeCloseTo(100, 8);
    expect(col[3]).toBeCloseTo(Math.pow(10, 4 * 255 / 256), 8);
  });

  it("reads f2 = 0 as 1, which is out of spec but common", () => {
    const fcs = parseFcs(logAmpFile("4,0", "256", [0, 64]));
    expect(fcs.channels[0].logAmp).toEqual({ decades: 4, offset: 1 });
    expect(Array.from(fcs.columns[0])[0]).toBeCloseTo(1, 12);
  });

  it("leaves a linear channel ($PnE 0,0) as stored", () => {
    const fcs = parseFcs(logAmpFile("0,0", "256", [0, 64, 128]));
    expect(fcs.channels[0].logAmp).toBeUndefined();
    expect(Array.from(fcs.columns[0])).toEqual([0, 64, 128]);
  });

  it("cannot decode without a usable $PnR, so leaves the values alone", () => {
    const fcs = parseFcs(logAmpFile("4,1", "0", [0, 64, 128]));
    expect(fcs.channels[0].logAmp).toBeUndefined();
    expect(Array.from(fcs.columns[0])).toEqual([0, 64, 128]);
  });

  it("decodes into float64, so one stored integer maps to one exact value", () => {
    const fcs = parseFcs(logAmpFile("4,1", "1024", [100, 100, 101]));
    expect(fcs.columns[0]).toBeInstanceOf(Float64Array);
    const col = Array.from(fcs.columns[0]);
    expect(col[0]).toBe(col[1]);
    expect(col[2]).toBeGreaterThan(col[1]);
  });
});

// Log amplification is a property of integer data. FCS 3.1 requires $PnE/0,0/ on float and
// double files, and flowCore decodes only when the datatype is integer; a float file carrying a
// stray $PnE/4,1/ had its real intensities exponentiated (262144 became 10,000) until 2026-09-11.
describe("parseFcs — $PnE is ignored on float data, and bounded on integer data", () => {
  function floatFile(pne: string, values: number[]): ArrayBuffer {
    const text =
      `/$BEGINANALYSIS/0/$ENDANALYSIS/0/$BYTEORD/1,2,3,4/$DATATYPE/F/$MODE/L` +
      `/$NEXTDATA/0/$PAR/1/$TOT/${values.length}` +
      `/$P1B/32/$P1E/${pne}/$P1N/FL1-A/$P1R/262144/$P1S/FITC-A/`;
    const HEAD = 256;
    const textStart = HEAD;
    const textEnd = textStart + text.length - 1;
    // Data 4-aligned, as the fast path expects.
    const dataStart = Math.ceil((textEnd + 1) / 4) * 4;
    const dataEnd = dataStart + values.length * 4 - 1;
    const buf = new Uint8Array(dataEnd + 1);
    const put = (s: string, at: number) => {
      for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i);
    };
    put("FCS3.1  ", 0);
    put(String(textStart).padStart(8), 10);
    put(String(textEnd).padStart(8), 18);
    put(String(dataStart).padStart(8), 26);
    put(String(dataEnd).padStart(8), 34);
    put(text, textStart);
    new Float32Array(buf.buffer, dataStart, values.length).set(values);
    return buf.buffer;
  }

  it("leaves float intensities alone whatever $PnE says", () => {
    const fcs = parseFcs(floatFile("4,1", [0, 1000, 50000, 262144]));
    expect(fcs.channels[0].logAmp).toBeUndefined();
    expect(Array.from(fcs.columns[0])).toEqual([0, 1000, 50000, 262144]);
    expect(fcs.channels[0].range).toBe(262144);
  });

  it("wraps a stored integer above $PnR to the channel's bit width, as flowCore does", () => {
    // Range 128 is 7 bits; a stored 200 wraps to 72 rather than decoding beyond the declared decades.
    const buf = (() => {
      const text =
        `/$BEGINANALYSIS/0/$ENDANALYSIS/0/$BYTEORD/1,2,3,4/$DATATYPE/I/$MODE/L` +
        `/$NEXTDATA/0/$PAR/1/$TOT/2/$P1B/8/$P1E/4,1/$P1N/FL1-H/$P1R/128/$P1S/FITC-H/`;
      const textStart = 256, textEnd = textStart + text.length - 1, dataStart = textEnd + 1;
      const out = new Uint8Array(dataStart + 2);
      const put = (s: string, at: number) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
      put("FCS3.0  ", 0);
      put(String(textStart).padStart(8), 10); put(String(textEnd).padStart(8), 18);
      put(String(dataStart).padStart(8), 26); put(String(dataStart + 1).padStart(8), 34);
      put(text, textStart);
      out[dataStart] = 72; out[dataStart + 1] = 200;
      return out.buffer;
    })();
    const fcs = parseFcs(buf);
    const col = Array.from(fcs.columns[0]);
    expect(col[1]).toBe(col[0]);
    expect(col[0]).toBeCloseTo(Math.pow(10, 4 * 72 / 128), 8);
    // The range describes the decoded values now.
    expect(fcs.channels[0].range).toBe(10000);
  });
});


/** Public S8 recording (Zenodo 19221995): 440 parameters, $PnFEATURE on each. */
const S8_PUBLIC = `${VENDOR_MATRIX_DIR}/bd_facsdiscover_s8__19221995__Zam36_YFP.fcs`;

describe.runIf(existsSync(S8_PUBLIC))("parseFcs — $PnFEATURE", () => {
  it("carries the instrument's word for what a parameter measures, and nothing when it has none", () => {
    const fcs = parseFcs(loadArrayBuffer(S8_PUBLIC));
    const byName = new Map(fcs.channels.map((c) => [c.name, c]));
    expect(byName.get("FSC-A")?.feature).toBe("Area");
    expect(byName.get("FSC-H")?.feature).toBe("Height");
    expect(byName.get("FSC-W")?.feature).toBe("Width");
    expect(byName.get("Size (FSC)")?.feature).toBe("MaskSize");
    expect(byName.get("Eccentricity (FSC)")?.feature).toBe("Eccentricity");
    expect(byName.get("Delta CoM (SSC (Imaging)/FSC)")?.feature).toBe("Delta CoM");
    // The S8's bookkeeping columns carry no feature, and the field is then absent, not "".
    expect(byName.get("Saturated")).toBeDefined();
    expect("feature" in byName.get("Saturated")!).toBe(false);
    // A file without the keyword has no such field on any channel.
    const aria = parseFcs(loadArrayBuffer(ARIA_SMALL));
    expect(aria.channels.every((c) => !("feature" in c))).toBe(true);
  });
});

// ── Byte-level fixtures for the 2026-09 reader fixes ─────────────────────────
// Every value here is synthetic: channels A/B/C, markers named after nothing real.

/** One FCS data set: HEADER, TEXT from `keywords` (encoded as given), then `data`. */
function rawDataSet(opts: {
  version?: string;
  keywords: [string, string][];
  data: Uint8Array;
  encode?: (text: string) => Uint8Array;
}): Uint8Array {
  const encode = opts.encode ?? ((t: string) => new TextEncoder().encode(t));
  const textStart = 64;
  let begin = 0;
  let text: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < 4; i++) {
    const kv: [string, string][] = [
      ...opts.keywords,
      ["$BEGINDATA", String(begin)],
      ["$ENDDATA", String(begin + opts.data.length - 1)],
    ];
    text = encode("/" + kv.map(([k, v]) => `${k}/${v.replaceAll("/", "//")}`).join("/") + "/");
    begin = textStart + text.length;
  }
  const out = new Uint8Array(begin + opts.data.length);
  const put = (s: string, at: number) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  put((opts.version ?? "FCS3.1").padEnd(10, " "), 0);
  put(String(textStart).padStart(8), 10);
  put(String(textStart + text.length - 1).padStart(8), 18);
  put(String(begin).padStart(8), 26);
  put(String(begin + opts.data.length - 1).padStart(8), 34);
  put("       0       0", 42);
  out.set(text, textStart);
  out.set(opts.data, begin);
  return out;
}

const ab = (u8: Uint8Array): ArrayBuffer => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

/** Little-endian float32 rows. */
function f32Rows(rows: number[][]): Uint8Array {
  const out = new Uint8Array(rows.length * (rows[0]?.length ?? 0) * 4);
  const dv = new DataView(out.buffer);
  let off = 0;
  for (const row of rows) for (const v of row) { dv.setFloat32(off, v, true); off += 4; }
  return out;
}

function floatKeywords(names: string[], n: number, extra: [string, string][] = []): [string, string][] {
  return [
    ["$BYTEORD", "1,2,3,4"], ["$DATATYPE", "F"], ["$MODE", "L"], ["$NEXTDATA", "0"],
    ["$PAR", String(names.length)], ["$TOT", String(n)],
    ...names.flatMap((name, i): [string, string][] => [
      [`$P${i + 1}N`, name], [`$P${i + 1}B`, "32"], [`$P${i + 1}E`, "0,0"], [`$P${i + 1}R`, "262144"],
    ]),
    ...extra,
  ];
}

describe("parseFcs — TEXT is UTF-8, with Latin-1 only for bytes that are not", () => {
  it("reads a UTF-8 marker label as written (FCS 3.1 §2.1.2)", () => {
    const fcs = parseFcs(ab(rawDataSet({
      keywords: floatKeywords(["A", "B"], 1, [["$P2S", "IFN-γ"], ["$P1S", "CD27−"]]),
      data: f32Rows([[1, 2]]),
    })));
    expect(fcs.channels[1].marker).toBe("IFN-γ");
    expect(fcs.channels[0].marker).toBe("CD27−");
  });

  it("falls back to Latin-1 when the TEXT is not valid UTF-8", () => {
    const latin1 = (t: string) => Uint8Array.from(t, (c) => c.charCodeAt(0) & 0xff);
    const fcs = parseFcs(ab(rawDataSet({
      version: "FCS2.0",
      keywords: floatKeywords(["A"], 1, [["$P1S", "Anti-hé"]]),
      data: f32Rows([[1]]),
      encode: latin1,
    })));
    expect(fcs.channels[0].marker).toBe("Anti-hé");
  });
});

describe("parseFcs — refuses what is not an FCS data set", () => {
  it("refuses a file that does not start with an FCS version", () => {
    const junk = new TextEncoder().encode("oi21j08cn\n");
    expect(() => parseFcs(ab(junk))).toThrow(/not an FCS file/i);
    const longJunk = new TextEncoder().encode("x".repeat(200));
    expect(() => parseFcs(ab(longJunk))).toThrow(/not an FCS file.*FCS version/i);
  });

  it("refuses an unknown $DATATYPE and a histogram $MODE instead of misreading them", () => {
    const bad = floatKeywords(["A"], 1).map(([k, v]): [string, string] => [k, k === "$DATATYPE" ? "Q" : v]);
    expect(() => parseFcs(ab(rawDataSet({ keywords: bad, data: f32Rows([[1]]) })))).toThrow(/Unsupported \$DATATYPE=Q/);
    const hist = floatKeywords(["A"], 1).map(([k, v]): [string, string] => [k, k === "$MODE" ? "U" : v]);
    expect(() => parseFcs(ab(rawDataSet({ keywords: hist, data: f32Rows([[1]]) })))).toThrow(/Unsupported \$MODE=U/);
  });

  it("says a DATA segment is incomplete rather than failing on a typed-array length", () => {
    const short = rawDataSet({ keywords: floatKeywords(["A", "B"], 3), data: f32Rows([[1, 2]]) });
    expect(() => parseFcs(ab(short))).toThrow(/DATA segment is incomplete/);
  });
});

describe("parseFcs — $DATATYPE=A (ASCII)", () => {
  const asciiKeywords = (pnb: string, n: number): [string, string][] => [
    ["$BYTEORD", "1,2,3,4"], ["$DATATYPE", "A"], ["$MODE", "L"], ["$NEXTDATA", "0"],
    ["$PAR", "2"], ["$TOT", String(n)],
    ["$P1N", "A"], ["$P1B", pnb], ["$P1E", "0,0"], ["$P1R", "1024"],
    ["$P2N", "B"], ["$P2B", pnb], ["$P2E", "0,0"], ["$P2R", "1024"],
  ];

  it("reads fixed-width values: $PnB characters each, no separators", () => {
    const fcs = parseFcs(ab(rawDataSet({
      version: "FCS3.0",
      keywords: asciiKeywords("4", 2),
      data: new TextEncoder().encode(" 123 456 7891000"),
    })));
    expect(Array.from(fcs.columns[0])).toEqual([123, 789]);
    expect(Array.from(fcs.columns[1])).toEqual([456, 1000]);
  });

  it("reads free-format values when $PnB is *", () => {
    const fcs = parseFcs(ab(rawDataSet({
      version: "FCS3.0",
      keywords: asciiKeywords("*", 2),
      data: new TextEncoder().encode("123,456\n789 1000"),
    })));
    expect(Array.from(fcs.columns[0])).toEqual([123, 789]);
    expect(Array.from(fcs.columns[1])).toEqual([456, 1000]);
  });
});

describe("parseFcs — integer words are masked to $PnR's bit width", () => {
  it("drops a flag bit on a LINEAR integer channel, as flowCore and flowio do", () => {
    // 16-bit words, range 1024 (10 bits): the high bits carry no measurement (FCS 3.1 §3.2.20).
    const fcs = parseFcs(buildFcs({
      datatype: "I", bits: 16, range: 1024, channels: ["A"],
      events: [[500], [0x8000 | 500], [1023], [0x0400 | 7]],
    }));
    expect(Array.from(fcs.columns[0])).toEqual([500, 500, 1023, 7]);
  });

  it("uses the next power of two when $PnR is not one, and leaves a full-width range alone", () => {
    const odd = parseFcs(buildFcs({
      datatype: "I", bits: 16, range: 1000, channels: ["A"], events: [[1001], [1024 + 3]],
    }));
    expect(Array.from(odd.columns[0])).toEqual([1001, 3]);
    const full = parseFcs(buildFcs({
      datatype: "I", bits: 16, range: 65536, channels: ["A"], events: [[65535]],
    }));
    expect(Array.from(full.columns[0])).toEqual([65535]);
  });
});

describe("parseFcs — FCS 3.2 $PnDATATYPE", () => {
  it("reads each parameter in its own type and width", () => {
    // Float file with an integer parameter (4 bytes) and a double parameter (8 bytes) inside it.
    const keywords: [string, string][] = [
      ["$BYTEORD", "1,2,3,4"], ["$DATATYPE", "F"], ["$MODE", "L"], ["$NEXTDATA", "0"],
      ["$PAR", "3"], ["$TOT", "2"],
      ["$P1N", "A"], ["$P1B", "32"], ["$P1E", "0,0"], ["$P1R", "262144"],
      ["$P2N", "B"], ["$P2B", "32"], ["$P2E", "0,0"], ["$P2R", "4294967296"], ["$P2DATATYPE", "I"],
      ["$P3N", "C"], ["$P3B", "64"], ["$P3E", "0,0"], ["$P3R", "262144"], ["$P3DATATYPE", "D"],
    ];
    const data = new Uint8Array(2 * 16);
    const dv = new DataView(data.buffer);
    [[1.5, 1299868, 0.1], [2.5, 3186724541, 123456.789012345]].forEach((row, e) => {
      dv.setFloat32(e * 16, row[0], true);
      dv.setUint32(e * 16 + 4, row[1], true);
      dv.setFloat64(e * 16 + 8, row[2], true);
    });
    const fcs = parseFcs(ab(rawDataSet({ version: "FCS3.2", keywords, data })));
    expect(Array.from(fcs.columns[0])).toEqual([1.5, 2.5]);
    expect(fcs.columns[1]).toBeInstanceOf(Uint32Array);
    expect(Array.from(fcs.columns[1])).toEqual([1299868, 3186724541]);
    expect(fcs.columns[2]).toBeInstanceOf(Float64Array);
    expect(Array.from(fcs.columns[2])).toEqual([0.1, 123456.789012345]);
  });
});

describe("parseFcs — $PnG is recorded, not applied", () => {
  it("keeps the stored value and records the gain on the channel", () => {
    const fcs = parseFcs(ab(rawDataSet({
      keywords: floatKeywords(["FSC-H", "SSC-H"], 1, [["$P1G", "3.67"]]),
      data: f32Rows([[323, 40]]),
    })));
    expect(fcs.columns[0][0]).toBe(323);
    expect(fcs.channels[0].gain).toBe(3.67);
    expect(fcs.channels[1].gain).toBeUndefined();
  });
});

describe("parseFcs — $COMP is not read as a spillover matrix", () => {
  it("leaves compensation to $SPILLOVER, as flowCore, flowio and FlowKit do", () => {
    // FCS 3.0 defines $COMP as the compensation already SUBTRACTED ELECTRONICALLY, in percent,
    // and FCS 3.1 retired it; vendors that still write it disagree about what it holds.
    const fcs = parseFcs(ab(rawDataSet({
      version: "FCS3.0",
      keywords: floatKeywords(["A-A", "B-A"], 1, [["$COMP", "2,1,-0.1,-0.2,1"]]),
      data: f32Rows([[1, 2]]),
    })));
    expect(fcs.spillover).toBeNull();
  });
});

describe("parseFcs — several data sets in one file ($NEXTDATA)", () => {
  /** Two data sets, each a full FCS data set, chained by $NEXTDATA relative to its own HEADER. */
  function twoDataSets(): Uint8Array {
    const first = (next: number) => rawDataSet({
      keywords: floatKeywords(["A", "B"], 2, [["$WELLID", "A01"]]).map(([k, v]): [string, string] =>
        [k, k === "$NEXTDATA" ? String(next).padStart(8, "0") : v]),
      data: f32Rows([[1, 2], [3, 4]]),
    });
    const probe = first(0);
    const one = first(probe.length);
    const two = rawDataSet({
      keywords: floatKeywords(["A", "B"], 3, [["$WELLID", "A02"]]),
      data: f32Rows([[10, 20], [30, 40], [50, 60]]),
    });
    const out = new Uint8Array(one.length + two.length);
    out.set(one, 0);
    out.set(two, one.length);
    return out;
  }

  it("refuses to read one data set silently, naming how many there are", () => {
    expect(() => parseFcs(ab(twoDataSets()))).toThrow(FcsMultipleDataSetsError);
    expect(() => parseFcs(ab(twoDataSets()))).toThrow(/holds 2 data sets \(2, 3 events\)/);
  });

  it("lists every data set and reads any one of them", () => {
    const buf = ab(twoDataSets());
    const sets = listFcsDataSets(buf);
    expect(sets.map((s) => [s.events, s.label])).toEqual([[2, "A01"], [3, "A02"]]);
    const second = parseFcs(buf, { dataSet: 1 });
    expect(second.nEvents).toBe(3);
    expect(Array.from(second.columns[1])).toEqual([20, 40, 60]);
    expect(Array.from(parseFcs(buf, { dataSet: 0 }).columns[0])).toEqual([1, 3]);
  });

  it("takes a data set out as a file of its own, every byte but $NEXTDATA unchanged", () => {
    const whole = twoDataSets();
    const first = extractFcsDataSet(ab(whole), 0);
    expect(listFcsDataSets(ab(first))).toHaveLength(1);
    expect(parseFcs(ab(first)).nEvents).toBe(2);
    const changed = first.reduce((n, byte, i) => n + (byte !== whole[i] ? 1 : 0), 0);
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThanOrEqual(8); // the $NEXTDATA digits only
    expect(Array.from(parseFcs(ab(extractFcsDataSet(ab(whole), 1))).columns[0])).toEqual([10, 30, 50]);
  });

  it("refuses a $NEXTDATA that points past the end of the file, rather than ending the chain there", () => {
    // Three data sets whose writer stored each $NEXTDATA from the start of the FILE. FCS 3.1
    // counts it from the start of the current data set, as flowCore does, so the second pointer
    // lands past the end, and the third data set, which is in the file, was dropped silently.
    const set = (rows: number[][], well: string, next: number) => rawDataSet({
      keywords: floatKeywords(["A", "B"], rows.length, [["$WELLID", well]]).map(([k, v]): [string, string] =>
        [k, k === "$NEXTDATA" ? String(next).padStart(8, "0") : v]),
      data: f32Rows(rows),
    });
    const rows1 = Array.from({ length: 40 }, (_, i) => [i, i + 1]);
    const len1 = set(rows1, "A01", 0).length;
    const len2 = set([[5, 6]], "A02", 0).length;
    const one = set(rows1, "A01", len1);
    const two = set([[5, 6]], "A02", len1 + len2); // absolute: the third HEADER's file offset
    const three = set([[7, 8], [9, 10]], "A03", 0);
    const bytes = new Uint8Array(one.length + two.length + three.length);
    bytes.set(one, 0);
    bytes.set(two, one.length);
    bytes.set(three, one.length + two.length);
    expect(len1 + len1 + len2).toBeGreaterThan(bytes.length);
    expect(() => listFcsDataSets(ab(bytes))).toThrow(
      new RegExp(`\\$NEXTDATA points to byte ${len1 + len1 + len2}, past the end of the ${bytes.length}-byte file`));
    expect(() => parseFcs(ab(bytes))).toThrow(/from the start of the file.*byte \d+ holds an FCS HEADER/);

    // A single data set whose $NEXTDATA names a data set the file does not hold: cut short.
    const cut = set([[1, 2]], "A01", 5000);
    expect(() => parseFcs(ab(cut))).toThrow(/past the end of the \d+-byte file.*cut short/);
    const atEnd = set([[1, 2]], "A01", set([[1, 2]], "A01", 0).length);
    expect(atEnd.length).toBe(set([[1, 2]], "A01", 0).length);
    expect(() => parseFcs(ab(atEnd))).toThrow(/past the end/);
  });

  it("names each data set's sample after its file and position, and reads the name back", () => {
    const name = fcsDataSetFileName("plate 1.fcs", 1, 4, "A02");
    expect(name).toBe("plate 1 (data set 2 of 4, A02).fcs");
    expect(parseFcsDataSetFileName(name)).toEqual({ fileName: "plate 1.fcs", index: 1, count: 4, label: "A02" });
    expect(parseFcsDataSetFileName("plate 1.fcs")).toBeNull();
    expect(parseFcsDataSetFileName(fcsDataSetFileName("x.fcs", 0, 2, null))).toEqual({ fileName: "x.fcs", index: 0, count: 2, label: null });
    // A label is written with the characters the name uses as punctuation replaced.
    expect(parseFcsDataSetFileName(fcsDataSetFileName("x.fcs", 1, 2, "B1 (1/2)"))?.label).toBe("B1 _1_2_");
  });
});

const MUSE = `${VENDOR_MATRIX_DIR}/curated-from-fcsparser/Guava_Muse.fcs`;

describe.runIf(existsSync(MUSE))("parseFcs — Guava Muse plate export, four wells in one file", () => {
  it("finds all four data sets, as flowio.read_multiple_data_sets and flowCore do", () => {
    const buf = loadArrayBuffer(MUSE);
    const sets = listFcsDataSets(buf);
    expect(sets.map((s) => s.events)).toEqual([108, 50081, 111496, 50037]);
    expect(sets.map((s) => s.label)).toEqual(["A01", "A02", "A03", "A04"]);
    expect(() => parseFcs(buf)).toThrow(FcsMultipleDataSetsError);
    for (let k = 0; k < 4; k++) {
      const own = parseFcs(ab(extractFcsDataSet(buf, k)));
      expect(own.nEvents).toBe(sets[k].events);
      expect(own.channels).toHaveLength(10);
    }
  });
});

describe.runIf(existsSync(S8_PUBLIC))("parseFcs — S8 integer bookkeeping parameters ($PnDATATYPE=I)", () => {
  it("reads event numbers as consecutive integers, not float32 denormals", () => {
    const fcs = parseFcs(loadArrayBuffer(S8_PUBLIC));
    const col = (name: string) => fcs.columns[fcs.channels.findIndex((c) => c.name === name)];
    const events = col("EventNumber0");
    expect(events).toBeInstanceOf(Uint32Array);
    expect(events[0]).toBe(1299868);
    for (let i = 1; i < events.length; i++) expect(events[i] - events[i - 1]).toBe(1);
    const widths = Array.from(col("EventWidthInDrops"));
    expect(Math.min(...widths)).toBe(29);
    expect(Math.max(...widths)).toBe(167);
    // Measurement parameters are still float32, as the file declares.
    expect(col("FSC-A")).toBeInstanceOf(Float32Array);
  });
});
