// transforms.ts — display-space transforms for FCS data, ported 1:1 from GateLabR.
//
// Two transforms:
//   • logicle (Moore–Parks bi-exponential) for flow fluorescence channels.
//     Ported verbatim from flowutils' logicle.c (the same reference algorithm
//     flowCore::logicleTransform wraps), so output matches GateLabR to ~1e-9.
//   • arcsinh(x / cofactor) for flow scatter (cf 150) and all CyTOF channels (cf 5).
//
// Channel classification, W/T estimation, and the per-instrument routing are ported
// from GateLabR inst/app/R/fcs_import.R (.is_qc_channel/.is_scatter_channel/
// .is_metal_channel/detect_instrument_type/.estimate_logicle_w/.resolve_logicle_t/
// transform_matrix_by_instrument). Every constant and branch mirrors that source.

const DBL_EPSILON = 2.220446049250313e-16; // matches C <float.h> DBL_EPSILON
const TAYLOR_LENGTH = 16;
const LN10 = Math.log(10);

// ---------------------------------------------------------------------------
// Logicle (bi-exponential) — port of flowutils/logicle_c_ext/logicle.c
// ---------------------------------------------------------------------------

/** solve() from logicle.c: find d given b and w via RTSAFE (bisection + Newton). */
function solve(b: number, w: number): number {
  // w == 0 means its really arcsinh
  if (w === 0) return b;

  const tolerance = 2 * b * DBL_EPSILON;

  // bracket the root
  let dLo = 0;
  let dHi = b;

  // bisection first step
  let d = (dLo + dHi) / 2;
  let lastDelta = dHi - dLo;

  const fB = -2 * Math.log(b) + w * b;
  let f = 2 * Math.log(d) + w * d + fB;
  let lastF = NaN;
  let delta: number;

  for (let i = 1; i < 40; ++i) {
    const df = 2 / d + w;

    if (
      ((d - dHi) * df - f) * ((d - dLo) * df - f) >= 0 ||
      Math.abs(1.9 * f) > Math.abs(lastDelta * df)
    ) {
      // bisection step
      delta = (dHi - dLo) / 2;
      d = dLo + delta;
      if (d === dLo) return d;
    } else {
      // Newton step
      delta = f / df;
      const t = d;
      d -= delta;
      if (d === t) return d;
    }

    if (Math.abs(delta) < tolerance) return d;
    lastDelta = delta;

    f = 2 * Math.log(d) + w * d + fB;
    if (f === 0 || f === lastF) return d;
    lastF = f;

    if (f < 0) dLo = d;
    else dHi = d;
  }

  return -1;
}

export class Logicle {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly f: number;
  readonly w: number;
  readonly x0: number;
  readonly x1: number;
  readonly x2: number;
  readonly xTaylor: number;
  readonly taylor: number[];

  constructor(
    readonly T: number,
    readonly W: number,
    readonly M: number,
    readonly A: number,
  ) {
    this.w = W / (M + A);
    this.x2 = A / (M + A);
    this.x1 = this.x2 + this.w;
    this.x0 = this.x2 + 2 * this.w;
    this.b = (M + A) * LN10;
    this.d = solve(this.b, this.w);
    const cA = Math.exp(this.x0 * (this.b + this.d));
    const mfA = Math.exp(this.b * this.x1) - cA / Math.exp(this.d * this.x1);
    this.a = T / (Math.exp(this.b) - mfA - cA / Math.exp(this.d));
    this.c = cA * this.a;
    this.f = -mfA * this.a;

    this.xTaylor = this.x1 + this.w / 4;

    let posCoef = this.a * Math.exp(this.b * this.x1);
    let negCoef = -this.c / Math.exp(this.d * this.x1);
    const taylor = new Array<number>(TAYLOR_LENGTH);
    for (let i = 0; i < TAYLOR_LENGTH; ++i) {
      posCoef *= this.b / (i + 1);
      negCoef *= -this.d / (i + 1);
      taylor[i] = posCoef + negCoef;
    }
    taylor[1] = 0; // exact result of Logicle condition
    this.taylor = taylor;
  }

  private seriesBiexponential(scaleVal: number): number {
    // Taylor series is around x1; taylor[1] is identically zero, skip it.
    const x = scaleVal - this.x1;
    let sum = this.taylor[TAYLOR_LENGTH - 1] * x;
    for (let i = TAYLOR_LENGTH - 2; i >= 2; --i) sum = (sum + this.taylor[i]) * x;
    return (sum * x + this.taylor[0]) * x;
  }

