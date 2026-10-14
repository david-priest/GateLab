// cellPanelBlock.ts — the cell panel, a Layout block for the side-by-side figure imaging flow papers
// use: chosen cells as rows and an image channel per column (LightLoss, the fluorescence channels,
// a merge), or the other way round. The block holds the cells and the columns, so it stays what it
// was when made and every part can be edited on the Layout tab: which channels and in what order,
// each in grey or its colour, what the merge holds, a gain per channel, the labels, the tile size.
// The pictures are decoded from the file's images when the page is drawn or exported.

import type { ChannelDisplay } from "../imaging/imageWallSettings";

/** One column: a single channel (by its slot) or the merge of several. */
export interface CellPanelColumn {
  kind: "channel" | "merge";
  /** For a channel column. */
  slot?: number;
  /** For a merge column: the channels it adds, each in its colour. */
  slots?: number[];
  /** The header drawn over the column. */
  header: string;
  /** A channel column drawn in grey rather than its colour (LightLoss reads best so). */
  grey?: boolean;
  /** Switched off: kept with its settings, not drawn. */
  hidden?: boolean;
}

/** The columns drawn, in order. */
export function visibleColumns(recipe: Pick<LayoutCellPanelRecipe, "columns">): CellPanelColumn[] {
  return recipe.columns.filter((c) => !c.hidden);
}

export interface CellPanelCell {
  event: number;
  /** The label drawn beside the cell's row. */
  label: string;
}

export interface LayoutCellPanelRecipe {
  kind: "cellpanel";
  sampleId: string;
  fileName: string;
  cells: CellPanelCell[];
  columns: CellPanelColumn[];
  /** Each channel's colour and black and white points, as the view had them when the panel was made. */
  display: ChannelDisplay[];
  /** A multiplier on one channel's values (slot → gain), on top of `exposure`. */
  gain?: Record<number, number>;
  exposure: number;
  /** Tile edge in page pixels. */
  tile: number;
  /** Cells as columns and channels as rows. */
  transpose?: boolean;
  /** Draw the counted objects' outline (the mask the panel was made with). */
  outline?: boolean;
  /** The mask's channel and threshold, kept so the outline can be switched on later. */
  mask?: { slot?: number; fraction?: number };
  showHeaders?: boolean;
  showLabels?: boolean;
  title?: string;
}

export const CELL_PANEL_GAP = 3;
export const CELL_PANEL_PADDING = 8;
export const CELL_PANEL_TITLE = 18;
export const CELL_PANEL_HEADER = 14;
const LABEL_CHAR = 5.6;

const isLightLoss = (name: string) => /^LightLoss/i.test(name);

/**
 * A panel of `events` with the view's channels as columns: LightLoss first and in grey (the S8's
 * brightfield), then every other channel in its colour, then the merge of the channels the view
 * had switched on other than LightLoss, when there are two or more of them.
 */
export function defaultCellPanel(input: {
  sampleId: string;
  fileName: string;
  cells: CellPanelCell[];
  display: readonly ChannelDisplay[];
  exposure: number;
  mask?: { slot?: number; fraction?: number } | null;
  outline?: boolean;
}): LayoutCellPanelRecipe {
  const display = input.display.map((d) => ({ ...d }));
  const light = display.filter((d) => isLightLoss(d.name));
  const rest = display.filter((d) => !isLightLoss(d.name));
  const columns: CellPanelColumn[] = [
    ...light.map((d) => ({ kind: "channel" as const, slot: d.slot, header: d.name, grey: true })),
    ...rest.map((d) => ({ kind: "channel" as const, slot: d.slot, header: d.name })),
  ];
  const mergeSlots = rest.filter((d) => d.enabled).map((d) => d.slot);
  if (mergeSlots.length >= 2) columns.push({ kind: "merge", slots: mergeSlots, header: "Merge" });
  return {
    kind: "cellpanel",
    sampleId: input.sampleId,
    fileName: input.fileName,
    cells: input.cells.map((c) => ({ ...c })),
    columns,
    display,
    exposure: input.exposure,
    tile: 64,
    ...(input.mask ? { mask: { ...input.mask } } : {}),
    ...(input.outline ? { outline: true } : {}),
    showHeaders: true,
    showLabels: true,
  };
}

/** Where everything sits, at the block's natural size. */
export interface CellPanelGeometry {
  width: number;
  height: number;
  /** Grid rows and columns, after the transpose. */
  rows: number;
  cols: number;
  /** Space left of the grid for row labels, and above it for headers, and the title's band. */
  labelWidth: number;
  headerHeight: number;
  titleHeight: number;
  /** Top-left of the grid. */
  gridX: number;
  gridY: number;
}

export function cellPanelGeometry(recipe: Pick<LayoutCellPanelRecipe, "cells" | "columns" | "tile" | "transpose" | "showHeaders" | "showLabels" | "title">): CellPanelGeometry {
  const transpose = recipe.transpose === true;
  const shown = visibleColumns(recipe);
  const rows = Math.max(1, transpose ? shown.length : recipe.cells.length);
  const cols = Math.max(1, transpose ? recipe.cells.length : shown.length);
  const sideTexts = transpose ? shown.map((c) => c.header) : recipe.cells.map((c) => c.label);
  const showSide = transpose ? recipe.showHeaders !== false : recipe.showLabels !== false;
  const showTop = transpose ? recipe.showLabels !== false : recipe.showHeaders !== false;
  const longest = sideTexts.reduce((m, s) => Math.max(m, s.length), 0);
  const labelWidth = showSide && longest > 0 ? Math.max(28, Math.min(220, Math.round(longest * LABEL_CHAR) + 8)) : 0;
  const headerHeight = showTop ? CELL_PANEL_HEADER : 0;
  const titleHeight = recipe.title && recipe.title.trim() ? CELL_PANEL_TITLE : 0;
  const gridX = CELL_PANEL_PADDING + labelWidth;
  const gridY = CELL_PANEL_PADDING + titleHeight + headerHeight;
  const tile = recipe.tile;
  return {
    width: gridX + cols * tile + (cols - 1) * CELL_PANEL_GAP + CELL_PANEL_PADDING,
    height: gridY + rows * tile + (rows - 1) * CELL_PANEL_GAP + CELL_PANEL_PADDING,
    rows,
    cols,
    labelWidth,
    headerHeight,
    titleHeight,
    gridX,
    gridY,
  };
}

