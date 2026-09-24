// exportSvg.ts — what every SVG export shares once its page is composed. An editor such as
// Illustrator reads a unitless width as points, so the root carries the page in millimetres with
// the drawing's own pixel coordinates kept in the viewBox; it substitutes a face of its own for a
// font stack it does not know, so every text names one print font; it shows a group by its id, so
// the groups a figure is edited by are named; and it reads an image reference in the SVG 1.1
// form. Hidden and empty nodes the renderer leaves behind are dropped. The PNG side writes the
// resolution chunk that image tools read a physical size from.

import type { jsPDF } from "jspdf";
import { SCREEN_PX_PER_MM } from "../engine/layout";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

/** The one font an export names: installed everywhere a figure is opened, and a PDF base font. */
export const EXPORT_FONT = "Arial, Helvetica, sans-serif";

export interface ExportSize {
  /** The drawing's size in CSS pixels: what its coordinates are in. */
  widthPx: number;
  heightPx: number;
  /** The physical size; from the pixels at the screen's 96 per inch when not given. */
  widthMm?: number;
  heightMm?: number;
}

const mm = (value: number) => `${Number(value.toFixed(3))}mm`;

/**
 * Finish a composed export: physical units on the root, the viewBox in the drawing's pixels, one
 * font on every text, images referenced as SVG 1.1 readers expect, and nothing hidden or empty.
 * Returns the same element.
 */
export function finishExportSvg(root: SVGSVGElement, size: ExportSize): SVGSVGElement {
  if (!root.getAttribute("viewBox")) root.setAttribute("viewBox", `0 0 ${size.widthPx} ${size.heightPx}`);
  root.setAttribute("width", mm(size.widthMm ?? size.widthPx / SCREEN_PX_PER_MM));
  root.setAttribute("height", mm(size.heightMm ?? size.heightPx / SCREEN_PX_PER_MM));
  root.setAttribute("xmlns", SVG_NS);
  root.setAttributeNS(XMLNS_NS, "xmlns:xlink", XLINK_NS);

  root.querySelectorAll("text").forEach((text) => {
    text.setAttribute("font-family", EXPORT_FONT);
    if (text.style?.fontFamily) text.style.removeProperty("font-family");
  });
  // Weights as the two faces a print font has: bold from 600 up, else normal. A PDF writer and
  // an editor both look a numeric weight up as a face name, and "600" names none.
  root.querySelectorAll<SVGElement>("[font-weight], [style*='font-weight']").forEach((el) => {
    const raw = (el.getAttribute("font-weight") ?? el.style?.fontWeight ?? "").trim();
    el.setAttribute("font-weight", /^(bold|bolder|[6-9]00)$/.test(raw) ? "bold" : "normal");
    if (el.style?.fontWeight) el.style.removeProperty("font-weight");
  });

  root.querySelectorAll("image").forEach((image) => {
    // One reference, in the form every reader takes: a second copy would double a data URL.
    const href = image.getAttribute("href");
    if (href) {
      image.setAttributeNS(XLINK_NS, "xlink:href", href);
      image.removeAttribute("href");
    }
    if (!image.getAttribute("preserveAspectRatio")) image.setAttribute("preserveAspectRatio", "none");
  });

  root.querySelectorAll("[display='none']").forEach((el) => el.remove());
  root.querySelectorAll("[style]").forEach((el) => {
    if (/(^|;)\s*display\s*:\s*none/.test(el.getAttribute("style") ?? "")) el.remove();
  });
  let removed = true;
  while (removed) {
    removed = false;
    root.querySelectorAll("g").forEach((g) => {
      if (!g.firstElementChild) { g.remove(); removed = true; }
    });
  }
  return root;
}

