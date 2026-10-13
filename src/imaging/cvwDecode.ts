// cvwDecode.ts — turn one event's waveform block into image planes.
//
// The S8 images a cell by FIRE (fluorescence imaging using radiofrequency-tagged emission): the
// excitation line is a comb of beamlets, each modulated at its own radio frequency, so one
// detector's time signal carries every row of the image at once, row k on carrier k, and the
// cell's passage through the line spreads the columns out in time. A block holds that signal
// for 8 detectors as interleaved 16-bit samples (channel 0 and 1 unused, 2 LightLoss, 3 FSC,
// 4 SSC, 5–7 fluorescence), followed by one 4096-byte trailer page:
//
//   u32 0xBDBDBDBD, u32 8 (channels), u32 256 (frame), u32 dataPages, u32 eventId, …
//
// so the sample count is dataPages × 4096 / 16. The image is a short-time Fourier transform:
// 256-sample frames stepped by `hop`, and in each frame the magnitude at bins 15..118 is one
// column of 104 rows (the carriers sit on exactly those bins on every file checked; the
// reference-beam spectrum in the metadata confirms them). The frame is rectangular, not
// windowed: the carriers are one bin apart and exactly periodic in 256 samples, so a plain DFT
// separates them, whereas a Hann window leaks each row into its neighbours at half amplitude.
//
// Checked against the TIFFs BD's own CellView Image Extractor writes (2026-10-13, two tubes):
// BD's image is 104 carriers by one column per 64 samples from the block's first sample, with
// no window and no offset, so hop 64 is the native resolution (NATIVE_HOP) and the file's
// pixelAspectRatio of 0.3, which is for a 16-sample pitch, becomes 1.2 at that hop (BD's TIFF
// resolution tags agree). Plain magnitude correlates with BD's FSC and SSC planes at 0.83 and
// 0.91; BD's values are signed, so its demodulation is coherent, and the metadata's phasors are
// what a later version would use to close that gap. BD's LightLoss plane is transmitted light,
// bright where the beam passes and dark where the cell is, and is shown that way here.

import type { CvwMetadata } from "./cvw";

export const CVW_FRAME = 256;
export const CVW_CHANNELS = 8;
export const CVW_PAGE_BYTES = 4096;
export const CVW_BYTES_PER_SAMPLE = CVW_CHANNELS * 2;
export const CARRIER_FIRST_BIN = 15;
export const CARRIER_LAST_BIN = 118;
export const IMAGE_ROWS = CARRIER_LAST_BIN - CARRIER_FIRST_BIN + 1; // 104
/** One column per 64 samples: the resolution BD's own extractor writes. */
export const NATIVE_HOP = 64;
const TRAILER_MAGIC = 0xbdbdbdbd;

/** The channel slots that carry an image, in slot order. */
export const IMAGE_CHANNEL_SLOTS: readonly number[] = [2, 3, 4, 5, 6, 7];

export interface ImagePlanes {
  readonly rows: number;
  readonly cols: number;
  /** One plane per entry of `slots`, row-major (`rows × cols`). */
  readonly planes: readonly Float32Array[];
  /** The channel slot each plane came from. */
  readonly slots: readonly number[];
  /** Column pitch over row pitch: draw a plane `cols × aspect` wide for a true-shape image. */
  readonly aspect: number;
}

export interface BlockTrailer {
  readonly channels: number;
  readonly frame: number;
  readonly dataPages: number;
  readonly eventId: number;
  /** Samples (per channel) in the block. */
  readonly sampleCount: number;
}

/** Read the trailer page at the end of a block. */
export function parseBlockTrailer(block: ArrayBufferLike): BlockTrailer {
  if (block.byteLength < CVW_PAGE_BYTES || block.byteLength % CVW_PAGE_BYTES !== 0) {
    throw new Error(`cvw: a block of ${block.byteLength} bytes is not a whole number of pages`);
  }
  const view = new DataView(block, block.byteLength - CVW_PAGE_BYTES, 32);
  if (view.getUint32(0, true) !== TRAILER_MAGIC) throw new Error("cvw: the block has no trailer");
  const channels = view.getUint32(4, true);
  const frame = view.getUint32(8, true);
  const dataPages = view.getUint32(12, true);
  const eventId = view.getUint32(16, true);
  if (channels !== CVW_CHANNELS || frame !== CVW_FRAME) {
    throw new Error(`cvw: a block with ${channels} channels and ${frame}-sample frames is not one GateLab decodes`);
  }
  if ((dataPages + 1) * CVW_PAGE_BYTES !== block.byteLength) {
    throw new Error(`cvw: the trailer says ${dataPages} data pages but the block has ${block.byteLength / CVW_PAGE_BYTES - 1}`);
  }
  return { channels, frame, dataPages, eventId, sampleCount: (dataPages * CVW_PAGE_BYTES) / CVW_BYTES_PER_SAMPLE };
}

// ── A 256-point real FFT ────────────────────────────────────────────────────────────────────
// Iterative radix-2 on the complex spectrum with the twiddles and bit-reversal table built once.
// Only the magnitudes of bins CARRIER_FIRST_BIN..CARRIER_LAST_BIN are ever taken.

