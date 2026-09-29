// A display-space rectangle edge written as a raw value must select exactly the events the
// display-space edge does (float32Bounds.ts). Checked against brute force on every transform a
// gate can carry, with edges placed on events' own display values: over float32 raw values, and
// over the float64 and wide-integer raw values GateLab holds for a $DATATYPE D file, a decoded
// log-amplified channel or a 32-bit integer channel.
import { describe, expect, it } from "vitest";
import { exactRawRange, nextRawValue } from "./float32Bounds";
import { transformFromSpec } from "./sample";
import type { TransformSpec } from "./models";

const SPECS: Record<string, TransformSpec> = {
  arcsinh: { kind: "asinh", cofactor: 150 },
  logicle: { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 },
  biex: { kind: "biex", maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -10, channelRange: 256 },
  flog: { kind: "flog", T: 262144, M: 4.5 },
  wsplog: { kind: "wsplog", offset: 1, decades: 5 },
};

/** Every float32 in a few dense runs (consecutive floats) plus a wide spread. */
function rawValues(): Float32Array {
  const out: number[] = [];
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  for (const centre of [-300, -1, 0, 0.5, 1, 7, 1000, 12345.678, 100000, 250000]) {
    f[0] = centre;
    const c = u[0];
    for (let d = -40; d <= 40; d++) {
      u[0] = c + d;
      if (Number.isFinite(f[0])) out.push(f[0]);
    }
  }
  for (let k = -60; k <= 60; k++) out.push(Math.fround(Math.sign(k) * Math.pow(10, Math.abs(k) / 10)));
  return Float32Array.from(out);
}

describe("exactRawRange", () => {
  const raw = rawValues();
  for (const [name, spec] of Object.entries(SPECS)) {
    it(`${name}: the raw bounds select exactly the events the display bounds do, under both rules`, () => {
      const t = transformFromSpec(spec);
      const disp = raw.map((r) => Math.fround(t.forward(r)));
      // Edges on events' own display values, where the events on an edge are the ones in question.
      const sorted = [...new Set(Array.from(disp))].filter(Number.isFinite).sort((a, b) => a - b);
      const picks = [3, 17, Math.floor(sorted.length / 3), Math.floor(sorted.length / 2), sorted.length - 20];
      for (const bounds of ["closed", "half-open"] as const) {
        for (const i of picks) {
          for (const j of picks) {
            if (!(sorted[i] < sorted[j])) continue;
            const [lo, hi] = [sorted[i], sorted[j]];
            const [rlo, rhi] = exactRawRange(t, lo, hi, bounds, "float32");
            for (let k = 0; k < raw.length; k++) {
              const inDisplay = disp[k] >= lo && (bounds === "closed" ? disp[k] <= hi : disp[k] < hi);
              const inRaw = raw[k] >= rlo && (bounds === "closed" ? raw[k] <= rhi : raw[k] < rhi);
              expect(inRaw, `${bounds} [${lo}, ${hi}] event ${raw[k]} (display ${disp[k]})`).toBe(inDisplay);
            }
          }
        }
      }
    });
  }
});

// ── Raw columns that are not float32 ─────────────────────────────────────────────────────────

const DV = new DataView(new ArrayBuffer(8));
/** The next double above (dir 1) or below (dir -1), stepping the bit pattern. */
function nextDouble(x: number, dir: 1 | -1): number {
  if (x === 0) return dir * Number.MIN_VALUE;
  DV.setFloat64(0, x);
  const bits = DV.getBigUint64(0);
  DV.setBigUint64(0, (x > 0) === (dir > 0) ? bits + 1n : bits - 1n);
  return DV.getFloat64(0);
}

/**
 * The smallest double r with pred(r), pred false below it and true from it on, found by plain
 * midpoint bisection from `guess`: independent of the key search under test.
 */
function transition(pred: (r: number) => boolean, guess: number): number {
  let step = Math.max(Math.abs(guess) * 1e-3, 1e-3);
  let a = guess;
  let b = guess;
  while (pred(a)) { a -= step; step *= 2; }
  step = Math.max(Math.abs(guess) * 1e-3, 1e-3);
  while (!pred(b)) { b += step; step *= 2; }
  for (;;) {
    const mid = a + (b - a) / 2;
    if (mid === a || mid === b) break;
    if (pred(mid)) b = mid;
    else a = mid;
  }
  while (nextDouble(a, 1) !== b) {
    const up = nextDouble(a, 1);
    if (pred(up)) { b = up; break; }
    a = up;
  }
  return b;
}

