// layoutCanvasExport.ts — an image wall or a cell panel in the exported page. Both draw their tiles,
// caption, headers and labels on one canvas; the canvas keeps its drawing (`__layoutCanvas`), and
// the export draws it again at the page's resolution without the words, embeds that as an image
// where and at the size the canvas is shown, and writes the words as <text> over it.

import { EXPORT_FONT, exportId } from "./exportSvg";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Words a block drew on its canvas, in the drawing's own coordinates. */
export interface CanvasLabel {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly weight: string;
  readonly family: string;
  readonly fill: string;
  readonly align: CanvasTextAlign;
  readonly baseline: CanvasTextBaseline;
  /** The width the text was squeezed to on the canvas, when it was wider. */
  readonly fit?: number;
}

/** A block's drawing at its natural size; `labels` null draws the words, else collects them. */
export interface LayoutCanvasDrawing {
  readonly width: number;
  readonly height: number;
  draw(ctx: CanvasRenderingContext2D, labels: CanvasLabel[] | null): void;
}

type DrawnCanvas = HTMLCanvasElement & { __layoutCanvas?: LayoutCanvasDrawing };

/** Keep a block's drawing on its canvas for the export. */
export function keepLayoutCanvas(canvas: HTMLCanvasElement, drawing: LayoutCanvasDrawing): void {
  (canvas as DrawnCanvas).__layoutCanvas = drawing;
}

/** The context's fillText, or, while an export collects them, the words as a label in the context's font. */
export function fillLabel(ctx: CanvasRenderingContext2D, labels: CanvasLabel[] | null, text: string, x: number, y: number, maxWidth?: number): void {
  if (!labels) {
    if (maxWidth === undefined) ctx.fillText(text, x, y);
    else ctx.fillText(text, x, y, maxWidth);
    return;
  }
  const font = /^(?:(?:normal|italic|oblique)\s+)?(?:(normal|bold|\d{3})\s+)?([\d.]+)px\s+(.+)$/.exec(ctx.font.trim());
  const fit = maxWidth !== undefined && ctx.measureText(text).width > maxWidth ? maxWidth : undefined;
  labels.push({
    text,
    x,
    y,
    size: font ? Number(font[2]) : 10,
    weight: font?.[1] === "bold" ? "700" : font?.[1] ?? "400",
    family: font?.[3] ?? EXPORT_FONT,
    fill: typeof ctx.fillStyle === "string" ? ctx.fillStyle : "#000000",
    align: ctx.textAlign,
    baseline: ctx.textBaseline,
    ...(fit !== undefined ? { fit } : {}),
  });
}

type Box = { left: number; top: number; width: number; height: number };

/** The longest side of the redrawn tiles, in pixels: a canvas larger than this fails to draw in some browsers. */
const MAX_SIDE = 16384;

/**
 * Write the image wall or cell panel `item` draws, if it is one, into `root`: its tiles as an
 * image at `dpi` and its words as text, at `place(canvas)` (page px, relative to the page being
 * written), which an item's zoom has already scaled; named `own`, else by its kind, `index` and
 * `heading`. False when the item is neither.
 */
export function writeLayoutCanvas(root: Element, item: HTMLElement, place: (el: Element) => Box, dpi: number, own: string | null, index: number, heading: string): boolean {
  const canvas = item.querySelector<DrawnCanvas>(".gl-layout-imagewall > canvas, .gl-layout-cellpanel > canvas");
  if (!canvas) return false;
  const id = own ?? exportId(canvas.parentElement?.classList.contains("gl-layout-cellpanel") ? "cellpanel" : "imagewall", index, heading);
  const rect = place(canvas);
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("id", id);
  g.setAttribute("transform", `translate(${round(rect.left)},${round(rect.top)})`);
  const image = document.createElementNS(SVG_NS, "image");
  image.setAttribute("x", "0");
  image.setAttribute("y", "0");
  image.setAttribute("width", String(round(rect.width)));
  image.setAttribute("height", String(round(rect.height)));
  image.setAttribute("id", `${id}-images`);
  g.appendChild(image);
  const drawing = canvas.__layoutCanvas;
  const labels: CanvasLabel[] = [];
  let href: string | null = null;
  if (drawing && drawing.width > 0 && drawing.height > 0) {
    // Drawn at its natural size and shown at `shown` times that: the tiles are drawn again at the
    // resolution of the image as placed, and the words are written at the natural size and
    // scaled with it, as the page shows them.
    const shown = rect.width / drawing.width;
    const k = Math.min(Math.max(0.05, shown * dpi / 96), MAX_SIDE / Math.max(drawing.width, drawing.height));
    const offscreen = document.createElement("canvas");
    offscreen.width = Math.max(1, Math.ceil(drawing.width * k));
    offscreen.height = Math.max(1, Math.ceil(drawing.height * k));
    const ctx = offscreen.getContext("2d");
    if (ctx) {
      try {
        ctx.setTransform(k, 0, 0, k, 0, 0);
        drawing.draw(ctx, labels);
        href = offscreen.toDataURL("image/png");
        const words = document.createElementNS(SVG_NS, "g");
        words.setAttribute("transform", `scale(${round(shown)})`);
        for (const label of labels) words.appendChild(labelText(label));
        if (labels.length) g.appendChild(words);
      } catch {
        // A tile's picture let go since it was shown (the image cache closes what it evicts).
        href = null;
      }
    }
  }
  // Not drawn yet, no context to draw it again in, or a picture gone: the canvas as shown, words and all.
  image.setAttribute("href", href ?? canvas.toDataURL("image/png"));
  root.appendChild(g);
  return true;
}

/** A label as <text>, its anchor and baseline those the canvas drew it with. */
function labelText(label: CanvasLabel): SVGTextElement {
  const t = document.createElementNS(SVG_NS, "text");
  const anchor = label.align === "center" ? "middle" : label.align === "right" || label.align === "end" ? "end" : "start";
  // The SVG text sits on its alphabetic baseline; a middle or bottom baseline is moved to it.
  const shift = label.baseline === "middle" ? 0.35 : label.baseline === "bottom" || label.baseline === "ideographic" ? -0.21 : label.baseline === "top" || label.baseline === "hanging" ? 0.8 : 0;
  t.setAttribute("x", String(round(label.x)));
  t.setAttribute("y", String(round(label.y + shift * label.size)));
  t.setAttribute("font-size", String(label.size));
  t.setAttribute("font-family", label.family);
  t.setAttribute("font-weight", label.weight);
  t.setAttribute("fill", label.fill);
  if (anchor !== "start") t.setAttribute("text-anchor", anchor);
  if (label.fit !== undefined) {
    t.setAttribute("textLength", String(round(label.fit)));
    t.setAttribute("lengthAdjust", "spacingAndGlyphs");
  }
  t.setAttribute("xml:space", "preserve");
  t.textContent = label.text;
  return t;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
