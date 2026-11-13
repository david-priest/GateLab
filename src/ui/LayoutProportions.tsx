// LayoutProportions.tsx — the Plotting tab's chart on a Layout page, drawn by the tab's own model
// and chart from the settings the block holds, so it looks on the page as it does there. The
// block keeps the chart as it was when added; "Edit in Plotting" hands it back to that tab, and
// the block can be replaced with the tab's current chart.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DivisionProfileLike } from "../engine/factors";
import type { FigureSample } from "../engine/figure";
import { effectiveLayoutStyle, type LayoutPlotStyle, type LayoutProportionsPanel, type LayoutProportionsRecipe, type LayoutSheet } from "../engine/layout";
import { pageContentBox } from "../engine/layoutArrange";
import {
  buildProportionsModel,
  proportionsCategoryColors,
  type FilePopulations,
  proportionsPopulations,
  type ProportionsModel,
  type ProportionsSampleRef,
  type ProportionsSettings,
} from "../engine/proportionsModel";
import type { CoreState } from "../store";
import { buildCellValuesModel, type CellValuesModel, type CellValuesOptions, type CellViolin } from "../engine/cellValuesModel";
import { PROPORTIONS_NO_FACTOR } from "../engine/proportionsSettings";
import { proportionPanelLayout, proportionsFactorTitle } from "./PlottingTab";
import { arrangeCellPanels, cellChartAxis, cellChartLayout, cellPanelAxes, cellPanels, cellPlotType, cellReplicateFrame, cellSlotN, channelCellPanels, splitsViolins, type CellChannelPart, type CellPanel } from "./CellValuesChart";
import { type ChartAxisFrame } from "./chart/valueAxis";
import { chartXAxis } from "./chart/chartXAxis";
import { arrangedSize, arrangePanels, chartChannels, chartPageDimension, chartPanelDimensions, isPageSelector, onlyPanelText, pagePanels, panelDimensionText, selectorPage } from "./panelArrangement";
import { onlyPanelMatches } from "./plottingPanels";
import { arrangeStatisticPanels, statisticChannelsFrame, statisticChartFrame, type StatisticChannelPart } from "./StatisticChart";
import { plottingDivisionLevels, plottingFacetLevels, plottingFactorLevels, plottingGroupLevels } from "./plottingColours";
import { useI18n } from "./i18n";
import { useFigureStyle } from "./figureStyle";
import { CHART_LEGEND_GAP, chartLegendColumns, chartLegendHeight, chartLegendWidth } from "./chart/ChartLegend";
import { nLineHeight, withNRows } from "./chart/chartLayout";
import { nLines, nRowSize } from "./chart/chartN";
import { formatLinearTick } from "./chart/chartFormat";
import { comparisonPaired, comparisonSpace, withBracketRows } from "./chart/chartComparisons";
import { proportionPanelTests } from "./ProportionsChart";
import { cellAxisOptions, PlottingChartView } from "./chart/PlottingChartView";

/** The proportion model while a block draws cells: nothing is counted for a chart not shown. */
const EMPTY_MODEL: ProportionsModel = { catLevels: [], perSample: [], hasFacet: false, excluded: [] };

/** The workspace's files as the Plotting model reads them: by id, file name and tree. */
export function proportionsSampleRefs(samples: readonly FigureSample[]): ProportionsSampleRef[] {
  return samples.map((entry) => ({ id: entry.id, name: entry.fileName ?? entry.name, sample: entry.sample, hierarchyId: entry.hierarchyId }));
}

/**
 * A frame for a block of one panel, at the panel's size, or of the legend alone, at the legend's,
 * within the sheet's page content box.
 */
function onePanelFrame(
  only: LayoutProportionsPanel,
  panelWidth: number,
  panelHeight: number,
  legend: LegendSize,
  box: { width: number; height: number },
): { width: number; height: number } {
  // A legend alone has no panels over it, so no gap.
  const size = "legend" in only
    ? { width: Math.max(160, legend.width) + 24, height: legend.height - CHART_LEGEND_GAP + 24 }
    : { width: panelWidth + 24, height: panelHeight + 24 };
  return { width: Math.round(Math.min(size.width, box.width)), height: Math.round(Math.min(size.height, box.height)) };
}

/** The room a chart's legend takes on a Layout page: its least width, and its height under the panels. */
interface LegendSize { width: number; height: number }

/** The legend of `labels` under an optional title, at the settings' legend font size, as the page draws it. */
function legendSize(labels: readonly string[], title: string | undefined, settings: ProportionsSettings): LegendSize {
  const columns = chartLegendColumns(labels.length);
  const rows = Math.max(1, Math.ceil(labels.length / columns));
  return {
    width: Math.max(columns * 145, chartLegendWidth(labels, columns, settings.fontLegend, title)),
    height: chartLegendHeight(rows, settings.fontLegend, !!title),
  };
}

/** The sheet's page content box; with no sheet, no bound. */
function contentBox(sheet: LayoutSheet | null): { width: number; height: number } {
  return sheet ? pageContentBox(sheet) : { width: Infinity, height: Infinity };
}

/**
 * A frame for a new block: the chart at its natural size, its panels arranged as the settings say, over the legend,
 * within the sheet's page content box (unbounded when `sheet` is null).
 */
