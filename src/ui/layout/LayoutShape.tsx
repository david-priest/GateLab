// LayoutShape.tsx — a line, bracket, rectangle or ellipse on a Layout page, and the layer that
// draws a new one by dragging on the page. The drawing is SVG in page px: the page's zoom scales
// it as it scales everything on the page, so a stroke keeps its width in page px. The export
// copies the art group as it stands (plots/layoutShapeExport.ts).

import { createElement, useEffect, useRef, useState } from "react";
import type { LayoutShapeRecipe } from "../../engine/shapeBlock";
import { useI18n } from "../i18n";
import { shapeAtPoint, shapeElements, shapeFromDrag, shapeHitElement, type Point, type ShapeElement, type ShapeFrame, type ShapeTool } from "./shapeGeometry";
import "./layoutShapes.css";

/** SVG attribute names as React takes them: stroke-width as strokeWidth. */
const reactAttrs = (attrs: Record<string, string>) =>
  Object.fromEntries(Object.entries(attrs).map(([key, value]) => [key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), value]));

const draw = (element: ShapeElement, key: number | string, extra: Record<string, unknown> = {}) =>
  createElement(element.tag, { key, ...reactAttrs(element.attrs), ...extra });

/**
 * A shape in a frame of `width` × `height`. The art is what is drawn and exported; with `hit`, an
 * invisible copy of its outline, at least 10 screen px across, is what a pointer takes it by, so
 * a thin or level line is as easy to press as anything else and empty space inside its frame is
 * left to the page.
 */
export function LayoutShapeSvg({ recipe, width, height, hit = true }: Readonly<{ recipe: LayoutShapeRecipe; width: number; height: number; hit?: boolean }>) {
  const filled = (recipe.shape === "rectangle" || recipe.shape === "ellipse") && !!recipe.fill;
  return (
    <svg
      className="gl-layout-shape"
      data-shape={recipe.shape}
      // A frame of no height or width still draws its line: the SVG is at least 1 px and lets its art overflow.
      width={Math.max(1, width)}
      height={Math.max(1, height)}
      overflow="visible"
      aria-hidden="true"
    >
      <g className="gl-layout-shape-art">{shapeElements(recipe, width, height).map((element, index) => draw(element, index))}</g>
      {hit && draw(shapeHitElement(recipe, width, height), "hit", {
        className: "gl-layout-shape-hit",
        fill: filled ? "transparent" : "none",
        stroke: "transparent",
        pointerEvents: filled ? "all" : "stroke",
        // Ten screen pixels at any zoom (--gl-hair is one screen pixel in page px), or the stroke and a margin when that is wider.
        style: { strokeWidth: `max(calc(10 * var(--gl-hair, 1px)), ${recipe.strokeWidth + 4}px)` },
      })}
    </svg>
  );
}

export interface ShapeSnap {
  /** The grid step, 0 for none. */
  grid: number;
  /** Lines a point snaps to when near: the page's edges, margins and centres and the items' edges and centres. */
  vertical: readonly number[];
  horizontal: readonly number[];
}

/** What a drawn shape snaps to: the page's guides, and the edges and centres of the items on the page. */
export function shapeSnapLines(
  grid: number,
  guides: { vertical: readonly number[]; horizontal: readonly number[] },
  items: readonly { x: number; y: number; width: number; height: number }[],
): ShapeSnap {
  return {
    grid,
    vertical: [...guides.vertical, ...items.flatMap((item) => [item.x, item.x + item.width / 2, item.x + item.width])],
    horizontal: [...guides.horizontal, ...items.flatMap((item) => [item.y, item.y + item.height / 2, item.y + item.height])],
  };
}

/** A coordinate taken to the nearest line within `threshold`, else to the grid. */
export function snapCoordinate(value: number, lines: readonly number[], threshold: number, grid: number): number {
  let best = value, distance = threshold;
  for (const line of lines) {
    const d = Math.abs(line - value);
    if (d <= distance) {
      best = line;
      distance = d;
    }
  }
  if (best !== value || distance < threshold) return best;
  return grid > 0 ? Math.round(value / grid) * grid : value;
}

/**
 * The page while a "+ Shape" tool is armed: a press and drag draws the shape from the press to the
 * release, a click places one of the kind's default size, Shift holds a line to 0°, 45° or 90°
 * and a rectangle or ellipse to a square, Cmd turns snapping off, and Escape disarms the tool.
 * It covers the page, so neither the marquee nor an item takes the press.
 */
export function LayoutShapeDrawLayer({
  tool,
  zoom,
  snap,
  onDraw,
  onCancel,
}: Readonly<{
  tool: ShapeTool;
  zoom: number;
  snap: ShapeSnap;
  onDraw: (shape: { recipe: LayoutShapeRecipe; frame: ShapeFrame }) => void;
  onCancel: () => void;
}>) {
  const { t } = useI18n();
  const layerRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ recipe: LayoutShapeRecipe; frame: ShapeFrame } | null>(null);
  const latest = useRef({ tool, zoom, snap, onDraw, onCancel });
  latest.current = { tool, zoom, snap, onDraw, onCancel };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") latest.current.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const pointAt = (event: MouseEvent, snapped: boolean): Point => {
      const rect = layer.getBoundingClientRect();
      const { zoom: z, snap: s } = latest.current;
      const raw = { x: (event.clientX - rect.left) / z, y: (event.clientY - rect.top) / z };
      if (!snapped || event.metaKey || event.ctrlKey) return raw;
      const threshold = 6 / z;
      return { x: snapCoordinate(raw.x, s.vertical, threshold, s.grid), y: snapCoordinate(raw.y, s.horizontal, threshold, s.grid) };
    };
    // Taken here, before the page's marquee (Selecto listens on the scroll box around the page).
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      const start = pointAt(event, true);
      const startClient = { x: event.clientX, y: event.clientY };
      const shapeTo = (move: MouseEvent) => shapeFromDrag(latest.current.tool, start, pointAt(move, true), move.shiftKey);
      const onMove = (move: MouseEvent) => setPreview(shapeTo(move));
      const onUp = (up: MouseEvent) => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        setPreview(null);
        const moved = Math.hypot(up.clientX - startClient.x, up.clientY - startClient.y) >= 3;
        latest.current.onDraw(moved ? shapeTo(up) : shapeAtPoint(latest.current.tool, start));
      };
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    };
    const stop = (event: Event) => event.stopPropagation();
    layer.addEventListener("mousedown", onDown);
    layer.addEventListener("pointerdown", stop);
    layer.addEventListener("touchstart", stop);
    return () => {
      layer.removeEventListener("mousedown", onDown);
      layer.removeEventListener("pointerdown", stop);
      layer.removeEventListener("touchstart", stop);
    };
  }, []);

  return (
    <div
      ref={layerRef}
      className="gl-layout-shape-draw"
      data-tool={tool}
      title={t("Drag on the page to draw; click to place one; Shift holds a line to 45° steps; Escape cancels")}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onCancel(); }}
    >
      {preview && (
        <div className="gl-layout-shape-preview" style={{ left: preview.frame.x, top: preview.frame.y, width: preview.frame.width, height: preview.frame.height }}>
          <LayoutShapeSvg recipe={preview.recipe} width={preview.frame.width} height={preview.frame.height} hit={false} />
        </div>
      )}
    </div>
  );
}
