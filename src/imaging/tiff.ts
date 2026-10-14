// tiff.ts — a small reader for the TIFF files BD's CellView Image Extractor writes: one page per
// image channel, named by the PageName tag, 32-bit floats (or 8- and 16-bit integers) in one or
// more uncompressed strips, either byte order. Enough for those files and the plain baseline
// layouts around them; a compressed or tiled file is refused with a message that says so.

export interface TiffPage {
  readonly width: number;
  readonly height: number;
  /** The PageName tag, or the ImageDescription, or "". */
  readonly name: string;
  /** Row-major `height × width`, as floats whatever the file's sample type. */
  readonly data: Float32Array;
  /** X and Y resolution as written (pixels per unit), when the file carries them. */
  readonly xResolution?: number;
  readonly yResolution?: number;
}

const TAG = {
  width: 256, height: 257, bitsPerSample: 258, compression: 259, imageDescription: 270, stripOffsets: 273,
  samplesPerPixel: 277, rowsPerStrip: 278, stripByteCounts: 279, xResolution: 282, yResolution: 283,
  planarConfiguration: 284, pageName: 285, tileWidth: 322, sampleFormat: 339,
} as const;

const TYPE_SIZE: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

interface Entry { readonly type: number; readonly count: number; readonly at: number }

export class TiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TiffError";
  }
}

/** The pages of a TIFF, in file order. */
export function readTiffPages(buffer: ArrayBufferLike): TiffPage[] {
  const view = new DataView(buffer as ArrayBuffer);
  if (view.byteLength < 8) throw new TiffError("not a TIFF: the file is too short");
  const order = String.fromCharCode(view.getUint8(0), view.getUint8(1));
  const little = order === "II";
  if (!little && order !== "MM") throw new TiffError("not a TIFF: no byte-order mark");
  if (view.getUint16(2, little) !== 42) throw new TiffError(view.getUint16(2, little) === 43 ? "a BigTIFF, which is not read" : "not a TIFF: the magic number is wrong");
  const pages: TiffPage[] = [];
  let offset = view.getUint32(4, little);
  const seen = new Set<number>();
  while (offset > 0 && !seen.has(offset) && pages.length < 64) {
    seen.add(offset);
    if (offset + 2 > view.byteLength) throw new TiffError("the TIFF's directory lies past the end of the file");
    const count = view.getUint16(offset, little);
    const entries = new Map<number, Entry>();
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      if (at + 12 > view.byteLength) throw new TiffError("the TIFF's directory is cut short");
      const tag = view.getUint16(at, little);
      const type = view.getUint16(at + 2, little);
      const n = view.getUint32(at + 4, little);
      const size = (TYPE_SIZE[type] ?? 1) * n;
      entries.set(tag, { type, count: n, at: size <= 4 ? at + 8 : view.getUint32(at + 8, little) });
    }
    pages.push(readPage(view, little, entries));
    offset = view.getUint32(offset + 2 + count * 12, little);
  }
  if (pages.length === 0) throw new TiffError("the TIFF holds no image");
  return pages;
}

