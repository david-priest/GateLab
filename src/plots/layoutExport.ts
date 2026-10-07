// layoutExport.ts — export a Layout sheet as SVG, PNG or PDF. The page is composed the way the
// Strategy and Illustration grids are (gridExport.ts): every plot's data layer is re-rendered at
// the export resolution and embedded as an image, its axes and gates stay vector from the cell's
// own <svg>, and text blocks and titles become <text>. The page is the sheet's physical size.

import { zipSync, strToU8 } from "fflate";
import { cellDataUrlAtDpi, rasterizeSvg } from "./gridExport";
import type { LayoutSheet } from "../engine/layout";
import { pageOrigins, pageSizeMm, pageSizePx, SCREEN_PX_PER_MM } from "../engine/layout";
import { sanitizeFilePart } from "../engine/fcsExport";
import { composeProportionsChartSvg } from "../ui/ProportionsTab";
import { EXPORT_FONT, exportId, finishExportSvg, nameCell, nextTurn, pdfVectorPage, pngBlob } from "./exportSvg";

const SVG_NS = "http://www.w3.org/2000/svg";

export type LayoutExportFormat = "svg" | "png" | "pdf";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A rectangle in page pixels, from client rects that the on-screen zoom has scaled, relative to the page being written. */
function pageRect(el: Element, origin: DOMRect, zoom: number, offset: { x: number; y: number } = { x: 0, y: 0 }) {
  const r = el.getBoundingClientRect();
  return {
    left: (r.left - origin.left) / zoom - offset.x,
    top: (r.top - origin.top) / zoom - offset.y,
    width: r.width / zoom,
    height: r.height / zoom,
  };
}

interface ExportLine { text: string; left: number; top: number }

/** Text lines under `parent`, each at its own offset from the block's top-left corner, the baseline 0.82 em below its line's top. */
function textLines(parent: Element, lines: readonly ExportLine[], left: number, top: number, fontSize: number, style: CSSStyleDeclaration) {
  lines.forEach((line) => {
    if (!line.text) return;
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(left + line.left));
    t.setAttribute("y", String(top + line.top + fontSize * 0.82));
    t.setAttribute("font-size", String(fontSize));
    t.setAttribute("font-family", style.fontFamily || EXPORT_FONT);
    t.setAttribute("font-weight", style.fontWeight || "400");
    t.setAttribute("fill", style.color || "#1e293b");
    t.setAttribute("xml:space", "preserve");
    t.textContent = line.text;
    parent.appendChild(t);
  });
}

/**
 * The lines a text block shows, from the browser's own line boxes: a mirror of the block, the
 * same width and font, is laid out off screen and read character by character, so text that
 * wraps on the page exports wrapped. Null where line boxes cannot be measured, and the block's
 * newlines alone decide.
 */
function wrappedLines(block: HTMLElement, content: string): ExportLine[] | null {
  if (typeof document.createRange !== "function" || !content.trim()) return null;
  const range = document.createRange();
  if (typeof range.getBoundingClientRect !== "function") return null;
  const style = getComputedStyle(block);
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const mirror = document.createElement("div");
  Object.assign(mirror.style, {
    position: "fixed", left: "-100000px", top: "0", visibility: "hidden",
    width: `${Math.max(1, block.clientWidth - padding)}px`, boxSizing: "content-box",
    padding: "0", margin: "0", border: "0",
    fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle,
    lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
    whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: style.wordBreak,
  } as Partial<CSSStyleDeclaration>);
  mirror.textContent = content;
  document.body.appendChild(mirror);
  try {
    const node = mirror.firstChild;
    if (!node) return null;
    const origin = mirror.getBoundingClientRect();
    const lines: ExportLine[] = [];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === "\n") continue;
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const top = r.top - origin.top;
      const previous = lines.at(-1);
      if (previous && Math.abs(previous.top - top) < 1) previous.text += content[i];
      else lines.push({ text: content[i], left: r.left - origin.left, top });
    }
    return lines.length ? lines : null;
  } finally {
    mirror.remove();
  }
}

