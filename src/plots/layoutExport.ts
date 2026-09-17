// layoutExport.ts — export a Layout sheet as SVG, PNG or PDF. The page is composed the way the
// Strategy and Illustration grids are (gridExport.ts): every plot's data layer is re-rendered at
// the export resolution and embedded as an image, its axes and gates stay vector from the cell's
// own <svg>, and text blocks and titles become <text>. The page is the sheet's physical size.

import { zipSync, strToU8 } from "fflate";
import { cellDataUrlAtDpi, rasterizeSvg } from "./gridExport";
import type { LayoutSheet } from "../engine/layout";
import { pageOrigins, pageSizeMm, pageSizePx } from "../engine/layout";
import { sanitizeFilePart } from "../engine/fcsExport";

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

function textLines(root: SVGSVGElement, lines: readonly string[], left: number, top: number, fontSize: number, style: CSSStyleDeclaration) {
  const lineHeight = fontSize * 1.3;
  lines.forEach((line, index) => {
    if (!line) return;
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(left));
    t.setAttribute("y", String(top + index * lineHeight + fontSize * 0.82));
    t.setAttribute("font-size", String(fontSize));
    t.setAttribute("font-family", style.fontFamily || "Arial, Helvetica, sans-serif");
    t.setAttribute("font-weight", style.fontWeight || "400");
    t.setAttribute("fill", style.color || "#1e293b");
    t.setAttribute("xml:space", "preserve");
    t.textContent = line;
    root.appendChild(t);
  });
}

/** One plot cell: the data layer as an image at `dpi`, the cell's own <svg> (axes, gates) on top. */
function addCell(root: SVGSVGElement, cell: HTMLElement, origin: DOMRect, zoom: number, dpi: number, offset: { x: number; y: number }) {
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
  if (svg) g.appendChild(svg.cloneNode(true));
  root.appendChild(g);
}

/**
 * Compose one page of the sheet's canvas element into an SVG the size of the page. Items are
 * taken in stacking order from the live DOM; `zoom` is the on-screen scale, so the composition
 * is the same at any zoom; `pageIndex` picks a page of the sheet's grid (row-major). Anything
 * beyond the page is clipped by the page.
 */
export function composeLayoutSVG(
  canvas: HTMLElement,
  sheet: LayoutSheet,
  options: { dpi: number; zoom: number; pageIndex?: number },
): { root: SVGSVGElement; width: number; height: number } {
  const { width, height } = pageSizePx(sheet.page);
  const offset = pageOrigins(sheet.page)[options.pageIndex ?? 0] ?? { x: 0, y: 0 };
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

  const origin = canvas.getBoundingClientRect();
  const items = [...canvas.querySelectorAll<HTMLElement>(".gl-layout-item")]
    .sort((a, b) => (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0));
  for (const item of items) {
    const frame = pageRect(item, origin, options.zoom, offset);
    // An item wholly outside this page is left to the page it is on.
    if (frame.left >= width || frame.top >= height || frame.left + frame.width <= 0 || frame.top + frame.height <= 0) continue;
    if (item.classList.contains("has-frame")) {
      const r = document.createElementNS(SVG_NS, "rect");
      r.setAttribute("x", String(Math.round(frame.left) + 0.5));
      r.setAttribute("y", String(Math.round(frame.top) + 0.5));
      r.setAttribute("width", String(Math.round(frame.width) - 1));
      r.setAttribute("height", String(Math.round(frame.height) - 1));
      r.setAttribute("fill", "none");
      r.setAttribute("stroke", "#94a3b8");
      root.appendChild(r);
    }
    const text = item.querySelector<HTMLTextAreaElement | HTMLElement>(".gl-layout-text-surface");
    if (text) {
      const content = text instanceof HTMLTextAreaElement ? text.value : (text.textContent ?? "");
      const style = getComputedStyle(text);
      const rect = pageRect(text, origin, options.zoom, offset);
      const fontSize = parseFloat(style.fontSize) || 14;
      const padLeft = parseFloat(style.paddingLeft) || 0;
      const padTop = parseFloat(style.paddingTop) || 0;
      textLines(root, content.split("\n"), rect.left + padLeft, rect.top + padTop, fontSize, style);
      continue;
    }
    const host = item.querySelector<HTMLElement>(".gl-layout-plot-host");
    if (!host) continue;
    if ((host as unknown as { __miniPlotCfg?: unknown }).__miniPlotCfg) {
      addCell(root, host, origin, options.zoom, options.dpi, offset);
      continue;
    }
    // A strategy block: a grid of cells with an HTML title.
    host.querySelectorAll<HTMLElement>(".strategy-context-title").forEach((title) => {
      const style = getComputedStyle(title);
      const rect = pageRect(title, origin, options.zoom, offset);
      textLines(root, [title.textContent ?? ""], rect.left, rect.top, parseFloat(style.fontSize) || 12, style);
    });
    host.querySelectorAll<HTMLElement>(".mini-plot-cell").forEach((cell) => addCell(root, cell, origin, options.zoom, options.dpi, offset));
  }
  return { root, width, height };
}

function serialize(root: SVGSVGElement): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(root);
}

async function pngBlob(raster: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) =>
    raster.toBlob((value) => (value ? resolve(value) : reject(new Error("PNG export failed"))), "image/png"));
}

export interface ComposedPage {
  root: SVGSVGElement;
  width: number;
  height: number;
}

/** Every page of the sheet's grid, composed from the canvas as it is now. */
export function composeSheetPages(canvas: HTMLElement, sheet: LayoutSheet, options: { zoom: number }): ComposedPage[] {
  return pageOrigins(sheet.page).map((_, pageIndex) => composeLayoutSVG(canvas, sheet, { dpi: sheet.page.dpi, zoom: options.zoom, pageIndex }));
}

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
  const rasters: HTMLCanvasElement[] = [];
  for (const page of composed) rasters.push(await rasterizeSvg(page, dpi));
  if (format === "png") {
    if (rasters.length === 1) {
      downloadBlob(await pngBlob(rasters[0]), `${filename}.png`);
      return;
    }
    const files: Record<string, Uint8Array> = {};
    for (const [index, raster] of rasters.entries()) {
      files[`${filename}-p${index + 1}.png`] = new Uint8Array(await (await pngBlob(raster)).arrayBuffer());
    }
    downloadBlob(new Blob([zipSync(files) as BlobPart], { type: "application/zip" }), `${filename}.zip`);
    return;
  }
  // The PDF page is the physical page; the raster inside it carries the resolution.
  const { widthMm, heightMm } = pageSizeMm(sheet.page);
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: widthMm >= heightMm ? "landscape" : "portrait", unit: "mm", format: [widthMm, heightMm] });
  rasters.forEach((raster, index) => {
    if (index > 0) pdf.addPage([widthMm, heightMm], widthMm >= heightMm ? "landscape" : "portrait");
    pdf.addImage(raster.toDataURL("image/png"), "PNG", 0, 0, widthMm, heightMm);
  });
  pdf.save(`${filename}.pdf`);
}

/** Write the sheet as it is on the canvas now, every page of its grid. */
export async function exportLayoutSheet(
  canvas: HTMLElement,
  sheet: LayoutSheet,
  format: LayoutExportFormat,
  options: { zoom: number },
): Promise<void> {
  await writeComposedPages(composeSheetPages(canvas, sheet, options), sheet, format);
}
