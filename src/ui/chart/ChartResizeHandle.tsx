// ChartResizeHandle.tsx — the grip at the bottom-right corner of the Plotting chart. Dragging it
// resizes the chart by re-laying it out, not by stretching the drawing: each panel's width and the
// plot height follow the pointer, shared out over the panels in a row and the rows, so text stays
// at its size and the panels fill the new area. The drag is shown live and kept on release, as one
// change (one undo step). Double-click fits the panels to their contents again.

import { useEffect, useRef, useState } from "react";
import { PANEL_WIDTH_RANGE } from "../../engine/proportionsSettings";
import { useI18n } from "../i18n";

/** The plot height's bounds, as the Plot height field takes it. */
export const PLOT_HEIGHT_RANGE: [number, number] = [140, 800];

export interface ChartSize {
  panelWidth: number;
  height: number;
}

/** What a drag starts from: the panels' size, and how many panels share a row and how many rows share the height. */
export interface ChartResizeStart extends ChartSize {
  columns: number;
  rows: number;
}

const clamp = (value: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, value));

/** The size a drag of `dx`, `dy` pixels asks for: the change shared over the columns and the rows, within the fields' bounds. */
export function resizedChart(start: ChartResizeStart, dx: number, dy: number): ChartSize {
  return {
    panelWidth: Math.round(clamp(start.panelWidth + dx / Math.max(1, start.columns), PANEL_WIDTH_RANGE)),
    height: Math.round(clamp(start.height + dy / Math.max(1, start.rows), PLOT_HEIGHT_RANGE)),
  };
}

/**
 * The drawn chart's panels as a drag starts: the widest panel (a panel fitted to its contents has
 * no set width), and the panels in the first row and the rows, read from where they sit.
 */
export function measureChart(frame: Element, panelWidth: number, height: number): ChartResizeStart | null {
  const panels = [...frame.querySelectorAll<SVGSVGElement>(".gl-prop-panels svg.gl-prop-panel")];
  if (!panels.length) return null;
  const tops = panels.map((panel) => Math.round(panel.getBoundingClientRect().top));
  const rows = new Set(tops).size;
  const columns = tops.filter((top) => top === tops[0]).length;
  const widest = Math.max(...panels.map((panel) => Number(panel.getAttribute("width")) || 0));
  return { panelWidth: panelWidth > 0 ? panelWidth : widest || PANEL_WIDTH_RANGE[0], height, columns, rows };
}

export interface ChartResizeHandleProps {
  /** The element holding the chart, whose panels a drag measures. */
  frame: () => Element | null;
  panelWidth: number;
  height: number;
  /** The size while dragging, null when the drag ends or is cancelled. */
  onPreview: (size: ChartSize | null) => void;
  /** The size kept on release. */
  onCommit: (size: ChartSize) => void;
  /** Double-click: the panels fitted to their contents. */
  onFit: () => void;
}

export function ChartResizeHandle({ frame, panelWidth, height, onPreview, onCommit, onFit }: ChartResizeHandleProps) {
  const { t } = useI18n();
  const [shown, setShown] = useState<ChartSize | null>(null);
  const drag = useRef<{ x: number; y: number; start: ChartResizeStart; size: ChartSize; stop: () => void } | null>(null);
  useEffect(() => () => drag.current?.stop(), []);

  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const holder = frame();
    const start = holder ? measureChart(holder, panelWidth, height) : null;
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    const size = { panelWidth: start.panelWidth, height: start.height };
    const move = (moved: PointerEvent) => {
      const current = drag.current;
      if (!current) return;
      current.size = resizedChart(current.start, moved.clientX - current.x, moved.clientY - current.y);
      setShown(current.size);
      onPreview(current.size);
    };
    const finish = (keep: boolean) => {
      const current = drag.current;
      if (!current) return;
      current.stop();
      drag.current = null;
      setShown(null);
      onPreview(null);
      const changed = current.size.panelWidth !== current.start.panelWidth || current.size.height !== current.start.height;
      if (keep && changed) onCommit(current.size);
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
      size,
      stop: () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        window.removeEventListener("keydown", key, true);
      },
    };
  };

  return (
    <>
      <div
        className="gl-prop-chart-resize"
        role="separator"
        aria-label={t("Resize the chart")}
        title={t("Drag to resize the chart: each panel's width and the plot height follow, the text keeps its size. Double-click to fit the panels to their contents.")}
        onPointerDown={begin}
        onDoubleClick={onFit}
      />
      {shown && <span className="gl-prop-chart-resize-size">{t("Panel width {width} px, plot height {height} px", { width: String(shown.panelWidth), height: String(shown.height) })}</span>}
    </>
  );
}
