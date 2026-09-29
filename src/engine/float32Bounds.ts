/**
 * A rectangle's display-space edge as the raw-value edge that selects exactly the same events.
 *
 * GateLab evaluates a display-space gate on a float32 column: an event's display value is
 * fround(forward(raw)). Mapping the bound through the inverse transform gives a raw bound that
 * is right to about 1e-16 of itself, but the events on the edge are the ones whose display value
 * ROUNDS to it, and their raw values sit on either side of the inverse. Because
 * fround(forward(r)) never decreases as r increases, each edge nonetheless has an exact raw
 * equivalent: a raw value, found here by search over the values the raw column can hold, in
 * order, such that comparing raw values selects the same events. A file that can only state a
 * rectangle in raw units (the hierarchy CSV, for a scale it cannot name) writes that value, and
 * the rectangle comes back holding the same events, the ones on its edges included.
 *
 * The raw column is not always float32. GateLab holds a $DATATYPE D file, a log-amplified
 * channel after decoding (fcs.ts, decodeLogAmplification) and an integer channel wider than 32
 * bits as float64, and a 32-bit integer channel as integers up to 2^32, which float32 cannot
 * hold above 2^24. Between two neighbouring float32 values such a column holds many values, and
 * the display rounding can divide them, so a float32 threshold selects the wrong ones. The search
 * therefore runs over the column's own values: float32 for a float32 column, every double
 * otherwise (`RawPrecision`).
 */

import type { RectangleBounds } from "./models";

/**
 * The values a raw column can hold: "float32" for a Float32Array, "float64" for anything else
 * (a Float64Array, or integers beyond float32's 2^24). Every float32 value is also a double, so
 * "float64" is right for any column; "float32" is the narrower search where it applies.
 */
export type RawPrecision = "float32" | "float64";

interface KeySpace {
  /** The value's position in order: -0 and +0 share 0, and adjacent keys are adjacent values. */
  key(x: number): bigint;
  value(k: bigint): number;
  /** The key of the largest finite value; its negation is the smallest. */
  maxKey: bigint;
  /** The value rounded to the nearest one this space holds, clamped to its finite range. */
  nearest(x: number): number;
}

const F32 = new Float32Array(1);
const I32 = new Int32Array(F32.buffer);
const F64 = new Float64Array(1);
const I64 = new BigInt64Array(F64.buffer);
const SIGN64 = 1n << 63n;
const MAG64 = SIGN64 - 1n;

const SPACES: Record<RawPrecision, KeySpace> = {
  float32: {
    key(x) {
      F32[0] = x;
      const b = I32[0];
      return BigInt(b >= 0 ? b : -(b & 0x7fffffff));
    },
    value(k) {
      const n = Number(k);
      I32[0] = n >= 0 ? n : (-n | 0x80000000);
      return F32[0];
    },
    maxKey: 0x7f7fffffn,
    nearest: (x) => Math.fround(Math.max(-3.4e38, Math.min(3.4e38, x))),
  },
  float64: {
    key(x) {
      F64[0] = x;
      const b = I64[0];
      return b >= 0n ? b : -(b & MAG64);
    },
    value(k) {
      I64[0] = k >= 0n ? k : BigInt.asIntN(64, -k | SIGN64);
      return F64[0];
    },
    maxKey: 0x7fefffffffffffffn,
    nearest: (x) => Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, x)),
  },
};

/**
 * The smallest key in [-maxKey, maxKey] where `pred` holds, `pred` being false below some key
 * and true from it on; maxKey + 1 when it holds nowhere. Searched outward from `start`.
 */
function smallestKey(pred: (k: bigint) => boolean, start: bigint, maxKey: bigint): bigint {
  const clamp = (k: bigint): bigint => (k < -maxKey ? -maxKey : k > maxKey ? maxKey : k);
  const k0 = clamp(start);
  let lo: bigint;
  let hi: bigint;
  if (pred(k0)) {
    hi = k0;
    let step = 1n;
    for (;;) {
      const k = clamp(hi - step);
      if (!pred(k)) { lo = k; break; }
      if (k === -maxKey) return -maxKey;
      hi = k;
      step *= 2n;
    }
  } else {
    lo = k0;
    let step = 1n;
    for (;;) {
      const k = clamp(lo + step);
      if (pred(k)) { hi = k; break; }
      if (k === maxKey) return maxKey + 1n;
      lo = k;
      step *= 2n;
    }
  }
  // pred(lo) is false and pred(hi) true.
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if (pred(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export interface MonotoneTransform {
  forward(v: number): number;
  inverse(v: number): number;
}

/**
 * The raw interval that selects, on a raw column of the given precision, exactly the events
 * whose display value fround(t.forward(raw)) lies in [lo, hi] (closed) or [lo, hi) (half-open).
 * Returned as bounds under the SAME rule: closed gives [rawLo, rawHi], half-open [rawLo, rawHi).
 */
export function exactRawRange(
  t: MonotoneTransform,
  lo: number,
  hi: number,
  bounds: RectangleBounds,
  precision: RawPrecision,
): [number, number] {
  const space = SPACES[precision];
  const display = (k: bigint): number => Math.fround(t.forward(space.value(k)));
  const near = (v: number): bigint => {
    const r = t.inverse(v);
    if (Number.isFinite(r)) return space.key(space.nearest(r));
    return r > 0 ? space.maxKey : -space.maxKey;
  };
  const rawLo = smallestKey((k) => display(k) >= lo, near(lo), space.maxKey);
  const rawHi = bounds === "half-open"
    ? smallestKey((k) => display(k) >= hi, near(hi), space.maxKey)
    : smallestKey((k) => display(k) > hi, near(hi), space.maxKey) - 1n;
  // Kept finite, so a file can state it: no event lies beyond the largest finite value.
  const value = (k: bigint): number => space.value(k < -space.maxKey ? -space.maxKey : k > space.maxKey ? space.maxKey : k);
  return [value(rawLo), value(rawHi)];
}

/**
 * The next value above x that a raw column of the given precision can hold, x itself at the
 * largest finite value. Turns a closed range's upper end into a half-open one's: [lo, hi] and
 * [lo, next(hi)) hold the same values of such a column.
 */
export function nextRawValue(x: number, precision: RawPrecision): number {
  const space = SPACES[precision];
  const k = space.key(x) + 1n;
  return space.value(k > space.maxKey ? space.maxKey : k);
}
