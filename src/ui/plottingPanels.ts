// plottingPanels.ts — a Plotting chart as separate Layout blocks, one per panel, placed as the
// tab arranges them, with the legend as a block of its own: what "Add panels" sends to the
// Layout tab. Each block names its panel by facet, group and population, as the chart labels them.

import type { CellValuesModel } from "../engine/cellValuesModel";
import type { LayoutProportionsPanel } from "../engine/layout";
import type { ProportionsModel } from "../engine/proportionsModel";
import type { ProportionsSettings } from "../engine/proportionsSettings";
import { arrangeCellPanels, cellPanels, channelCellPanels, type PlottingLevels } from "./CellValuesChart";
import { arrangePanels, chartChannels, chartPageDimension, chartPanelDimensions, isPageSelector, matchingPanels, pageAsPanels, pagePanels, type PanelValues } from "./panelArrangement";
import { proportionsFactorTitle } from "./PlottingTab";
import { arrangeStatisticPanels, statisticChannelsFrame, statisticChartFrame } from "./StatisticChart";
import { columnValueOrder } from "../engine/levelOrder";
import { chartXAxis } from "./chart/chartXAxis";

export interface PlottingPanelBlock {
  panel: LayoutProportionsPanel;
  /** The block's cell in the arrangement on the tab. */
  row: number;
  column: number;
}

/** Each channel of a chart of several, `channel` first: its key, label and cells (a per-cell chart's, or a statistic chart's pooled by unit). */
export interface PlottingChannelModel {
  key: string;
  label: string;
  model: CellValuesModel;
}

/**
 * A panel's selector: the fields that tell it apart, its channel in a chart of several, its facet
 * only where the chart has facets, its population by name and id. A chart of one panel gives an
 * empty selector.
 */
function selector(panel: PanelValues, hasFacet: boolean): LayoutProportionsPanel {
  return {
    ...(panel.channel ? { channel: panel.channel } : {}),
    ...(hasFacet ? { facet: panel.facet ?? "" } : {}),
    ...(panel.group !== null ? { group: panel.group } : {}),
    ...(panel.population !== null ? { population: panel.population } : {}),
    ...(panel.population !== null && panel.populationId ? { populationId: panel.populationId } : {}),
  };
}

function cellsOf<T>(arranged: { columns: number; cells: (T | null)[] }, toPanel: (panel: T) => LayoutProportionsPanel): PlottingPanelBlock[] {
  return arranged.cells.flatMap((panel, i) =>
    panel ? [{ panel: toPanel(panel), row: Math.floor(i / arranged.columns), column: i % arranged.columns }] : [],
  );
}

/**
 * The chart's panels as Layout blocks, in the tab's arrangement: a proportion chart's (a panel per
 * facet, and per population for a boxplot), a per-cell chart's or a statistic chart's. With pages,
 * the panels of the page named, arranged as the tab draws that page; every panel without one.
 */
