// sidePaneWidth.ts — how wide the Gates and Populations pane may be dragged. There is no fixed
// upper bound: on a wide window the pane may take everything except the left pane and a strip
// for the plot. A fixed cap (900 px until 2026-10) stopped the pane short on a wide window.

/** The narrowest the Gates and Populations pane goes. */
export const MIN_SIDE_PANE_WIDTH = 320;
/** The room the plot keeps beside the panes, so a wide pane never squeezes it to nothing. */
export const MIN_PLOT_AREA_WIDTH = 420;

/**
 * The pane width for a requested `width` in a window `viewportWidth` wide with the left pane
 * `leftWidth` wide. The pane minimum wins when the window is too narrow to keep both minimums.
 */
export function clampSidePaneWidth(width: number, viewportWidth: number, leftWidth: number): number {
  const widest = viewportWidth - leftWidth - MIN_PLOT_AREA_WIDTH;
  return Math.max(MIN_SIDE_PANE_WIDTH, Math.min(width, widest));
}

/**
 * The pane width a saved workspace asks for. Not clamped to this window: the pane's max-width keeps
 * the plot visible meanwhile, and a width saved on a wide screen comes back on one again. Widths
 * saved under the old cap (320–900 px) load unchanged.
 */
export function restoredSidePaneWidth(saved: number): number {
  return Math.max(MIN_SIDE_PANE_WIDTH, saved);
}

/**
 * The CSS `max-width` that holds the same bound as the window is resized after the drag, so a pane
 * left wide on a large window does not cover the plot on a smaller one.
 */
export function sidePaneMaxWidthCss(leftWidth: number): string {
  return `calc(100vw - ${leftWidth + MIN_PLOT_AREA_WIDTH}px)`;
}
