// CellHoverProbe.tsx — which plotted point is under the cursor. Listens on the plot area
// (the renderer stops only pointerdown and click, so moves reach it), maps the pointer through
// the data area's rect and the painted ranges, and asks the point index for the nearest point
// within a few pixels. Quiet while a button is down (a pan rewrites the ranges locally until it
// ends) and outside navigate mode. Renders nothing. The lookup runs on the move itself, since it
// costs microseconds; a settle timer is available but off by default, and an animation frame is
// never used (a throttled pane holds frames back for hundreds of milliseconds). Only points with
// an image are indexed, so the cursor snaps to the nearest cell that has one.

import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { PlottedPoints } from "../engine/sample";
import type { HoverHit } from "./cellTypes";
import { buildPointIndex } from "./pointIndex";
import { insideFrame, pixelRadius, pixelToDisplay, plotFrame } from "./plotGeometry";

export interface CellHoverProbeProps {
  readonly plotAreaRef: RefObject<HTMLElement | null>;
  readonly plotted: PlottedPoints | null;
  readonly xRange: readonly [number, number] | null;
  readonly yRange: readonly [number, number] | null;
  /** False outside navigate mode or when the Gating tab is hidden. */
  readonly enabled: boolean;
  /** Pixels around the cursor a point may sit in; 8 by default. */
  readonly radiusPx?: number;
  /** Milliseconds the cursor must rest before a hover is reported; 0 (at once) by default. */
  readonly settleMs?: number;
  /** Which plotted events have an image; the others are not offered. Absent means all do. */
  readonly hasImage?: (sampleId: string | null, eventIndex: number) => boolean;
  readonly onHover: (hit: HoverHit | null) => void;
  /** A click on a point pins it; Escape, or a click on nothing, unpins. */
  readonly onPin: (hit: HoverHit | null) => void;
}

const hitOf = (plotted: PlottedPoints, k: number): HoverHit => ({
  plotIndex: k,
  eventIndex: plotted.indices ? plotted.indices[k] : k,
  sampleId: plotted.sampleOf && plotted.sampleIds ? plotted.sampleIds[plotted.sampleOf[k]] ?? null : null,
});

export function CellHoverProbe({
  plotAreaRef, plotted, xRange, yRange, enabled, radiusPx = 8, settleMs = 0, onHover, onPin, hasImage,
}: CellHoverProbeProps) {
  const index = useMemo(() => {
    if (!plotted) return null;
    const include = hasImage
      ? (k: number) => {
          const sampleId = plotted.sampleOf && plotted.sampleIds ? plotted.sampleIds[plotted.sampleOf[k]] ?? null : null;
          return hasImage(sampleId, plotted.indices ? plotted.indices[k] : k);
        }
      : undefined;
    return buildPointIndex(plotted.xd, plotted.yd, include ? { include } : {});
  }, [plotted, hasImage]);
  const latest = useRef({ plotted, xRange, yRange, enabled, onHover, onPin, index, radiusPx, settleMs });
  latest.current = { plotted, xRange, yRange, enabled, onHover, onPin, index, radiusPx, settleMs };
  const lastReported = useRef<number | null>(null);

  useEffect(() => {
    const area = plotAreaRef.current;
    if (!area) return;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let downAt: { x: number; y: number } | null = null;

    const report = (k: number | null) => {
      const { plotted: points, onHover: hover } = latest.current;
      if (k === lastReported.current) return;
      lastReported.current = k;
      hover(k === null || !points ? null : hitOf(points, k));
    };

    const locate = (px: number, py: number): number | null => {
      const { plotted: points, xRange: xr, yRange: yr, index: idx, radiusPx: radius } = latest.current;
      if (!points || !idx) return null;
      const frame = plotFrame(area, xr, yr);
      if (!frame || !insideFrame(frame, px, py)) return null;
      const [x, y] = pixelToDisplay(frame, px, py);
      const [rx, ry] = pixelRadius(frame, radius);
      return idx.nearest(x, y, rx, ry);
    };

    const onMove = (event: PointerEvent) => {
      if (!latest.current.enabled || event.buttons !== 0) {
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        return;
      }
      const rect = area.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const wait = latest.current.settleMs;
      if (settleTimer) clearTimeout(settleTimer);
      if (wait <= 0) {
        report(locate(px, py));
        return;
      }
      settleTimer = setTimeout(() => { settleTimer = null; report(locate(px, py)); }, wait);
    };
    const onLeave = () => {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      report(null);
    };
    const onDown = (event: PointerEvent) => {
      downAt = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event: PointerEvent) => {
      const from = downAt;
      downAt = null;
      if (!from || !latest.current.enabled || event.button !== 0) return;
      // A click, not the end of a pan: the pointer stayed put.
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > 3) return;
      const rect = area.getBoundingClientRect();
      const k = locate(event.clientX - rect.left, event.clientY - rect.top);
      const { plotted: points, onPin: pin } = latest.current;
      pin(k === null || !points ? null : hitOf(points, k));
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") latest.current.onPin(null);
    };

    area.addEventListener("pointermove", onMove, { passive: true });
    area.addEventListener("pointerleave", onLeave);
    area.addEventListener("pointerdown", onDown, { passive: true });
    area.addEventListener("pointerup", onUp, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      area.removeEventListener("pointermove", onMove);
      area.removeEventListener("pointerleave", onLeave);
      area.removeEventListener("pointerdown", onDown);
      area.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, [plotAreaRef]);

  // A new payload may have moved the points: whatever was reported no longer names the same dot.
  useEffect(() => {
    lastReported.current = null;
  }, [plotted]);

  return null;
}
