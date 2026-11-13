// placedImage.ts — placed images on a Layout page: reading a file into an `image` item (its type
// told from its bytes, its natural size read from them, the 8 MB limit), its frame on the page,
// and the SVG made safe. A placed SVG is untrusted: the page draws it only through an <img> of a
// data URL, which runs no script, and the export embeds it only after `sanitizePlacedSvg` has
// removed scripts, foreignObject, event handlers, animation, and every reference out of the file
// other than a fragment or an embedded image, with its ids and style rules confined to it.

import { mmToPx, pageSizePx, type LayoutPage } from "../../engine/layout";
import type { LayoutImageMediaType, LayoutPlacedImageRecipe } from "../../engine/placedImageBlock";

type Translate = (source: string, values?: Readonly<Record<string, string | number>>) => string;

/** The largest file that can be placed, in bytes: the workspace file holds it. */
export const PLACED_IMAGE_BYTES_LIMIT = 8 * 1024 * 1024;
/** What the file picker offers. A PDF page is not offered: the app has no PDF reader to draw one. */
export const PLACED_IMAGE_ACCEPT = ".svg,.png,.jpg,.jpeg,image/svg+xml,image/png,image/jpeg";

const SVG_NS = "http://www.w3.org/2000/svg";

/** A size in bytes as people read it: 812 B, 34 KB, 1.2 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The bytes the workspace file spends on an image: its SVG text in UTF-8, or its data URL. */
export function storedBytes(recipe: Pick<LayoutPlacedImageRecipe, "content">): number {
  return new TextEncoder().encode(recipe.content).length;
}

/** The type of a file from its first bytes: a PNG or JPEG by its signature, an SVG by an <svg> element near the start. */
export function sniffMediaType(bytes: Uint8Array): LayoutImageMediaType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = new TextDecoder().decode(bytes.subarray(0, 4096));
  return /<svg[\s>]/i.test(head) ? "image/svg+xml" : null;
}