export function proportionsBlockFrame(
  settings: ProportionsSettings,
  model: ProportionsModel,
  sheet: LayoutSheet | null,
  only?: LayoutProportionsPanel,
): { width: number; height: number } {
  const box = contentBox(sheet);
  const groups = [...new Set(model.perSample.map((row) => row.group))];
  // A stacked bar is a panel per facet; a boxplot a panel per facet and category, a box per group.
  const plotType = settings.plotType === "stacked" ? "stacked" : "box";
  const facets = model.hasFacet ? [...new Set(model.perSample.map((row) => row.facet ?? ""))] : [""];
  const panelList = plotType === "box"
    ? facets.flatMap((facet) => model.catLevels.map((cat, i) => ({ facet, cat: model.levels?.[i]?.popId ?? cat, name: cat })))
    : facets.map((facet) => ({ facet, cat: "", name: "" }));
  const facetTitle = proportionsFactorTitle(settings.facetSel);
  // A block of a page is the page's panels, arranged as the tab draws that page.
  const pageBy = chartPageDimension({ ...settings, plotType }, model.hasFacet);
  const placed = arrangePanels(
    pagePanels(panelList, pageBy, selectorPage(only), (panel) => ({ facet: panel.facet, group: null, population: panel.name })),
    (panel, dimension) => (dimension === "facet" ? panel.facet : panel.cat),
    chartPanelDimensions({ valueKind: "proportion", plotType, xAxis: "groups" }, model.hasFacet),
    settings.panelColumns,
    settings.panelsPerRow,
    settings.panelRows,
    (panel, dimension) => panelDimensionText({ facet: panel.facet, group: null, population: panel.name }, dimension, { facet: facetTitle }),
  );
  // A line of n, as wide as the most units a group can hold, when the chart writes one.
  const nSize = nRowSize(settings.showN && (plotType === "box" || settings.averagePerUnit) ? [nLines(model.perSample.length)] : [], settings.fontTick);
  // The room above the plots the chart's tests take: its line and its brackets.
  const tested = plotType === "box" && settings.test;
  const options = { comparisons: settings.comparisons, comparisonsShow: settings.comparisonsShow, paired: comparisonPaired(settings) };
  const space = tested ? comparisonSpace(proportionPanelTests(model, facets, groups, settings.proportionValue, options).values(), options) : { testLine: false, brackets: 0 };
  const panel = withNRows(withBracketRows(proportionPanelLayout(plotType, groups, Math.max(1, groups.length), settings.fontTick, settings.panelWidth, tested && space.testLine, nSize.width), settings.fontTick, space.brackets), settings.fontTick, nSize.rows);
  // A stacked bar's group title under its labels can reach below the panel's margin, as the chart draws it.
  const below = plotType === "stacked" && proportionsFactorTitle(settings.groupSel)
    ? Math.max(0, (panel.rotateLabels ? panel.margin.bottom + settings.fontAxis : 18 + settings.fontTick + settings.fontAxis + nSize.rows * nLineHeight(settings.fontTick)) + 6 - panel.margin.bottom)
    : 0;
  const panels = arrangedSize(placed, panel.width, panel.height - 240 + settings.height + below, settings.fontAxis);
  // A stacked bar's legend names its categories; a boxplot's its groups, under what the groups are.
  const legend = plotType === "stacked"
    ? legendSize(model.catLevels, undefined, settings)
    : legendSize(groups, proportionsFactorTitle(settings.groupSel), settings);
  if (only && !isPageSelector(only)) return onePanelFrame(only, panel.width, panel.height - 240 + settings.height + below, legend, box);
  const width = Math.max(360, legend.width, panels.width) + 24;
  const height = panels.height + (settings.legend ? legend.height : 0) + 24;
  return { width: Math.round(Math.min(width, box.width)), height: Math.round(Math.min(height, box.height)) };
}

