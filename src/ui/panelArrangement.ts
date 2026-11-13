// panelArrangement.ts — where a Plotting chart's panels sit: wrapped a set number to a row, or in
// a grid with a column for each value of one of the chart's panel dimensions (the populations, the
// groups or the facets) and a row for each value of another, as an Illustration figure puts files
// across the columns. A grid by rows and columns is headed above each column and beside each row.
// The chart and its Layout block's frame both lay out here.

import type { ProportionsSettings } from "../engine/proportionsSettings";
import type { LayoutProportionsPanel } from "../engine/layout";
import { CHART_TITLE_CHARS } from "./chart/chartFormat";
import { longestLabelWidth } from "./chart/chartLayout";

export type PanelDimension = Exclude<ProportionsSettings["panelColumns"], "">;

/** Gap between panels, in pixels; the chart's CSS grid uses the same. */
export const PANEL_GAP = 12;

export interface PanelArrangement<T> {
  columns: number;
  /** The panels row by row, `columns` to a row; null where a row has no panel for a column. */
  cells: (T | null)[];
  /**
   * In a grid by rows and columns: the dimensions on each, and the heading above each column and
   * beside each row, which the panels' titles then leave out.
   */
  headings?: { column: PanelDimension; row: PanelDimension; columns: string[]; rows: string[] };
}

/** The channels a chart draws: its list, or a chart made before the list its one channel. */
export function chartChannels(settings: Pick<ProportionsSettings, "channel"> & Partial<Pick<ProportionsSettings, "channels">>): string[] {
  return settings.channels?.length ? [...settings.channels] : settings.channel ? [settings.channel] : [];
}

/**
 * The panel dimensions a chart has, in the order its panels run: the outer dimension first. A
 * per-cell or statistic chart of several channels has them outermost, each channel's panels on
 * its own value axis.
 */
export function chartPanelDimensions(
  settings: Pick<ProportionsSettings, "valueKind" | "plotType" | "xAxis"> & Partial<Pick<ProportionsSettings, "channel" | "channels" | "populationsTogether">>,
  hasFacet: boolean,
): PanelDimension[] {
  const dims: PanelDimension[] = hasFacet ? ["facet"] : [];
  if (settings.valueKind !== "proportion" && (settings.channels?.length ?? 0) > 1) dims.unshift("channels");
  if (settings.valueKind === "proportion") {
    // A stacked bar is a panel per facet; a boxplot a panel per facet and population.
    if (settings.plotType !== "stacked") dims.push("populations");
    return dims;
  }
  // A per-cell or statistic chart has a panel per facet and per whatever is not along x; with the
  // populations side by side at each group, a panel per facet only.
  if (settings.xAxis === "groups" && settings.populationsTogether) return dims;
  dims.push(settings.xAxis === "populations" ? "groups" : "populations");
  return dims;
}

/**
 * Arrange panels. With `columnDimension` one of the panels' dimensions, each of its values is a
 * column, in the order the values first appear, and each value of the other dimensions a row; with
 * `rowDimension` one of them, each of its values is a row, and with no column dimension each value
 * of the others a column. With both, the other dimensions' values join the rows, outermost, and the
 * grid is headed by `heading` where given. Otherwise the panels wrap `perRow` to a row in the
 * order given.
 */
export function arrangePanels<T>(
  panels: readonly T[],
  dimensionValue: (panel: T, dimension: PanelDimension) => string,
  dimensions: readonly PanelDimension[],
  columnDimension: ProportionsSettings["panelColumns"],
  perRow: number,
  rowDimension: ProportionsSettings["panelRows"] = "",
  heading?: (panel: T, dimension: PanelDimension) => string,
): PanelArrangement<T> {
  const column = columnDimension && dimensions.includes(columnDimension) ? columnDimension : "";
  const row = rowDimension && rowDimension !== column && dimensions.includes(rowDimension) ? rowDimension : "";
  if (!column && !row) {
    const columns = Math.max(1, Math.min(Math.round(perRow) || 1, panels.length));
    return { columns, cells: [...panels] };
  }
  const others = dimensions.filter((dimension) => dimension !== column && dimension !== row);
  const keyOf = (panel: T, of: readonly PanelDimension[]) => of.map((dimension) => dimensionValue(panel, dimension)).join("\0");
  // The dimensions each axis of the grid is keyed by: the others join the rows, or with a row
  // dimension only, run across the columns.
  const columnDims = column ? [column] : others;
  const rowDims = column ? [...others, ...(row ? [row] : [])] : [row as PanelDimension];
  const columnValues: string[] = [];
  const rowValues: string[] = [];
  const firstOfColumn: T[] = [];
  const firstOfRow: T[] = [];
  for (const panel of panels) {
    const c = keyOf(panel, columnDims);
    const r = keyOf(panel, rowDims);
    if (!columnValues.includes(c)) columnValues.push(c), firstOfColumn.push(panel);
    if (!rowValues.includes(r)) rowValues.push(r), firstOfRow.push(panel);
  }
  const cells: (T | null)[] = new Array(columnValues.length * rowValues.length).fill(null);
  for (const panel of panels) {
    const at = rowValues.indexOf(keyOf(panel, rowDims)) * columnValues.length + columnValues.indexOf(keyOf(panel, columnDims));
    cells[at] ??= panel;
  }
  const arranged: PanelArrangement<T> = { columns: Math.max(1, columnValues.length), cells };
  if (column && row && heading) {
    arranged.headings = {
      column,
      row,
      columns: firstOfColumn.map((panel) => heading(panel, column)),
      rows: firstOfRow.map((panel) => heading(panel, row)),
    };
  }
  return arranged;
}

