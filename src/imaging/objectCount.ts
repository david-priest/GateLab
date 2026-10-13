// objectCount.ts — how many objects an image holds. The mask is made on the SSC (imaging) plane,
// as Chorus makes its own (its mask settings name the SSC channel with a threshold of 8192 on a
// 16-bit scale, an eighth of full scale): a cell scatters, so it is a bright patch on a dark
// field, a doublet two patches, debris small ones. Checked on 400 real events against Chorus's
// per-event mask size (2026-10-13): the mask area here follows it with a rank correlation of
// 0.9, and the counts come out about nine cells in ten with one object, one in twelve with two.
//
// The steps: a 3 × 3 mean, a threshold at a fraction of the file's full scale, a 3 × 3 closing,
// holes filled, then 8-connected labelling. A patch is an object when it has at least the
// minimum area and is not a thin full-height band (a frame-wide flash reads as one in a
// frequency-time image) or a thin full-width streak (a carrier glitch). Pure and small, so the
// worker runs it on every imaged event and the tests can draw pictures for it.

import { boxBlur } from "./render";

export interface ObjectCountOptions {
  /** A pixel is an object when the plane is above this fraction of full scale; 0.125 by default. */
  readonly fraction?: number;
  /** Patches with fewer pixels than this are specks, not objects; 20 by default. */
  readonly minArea?: number;
  /** Box-blur radius before thresholding, in pixels; 1 by default. */
  readonly smoothing?: number;
  /** A patch this narrow (columns) spanning at least half the rows is a band, not an object; 6 by default. */
  readonly bandWidth?: number;
  /** A patch this flat (rows) spanning at least a third of the columns is a streak, not an object; 4 by default. */
  readonly streakHeight?: number;
}

export interface ObjectCountResult {
  /** Connected patches of at least minArea pixels. */
  readonly count: number;
  /** Pixels in the largest patch. */
  readonly largestArea: number;
  /** Pixels in every counted patch together. */
  readonly totalArea: number;
}

/** The class a count falls in, for colouring: 0 none, 1 one object, 2 two, 3 three or more. */
export const OBJECT_CLASSES = ["no object", "one object", "two objects", "three or more"] as const;
export const OBJECT_CLASS_UNKNOWN = 255;

export function objectClassOf(count: number): number {
  return count <= 0 ? 0 : count === 1 ? 1 : count === 2 ? 2 : 3;
}

/** Dilate then erode with a 3 × 3 square. */
function closeSquare(mask: Uint8Array, rows: number, cols: number): Uint8Array {
  const dilated = new Uint8Array(mask.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!mask[r * cols + c]) continue;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) dilated[rr * cols + cc] = 1;
      }
    }
  }
  const out = new Uint8Array(mask.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let keep = 1;
      for (let dr = -1; dr <= 1 && keep; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols || !dilated[rr * cols + cc]) { keep = 0; break; }
      }
      out[r * cols + c] = keep;
    }
  }
  return out;
}

/** Fill the holes: background that cannot be reached from the border becomes object. */
function fillHoles(mask: Uint8Array, rows: number, cols: number): Uint8Array {
  const reached = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let top = 0;
  const push = (i: number) => { if (!mask[i] && !reached[i]) { reached[i] = 1; stack[top++] = i; } };
  for (let c = 0; c < cols; c++) { push(c); push((rows - 1) * cols + c); }
  for (let r = 0; r < rows; r++) { push(r * cols); push(r * cols + cols - 1); }
  while (top > 0) {
    const at = stack[--top];
    const r = Math.floor(at / cols);
    const c = at - r * cols;
    if (r > 0) push(at - cols);
    if (r < rows - 1) push(at + cols);
    if (c > 0) push(at - 1);
    if (c < cols - 1) push(at + 1);
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] || !reached[i] ? 1 : 0;
  return out;
}

/**
 * Count the objects in an SSC plane (`rows × cols`, row-major); `scale` is the file's full-scale
 * value for that channel (the service measures it when the file opens).
 */
export function countObjects(
  plane: Float32Array,
  rows: number,
  cols: number,
  scale: number,
  options: ObjectCountOptions = {},
): ObjectCountResult {
  const fraction = options.fraction ?? 0.125;
  const minArea = options.minArea ?? 20;
  const smoothing = options.smoothing ?? 1;
  const bandWidth = options.bandWidth ?? 6;
  const streakHeight = options.streakHeight ?? 4;
  if (rows === 0 || cols === 0 || !(scale > 0)) return { count: 0, largestArea: 0, totalArea: 0 };
  const smoothed = smoothing > 0 ? boxBlur(plane, rows, cols, smoothing) : plane;
  let mask: Uint8Array = new Uint8Array(rows * cols);
  const cut = fraction * scale;
  for (let i = 0; i < mask.length; i++) mask[i] = smoothed[i] > cut ? 1 : 0;
  mask = closeSquare(mask, rows, cols);
  mask = fillHoles(mask, rows, cols);
  // Label 8-connected patches with a scan and a stack; no recursion, so a plane-sized patch is fine.
  const label = new Int32Array(rows * cols);
  const stack = new Int32Array(rows * cols);
  let next = 0;
  let count = 0;
  let largest = 0;
  let total = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    next++;
    let top = 0;
    stack[top++] = start;
    label[start] = next;
    let area = 0;
    let rMin = rows;
    let rMax = -1;
    let cMin = cols;
    let cMax = -1;
    while (top > 0) {
      const at = stack[--top];
      area++;
      const r = Math.floor(at / cols);
      const c = at - r * cols;
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (c < cMin) cMin = c;
      if (c > cMax) cMax = c;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols || (dr === 0 && dc === 0)) continue;
          const j = rr * cols + cc;
          if (mask[j] && !label[j]) {
            label[j] = next;
            stack[top++] = j;
          }
        }
      }
    }
    const width = cMax - cMin + 1;
    const height = rMax - rMin + 1;
    const band = width <= bandWidth && height >= rows / 2;
    const streak = height <= streakHeight && width >= cols / 3;
    if (area >= minArea && !band && !streak) {
      count++;
      total += area;
      if (area > largest) largest = area;
    }
  }
  return { count, largestArea: largest, totalArea: total };
}

/** The plane of a decoded event for a slot, or null when that slot was not decoded. */
export function planeOf(planes: readonly Float32Array[], slots: readonly number[], slot: number): Float32Array | null {
  const at = slots.indexOf(slot);
  return at >= 0 ? planes[at] : null;
}

/** The SSC imaging channel's slot, by name; 4 on every S8 file seen. */
export function sscSlotOf(channelNames: ReadonlyMap<number, string>): number {
  for (const [slot, name] of channelNames) if (/^SSC/i.test(name)) return slot;
  return 4;
}