  /** Forward: raw data value → display coordinate (Halley's method). */
  scale(value: number): number {
    if (value === 0) return this.x1;

    const negative = value < 0;
    if (negative) value = -value;

    let x: number;
    if (value < this.f) x = this.x1 + value / this.taylor[0];
    else x = Math.log(value / this.a) / this.b;

    let tolerance = 3 * DBL_EPSILON;
    if (x > 1) tolerance = 3 * x * DBL_EPSILON;

    for (let i = 0; i < 40; ++i) {
      const ae2bx = this.a * Math.exp(this.b * x);
      const ce2mdx = this.c / Math.exp(this.d * x);
      let y: number;
      if (x < this.xTaylor) y = this.seriesBiexponential(x) - value;
      else y = ae2bx + this.f - (ce2mdx + value);
      const abe2bx = this.b * ae2bx;
      const cde2mdx = this.d * ce2mdx;
      const dy = abe2bx + cde2mdx;
      const ddy = this.b * abe2bx - this.d * cde2mdx;

      // Halley's method (cubic convergence)
      const delta = y / (dy * (1 - (y * ddy) / (2 * dy * dy)));
      x -= delta;

      if (Math.abs(delta) < tolerance) return negative ? 2 * this.x1 - x : x;
    }

    return -1;
  }

  /** Inverse: display coordinate → raw data value. */
  inverse(value: number): number {
    const negative = value < this.x1;
    if (negative) value = 2 * this.x1 - value;

    let inv: number;
    if (value < this.xTaylor) inv = this.seriesBiexponential(value);
    else inv = this.a * Math.exp(this.b * value) + this.f - this.c / Math.exp(this.d * value);

    return negative ? -inv : inv;
  }
}

// ---------------------------------------------------------------------------
// arcsinh
// ---------------------------------------------------------------------------

export const arcsinh = (x: number, cofactor: number): number => Math.asinh(x / cofactor);
export const arcsinhInverse = (y: number, cofactor: number): number => cofactor * Math.sinh(y);

// ---------------------------------------------------------------------------
// Quantiles (R type-7 == numpy 'linear'), for W/T estimation
// ---------------------------------------------------------------------------

function sortedFinite(vals: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (Number.isFinite(v)) out.push(v);
  }
  out.sort((p, q) => p - q);
  return out;
}

/** R quantile type 7 (default) on an ascending, finite-only array. */
export function quantileType7(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0];
  const h = (n - 1) * p; // 0-indexed position
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sortedAsc[lo] + (h - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

/**
 * Estimate logicle W. Matches GateLabR .estimate_logicle_w():
 *   q = 5th percentile; if q >= 0 → default 0.5
 *   abs_q = max(|q|, 1); W = (M - log10(T / abs_q)) / 2, clamped [0.1, 2.0]
 */
export function estimateLogicleW(
  vals: ArrayLike<number>,
  tVal: number,
  mVal = 4.5,
  defaultW = 0.5,
  minW = 0.1,
  maxW = 2.0,
): number {
  const sorted = sortedFinite(vals);
  const q5 = quantileType7(sorted, 0.05);
  if (!Number.isFinite(q5) || q5 >= 0 || !Number.isFinite(tVal) || tVal <= 0) return defaultW;
  const absQ = Math.max(Math.abs(q5), 1.0);
  let w = (mVal - Math.log10(tVal / absQ)) / 2;
  if (!Number.isFinite(w)) w = defaultW;
  return Math.max(minW, Math.min(w, maxW));
}

/** Resolve logicle T. Matches GateLabR .resolve_logicle_t(): max(q99.9, 262144). */
export function resolveLogicleT(vals: ArrayLike<number>): number {
  const sorted = sortedFinite(vals);
  if (sorted.length === 0) return 262144;
  let t = quantileType7(sorted, 0.999);
  if (!Number.isFinite(t) || t <= 0) t = 262144;
  return Math.max(t, 262144);
}

/**
 * Resolve both logicle T and W from a single sort of the column — same results as
 * resolveLogicleT + estimateLogicleW, but half the work (important for wide panels
 * where a transform is built per displayed channel).
 */
export function estimateLogicleParams(vals: ArrayLike<number>, mVal = 4.5): { t: number; w: number } {
  const sorted = sortedFinite(vals);
  let t = quantileType7(sorted, 0.999);
  if (!Number.isFinite(t) || t <= 0) t = 262144;
  t = Math.max(t, 262144);
  const q5 = quantileType7(sorted, 0.05);
  let w: number;
  if (!Number.isFinite(q5) || q5 >= 0) {
    w = 0.5;
  } else {
    const absQ = Math.max(Math.abs(q5), 1.0);
    w = (mVal - Math.log10(t / absQ)) / 2;
    if (!Number.isFinite(w)) w = 0.5;
    w = Math.max(0.1, Math.min(w, 2.0));
  }
  return { t, w };
}

// ---------------------------------------------------------------------------
// Channel classification — ported from fcs_import.R
// ---------------------------------------------------------------------------

const QC_EXACT = [
  "time", "event_length", "cell_length", "center", "offset",
  "width", "residual", "file_number", "beads",
];

export function isQcChannel(name: string): boolean {
  if (QC_EXACT.includes(name.toLowerCase())) return true;
  return /gaussian|amplitude|beaddist|^width$|^center$|^offset$|^residual$/i.test(name);
}

export function hasFlowSuffix(name: string): boolean {
  return /-(A|H|W|T)(\b|\)|\s|$)/i.test(name);
}

