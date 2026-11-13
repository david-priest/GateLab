import { describe, expect, it } from "vitest";
import { parseFcs } from "./fcs";

// Files written by hand, byte for byte, so the reader is not tested against GateLab's own writer.

/** A one-data-set FCS file: HEADER, TEXT, then `data` (and anything appended to it). */
function fcsFile(version: string, keywords: [string, string][], data: Uint8Array): ArrayBuffer {
  let text = "";
  let begin = 0;
  let end = 0;
  for (let pass = 0; pass < 5; pass++) {
    const all: [string, string][] = [...keywords, ["$BEGINDATA", String(begin)], ["$ENDDATA", String(end)]];
    text = "/" + all.map(([k, v]) => `${k}/${v}/`).join("");
    begin = 58 + text.length;
    end = begin + data.length - 1;
  }
  const field = (n: number) => String(n).padStart(8, " ");
  const header = version.padEnd(10, " ") + field(58) + field(58 + text.length - 1) + field(begin) + field(end) + field(0) + field(0);
  const out = new Uint8Array(58 + text.length + data.length);
  for (let i = 0; i < 58; i++) out[i] = header.charCodeAt(i);
  for (let i = 0; i < text.length; i++) out[58 + i] = text.charCodeAt(i);
  out.set(data, 58 + text.length);
  return out.buffer;
}

function float32(values: number[], littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((v, i) => view.setFloat32(i * 4, v, littleEndian));
  return bytes;
}

const oneFloatChannel = (byteOrder: string): [string, string][] => [
  ["$BYTEORD", byteOrder], ["$DATATYPE", "F"], ["$MODE", "L"], ["$NEXTDATA", "0"], ["$PAR", "1"], ["$TOT", "3"],
  ["$P1N", "FL1-A"], ["$P1B", "32"], ["$P1E", "0,0"], ["$P1R", "262144"],
];

describe("$BYTEORD", () => {
  it.each([["1,2,3,4", true], ["1, 2, 3, 4", true], [" 1,2,3,4 ", true], ["4,3,2,1", false], ["4, 3, 2, 1", false]] as const)(
    "%j is read in its own order", (byteOrder, littleEndian) => {
      const file = parseFcs(fcsFile("FCS3.0", oneFloatChannel(byteOrder), float32([100, 200, 300], littleEndian)));
      expect(Array.from(file.columns[0])).toEqual([100, 200, 300]);
    });

  it("of a mixed order is refused, not read as big-endian", () => {
    expect(() => parseFcs(fcsFile("FCS3.0", oneFloatChannel("3,4,1,2"), float32([100, 200, 300], true))))
      .toThrow(/Unsupported \$BYTEORD=3,4,1,2/);
  });
});

describe("a file with no $TOT", () => {
  it("holds the events its DATA segment holds", () => {
    const data = new Uint8Array(6);
    const view = new DataView(data.buffer);
    [10, 20, 30].forEach((v, i) => view.setUint16(i * 2, v, false));
    const file = parseFcs(fcsFile("FCS2.0", [
      ["$BYTEORD", "2,1"], ["$DATATYPE", "I"], ["$MODE", "L"], ["$NEXTDATA", "0"], ["$PAR", "1"],
      ["$P1N", "FL1-H"], ["$P1B", "16"], ["$P1R", "1024"], ["$P1E", "0,0"],
    ], data));
    expect(file.nEvents).toBe(3);
    expect(Array.from(file.columns[0])).toEqual([10, 20, 30]);
  });
});

describe("a supplemental TEXT segment", () => {
  it("gives the keywords the primary segment does not", () => {
    const data = float32([10, 20], true);
    const supplemental = "/$SPILLOVER/2,FL1-A,FL2-A,1,0.1,0.2,1/$P1N/Renamed/";
    const offset = (n: number) => String(n).padStart(8, "0");
    const keywords = (begin: number, end: number): [string, string][] => [
      ["$BYTEORD", "1,2,3,4"], ["$DATATYPE", "F"], ["$MODE", "L"], ["$NEXTDATA", "0"], ["$PAR", "2"], ["$TOT", "1"],
      ["$P1N", "FL1-A"], ["$P1B", "32"], ["$P1E", "0,0"], ["$P1R", "1024"],
      ["$P2N", "FL2-A"], ["$P2B", "32"], ["$P2E", "0,0"], ["$P2R", "1024"],
      ["$BEGINSTEXT", offset(begin)], ["$ENDSTEXT", offset(end)],
    ];
    // The supplemental segment follows DATA; its offsets are padded, so the TEXT length is fixed.
    const start = new Uint8Array(fcsFile("FCS3.0", keywords(0, 0), data)).length;
    const body = new Uint8Array(data.length + supplemental.length);
    body.set(data);
    for (let i = 0; i < supplemental.length; i++) body[data.length + i] = supplemental.charCodeAt(i);
    const file = parseFcs(fcsFile("FCS3.0", keywords(start, start + supplemental.length - 1), body));
    expect(file.spillover).toEqual({ channels: ["FL1-A", "FL2-A"], matrix: [[1, 0.1], [0.2, 1]] });
    // A keyword both segments give keeps the primary segment's value.
    expect(file.channels[0].name).toBe("FL1-A");
    expect(Array.from(file.columns[0])).toEqual([10]);
  });
});

