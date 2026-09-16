// markerColour.ts — colouring events by a third marker in the gating plot.
//
// The renderer already draws per-point colours: cytof_plot.js `_drawOverlayScatter` reads a
// per-event uint8 index and a palette array, which is how "Colour by population / sample /
// colData" works. A continuous marker needs nothing new from it — the value is quantised to the
// levels a uint8 can hold and the palette is the ramp. So this file owns the only three
// decisions that are actually about the marker: what range the ramp spans, which level a value
// lands on, and what an event with no reading is coloured.

import { LOWER_QUANTILE, UPPER_QUANTILE, finiteQuantileSample } from "./axisRange";
import { quantileType7 } from "./transforms";
import { UNGATED_COLOR, paletteColors, type PaletteName } from "./palettes";

/**
 * Level 0 is not part of the ramp. It is the colour for an event with no reading on this
 * marker -- a file that does not carry the channel, or a non-finite value -- and it is level
 * ZERO rather than 255 because the renderer draws its colour buckets in ascending index order.
 * At the bottom the greys sit under the data, which is where an absence belongs; at the top they
 * would be painted over every coloured event in the plot.
 */
export const MARKER_MISSING_LEVEL = 0;

/**
 * Ramp levels, and therefore distinct marker colours. A uint8 index addresses 256 values and
 * one of them is spent on MARKER_MISSING_LEVEL.
 */
export const MARKER_COLOUR_LEVELS = 255;

/**
 * The palette the renderer is handed: the missing colour, then the ramp. Index i of this array
 * is exactly the level markerColourLevel() returns, which is the only thing keeping the two in
 * step -- cytof_plot.js looks the colour up by index and cannot detect a palette off by one.
 */
export function markerColourPalette(name: PaletteName): string[] {
  return [UNGATED_COLOR, ...paletteColors(name, MARKER_COLOUR_LEVELS)];
}

// ── Contrast ────────────────────────────────────────────────────────────────────────────────
// The same control the pseudocolour density has, for the same reason. A robust range still
// leaves most markers bimodal with a large negative peak, so a linear mapping spends most of the
// ramp on the negatives and squeezes the positive population into the top few colours. The
// exponent moves where the ramp's contrast sits without moving an event or changing the scale:
// above 1 it holds the bright colours back for the brightest events, below 1 it brings them in
// earlier. The numbers on the colour bar move with it, so the key never stops describing the plot.
export const DEFAULT_MARKER_COLOR_POWER = 1;
export const MIN_MARKER_COLOR_POWER = 0.3;
export const MAX_MARKER_COLOR_POWER = 3;
export const MARKER_COLOR_POWER_STEP = 0.1;

/** Clamp the marker contrast exponent to the range the UI exposes. */
export function normalizeMarkerColorPower(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MARKER_COLOR_POWER;
  const clamped = Math.max(MIN_MARKER_COLOR_POWER, Math.min(MAX_MARKER_COLOR_POWER, parsed));
  return Number((Math.round(clamped / MARKER_COLOR_POWER_STEP) * MARKER_COLOR_POWER_STEP).toFixed(1));
}

/**
 * Where a value sits along the ramp, 0 to 1, contrast applied. This is the one function the
 * colour levels and the colour bar's tick positions both go through, which is what keeps the
 * key and the plot from drifting apart when the exponent moves.
 */
export function markerColourFraction(
  value: number,
  scale: MarkerColourScale,
  power = DEFAULT_MARKER_COLOR_POWER,
): number {
  return fractionAt(value, scale, normalizeMarkerColorPower(power));
}

/** The fraction for an exponent already normalised: the per-event loops call this. */
function fractionAt(value: number, scale: MarkerColourScale, normalisedPower: number): number {
  const linear = (value - scale.lo) / (scale.hi - scale.lo);
  const clamped = Math.max(0, Math.min(1, linear));
  return Math.pow(clamped, normalisedPower);
}

/** The display-space value at the bottom and the top of the colour ramp. */
export interface MarkerColourScale {
  lo: number;
  hi: number;
}

/**
 * Where the ramp starts and ends, over every column that will be drawn.
 *
 * The quantiles are the axis fit's (see axisRange), for one reason: a user who colours by CD4
 * and then puts CD4 on an axis must not find the two disagreeing about where the data ends.
 * The axis fit's 5% padding is deliberately NOT applied — padding exists so marks do not sit on
 * the plot border, and its cost here would be that no event ever reaches either end of the
 * palette, which is exactly the contrast a colour scale is for.
 *
 * Every contributing sample is pooled into one scale, so a colour means the same marker level
 * in every file of a pooled display. Colouring each file against its own range would show four
 * files as equally bright while their actual expression differed by a decade.
 */
export function markerColourScale(columns: readonly ArrayLike<number>[]): MarkerColourScale {
  const pooled: number[] = [];
  // Appended one value at a time: each per-column sample is up to 100k long, and spreading that
  // into push() as arguments overflows the call stack rather than being slow.
  for (const column of columns) for (const value of finiteQuantileSample(column)) pooled.push(value);
  if (pooled.length === 0) return { lo: 0, hi: 1 };
  pooled.sort((a, b) => a - b);

  const lo = quantileType7(pooled, LOWER_QUANTILE);
  const hi = quantileType7(pooled, UPPER_QUANTILE);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 };
  // A channel holding one value has no range to spread a ramp over. Widening it by an arbitrary
  // epsilon would paint half the events at each end of the palette and invent a contrast that is
  // not in the data; every event belongs at the same colour, so give the scale a span of 1 and
  // let the clamp below put them all on level 0.
  return hi > lo ? { lo, hi } : { lo, hi: lo + 1 };
}

/**
 * The palette level for one display-space value: MARKER_MISSING_LEVEL, or 1..MARKER_COLOUR_LEVELS.
 *
 * Values outside the ramp are clamped rather than dropped: an event brighter than the 99.9th
 * percentile is still an event, and hiding it or leaving it uncoloured would misreport the plot.
 * A non-finite value is a reading that does not exist, which is a different statement from a low
 * one, so it takes the missing colour instead of the bottom of the ramp.
 */
export function markerColourLevel(
  value: number,
  scale: MarkerColourScale,
  power = DEFAULT_MARKER_COLOR_POWER,
): number {
  return levelAt(value, scale, normalizeMarkerColorPower(power));
}

function levelAt(value: number, scale: MarkerColourScale, normalisedPower: number): number {
  if (!Number.isFinite(value)) return MARKER_MISSING_LEVEL;
  const level = Math.floor(fractionAt(value, scale, normalisedPower) * MARKER_COLOUR_LEVELS);
  return Math.min(MARKER_COLOUR_LEVELS - 1, level) + 1;
}

/**
 * Palette levels for a whole column. The exponent is normalised once here, not once per event:
 * normalising rounds through a decimal string, and a million events paid for that each.
 */
export function markerColourLevels(
  values: ArrayLike<number>,
  scale: MarkerColourScale,
  power = DEFAULT_MARKER_COLOR_POWER,
): Uint8Array {
  const normalisedPower = normalizeMarkerColorPower(power);
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = levelAt(values[i], scale, normalisedPower);
  return out;
}

/**
 * Tick values along the colour bar, ends included. Purely for the legend; nothing reads them
 * back to colour an event.
 */
export function markerColourTicks(scale: MarkerColourScale, count = 3): number[] {
  const n = Math.max(2, Math.floor(count));
  return Array.from({ length: n }, (_, i) => scale.lo + ((scale.hi - scale.lo) * i) / (n - 1));
}
