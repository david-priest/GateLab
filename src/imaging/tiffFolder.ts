// tiffFolder.ts — a folder of TIFFs from the BD CellView Image Extractor (or FlowJo) as a cell
// image source. The extractor writes one TIFF per imaged event, named `<tube>_<8-digit FCS event
// index>.tiff`, into subfolders of ten thousand events named `00000000`, `00010000`, …; each TIFF
// holds one float32 page per image channel, `[time][carrier]`, 104 carriers wide, named by its
// PageName tag in the waveform file's slot order (LightLoss, FSC, SSC, the fluorescence filters).
// GateLab's planes are `[carrier][time]`, so a page is transposed into a plane; BD's light-loss
// page is already transmitted light, so it is taken as written.

import { IMAGE_ROWS, type ImagePlanes } from "./cvwDecode";
import type { TiffPage } from "./tiff";

export interface TiffNaming {
  readonly prefix: string;
  readonly digits: number;
  readonly suffix: string;
  /** Files in `00000000`-style subfolders of ten thousand, or straight in the folder. */
  readonly layout: "subfolders" | "flat";
}

export const TIFF_SUBFOLDER_SPAN = 10000;
/** The first slot a page maps to: the extractor's page order is the waveform file's slot order from 2. */
export const TIFF_FIRST_SLOT = 2;
/** Column pitch over row pitch of an extracted image: one column per 64 samples, as the file's resolution tags say. */
export const TIFF_ASPECT = 1.2;

const NAME = /^(.*?)(\d{6,})(\.tiff?)$/i;

/** The naming an extracted file follows, from one file name; null when it is not one. */
export function inferTiffNaming(fileName: string, layout: TiffNaming["layout"] = "subfolders"): TiffNaming | null {
  const m = NAME.exec(fileName);
  if (!m) return null;
  return { prefix: m[1], digits: m[2].length, suffix: m[3], layout };
}

/** The FCS event index a file name carries under `naming`, or null when the name is not one of its files. */
export function tiffEventIndexOf(fileName: string, naming: TiffNaming): number | null {
  if (!fileName.startsWith(naming.prefix) || !fileName.toLowerCase().endsWith(naming.suffix.toLowerCase())) return null;
  const middle = fileName.slice(naming.prefix.length, fileName.length - naming.suffix.length);
  if (!/^\d+$/.test(middle)) return null;
  return Number(middle);
}

export function tiffFileNameFor(naming: TiffNaming, eventIndex: number): string {
  return `${naming.prefix}${String(eventIndex).padStart(naming.digits, "0")}${naming.suffix}`;
}

/** The subfolder an event's file sits in: the floor of its index to ten thousand, eight digits. */
export function tiffSubfolderFor(eventIndex: number): string {
  return String(Math.floor(eventIndex / TIFF_SUBFOLDER_SPAN) * TIFF_SUBFOLDER_SPAN).padStart(8, "0");
}

/** Slot → channel name, from the pages' names in order. */
export function tiffChannelNames(pages: readonly TiffPage[]): Map<number, string> {
  const names = new Map<number, string>();
  pages.forEach((page, k) => names.set(TIFF_FIRST_SLOT + k, page.name || `Channel ${TIFF_FIRST_SLOT + k}`));
  return names;
}

/** The light-loss page's slot, by name; null when no page is one. */
export function tiffLightLossSlot(pages: readonly TiffPage[]): number | null {
  const k = pages.findIndex((page) => /^lightloss/i.test(page.name));
  return k < 0 ? null : TIFF_FIRST_SLOT + k;
}

/**
 * The pages as planes: every page, or the `slots` asked for; each transposed from `[time][carrier]`
 * to `[carrier][time]`. A page that is not 104 carriers wide is taken as it is, carrier rows being
 * whatever it has.
 */
export function planesFromTiff(pages: readonly TiffPage[], options: { slots?: readonly number[] } = {}): ImagePlanes {
  if (pages.length === 0) throw new Error("the TIFF holds no pages");
  const wanted = options.slots ?? pages.map((_, k) => TIFF_FIRST_SLOT + k);
  const first = pages[0];
  const rows = first.width;
  const cols = first.height;
  const planes: Float32Array[] = [];
  const slots: number[] = [];
  for (const slot of wanted) {
    const page = pages[slot - TIFF_FIRST_SLOT];
    if (!page) continue;
    const plane = new Float32Array(rows * cols);
    const w = Math.min(page.width, rows);
    const h = Math.min(page.height, cols);
    for (let t = 0; t < h; t++) {
      const row = t * page.width;
      for (let c = 0; c < w; c++) plane[c * cols + t] = page.data[row + c];
    }
    planes.push(plane);
    slots.push(slot);
  }
  const aspect = first.xResolution && first.yResolution && first.xResolution > 0 ? first.yResolution / first.xResolution : TIFF_ASPECT;
  return { rows, cols, planes, slots, aspect: Number.isFinite(aspect) && aspect > 0 ? aspect : TIFF_ASPECT };
}

export { IMAGE_ROWS as TIFF_CARRIERS };
