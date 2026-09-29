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
// translated from java routine from tree star" — TreeStar being FlowJo's authors.
//
// WHICH TABLE. The workspace declares `length="256"`, and cytolib builds its table at that
// length. FlowJo does not: it builds the same table at 4096 channels (4097 entries, t = j/4097,
// an integer zero channel computed from 4096, the width basis clamped to half a decade as cytolib
// clamps it) and solves the negative range to convergence, without the int64 truncation cytolib's
// logRoot carries over from the Java. Measured event by event against FlowJo's own exported
// memberships (three datasets, FlowJo 10.9.0 and 10.10.0, 56 populations, 12 biex parameter
// sets): FlowJo's polygon grid (flowjoGrid.ts) reproduces every event only on this table, and
// evaluating it continuously reproduces FlowKit's deposited membership, FlowKit having ported the
// 4096-channel table as well. Every variant that changes one part of it leaves events behind:
// with every gate of the three trees evaluated under the variant, summed over the 56
// populations, the 256-channel table 500 of them, the truncated root 545, a 4095- or 4097-channel
// table 286 and 74, no width clamp 202; each polygon tested alone against FlowJo's own parent
// population, 340 (over 31 polygons), 326, 130, 45 and 143. The table is scaled to the declared
// `length` for display, so a biex axis still spans 0..256 as FlowJo draws it.
//
// A spec saved before this correction carries no `tableChannels` and keeps the table it was
// evaluated on then -- cytolib's, at `length` channels with the truncated root -- so a saved
// workspace keeps the boundaries it had. Every spec the FlowJo importer writes now states 4096.

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
  /**
   * The channels the calibration table is built at: FLOWJO_BIEX_TABLE_CHANNELS (4096) for the
   * table FlowJo builds, with the negative range solved exactly. Absent means the table GateLab
   * built before 2026-09-24 -- cytolib's port, at `channelRange` channels with the truncated root
   * -- which is how a gate saved then keeps its boundary. Never default it to 4096 when reading a
   * saved spec: the stored coordinates were placed on the old table.
   */
  tableChannels?: number;
}

/** The resolution FlowJo builds its biex table at, whatever `length` the workspace declares. */
export const FLOWJO_BIEX_TABLE_CHANNELS = 4096;

/**
 * Solve for the negative range.
 *
 * Newton's method with a bisection fallback, as cytolib has it. cytolib casts to int64_t in the
 * convergence tests, mirroring the Java it was translated from; `strictStep` leaves that out and
 * solves to convergence. FlowJo's own table is the strict one (see the header): the truncated
 * root is kept only for the table GateLab built before, so a spec saved then keeps its meaning.
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
  /** Output (display channel) values, 0 … channelRange, evenly spaced. */
  y: Float64Array;
}

/**
 * How a spec's table is built: its resolution, and whether the negative range is solved exactly.
 * `strictStep` overrides the root for the legacy table only, so the two roots can be compared.
 */
function tableShape(p: BiexParams, strictStep: boolean): { channels: number; exactRoot: boolean } {
  return p.tableChannels === undefined
    ? { channels: p.channelRange, exactRoot: strictStep }
    : { channels: p.tableChannels, exactRoot: true };
}

/**
 * Build the calibration table for these parameters: FlowJo's (4096 channels, exact root) when the
 * spec states `tableChannels`, the pre-2026-09-24 one otherwise. Either way `y` runs 0 … channelRange,
 * so the display is the same axis FlowJo draws.
 */