/** A grid's headings' room: the line above the columns and the width beside the rows, at the font given. */
export function headingSizes(arrangement: PanelArrangement<unknown>, font: number): { top: number; left: number } {
  if (!arrangement.headings) return { top: 0, left: 0 };
  return {
    top: Math.ceil(font * 1.4) + 6,
    left: Math.ceil(Math.min(150, Math.max(40, longestLabelWidth(arrangement.headings.rows, font, CHART_TITLE_CHARS)) + 8)),
  };
}

/** The size of a grid of equal panels, gaps included, with its headings at `headingFont` when it has them. */
export function arrangedSize(arrangement: PanelArrangement<unknown>, panelWidth: number, panelHeight: number, headingFont = 0): { width: number; height: number } {
  const rows = Math.max(1, Math.ceil(arrangement.cells.length / arrangement.columns));
  const headed = arrangement.headings ? headingSizes(arrangement, headingFont) : null;
  return {
    width: arrangement.columns * panelWidth + (arrangement.columns - 1) * PANEL_GAP + (headed ? headed.left + PANEL_GAP : 0),
    height: rows * panelHeight + (rows - 1) * PANEL_GAP + (headed ? headed.top + PANEL_GAP : 0),
  };
}

/** What a chart's titles and headings name its groups, facets and channels by: the columns' names, each channel's label by its key. */
export interface PanelTitles {
  group?: string;
  facet?: string;
  channels?: Readonly<Record<string, string>>;
}

/**
 * What a panel's title says of one of its dimensions: "condition: control" for a group or facet
 * named by its column, the population's name. A grid's heading says the same.
 */
export function panelDimensionText(panel: Pick<PanelValues, "facet" | "group" | "population" | "channel">, dimension: PanelDimension, titles: PanelTitles): string {
  if (dimension === "channels") return titles.channels?.[panel.channel ?? ""] ?? panel.channel ?? "";
  if (dimension === "facet") return titles.facet ? `${titles.facet}: ${panel.facet || "(NA)"}` : panel.facet || "(NA)";
  if (dimension === "groups") return titles.group ? `${titles.group}: ${panel.group ?? ""}` : panel.group ?? "";
  return panel.population ?? "";
}

/**
 * A panel's title in a grid with headings: what it says of its dimensions, the population or group
 * first and the facet last as every chart writes it, without the two the headings say.
 */
export function headedPanelTitle(
  panel: Pick<PanelValues, "facet" | "group" | "population" | "channel">,
  dimensions: readonly PanelDimension[],
  headings: NonNullable<PanelArrangement<unknown>["headings"]>,
  titles: PanelTitles,
): string {
  return [...dimensions]
    .reverse()
    .filter((dimension) => dimension !== headings.column && dimension !== headings.row)
    .map((dimension) => panelDimensionText(panel, dimension, titles))
    .filter(Boolean)
    .join(" · ");
}

/** The value a panel takes on a chart's page dimension: its facet, its group or its population's name. */
export function panelPageValue(panel: Pick<PanelValues, "facet" | "group" | "population" | "channel">, pageBy: PanelDimension): string {
  if (pageBy === "channels") return panel.channel ?? "";
  return pageBy === "facet" ? panel.facet ?? "" : pageBy === "groups" ? panel.group ?? "" : panel.population ?? "";
}

/** The dimension a chart's pages are by: `pageBy` where it is one of the chart's panel dimensions, else none. */
export function chartPageDimension(
  settings: Pick<ProportionsSettings, "valueKind" | "plotType" | "xAxis"> & Partial<Pick<ProportionsSettings, "pageBy" | "channel" | "channels" | "populationsTogether">>,
  hasFacet: boolean,
): PanelDimension | "" {
  return settings.pageBy && chartPanelDimensions(settings, hasFacet).includes(settings.pageBy) ? settings.pageBy : "";
}

