import { describe, expect, it } from "vitest";
import { readTiffPages, writeTiffPages, TiffError } from "./tiff";

describe("the TIFF reader", () => {
  it("reads float pages by name, in either byte order, with their resolution", () => {
    const a = Float32Array.from({ length: 6 }, (_, i) => i - 2.5);
    const b = Float32Array.from({ length: 6 }, (_, i) => i * 10);
    for (const big of [false, true]) {
      const bytes = writeTiffPages([{ width: 3, height: 2, name: "LightLoss (Imaging)", data: a, xResolution: 73.3, yResolution: 88 }, { width: 3, height: 2, name: "FSC", data: b }], big);
      const pages = readTiffPages(bytes.buffer);
      expect(pages.map((p) => [p.name, p.width, p.height])).toEqual([["LightLoss (Imaging)", 3, 2], ["FSC", 3, 2]]);
      expect(Array.from(pages[0].data)).toEqual(Array.from(a));
      expect(Array.from(pages[1].data)).toEqual(Array.from(b));
      expect(pages[0].xResolution).toBeCloseTo(73.3, 3);
      expect(pages[0].yResolution).toBeCloseTo(88, 3);
      expect(pages[1].xResolution).toBeUndefined();
    }
  });

  it("reads integer samples as floats", () => {
    const bytes = writeTiffPages([{ width: 2, height: 2, data: Uint16Array.from([1, 2, 3, 65535]) }, { width: 2, height: 1, data: Uint8Array.from([7, 255]) }]);
    const pages = readTiffPages(bytes.buffer);
    expect(Array.from(pages[0].data)).toEqual([1, 2, 3, 65535]);
    expect(Array.from(pages[1].data)).toEqual([7, 255]);
  });

  it("refuses what it does not read, saying what it is", () => {
    expect(() => readTiffPages(new Uint8Array([0x49, 0x49, 42, 0]).buffer)).toThrow(TiffError);
    expect(() => readTiffPages(new TextEncoder().encode("not a tiff at all").buffer)).toThrow(/byte-order/);
    const bytes = writeTiffPages([{ width: 2, height: 2, data: Float32Array.from([1, 2, 3, 4]) }]);
    // Compression 5 (LZW) in the compression entry: tag 259 is the fourth entry (sorted), type SHORT.
    const view = new DataView(bytes.buffer);
    const dirAt = 8;
    const count = view.getUint16(dirAt, true);
    for (let i = 0; i < count; i++) {
      const at = dirAt + 2 + i * 12;
      if (view.getUint16(at, true) === 259) view.setUint16(at + 8, 5, true);
    }
    expect(() => readTiffPages(bytes.buffer)).toThrow(/compressed/);
    const whole = writeTiffPages([{ width: 2, height: 2, data: Float32Array.from([1, 2, 3, 4]) }]);
    const cut = whole.slice(0, whole.length - 4);
    expect(() => readTiffPages(cut.buffer)).toThrow(/past the end|fewer samples/);
  });
});
