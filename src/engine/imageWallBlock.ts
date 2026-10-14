// imageWallBlock.ts — an image wall as a Layout block: the cells of one population of one file,
// in the order the Images tab showed them, drawn as a grid of cell images under a caption that
// says what they are. The block holds the events it was made from, so it stays what it was when
// added: the file's images are drawn from the waveform file when the page is shown or exported.

import type { ChannelDisplay } from "../imaging/imageWallSettings";

export interface LayoutImageWallRecipe {
  kind: "imagewall";
  sampleId: string;
  /** The file's name, for the caption and for finding the file again. */
  fileName: string;
  populationId: string;
  populationName: string;
  /** The events drawn, in order. */
  events: number[];
  /** Imaged cells in the population, of which `events` are the first. */
  imaged: number;
  /** Cells in the population, imaged or not. */
  populationCount: number;
  /** The channel the wall was sorted by (its key and its label), or "" for event order. */
  sortKey: string;
  sortLabel: string;
  sortDesc: boolean;
  display: ChannelDisplay[];
  exposure: number;
  /** Tile edge in page pixels, and tiles per row. */
  tile: number;
  columns: number;
  title?: string;
  /** A border colour per event under the colouring the wall was sent with, "" for none. */
  tileColours?: string[];
  /** The colouring's classes, drawn as a legend line under the caption. */
  legend?: { label: string; colour: string }[];
  /** Draw the counted objects' outline over each tile, with the mask the wall used. */
  outline?: { slot?: number; fraction?: number };
  /** The range of the sort channel the wall was limited to, as the caption says it. */
  rangeLabel?: string;
}

export const IMAGE_WALL_GAP = 3;
export const IMAGE_WALL_PADDING = 8;
export const IMAGE_WALL_CAPTION = 34;
export const IMAGE_WALL_LEGEND = 16;

/** The caption's height, with the legend line when the block carries one. */
export function imageWallHeader(recipe: Pick<LayoutImageWallRecipe, "legend">): number {
  return IMAGE_WALL_CAPTION + (recipe.legend && recipe.legend.length > 0 ? IMAGE_WALL_LEGEND : 0);
}

/** The block's natural size on the page: the grid at its tile size, plus the caption. */
export function imageWallNaturalSize(recipe: Pick<LayoutImageWallRecipe, "events" | "tile" | "columns" | "legend">): { width: number; height: number } {
  const columns = Math.max(1, recipe.columns);
  const rows = Math.max(1, Math.ceil(recipe.events.length / columns));
  return {
    width: IMAGE_WALL_PADDING * 2 + columns * recipe.tile + (columns - 1) * IMAGE_WALL_GAP,
    height: IMAGE_WALL_PADDING * 2 + imageWallHeader(recipe) + rows * recipe.tile + (rows - 1) * IMAGE_WALL_GAP,
  };
}

/** The caption's two lines: the population, then the file, the counts and the order. */
const plainT = (text: string, vars?: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (match, key: string) => (vars && key in vars ? String(vars[key]) : match));

export function imageWallCaption(recipe: LayoutImageWallRecipe, t: (text: string, vars?: Record<string, string | number>) => string = plainT): [string, string] {
  const title = recipe.title?.trim() || recipe.populationName;
  const shown = recipe.events.length;
  const cells = shown === recipe.imaged
    ? t("{shown} imaged cells of {count}", { shown: shown.toLocaleString(), count: recipe.populationCount.toLocaleString() })
    : t("{shown} of {imaged} imaged cells of {count}", { shown: shown.toLocaleString(), imaged: recipe.imaged.toLocaleString(), count: recipe.populationCount.toLocaleString() });
  const order = recipe.sortKey
    ? t("sorted by {channel} {direction}", { channel: recipe.sortLabel || recipe.sortKey, direction: recipe.sortDesc ? "↓" : "↑" })
    : recipe.sortDesc ? t("latest first") : t("in event order");
  const range = recipe.rangeLabel ? ` · ${recipe.rangeLabel}` : "";
  return [title, `${recipe.fileName} · ${cells} · ${order}${range}`];
}

const finiteInt = (value: unknown, min: number, fallback: number): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, n);
};

/** The recipe as saved in a workspace, checked field by field; null when it is not one. */
export function normalizeImageWallRecipe(candidate: Record<string, unknown>): LayoutImageWallRecipe | null {
  if (candidate.kind !== "imagewall") return null;
  if (typeof candidate.sampleId !== "string" || !candidate.sampleId) return null;
  if (!Array.isArray(candidate.events) || !candidate.events.every((e) => typeof e === "number" && Number.isInteger(e) && e >= 0)) return null;
  if (!Array.isArray(candidate.display)) return null;
  const display = candidate.display.filter((d): d is ChannelDisplay => !!d && typeof d === "object" && typeof (d as ChannelDisplay).slot === "number");
  return {
    kind: "imagewall",
    sampleId: candidate.sampleId,
    fileName: typeof candidate.fileName === "string" ? candidate.fileName : "",
    populationId: typeof candidate.populationId === "string" ? candidate.populationId : "",
    populationName: typeof candidate.populationName === "string" ? candidate.populationName : "",
    events: candidate.events as number[],
    imaged: finiteInt(candidate.imaged, 0, (candidate.events as number[]).length),
    populationCount: finiteInt(candidate.populationCount, 0, 0),
    sortKey: typeof candidate.sortKey === "string" ? candidate.sortKey : "",
    sortLabel: typeof candidate.sortLabel === "string" ? candidate.sortLabel : "",
    sortDesc: candidate.sortDesc === true,
    display,
    exposure: typeof candidate.exposure === "number" && Number.isFinite(candidate.exposure) && candidate.exposure > 0 ? candidate.exposure : 1,
    tile: finiteInt(candidate.tile, 16, 56),
    columns: finiteInt(candidate.columns, 1, 8),
    ...(typeof candidate.title === "string" && candidate.title ? { title: candidate.title } : {}),
    ...(typeof candidate.rangeLabel === "string" && candidate.rangeLabel ? { rangeLabel: candidate.rangeLabel } : {}),
    ...(Array.isArray(candidate.tileColours) && candidate.tileColours.every((c) => typeof c === "string")
      ? { tileColours: candidate.tileColours as string[] }
      : {}),
    ...(candidate.outline && typeof candidate.outline === "object"
      ? { outline: {
          ...(typeof (candidate.outline as { slot?: unknown }).slot === "number" ? { slot: (candidate.outline as { slot: number }).slot } : {}),
          ...(typeof (candidate.outline as { fraction?: unknown }).fraction === "number" ? { fraction: (candidate.outline as { fraction: number }).fraction } : {}),
        } }
      : {}),
    ...(Array.isArray(candidate.legend)
      ? { legend: candidate.legend.filter((l): l is { label: string; colour: string } => !!l && typeof l === "object" && typeof (l as { label?: unknown }).label === "string" && typeof (l as { colour?: unknown }).colour === "string") }
      : {}),
  };
}