/** One plot cell: the data layer as an image at `dpi`, the cell's own <svg> (axes, gates) on top. */
function addCell(root: SVGSVGElement, cell: HTMLElement, origin: DOMRect, zoom: number, dpi: number, offset: { x: number; y: number }, base: string) {
  const rect = pageRect(cell, origin, zoom, offset);
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("transform", `translate(${Math.round(rect.left)},${Math.round(rect.top)})`);
  const canvas = cell.querySelector("canvas");
  if (canvas) {
    const img = document.createElementNS(SVG_NS, "image");
    const size = pageRect(canvas, origin, zoom, offset);
    img.setAttribute("x", "0");
    img.setAttribute("y", "0");
    img.setAttribute("width", String(Math.round(size.width || rect.width)));
    img.setAttribute("height", String(Math.round(size.height || rect.height)));
    img.setAttribute("href", cellDataUrlAtDpi(cell, dpi, Math.round(size.width || rect.width)) ?? canvas.toDataURL("image/png"));
    g.appendChild(img);
  }
  const svg = cell.querySelector("svg");
  if (svg) {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    // A figure block draws its grid under a CSS zoom to fit its frame; the cloned <svg> keeps its
    // own size, so it is scaled by the ratio of the cell as placed to the cell as laid out.
    const natural = svg.clientWidth || Number(svg.getAttribute("width")) || rect.width;
    const scale = natural > 0 ? rect.width / natural : 1;
    if (Math.abs(scale - 1) > 1e-3) {
      const scaled = document.createElementNS(SVG_NS, "g");
      scaled.setAttribute("transform", `scale(${scale})`);
      scaled.appendChild(clone);
      g.appendChild(scaled);
    } else g.appendChild(clone);
  }
  nameCell(g, base);
  root.appendChild(g);
}

/** The items of the canvas in stacking order, each with its frame relative to `offset` in page pixels. */
function pageItems(canvas: HTMLElement, origin: DOMRect, zoom: number, offset: { x: number; y: number }) {
  return [...canvas.querySelectorAll<HTMLElement>(".gl-layout-item")]
    .sort((a, b) => (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0))
    .map((item) => ({ item, frame: pageRect(item, origin, zoom, offset) }));
}

/**
 * The part of the page an export cropped to its content covers: the items on the page, with
 * `paddingMm` of white around them, and never beyond the page itself. Null when nothing is on
 * the page, and the page is written whole.
 */
function cropBox(items: readonly { frame: { left: number; top: number; width: number; height: number } }[], width: number, height: number, paddingMm: number) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const { frame } of items) {
    if (frame.left >= width || frame.top >= height || frame.left + frame.width <= 0 || frame.top + frame.height <= 0) continue;
    left = Math.min(left, frame.left);
    top = Math.min(top, frame.top);
    right = Math.max(right, frame.left + frame.width);
    bottom = Math.max(bottom, frame.top + frame.height);
  }
  if (!Number.isFinite(left)) return null;
  const pad = Math.max(0, paddingMm) * SCREEN_PX_PER_MM;
  const x = Math.max(0, Math.floor(left - pad));
  const y = Math.max(0, Math.floor(top - pad));
  return { x, y, width: Math.min(width, Math.ceil(right + pad)) - x, height: Math.min(height, Math.ceil(bottom + pad)) - y };
}

/**
 * Compose one page of the sheet's canvas element into an SVG the size of the page. Items are
 * taken in stacking order from the live DOM; `zoom` is the on-screen scale, so the composition
 * is the same at any zoom; `pageIndex` picks a page of the sheet's grid (row-major). Anything
 * beyond the page is clipped by the page. With `crop`, the page is cut down to its items plus
 * the padding, so a figure comes out without the blank paper around it.
 */
