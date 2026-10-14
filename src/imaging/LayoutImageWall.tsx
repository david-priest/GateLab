// LayoutImageWall.tsx — an image wall drawn on a Layout page: the block's cells as a grid of
// composites under its caption, all on one canvas so the page's export takes it as a picture.
// The cells are decoded on the batch lane from the file the block names; while they arrive the
// grid fills in, and a file whose images are not attached shows the caption and says so.

import { useEffect, useMemo, useRef, useState } from "react";
import { IMAGE_WALL_CAPTION, IMAGE_WALL_GAP, IMAGE_WALL_PADDING, imageWallCaption, imageWallHeader, imageWallNaturalSize, type LayoutImageWallRecipe } from "../engine/imageWallBlock";
import { useI18n } from "../ui/i18n";
import { NATIVE_HOP } from "./cvwDecode";
import type { RenderSpecMessage, RenderedPicture } from "./cvwProtocol";
import type { ImageService, RenderResult, SourceInfo } from "./imageService";

export interface LayoutImageWallProps {
  readonly recipe: LayoutImageWallRecipe;
  readonly service: ImageService | null;
  /** The block's inner size on the page; the wall is drawn at its natural size and scaled to fit. */
  readonly width: number;
  readonly height: number;
}

/** Draw a rendered picture into a square tile, contained and centred, on the tile's own dark ground. */
export function drawTile(ctx: CanvasRenderingContext2D, picture: RenderedPicture | null, cols: number, rows: number, aspect: number, x: number, y: number, size: number): void {
  ctx.fillStyle = "#111";
  ctx.fillRect(x, y, size, size);
  if (!picture) return;
  const w = cols * aspect;
  const zoom = Math.min(size / Math.max(w, 1), size / Math.max(rows, 1));
  const dw = w * zoom;
  const dh = rows * zoom;
  const dx = x + (size - dw) / 2;
  const dy = y + (size - dh) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (picture.bitmap) {
    ctx.drawImage(picture.bitmap, dx, dy, dw, dh);
    return;
  }
  if (!picture.pixels) return;
  const scratch = document.createElement("canvas");
  scratch.width = picture.width;
  scratch.height = picture.height;
  const sctx = scratch.getContext("2d");
  if (!sctx) return;
  sctx.putImageData(new ImageData(picture.pixels as Uint8ClampedArray<ArrayBuffer>, picture.width, picture.height), 0, 0);
  ctx.drawImage(scratch, dx, dy, dw, dh);
}

type Tile = { picture: RenderedPicture | null; cols: number; rows: number; aspect: number };

export function LayoutImageWall({ recipe, service, width, height }: LayoutImageWallProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [info, setInfo] = useState<{ fileKey: string; info: SourceInfo | null; error: string | null } | null>(null);
  const [tiles, setTiles] = useState<Map<number, Tile>>(() => new Map());
  const fileKey = recipe.sampleId;
  const attached = !!service?.hasSource(fileKey);

  // The file's full scale, once.
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

  const spec = useMemo<RenderSpecMessage | null>(() => {
    if (!info || info.fileKey !== fileKey || !info.info) return null;
    return { display: recipe.display, scale: info.info.scale, exposure: recipe.exposure, hop: NATIVE_HOP, composite: true, channels: [], ...(recipe.outline ? { outline: recipe.outline } : {}) };
  }, [info, fileKey, recipe.display, recipe.exposure, recipe.outline]);

  // Every event's composite on the batch lane, drawn as they arrive.
  const eventsKey = recipe.events.join(",");
  useEffect(() => {
    if (!service || !spec) return;
    const next = new Map<number, Tile>();
    setTiles(next);
    const handles = recipe.events.map((eventIndex) => {
      const cached = service.cached(fileKey, eventIndex, spec);
      const take = (result: RenderResult) => {
        const image = result.kind === "image" ? result.image : null;
        next.set(eventIndex, { picture: image?.composite ?? null, cols: image?.cols ?? 1, rows: image?.rows ?? 1, aspect: image?.aspect ?? 1 });
      };
      if (cached) { take(cached); return null; }
      const handle = service.render(fileKey, eventIndex, spec, "batch");
      handle.promise.then((result) => { take(result); schedule(); }, () => undefined);
      return handle;
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; setTiles(new Map(next)); }, 60);
    };
    setTiles(new Map(next));
    return () => {
      if (timer) clearTimeout(timer);
      for (const handle of handles) handle?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, spec, fileKey, eventsKey]);

  // The drawing: caption, then the grid, at the natural size scaled to the frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const natural = imageWallNaturalSize(recipe);
    const scale = Math.max(0.05, Math.min(width / natural.width, height / natural.height));
    const dpr = Math.max(1, Math.min(3, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1));
    const cssW = Math.round(natural.width * scale);
    const cssH = Math.round(natural.height * scale);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, natural.width, natural.height);
    const [title, detail] = imageWallCaption(recipe, t);
    ctx.fillStyle = "#1a1a1a";
    ctx.textBaseline = "alphabetic";
    ctx.font = "600 12px Helvetica Neue, Helvetica, Arial, sans-serif";
    ctx.fillText(title, IMAGE_WALL_PADDING, IMAGE_WALL_PADDING + 12, natural.width - 2 * IMAGE_WALL_PADDING);
    ctx.fillStyle = "#444";
    ctx.font = "10px Helvetica Neue, Helvetica, Arial, sans-serif";
    ctx.fillText(detail, IMAGE_WALL_PADDING, IMAGE_WALL_PADDING + 26, natural.width - 2 * IMAGE_WALL_PADDING);
    if (recipe.legend && recipe.legend.length > 0) {
      // The colouring's classes, as chips with their names, on one line under the caption.
      let x = IMAGE_WALL_PADDING;
      const y = IMAGE_WALL_PADDING + IMAGE_WALL_CAPTION + 6;
      ctx.font = "9px Helvetica Neue, Helvetica, Arial, sans-serif";
      for (const entry of recipe.legend) {
        ctx.fillStyle = entry.colour;
        ctx.fillRect(x, y - 1, 8, 8);
        ctx.fillStyle = "#444";
        ctx.fillText(entry.label, x + 11, y + 7);
        x += 11 + ctx.measureText(entry.label).width + 12;
        if (x > natural.width - IMAGE_WALL_PADDING) break;
      }
    }
    const columns = Math.max(1, recipe.columns);
    const top = IMAGE_WALL_PADDING + imageWallHeader(recipe);
    if (!attached || info?.error) {
      ctx.fillStyle = "#666";
      ctx.fillText(info?.error ?? t("The file's cell images are not attached"), IMAGE_WALL_PADDING, top + 14);
      return;
    }
    recipe.events.forEach((eventIndex, k) => {
      const x = IMAGE_WALL_PADDING + (k % columns) * (recipe.tile + IMAGE_WALL_GAP);
      const y = top + Math.floor(k / columns) * (recipe.tile + IMAGE_WALL_GAP);
      const tile = tiles.get(eventIndex);
      if (tile) drawTile(ctx, tile.picture, tile.cols, tile.rows, tile.aspect, x, y, recipe.tile);
      else { ctx.fillStyle = "#e6e6e6"; ctx.fillRect(x, y, recipe.tile, recipe.tile); }
      const colour = recipe.tileColours?.[k];
      if (colour) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 0.75, y + 0.75, recipe.tile - 1.5, recipe.tile - 1.5);
      }
    });
  }, [recipe, tiles, width, height, attached, info, t]);

  return (
    <div className="gl-layout-imagewall" data-events={recipe.events.length} data-ready={tiles.size}>
      <canvas ref={canvasRef} />
    </div>
  );
}
