// biex.ts — FlowJo's biexponential display transform.
//
// FlowJo evaluates a gate as straight lines in the space its axes are DISPLAYED in, and for
// fluorescence that space is almost always biex: 30 of 36 gated axes in the S6 workspace, 504 of
// 672 in LP4. Without it GateLab cannot hold an imported FlowJo gate in the space FlowJo applies
// it, and imports it straight-in-raw instead — a different boundary.
//
// Biex is not a logicle and has no closed form. It is DEFINED by building a calibration table:
// a positive and a negative exponential branch are evaluated across the channel range, subtracted,
// and mirrored about a zero channel. Interpolating that table is the algorithm, not an
// approximation of one — which is why every independent implementation builds a LUT.
//
// Ported from cytolib's `biexpTrans::computCalTbl` / `logRoot`
// (github.com/RGLab/cytolib, src/transformation.cpp), whose own comment reads "directly
// translated from java routine from tree star" — TreeStar being FlowJo's authors. Preferred over
// FlowKit's Python port, which deviates in three places: it drops the `width` clamp, and in
// logRoot it uses a subtraction where the C++ has the product that guards the Newton bracket.

/** FlowJo's five biex parameters, as written in a .wsp <Transformations> block. */
export interface BiexParams {
  /** transforms:maxRange — top of the input scale. */
  maxValue: number;
  /** transforms:pos — number of decades. */
  pos: number;
  /** transforms:neg — extra negative decades. */
  neg: number;
  /** transforms:width — the (negative) width basis. */
  widthBasis: number;
  /** transforms:length — output channel range. */
  channelRange: number;
}

/**
 * Solve for the negative range.
 *
 * Newton's method with a bisection fallback, exactly as cytolib has it. The integer truncation in
 * the convergence tests is deliberate and faithful: the C++ casts to int64_t there, mirroring the
 * Java it was translated from, and the ported behaviour is what reproduces FlowJo. `strictStep`
 * exists only so the two can be compared — see biex.test.ts.
 */
export function logRoot(b: number, w: number, strictStep = false): number {
  if (w === 0) return b;
  let xLo = 0;
  let xHi = b;
  let d = (xLo + xHi) / 2;
  const trunc = (x: number): number => Math.abs(Math.trunc(x));
  let dX = strictStep ? Math.abs(xLo - xHi) : trunc(xLo - xHi);
  let dXLast = dX;
  const fB = -2 * Math.log(b) + w * b;
  let f = 2 * Math.log(d) + w * b + fB;
  let dF = 2 / d + w;

  for (let i = 0; i < 100; i++) {
    const outsideBracket = ((d - xHi) * dF - f) * ((d - xLo) * dF - f) >= 0;
    const tooSlow = strictStep
      ? Math.abs(2 * f) > Math.abs(dXLast * dF)
      : trunc(2 * f) > trunc(dXLast * dF);
    if (outsideBracket || tooSlow) {
      dX = (xHi - xLo) / 2;
      d = xLo + dX;
      if (d === xLo) return d;
    } else {
      dX = f / dF;
      const t = d;
      d -= dX;
      if (d === t) return d;
    }
    if ((strictStep ? Math.abs(dX) : trunc(dX)) < 1.0e-12) return d;
    dXLast = dX;
    f = 2 * Math.log(d) + w * d + fB;
    dF = 2 / d + w;
    if (f < 0) xLo = d;
    else xHi = d;
  }
  return d;
}

export interface BiexLut {
  /** Input (raw) values, strictly increasing. */
  x: Float64Array;
  /** Output (channel) values, 0 … channelRange. */
  y: Float64Array;
}

