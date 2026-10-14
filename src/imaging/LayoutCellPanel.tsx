// LayoutCellPanel.tsx — a cell panel drawn on a Layout page: the chosen cells as rows and a channel
// per column (or transposed), with the headers over the columns and the cells' labels beside the
// rows, all on one canvas so the page's export takes it as a picture. Each cell is one render on
// the batch lane that returns every column's channel and, when there is a merge, the composite.

import { useEffect, useMemo, useRef, useState } from "react";
import { CELL_PANEL_PADDING, cellPanelGeometry, cellPanelRenderParts, visibleColumns, type LayoutCellPanelRecipe } from "../engine/cellPanelBlock";
import { useI18n } from "../ui/i18n";
import { NATIVE_HOP } from "./cvwDecode";
import type { RenderSpecMessage, RenderedPicture } from "./cvwProtocol";
import type { ImageService, RenderResult, SourceInfo } from "./imageService";
import { drawTile } from "./LayoutImageWall";

export interface LayoutCellPanelProps {
  readonly recipe: LayoutCellPanelRecipe;
  readonly service: ImageService | null;
  /** The block's inner size on the page; the panel is drawn at its natural size and scaled to fit. */
  readonly width: number;
  readonly height: number;
}

type Cell = { composite: RenderedPicture | null; channels: Readonly<Record<number, RenderedPicture>>; cols: number; rows: number; aspect: number };

const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";

/** The text, cut with an ellipsis to fit `max` pixels in the context's font (never squeezed). */
function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (max <= 0 || ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + "…").width <= max) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + "…" : "…";
}

export function LayoutCellPanel({ recipe, service, width, height }: LayoutCellPanelProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [info, setInfo] = useState<{ fileKey: string; info: SourceInfo | null; error: string | null } | null>(null);
  const [pictures, setPictures] = useState<Map<number, Cell>>(() => new Map());
  const fileKey = recipe.sampleId;
  const attached = !!service?.hasSource(fileKey);

  useEffect(() => {
    if (!service || !attached) { setInfo(null); return; }
    let live = true;
    const known = service.knownInfo(fileKey);
    if (known) { setInfo({ fileKey, info: known, error: null }); return; }
    service.info(fileKey).then(
      (value) => { if (live) setInfo({ fileKey, info: value, error: null }); },
      (error: unknown) => { if (live) setInfo({ fileKey, info: null, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { live = false; };
  }, [service, attached, fileKey]);

  const partsKey = JSON.stringify([recipe.columns, recipe.display, recipe.gain ?? null]);
  const spec = useMemo<RenderSpecMessage | null>(() => {
    // Not while the file's images are detached: the scale held from before must not start renders.
    if (!attached || !info || info.fileKey !== fileKey || !info.info) return null;
    const parts = cellPanelRenderParts(recipe);
    return {
      display: parts.display,
      scale: info.info.scale,
      exposure: recipe.exposure,
      hop: NATIVE_HOP,
      composite: parts.composite,
      channels: parts.channels,
      ...(parts.grey.length ? { grey: parts.grey } : {}),
      ...(recipe.outline ? { outline: recipe.mask ?? {} } : {}),
    };
    // partsKey stands for the columns, the display and the gains.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attached, info, fileKey, partsKey, recipe.exposure, recipe.outline, recipe.mask?.slot, recipe.mask?.fraction]);

  const eventsKey = recipe.cells.map((c) => c.event).join(",");
  useEffect(() => {
    if (!service || !spec) return;
    const next = new Map<number, Cell>();
    const take = (eventIndex: number, result: RenderResult) => {
      const image = result.kind === "image" ? result.image : null;
      next.set(eventIndex, { composite: image?.composite ?? null, channels: image?.channels ?? {}, cols: image?.cols ?? 1, rows: image?.rows ?? 1, aspect: image?.aspect ?? 1 });
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; setPictures(new Map(next)); }, 60);
    };
    const handles = [...new Set(recipe.cells.map((c) => c.event))].map((eventIndex) => {
      const cached = service.cached(fileKey, eventIndex, spec);
      if (cached) { take(eventIndex, cached); return null; }
      const handle = service.render(fileKey, eventIndex, spec, "batch");
      handle.promise.then((result) => { take(eventIndex, result); schedule(); }, () => undefined);
      return handle;
    });
    setPictures(new Map(next));
    return () => {
      if (timer) clearTimeout(timer);
      for (const handle of handles) handle?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, spec, fileKey, eventsKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = cellPanelGeometry(recipe);
    const scale = Math.max(0.05, Math.min(width / g.width, height / g.height));
    const dpr = Math.max(1, Math.min(3, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1));
    const cssW = Math.round(g.width * scale);
    const cssH = Math.round(g.height * scale);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, g.width, g.height);
    const tile = recipe.tile;
    const step = tile + 3;
    if (g.titleHeight > 0) {
      ctx.fillStyle = "#1a1a1a";
      ctx.font = `600 12px ${FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(fitText(ctx, recipe.title!.trim(), g.width - 2 * CELL_PANEL_PADDING), CELL_PANEL_PADDING, CELL_PANEL_PADDING + 12);
    }
    const transpose = recipe.transpose === true;
    const shown = visibleColumns(recipe);
    const topTexts = transpose ? recipe.cells.map((c) => c.label) : shown.map((c) => c.header);
    const sideTexts = transpose ? shown.map((c) => c.header) : recipe.cells.map((c) => c.label);
    // Headers over the grid, centred on their tiles and cut to the tile's width.
    if (g.headerHeight > 0) {
      ctx.fillStyle = "#333";
      ctx.font = `10px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      topTexts.forEach((text, c) => ctx.fillText(fitText(ctx, text, tile), g.gridX + c * step + tile / 2, g.gridY - 3));
    }
    // Labels beside the rows, right-aligned against the grid.
    if (g.labelWidth > 0) {
      ctx.fillStyle = "#333";
      ctx.font = `10px ${FONT}`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      sideTexts.forEach((text, r) => ctx.fillText(fitText(ctx, text, g.labelWidth - 6), g.gridX - 5, g.gridY + r * step + tile / 2));
    }
    ctx.textAlign = "left";
    if (!attached || info?.error) {
      ctx.fillStyle = "#666";
      ctx.font = `10px ${FONT}`;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(info?.error ?? t("The file's cell images are not attached"), g.gridX, g.gridY + 14);
      return;
    }
    recipe.cells.forEach((cell, i) => {
      shown.forEach((column, j) => {
        const r = transpose ? j : i;
        const c = transpose ? i : j;
        const x = g.gridX + c * step;
        const y = g.gridY + r * step;
        const got = pictures.get(cell.event);
        if (!got) { ctx.fillStyle = "#e6e6e6"; ctx.fillRect(x, y, tile, tile); return; }
        const picture = column.kind === "merge" ? got.composite : column.slot !== undefined ? got.channels[column.slot] ?? null : null;
        drawTile(ctx, picture, got.cols, got.rows, got.aspect, x, y, tile);
      });
    });
  }, [recipe, pictures, width, height, attached, info, t]);

  return (
    <div className="gl-layout-cellpanel" data-cells={recipe.cells.length} data-ready={pictures.size}>
      <canvas ref={canvasRef} />
    </div>
  );
}