/** Words as an id: letters, digits, hyphens and underscores, the rest folded to one hyphen, and no more than `max` characters. */
export function slugId(text: string, max = 48): string {
  return text
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** `kind-n-words`, the shape every named group takes; the words are left out when they give nothing. */
export function exportId(kind: string, index: number, words = ""): string {
  const slug = slugId(words);
  return slug ? `${kind}-${index}-${slug}` : `${kind}-${index}`;
}

const firstLine = (text: string | null | undefined) => (text ?? "").trim().split(/\r?\n/)[0] ?? "";

/** The title a rendered cell shows: the first text directly under its <svg>. */
export function cellTitle(cell: Element): string {
  const svg = cell.querySelector("svg");
  return firstLine([...(svg?.children ?? [])].find((el) => el.tagName === "text")?.textContent);
}

/**
 * Name the parts of one plot cell for an editor's layers panel: the cell, its events image, its
 * title and axis labels, each axis, and each gate by its name. A gate as the renderer draws it is
 * an outline path followed by its label group, or one quadrant group; each becomes a group of
 * its own so it can be selected and moved whole.
 */
export function nameCell(group: Element, base: string): void {
  group.setAttribute("id", base);
  group.querySelector("image")?.setAttribute("id", `${base}-events`);
  const svg = group.querySelector("svg");
  if (!svg) return;
  [...svg.children].find((el) => el.tagName === "text")?.setAttribute("id", `${base}-title`);
  const plot = [...svg.children].find((el) => el.tagName === "g");
  if (plot) {
    for (const label of [...plot.children].filter((el) => el.tagName === "text")) {
      label.setAttribute("id", `${base}-${label.getAttribute("transform") ? "y" : "x"}-label`);
    }
  }
  svg.querySelector("g.x-axis")?.setAttribute("id", `${base}-x-axis`);
  svg.querySelector("g.y-axis")?.setAttribute("id", `${base}-y-axis`);
  const overlays = svg.querySelector("g.gate-overlays");
  if (!overlays) return;
  overlays.setAttribute("id", `${base}-gates`);
  const children = [...overlays.children];
  let index = 0;
  const gateName = (el: Element) => {
    const text = el.querySelector("text");
    return firstLine(text?.querySelector("tspan")?.textContent ?? text?.textContent);
  };
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (el.tagName === "path") {
      index += 1;
      const gate = document.createElementNS(SVG_NS, "g");
      overlays.insertBefore(gate, el);
      gate.appendChild(el);
      const next = children[i + 1];
      if (next && next.tagName === "g" && !next.classList.contains("quadrant-gate")) {
        gate.appendChild(next);
        i += 1;
      }
      gate.setAttribute("id", exportId(`${base}-gate`, index, gateName(gate)));
    } else if (el.tagName === "g" && el.classList.contains("quadrant-gate")) {
      index += 1;
      el.setAttribute("id", exportId(`${base}-gate`, index, gateName(el)));
    }
  }
}

// ---- PNG resolution

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as PNG chunks carry it. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * The PNG with its resolution written: a pHYs chunk after the header saying how many pixels make
 * a metre, which is what image tools and submission systems read a physical size and a dpi from.
 * A chunk already there is replaced. Bytes that are not a PNG are returned as they are.
 */
export function pngWithResolution(png: Uint8Array, dpi: number): Uint8Array {
  if (png.length < 33 || PNG_SIGNATURE.some((byte, i) => png[i] !== byte)) return png;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const perMetre = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // pHYs
  chunkView.setUint32(8, perMetre);
  chunkView.setUint32(12, perMetre);
  chunk[16] = 1;
  chunkView.setUint32(17, crc32(chunk.subarray(4, 17)));

  // Walk the chunks: a pHYs already present is replaced in place, else the new one follows IHDR.
  let offset = 8;
  let insertAt = -1;
  let replace: { start: number; end: number } | null = null;
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
    const end = offset + 12 + length;
    if (type === "IHDR") insertAt = end;
    if (type === "pHYs") { replace = { start: offset, end }; break; }
    if (type === "IEND") break;
    offset = end;
  }
  if (!replace && insertAt < 0) return png;
  const start = replace ? replace.start : insertAt;
  const end = replace ? replace.end : insertAt;
  const out = new Uint8Array(png.length - (end - start) + chunk.length);
  out.set(png.subarray(0, start), 0);
  out.set(chunk, start);
  out.set(png.subarray(end), start + chunk.length);
  return out;
}

/** The canvas as a PNG blob carrying `dpi` as its resolution. */
export async function pngBlob(canvas: HTMLCanvasElement, dpi: number): Promise<Blob> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("PNG export failed"))), "image/png"));
  const bytes = pngWithResolution(new Uint8Array(await blob.arrayBuffer()), dpi);
  return new Blob([bytes as BlobPart], { type: "image/png" });
}

/**
 * Write `root` onto the PDF's current page as vector art, sized to `size` in the document's
 * unit: axes, gates and text stay paths and text, and the events image is embedded as it is.
 * The element is attached off screen while the writer measures it. False when the writer could
 * not take the page, and the caller draws it as a raster instead.
 */
export async function pdfVectorPage(pdf: jsPDF, root: SVGSVGElement, size: { width: number; height: number }): Promise<boolean> {
  const { svg2pdf } = await import("svg2pdf.js");
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden";
  holder.appendChild(root);
  document.body.appendChild(holder);
  try {
    await svg2pdf(root, pdf, { x: 0, y: 0, width: size.width, height: size.height });
    return true;
  } catch (error) {
    console.warn("GateLab: the PDF writer could not take this page as vector art; it is drawn as an image instead.", error);
    return false;
  } finally {
    holder.remove();
  }
}

/** A turn of the event loop between pages, so a long export leaves the page responsive. */
export const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