export function composeLayoutSVG(
  canvas: HTMLElement,
  sheet: LayoutSheet,
  options: { dpi: number; zoom: number; pageIndex?: number; crop?: { paddingMm: number } },
): ComposedPage {
  const page = pageSizePx(sheet.page);
  const pageOrigin = pageOrigins(sheet.page)[options.pageIndex ?? 0] ?? { x: 0, y: 0 };
  const origin = canvas.getBoundingClientRect();
  const crop = options.crop ? cropBox(pageItems(canvas, origin, options.zoom, pageOrigin), page.width, page.height, options.crop.paddingMm) : null;
  const offset = crop ? { x: pageOrigin.x + crop.x, y: pageOrigin.y + crop.y } : pageOrigin;
  const width = crop ? crop.width : page.width;
  const height = crop ? crop.height : page.height;
  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("xmlns", SVG_NS);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("width", "100%");
  bg.setAttribute("height", "100%");
  bg.setAttribute("fill", "#ffffff");
  root.appendChild(bg);

  // Items are numbered in stacking order and named by their heading, so an editor's layers
  // panel reads plot-3-Lymphocytes rather than a row of anonymous groups.
  let index = 0;
  for (const { item, frame } of pageItems(canvas, origin, options.zoom, offset)) {
    // An item wholly outside this page is left to the page it is on.
    if (frame.left >= width || frame.top >= height || frame.left + frame.width <= 0 || frame.top + frame.height <= 0) continue;
    index += 1;
    const heading = item.dataset.title ?? item.querySelector(".gl-layout-item-head span")?.textContent ?? "";
    if (item.classList.contains("has-frame")) {
      const r = document.createElementNS(SVG_NS, "rect");
      r.setAttribute("x", String(Math.round(frame.left) + 0.5));
      r.setAttribute("y", String(Math.round(frame.top) + 0.5));
      r.setAttribute("width", String(Math.round(frame.width) - 1));
      r.setAttribute("height", String(Math.round(frame.height) - 1));
      r.setAttribute("fill", "none");
      r.setAttribute("stroke", "#94a3b8");
      r.setAttribute("id", exportId("frame", index, heading));
      root.appendChild(r);
    }
    const text = item.querySelector<HTMLTextAreaElement | HTMLElement>(".gl-layout-text-surface");
    if (text) {
      const content = text instanceof HTMLTextAreaElement ? text.value : (text.textContent ?? "");
      const style = getComputedStyle(text);
      const rect = pageRect(text, origin, options.zoom, offset);
      // A zoomed item (data-zoom) draws its text at the size written and scales it as a whole;
      // computed lengths are as written, so the item's zoom is applied here.
      const itemZoom = Number(item.dataset.zoom) || 1;
      const fontSize = (parseFloat(style.fontSize) || 14) * itemZoom;
      const padLeft = (parseFloat(style.paddingLeft) || 0) * itemZoom;
      const padTop = (parseFloat(style.paddingTop) || 0) * itemZoom;
      const lines = wrappedLines(text, content)?.map((line) => ({ text: line.text, left: line.left * itemZoom, top: line.top * itemZoom }))
        ?? content.split("\n").map((line, row) => ({ text: line, left: 0, top: row * fontSize * 1.3 }));
      const block = document.createElementNS(SVG_NS, "g");
      block.setAttribute("id", exportId("text", index, content.trim().split(/\s+/).slice(0, 4).join(" ")));
      textLines(block, lines, rect.left + padLeft, rect.top + padTop, fontSize, style);
      root.appendChild(block);
      continue;
    }
    const host = item.querySelector<HTMLElement>(".gl-layout-plot-host");
    if (!host) continue;
    if ((host as unknown as { __miniPlotCfg?: unknown }).__miniPlotCfg) {
      addCell(root, host, origin, options.zoom, options.dpi, offset, exportId("plot", index, heading));
      continue;
    }
    // A Plotting chart block is the tab's card: its panels and legend composed as one SVG at the
    // card's own scale, placed and scaled to where the card sits on the page.
    const chart = host.querySelector<HTMLElement>(".gl-prop-chart");
    if (chart) {
      const composed = composeProportionsChartSvg(chart);
      if (composed) {
        const rect = pageRect(chart, origin, options.zoom, offset);
        const scale = composed.width > 0 ? rect.width / composed.width : 1;
        const g = document.createElementNS(SVG_NS, "g");
        g.setAttribute("id", exportId("chart", index, heading));
        g.setAttribute("transform", `translate(${rect.left},${rect.top}) scale(${scale})`);
        g.appendChild(composed.root);
        root.appendChild(g);
      }
      continue;
    }
    // A strategy block is a grid of cells with an HTML title; a figure block is the Illustration
    // grid with its HTML row and column headings, drawn under a zoom that the placed size shows.
    host.querySelectorAll<HTMLElement>(".strategy-context-title, .illustration-row-header").forEach((title) => {
      const text = (title.textContent ?? "").trim();
      if (!text) return;
      const style = getComputedStyle(title);
      const rect = pageRect(title, origin, options.zoom, offset);
      const zoomed = title.offsetWidth > 0 ? rect.width / title.offsetWidth : 1;
      textLines(root, [{ text, left: 0, top: 0 }], rect.left, rect.top, (parseFloat(style.fontSize) || 12) * zoomed, style);
    });
    const block = exportId(host.querySelector(".gl-figure-grid") ? "figure" : "strategy", index, heading);
    host.querySelectorAll<HTMLElement>(".mini-plot-cell").forEach((cell, k) => addCell(root, cell, origin, options.zoom, options.dpi, offset, `${block}-panel-${k + 1}`));
  }
  // The physical size: the sheet's page, or the cropped part of it at the page's pixels per mm.
  const size = crop
    ? { widthMm: width / SCREEN_PX_PER_MM, heightMm: height / SCREEN_PX_PER_MM }
    : pageSizeMm(sheet.page);
  finishExportSvg(root, { widthPx: width, heightPx: height, ...size });
  return { root, width, height, ...size };
}