/** A frame for a new per-cell block: the chart at its natural size, its panels arranged as the settings say, over the legend. */
export function cellValuesBlockFrame(
  settings: ProportionsSettings,
  model: CellValuesModel,
  axis: ChartAxisFrame,
  sheet: LayoutSheet | null,
  only?: LayoutProportionsPanel,
  /** The cells pooled by replicate unit, on linear values, when the chart draws replicate marks. */
  unitModel?: CellValuesModel | null,
  /** A chart of several channels: each channel's cells, axis and replicate marks, as the chart takes them. */
  channels?: readonly CellChannelPart[],
): { width: number; height: number } {
  const box = contentBox(sheet);
  const parts = channels && channels.length > 1 ? channels : null;
  const xAxis = chartXAxis(settings);
  const { panels, groups } = parts
    ? channelCellPanels(parts, xAxis, settings.xAxis === "populations" ? proportionsFactorTitle(settings.groupSel) : undefined, proportionsFactorTitle(settings.facetSel))
    : cellPanels(
        model,
        xAxis,
        settings.xAxis === "populations" ? proportionsFactorTitle(settings.groupSel) : undefined,
        proportionsFactorTitle(settings.facetSel),
      );
  const plotType = cellPlotType(settings.plotType);
  const titleChars = Math.max(0, ...panels.map((p) => p.title.length));
  const ownPanels = (part: CellChannelPart) => panels.filter((p) => p.channel === part.key);
  const axes = parts
    ? parts.flatMap((part) => cellPanelAxes(part.model, ownPanels(part), part.axis, cellAxisOptions(settings)) ?? [part.axis])
    : cellPanelAxes(model, panels, axis, cellAxisOptions(settings)) ?? [axis];
  const replicateOf = (of: CellValuesModel, shown: CellPanel[], units: CellValuesModel | null | undefined) => units && settings.replicateMarks !== "none"
    ? cellReplicateFrame(of, shown, groups, xAxis, { unitModel: units, statistic: settings.replicateMarks, unitSel: settings.unitSel, test: settings.test, comparisons: settings })
    : null;
  const channelFrames = new Map(parts?.map((part) => [part.key, replicateOf(part.model, ownPanels(part), part.replicates?.unitModel)]));
  const single = parts ? null : replicateOf(model, panels, unitModel);
  const frames = [...(parts ? channelFrames.values() : [single])].filter((frame): frame is NonNullable<typeof frame> => !!frame);
  const panel = cellChartLayout(
    plotType === "splitViolin" && !splitsViolins(groups.length, xAxis) ? "violin" : plotType,
    panels[0]?.slots.map((slot) => slot.tick ?? slot.label) ?? [],
    axes.flatMap((own) => own.major.map((tick) => tick.label)),
    { tick: settings.fontTick, axis: settings.fontAxis },
    settings.height,
    titleChars,
    settings.panelWidth,
    settings.showN ? panels.flatMap((p) => p.slots.map((_, si) => cellSlotN(p, si, parts ? channelFrames.get(p.channel ?? "") ?? null : single))) : [],
    frames.some((frame) => frame.withTest),
    frames.some((frame) => frame.testLine),
    Math.max(0, ...frames.map((frame) => frame.brackets)),
  );
  // With the groups along x, the legend names the groups above its entries.
  const legend = xAxis !== "groups" ? legendSize(model.catLevels, undefined, settings) : legendSize(groups, proportionsFactorTitle(settings.groupSel), settings);
  if (only && !isPageSelector(only)) return onePanelFrame(only, panel.width, panel.height, legend, box);
  const titles = { group: settings.xAxis === "populations" ? proportionsFactorTitle(settings.groupSel) : undefined, facet: proportionsFactorTitle(settings.facetSel) };
  const keys = parts?.map((part) => part.key);
  const shown = pagePanels(panels, chartPageDimension({ ...settings, channels: keys ?? [] }, model.hasFacet), selectorPage(only), (p) => p);
  const placed = arrangedSize(arrangeCellPanels(shown, xAxis, model.hasFacet, settings, titles, keys), panel.width, panel.height, settings.fontAxis);
  const width = Math.max(360, legend.width, placed.width) + 24;
  const height = placed.height + (settings.legend ? legend.height : 0) + 24;
  return { width: Math.round(Math.min(width, box.width)), height: Math.round(Math.min(height, box.height)) };
}

/** A frame for a new statistic block: the chart at its natural size, its panels arranged as the settings say, over the legend. */
export function statisticBlockFrame(
  settings: ProportionsSettings,
  model: CellValuesModel,
  sheet: LayoutSheet | null,
  only?: LayoutProportionsPanel,
  /** A chart of several channels: each channel's cells pooled by unit. */
  channels?: readonly StatisticChannelPart[],
): { width: number; height: number } {
  const box = contentBox(sheet);
  const plotType = settings.plotType === "bar" ? "bar" : settings.plotType === "dots" ? "dots" : "box";
  const parts = channels && channels.length > 1 ? channels : null;
  const { panels, groups, layout } = parts
    ? statisticChannelsFrame(parts, { ...settings, plotType }, proportionsFactorTitle(settings.groupSel), proportionsFactorTitle(settings.facetSel))
    : statisticChartFrame(
        model,
        { ...settings, plotType },
        proportionsFactorTitle(settings.groupSel),
        proportionsFactorTitle(settings.facetSel),
      );
  const xAxis = chartXAxis(settings);
  // With the groups along x, the legend names the groups above its entries.
  const legend = xAxis !== "groups" ? legendSize(model.catLevels, undefined, settings) : legendSize(groups, proportionsFactorTitle(settings.groupSel), settings);
  if (only && !isPageSelector(only)) return onePanelFrame(only, layout.width, layout.height, legend, box);
  const titles = { group: settings.xAxis === "populations" ? proportionsFactorTitle(settings.groupSel) : undefined, facet: proportionsFactorTitle(settings.facetSel) };
  const keys = parts?.map((part) => part.key);
  const shown = pagePanels(panels, chartPageDimension({ ...settings, channels: keys ?? [] }, model.hasFacet), selectorPage(only), (p) => p);
  const placed = arrangedSize(arrangeStatisticPanels(shown, xAxis, model.hasFacet, settings, titles, keys), layout.width, layout.height, settings.fontAxis);
  const width = Math.max(360, legend.width, placed.width) + 24;
  const height = placed.height + (settings.legend ? legend.height : 0) + 24;
  return { width: Math.round(Math.min(width, box.width)), height: Math.round(Math.min(height, box.height)) };
}