describe("exactRawRange on raw columns GateLab holds as float64", () => {
  for (const [name, spec] of Object.entries(SPECS)) {
    it(`${name}: doubles and wide integers around every display rounding edge`, () => {
      const t = transformFromSpec(spec);
      const disp = (r: number) => Math.fround(t.forward(r));
      // Doubles that no float32 holds, and integers above 2^24, which float32 cannot tell apart.
      const base: number[] = [];
      for (const centre of [-300.3, -1.1, 0.37, 7.7, 1000.1, 12345.678, 100000.5, 250000.25]) {
        for (let j = -30; j <= 30; j++) base.push(centre * (1 + j * 3e-8));
      }
      for (const centre of [2 ** 24 + 3, 1e8, 3e9]) for (let j = -30; j <= 30; j++) base.push(centre + j * 97);
      const edges = [...new Set(base.map(disp))].filter(Number.isFinite).sort((a, b) => a - b);
      const picks = [2, 11, Math.floor(edges.length / 3), Math.floor(edges.length / 2), edges.length - 9];
      // Events on both sides of where each picked display value begins and ends, as tight as
      // doubles and integers sit.
      const raw = [...base];
      for (const i of picks) {
        const d = edges[i];
        const guess = t.inverse(d);
        for (const r of [transition((x) => disp(x) >= d, guess), transition((x) => disp(x) > d, guess)]) {
          let up = r;
          let down = r;
          raw.push(r);
          for (let k = 0; k < 6; k++) {
            up = nextDouble(up, 1);
            down = nextDouble(down, -1);
            raw.push(up, down);
          }
          for (let k = -3; k <= 3; k++) raw.push(Math.round(r) + k);
        }
      }
      const values = Float64Array.from(raw);
      const shown = values.map(disp);
      // Where the transform's own double arithmetic reverses the order of two neighbouring
      // doubles at a display rounding point (logicle's forward does, by 5e-17), the display
      // column itself is not monotone and no raw bound can match it. That takes a raw value
      // within an ulp or two of the rounding point; such events are counted, not checked.
      const monotoneAround = (x: number): boolean => {
        let prev = -Infinity;
        let y = x;
        for (let k = 0; k < 8; k++) y = nextDouble(y, -1);
        for (let k = 0; k <= 16; k++, y = nextDouble(y, 1)) {
          const d = disp(y);
          if (d < prev) return false;
          prev = d;
        }
        return true;
      };
      const checked = Array.from(values, monotoneAround);
      // None of the events away from those points is left out.
      expect(checked.slice(0, base.length).every(Boolean)).toBe(true);
      for (const bounds of ["closed", "half-open"] as const) {
        for (const i of picks) {
          for (const j of picks) {
            if (!(edges[i] < edges[j])) continue;
            const [lo, hi] = [edges[i], edges[j]];
            const [rlo, rhi] = exactRawRange(t, lo, hi, bounds, "float64");
            for (let k = 0; k < values.length; k++) {
              if (!checked[k]) continue;
              const inDisplay = shown[k] >= lo && (bounds === "closed" ? shown[k] <= hi : shown[k] < hi);
              const inRaw = values[k] >= rlo && (bounds === "closed" ? values[k] <= rhi : values[k] < rhi);
              expect(inRaw, `${bounds} [${lo}, ${hi}] event ${values[k]} (display ${shown[k]})`).toBe(inDisplay);
            }
          }
        }
      }
    });
  }
});

describe("nextRawValue", () => {
  it("is the next value the column can hold, so [lo, hi] and [lo, next(hi)) hold the same values", () => {
    expect(nextRawValue(1, "float32")).toBe(1.0000001192092896);
    expect(nextRawValue(1, "float64")).toBe(1 + 2 ** -52);
    expect(nextRawValue(-1, "float32")).toBe(-0.9999999403953552);
    expect(nextRawValue(-0, "float32")).toBe(2 ** -149);
    expect(nextRawValue(2 ** 24, "float32")).toBe(2 ** 24 + 2);
    expect(nextRawValue(2 ** 24, "float64")).toBe(2 ** 24 + 2 ** -28);
    // The largest finite value has no finite successor, and stays what it is.
    expect(nextRawValue(3.4028234663852886e38, "float32")).toBe(3.4028234663852886e38);
    expect(nextRawValue(Number.MAX_VALUE, "float64")).toBe(Number.MAX_VALUE);
  });
});

