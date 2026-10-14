// WallHistogram.tsx — a small histogram of the wall's sort channel over its cells. The band of the
// tiles in view moves along it as the wall scrolls; a drag across it limits the wall to a range of
// values, a click clears the limit. Drawn on a canvas; no plot library.

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../ui/i18n";
import type { WallHistogram as Histogram } from "./wallBins";

export interface WallHistogramProps {
  readonly histogram: Histogram;
  /** The channel's label, for the tooltip. */
  readonly label: string;
  /** The values of the tiles now in view, as a band. */
  readonly inView: readonly [number, number] | null;
  /** The limit in force. */
  readonly range: readonly [number, number] | null;
  readonly onRange: (range: [number, number] | null) => void;
  readonly width?: number;
  readonly height?: number;
}

const BAR = "#7b9bc8";
const BAND = "rgba(47, 111, 228, 0.22)";
const DIM = "rgba(255, 255, 255, 0.6)";
const EDGE = "#2f6fe4";

export function WallHistogram({ histogram, label, inView, range, onRange, width = 220, height = 40 }: WallHistogramProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const dragRef = useRef<[number, number] | null>(null);

  const xOf = (value: number) => ((value - histogram.lo) / (histogram.hi - histogram.lo)) * width;
  const valueAt = (x: number) => histogram.lo + (Math.max(0, Math.min(width, x)) / width) * (histogram.hi - histogram.lo);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = typeof window !== "undefined" && window.devicePixelRatio > 1 ? window.devicePixelRatio : 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const bins = histogram.counts.length;
    const bw = width / bins;
    ctx.fillStyle = BAR;
    for (let b = 0; b < bins; b++) {
      const h = histogram.peak > 0 ? (histogram.counts[b] / histogram.peak) * (height - 2) : 0;
      if (h > 0) ctx.fillRect(b * bw, height - h, Math.max(1, bw - 0.5), h);
    }
    if (inView) {
      const x0 = xOf(Math.min(inView[0], inView[1]));
      const x1 = xOf(Math.max(inView[0], inView[1]));
      ctx.fillStyle = BAND;
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), height);
    }
    const limit = drag ?? range;
    if (limit) {
      const x0 = xOf(Math.min(limit[0], limit[1]));
      const x1 = xOf(Math.max(limit[0], limit[1]));
      ctx.fillStyle = DIM;
      ctx.fillRect(0, 0, x0, height);
      ctx.fillRect(x1, 0, width - x1, height);
      ctx.strokeStyle = EDGE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, height);
      ctx.moveTo(x1 - 0.5, 0); ctx.lineTo(x1 - 0.5, height);
      ctx.stroke();
    }
    // The histogram's identity covers its counts; xOf and valueAt are derived from it and the size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histogram, inView, range, drag, width, height]);

  const localX = (event: React.PointerEvent<HTMLCanvasElement>) => event.clientX - event.currentTarget.getBoundingClientRect().left;
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const x = localX(event);
    dragRef.current = [x, x];
    setDrag([valueAt(x), valueAt(x)]);
    const node = event.currentTarget;
    if (typeof node.setPointerCapture === "function") { try { node.setPointerCapture(event.pointerId); } catch { /* jsdom */ } }
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const x = localX(event);
    dragRef.current = [dragRef.current[0], x];
    setDrag([valueAt(dragRef.current[0]), valueAt(x)]);
  };
  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const started = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!started) return;
    const x = localX(event);
    if (Math.abs(x - started[0]) < 3) { onRange(null); return; }
    const a = valueAt(started[0]);
    const b = valueAt(x);
    onRange([Math.min(a, b), Math.max(a, b)]);
  };

  return (
    <canvas
      ref={canvasRef}
      className="gl-wall-histogram"
      role="img"
      aria-label={t("Distribution of {channel} over the wall's cells; drag across it to show only a range of values, click it to show them all", { channel: label })}
      title={t("Distribution of {channel} over the wall's cells; drag across it to show only a range of values, click it to show them all", { channel: label })}
      style={{ width, height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { dragRef.current = null; setDrag(null); }}
    />
  );
}