/** A block's settings with the sheet's text sizes in place of the chart's own. */
export function withSheetText(settings: ProportionsSettings, style: Pick<LayoutPlotStyle, "fontTick" | "fontAxis" | "fontLegend">): ProportionsSettings {
  return { ...settings, fontTick: style.fontTick, fontAxis: style.fontAxis, fontLegend: style.fontLegend };
}

/**
 * What a block's frame holds besides what the frame functions count (their 24 px): the item's
 * 8 px less than its frame, the plot host's 4 px padding and the chart card's 10 px padding a side.
 */
export const SHEET_BLOCK_CHROME = 12;
/** The smallest panel width and plot height a block is drawn at; a smaller frame clips the chart. */
const MIN_PANEL_WIDTH = 60;
const MIN_PLOT_HEIGHT = 40;

/**
 * The chart laid out to fill `width` × `height` (a frame function's size): the panel width and plot
 * height that make `frame` come to that size, the panel width first since label turns change a
 * panel's height. `fits` is false when the chart at its smallest is still larger.
 */
export function fitPlottingToFrame(
  settings: ProportionsSettings,
  frame: (settings: ProportionsSettings) => { width: number; height: number },
  width: number,
  height: number,
): { settings: ProportionsSettings; fits: boolean } {
  // Two sizes large enough that the panels, not the legend's or the card's least width, set the frame.
  const LO = 1000;
  const HI = 2000;
  const at = (panelWidth: number, plotHeight: number) => frame({ ...settings, panelWidth, height: plotHeight });
  const w0 = at(LO, LO).width;
  const perWidth = (at(HI, LO).width - w0) / (HI - LO);
  const panelWidth = perWidth > 0 ? Math.max(MIN_PANEL_WIDTH, Math.floor(LO + (width - w0) / perWidth)) : settings.panelWidth;
  const h0 = at(panelWidth, LO).height;
  const perHeight = (at(panelWidth, HI).height - h0) / (HI - LO);
  const plotHeight = perHeight > 0 ? Math.max(MIN_PLOT_HEIGHT, Math.floor(LO + (height - h0) / perHeight)) : settings.height;
  const fitted = { ...settings, panelWidth, height: plotHeight };
  const size = frame(fitted);
  return { settings: fitted, fits: size.width <= width + 0.5 && size.height <= height + 0.5 };
}

/**
 * A block's cells. A block with no group (an Illustration chart panel's, figureChartRecipe) draws
 * its files as one group, as the panel does: the model groups them by file, so the groups are
 * joined here, each population's cells pooled over the files for a per-cell chart, and each unit
 * kept for a statistic.
 */
function blockCellModel(
  settings: ProportionsSettings,
  files: readonly ProportionsSampleRef[],
  state: CoreState,
  metadataById: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
  options: CellValuesOptions = {},
): CellValuesModel {
  const model = buildCellValuesModel(settings, files, state, metadataById, options);
  if (settings.groupSel !== PROPORTIONS_NO_FACTOR) return model;
  const joined = new Map<string, CellViolin>();
  for (const violin of model.violins) {
    const key = JSON.stringify([violin.cat, violin.facet, violin.unit]);
    const kept = joined.get(key);
    if (!kept) {
      joined.set(key, { ...violin, group: "" });
      continue;
    }
    const values = new Float32Array(kept.values.length + violin.values.length);
    values.set(kept.values);
    values.set(violin.values, kept.values.length);
    joined.set(key, { ...kept, values: values.sort(), files: [...kept.files, ...violin.files] });
  }
  return { ...model, violins: [...joined.values()] };
}

/** The cells a statistic or per-cell block is drawn from: each unit's on linear values for a statistic. */
function channelModel(
  settings: ProportionsSettings,
  files: readonly ProportionsSampleRef[],
  state: CoreState,
  metadataById: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
  filePopulations?: FilePopulations,
): CellValuesModel {
  return blockCellModel(settings, files, state, metadataById, { ...(settings.valueKind === "statistic" ? { poolBy: "unit" as const, values: "raw" as const } : {}), filePopulations });
}

/** A per-cell chart's cells pooled by replicate unit on linear values, as a statistic chart takes them, when it draws replicate marks. */
function replicateUnitModel(
  settings: ProportionsSettings,
  files: readonly ProportionsSampleRef[],
  state: CoreState,
  metadataById: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
  filePopulations?: FilePopulations,
): CellValuesModel | null {
  return settings.valueKind === "cells" && settings.replicateMarks !== "none"
    ? blockCellModel(settings, files, state, metadataById, { poolBy: "unit", values: "raw", filePopulations })
    : null;
}

/** Numbers objects by identity, so a cache key can say "the same tree" or "the same file" without copying them. */
const objectNumbers = new WeakMap<object, number>();
let lastObjectNumber = 0;
function objectNumber(value: object | null | undefined): number {
  if (!value) return 0;
  let n = objectNumbers.get(value);
  if (n === undefined) {
    n = ++lastObjectNumber;
    objectNumbers.set(value, n);
  }
  return n;
}

/**
 * What a block's model is built from: the settings that reach the model (not how it is drawn),
 * the chart's files and their metadata, the gating and the files' data revision. Blocks of one
 * chart, and an iterated block drawn again for the same unit, give the same key.
 */
