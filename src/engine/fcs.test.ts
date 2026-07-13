import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFcs } from "./fcs";

// Ground truth extracted independently (fcsparser for metadata; a raw big-endian
// struct read for the data values) from the real Aria III test file. This is a
// "don't guess" cross-check: the parser must reproduce these exactly.
const ARIA_SMALL =
  "/Users/davidpriest/code/gatelabr-test-fcs/conventional_comp_AriaIII/sample_Bmem_purity_small.fcs";

function loadArrayBuffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
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
  events: number[][]; // event-major rows
  littleEndian?: boolean;
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
  });
  const textBody = delim + kv.join(delim) + delim;

  const textStart = 256; // leave the standard header room + slack
  const textEnd = textStart + textBody.length - 1; // inclusive index of last TEXT byte
  const dataStart = textEnd + 1;
  const dataBytes = tot * par * bytesPerVal;
  const dataEnd = dataStart + dataBytes - 1;

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
  putAscii(pad8(dataStart), 26);
  putAscii(pad8(dataEnd), 34);
  // analysis start/end (42..57) left as spaces/zeros — unused here.

  putAscii(textBody, textStart);

  const dv = new DataView(buf);
  let off = dataStart;
  for (const ev of opts.events) {
    for (const v of ev) {
      if (opts.datatype === "D") {
        dv.setFloat64(off, v, le);
        off += 8;
      } else if (opts.bits === 16) {
        dv.setUint16(off, v, le);
        off += 2;
      } else if (opts.bits === 32) {
        dv.setUint32(off, v, le);
        off += 4;
      } else {
        dv.setUint8(off, v);
        off += 1;
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
