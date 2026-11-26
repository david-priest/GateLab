// FigureResizeHandle.tsx — the grip at the bottom-right corner of the Illustration figure, as the
// Plotting chart has one. Dragging it scales the figure: while the pointer moves the page is
// stretched to show the size it will take, which costs nothing however many panels there are; on
// release the panel size (or, for a heatmap, the cell size) takes the same scale and the figure is
// laid out and drawn again at it, its text at its own size. One change, one undo step. Escape
// cancels the drag. Double-click fits the figure to the preview's width.

import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";

/** The scale a drag of `dx`, `dy` pixels gives a page `width` by `height`: along whichever edge moved the more, never below a tenth. */
export function figureDragScale(width: number, height: number, dx: number, dy: number): number {
  const along = Math.abs(dx) / Math.max(1, width) >= Math.abs(dy) / Math.max(1, height) ? (width + dx) / Math.max(1, width) : (height + dy) / Math.max(1, height);
  return Math.max(0.1, along);
}

interface Props {
  /** The figure page, which a drag measures and stretches. */
  page: () => HTMLElement | null;
  /** The size the drag scales: the panel size, or a heatmap's cell size. */
  size: number;
  range: readonly [number, number];
  /** What the size is called, in the label shown while dragging. */
  sizeLabel: string;
  /** The stretch shown while dragging; 1 when the drag ends. */
  onPreview: (scale: number) => void;
  onCommit: (size: number) => void;
  /** Double-click: the scale that fits the page to the preview's width. */
  fitScale: () => number | null;
  /** Double-click, where the tab has its own way to fit the page to the width: taken in place of fitScale. */
  onFit?: () => void;
  disabled?: boolean;
}

const clamp = (value: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, value));

export function FigureResizeHandle({ page, size, range, sizeLabel, onPreview, onCommit, fitScale, onFit, disabled = false }: Props) {
  const { t } = useI18n();
  const [shown, setShown] = useState<number | null>(null);
  const drag = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => drag.current?.stop(), []);
  const sized = (scale: number) => Math.round(clamp(size * scale, range));

  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || disabled) return;
    const target = page();
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = target.getBoundingClientRect();
    const x = event.clientX, y = event.clientY;
    let scale = 1;
    const move = (moved: PointerEvent) => {
      // The stretch shown is the one the size will take, its bounds included.
      scale = sized(figureDragScale(rect.width, rect.height, moved.clientX - x, moved.clientY - y)) / size;
      setShown(sized(scale));
      onPreview(scale);
    };
    const finish = (keep: boolean) => {
      stop();
      drag.current = null;
      setShown(null);
      onPreview(1);
      const next = sized(scale);
      if (keep && next !== size) onCommit(next);
    };
    const up = () => finish(true);
    const key = (pressed: KeyboardEvent) => {
      if (pressed.key === "Escape") finish(false);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
    drag.current = { stop };
  };

  return (
    <>
      <div
        className="gl-figure-resize"
        role="separator"
        aria-label={t("Resize the figure")}
        title={t("Drag to resize the figure: the panels grow or shrink, the text keeps its size. Double-click to fit the figure to the preview's width.")}
        onPointerDown={begin}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (onFit) {
            onFit();
            return;
          }
          const scale = fitScale();
          if (scale && sized(scale) !== size) onCommit(sized(scale));
        }}
      />
      {shown !== null && <span className="gl-figure-resize-size">{t("{label} {size} px", { label: sizeLabel, size: String(shown) })}</span>}
    </>
  );
}
