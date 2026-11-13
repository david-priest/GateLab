// placedImageBlock.ts — a placed image on a Layout sheet: an SVG, PNG or JPEG file the user put on
// the page (a schematic, a microscopy panel), held in the workspace with its content, so the file
// needs nothing outside it. An SVG is kept as its text, a bitmap as a data URL. It is an item like
// the others, its frame the box it is drawn in; it draws no data, follows no iteration and has no
// title or sheet style.

export type LayoutImageMediaType = "image/svg+xml" | "image/png" | "image/jpeg";
export const LAYOUT_IMAGE_MEDIA_TYPES: readonly LayoutImageMediaType[] = ["image/svg+xml", "image/png", "image/jpeg"];

export interface LayoutPlacedImageRecipe {
  kind: "image";
  /** The name of the file it was placed from. */
  fileName: string;
  mediaType: LayoutImageMediaType;
  /** Its own size in px: an SVG's width and height (or its viewBox's), a bitmap's pixels. */
  naturalWidth: number;
  naturalHeight: number;
  /** An SVG's text; a bitmap's data URL, `data:<mediaType>;base64,…`. */
  content: string;
  /** A placed image has no title; named so that code reading any block's title reads none. */
  title?: never;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : fallback;
}

/**
 * A placed image as saved: its file name, media type, natural size and content. Null when the
 * media type is not one of the three, or the content is missing or not of that type (a bitmap's
 * content not a base64 data URL of its type, an SVG's not text holding an <svg> element).
 */
export function normalizePlacedImageRecipe(candidate: Record<string, unknown>): LayoutPlacedImageRecipe | null {
  const mediaType = candidate.mediaType as LayoutImageMediaType;
  if (!LAYOUT_IMAGE_MEDIA_TYPES.includes(mediaType)) return null;
  const content = candidate.content;
  if (typeof content !== "string" || !content) return null;
  if (mediaType === "image/svg+xml" ? !/<svg[\s>]/i.test(content) : !content.startsWith(`data:${mediaType};base64,`)) return null;
  return {
    kind: "image",
    fileName: typeof candidate.fileName === "string" && candidate.fileName.trim() ? candidate.fileName.trim() : "image",
    mediaType,
    naturalWidth: positive(candidate.naturalWidth, 300),
    naturalHeight: positive(candidate.naturalHeight, 150),
    content,
  };
}