describe("an exported column with no declared range", () => {
  it("is given a positive $PnR when every value is at or below 0", async () => {
    const { writeFcs } = await import("./fcsExport");
    const bytes = writeFcs([new Float32Array([0, 0, 0]), new Float32Array([-5, -2, -1])], [{ name: "A", desc: "" }, { name: "B", desc: "" }]);
    const file = parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(Number(file.keywords["$P1R"])).toBe(1);
    expect(Number(file.keywords["$P2R"])).toBe(1);
    expect(Array.from(file.columns[1])).toEqual([-5, -2, -1]);
  });
});

describe("a keyword value left empty", () => {
  const keywords = (empty: [string, string][]): [string, string][] => [
    ["$BYTEORD", "1,2,3,4"], ["$DATATYPE", "F"], ["$MODE", "L"], ["$NEXTDATA", "0"], ["$PAR", "2"], ["$TOT", "1"],
    ["$P1N", "FL1-A"], ...empty, ["$P2N", "FL2-A"], ["$P1B", "32"], ["$P1E", "0,0"], ["$P1R", "1024"],
    ["$P2B", "32"], ["$P2E", "0,0"], ["$P2R", "1024"],
  ];

  it("does not take the next keyword with it", () => {
    const file = parseFcs(fcsFile("FCS3.0", keywords([["$P1S", ""]]), float32([1, 2], true)));
    expect(file.channels.map((c) => c.name)).toEqual(["FL1-A", "FL2-A"]);
    expect(file.keywords["$P1S"]).toBe("");
    expect(Array.from(file.columns[0])).toEqual([1]);
    expect(Array.from(file.columns[1])).toEqual([2]);
  });

  it("leaves a doubled delimiter inside a value as the delimiter where the file reads by the rule", () => {
    const file = parseFcs(fcsFile("FCS3.0", keywords([["$FIL", "runs//D1.fcs"]]), float32([1, 2], true)));
    expect(file.keywords["$FIL"]).toBe("runs/D1.fcs");
    expect(file.channels.map((c) => c.name)).toEqual(["FL1-A", "FL2-A"]);
  });
});

describe("a DATA segment that does not hold what the keywords say", () => {
  const twoEvents = (tot: string): [string, string][] => [
    ["$BYTEORD", "1,2,3,4"], ["$DATATYPE", "F"], ["$MODE", "L"], ["$NEXTDATA", "0"], ["$PAR", "1"], ["$TOT", tot],
    ["$P1N", "FL1-A"], ["$P1B", "32"], ["$P1E", "0,0"], ["$P1R", "262144"],
  ];
  /** The file with bytes after its DATA segment, as a CRC or another segment would be. */
  const withTrailing = (file: ArrayBuffer, trailing: Uint8Array): ArrayBuffer => {
    const out = new Uint8Array(file.byteLength + trailing.length);
    out.set(new Uint8Array(file));
    out.set(trailing, file.byteLength);
    return out.buffer;
  };

  it("refuses a $TOT of more events than the segment holds, where bytes follow it", () => {
    const file = withTrailing(fcsFile("FCS3.1", twoEvents("3"), float32([100, 200], true)), float32([999], true));
    expect(() => parseFcs(file)).toThrow(/\$TOT=3 events .* DATA segment .* holds 8/);
  });

  it("reads the same file when $TOT is the two events the segment holds", () => {
    const file = withTrailing(fcsFile("FCS3.1", twoEvents("2"), float32([100, 200], true)), float32([999], true));
    expect(Array.from(parseFcs(file).columns[0])).toEqual([100, 200]);
  });

  it("refuses a file that places its DATA nowhere", () => {
    const bytes = new Uint8Array(fcsFile("FCS3.1", twoEvents("2"), float32([100, 200], true)));
    const zero = "       0";
    for (let i = 0; i < 16; i++) bytes[26 + i] = zero.charCodeAt(i % 8);
    const text = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    const at = text.indexOf("$BEGINDATA");
    bytes[at + 1] = "X".charCodeAt(0);
    expect(() => parseFcs(bytes.buffer)).toThrow(/does not say where its DATA segment begins/);
  });

  it("refuses a file with no $BYTEORD", () => {
    const keywords = twoEvents("2").filter(([key]) => key !== "$BYTEORD");
    expect(() => parseFcs(fcsFile("FCS3.1", keywords, float32([100, 200], false)))).toThrow(/no \$BYTEORD/);
  });
});