export function plottingPanelBlocks(
  settings: ProportionsSettings,
  model: ProportionsModel | null,
  cellModel: CellValuesModel | null,
  /** The chart's order of its groups, facets and replicate units, as the tab draws them. */
  order: PlottingLevels = {},
  page?: string,
  /** A chart of several channels: each channel's cells, `cellModel`'s first. */
  channels?: readonly PlottingChannelModel[],
): PlottingPanelBlock[] {
  const facetTitle = proportionsFactorTitle(settings.facetSel);
  const groupTitle = proportionsFactorTitle(settings.groupSel);
  const parts = channels && channels.length > 1 ? channels : null;
  const keys = parts?.map((part) => part.key);
  const paged = { ...settings, channels: keys ?? chartChannels(settings).slice(0, 1) };
  if (settings.valueKind === "statistic" && cellModel) {
    const plotType = settings.plotType === "bar" ? "bar" : settings.plotType === "dots" ? "dots" : "box";
    const { panels } = parts
      ? statisticChannelsFrame(parts, { ...settings, plotType }, groupTitle, facetTitle, order)
      : statisticChartFrame(cellModel, { ...settings, plotType }, groupTitle, facetTitle, order);
    const shown = pagePanels(panels, chartPageDimension(paged, cellModel.hasFacet), page, (panel) => panel);
    return cellsOf(arrangeStatisticPanels(shown, chartXAxis(settings), cellModel.hasFacet, settings, {}, keys), (panel) => selector(panel, cellModel.hasFacet));
  }
  if (settings.valueKind === "cells" && cellModel) {
    const { panels } = parts
      ? channelCellPanels(parts, chartXAxis(settings), settings.xAxis === "populations" ? groupTitle : undefined, facetTitle, order)
      : cellPanels(cellModel, chartXAxis(settings), settings.xAxis === "populations" ? groupTitle : undefined, facetTitle, order);
    const shown = pagePanels(panels, chartPageDimension(paged, cellModel.hasFacet), page, (panel) => panel);
    return cellsOf(arrangeCellPanels(shown, chartXAxis(settings), cellModel.hasFacet, settings, {}, keys), (panel) => selector(panel, cellModel.hasFacet));
  }
  if (!model) return [];
  const plotType = settings.plotType === "stacked" ? "stacked" : "box";
  const facets = model.hasFacet ? columnValueOrder(model.perSample.map((s) => s.facet ?? ""), order.facets) : [null];
  const list: PanelValues[] = plotType === "box"
    ? facets.flatMap((facet) => model.catLevels.map((population, cat) => ({ facet, group: null, population, populationId: model.levels?.[cat]?.popId ?? null })))
    : facets.map((facet) => ({ facet, group: null, population: null }));
  const arranged = arrangePanels(
    pagePanels(list, chartPageDimension({ ...settings, plotType }, model.hasFacet), page, (panel) => panel),
    (panel, dimension) => (dimension === "facet" ? panel.facet ?? "" : panel.populationId ?? panel.population ?? ""),
    chartPanelDimensions({ valueKind: "proportion", plotType, xAxis: "groups" }, model.hasFacet),
    settings.panelColumns,
    settings.panelsPerRow,
    settings.panelRows,
  );
  return cellsOf(arranged, (panel) => selector(panel, model.hasFacet));
}

/**
 * How many of the chart's panels a block of one panel matches: none leaves the block to say what
 * it looks for, more than one draws the first. A legend block, or a whole chart, counts as one; a
 * block of a page as one when the chart has that page, else none.
 */
export function onlyPanelMatches(
  settings: ProportionsSettings,
  model: ProportionsModel | null,
  cellModel: CellValuesModel | null,
  only: LayoutProportionsPanel | undefined,
  channels?: readonly PlottingChannelModel[],
): number {
  if (!only || "legend" in only) return 1;
  const panels = plottingPanelBlocks(settings, model, cellModel, {}, undefined, channels).flatMap(({ panel }) =>
    "legend" in panel ? [] : [{ facet: panel.facet ?? null, group: panel.group ?? null, population: panel.population ?? null, populationId: panel.populationId ?? null, channel: panel.channel ?? null }],
  );
  if (isPageSelector(only)) {
    const onPage = pageAsPanels(only, chartPageDimension({ ...settings, channels: channels && channels.length > 1 ? channels.map((part) => part.key) : [] }, cellModel ? cellModel.hasFacet : !!model?.hasFacet));
    return !onPage || matchingPanels(panels, onPage, (panel) => panel).length ? 1 : 0;
  }
  return matchingPanels(panels, only, (panel) => panel).length;
}

/**
 * A chart's pages: each value of its page dimension (`pageBy`), in the order the chart draws them,
 * the facets and groups in the chart's order and the populations in theirs. Empty without pages.
 */
export function plottingPages(
  settings: ProportionsSettings,
  model: ProportionsModel | null,
  cellModel: CellValuesModel | null,
  order: PlottingLevels = {},
): string[] {
  const pageBy = chartPageDimension(settings, cellModel ? cellModel.hasFacet : !!model?.hasFacet);
  if (!pageBy) return [];
  if (pageBy === "channels") return chartChannels(settings);
  if (cellModel) {
    if (pageBy === "populations") return [...cellModel.catLevels];
    if (pageBy === "groups") return columnValueOrder(cellModel.violins.map((violin) => violin.group), order.groups);
    return columnValueOrder(cellModel.violins.map((violin) => violin.facet ?? ""), order.facets);
  }
  if (!model) return [];
  if (pageBy === "populations") return [...model.catLevels];
  return pageBy === "facet" ? columnValueOrder(model.perSample.map((row) => row.facet ?? ""), order.facets) : [];
}
