// CellMarker.tsx — rings over the hovered and the pinned cell on the gating plot, the same in
// every display style since they are drawn over the plot, not by it. A sibling of the
// renderer's container (which the renderer empties on every init and resize), placed through
// the same data-area rect the hover probe reads, and re-placed when the painted ranges change
// or the plot area resizes. The hovered cell comes from its store, so a hover re-renders this
// component and nothing else. Inside each ring sits a dot in the cell's own plot colour, so the
// hovered or pinned event is in front of its neighbours whatever the draw order buried it under.

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import type { CellHoverStore, HoveredCell } from "../engine/cellHoverStore";
import { displayToPixel, plotFrame } from "./plotGeometry";

export interface CellMarkerProps {
  readonly plotAreaRef: RefObject<HTMLElement | null>;
  readonly xRange: readonly [number, number] | null;
  readonly yRange: readonly [number, number] | null;
  readonly hoverStore: CellHoverStore;
  readonly pinned: HoveredCell | null;
  /** The display coordinates of a cell on the current axes; null when it is not on this plot. */
  readonly displayPointOf: (cell: HoveredCell) => [number, number] | null;
  /** The colour the plot draws the cell in; null for no dot inside the ring. */
  readonly colourOf?: (cell: HoveredCell) => string | null;
  /** Anything that changes where the data area sits: the painted payload, the tab, a resize. */
  readonly layoutKey?: unknown;
}

type Placed = { hovered: [number, number] | null; pinned: [number, number] | null };

export function CellMarker({ plotAreaRef, xRange, yRange, hoverStore, pinned, displayPointOf, colourOf, layoutKey }: CellMarkerProps) {
  const hovered = useSyncExternalStore(hoverStore.subscribe, hoverStore.get, hoverStore.get);
  const [placed, setPlaced] = useState<Placed>({ hovered: null, pinned: null });

  useEffect(() => {
    const area = plotAreaRef.current;
    if (!area) {
      setPlaced({ hovered: null, pinned: null });
      return;
    }
    const place = () => {
      const frame = plotFrame(area, xRange, yRange);
      const at = (cell: HoveredCell | null): [number, number] | null => {
        if (!cell || !frame) return null;
        const point = displayPointOf(cell);
        if (!point) return null;
        const [px, py] = displayToPixel(frame, point[0], point[1]);
        const inside = px >= frame.left && px <= frame.left + frame.width && py >= frame.top && py <= frame.top + frame.height;
        return inside ? [px, py] : null;
      };
      setPlaced({ hovered: at(hovered), pinned: at(pinned) });
    };
    place();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    observer?.observe(area);
    return () => observer?.disconnect();
  }, [plotAreaRef, xRange, yRange, hovered, pinned, displayPointOf, layoutKey]);

  const samePoint = placed.hovered && placed.pinned &&
    placed.hovered[0] === placed.pinned[0] && placed.hovered[1] === placed.pinned[1];
  const dot = (cell: HoveredCell | null) => {
    const colour = cell ? colourOf?.(cell) ?? null : null;
    return colour ? <span className="gl-cell-marker-dot" style={{ background: colour }} /> : null;
  };
  return (
    <>
      {placed.hovered && !samePoint && (
        <div className="gl-cell-marker gl-cell-marker-hover" aria-hidden="true" style={{ left: placed.hovered[0], top: placed.hovered[1] }}>
          {dot(hovered)}
        </div>
      )}
      {placed.pinned && (
        <div className="gl-cell-marker gl-cell-marker-pinned" aria-hidden="true" style={{ left: placed.pinned[0], top: placed.pinned[1] }}>
          {dot(pinned)}
        </div>
      )}
    </>
  );
}
