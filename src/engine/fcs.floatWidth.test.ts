// A float ($DATATYPE F) parameter must declare $PnB 32 and a double (D) parameter $PnB 64 (FCS 3.1).
// A file that declares the other width is refused by name instead of being read at the wrong width.
import { describe, expect, it } from "vitest";
import { parseFcs } from "./fcs";

/** A one-data-set FCS 3.1 file with two parameters, written byte for byte. */
function fcsFile(keywords: [string, string][], data: Uint8Array): ArrayBuffer {
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
  const header = "FCS3.1".padEnd(10, " ") + field(58) + field(58 + text.length - 1) + field(begin) + field(end) + field(0) + field(0);
  const out = new Uint8Array(58 + text.length + data.length);
  for (let i = 0; i < 58; i++) out[i] = header.charCodeAt(i);
  for (let i = 0; i < text.length; i++) out[58 + i] = text.charCodeAt(i);
  out.set(data, 58 + text.length);
  return out.buffer;
}

const keywords = (datatype: string, pnb: string | null): [string, string][] => [
  ["$BYTEORD", "1,2,3,4"], ["$DATATYPE", datatype], ["$MODE", "L"], ["$NEXTDATA", "0"], ["$PAR", "2"], ["$TOT", "2"],
  ["$P1N", "FL1-A"], ...(pnb === null ? [] : [["$P1B", pnb] as [string, string]]), ["$P1E", "0,0"], ["$P1R", "262144"],
  ["$P2N", "FL2-A"], ...(pnb === null ? [] : [["$P2B", pnb] as [string, string]]), ["$P2E", "0,0"], ["$P2R", "262144"],
];

function values(rows: number[][], bytesEach: 4 | 8): Uint8Array {
  const flat = rows.flat();
  const bytes = new Uint8Array(flat.length * bytesEach);
  const view = new DataView(bytes.buffer);
  flat.forEach((v, i) => (bytesEach === 4 ? view.setFloat32(i * 4, v, true) : view.setFloat64(i * 8, v, true)));
  return bytes;
}

const rows = [[1.5, 2.5], [3.5, 4.5]];

describe("$PnB of a float or double parameter", () => {
  it("is refused when a float file declares $PnB 64", () => {
    expect(() => parseFcs(fcsFile(keywords("F", "64"), values(rows, 8)))).toThrow(/\$P1B=64 contradicts its data type F/);
  });

  it("is refused when a double file declares $PnB 32", () => {
    expect(() => parseFcs(fcsFile(keywords("D", "32"), values(rows, 4)))).toThrow(/\$P1B=32 contradicts its data type D/);
  });

  it("reads F with $PnB 32, D with $PnB 64, and D with no $PnB", () => {
    for (const [file, width] of [
      [fcsFile(keywords("F", "32"), values(rows, 4)), 4],
      [fcsFile(keywords("D", "64"), values(rows, 8)), 8],
      [fcsFile(keywords("D", null), values(rows, 8)), 8],
    ] as const) {
      const fcs = parseFcs(file);
      expect(fcs.nEvents, `width ${width}`).toBe(2);
      expect([Array.from(fcs.columns[0]), Array.from(fcs.columns[1])]).toEqual([[1.5, 3.5], [2.5, 4.5]]);
    }
  });
});