/** Build FlowJo's calibration table for these parameters. */
export function generateBiexLut(p: BiexParams, strictStep = false): BiexLut {
  const ln10 = Math.log(10);
  let decades = p.pos;
  let width = Math.log10(-p.widthBasis);
  // cytolib clamps; FlowKit does not. Without it an extreme width basis walks the table off its
  // own bounds, which is the "potential segfault risk" cytolib's comment warns about.
  if (width < 0.5 || width > 3) width = 0.5;
  decades -= width / 2;
  let extra = p.neg;
  if (extra < 0) extra = 0;
  extra += width / 2;

  const channelRange = p.channelRange;
  let zeroChan = Math.trunc((extra * channelRange) / (extra + decades));
  zeroChan = Math.min(zeroChan, Math.trunc(channelRange / 2));
  if (zeroChan > 0) decades = (extra * channelRange) / zeroChan;
  width /= 2 * decades;

  const maximum = p.maxValue;
  const positiveRange = ln10 * decades;
  const minimum = maximum / Math.exp(positiveRange);
  const negativeRange = logRoot(positiveRange, width, strictStep);

  const nPoints = channelRange + 1;
  if (!(nPoints > 1) || zeroChan < 0 || zeroChan >= nPoints) {
    throw new Error(`Biex parameters give an invalid zero channel (${zeroChan} of ${nPoints}).`);
  }
  const step = (nPoints - 1) / (nPoints - 1); // 1, kept explicit to mirror the source

  const positive = new Float64Array(nPoints);
  const negative = new Float64Array(nPoints);
  const vals = new Float64Array(nPoints);
  for (let j = 0; j < nPoints; j++) {
    vals[j] = j * step;
    // Math.fround mirrors the C++ (float) casts, which are 32-bit there and would otherwise
    // shift the table by a few ulps against the reference.
    const t = Math.fround(j) / Math.fround(nPoints);
    positive[j] = Math.exp(t * positiveRange);
    negative[j] = Math.exp(t * -negativeRange);
  }

  const scale = Math.exp((positiveRange + negativeRange) * (width + extra / decades));
  for (let j = 0; j < nPoints; j++) negative[j] *= scale;

  const s = positive[zeroChan] - negative[zeroChan];
  for (let j = zeroChan; j < nPoints; j++) {
    positive[j] = minimum * (positive[j] - negative[j] - s);
  }
  for (let j = 0; j < zeroChan; j++) {
    positive[j] = -positive[2 * zeroChan - j];
  }

  return { x: positive, y: vals };
}

/** Linear interpolation over a monotonic table, clamped at both ends. */
function interp(xs: Float64Array, ys: Float64Array, v: number): number {
  const n = xs.length;
  if (!Number.isFinite(v)) return NaN;
  if (v <= xs[0]) return ys[0];
  if (v >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= v) lo = mid;
    else hi = mid;
  }
  const span = xs[hi] - xs[lo];
  if (!(span > 0)) return ys[lo];
  return ys[lo] + ((v - xs[lo]) / span) * (ys[hi] - ys[lo]);
}

export interface BiexTransform {
  forward(v: number): number;
  inverse(v: number): number;
}

/** FlowJo's biex as a forward/inverse pair, built once per parameter set. */
export function biexTransform(p: BiexParams, strictStep = false): BiexTransform {
  const { x, y } = generateBiexLut(p, strictStep);
  return {
    forward: (v) => interp(x, y, v),
    inverse: (v) => interp(y, x, v),
  };
}

// ── FlowJo's log scale ───────────────────────────────────────────────────────
//
// Unlike biex this is a closed form, and it is where the coordinate-space choice actually bites:
// on LP4's log-displayed scatter, a gate read straight-in-raw scores J=0.9807 against FlowJo's own
// population where straight-in-display scores 0.9951 — forty times the effect biex contributes on
// S6's fluorescence gates. Matches FlowKit's WSPLogTransform.

/** FlowJo's two log parameters, as written in a .wsp <Transformations> block. */
export interface WspLogParams {
  /** transforms:offset — the input value that maps to 0. Values below it are clamped. */
  offset: number;
  /** transforms:decades — how many decades the axis spans. */
  decades: number;
}

export function wspLogTransform(p: WspLogParams): BiexTransform {
  const { offset, decades } = p;
  const logOffset = Math.log10(offset);
  return {
    // FlowJo clamps at the offset rather than producing -Infinity for zero and negative values,
    // which real scatter carries. Reproducing the clamp is part of reproducing the gate.
    forward: (v) => (1 / decades) * (Math.log10(Math.max(v, offset)) - logOffset),
    inverse: (v) => Math.pow(10, v * decades + logOffset),
  };
}