export function generateBiexLut(p: BiexParams, strictStep = false): BiexLut {
  const { channels, exactRoot } = tableShape(p, strictStep);
  const ln10 = Math.log(10);
  let decades = p.pos;
  let width = Math.log10(-p.widthBasis);
  // cytolib clamps; FlowKit does not. Without it an extreme width basis walks the table off its
  // own bounds, which is the "potential segfault risk" cytolib's comment warns about. FlowJo
  // clamps as cytolib does: without the clamp, 202 events of the three reference datasets move
  // (143 with each polygon tested alone against FlowJo's parent population).
  if (width < 0.5 || width > 3) width = 0.5;
  decades -= width / 2;
  let extra = p.neg;
  if (extra < 0) extra = 0;
  extra += width / 2;

  if (!(Number.isInteger(channels) && channels > 1) || !(p.channelRange > 0)) {
    throw new Error(`Biex parameters give an invalid zero channel (0 of ${channels + 1}).`);
  }
  // The zero channel is an integer of the table's own resolution: computed from 4096 on FlowJo's
  // table. A zero channel carried over from 256 (or not rounded at all) moves 257 events.
  let zeroChan = Math.trunc((extra * channels) / (extra + decades));
  zeroChan = Math.min(zeroChan, Math.trunc(channels / 2));
  if (zeroChan > 0) decades = (extra * channels) / zeroChan;
  width /= 2 * decades;

  const maximum = p.maxValue;
  const positiveRange = ln10 * decades;
  const minimum = maximum / Math.exp(positiveRange);
  const negativeRange = logRoot(positiveRange, width, exactRoot);

  const nPoints = channels + 1;
  if (zeroChan < 0 || zeroChan >= nPoints) {
    throw new Error(`Biex parameters give an invalid zero channel (${zeroChan} of ${nPoints}).`);
  }
  // Scaled to the declared length for display: on FlowJo's table entry j sits at channel
  // j · length / 4096, a sixteenth of a display channel apart for the usual length of 256.
  const displayStep = p.channelRange / channels;

  const positive = new Float64Array(nPoints);
  const negative = new Float64Array(nPoints);
  const vals = new Float64Array(nPoints);
  for (let j = 0; j < nPoints; j++) {
    vals[j] = j * displayStep;
    // Both are integers below 2^24, so the C++ (float) casts are exact and this is j / nPoints.
    const t = Math.fround(j) / Math.fround(nPoints);
    positive[j] = Math.exp(t * positiveRange);
    negative[j] = Math.exp(t * -negativeRange);
  }
  vals[nPoints - 1] = p.channelRange;

  const scale = Math.exp((positiveRange + negativeRange) * (width + extra / decades));
  for (let j = 0; j < nPoints; j++) negative[j] *= scale;

  const s = positive[zeroChan] - negative[zeroChan];
  for (let j = zeroChan; j < nPoints; j++) {
    positive[j] = minimum * (positive[j] - negative[j] - s);
  }
  for (let j = 0; j < zeroChan; j++) {
    positive[j] = -positive[2 * zeroChan - j];
  }

  // The table IS the transform, so a bad table is a bad transform and must say so. Without this,
  // parameters that send logRoot a non-positive bound (pos <= width/2 with a zero channel of 0)
  // flowed NaN through the whole table, every membership comparison against NaN was false, and
  // the gate quietly reported zero events -- the silent failure shape this codebase defends
  // against everywhere else. The parser catches a thrown table and degrades the gate to
  // warned-straight-in-raw, which is the documented behaviour for a transform GateLab cannot hold.
  for (let j = 0; j < nPoints; j++) {
    if (!Number.isFinite(positive[j]) || (j > 0 && !(positive[j] > positive[j - 1]))) {
      throw new Error(
        `Biex parameters produce an unusable calibration table (maxValue ${p.maxValue}, ` +
        `pos ${p.pos}, neg ${p.neg}, width ${p.widthBasis}, length ${p.channelRange}: ` +
        `table ${Number.isFinite(positive[j]) ? "not increasing" : "not finite"} at entry ${j}).`,
      );
    }
  }

  return { x: positive, y: vals };
}

/**
 * Tables already built, by parameter set. A table is 4097 exponentials, and a gate's transform is
 * rebuilt wherever one of its coordinates is converted (Sample.gateToRaw), so without this a
 * redraw of one imported polygon rebuilt its two tables once per vertex.
 */
const lutCache = new Map<string, BiexLut>();
const LUT_CACHE_LIMIT = 64;

