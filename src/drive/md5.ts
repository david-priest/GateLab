// md5.ts — MD5 (RFC 1321) of bytes held in the page, the checksum Drive reports for every binary
// file (md5Checksum). An upload's checksum is compared with Drive's to confirm the file arrived
// whole, and to find a file Drive stored although it answered with an error. Web Crypto has no
// MD5, so it is computed here; the hash is read in slices, yielding between them, so a large FCS
// does not hold the page still.

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

/** An MD5 computed over bytes given in any number of pieces. */
export class Md5 {
  private a = 0x67452301 | 0;
  private b = 0xefcdab89 | 0;
  private c = 0x98badcfe | 0;
  private d = 0x10325476 | 0;
  private readonly block = new Uint8Array(64);
  private readonly words = new Int32Array(16);
  private filled = 0;
  private length = 0;
  private done = false;

  update(bytes: Uint8Array): this {
    if (this.done) throw new Error("MD5 already finished.");
    this.length += bytes.length;
    let offset = 0;
    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, bytes.length);
      this.block.set(bytes.subarray(0, take), this.filled);
      this.filled += take;
      offset = take;
      if (this.filled < 64) return this;
      this.round(this.block, 0);
      this.filled = 0;
    }
    for (; offset + 64 <= bytes.length; offset += 64) this.round(bytes, offset);
    if (offset < bytes.length) {
      this.block.set(bytes.subarray(offset), 0);
      this.filled = bytes.length - offset;
    }
    return this;
  }

  /** The digest as Drive writes it: 32 lower-case hexadecimal digits. */
  hex(): string {
    if (!this.done) {
      const bits = this.length * 8;
      const tail = new Uint8Array((this.filled < 56 ? 64 : 128) - this.filled);
      tail[0] = 0x80;
      const view = new DataView(tail.buffer);
      view.setUint32(tail.length - 8, bits >>> 0, true);
      view.setUint32(tail.length - 4, Math.floor(bits / 2 ** 32), true);
      const length = this.length;
      this.update(tail);
      this.length = length;
      this.done = true;
    }
    const out = new DataView(new ArrayBuffer(16));
    out.setInt32(0, this.a, true);
    out.setInt32(4, this.b, true);
    out.setInt32(8, this.c, true);
    out.setInt32(12, this.d, true);
    return Array.from(new Uint8Array(out.buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private round(bytes: Uint8Array, offset: number): void {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24);
    }
    let a = this.a;
    let b = this.b;
    let c = this.c;
    let d = this.d;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const sum = (a + f + K[i] + w[g]) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << S[i]) | (sum >>> (32 - S[i])))) | 0;
    }
    this.a = (this.a + a) | 0;
    this.b = (this.b + b) | 0;
    this.c = (this.c + c) | 0;
    this.d = (this.d + d) | 0;
  }
}

export function md5Hex(bytes: Uint8Array): string {
  return new Md5().update(bytes).hex();
}

/** The MD5 of a large array, read in slices with a pause between them; stops when `signal` aborts. */
export async function md5HexAsync(
  bytes: Uint8Array,
  options: { signal?: AbortSignal; slice?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<string> {
  const { signal, slice = 4 * 1024 * 1024, onProgress } = options;
  const hash = new Md5();
  for (let offset = 0; offset < bytes.length; offset += slice) {
    signal?.throwIfAborted();
    hash.update(bytes.subarray(offset, Math.min(offset + slice, bytes.length)));
    onProgress?.(Math.min(offset + slice, bytes.length), bytes.length);
    if (offset + slice < bytes.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return hash.hex();
}
