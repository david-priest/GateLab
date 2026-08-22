// axisRange.ts — robust initial axis limits for cytometry display data.
//
// A handful of extreme compensated events should not determine the whole view. GateLabR
// frames axes from the 0.1st–99.9th percentiles with 5% breathing room; this browser port
// uses the same rule. Very large files are sampled deterministically so opening a two-million
// event file does not add another full-column sort to initial rendering.

import { quantileType7 } from "./transforms";

const LOWER_QUANTILE = 0.001;
const UPPER_QUANTILE = 0.999;
const PADDING_FRACTION = 0.05;
const MAX_QUANTILE_SAMPLES = 100_000;

type PlotGateGeometry = Readonly<{
  gate_type?: unknown;
  vertices?: unknown;
  center?: unknown;
  label_offset?: unknown;
}>;

function finiteQuantileSample(values: ArrayLike<number>): number[] {
  const n = values.length;
  if (n === 0) return [];

  const sampleN = Math.min(n, MAX_QUANTILE_SAMPLES);
  const out: number[] = [];
  const denom = sampleN > 1 ? sampleN - 1 : 1;
  for (let i = 0; i < sampleN; i++) {
    const index = sampleN === n ? i : Math.round((i * (n - 1)) / denom);
    const value = values[index];
    if (Number.isFinite(value)) out.push(value);
  }

  // FCS display columns should be finite, but recover sensibly from a malformed column whose
  // sparse finite values happened to fall between the deterministic sample positions.
  if (out.length === 0 && sampleN < n) {
    for (let i = 0; i < n && out.length < MAX_QUANTILE_SAMPLES; i++) {
      const value = values[i];
      if (Number.isFinite(value)) out.push(value);
    }
  }

  out.sort((a, b) => a - b);
  return out;
}

/**
 * Initial display-space range. Outliers beyond the returned limits remain visible because the
 * main plot clamps event marks (but not gates) to the corresponding axis edge.
 */
export function robustAxisRange(values: ArrayLike<number>): [number, number] {
  const sorted = finiteQuantileSample(values);
  if (sorted.length === 0) return [0, 1];

  const lo = quantileType7(sorted, LOWER_QUANTILE);
  const hi = quantileType7(sorted, UPPER_QUANTILE);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];

  const span = hi - lo;
  const padding = (span < 1e-10 ? 1 : span) * PADDING_FRACTION;
  return [lo - padding, hi + padding];
}

function finitePair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/**
 * Keep visible gate geometry inside an automatically fitted data range.
 *
 * Robust data quantiles deliberately ignore rare events, but a gate is an intentional
 * annotation rather than an outlier. After an assay-layer switch its display transform can
 * move slightly beyond the newly fitted data range. Expand only the affected edge and add a
 * small buffer so the gate line/handles do not sit on the plot border. Explicit user/global
 * ranges bypass this helper in Sample.plotPayload and therefore remain authoritative.
 */
/**
 * How far a LABEL alone may push an axis past what the data and gate geometry need.
 *
 * A label is an annotation of a gate, not a thing the view exists to contain: if it falls
 * outside, the answer is to move the label, not to rescale the plot. Letting one drive the fit
 * without limit is how a single quadrant label in a far corner shrank a whole dataset into the
 * opposite corner. A quarter of the fitted span is enough that a label sitting just off the edge
 * is still brought into view, and little enough that no label can dominate the plot.
 */
const LABEL_MAX_EXTENSION = 0.25;

/**
 * Fit ONE channel's axis to its data plus every gate drawn on it, on either axis.
 *
 * The Gating tab fits the two axes it is showing. The Strategy and Illustration grids show many
 * plots at once, so a fit there has to work per channel rather than per plot: a channel can be
 * the x of one panel and the y of another, and both sets of gates belong in the range.
 *
 * Gate coordinates are converted with the gate's OWN transform, so a raw-space gate and a
 * display-space gate on the same channel both land where they are actually drawn.
 */
export function fitChannelAxisRange(
  dataRange: [number, number],
  gateCoordinates: readonly number[],
): [number, number] {
  let [lo, hi] = dataRange;
  let expandedLow = false;
  let expandedHigh = false;
  for (const value of gateCoordinates) {
    if (!Number.isFinite(value)) continue;
    if (value < lo) { lo = value; expandedLow = true; }
    if (value > hi) { hi = value; expandedHigh = true; }
  }
  if (!expandedLow && !expandedHigh) return dataRange;
  const buffer = Math.max(1e-10, hi - lo) * PADDING_FRACTION;
  return [expandedLow ? lo - buffer : lo, expandedHigh ? hi + buffer : hi];
}

export function includePlotGatesInAxisRange(
  baseRange: [number, number],
  gates: readonly unknown[],
  axis: "x" | "y",
): [number, number] {
  const axisIndex = axis === "x" ? 0 : 1;
  // Geometry and labels are fitted separately: geometry sets the range, labels may only nudge it.
  const geometry: number[] = [];
  const labels: number[] = [];

  for (const value of gates) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const gate = value as PlotGateGeometry;
    const vertices = Array.isArray(gate.vertices) ? gate.vertices : [];
    const finiteVertices = vertices
      .map(finitePair)
      .filter((point): point is [number, number] => point !== null);
    for (const point of finiteVertices) geometry.push(point[axisIndex]);

    const center = finitePair(gate.center);
    if (center) geometry.push(center[axisIndex]);

    // A user-positioned label is part of the visible annotation. Auto-generated labels are
    // also included, but only when a finite gate centroid exists.
    const labelOffset = finitePair(gate.label_offset);
    const anchorPoints = finiteVertices.length > 0
      ? finiteVertices
      : center
        ? [center]
        : [];
    if (labelOffset && anchorPoints.length > 0) {
      const anchor = anchorPoints.reduce((sum, point) => sum + point[axisIndex], 0) /
        anchorPoints.length;
      labels.push(anchor + labelOffset[axisIndex]);
    }
  }

  if (geometry.length === 0 && labels.length === 0) return baseRange;

  let lo = baseRange[0];
  let hi = baseRange[1];
  let expandedLow = false;
  let expandedHigh = false;
  for (const coordinate of geometry) {
    if (coordinate <= lo) { lo = coordinate; expandedLow = true; }
    if (coordinate >= hi) { hi = coordinate; expandedHigh = true; }
  }

  // Labels get whatever room is left, and no more. Measured against the range the data and the
  // geometry already agreed on, so one distant label cannot enlarge its own allowance.
  const allowance = Math.max(1e-10, hi - lo) * LABEL_MAX_EXTENSION;
  const labelFloor = lo - allowance;
  const labelCeiling = hi + allowance;
  for (const coordinate of labels) {
    // <= / >= , not < / > : a label sitting exactly on the edge still earns the padding that
    // keeps it off the plot border, which is the behaviour this has always had.
    if (coordinate <= lo) {
      lo = Math.max(labelFloor, coordinate);
      expandedLow = true;
    }
    if (coordinate >= hi) {
      hi = Math.min(labelCeiling, coordinate);
      expandedHigh = true;
    }
  }

  if (!expandedLow && !expandedHigh) return baseRange;

  const span = Math.max(1e-10, hi - lo);
  const buffer = span * PADDING_FRACTION;
  return [expandedLow ? lo - buffer : lo, expandedHigh ? hi + buffer : hi];
}