export function plottingModelKey(
  settings: ProportionsSettings,
  samples: readonly FigureSample[],
  state: CoreState,
  metadataById: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
  divisionProfiles: Readonly<Record<string, DivisionProfileLike>>,
  dataRevision: string | number,
  /** Where each population is found in each file, for an Illustration chart panel (buildFigureChartPanel). */
  filePopulations?: FilePopulations,
): string {
  const files = samples.filter((entry) => settings.files.includes(entry.id));
  return JSON.stringify([
    settings.valueKind, settings.channel, chartChannels(settings), settings.files, settings.hierarchy, settings.categoryKind, settings.parent,
    settings.selectedPops, settings.includeUngated, settings.groupSel, settings.unitSel, settings.facetSel,
    settings.valueKind === "cells" && settings.replicateMarks !== "none",
    files.map((entry) => [entry.id, entry.fileName ?? entry.name, entry.hierarchyId ?? "", objectNumber(entry.sample), metadataById[entry.id] ?? null]),
    state.gate_version, state.tree_version, state.active_hierarchy_id, state.root_population_id,
    [state.gates, state.populations, state.hierarchies, state.stored_hierarchies].map(objectNumber),
    settings.categoryKind === "division" ? divisionProfiles : null,
    dataRevision,
    ...(filePopulations ? [filePopulations] : []),
  ]);
}

interface PlottingModels {
  model: ProportionsModel;
  cellModel: CellValuesModel | null;
  /** A per-cell chart's cells pooled by replicate unit, when it draws replicate marks. */
  unitModel: CellValuesModel | null;
  /** A chart of several channels: each channel's cells and units, the first channel's those above; empty otherwise. */
  channels: { key: string; label: string; model: CellValuesModel; unitModel: CellValuesModel | null }[];
}

/** The models last built for the sheets' blocks, by key, the most recently used last. */
const plottingModels = new Map<string, PlottingModels>();
const PLOTTING_MODELS_KEPT = 24;

/**
 * A block's models, built once for every block of its chart: a proportion model, or a per-cell
 * or statistic chart's cells, from the cache while what they are built from is unchanged.
 */
export function plottingBlockModels(
  settings: ProportionsSettings,
  samples: readonly FigureSample[],
  state: CoreState,
  metadataById: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
  divisionProfiles: Readonly<Record<string, DivisionProfileLike>>,
  dataRevision: string | number,
  /** Where each population is found in each file, in place of provenance: an Illustration chart panel's (buildFigureChartPanel). */
  filePopulations?: FilePopulations,
): PlottingModels {
  const key = plottingModelKey(settings, samples, state, metadataById, divisionProfiles, dataRevision, filePopulations);
  const kept = plottingModels.get(key);
  if (kept) {
    plottingModels.delete(key);
    plottingModels.set(key, kept);
    return kept;
  }
  const files = proportionsSampleRefs(samples);
  const channel = settings.valueKind === "cells" || settings.valueKind === "statistic";
  const cellModel = channel ? channelModel(settings, files, state, metadataById, filePopulations) : null;
  const unitModel = replicateUnitModel(settings, files, state, metadataById, filePopulations);
  const keys = channel ? chartChannels(settings) : [];
  const built: PlottingModels = {
    model: channel ? EMPTY_MODEL : buildProportionsModel(settings, files, state, metadataById, divisionProfiles, { filePopulations }),
    cellModel,
    unitModel,
    channels: cellModel && keys.length > 1
      ? keys.map((key, i) => {
          const own = i === 0 ? { model: cellModel, unitModel } : { model: channelModel({ ...settings, channel: key }, files, state, metadataById, filePopulations), unitModel: replicateUnitModel({ ...settings, channel: key }, files, state, metadataById, filePopulations) };
          return { key, label: own.model.channelLabel || key, ...own };
        })
      : [],
  };
  plottingModels.set(key, built);
  if (plottingModels.size > PLOTTING_MODELS_KEPT) plottingModels.delete(plottingModels.keys().next().value!);
  return built;
}

/**
 * How to size the Plotting chart a block will hold on a sheet: a proportion chart or a per-cell
 * chart as its settings say, its model built once here; null when it would draw nothing.
 */