const N = CVW_FRAME;
const LOG2N = 8;
const bitReverse = new Uint16Array(N);
for (let i = 0; i < N; i++) {
  let r = 0;
  for (let b = 0; b < LOG2N; b++) r |= ((i >> b) & 1) << (LOG2N - 1 - b);
  bitReverse[i] = r;
}
const cosTable = new Float32Array(N / 2);
const sinTable = new Float32Array(N / 2);
for (let k = 0; k < N / 2; k++) {
  cosTable[k] = Math.cos((-2 * Math.PI * k) / N);
  sinTable[k] = Math.sin((-2 * Math.PI * k) / N);
}
/**
 * In-place complex FFT of `re`/`im` (length 256). After the call, bin k is (re[k], im[k]).
 * Exported for the tests, which feed it known sinusoids.
 */
export function fft256(re: Float32Array, im: Float32Array): void {
  for (let i = 0; i < N; i++) {
    const j = bitReverse[i];
    if (j > i) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cosTable[k * step];
        const wi = sinTable[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

/** The number of columns a signal of `sampleCount` samples yields at `hop`. */
export function stftColumns(sampleCount: number, hop: number): number {
  return sampleCount < N ? 0 : Math.floor((sampleCount - N) / hop) + 1;
}

/**
 * One channel's image: the carrier-bin magnitudes of successive frames. `samples` is read
 * with the stride of the interleaved block (`stride` = 8, `first` = the channel slot). Returns a
 * row-major plane of IMAGE_ROWS × columns.
 */
export function stftPlane(
  samples: Uint16Array,
  first: number,
  stride: number,
  sampleCount: number,
  hop: number,
  out?: Float32Array,
): Float32Array {
  const cols = stftColumns(sampleCount, hop);
  const plane = out ?? new Float32Array(IMAGE_ROWS * cols);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let c = 0; c < cols; c++) {
    const base = c * hop;
    let mean = 0;
    for (let i = 0; i < N; i++) mean += samples[(base + i) * stride + first];
    mean /= N;
    for (let i = 0; i < N; i++) {
      re[i] = samples[(base + i) * stride + first] - mean;
      im[i] = 0;
    }
    fft256(re, im);
    for (let k = CARRIER_FIRST_BIN; k <= CARRIER_LAST_BIN; k++) {
      plane[(k - CARRIER_FIRST_BIN) * cols + c] = Math.hypot(re[k], im[k]);
    }
  }
  return plane;
}

/**
 * LightLoss is the transmitted beam: every carrier arrives at full strength and a cell takes
 * light away, so the picture is bright where nothing is and darker where the cell is, as BD
 * shows it. Each row is scaled by its own level in the empty columns at the block's edges, which
 * also absorbs the carrier's strength (the |refPhasor| the metadata records), so the background
 * reads 1 on every row and a cell reads below it.
 */
export function lightLossPlane(plane: Float32Array, cols: number): Float32Array {
  const out = new Float32Array(plane.length);
  // Background: the mean transmitted level per row over the outer 10% of columns on each side.
  const edge = Math.max(1, Math.floor(cols * 0.1));
  for (let r = 0; r < IMAGE_ROWS; r++) {
    let sum = 0;
    let n = 0;
    for (let c = 0; c < edge; c++) { sum += plane[r * cols + c]; n++; }
    for (let c = cols - edge; c < cols; c++) { sum += plane[r * cols + c]; n++; }
    const background = n > 0 && sum > 0 ? sum / n : 1;
    for (let c = 0; c < cols; c++) out[r * cols + c] = plane[r * cols + c] / background;
  }
  return out;
}

export interface DecodeOptions {
  /** Frame step in samples: NATIVE_HOP (64) is BD's resolution; smaller steps give more columns. */
  readonly hop: number;
  /** Which channel slots to decode; defaults to every image channel. */
  readonly slots?: readonly number[];
}

/** Decode one event's block into planes for the requested channel slots. */
export function decodeEvent(block: ArrayBufferLike, metadata: CvwMetadata, options: DecodeOptions): ImagePlanes {
  const trailer = parseBlockTrailer(block);
  const hop = Math.max(1, Math.floor(options.hop));
  const slots = options.slots ?? IMAGE_CHANNEL_SLOTS;
  const samples = new Uint16Array(block, 0, trailer.sampleCount * CVW_CHANNELS);
  const cols = stftColumns(trailer.sampleCount, hop);
  const laser = metadata.lasers[0];
  const planes = slots.map((slot) => {
    const plane = stftPlane(samples, slot, CVW_CHANNELS, trailer.sampleCount, hop);
    return slot === laser.lightlossIndex ? lightLossPlane(plane, cols) : plane;
  });
  // The metadata's aspect is for hop 16 (the native column pitch); a larger hop widens the
  // column pitch in proportion.
  const aspect = laser.pixelAspectRatio * (hop / 16);
  return { rows: IMAGE_ROWS, cols, planes, slots, aspect };
}
