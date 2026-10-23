// Gating-ML 2.0 section 6.5, https://flowcyt.sourceforge.net/gating/20141009.pdf.
// The negative branch is reflected about the coordinate of zero, as in the ISAC reference
// implementation used by FlowUtils (whitews/FlowUtils, logicle_c_ext/logicle.c).
// This solver evaluates the defining exponential-plus-linear function with expm1 around zero;
// it neither substitutes Logicle nor quantises values onto a vendor's display grid.
import { withinLogicleBound } from "./transforms";

export interface HyperlogParameters { T: number; W: number; M: number; A: number }

/** Gating-ML permits negative A down to -W, and requires W > 0 (unlike Logicle). */
export function validHyperlog({ T, W, M, A }: HyperlogParameters): boolean {
  return [T, W, M, A].every(Number.isFinite) && T > 0 && M > 0 && W > 0
    && withinLogicleBound(W, M / 2, M)
    && withinLogicleBound(-A, W, M) && withinLogicleBound(A, M - 2 * W, M);
}

export class Hyperlog {
  readonly zero: number;
  private readonly b: number;
  private readonly p: number;
  private readonly c: number;

  constructor(readonly T: number, readonly W: number, readonly M: number, readonly A: number) {
    if (!validHyperlog({ T, W, M, A })) throw new Error("Invalid Hyperlog parameters: require T > 0, M > 0, 0 < W <= M/2 and -W <= A <= M - 2W.");
    const span = M + A;
    const w = W / span;
    this.zero = (A + W) / span;
    this.b = span * Math.LN10;
    // For d = y - zero >= 0, EH(y) = p * expm1(b*d) + c*d. Normalize EH(1) = T.
    // c/p = exp(b*w)/w follows directly from section 6.5's c/a and zero = x1.
    const ratio = Math.exp(this.b * w) / w;
    const top = 1 - this.zero;
    this.p = T / (Math.expm1(this.b * top) + ratio * top);
    this.c = this.p * ratio;
    if (![this.b, this.p, this.c].every((x) => Number.isFinite(x) && x > 0)) {
      throw new Error("Hyperlog parameters exceed the numeric range of this evaluator.");
    }
  }

  /** Display coordinate to the raw value; the function is defined beyond the display ends. */
  inverse(y: number): number {
    const d = y - this.zero;
    if (d === 0) return 0;
    if (y === 1) return this.T;
    const magnitude = this.p * Math.expm1(this.b * Math.abs(d)) + this.c * Math.abs(d);
    return d < 0 ? -magnitude : magnitude;
  }

  /** Raw value to display coordinate, with a bracketed Halley iteration. No fallback transform. */
  scale(value: number): number {
    if (!Number.isFinite(value)) return value;
    if (value === 0) return this.zero;
    const v = Math.abs(value);
    if (v === this.T) return value < 0 ? 2 * this.zero - 1 : 1;
    // Each positive term gives an upper bound on d. log(v)-log(p) avoids overflow of v/p.
    const ratio = v / this.p;
    const logUpper = Number.isFinite(ratio) ? Math.log1p(ratio) : Math.log(v) - Math.log(this.p);
    let lo = 0;
    let hi = Math.min(logUpper / this.b, v / (this.p * this.b + this.c));
    let d = hi;
    for (let i = 0; i < 80; i++) {
      // Where exp(b*d) alone overflows, p*exp(b*d) need not (p < 1): it is then formed from logs.
      const growth = Math.exp(this.b * d);
      const overflowed = growth === Infinity;
      const exp = overflowed ? Math.exp(this.b * d + Math.log(this.p)) : this.p * growth;
      const residual = (overflowed ? exp - this.p : this.p * Math.expm1(this.b * d)) + this.c * d - v;
      if (residual === 0) break;
      if (residual > 0) hi = d; else lo = d;
      // Halley's step r / (f' - r*f''/(2f')), with f' = b*exp + c and f'' = b*b*exp, taken as
      // ratios to exp. Formed directly, f' and r*f'' overflow near the largest doubles, and the
      // step became -0, which the convergence check below accepted at an unconverged d.
      const newton = (residual / exp) / (this.b + this.c / exp);
      const delta = newton / (1 - newton * this.b / (2 + 2 * this.c / (this.b * exp)));
      const proposed = d - delta;
      // Close enough in display units, including a rounding-stalled exact root. A failed
      // iteration stays inside the mathematical bracket instead of returning an arbitrary scale.
      if (Number.isFinite(delta) && Math.abs(delta) <= 4 * Number.EPSILON * Math.max(1, d)) {
        d = proposed;
        return this.zero + (value < 0 ? -d : d);
      }
      const next = proposed > lo && proposed < hi ? proposed : lo + (hi - lo) / 2;
      if (next === d) break;
      d = next;
    }
    return this.zero + (value < 0 ? -d : d);
  }
}