/** The panels of one page, in the order given; every panel when the chart has no pages or no page is named. */
export function pagePanels<T>(panels: readonly T[], pageBy: PanelDimension | "", page: string | undefined, values: (panel: T) => Pick<PanelValues, "facet" | "group" | "population" | "channel">): T[] {
  if (!pageBy || page === undefined) return [...panels];
  return panels.filter((panel) => panelPageValue(values(panel), pageBy) === page);
}

/** Whether a block's selector names a whole page: a page and no panel. */
export function isPageSelector(only: LayoutProportionsPanel | undefined): only is { page: string } {
  return !!only && !("legend" in only) && only.page !== undefined && only.facet === undefined && only.group === undefined && only.population === undefined && only.populationId === undefined && only.channel === undefined;
}

/** The page a block's selector names, when it names a whole page. */
export function selectorPage(only: LayoutProportionsPanel | undefined): string | undefined {
  return isPageSelector(only) ? only.page : undefined;
}

/**
 * A page selector as a selector of the panels on the page: its value set on the page dimension's
 * field, which every panel of the page matches (matchingPanels). Any other selector is returned
 * as it is; a page of a chart without pages is the whole chart.
 */
export function pageAsPanels(only: LayoutProportionsPanel | undefined, pageBy: PanelDimension | ""): LayoutProportionsPanel | undefined {
  if (!isPageSelector(only)) return only;
  if (!pageBy) return undefined;
  if (pageBy === "channels") return { channel: only.page };
  return pageBy === "facet" ? { facet: only.page } : pageBy === "groups" ? { group: only.page } : { population: only.page };
}

/** The label a dimension takes in the Panels picker. */
export const PANEL_DIMENSION_LABELS: Record<PanelDimension, string> = {
  populations: "A column per population",
  groups: "A column per group",
  facet: "A column per facet",
  channels: "A column per channel",
};

/** What tells a chart's panels apart: its facet, group and population, the population with its id where the chart has one. */
export interface PanelValues {
  facet: string | null;
  group: string | null;
  population: string | null;
  populationId?: string | null;
  /** The channel's key, in a chart of several channels. */
  channel?: string | null;
}

/**
 * Whether a panel is the one a Layout block of one panel draws: each field the block names is the
 * panel's (its facet, group, population); a field left out matches any. A block that records its
 * population's id matches it by id, so a renamed population still finds its panel; one saved
 * without it matches by name. The legend block draws none.
 */
export function isOnlyPanel(only: LayoutProportionsPanel, panel: PanelValues): boolean {
  if ("legend" in only) return false;
  return (
    (only.channel === undefined || (panel.channel ?? "") === only.channel) &&
    (only.facet === undefined || (panel.facet ?? "") === only.facet) &&
    (only.group === undefined || panel.group === only.group) &&
    (only.populationId !== undefined && panel.populationId
      ? panel.populationId === only.populationId
      : only.population === undefined || panel.population === only.population)
  );
}

/**
 * The panels a block of one panel matches, in the chart's order. Where no panel holds the block's
 * population by id (the population was made again, or another chart was put in its place), its
 * name is looked for instead.
 */
export function matchingPanels<T>(panels: readonly T[], only: LayoutProportionsPanel, values: (panel: T) => PanelValues): T[] {
  if ("legend" in only) return [];
  const matched = panels.filter((panel) => isOnlyPanel(only, values(panel)));
  if (matched.length || only.populationId === undefined) return matched;
  const { populationId: _id, ...byName } = only;
  return panels.filter((panel) => isOnlyPanel(byName, values(panel)));
}

/** What a block of one panel looks for, as its message names it: "treated, CD4_positive". */
export function onlyPanelText(only: LayoutProportionsPanel): string {
  if ("legend" in only) return "";
  if (isPageSelector(only)) return `page ${only.page}`;
  return [only.channel, only.facet, only.group, only.population].filter((part) => part !== undefined && part !== "").join(", ");
}

/**
 * The panels a chart draws: as arranged, or the one panel (or none, for its legend) a Layout block
 * holds. A block that matches several panels draws the first.
 */
export function placedOrOnly<T>(arranged: PanelArrangement<T>, panels: readonly T[], only: LayoutProportionsPanel | undefined, values: (panel: T) => PanelValues): PanelArrangement<T> {
  if (!only) return arranged;
  return { columns: 1, cells: matchingPanels(panels, only, values).slice(0, 1) };
}