function readPage(view: DataView, little: boolean, entries: Map<number, Entry>): TiffPage {
  const numbers = (tag: number): number[] => {
    const entry = entries.get(tag);
    if (!entry) return [];
    const out: number[] = [];
    for (let i = 0; i < entry.count; i++) {
      const at = entry.at + i * (TYPE_SIZE[entry.type] ?? 1);
      if (entry.type === 3) out.push(view.getUint16(at, little));
      else if (entry.type === 4) out.push(view.getUint32(at, little));
      else if (entry.type === 1) out.push(view.getUint8(at));
      else if (entry.type === 5) { const num = view.getUint32(at, little); const den = view.getUint32(at + 4, little); out.push(den ? num / den : 0); }
      else if (entry.type === 11) out.push(view.getFloat32(at, little));
      else if (entry.type === 12) out.push(view.getFloat64(at, little));
      else if (entry.type === 16) out.push(Number(view.getBigUint64(at, little)));
      else out.push(0);
    }
    return out;
  };
  const text = (tag: number): string => {
    const entry = entries.get(tag);
    if (!entry || entry.type !== 2) return "";
    let s = "";
    for (let i = 0; i < entry.count; i++) {
      const c = view.getUint8(entry.at + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  };
  const width = numbers(TAG.width)[0] ?? 0;
  const height = numbers(TAG.height)[0] ?? 0;
  if (!(width > 0) || !(height > 0)) throw new TiffError("the TIFF page has no size");
  if (entries.has(TAG.tileWidth)) throw new TiffError("a tiled TIFF, which is not read");
  const compression = numbers(TAG.compression)[0] ?? 1;
  if (compression !== 1) throw new TiffError(`a compressed TIFF (compression ${compression}), which is not read`);
  const samplesPerPixel = numbers(TAG.samplesPerPixel)[0] ?? 1;
  if (samplesPerPixel !== 1) throw new TiffError(`a TIFF with ${samplesPerPixel} samples per pixel, which is not read; one channel per page is`);
  const bits = numbers(TAG.bitsPerSample)[0] ?? 8;
  const format = numbers(TAG.sampleFormat)[0] ?? 1;
  const offsets = numbers(TAG.stripOffsets);
  const counts = numbers(TAG.stripByteCounts);
  if (offsets.length === 0) throw new TiffError("the TIFF page has no strips");
  const bytesPerSample = bits / 8;
  if (![1, 2, 4].includes(bytesPerSample)) throw new TiffError(`a TIFF with ${bits}-bit samples, which is not read`);
  if (format === 3 && bits !== 32) throw new TiffError(`a TIFF with ${bits}-bit floats, which is not read`);
  const data = new Float32Array(width * height);
  let k = 0;
  for (let s = 0; s < offsets.length && k < data.length; s++) {
    const bytes = counts[s] ?? (data.length - k) * bytesPerSample;
    const n = Math.min(Math.floor(bytes / bytesPerSample), data.length - k);
    const at = offsets[s];
    if (at + n * bytesPerSample > view.byteLength) throw new TiffError("the TIFF's strip lies past the end of the file");
    for (let i = 0; i < n; i++, k++) {
      const p = at + i * bytesPerSample;
      data[k] = format === 3 ? view.getFloat32(p, little)
        : bytesPerSample === 1 ? (format === 2 ? view.getInt8(p) : view.getUint8(p))
        : bytesPerSample === 2 ? (format === 2 ? view.getInt16(p, little) : view.getUint16(p, little))
        : (format === 2 ? view.getInt32(p, little) : view.getUint32(p, little));
    }
  }
  if (k < data.length) throw new TiffError("the TIFF's strips hold fewer samples than the page's size");
  const xres = numbers(TAG.xResolution)[0];
  const yres = numbers(TAG.yResolution)[0];
  return {
    width, height, data,
    name: text(TAG.pageName) || text(TAG.imageDescription),
    ...(xres ? { xResolution: xres } : {}),
    ...(yres ? { yResolution: yres } : {}),
  };
}

/** Write a TIFF of the given pages (float32, little-endian, one strip each): the test fixture, and nothing else needs it. */
export function writeTiffPages(pages: readonly { width: number; height: number; name?: string; data: Float32Array | Uint16Array | Uint8Array; xResolution?: number; yResolution?: number }[], big = false): Uint8Array {
  const little = !big;
  const parts: { entries: [number, number, number, Uint8Array | number][]; data: Uint8Array }[] = [];
  let total = 8;
  const layout: { dirAt: number; dataAt: number; extraAt: number; size: number }[] = [];
  const bytesPerSample = (d: Float32Array | Uint16Array | Uint8Array) => d.BYTES_PER_ELEMENT;
  for (const page of pages) {
    const name = page.name ?? "";
    const bps = bytesPerSample(page.data);
    const entryCount = 11 + (name ? 1 : 0) + (page.xResolution ? 2 : 0);
    const dirSize = 2 + entryCount * 12 + 4;
    const nameBytes = name ? name.length + 1 : 0;
    const resBytes = page.xResolution ? 16 : 0;
    const dataSize = page.width * page.height * bps;
    layout.push({ dirAt: total, dataAt: total + dirSize + nameBytes + resBytes, extraAt: total + dirSize, size: dirSize + nameBytes + resBytes + dataSize });
    total += dirSize + nameBytes + resBytes + dataSize;
    parts.push({ entries: [], data: new Uint8Array(0) });
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out[0] = little ? 0x49 : 0x4d; out[1] = out[0];
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  pages.forEach((page, p) => {
    const { dirAt, dataAt, extraAt } = layout[p];
    const name = page.name ?? "";
    const bps = bytesPerSample(page.data);
    const format = page.data instanceof Float32Array ? 3 : 1;
    const entries: [number, number, number, number][] = [
      [TAG.width, 4, 1, page.width], [TAG.height, 4, 1, page.height], [TAG.bitsPerSample, 3, 1, bps * 8], [TAG.compression, 3, 1, 1],
      [262, 3, 1, 1], [TAG.stripOffsets, 4, 1, dataAt], [TAG.samplesPerPixel, 3, 1, 1], [TAG.rowsPerStrip, 4, 1, page.height],
      [TAG.stripByteCounts, 4, 1, page.width * page.height * bps], [TAG.planarConfiguration, 3, 1, 1], [TAG.sampleFormat, 3, 1, format],
    ];
    let extra = extraAt;
    if (page.xResolution) {
      entries.push([TAG.xResolution, 5, 1, extra], [TAG.yResolution, 5, 1, extra + 8]);
      view.setUint32(extra, Math.round(page.xResolution * 65536), little); view.setUint32(extra + 4, 65536, little);
      view.setUint32(extra + 8, Math.round((page.yResolution ?? page.xResolution) * 65536), little); view.setUint32(extra + 12, 65536, little);
      extra += 16;
    }
    // A value of four bytes or fewer sits in the entry itself; a short name is written there.
    const inlineName = name.length + 1 <= 4;
    if (name) {
      entries.push([TAG.pageName, 2, name.length + 1, inlineName ? -1 : extra]);
      if (!inlineName) for (let i = 0; i < name.length; i++) out[extra + i] = name.charCodeAt(i) & 0xff;
    }
    entries.sort((a, b) => a[0] - b[0]);
    view.setUint16(dirAt, entries.length, little);
    entries.forEach(([tag, type, count, value], i) => {
      const at = dirAt + 2 + i * 12;
      view.setUint16(at, tag, little); view.setUint16(at + 2, type, little); view.setUint32(at + 4, count, little);
      if (tag === TAG.pageName && value === -1) { for (let j = 0; j < name.length; j++) out[at + 8 + j] = name.charCodeAt(j) & 0xff; }
      else if (type === 3 && count === 1) view.setUint16(at + 8, value, little); else view.setUint32(at + 8, value, little);
    });
    view.setUint32(dirAt + 2 + entries.length * 12, p + 1 < pages.length ? layout[p + 1].dirAt : 0, little);
    for (let i = 0; i < page.data.length; i++) {
      const at = dataAt + i * bps;
      if (format === 3) view.setFloat32(at, page.data[i], little);
      else if (bps === 2) view.setUint16(at, page.data[i], little);
      else out[at] = page.data[i];
    }
  });
  return out;
}
