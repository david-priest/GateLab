import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { parseFcs } from "./fcs";
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
    kv.push(`$P${p}N`, nm, `$P${p}B`, String(opts.bits), `$P${p}R`, "262144", `$P${p}E`, "0,0");
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
