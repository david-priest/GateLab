// GatingPlotResizeHandle.tsx — the grip at the bottom-right corner of the Gating tab's plot, as the
// Plotting chart has (chart/ChartResizeHandle.tsx). Dragging it sets the plot's side: the plot is
// laid out again at that side, not stretched, so text and points keep their size. While dragging,
// an outline shows the new size and the plot is drawn once, on release. Escape cancels; a
// double-click lets the plot fit its area again.

import { useEffect, useRef, useState } from "react";
import { PLOT_SIDE_RANGE } from "../plots/loadPlots";
import { useI18n } from "./i18n";

const clamp = (value: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, value));

/**
 * The side a drag of `dx`, `dy` px asks for, from `start`: the larger of the two moves, as the plot
 * is square, within PLOT_SIDE_RANGE.
 */
export function resizedPlotSide(start: number, dx: number, dy: number): number {
  const move = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
  return Math.round(clamp(start + move, PLOT_SIDE_RANGE));
}

export interface GatingPlotResizeHandleProps {
  /** Where the plot's bottom-right corner sits in the plot area, in px. */
  corner: { left: number; top: number };
  /** The plot's side as drawn now, in px: where a drag starts. */
  side: () => number | null;
  /** The side kept on release. */
  onCommit: (side: number) => void;
  /** Double-click: the plot fits its area again. */
  onFit: () => void;
}

export function GatingPlotResizeHandle({ corner, side, onCommit, onFit }: GatingPlotResizeHandleProps) {
  const { t } = useI18n();
  const [shown, setShown] = useState<{ start: number; side: number } | null>(null);
  const drag = useRef<{ x: number; y: number; start: number; side: number; stop: () => void } | null>(null);
  useEffect(() => () => drag.current?.stop(), []);

  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const start = side();
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    const move = (moved: PointerEvent) => {
      const current = drag.current;
      if (!current) return;
      current.side = resizedPlotSide(current.start, moved.clientX - current.x, moved.clientY - current.y);
      setShown({ start: current.start, side: current.side });
    };
    const finish = (keep: boolean) => {
      const current = drag.current;
      if (!current) return;
      current.stop();
      drag.current = null;
      setShown(null);
      if (keep && current.side !== current.start) onCommit(current.side);
    };
    const up = () => finish(true);
    const key = (pressed: KeyboardEvent) => {
      if (pressed.key === "Escape") finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      start,
      side: start,
      stop: () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        window.removeEventListener("keydown", key, true);
      },
    };
  };

  const grow = shown ? shown.side - shown.start : 0;
  return (
    <>
      {shown && (
        // The plot's new extent, from its top-left corner, while dragging.
        <div
          className="gl-plot-resize-outline"
          style={{ left: corner.left - shown.start - 18, top: corner.top - shown.start - 12, width: shown.side + 18, height: shown.side + 12 }}
        />
      )}
      <div
        className={shown ? "gl-plot-resize is-dragging" : "gl-plot-resize"}
        style={{ left: corner.left + grow, top: corner.top + grow }}
        role="separator"
        aria-label={t("Resize the plot")}
        title={t("Drag to resize the plot: it is laid out again at the new size, its text and points keep their size. Double-click to fit it to the area again.")}
        onPointerDown={begin}
        onDoubleClick={onFit}
      />
      {shown && (
        <span className="gl-plot-resize-size" style={{ left: corner.left + grow, top: corner.top + grow }}>
          {t("{side} px", { side: String(shown.side) })}
        </span>
      )}
    </>
  );
}