/** A PNG's or JPEG's size in pixels, read from its header; null when the header is not there. */
export function bitmapNaturalSize(bytes: Uint8Array, mediaType: "image/png" | "image/jpeg"): { width: number; height: number } | null {
  if (mediaType === "image/png") {
    if (bytes.length < 24) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16), height = view.getUint32(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  // A JPEG: the frame header (SOFn) after the markers before it.
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return null;
}

const UNIT_PX: Record<string, number> = { "": 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };

/** An SVG length in px; null for a percentage, an em, or anything not a length. */
function svgLength(value: string | null): number | null {
  const match = value?.trim().match(/^([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)\s*(px|pt|pc|mm|cm|in)?$/i);
  if (!match) return null;
  const px = Number(match[1]) * UNIT_PX[(match[2] ?? "").toLowerCase()];
  return Number.isFinite(px) && px > 0 ? px : null;
}

function viewBoxOf(svg: Element): { width: number; height: number } | null {
  const parts = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  return parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0 ? { width: parts[2], height: parts[3] } : null;
}

/** An SVG's own size in px: its width and height, or what its viewBox gives; 300 × 150, a browser's default, failing both. */
export function svgNaturalSize(svg: Element): { width: number; height: number } {
  const width = svgLength(svg.getAttribute("width"));
  const height = svgLength(svg.getAttribute("height"));
  const box = viewBoxOf(svg);
  const round = (value: number) => Math.round(value * 100) / 100;
  if (width && height) return { width: round(width), height: round(height) };
  if (box && width) return { width: round(width), height: round((width * box.height) / box.width) };
  if (box && height) return { width: round((height * box.width) / box.height), height: round(height) };
  if (box) return { width: round(box.width), height: round(box.height) };
  return { width: width ?? 300, height: height ?? 150 };
}

/** The SVG element of a text, parsed; null when it is not well-formed SVG. */
function parseSvg(text: string): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName !== "svg" || root.namespaceURI !== SVG_NS || doc.getElementsByTagName("parsererror").length) return null;
  return root as unknown as SVGSVGElement;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export type PlacedImageRead = { recipe: LayoutPlacedImageRecipe } | { error: string };

/**
 * A file as a placed image: refused over the size limit, or when it is not an SVG, PNG or JPEG
 * (told from its bytes, not its name) or cannot be read as one.
 */
export async function readPlacedImage(file: File, t: Translate): Promise<PlacedImageRead> {
  if (file.size > PLACED_IMAGE_BYTES_LIMIT) {
    return { error: t("{name} is {size}; a placed image can be at most {limit}.", { name: file.name, size: formatBytes(file.size), limit: formatBytes(PLACED_IMAGE_BYTES_LIMIT) }) };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaType = sniffMediaType(bytes);
  if (!mediaType) return { error: t("{name} is not an SVG, PNG or JPEG file.", { name: file.name }) };
  const fileName = file.name || "image";
  if (mediaType === "image/svg+xml") {
    const content = new TextDecoder().decode(bytes);
    const svg = parseSvg(content);
    if (!svg) return { error: t("{name} could not be read as SVG.", { name: file.name }) };
    const size = svgNaturalSize(svg);
    return { recipe: { kind: "image", fileName, mediaType, naturalWidth: size.width, naturalHeight: size.height, content } };
  }
  const size = bitmapNaturalSize(bytes, mediaType);
  if (!size) return { error: t("{name} could not be read as {type}.", { name: file.name, type: mediaType === "image/png" ? "PNG" : "JPEG" }) };
  return { recipe: { kind: "image", fileName, mediaType, naturalWidth: size.width, naturalHeight: size.height, content: `data:${mediaType};base64,${base64(bytes)}` } };
}

/** Ask for a file with the system's file picker; null when none is chosen. */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = PLACED_IMAGE_ACCEPT;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

/**
 * The frame an image is placed in: its natural size in px, scaled down to fit inside the page's
 * margins when it is larger, its proportions kept.
 */
export function placedImageFrame(recipe: Pick<LayoutPlacedImageRecipe, "naturalWidth" | "naturalHeight">, page: LayoutPage): { width: number; height: number } {
  const size = pageSizePx(page);
  const margin = mmToPx(page.marginMm);
  const room = { width: Math.max(1, size.width - 2 * margin), height: Math.max(1, size.height - 2 * margin) };
  const scale = Math.min(1, room.width / recipe.naturalWidth, room.height / recipe.naturalHeight);
  // Scaled down, it is rounded down, so it stays inside the margins.
  const px = (value: number) => Math.max(1, scale < 1 ? Math.floor(value * scale + 1e-6) : Math.round(value));
  return { width: px(recipe.naturalWidth), height: px(recipe.naturalHeight) };
}

/** Elements that run code, load other documents or change the drawing over time: removed whole. */
const REMOVED_ELEMENTS = new Set(["script", "foreignobject", "iframe", "object", "embed", "audio", "video", "handler", "listener", "set", "animate", "animatemotion", "animatetransform", "animatecolor"]);
/** A url(…) that is neither a fragment nor an embedded image. */
const EXTERNAL_URL = /url\(\s*(['"]?)(?!\s*#|\s*data:image\/)[^)]*\1\s*\)/gi;

const safeHref = (value: string) => /^\s*(#|data:image\/)/i.test(value);

function rewriteIds(text: string, ids: ReadonlyMap<string, string>): string {
  return text.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (whole, quote: string, id: string) => (ids.has(id) ? `url(${quote}#${ids.get(id)}${quote})` : whole));
}

/** A style sheet's rules confined to the element `scope`: each selector under it, its ids renamed; @import dropped. */
function scopeStyleSheet(css: string, scope: string | undefined, ids: ReadonlyMap<string, string>): string {
  const withoutImports = css.replace(/@import[^;]*;?/gi, "").replace(EXTERNAL_URL, "none");
  return rewriteIds(withoutImports, ids).replace(/([^{}]*)\{/g, (whole, prelude: string) => {
    const trimmed = prelude.trim();
    if (!trimmed || trimmed.startsWith("@")) return whole;
    const renamed = prelude.replace(/#([A-Za-z_][\w-]*)/g, (match, id: string) => (ids.has(id) ? `#${ids.get(id)}` : match));
    if (!scope) return `${renamed}{`;
    const lead = prelude.match(/^\s*/)?.[0] ?? "";
    return `${lead}${renamed.trim().split(",").map((selector) => `#${scope} ${selector.trim()}`).join(", ")} {`;
  });
}

/**
 * A placed SVG made safe to embed, as a detached <svg> element, or null when the text is not
 * well-formed SVG. Removed: scripts, foreignObject and the other elements in REMOVED_ELEMENTS,
 * every event-handler attribute (on…), every href or xlink:href that is not a fragment (#id) or
 * a data:image/ URL, every url(…) of anything else, and @import. With `idPrefix`, every id is
 * prefixed and the references to it follow; with `scope`, the element gets that id and its style
 * sheets apply only inside it. The drawing stretches to whatever size it is given (its viewBox
 * the natural size when it had none), as the page draws it.
 */
export function sanitizePlacedSvg(
  text: string,
  options: { idPrefix?: string; scope?: string; natural?: { width: number; height: number } } = {},
): SVGSVGElement | null {
  const svg = parseSvg(text);
  if (!svg) return null;
  for (const element of [...svg.querySelectorAll("*")]) if (REMOVED_ELEMENTS.has(element.localName.toLowerCase())) element.remove();
  const elements = [svg, ...svg.querySelectorAll("*")];
  const ids = new Map<string, string>();
  if (options.idPrefix) for (const element of elements) {
    const id = element.getAttribute("id");
    if (id) ids.set(id, `${options.idPrefix}${id}`);
  }
  for (const element of elements) {
    for (const attr of [...element.attributes]) {
      const name = attr.localName.toLowerCase();
      if (name.startsWith("on")) { element.removeAttributeNode(attr); continue; }
      if (name === "href") {
        if (!safeHref(attr.value)) { element.removeAttributeNode(attr); continue; }
        const target = attr.value.trim().slice(1);
        if (attr.value.trim().startsWith("#") && ids.has(target)) attr.value = `#${ids.get(target)}`;
        continue;
      }
      if (name === "id" && ids.has(attr.value)) { attr.value = ids.get(attr.value)!; continue; }
      if (/url\(/i.test(attr.value)) attr.value = rewriteIds(attr.value.replace(EXTERNAL_URL, "none"), ids);
    }
    if (element.localName === "style") element.textContent = scopeStyleSheet(element.textContent ?? "", options.scope, ids);
  }
  const natural = options.natural ?? svgNaturalSize(svg);
  if (!viewBoxOf(svg)) svg.setAttribute("viewBox", `0 0 ${natural.width} ${natural.height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  if (options.scope) svg.setAttribute("id", options.scope);
  return svg;
}

/**
 * What the page's <img> shows: a bitmap's data URL as stored, an SVG made safe as above at its
 * natural size, as a data URL. An SVG that does not parse shows nothing.
 */
export function placedImageSrc(recipe: LayoutPlacedImageRecipe): string {
  if (recipe.mediaType !== "image/svg+xml") return recipe.content;
  const svg = sanitizePlacedSvg(recipe.content, { natural: { width: recipe.naturalWidth, height: recipe.naturalHeight } });
  if (!svg) return "";
  svg.setAttribute("width", String(recipe.naturalWidth));
  svg.setAttribute("height", String(recipe.naturalHeight));
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
}

/** The SVG text of the page's <img> source, for the export; null for a bitmap. */
export function svgTextOfSrc(src: string): string | null {
  const prefix = "data:image/svg+xml;charset=utf-8,";
  if (!src.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(src.slice(prefix.length));
  } catch {
    return null;
  }
}
