// render.ts — image planes to pixels. Every channel goes through its own lookup: the plane's
// values are divided by the channel's full scale (a per-file figure the service measures), then
// stretched between the channel's black and white points, then raised to its gamma, and the
// composite adds the enabled channels' colours. A single channel renders the same way in grey or
// in its tint. No DOM here: the output is RGBA bytes a worker turns into an ImageBitmap.

import type { ImagePlanes } from "./cvwDecode";
import { hexToRgb, type ChannelDisplay } from "./imageWallSettings";

export interface RenderSpec {
  readonly display: readonly ChannelDisplay[];
  /** Full-scale value per slot (slot → scale); a plane value at the scale maps to 1. */
  readonly scale: Readonly<Record<number, number>>;
  /** A multiplier on every channel, 1 by default. */
  readonly exposure: number;
}

/** A string that changes whenever the same planes would render differently. */
export function renderKey(spec: RenderSpec, hop: number): string {
  const channels = spec.display
    .map((d) => `${d.slot}:${d.enabled ? 1 : 0}:${d.colour}:${d.threshold}:${d.saturation}:${d.gamma}:${d.smoothing}:${spec.scale[d.slot] ?? 1}`)
    .join("|");
  return `h${hop}|e${spec.exposure}|${channels}`;
}

const LUT_SIZE = 4096;

/** The lookup for one channel: a normalised value (0..1 of full scale) → 0..1 brightness. */
function buildLut(display: ChannelDisplay): Float32Array {
  const lut = new Float32Array(LUT_SIZE + 1);
  const lo = display.threshold;
  const hi = Math.max(display.saturation, lo + 1e-6);
  const invGamma = 1 / display.gamma;
  for (let i = 0; i <= LUT_SIZE; i++) {
    const v = i / LUT_SIZE;
    let t = (v - lo) / (hi - lo);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    lut[i] = display.gamma === 1 ? t : Math.pow(t, invGamma);
  }
  return lut;
}

/** Box blur of radius `radius` (in pixels, separable), in place via a scratch buffer. */
export function boxBlur(plane: Float32Array, rows: number, cols: number, radius: number): Float32Array {
  if (radius <= 0 || rows === 0 || cols === 0) return plane;
  const tmp = new Float32Array(plane.length);
  const out = new Float32Array(plane.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      let n = 0;
      for (let d = -radius; d <= radius; d++) {
        const cc = c + d;
        if (cc >= 0 && cc < cols) { sum += plane[r * cols + cc]; n++; }
      }
      tmp[r * cols + c] = sum / n;
    }
  }
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      let sum = 0;
      let n = 0;
      for (let d = -radius; d <= radius; d++) {
        const rr = r + d;
        if (rr >= 0 && rr < rows) { sum += tmp[rr * cols + c]; n++; }
      }
      out[r * cols + c] = sum / n;
    }
  }
  return out;
}

/** Brightness 0..1 per pixel for one plane under its display settings. */
export function channelBrightness(
  plane: Float32Array,
  rows: number,
  cols: number,
  display: ChannelDisplay,
  scale: number,
  exposure: number,
): Float32Array {
  const lut = buildLut(display);
  const smoothed = display.smoothing > 1 ? boxBlur(plane, rows, cols, display.smoothing - 1) : plane;
  const out = new Float32Array(plane.length);
  const gain = exposure / (scale > 0 ? scale : 1);
  for (let i = 0; i < plane.length; i++) {
    let v = smoothed[i] * gain;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    out[i] = lut[Math.round(v * LUT_SIZE)];
  }
  return out;
}

/** The composite of the enabled channels, as RGBA bytes (`rows × cols × 4`). */
export function compositeRgba(planes: ImagePlanes, spec: RenderSpec): Uint8ClampedArray {
  const { rows, cols } = planes;
  const acc = new Float32Array(rows * cols * 3);
  for (const display of spec.display) {
    if (!display.enabled) continue;
    const at = planes.slots.indexOf(display.slot);
    if (at < 0) continue;
    const bright = channelBrightness(planes.planes[at], rows, cols, display, spec.scale[display.slot] ?? 1, spec.exposure);
    const [r, g, b] = hexToRgb(display.colour);
    for (let i = 0; i < bright.length; i++) {
      const t = bright[i];
      acc[i * 3] += t * r;
      acc[i * 3 + 1] += t * g;
      acc[i * 3 + 2] += t * b;
    }
  }
  const rgba = new Uint8ClampedArray(rows * cols * 4);
  for (let i = 0; i < rows * cols; i++) {
    rgba[i * 4] = acc[i * 3];
    rgba[i * 4 + 1] = acc[i * 3 + 1];
    rgba[i * 4 + 2] = acc[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** One channel on its own, tinted with its colour (or grey when `tint` is false). */
export function channelRgba(planes: ImagePlanes, spec: RenderSpec, slot: number, tint = true): Uint8ClampedArray {
  const { rows, cols } = planes;
  const rgba = new Uint8ClampedArray(rows * cols * 4);
  const at = planes.slots.indexOf(slot);
  const display = spec.display.find((d) => d.slot === slot);
  if (at < 0 || !display) return rgba;
  const bright = channelBrightness(planes.planes[at], rows, cols, display, spec.scale[slot] ?? 1, spec.exposure);
  const [r, g, b] = tint ? hexToRgb(display.colour) : [255, 255, 255];
  for (let i = 0; i < bright.length; i++) {
    const t = bright[i];
    rgba[i * 4] = t * r;
    rgba[i * 4 + 1] = t * g;
    rgba[i * 4 + 2] = t * b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * The full-scale value of each plane in a set of decoded events: a high percentile of every
 * pixel, so one bright pixel does not set the scale and the cells of a file are comparable,
 * but never below several times the median. A channel with no cells positive is all noise, and
 * a percentile of noise would stretch that noise to full brightness; the magnitude of noise
 * has its 99.9th percentile about three times its median, so a floor of twenty medians keeps an
 * empty channel dark (its brightest noise at a fifth of the white point) while a channel with
 * real signal, which is tens of times its noise, clears it easily.
 */
export function measureScale(
  events: readonly ImagePlanes[],
  percentile = 0.999,
  noiseFloorMedians = 20,
  /** Slots whose background is their signal (transmitted light): the percentile alone sets them. */
  noFloorSlots: readonly number[] = [],
): Record<number, number> {
  const scale: Record<number, number> = {};
  if (events.length === 0) return scale;
  const slots = events[0].slots;
  for (let s = 0; s < slots.length; s++) {
    let total = 0;
    for (const e of events) total += e.planes[s]?.length ?? 0;
    const all = new Float32Array(total);
    let at = 0;
    for (const e of events) {
      const plane = e.planes[s];
      if (!plane) continue;
      all.set(plane, at);
      at += plane.length;
    }
    all.sort();
    const high = all.length ? all[Math.min(all.length - 1, Math.floor(percentile * all.length))] : 1;
    const median = all.length ? all[Math.floor(all.length / 2)] : 0;
    const value = noFloorSlots.includes(slots[s]) ? high : Math.max(high, noiseFloorMedians * median);
    scale[slots[s]] = value > 0 ? value : 1;
  }
  return scale;
}
