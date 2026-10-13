// plotGeometry.ts — where the plotted data sits on the page. The renderer (vendor cytof_plot.js)
// draws the data area as the `.cytof-overlay` rect inside its margin group, and App's pan and
// stretch gestures already read that rect to map pixels to display coordinates; the hover probe
// and the pinned-cell marker do the same, so the three agree to the pixel. Positions are
// relative to the plot area element, which is `position: relative`, so a marker placed with
// them lands on the plotted point whatever scrolled or resized around it.

export interface PlotFrame {
  /** The data area, relative to the plot area's own box. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly xr: readonly [number, number];
  readonly yr: readonly [number, number];
}

/** The data area of the plot inside `plotArea`, or null before the renderer has drawn one. */
export function plotFrame(
  plotArea: HTMLElement,
  xr: readonly [number, number] | null,
  yr: readonly [number, number] | null,
): PlotFrame | null {
  if (!xr || !yr) return null;
  const overlay = plotArea.querySelector(".cytof-overlay");
  if (!overlay) return null;
  const area = plotArea.getBoundingClientRect();
  const rect = overlay.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  if (!(xr[1] - xr[0] > 0) || !(yr[1] - yr[0] > 0)) return null;
  return { left: rect.left - area.left, top: rect.top - area.top, width: rect.width, height: rect.height, xr, yr };
}

/** Display coordinates of a point given relative to the plot area. */
export function pixelToDisplay(frame: PlotFrame, px: number, py: number): [number, number] {
  const fx = (px - frame.left) / frame.width;
  const fy = (py - frame.top) / frame.height;
  return [frame.xr[0] + fx * (frame.xr[1] - frame.xr[0]), frame.yr[1] - fy * (frame.yr[1] - frame.yr[0])];
}

/** Position relative to the plot area of a display-space point. */
export function displayToPixel(frame: PlotFrame, x: number, y: number): [number, number] {
  const fx = (x - frame.xr[0]) / (frame.xr[1] - frame.xr[0]);
  const fy = (frame.yr[1] - y) / (frame.yr[1] - frame.yr[0]);
  return [frame.left + fx * frame.width, frame.top + fy * frame.height];
}

/** A pixel radius as display-unit radii per axis. */
export function pixelRadius(frame: PlotFrame, px: number): [number, number] {
  return [(px / frame.width) * (frame.xr[1] - frame.xr[0]), (px / frame.height) * (frame.yr[1] - frame.yr[0])];
}

/** True when the pixel (relative to the plot area) is inside the data area. */
export function insideFrame(frame: PlotFrame, px: number, py: number): boolean {
  return px >= frame.left && px <= frame.left + frame.width && py >= frame.top && py <= frame.top + frame.height;
}
