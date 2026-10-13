// readRange.ts — the one way the imaging code reads bytes. A BD FACSDiscover S8 `.cvw` file is
// hundreds of megabytes to several gigabytes and only ever read in small pieces (a 128-byte
// header, a 24-byte-per-event index, a few kilobytes of metadata at the tail, one event's block
// of 50–250 KB at a time), so nothing here reads a whole file. The browser flow hands over a
// File from a picker or a handle; a future GateLabR host, whose R side has no File, can serve
// the same ranges over HTTP (the `url` kind), and nothing above this module changes.

export type ByteSource =
  | { readonly kind: "file"; readonly file: Blob }
  | { readonly kind: "url"; readonly url: string; readonly size: number };

/** Total length of the source in bytes. */
export function byteSourceSize(source: ByteSource): number {
  return source.kind === "file" ? source.file.size : source.size;
}

/**
 * Read `length` bytes starting at `offset`, as an ArrayBuffer that is exactly that long. A
 * range past the end is an error rather than a short read: every caller knows the length it
 * needs from the file's own header, so a short read means the file is truncated.
 */
export async function readRange(source: ByteSource, offset: number, length: number): Promise<ArrayBuffer> {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) {
    throw new RangeError(`readRange: bad range ${offset}+${length}`);
  }
  const size = byteSourceSize(source);
  if (offset + length > size) {
    throw new RangeError(
      `readRange: ${offset}+${length} is beyond the end of the file (${size} bytes); the file is truncated`,
    );
  }
  if (length === 0) return new ArrayBuffer(0);
  if (source.kind === "file") {
    const buffer = await source.file.slice(offset, offset + length).arrayBuffer();
    if (buffer.byteLength !== length) {
      throw new RangeError(`readRange: short read (${buffer.byteLength} of ${length} bytes)`);
    }
    return buffer;
  }
  const response = await fetch(source.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
  if (response.status !== 206) {
    throw new Error(`readRange: the server did not honour a byte range (HTTP ${response.status})`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== length) {
    throw new RangeError(`readRange: short read (${buffer.byteLength} of ${length} bytes)`);
  }
  return buffer;
}
