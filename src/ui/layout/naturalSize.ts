// naturalSize.ts — the natural size of a block drawn zoomed to fit its frame (a figure or a chart).
//
// The block is laid out at its natural size and zoomed by width / natural. Text laid out under a
// zoom rounds to the zoomed font's metrics, so the natural size measured changes by a pixel or
// three with the zoom itself; taken as is, each new zoom gives a new size, which gives a new zoom,
// and the block flickers between two zooms. A change of a few pixels measured just after the zoom
// changed is that rounding and is not taken; a measurement that has not changed is not taken
// again; any other change is the content's.

export interface MeasuredSize {
  width: number;
  height: number;
  /** The zoom the block was drawn at when it was measured. */
  zoom: number;
}

export interface NaturalSize {
  /** The size the zoom is computed from. */
  width: number;
  height: number;
  /** The last measurement, as measured. */
  measured: MeasuredSize;
}

/** What the zoom's own rounding moves the measured size by, at most, in px. */
export const ZOOM_ROUNDING_SLACK = 4;

export function settleNaturalSize(
  previous: NaturalSize | null,
  measured: MeasuredSize,
  slack = ZOOM_ROUNDING_SLACK,
): NaturalSize {
  if (previous) {
    const last = previous.measured;
    const same = measured.width === last.width && measured.height === last.height;
    const rounding = measured.zoom !== last.zoom &&
      Math.abs(measured.width - last.width) <= slack &&
      Math.abs(measured.height - last.height) <= slack;
    if (same || rounding) return { width: previous.width, height: previous.height, measured };
  }
  return { width: measured.width, height: measured.height, measured };
}

/** The zoom an element is drawn at, from its inline style; 1 when it has none. */
export function inlineZoom(node: HTMLElement): number {
  const zoom = Number.parseFloat(node.style.zoom);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}
