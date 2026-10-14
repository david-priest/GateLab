// wallBins.ts — the distribution of the wall's sort channel over its cells, so the wall can
// show where its tiles sit and be limited to a range of values. Pure: the Images tab hands it the
// channel's display column and the events on the wall; the component draws what comes back.

export interface WallHistogram {
  /** Cells per bin, left to right over [lo, hi]. */
  readonly counts: Uint32Array;
  readonly lo: number;
  readonly hi: number;
  /** Finite values binned. */
  readonly total: number;
  readonly peak: number;
}

/** The finite span of `column` over `events`, or null when nothing finite is there. */
export function valueSpan(column: Float32Array, events: ArrayLike<number>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < events.length; k++) {
    const v = column[events[k]];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}

/** `bins` equal bins over the events' span; null when there is nothing to bin. A single value makes one full bin. */
export function wallHistogram(column: Float32Array, events: ArrayLike<number>, bins = 64): WallHistogram | null {
  const span = valueSpan(column, events);
  if (!span) return null;
  let [lo, hi] = span;
  if (hi === lo) { lo -= 0.5; hi += 0.5; }
  const counts = new Uint32Array(Math.max(1, bins));
  const width = (hi - lo) / counts.length;
  let total = 0;
  for (let k = 0; k < events.length; k++) {
    const v = column[events[k]];
    if (!Number.isFinite(v)) continue;
    let b = Math.floor((v - lo) / width);
    if (b >= counts.length) b = counts.length - 1;
    if (b < 0) b = 0;
    counts[b]++;
    total++;
  }
  let peak = 0;
  for (const c of counts) if (c > peak) peak = c;
  return { counts, lo, hi, total, peak };
}

/** The events whose value lies in [lo, hi], in the order given. */
export function eventsInRange(column: Float32Array, events: Int32Array, lo: number, hi: number): Int32Array {
  const out = new Int32Array(events.length);
  let k = 0;
  for (let i = 0; i < events.length; i++) {
    const v = column[events[i]];
    if (v >= lo && v <= hi) out[k++] = events[i];
  }
  return out.subarray(0, k);
}

/** A value for a label: three significant figures, exponent form outside 0.001..1e6. */
export function formatWallValue(v: number): string {
  if (!Number.isFinite(v)) return "–";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-3) return v.toExponential(2).replace(/\.?0+e/, "e");
  const digits = Math.max(0, 2 - Math.floor(Math.log10(a)));
  return v.toFixed(Math.min(6, digits)).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}
