/**
 * The view window of an axis whose transform has ends of its own.
 *
 * A biexponential axis is a table: an event below its first entry is drawn on channel 0 and one
 * above its last on the last channel (biex.ts). A view reaching past either end shows axis space
 * no event can ever fill, and panning the data right read as "more negative room" although the
 * extra negative decades had not changed. So a biex view stays within 0 … channelRange: room
 * below zero comes only from the extra negative decades. Logicle and arcsinh axes have no such
 * ends and are left as they are.
 *
 * Display only: gates are held in raw values or in their own stored transform, so no gate moves
 * and no count changes.
 */

import type { Range } from "./panGesture";

/**
 * A range moved inside `bounds`, keeping its width: a pan that reaches an end stops there, a
 * zoom in is untouched, and a range at least as wide as the bounds becomes the bounds, so a zoom
 * out stops at the full table. With no bounds, the range as given.
 */
export function clampToAxisWindow(range: Range, bounds: Range | null): Range {
  if (!bounds) return range;
  const [lo, hi] = bounds;
  const width = range[1] - range[0];
  if (!(width > 0) || width >= hi - lo) return [lo, hi];
  if (range[0] < lo) return [lo, lo + width];
  if (range[1] > hi) return [hi - width, hi];
  return range;
}

/** What an axis window needs to know about a channel's scale. */
export interface AxisWindowSource {
  fluorScale(idx: number): string;
  fluorBiexParams(idx: number): { channelRange: number } | null;
}

/** The ends a channel's view must stay within: 0 … channelRange on a biex axis, else none. */
export function axisWindowBounds(sample: AxisWindowSource, idx: number | undefined): Range | null {
  if (idx === undefined || sample.fluorScale(idx) !== "biex") return null;
  const params = sample.fluorBiexParams(idx);
  return params && params.channelRange > 0 ? [0, params.channelRange] : null;
}