function serialize(root: SVGSVGElement): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(root);
}

export interface ComposedPage {
  root: SVGSVGElement;
  /** The drawing's size in page pixels, what its coordinates are in. */
  width: number;
  height: number;
  /** Its physical size. */
  widthMm: number;
  heightMm: number;
}

export interface ComposeOptions {
  zoom: number;
  /** Cut each page down to the items on it plus this much white around them. */
  crop?: { paddingMm: number };
}

/** Every page of the sheet's grid, composed from the canvas as it is now. */
export function composeSheetPages(canvas: HTMLElement, sheet: LayoutSheet, options: ComposeOptions): ComposedPage[] {
  return pageOrigins(sheet.page).map((_, pageIndex) => composeLayoutSVG(canvas, sheet, { dpi: sheet.page.dpi, zoom: options.zoom, pageIndex, crop: options.crop }));
}

const PT_PER_MM = 72 / 25.4;

/**
 * Write composed pages as the chosen format; the file is named after the sheet. One page is one
 * file; several are one PDF with a page each, or a zip of one SVG or PNG each.
 */
export async function writeComposedPages(composed: readonly ComposedPage[], sheet: LayoutSheet, format: LayoutExportFormat): Promise<void> {
  const dpi = sheet.page.dpi;
  const filename = sanitizeFilePart(sheet.name) || "layout";
  if (!composed.length) return;
  if (format === "svg") {
    if (composed.length === 1) {
      downloadBlob(new Blob([serialize(composed[0].root)], { type: "image/svg+xml" }), `${filename}.svg`);
      return;
    }
    const files: Record<string, Uint8Array> = {};
    composed.forEach((page, index) => { files[`${filename}-p${index + 1}.svg`] = strToU8(serialize(page.root)); });
    downloadBlob(new Blob([zipSync(files) as BlobPart], { type: "application/zip" }), `${filename}.zip`);
    return;
  }
  // One page at a time: a page's raster is tens of megabytes at print resolution, and it is let
  // go before the next is drawn; a turn of the event loop between pages keeps the tab responsive.
  if (format === "png") {
    if (composed.length === 1) {
      downloadBlob(await pngBlob(await rasterizeSvg(composed[0], dpi), dpi), `${filename}.png`);
      return;
    }
    const files: Record<string, Uint8Array> = {};
    for (const [index, page] of composed.entries()) {
      const raster = await rasterizeSvg(page, dpi);
      files[`${filename}-p${index + 1}.png`] = new Uint8Array(await (await pngBlob(raster, dpi)).arrayBuffer());
      await nextTurn();
    }
    downloadBlob(new Blob([zipSync(files) as BlobPart], { type: "application/zip" }), `${filename}.zip`);
    return;
  }
  // The PDF page is the physical page, each page at its own size once cropped. It is written as
  // vector art, axes, gates and text as such and the events image embedded at the sheet's dpi;
  // a page the writer cannot take is drawn as one raster instead, deflated, since jsPDF stores
  // an image uncompressed unless told otherwise, at fifty times the size. The document is in
  // points, the unit the writer measures text in: in any other unit it scales an em offset such
  // as the one under every tick label by the unit's factor, and the labels drop off the axis.
  const pageSize = (page: ComposedPage) => {
    const width = page.widthMm * PT_PER_MM, height = page.heightMm * PT_PER_MM;
    return { width, height, orientation: width >= height ? "landscape" as const : "portrait" as const };
  };
  const { jsPDF } = await import("jspdf");
  const first = pageSize(composed[0]);
  // With the document compressed, jsPDF deflates the images the writer embeds as well.
  const pdf = new jsPDF({ orientation: first.orientation, unit: "pt", format: [first.width, first.height], compress: true });
  for (const [index, page] of composed.entries()) {
    const { width, height, orientation } = pageSize(page);
    if (index > 0) pdf.addPage([width, height], orientation);
    if (!(await pdfVectorPage(pdf, page.root, { width, height }))) {
      const raster = await rasterizeSvg(page, dpi);
      pdf.addImage(raster, "PNG", 0, 0, width, height, undefined, "FAST");
    }
    await nextTurn();
  }
  pdf.save(`${filename}.pdf`);
}

/** Write the sheet as it is on the canvas now, every page of its grid. */
export async function exportLayoutSheet(
  canvas: HTMLElement,
  sheet: LayoutSheet,
  format: LayoutExportFormat,
  options: ComposeOptions,
): Promise<void> {
  await writeComposedPages(composeSheetPages(canvas, sheet, options), sheet, format);
}
