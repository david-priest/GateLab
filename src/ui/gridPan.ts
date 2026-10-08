// gridPan.ts — the Gating tab's navigate drag on a grid of mini plots: press on a panel and drag
// to move the view, hold Shift to stretch it about the grabbed point (panGesture.ts, the same
// gesture). The panel's data layer follows the pointer meanwhile, as a preview; on release the new
// ranges go to the workspace's channel scales, which is where every tab draws a channel from, so
// the Gating tab and the other panels of that channel follow.

import { startPanSession, type Range } from "../plots/panGesture";

export interface PannablePanel {
  /** The channels the panel draws, as the workspace's channel keys. */
  xKey: string;
  yKey: string;
  /** The ranges the panel is drawn on, in display units. */
  xr: Range;
  yr: Range;
}

/**
 * Wire the drag on `container`'s `.mini-plot-cell`s. `resolve` names a cell's channels and ranges
 * (null for one that cannot be panned); `commit` receives the ranges a drag ended on. Returns the
 * disposer.
 */
export function attachGridPan(
  container: HTMLElement,
  resolve: (cell: HTMLElement) => PannablePanel | null,
  commit: (panel: PannablePanel, xr: Range, yr: Range) => void,
): () => void {
  const onDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    if (!target) return;
    // A gate label's drag is the renderer's; controls are their own.
    if (target.closest("[data-gate-id], .gl-strategy-arrows, button, input, select, a, textarea")) return;
    const cell = target.closest<HTMLElement>(".mini-plot-cell");
    if (!cell || !container.contains(cell)) return;
    const panel = resolve(cell);
    if (!panel) return;
    const svg = cell.querySelector("svg");
    const xDomain = svg?.querySelector(".x-axis .domain");
    const yDomain = svg?.querySelector(".y-axis .domain");
    if (!xDomain || !yDomain) return;
    const xb = xDomain.getBoundingClientRect(), yb = yDomain.getBoundingClientRect();
    const rect = { left: xb.left, top: yb.top, width: xb.width, height: yb.height };
    if (!(rect.width >= 10) || !(rect.height >= 10)) return;
    event.preventDefault();
    const canvas = cell.querySelector("canvas");
    const cellRect = cell.getBoundingClientRect();
    const overflow = cell.style.overflow;
    cell.style.overflow = "hidden";
    let live = { xr: panel.xr, yr: panel.yr };
    let moved = false;
    const span = (r: Range) => r[1] - r[0];
    // The data layer under the new ranges is the old one scaled about the plot's origin: for a
    // point at px, px' = left + (x − xr0')·W/span' with x = xr0 + (px − left)·span/W.
    const preview = (xr: Range, yr: Range) => {
      if (!canvas || !(span(xr) > 0) || !(span(yr) > 0)) return;
      const ax = span(panel.xr) / span(xr), ay = span(panel.yr) / span(yr);
      const left = rect.left - cellRect.left, top = rect.top - cellRect.top;
      const bx = left * (1 - ax) + ((panel.xr[0] - xr[0]) * rect.width) / span(xr);
      const by = top * (1 - ay) + ((yr[1] - panel.yr[1]) * rect.height) / span(yr);
      canvas.style.transformOrigin = "0 0";
      canvas.style.transform = `translate(${bx}px, ${by}px) scale(${ax}, ${ay})`;
    };
    startPanSession(
      { clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey, altKey: event.altKey },
      rect,
      panel.xr,
      panel.yr,
      {
        liveRanges: () => live,
        onRanges: (xr, yr) => {
          live = { xr, yr };
          moved = true;
          preview(xr, yr);
        },
        onEnd: () => {
          if (canvas) canvas.style.transform = "";
          cell.style.overflow = overflow;
          const ok = (r: Range) => r.length === 2 && r.every(Number.isFinite) && r[0] !== r[1];
          if (moved && ok(live.xr) && ok(live.yr)) commit(panel, live.xr, live.yr);
        },
      },
      window,
    );
  };
  container.addEventListener("mousedown", onDown);
  return () => container.removeEventListener("mousedown", onDown);
}