export function cellPanelNaturalSize(recipe: LayoutCellPanelRecipe): { width: number; height: number } {
  const g = cellPanelGeometry(recipe);
  return { width: g.width, height: g.height };
}

/**
 * What one render request asks for, the same for every cell of the panel: the channels with a
 * column of their own (those drawn in grey asked for untinted), and a composite when there is a
 * merge column, made of the merge's channels alone. A channel's gain scales its black and white
 * points, so it brightens that channel in its column and in the merge alike.
 */
export function cellPanelRenderParts(recipe: LayoutCellPanelRecipe): {
  display: ChannelDisplay[];
  channels: number[];
  grey: number[];
  composite: boolean;
} {
  const shown = visibleColumns(recipe);
  const merge = shown.find((c) => c.kind === "merge");
  const inMerge = new Set(merge?.slots ?? []);
  const channels: number[] = [];
  const grey: number[] = [];
  for (const column of shown) {
    if (column.kind !== "channel" || column.slot === undefined || channels.includes(column.slot)) continue;
    channels.push(column.slot);
    if (column.grey) grey.push(column.slot);
  }
  const display = recipe.display.map((d) => {
    const gain = recipe.gain?.[d.slot] ?? 1;
    const g = gain > 0 ? gain : 1;
    return { ...d, enabled: inMerge.has(d.slot), threshold: d.threshold / g, saturation: d.saturation / g };
  });
  return { display, channels, grey, composite: !!merge && inMerge.size > 0 };
}

const finiteInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, n));
};

function normalizeColumn(value: unknown): CellPanelColumn | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  const header = typeof c.header === "string" ? c.header : "";
  const hidden = c.hidden === true ? { hidden: true } : {};
  if (c.kind === "channel" && typeof c.slot === "number" && Number.isInteger(c.slot)) {
    return { kind: "channel", slot: c.slot, header, ...(c.grey === true ? { grey: true } : {}), ...hidden };
  }
  if (c.kind === "merge" && Array.isArray(c.slots) && c.slots.every((s) => typeof s === "number" && Number.isInteger(s))) {
    return { kind: "merge", slots: c.slots as number[], header, ...hidden };
  }
  return null;
}

/** The recipe as saved in a workspace, checked field by field; null when it is not one. */
export function normalizeCellPanelRecipe(candidate: Record<string, unknown>): LayoutCellPanelRecipe | null {
  if (candidate.kind !== "cellpanel") return null;
  if (typeof candidate.sampleId !== "string" || !candidate.sampleId) return null;
  if (!Array.isArray(candidate.cells) || !Array.isArray(candidate.columns) || !Array.isArray(candidate.display)) return null;
  const cells = candidate.cells
    .filter((c): c is { event: number; label?: unknown } => !!c && typeof c === "object" && Number.isInteger((c as { event?: unknown }).event) && (c as { event: number }).event >= 0)
    .map((c) => ({ event: c.event, label: typeof c.label === "string" ? c.label : `Event ${c.event}` }));
  const columns = candidate.columns.map(normalizeColumn).filter((c): c is CellPanelColumn => c !== null);
  const display = (candidate.display as unknown[]).filter((d): d is ChannelDisplay => !!d && typeof d === "object" && typeof (d as ChannelDisplay).slot === "number" && typeof (d as ChannelDisplay).colour === "string") as ChannelDisplay[];
  if (cells.length === 0 || columns.length === 0 || display.length === 0) return null;
  const gain: Record<number, number> = {};
  if (candidate.gain && typeof candidate.gain === "object") {
    for (const [k, v] of Object.entries(candidate.gain as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0 && Number.isInteger(Number(k))) gain[Number(k)] = v;
    }
  }
  const mask = candidate.mask && typeof candidate.mask === "object" ? candidate.mask as { slot?: unknown; fraction?: unknown } : null;
  return {
    kind: "cellpanel",
    sampleId: candidate.sampleId,
    fileName: typeof candidate.fileName === "string" ? candidate.fileName : "",
    cells,
    columns,
    display,
    ...(Object.keys(gain).length ? { gain } : {}),
    exposure: typeof candidate.exposure === "number" && Number.isFinite(candidate.exposure) && candidate.exposure > 0 ? candidate.exposure : 1,
    tile: finiteInt(candidate.tile, 16, 240, 64),
    ...(candidate.transpose === true ? { transpose: true } : {}),
    ...(candidate.outline === true ? { outline: true } : {}),
    ...(mask
      ? { mask: { ...(typeof mask.slot === "number" ? { slot: mask.slot } : {}), ...(typeof mask.fraction === "number" ? { fraction: mask.fraction } : {}) } }
      : {}),
    showHeaders: candidate.showHeaders !== false,
    showLabels: candidate.showLabels !== false,
    ...(typeof candidate.title === "string" && candidate.title ? { title: candidate.title } : {}),
  };
}