export function plottingBlockSizer(
  settings: ProportionsSettings,
  files: readonly ProportionsSampleRef[],
  state: CoreState,
  metadataById: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
  divisionProfiles: Readonly<Record<string, DivisionProfileLike>>,
  globalScales?: Readonly<Record<string, [number, number]>>,
  /** One panel of the chart, or its legend, for a block of one panel. */
  only?: LayoutProportionsPanel,
): ((sheet: LayoutSheet, figure?: Partial<LayoutPlotStyle> | null) => { width: number; height: number }) | null {
  // A new block draws with the sheet's text sizes (`textSize: "sheet"`), so its frame is the chart
  // at those sizes with the frame's own margins, within the page's content box. `figure` is the
  // workspace's figure style, which a sheet that follows it takes.
  const sized = (frame: (settings: ProportionsSettings) => { width: number; height: number }) => (sheet: LayoutSheet, figure?: Partial<LayoutPlotStyle> | null) => {
    const natural = frame(withSheetText(settings, effectiveLayoutStyle(sheet, null, figure)));
    const box = pageContentBox(sheet);
    return {
      width: Math.round(Math.min(natural.width + SHEET_BLOCK_CHROME, box.width)),
      height: Math.round(Math.min(natural.height + SHEET_BLOCK_CHROME, box.height)),
    };
  };
  // A chart of several channels: every channel's cells and units, the first's those given.
  const channelsOf = (first: CellValuesModel, firstUnits: CellValuesModel | null): PlottingModels["channels"] => {
    const keys = chartChannels(settings);
    if (keys.length < 2) return [];
    return keys.map((key, i) => {
      const own = i === 0 ? { model: first, unitModel: firstUnits } : { model: channelModel({ ...settings, channel: key }, files, state, metadataById), unitModel: replicateUnitModel({ ...settings, channel: key }, files, state, metadataById) };
      return { key, label: own.model.channelLabel || key, ...own };
    });
  };
  if (settings.valueKind === "statistic") {
    const model = channelModel(settings, files, state, metadataById);
    if (!model.violins.some((violin) => violin.values.length > 0)) return null;
    const parts = blockChannelParts(settings, channelsOf(model, null));
    return sized((s) => statisticBlockFrame(s, model, null, only, parts));
  }
  if (settings.valueKind === "cells") {
    const model = blockCellModel(settings, files, state, metadataById);
    const axis = cellChartAxis(model, settings.cellRange, globalScales?.[settings.channel], { min: settings.valueMin, max: settings.valueMax });
    if (!axis || !model.violins.some((violin) => violin.values.length > 0)) return null;
    const unitModel = replicateUnitModel(settings, files, state, metadataById);
    const parts = blockChannelParts(settings, channelsOf(model, unitModel), globalScales);
    return sized((s) => cellValuesBlockFrame(s, model, axis, null, only, unitModel, parts));
  }
  const model = buildProportionsModel(settings, files, state, metadataById, divisionProfiles);
  if (!model.catLevels.length || !model.perSample.length) return null;
  return sized((s) => proportionsBlockFrame(s, model, null, only));
}

/**
 * A block's channels as its chart takes them, each on its own value axis (a per-cell chart's within
 * the typed limits, in the channel's own units) with its own replicate marks; undefined for a
 * chart of one channel. A per-cell channel without an axis is left out.
 */
export function blockChannelParts(
  settings: ProportionsSettings,
  channels: PlottingModels["channels"],
  globalScales?: Readonly<Record<string, [number, number]>>,
  unitLevels?: readonly string[],
): CellChannelPart[] | undefined {
  if (channels.length < 2) return undefined;
  return channels.flatMap((part) => {
    const axis = settings.valueKind === "cells"
      ? cellChartAxis(part.model, settings.cellRange, globalScales?.[part.key], { min: settings.valueMin, max: settings.valueMax })
      : { range: [0, 1] as [number, number], major: [], minor: [] };
    if (!axis) return [];
    const replicates = part.unitModel && settings.valueKind === "cells" && settings.replicateMarks !== "none"
      ? { unitModel: part.unitModel, statistic: settings.replicateMarks, unitSel: settings.unitSel, unitLevels, test: settings.test, comparisons: { comparisons: settings.comparisons, comparisonsShow: settings.comparisonsShow } }
      : undefined;
    return [{ key: part.key, label: part.label, model: part.model, axis, ...(replicates ? { replicates } : {}) }];
  });
}