export function isScatterChannel(name: string): boolean {
  if (isQcChannel(name)) return false;
  return /^FSC|^SSC|^BSC|^FS[\s\-_]|^SS[\s\-_]|^BS[\s\-_]|^FS$|^SS$|^LightLoss|^Extinction/i.test(
    name,
  );
}

const NON_METAL_EXACT = [
  "time", "event_length", "cell_length", "center", "offset", "width",
  "residual", "file_number", "beads", "dead", "live", "viability",
];
const NON_METAL_PREFIX = [/^FSC/i, /^SSC/i, /^Viab/i, /^Scatter/i];

export function isMetalChannel(name: string): boolean {
  const isNonMetal =
    NON_METAL_EXACT.includes(name.toLowerCase()) || NON_METAL_PREFIX.some((r) => r.test(name));
  const flowSuffix = hasFlowSuffix(name);
  const looksMetal =
    /Di$/i.test(name) ||
    /(?<![A-Za-z0-9])[A-Z][a-z]?[0-9]{2,3}(?![A-Za-z0-9])/.test(name) ||
    /(?<![A-Za-z0-9])[0-9]{2,3}[A-Z][a-z]?(?![A-Za-z0-9])/.test(name);
  return looksMetal && !isNonMetal && !flowSuffix;
}

const CYTOF_RAW = ["time", "event_length", "cell_length", "file_number"];

export function isCytofRawChannel(name: string): boolean {
  return CYTOF_RAW.includes(name.toLowerCase());
}

export type Instrument = "cytof" | "flow";

/** Autodetect CyTOF vs flow from channel names. Ported from detect_instrument_type(). */
export function detectInstrumentType(names: string[]): Instrument {
  if (names.length === 0) return "flow";
  const nTotal = names.length;
  const nMetal = names.filter(isMetalChannel).length;
  const nScatter = names.filter(isScatterChannel).length;
  const nFlowSuffix = names.filter(hasFlowSuffix).length;
  const nQc = names.filter(isQcChannel).length;
  const nSignal = Math.max(0, nTotal - nQc);

  if (nScatter >= 2) return "flow";
  if (nMetal >= 3 && nFlowSuffix === 0) return "cytof";
  if (nFlowSuffix >= 3) return "flow";
  if (nSignal > 0 && nMetal / nSignal >= 0.35 && nMetal > nFlowSuffix) return "cytof";
  if (nFlowSuffix > nMetal) return "flow";
  if (nMetal > 0 && nScatter === 0) return "cytof";
  return "flow";
}

// ---------------------------------------------------------------------------
// Per-channel display transform — ported from transform_matrix_by_instrument()
// ---------------------------------------------------------------------------

export interface TransformOpts {
  /** Pre-set logicle W for this channel (else estimated). */
  wParam?: number;
  /** Scatter arcsinh cofactor (flow), default 150. */
  scatterCofactor?: number;
  /** CyTOF arcsinh cofactor, default 5. */
  cytofCofactor?: number;
}

/**
 * Transform one raw channel column into display space, exactly as GateLabR:
 *   CyTOF: raw for acquisition params, else arcsinh(x/5).
 *   Flow:  raw for QC, arcsinh(x/150) for scatter, logicle for signal.
 */
export function transformChannel(
  raw: ArrayLike<number>,
  name: string,
  instrument: Instrument,
  opts: TransformOpts = {},
): Float32Array {
  const n = raw.length;
  const out = new Float32Array(n);

  if (instrument === "cytof") {
    if (isCytofRawChannel(name)) {
      for (let i = 0; i < n; i++) out[i] = raw[i];
      return out;
    }
    const cf = opts.cytofCofactor ?? 5;
    for (let i = 0; i < n; i++) out[i] = Math.asinh(raw[i] / cf);
    return out;
  }

  // flow
  if (isQcChannel(name)) {
    for (let i = 0; i < n; i++) out[i] = raw[i];
    return out;
  }
  if (isScatterChannel(name)) {
    let cf = opts.scatterCofactor ?? 150;
    if (!Number.isFinite(cf) || cf <= 0) cf = 150;
    for (let i = 0; i < n; i++) out[i] = Math.asinh(raw[i] / cf);
    return out;
  }

  // signal → logicle
  const tVal = resolveLogicleT(raw);
  let wVal: number;
  if (opts.wParam !== undefined) {
    wVal = Number.isFinite(opts.wParam) ? (opts.wParam as number) : 0.5;
    wVal = Math.max(0.1, Math.min(wVal, 2.0));
  } else {
    wVal = estimateLogicleW(raw, tVal);
  }
  const lg = new Logicle(tVal, wVal, 4.5, 0);
  for (let i = 0; i < n; i++) out[i] = lg.scale(raw[i]);
  return out;
}