function cachedLut(p: BiexParams, strictStep: boolean): BiexLut {
  const key = `${p.maxValue}|${p.pos}|${p.neg}|${p.widthBasis}|${p.channelRange}|${p.tableChannels ?? ""}|${strictStep}`;
  const hit = lutCache.get(key);
  if (hit) return hit;
  const lut = generateBiexLut(p, strictStep);
  if (lutCache.size >= LUT_CACHE_LIMIT) lutCache.delete(lutCache.keys().next().value as string);
  lutCache.set(key, lut);
  return lut;
}

/**
 * The biex display map's breakpoints: `raw[j]` maps to `display[j]`, and the map is exactly
 * linear between consecutive entries. On FlowJo's table that is 4097 points, sixteen to a
 * display channel, where the table GateLab used before had 257.
 *
 * What that means for exporting a biex polygon evaluated continuously (the import option off, or
 * a polygon FlowJo's grid does not cover): its edges are straight in the display, so in raw units
 * each edge is a chain of straight pieces that break at every breakpoint it crosses. Gating-ML
 * has no biex, so the exporter writes raw units, densified to within 0.2% of the gate's extent
 * (gatingmlExport.ts): close, not exact, on either table. Written exactly, an edge needs a vertex
 * at every breakpoint it crosses on a biex axis, mapped through the table: on this table up to
 * sixteen per display channel crossed, where one per channel was exact on the old one, so a split
 * at whole channels alone is no longer exact. This function is the one source of those points.
 * The arrays are shared: do not modify them.
 */
export function biexBreakpoints(p: BiexParams): { raw: Float64Array; display: Float64Array } {
  const { x, y } = cachedLut(p, false);
  return { raw: x, display: y };
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

/**
 * FlowJo's biex as a forward/inverse pair. Both ends pin: an event below the table sits on its
 * first channel and one above it on its last, as FlowJo draws them and as FlowKit evaluates a
 * biex gate. (FlowJo's own RECTANGLES do not pin at the top; flowjoWorkspace.ts imports them in
 * raw units for that reason, and its polygons are tested on a grid, flowjoGrid.ts.)
 */
export function biexTransform(p: BiexParams, strictStep = false): BiexTransform {
  const { x, y } = cachedLut(p, strictStep);
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

/**
 * Gating-ML 2.0 flog: `y = log10(x / T) / M + 1`, inverse `x = T · 10^((y − 1) · M)`.
 *
 * The standard leaves x <= 0 undefined, and real data is full of zeros and negatives, so the
 * input is clamped to the bottom of the declared scale — `T · 10^(−M)`, the value where y = 0.
 * That is the same shape of rule FlowJo applies in wspLogTransform, one scale-span lower: FlowJo
 * pins at its offset (its own y = 0), flog pins M decades below T. Both keep the axis finite
 * rather than sending an event to −Infinity, and neither moves a gate whose lower edge sits above
 * the floor, which is every log gate that means anything.
 *
 * That clamp is GateLab's, not the standard's, and it is kept only for gates that were held with
 * it (TransformSpec flog without `standard`). With `standard`, this is Gating-ML 2.0's flog
 * itself, as flowCore and FlowKit evaluate it: no clamp, −Infinity at 0 and NaN below it. An event
 * below zero is therefore in no gate, and one at zero only in a rectangle with no lower bound on
 * that axis, which holds −Infinity because an absent bound is not tested (gateMaskRectangle). A
 * clamped gate with its lower edge at or below y = 0 took in every such event: 32,364 events where
 * FlowKit counts 9,254, on a FlowKit-written rectangle over the public 17-colour PBMC file.
 */
export function flogTransform(p: { T: number; M: number; standard?: boolean }): BiexTransform {
  const { T, M } = p;
  const floor = T * Math.pow(10, -M);
  return {
    forward: p.standard
      ? (v) => Math.log10(v / T) / M + 1
      : (v) => Math.log10(Math.max(v, floor) / T) / M + 1,
    inverse: (v) => T * Math.pow(10, (v - 1) * M),
  };
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
