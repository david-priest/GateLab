// MD5 against RFC 1321's test suite and Node's own, whole and given in pieces of every size.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Md5, md5Hex, md5HexAsync } from "./md5";

const text = (value: string) => new TextEncoder().encode(value);

describe("MD5", () => {
  it("gives RFC 1321's digests", () => {
    expect(md5Hex(text(""))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex(text("a"))).toBe("0cc175b9c0f1b6a831c399e269772661");
    expect(md5Hex(text("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex(text("message digest"))).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(md5Hex(text("abcdefghijklmnopqrstuvwxyz"))).toBe("c3fcd3d76192e4007dfb496cca67e13b");
    expect(md5Hex(text("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")))
      .toBe("d174ab98d277d9f5a5611c2c9f419d9f");
    expect(md5Hex(text("1234567890".repeat(8)))).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });

  it("agrees with Node's at every length around the block and padding edges, and in any pieces", () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 131 + 7) & 255);
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 300]) {
      const part = bytes.subarray(0, length);
      const expected = createHash("md5").update(part).digest("hex");
      expect(md5Hex(part), `length ${length}`).toBe(expected);
      for (const piece of [1, 3, 63, 64, 65]) {
        const hash = new Md5();
        for (let offset = 0; offset < length; offset += piece) hash.update(part.subarray(offset, offset + piece));
        expect(hash.hex(), `length ${length} in pieces of ${piece}`).toBe(expected);
      }
    }
  });

  it("reads a large array in slices, and stops when cancelled", async () => {
    const bytes = Uint8Array.from({ length: 1_000_003 }, (_, i) => (i * 7) & 255);
    const seen: number[] = [];
    expect(await md5HexAsync(bytes, { slice: 65_536, onProgress: (done) => seen.push(done) }))
      .toBe(createHash("md5").update(bytes).digest("hex"));
    expect(seen.at(-1)).toBe(bytes.length);
    expect(seen.length).toBe(Math.ceil(bytes.length / 65_536));
    const controller = new AbortController();
    controller.abort();
    await expect(md5HexAsync(bytes, { signal: controller.signal })).rejects.toThrow();
  });
});