export function LayoutProportionsSurface({
  recipe,
  samples,
  state,
  metadataById,
  divisionProfiles,
  width,
  height,
  containerId,
  globalScales,
  chartFiles,
  dataRevision = "",
  metadataLevels,
  sheetStyle,
}: Readonly<{
  recipe: LayoutProportionsRecipe;
  /**
   * The files the chart was made with, before a sheet's iteration narrows the block to a page's:
   * each group and division level takes the colour of its place among theirs on every page.
   */
  chartFiles?: readonly string[];
  samples: readonly FigureSample[];
  state: CoreState;
  metadataById: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>;
  divisionProfiles: Readonly<Record<string, DivisionProfileLike>>;
  width: number;
  height: number;
  /** The chart card's element id; each block on a page needs its own. */
  containerId: string;
  /** Each channel's range on the Gating tab, for a per-cell chart's value axis. */
  globalScales?: Readonly<Record<string, [number, number]>>;
  /** The files' data revision: a model is built again when it changes. */
  dataRevision?: string | number;
  /** The metadata columns' own orders of their values, the workspace's, which the chart draws its groups and facets in. */
  metadataLevels?: Readonly<Record<string, readonly string[]>>;
  /** The sheet's style, whose text sizes a block of `textSize: "sheet"` draws with. */
  sheetStyle?: LayoutPlotStyle;
}>) {
  const { t } = useI18n();
  // A block of a chart that uses the workspace's figure style, at the chart's own text size, draws
  // its text at the style's sizes, as the Plotting tab does.
  const { style: figureStyle } = useFigureStyle();
  const settings = useMemo(
    () => (recipe.settings.followFigureStyle && recipe.textSize !== "sheet"
      ? { ...recipe.settings, fontTick: figureStyle.fontTick, fontAxis: figureStyle.fontAxis, fontLegend: figureStyle.fontLegend }
      : recipe.settings),
    [recipe.settings, recipe.textSize, figureStyle],
  );
  const cells = settings.valueKind === "cells";
  const stat = settings.valueKind === "statistic";
  // Every block of the chart draws from one build, kept while its inputs are unchanged.
  const { model, cellModel, unitModel, channels: channelModels } = plottingBlockModels(settings, samples, state, metadataById, divisionProfiles, dataRevision);
  const matches = useMemo(() => onlyPanelMatches(settings, cellModel ? null : model, cellModel, recipe.panel, channelModels), [settings, model, cellModel, recipe.panel, channelModels]);
  // A block of a page draws that page's panels as the chart arranges them, with its legend; a block of one panel, that panel.
  const page = selectorPage(recipe.panel);
  const only = page === undefined ? recipe.panel : undefined;
  const xAxisFrame = useMemo(
    () => (cellModel && cells ? cellChartAxis(cellModel, settings.cellRange, globalScales?.[settings.channel], { min: settings.valueMin, max: settings.valueMax }) : null),
    [cells, cellModel, settings.cellRange, settings.channel, settings.valueMin, settings.valueMax, globalScales],
  );
  const populations = useMemo(() => proportionsPopulations(settings, state), [settings, state]);
  const catColors = useMemo(
    () => (cellModel ? proportionsCategoryColors(cellModel, { ...settings, includeUngated: false }, populations) : proportionsCategoryColors(model, settings, populations)),
    [cellModel, model, settings, populations],
  );
  const allFiles = chartFiles ?? settings.files;
  // The groups, facets and units in the chart's order over all its files, so a block under an
  // iteration draws and colours them as the whole chart does.
  const { groupLevels, facetLevels, unitLevels } = useMemo(() => {
    const whole = { ...settings, files: [...allFiles] };
    const refs = proportionsSampleRefs(samples);
    return {
      groupLevels: plottingGroupLevels(whole, refs, metadataById, metadataLevels),
      facetLevels: plottingFacetLevels(whole, refs, metadataById, metadataLevels),
      unitLevels: plottingFactorLevels(whole, settings.unitSel, refs, metadataById, metadataLevels),
    };
  }, [settings, allFiles, samples, metadataById, metadataLevels]);
  // A chart of several channels: each on its own value axis, within the channel.
  const channelParts = useMemo(() => blockChannelParts(settings, channelModels, globalScales, unitLevels), [settings, channelModels, globalScales, unitLevels]);
  // Division levels take the palette in order, so they are coloured over the chart's files too.
  const levelColors = useMemo(
    () => (!cellModel && !model.levels && model.catLevels.length && settings.categoryKind === "division"
      ? proportionsCategoryColors({ catLevels: plottingDivisionLevels(allFiles, divisionProfiles) }, settings, populations)
      : catColors),
    [cellModel, model, settings, allFiles, divisionProfiles, populations, catColors],
  );
  // With the sheet's text sizes, the chart is laid out to fill the frame: its panels take the
  // frame's size and its text the sheet's, so text is the same size in every block on the page.
  const sheetSizes = recipe.textSize === "sheet" && sheetStyle ? [sheetStyle.fontTick, sheetStyle.fontAxis, sheetStyle.fontLegend, sheetStyle.fontTitle] : null;
  const sheetText = useMemo(
    () => (sheetSizes ? { fontTick: sheetSizes[0], fontAxis: sheetSizes[1], fontLegend: sheetSizes[2], fontTitle: sheetSizes[3] } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the sizes, not the style object made anew each render
    [sheetSizes?.join()],
  );
  const fitted = useMemo(() => {
    if (!sheetText) return null;
    const sized = withSheetText(settings, sheetText);
    const frame = cellModel && stat
      ? (s: ProportionsSettings) => statisticBlockFrame(s, cellModel, null, recipe.panel, channelParts)
      : cellModel
        ? xAxisFrame ? (s: ProportionsSettings) => cellValuesBlockFrame(s, cellModel, xAxisFrame, null, recipe.panel, unitModel, channelParts) : null
        : model.catLevels.length && model.perSample.length ? (s: ProportionsSettings) => proportionsBlockFrame(s, model, null, recipe.panel) : null;
    if (!frame) return { settings: sized, fits: true };
    // The frame functions count 24 px about the chart; the surface is the frame less 8 px.
    return fitPlottingToFrame(sized, frame, width + 8 - SHEET_BLOCK_CHROME, height + 8 - SHEET_BLOCK_CHROME);
  }, [sheetText, settings, cellModel, unitModel, stat, xAxisFrame, model, recipe.panel, width, height, channelParts]);
  const drawn = fitted?.settings ?? settings;
  const fonts = { tick: drawn.fontTick, axis: drawn.fontAxis, legend: drawn.fontLegend, ...(sheetText ? { title: sheetText.fontTitle } : {}) };
  const formatTick = sheetText ? formatLinearTick : undefined;
  // Otherwise the chart is laid out at its natural size and zoomed to fit the frame, never
  // enlarged. A chart laid out to the frame is measured too, to mark one that does not fit.
  const zoomRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const node = zoomRef.current;
    if (!node) return;
    const measure = () => {
      const natural = node.firstElementChild as HTMLElement | null;
      if (!natural) return;
      const w = natural.offsetWidth;
      const h = natural.offsetHeight;
      if (!w || !h) return;
      if (sheetText) {
        setZoom(1);
        // The host's 4 px padding a side.
        setOverflows(w > width - 8 + 1 || h > height - 8 + 1);
      } else {
        setZoom(Math.min(1, width / w, height / h));
        setOverflows(false);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [width, height, model, cellModel, sheetText, drawn]);
  // A frame too small for the chart at the sheet's text sizes clips it and says so in its corner.
  const tooSmall = sheetText && (fitted?.fits === false || overflows) ? (
    <span className="gl-layout-too-small" title={t("The frame is too small for this chart at the sheet's text sizes; enlarge it to show the whole chart.")}>
      {t("too small")}
    </span>
  ) : null;

  // A block of one panel that finds none in the chart says what it looks for.
  const noPanel = matches === 0 && recipe.panel && !("legend" in recipe.panel) ? (
    <div className="gl-layout-plot-host gl-layout-proportions-host is-missing">
      {`No panel for ${onlyPanelText(recipe.panel) || "this block"} in this chart.`}
    </div>
  ) : null;

  const view = (
    <PlottingChartView
      settings={drawn}
      model={model}
      cellModel={cellModel}
      unitModel={unitModel}
      channelParts={channelParts}
      catColors={catColors}
      levelColors={levelColors}
      populations={populations}
      groupLevels={groupLevels}
      facetLevels={facetLevels}
      unitLevels={unitLevels}
      fonts={fonts}
      xAxisFrame={xAxisFrame}
      formatTick={formatTick}
      containerId={containerId}
      only={only}
      page={page}
    />
  );

  if (cellModel && stat) {
    if (!cellModel.violins.some((violin) => violin.values.length > 0)) {
      return (
        <div className="gl-layout-plot-host gl-layout-proportions-host is-missing">
          {settings.channel && settings.selectedPops.length
            ? "The chart's files, populations or channel are not in this workspace."
            : "The chart has no channel or populations."}
        </div>
      );
    }
    if (noPanel) return noPanel;
    return (
      <div className="gl-layout-plot-host gl-layout-proportions-host" style={{ width, height }}>
        {tooSmall}
        <div ref={zoomRef} className="gl-layout-figure-zoom" style={{ zoom, width: "max-content" }}>
          {view}
        </div>
      </div>
    );
  }
  if (cellModel) {
    if (!xAxisFrame || !cellModel.violins.some((violin) => violin.values.length > 0)) {
      return (
        <div className="gl-layout-plot-host gl-layout-proportions-host is-missing">
          {settings.channel && settings.selectedPops.length
            ? "The chart's files, populations or channel are not in this workspace."
            : "The chart has no channel or populations."}
        </div>
      );
    }
    if (noPanel) return noPanel;
    return (
      <div className="gl-layout-plot-host gl-layout-proportions-host" style={{ width, height }}>
        {tooSmall}
        <div ref={zoomRef} className="gl-layout-figure-zoom" style={{ zoom, width: "max-content" }}>
          {view}
        </div>
      </div>
    );
  }

  if (!model.catLevels.length || !model.perSample.length) {
    return (
      <div className="gl-layout-plot-host gl-layout-proportions-host is-missing">
        {settings.files.length && (settings.categoryKind === "division" || settings.selectedPops.length)
          ? "The chart's files or populations are not in this workspace."
          : "The chart has no files or populations."}
      </div>
    );
  }
  if (noPanel) return noPanel;
  return (
    <div className="gl-layout-plot-host gl-layout-proportions-host" style={{ width, height }}>
      {tooSmall}
      <div ref={zoomRef} className="gl-layout-figure-zoom" style={{ zoom, width: "max-content" }}>
        {view}
      </div>
    </div>
  );
}

/**
 * The Layout inspector's note on a block of one panel: what it looks for when the chart has no
 * such panel, or that it draws the first of the panels it matches. Nothing for any other block.
 */
export function LayoutProportionsPanelNote({
  recipe,
  samples,
  state,
  metadataById,
  divisionProfiles,
  dataRevision = "",
}: Readonly<{
  recipe: LayoutProportionsRecipe;
  samples: readonly FigureSample[];
  state: CoreState;
  metadataById: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>;
  divisionProfiles: Readonly<Record<string, DivisionProfileLike>>;
  dataRevision?: string | number;
}>) {
  const { t } = useI18n();
  const only = recipe.panel;
  if (!only || "legend" in only) return null;
  const { model, cellModel, channels: channelModels } = plottingBlockModels(recipe.settings, samples, state, metadataById, divisionProfiles, dataRevision);
  // A chart that draws nothing says so in its frame already.
  if (cellModel ? !cellModel.violins.length : !model.perSample.length) return null;
  const matches = onlyPanelMatches(recipe.settings, cellModel ? null : model, cellModel, only, channelModels);
  if (matches === 1) return null;
  return (
    <p className="gl-hint">
      {matches === 0
        ? t("No panel for {which} in this chart.", { which: onlyPanelText(only) || t("this block") })
        : t("{count} panels of the chart match this block; it draws the first.", { count: String(matches) })}
    </p>
  );
}
