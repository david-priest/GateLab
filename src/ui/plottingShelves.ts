// plottingShelves.ts — a Plotting chart's dimensions on the "Arrange dimensions" shelves, read
// from and written to its settings: `xAxis` is the Along x shelf, `panelColumns` the Columns shelf,
// `panelRows` the Rows shelf and `pageBy` the Pages shelf; a panel dimension on no shelf wraps `panelsPerRow` to a row
// (with a dimension on Columns it runs down the rows, with one on Rows only across the columns).
// A saved chart is shown on the shelves as it draws.

import type { ProportionsSettings } from "../engine/proportionsSettings";
import { chartPanelDimensions, type PanelDimension } from "./panelArrangement";

/** A chart's dimensions: its populations, its groups and, when one is set, its facet. */
export type ChartDimension = PanelDimension;

export type ChartShelf = "x" | "columns" | "rows" | "pages" | "wrap";

export type ChartShelfSettings = Pick<ProportionsSettings, "valueKind" | "plotType" | "xAxis" | "panelColumns"> & Partial<Pick<ProportionsSettings, "panelRows" | "pageBy" | "channel" | "channels" | "populationsTogether">>;

type ShelfPatch = Partial<Pick<ProportionsSettings, "xAxis" | "panelColumns" | "panelRows" | "pageBy">>;

export interface ChartShelves {
  /** The dimension along each panel's x axis. */
  x: ChartDimension[];
  columns: ChartDimension[];
  rows: ChartDimension[];
  /** A page per value, one page drawn at a time. */
  pages: ChartDimension[];
  wrap: ChartDimension[];
  /** A stacked bar's populations are its stack, fixed. */
  stack: boolean;
}

/** Whether the chart runs its populations or its groups along x by choice: a per-cell or statistic chart. */
function xChosen(settings: Pick<ProportionsSettings, "valueKind">): boolean {
  return settings.valueKind !== "proportion";
}

/** The dimension a chart draws along x: a proportion chart always its groups. */
function xDimension(settings: Pick<ProportionsSettings, "valueKind" | "xAxis">): ChartDimension {
  return xChosen(settings) ? settings.xAxis : "groups";
}

/** Where each of the chart's dimensions sits. */
export function chartShelves(settings: ChartShelfSettings, hasFacet: boolean): ChartShelves {
  const panels = chartPanelDimensions(settings, hasFacet);
  const columns = settings.panelColumns && panels.includes(settings.panelColumns) ? [settings.panelColumns] : [];
  const rows = settings.panelRows && settings.panelRows !== settings.panelColumns && panels.includes(settings.panelRows) ? [settings.panelRows] : [];
  const pages = settings.pageBy && !columns.includes(settings.pageBy) && !rows.includes(settings.pageBy) && panels.includes(settings.pageBy) ? [settings.pageBy] : [];
  return {
    x: [xDimension(settings)],
    columns,
    rows,
    pages,
    wrap: panels.filter((dimension) => !columns.includes(dimension) && !rows.includes(dimension) && !pages.includes(dimension)),
    stack: settings.valueKind === "proportion" && settings.plotType === "stacked",
  };
}

/** Whether a dimension can be moved at all: a proportion chart's groups and a stacked bar's populations cannot. */
export function chartDimensionMovable(settings: ChartShelfSettings, dimension: ChartDimension): boolean {
  if (xChosen(settings)) return true;
  if (dimension === "groups") return false;
  return !(dimension === "populations" && settings.plotType === "stacked");
}

/**
 * Whether a dimension may go to a shelf: only the populations or the groups run along x, and only
 * by choice; the channels are drawn on panels of their own, each with its own value axis.
 */
export function chartShelfAllowed(settings: ChartShelfSettings, dimension: ChartDimension, shelf: ChartShelf): boolean {
  if (!chartDimensionMovable(settings, dimension)) return false;
  if (shelf === "x") return xChosen(settings) && dimension !== "facet" && dimension !== "channels";
  return true;
}

/**
 * The settings that put a dimension on a shelf. Along x holds one dimension: the populations and
 * the groups change places, the one leaving x taking the place the other had.
 */
export function placeChartDimension(
  settings: ChartShelfSettings,
  hasFacet: boolean,
  dimension: ChartDimension,
  shelf: ChartShelf,
): ShelfPatch {
  if (!chartShelfAllowed(settings, dimension, shelf)) return {};
  const now = chartShelves(settings, hasFacet);
  const onColumns = now.columns[0] ?? "";
  const onRows = now.rows[0] ?? "";
  const onPages = now.pages[0] ?? "";
  if (shelf === "x") {
    if (now.x[0] === dimension) return {};
    const leaving = now.x[0];
    return {
      xAxis: dimension as ProportionsSettings["xAxis"],
      ...(onColumns === dimension ? { panelColumns: leaving } : {}),
      ...(onRows === dimension ? { panelRows: leaving } : {}),
      ...(onPages === dimension ? { pageBy: leaving } : {}),
    };
  }
  const patch: ShelfPatch = {};
  // Leaving x, the populations or the groups give it to the other, which leaves its own shelf.
  const comingToX = now.x[0] === dimension ? (dimension === "populations" ? "groups" : "populations") : null;
  if (comingToX) patch.xAxis = comingToX;
  const leaves = (held: string) => held === dimension || (!!comingToX && held === comingToX);
  if (shelf === "columns") patch.panelColumns = dimension;
  else if (leaves(onColumns)) patch.panelColumns = "";
  if (shelf === "rows") patch.panelRows = dimension;
  else if (leaves(onRows)) patch.panelRows = "";
  if (shelf === "pages") patch.pageBy = dimension;
  else if (leaves(onPages)) patch.pageBy = "";
  return patch;
}
