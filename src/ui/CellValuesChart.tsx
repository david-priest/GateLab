// CellValuesChart.tsx — the Plotting tab's per-cell chart: a channel's value in every cell of each
// population, as a violin or a box per population and group, a violin split between two groups,
// or ridgelines along a horizontal value axis, on the channel's display scale and ticked as the
// Gating tab ticks it. It is built as the proportion chart is (`.gl-prop-chart`,
// `svg.gl-prop-panel` panels, an HTML legend), so its export and the Layout block take it as is.

import { useEffect, useMemo, useState } from "react";
import {
  cellBoxStats,
  cellValueAxis,
  measuredMedian,
  violinOutline,
  type CellValuesModel,
  type CellViolin,
} from "../engine/cellValuesModel";
import type { PaletteName } from "../engine/palettes";
import { plottingGroupColours } from "./plottingColours";
import { useI18n } from "./i18n";
import { CHART_TITLE_CHARS, compactChartLabel, formatMeasured } from "./chart/chartFormat";
import { fittedInnerWidth, labelsRotate, labelWidths, leftForTurnedLabels, longestLabelWidth, rotatedLabelsBottom, withNRows, type ChartPanelLayout } from "./chart/chartLayout";
import { cellMarkN, cellMarkNWithUnits, ChartNRow, nRowSize } from "./chart/chartN";
import { ChartCategoryAxis, ChartHorizontalValueAxis, ChartValueAxis } from "./chart/ChartAxis";
import { ChartPanel } from "./chart/ChartPanel";
import { ChartHighlightNote, ChartLegend, chartLegendColumns } from "./chart/ChartLegend";
import { PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "../engine/proportionsSettings";
import { arrangePanels, chartPageDimension, chartPanelDimensions, headedPanelTitle, pagePanels, panelDimensionText, placedOrOnly, type PanelTitles } from "./panelArrangement";
import { chartGridCells } from "./chart/ChartPanelGrid";
import type { LayoutProportionsPanel } from "../engine/layout";
import { columnValueOrder } from "../engine/levelOrder";
import { typedLimits, type ChartAxisFrame } from "./chart/valueAxis";
import { ChartPlotMarks } from "./chart/ChartPlotMarks";
import { bracketRowHeight, bracketRows, ChartBrackets, shownComparisons, withBracketRows, type PanelComparison, type PanelOverallTest } from "./chart/chartComparisons";
import { statisticPanels, statisticPoints, type StatisticPoint } from "./StatisticChart";
import { chartXAxis, xAxisFields, type ChartXAxis } from "./chart/chartXAxis";

/** The order of a chart's groups, facets and replicate units over all the files it was made with (plottingFactorLevels). */
export interface PlottingLevels {
  groups?: readonly string[];
  facets?: readonly string[];
  units?: readonly string[];
}

export interface CellValuesChartProps {
  model: CellValuesModel;
  /** A split violin is drawn as a violin unless the groups, exactly two, run along x (splitsViolins). */
  plotType: CellPlotType;
  /** Populations along x with a panel per group, or groups along x with a panel per population. */
  xAxis: "populations" | "groups";
  violinBox: boolean;
  /** Write each violin's or box's cells (and files, where it pools more than one) under its label. */
  showN?: boolean;
  /** The value axis every panel shares, or the one a panel without cells takes when each fits its own. */
  axis: ChartAxisFrame;
  /** Each panel on an axis fitted to its own cells, within the typed limits (in measured units); unset or shared, every panel on `axis`. */
  axisOptions?: { min: number | null; max: number | null; shared: boolean };
  /** The populations' colours, in category order. */
  catColors: string[];
  /** The palette the groups take their colours from. */
  palette: PaletteName;
  /** With the groups along x, colour each mark by its panel's population in place of its group (settings.colourByPopulation). */
  colourByPopulation?: boolean;
  /** With the groups along x, every population in one panel, side by side at each group (settings.populationsTogether). */
  populationsTogether?: boolean;
  /** Every group of the chart, over all the files it was made with, before an iteration or a panel narrows them: each group takes the colour of its place here. */
  groupLevels?: readonly string[];
  /** Every facet of the chart, in the order its panels are drawn. */
  facetLevels?: readonly string[];
  /** Text sizes; a panel's title takes `title`, else the axis size. */
  fonts: { tick: number; axis: number; legend: number; title?: number };
  appearance: { height: number; showGrid: boolean; showLegend: boolean };
  /** The card's element id, which the export composer finds it by; each chart on a page needs its own. */
  containerId?: string;
  /** What the groups and the facets are, before each panel's value. */
  groupTitle?: string;
  facetTitle?: string;
  /** Where the panels sit and how wide each is; unset, they wrap five to a row at their natural width. */
  arrangement?: Pick<ProportionsSettings, "panelColumns" | "panelsPerRow" | "panelWidth"> & Partial<Pick<ProportionsSettings, "panelRows" | "pageBy">>;
  /** One panel of the chart, or its legend alone, as a Layout block of one panel draws it. */
  only?: LayoutProportionsPanel;
  /** With pages (`arrangement.pageBy`), the page drawn, by its value; unset, every panel. */
  page?: string;
  /** The legend as a key alone: its entries are not buttons and highlight nothing. A Layout block and a figure's chart panel draw it so. */
  staticLegend?: boolean;
  /** Each replicate unit's median or mean drawn over the pooled marks; unset, none. */
  replicates?: CellReplicates;
  /**
   * Several channels, each drawn in panels of its own on its own value axis, its axis options taken
   * within the channel; unset or one, the chart draws `model` on `axis` with `replicates`.
   */
  channels?: readonly CellChannelPart[];
}

/** One channel of a chart of several: its cells, its value axis and its replicate marks. */
export interface CellChannelPart {
  key: string;
  label: string;
  model: CellValuesModel;
  axis: ChartAxisFrame;
  replicates?: CellReplicates;
}

/** A channel's display scale and measured units, through the transform of the file its axis is read from. */
function channelTransforms(model: Pick<CellValuesModel, "axisSource">): { toMeasured: (value: number) => number; toDisplay: (value: number) => number } {
  const source = model.axisSource;
  if (!source) return { toMeasured: (value) => value, toDisplay: (value) => value };
  const key = source.sample.channels[source.index].key;
  return { toMeasured: (value) => source.sample.displayToRaw(key, value), toDisplay: (value) => source.sample.rawToDisplay(key, value) };
}

/**
 * A chart of several channels' panels: each channel's panels in turn, keyed and titled with the
 * channel, which the chart's arrangement takes as a dimension. The groups are the first channel's.
 */
export function channelCellPanels(
  parts: readonly Pick<CellChannelPart, "key" | "label" | "model">[],
  xAxis: ChartXAxis,
  groupTitle?: string,
  facetTitle?: string,
  order: PlottingLevels = {},
): { panels: CellPanel[]; groups: string[] } {
  const each = parts.map((part) => cellPanels(part.model, xAxis, groupTitle, facetTitle, order));
  return {
    panels: each.flatMap(({ panels }, ci) => panels.map((panel) => ({ ...panel, key: `c${ci}-${panel.key}`, channel: parts[ci].key, title: [panel.title, parts[ci].label].filter(Boolean).join(" · ") }))),
    groups: each[0]?.groups ?? [],
  };
}

/** What a per-cell chart's replicate marks are taken from. */
export interface CellReplicates {
  /** The cells pooled by replicate unit, on linear values, as the statistic chart takes them. */
  unitModel: CellValuesModel;
  statistic: "median" | "mean";
  /** The replicate unit factor, so a unit that is a file is named by its file. */
  unitSel: string;
  /** The chart's order of its replicate units. */
  unitLevels?: readonly string[];
  /** A rank test between the groups of each panel on the units' values; drawn only with the groups along x. */
  test: boolean;
  /** Pairwise comparisons drawn as brackets, and which; unset, the overall test alone. */
  comparisons?: Pick<ProportionsSettings, "comparisons" | "comparisonsShow">;
}

export type CellPanelLayout = ChartPanelLayout;

/** What a per-cell chart draws for each population and group. */
export type CellPlotType = "violin" | "box" | "splitViolin" | "ridgeline";

/** The per-cell plot type a chart's settings name; anything a per-cell chart does not draw is a violin. */
export function cellPlotType(plotType: ProportionsSettings["plotType"]): CellPlotType {
  return plotType === "box" || plotType === "splitViolin" || plotType === "ridgeline" ? plotType : "violin";
}

/**
 * Whether a split violin can be drawn: exactly two groups, along x, so each population's panel
 * holds one violin with the first group's half on the left and the second group's on the right.
 */
export function splitsViolins(groupCount: number, xAxis: ChartXAxis): boolean {
  return groupCount === 2 && xAxis === "groups";
}

/** How far each ridge overlaps the row above it, as the Illustration's ridgeline layout sets by default. */
export const RIDGE_OVERLAP = 0.7;

/**
 * A ridgeline panel's rows within its plot: each ridge's height and each row's baseline, the
 * first row at the top. The rows overlap by RIDGE_OVERLAP, as the Illustration's ridgelines do,
 * and the lowest baseline is the plot's bottom, so no ridge reaches beyond the plot.
 */
export function ridgelineRows(rows: number, plotTop: number, plotHeight: number): { ridgeHeight: number; baselines: number[] } {
  const ridgeHeight = plotHeight / (1 + Math.max(0, rows - 1) * (1 - RIDGE_OVERLAP));
  const step = ridgeHeight * (1 - RIDGE_OVERLAP);
  return { ridgeHeight, baselines: Array.from({ length: rows }, (_, r) => plotTop + ridgeHeight + r * step) };
}

/**
 * A ridgeline panel's size: the rows' labels in the left margin, the value axis and its title
 * below, each row's n (on one line) to the right of the plot, the plot `plotHeight` tall.
 */
export function ridgelinePanelLayout(
  labels: readonly string[],
  tickFont: number,
  axisFont: number,
  plotHeight: number,
  titleChars = 0,
  titleFont = tickFont,
  panelWidth = 0,
  nWidth = 0,
): CellPanelLayout {
  const margin = {
    top: 22,
    right: 14 + nWidth,
    bottom: 20 + tickFont + axisFont,
    left: Math.max(36, Math.round(14 + longestLabelWidth(labels, tickFont, 30))),
  };
  const titleWidth = Math.min(titleChars, CHART_TITLE_CHARS) * titleFont * 0.62 + 12;
  const innerWidth = fittedInnerWidth(panelWidth, margin, Math.max(200, titleWidth - margin.left - margin.right));
  return { width: margin.left + innerWidth + margin.right, height: margin.top + plotHeight + margin.bottom, margin, rotateLabels: false };
}

/**
 * A per-cell panel's whole layout, as the chart draws it and a Layout block is sized for it: the
 * slots' lines of n under the labels (beside each row, on one line, for ridgelines) and the test's
 * line above the plot where it is drawn.
 */
export function cellChartLayout(
  plotType: CellPlotType,
  labels: readonly string[],
  tickLabels: readonly string[],
  fonts: { tick: number; axis: number },
  plotHeight: number,
  titleChars: number,
  panelWidth: number,
  slotN: readonly (readonly string[])[],
  withTest: boolean,
  /** Whether the overall test's line is written above the plot, and the rows of brackets above it; ridgelines draw the line alone. */
  testLine: boolean = withTest,
  brackets = 0,
): CellPanelLayout & { nBaseline: number } {
  if (plotType === "ridgeline") {
    const nSize = nRowSize(slotN.map((lines) => (lines.length ? [lines.join(" ")] : [])), fonts.tick);
    return { ...withTestRow(ridgelinePanelLayout(labels, fonts.tick, fonts.axis, plotHeight, titleChars, fonts.axis, panelWidth, nSize.width), fonts.tick, withTest), nBaseline: 0 };
  }
  const nSize = nRowSize(slotN, fonts.tick);
  return withBracketRows(withTestRow(withNRows(cellPanelLayout(plotType, labels, tickLabels, fonts.tick, plotHeight, titleChars, fonts.axis, panelWidth, nSize.width), fonts.tick, nSize.rows), fonts.tick, testLine), fonts.tick, brackets);
}

/** The outline's width at a value, read between its positions; 0 beyond its ends. */
function outlineWidthAt(outline: { at: number[]; width: number[] }, value: number): number {
  const { at, width } = outline;
  if (!at.length || value < at[0] || value > at[at.length - 1]) return 0;
  for (let i = 1; i < at.length; i++)
    if (value <= at[i]) return at[i] > at[i - 1] ? width[i - 1] + ((width[i] - width[i - 1]) * (value - at[i - 1])) / (at[i] - at[i - 1]) : width[i];
  return width[width.length - 1];
}

/**
 * A split violin's half as an SVG path: the outline on the left (side -1) or right (side 1) of the
 * centre line, `half` wide at the outline's widest, closed along the centre line.
 */
export function halfViolinPath(points: readonly { x: number; y: number }[], centre: number, side: -1 | 1): string {
  if (points.length < 2) return "";
  const outer = points.map((p) => `${(centre + side * p.x).toFixed(2)},${p.y.toFixed(2)}`);
  return `M${outer.join("L")}L${centre.toFixed(2)},${points[points.length - 1].y.toFixed(2)}L${centre.toFixed(2)},${points[0].y.toFixed(2)}Z`;
}

/**
 * A per-cell chart's value axis: the channel's (cellValueAxis), within the typed limits, which are
 * in measured units and placed on the display scale through the channel's transform.
 */
export function cellChartAxis(
  model: Pick<CellValuesModel, "extent" | "axisSource">,
  mode: ProportionsSettings["cellRange"],
  gatingRange: [number, number] | undefined,
  limits: { min?: number | null; max?: number | null } = {},
): ChartAxisFrame | null {
  const auto = cellValueAxis(model, mode, gatingRange);
  const typed = typedLimits(limits.min, limits.max);
  if (!auto || !typed) return auto;
  const source = model.axisSource;
  const toDisplay = (value: number) => (source ? source.sample.rawToDisplay(source.sample.channels[source.index].key, value) : value);
  const lo = typed[0] === null ? auto.range[0] : toDisplay(typed[0]);
  const hi = typed[1] === null ? auto.range[1] : toDisplay(typed[1]);
  if (!(Number.isFinite(lo) && Number.isFinite(hi) && hi > lo)) return auto;
  const limited = cellValueAxis({ extent: null, axisSource: source }, "gating", [lo, hi]);
  return limited ? { ...limited, clip: true } : auto;
}

/** Each panel's own axis, fitted to its cells within the limits; null when the panels share one. */
export function cellPanelAxes(
  model: Pick<CellValuesModel, "axisSource">,
  panels: readonly CellPanel[],
  axis: ChartAxisFrame,
  options: CellValuesChartProps["axisOptions"],
): ChartAxisFrame[] | null {
  if (!options || options.shared) return null;
  return panels.map((panel) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const slot of panel.slots)
      if (slot.violin?.values.length) {
        lo = Math.min(lo, slot.violin.values[0]);
        hi = Math.max(hi, slot.violin.values[slot.violin.values.length - 1]);
      }
    if (!Number.isFinite(lo)) return axis;
    return cellChartAxis({ extent: [lo, hi], axisSource: model.axisSource }, "fit", undefined, options) ?? axis;
  });
}

/** A panel's size from its x labels, the axis's tick labels, its title and the plot height. */
export function cellPanelLayout(
  plotType: CellPlotType,
  labels: readonly string[],
  tickLabels: readonly string[],
  tickFont: number,
  plotHeight: number,
  titleChars = 0,
  titleFont = tickFont,
  /** The panel's whole width when set (an Illustration panel's size); 0 fits it to its contents. */
  panelWidth = 0,
  /** The width a slot needs for its lines of n; 0 without them. */
  nWidth = 0,
): CellPanelLayout {
  const longestTick = Math.max(1, ...tickLabels.map((label) => label.length));
  const margin = { top: 22, right: 14, bottom: 46, left: Math.max(48, Math.round(28 + longestTick * tickFont * 0.6)) };
  const slot = Math.max(plotType === "box" ? 34 : 46, nWidth);
  const titleWidth = Math.min(titleChars, CHART_TITLE_CHARS) * titleFont * 0.62 + 12;
  const innerAt = (left: number) => fittedInnerWidth(panelWidth, { left, right: margin.right }, Math.max(90, labels.length * slot, titleWidth - left - margin.right));
  let innerWidth = innerAt(margin.left);
  const step = labels.length ? innerWidth / labels.length : innerWidth;
  const longestLabelPx = longestLabelWidth(labels, tickFont, 30);
  const rotateLabels = labelsRotate(longestLabelPx, step, 40);
  if (rotateLabels) {
    margin.bottom = rotatedLabelsBottom(longestLabelPx, 60);
    // The first labels, turned, reach left past the plot; the margin makes room for them.
    margin.left = leftForTurnedLabels(margin.left, labelWidths(labels, tickFont, 30), innerAt);
    innerWidth = innerAt(margin.left);
  }
  return {
    width: margin.left + innerWidth + margin.right,
    height: margin.top + plotHeight + margin.bottom,
    margin,
    rotateLabels,
  };
}

export interface CellPanel {
  key: string;
  title: string;
  facet: string | null;
  /** The panel's group, when it is a panel per group, or its population's name, when a panel per population. */
  group: string | null;
  population: string | null;
  /** Its population's id, when a panel per population. */
  populationId: string | null;
  /** Its channel's key, in a chart of several channels. */
  channel?: string;
  /**
   * The slots along x: each a label, the violin drawn there (if any) and its colour index. With the
   * populations together, the label is the slot's group, `cat` its population and `tick` what is
   * written under it.
   */
  slots: { label: string; violin: CellViolin | undefined; colour: number; cat?: number; tick?: string }[];
}

/** The panels and their slots, in the order they are drawn. */
export function cellPanels(
  model: Pick<CellValuesModel, "catLevels" | "violins" | "hasFacet"> & { levels?: CellValuesModel["levels"] },
  xAxis: ChartXAxis,
  groupTitle?: string,
  facetTitle?: string,
  /** The chart's order of its groups and facets; without it, the order the violins hold them. */
  order: PlottingLevels = {},
): { panels: CellPanel[]; groups: string[] } {
  const groups = columnValueOrder(model.violins.map((v) => v.group), order.groups);
  const facets = model.hasFacet ? columnValueOrder(model.violins.map((v) => v.facet ?? ""), order.facets) : [null];
  const find = (cat: number, group: string, facet: string | null) =>
    model.violins.find((v) => v.cat === cat && v.group === group && (!model.hasFacet || (v.facet ?? "") === facet));
  const facetPart = (facet: string | null) => (model.hasFacet ? (facetTitle ? `${facetTitle}: ${facet || "(NA)"}` : facet || "(NA)") : null);
  const panels: CellPanel[] = [];
  facets.forEach((facet, fi) => {
    if (xAxis === "populations") {
      groups.forEach((group, gi) => {
        panels.push({
          key: `f${fi}-g${gi}`,
          title: [groupTitle ? `${groupTitle}: ${group}` : group, facetPart(facet)].filter(Boolean).join(" · "),
          facet,
          group,
          population: null,
          populationId: null,
          slots: model.catLevels.map((label, cat) => ({ label, violin: find(cat, group, facet), colour: cat })),
        });
      });
    } else if (xAxis === "together") {
      panels.push({
        key: `f${fi}`,
        title: facetPart(facet) ?? "",
        facet,
        group: null,
        population: null,
        populationId: null,
        slots: groups.flatMap((group) => model.catLevels.map((_, ci) => ({ label: group, tick: togetherTick(group, ci, model.catLevels.length), cat: ci, violin: find(ci, group, facet), colour: ci }))),
      });
    } else {
      model.catLevels.forEach((cat, ci) => {
        panels.push({
          key: `f${fi}-c${ci}`,
          title: [cat, facetPart(facet)].filter(Boolean).join(" · "),
          facet,
          group: null,
          population: cat,
          populationId: model.levels?.[ci]?.popId ?? null,
          slots: groups.map((group, gi) => ({ label: group, violin: find(ci, group, facet), colour: gi })),
        });
      });
    }
  });
  return { panels, groups };
}

/**
 * With the populations together, what is written under a slot: its group, once, under the middle of
 * the group's populations. A group named by blanks alone (an Illustration summary drawn without its
 * file labels, whose groups are kept apart by blanks of different lengths) writes nothing.
 */
export function togetherTick(group: string, population: number, populations: number): string {
  return population === Math.floor((populations - 1) / 2) && group.trim() ? group : "";
}

/** A per-cell chart's replicate marks laid out: each slot's unit values and each panel's rank test. */
export interface CellReplicateFrame {
  statistic: CellReplicates["statistic"];
  unitSel: string;
  /** The unit values at a slot of a panel, in the chart's order of the units. */
  slotPoints: (panel: CellPanel, slot: number) => StatisticPoint[];
  /** Each panel's rank test on its units' values, by panel key, when the test is drawn. */
  tests: Map<string, PanelOverallTest | null>;
  withTest: boolean;
  /** Each panel's brackets drawn, by panel key, with pairwise comparisons on. */
  comparisons: Map<string, PanelComparison[]>;
  /** Whether a panel writes the overall test above its plot, and the rows of brackets the panels need. */
  testLine: boolean;
  brackets: number;
}

/**
 * The replicate marks of a per-cell chart's panels: each unit's statistic as the statistic chart
 * takes it (statisticPoints, on linear values), and with the groups along x and the test asked
 * for, the statistic chart's rank test on those values, never on the cells.
 */
export function cellReplicateFrame(
  model: Pick<CellValuesModel, "catLevels" | "hasFacet" | "levels">,
  panels: readonly CellPanel[],
  groups: readonly string[],
  xAxis: ChartXAxis,
  replicates: CellReplicates,
  facetLevels?: readonly string[],
): CellReplicateFrame {
  const unitIsFile = replicates.unitSel === PROPORTIONS_SAMPLE_FACTOR || replicates.unitSel === PROPORTIONS_NO_FACTOR;
  const points = statisticPoints(replicates.unitModel, replicates.statistic, unitIsFile, replicates.unitLevels);
  const withTest = replicates.test && xAxis === "groups";
  const tests = new Map<string, PanelOverallTest | null>();
  const comparisons = new Map<string, PanelComparison[]>();
  const options = { comparisons: replicates.comparisons?.comparisons ?? "overall", comparisonsShow: replicates.comparisons?.comparisonsShow ?? "all", paired: false } as const;
  if (withTest) {
    const statistic = statisticPanels(replicates.unitModel, points, groups, xAxis, true, undefined, undefined, facetLevels, options);
    for (const panel of panels) {
      const match = statistic.find((p) => p.facet === panel.facet && p.populationId === panel.populationId);
      tests.set(panel.key, match?.test ?? null);
      comparisons.set(panel.key, shownComparisons(match?.comparisons ?? [], options.comparisonsShow));
    }
  }
  const testLine = withTest && (options.comparisons === "overall" || [...tests.values()].some(Boolean));
  const brackets = Math.max(0, ...[...comparisons.values()].map(bracketRows));
  const slotPoints = (panel: CellPanel, slot: number) => {
    const cat = xAxis === "populations" ? slot : xAxis === "together" ? panel.slots[slot]?.cat ?? -1 : model.levels.findIndex((level) => level.popId === panel.populationId);
    const group = xAxis === "populations" ? panel.group : panel.slots[slot]?.label;
    return points.filter((p) => p.cat === cat && p.group === group && (!model.hasFacet || (p.facet ?? "") === panel.facet));
  };
  return { statistic: replicates.statistic, unitSel: replicates.unitSel, slotPoints, tests, withTest, comparisons, testLine, brackets };
}

/** A slot's lines of n: its cells and files, and with replicate marks the units they stand for. */
export function cellSlotN(panel: CellPanel, slot: number, replicates: CellReplicateFrame | null): string[] {
  const violin = panel.slots[slot]?.violin;
  if (!violin?.values.length) return [];
  return replicates ? cellMarkNWithUnits(violin, replicates.slotPoints(panel, slot).length, replicates.unitSel) : cellMarkN(violin);
}

/** The layout with a line above the plot for a rank test, as a statistic panel has; unchanged without one. */
export function withTestRow<L extends ChartPanelLayout>(layout: L, tickFont: number, on: boolean): L {
  if (!on) return layout;
  const extra = tickFont + 6;
  return { ...layout, height: layout.height + extra, margin: { ...layout.margin, top: layout.margin.top + extra } };
}

/** A per-cell chart's panels placed as its settings say: wrapped, or a column or row per value of a dimension, headed as the titles name the group and facet. */
export function arrangeCellPanels(
  panels: readonly CellPanel[],
  xAxis: ChartXAxis,
  hasFacet: boolean,
  arrangement: (Pick<ProportionsSettings, "panelColumns" | "panelsPerRow"> & Partial<Pick<ProportionsSettings, "panelRows">>) | undefined,
  titles: PanelTitles = {},
  /** A chart of several channels: their keys, a dimension of its panels. */
  channels?: readonly string[],
) {
  return arrangePanels(
    panels,
    (panel, dimension) => (dimension === "channels" ? panel.channel ?? "" : dimension === "facet" ? panel.facet ?? "" : dimension === "groups" ? panel.group ?? "" : panel.populationId ?? panel.population ?? ""),
    chartPanelDimensions({ valueKind: "cells", plotType: "violin", ...xAxisFields(xAxis), channels: channels ? [...channels] : undefined }, hasFacet),
    arrangement?.panelColumns ?? "",
    arrangement?.panelsPerRow ?? 5,
    arrangement?.panelRows ?? "",
    (panel, dimension) => panelDimensionText(panel, dimension, titles),
  );
}

export function CellValuesChart({
  model,
  plotType,
  xAxis,
  violinBox,
  showN = false,
  axis,
  catColors,
  palette,
  colourByPopulation,
  populationsTogether,
  groupLevels,
  facetLevels,
  fonts,
  appearance,
  containerId = "gl-prop-svg",
  groupTitle,
  facetTitle,
  arrangement,
  only,
  page,
  staticLegend = false,
  axisOptions,
  replicates,
  channels,
}: CellValuesChartProps) {
  const { t } = useI18n();
  const [hoveredLegend, setHoveredLegend] = useState<number | null>(null);
  const [pinnedLegend, setPinnedLegend] = useState<number | null>(null);
  const highlighted = hoveredLegend ?? pinnedLegend;
  // Several channels: each channel's panels, axis and replicate marks; one channel draws `model` as before.
  const parts = channels && channels.length > 1 ? channels : null;
  // With the populations together, one panel per facet: the groups along x, the populations side by side at each.
  const layoutAxis = chartXAxis({ xAxis, populationsTogether });
  const { panels, groups } = useMemo(
    () => (parts
      ? channelCellPanels(parts, layoutAxis, layoutAxis === "populations" ? groupTitle : undefined, facetTitle, { groups: groupLevels, facets: facetLevels })
      : cellPanels(model, layoutAxis, layoutAxis === "populations" ? groupTitle : undefined, facetTitle, { groups: groupLevels, facets: facetLevels })),
    [parts, model, layoutAxis, groupTitle, facetTitle, groupLevels, facetLevels],
  );
  const replicateFrame = useMemo(
    () => (replicates && !parts ? cellReplicateFrame(model, panels, groups, layoutAxis, replicates, facetLevels) : null),
    [replicates, parts, model, panels, groups, layoutAxis, facetLevels],
  );
  const channelFrames = useMemo(
    () => new Map((parts ?? []).flatMap((part) => (part.replicates ? [[part.key, cellReplicateFrame(part.model, panels.filter((panel) => panel.channel === part.key), groups, layoutAxis, part.replicates, facetLevels)] as const] : []))),
    [parts, panels, groups, layoutAxis, facetLevels],
  );
  /** A panel's channel: its cells, transforms and replicate marks. */
  const channelOf = (panel: CellPanel) => {
    const part = parts?.find((entry) => entry.key === panel.channel);
    const of = part?.model ?? model;
    return { model: of, ...channelTransforms(of), replicateFrame: part ? channelFrames.get(part.key) ?? null : replicateFrame };
  };
  const frames = parts ? [...channelFrames.values()] : replicateFrame ? [replicateFrame] : [];
  // A split violin needs its two groups in one panel; otherwise each group's violin is whole.
  const drawnType: CellPlotType = plotType === "splitViolin" && !splitsViolins(groups.length, layoutAxis) ? "violin" : plotType;
  const groupColors = plottingGroupColours(palette, groups, groupLevels);
  const byPopulation = !!colourByPopulation && layoutAxis === "groups";
  const colours = layoutAxis !== "groups" || byPopulation ? catColors : groupColors;
  /** A mark's place in the colours and the legend: its group, or, coloured by population, its panel's population. */
  const tone = (panel: { population: string | null }, slot: { colour: number }) =>
    byPopulation ? Math.max(0, model.catLevels.indexOf(panel.population ?? "")) : slot.colour;
  const legend = (layoutAxis !== "groups" || byPopulation ? model.catLevels : groups).map((label, index) => ({ index, label, color: colours[index] ?? "#888" }));
  const pinnedEntry = pinnedLegend === null ? undefined : legend.find((entry) => entry.index === pinnedLegend);
  const legendColumns = chartLegendColumns(legend.length);
  const clearHighlight = () => {
    setHoveredLegend(null);
    setPinnedLegend(null);
  };
  useEffect(() => {
    setHoveredLegend(null);
    setPinnedLegend(null);
  }, [layoutAxis, legend.length]);
  const markOpacity = (index: number) => (highlighted === null || highlighted === index ? 1 : 0.16);
  // The shapes are worked out once per violin, not on every hover, each median in its channel's measured units.
  const shapes = useMemo(() => {
    const out = new Map<CellViolin, { box: ReturnType<typeof cellBoxStats>; outline: ReturnType<typeof violinOutline> | null; median: number }>();
    for (const of of parts?.map((part) => part.model) ?? [model]) {
      const { toMeasured } = channelTransforms(of);
      for (const violin of of.violins) {
        out.set(violin, {
          box: cellBoxStats(violin.values),
          outline: drawnType !== "box" ? violinOutline(violin.values) : null,
          median: measuredMedian(violin.values, toMeasured),
        });
      }
    }
    return out;
  }, [parts, model, drawnType]);

  // Each channel's panels on its own axis: shared within the channel, or each panel's own within its limits.
  const panelAxes = useMemo(
    () => (parts
      ? parts.flatMap((part) => {
          const own = panels.filter((panel) => panel.channel === part.key);
          return cellPanelAxes(part.model, own, part.axis, axisOptions) ?? own.map(() => part.axis);
        })
      : cellPanelAxes(model, panels, axis, axisOptions)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parts, model, panels, axis, axisOptions?.shared, axisOptions?.min, axisOptions?.max],
  );
  const ih = appearance.height;
  const tickLabels = (panelAxes ?? [axis]).flatMap((own) => own.major.map((tick) => tick.label));
  const slotLabels = panels[0]?.slots.map((slot) => slot.tick ?? slot.label) ?? [];
  const titleChars = Math.max(0, ...panels.map((panel) => panel.title.length));
  const slotN = (panel: CellPanel, si: number) => (showN ? cellSlotN(panel, si, channelOf(panel).replicateFrame) : []);
  const slotNLines = panels.flatMap((panel) => panel.slots.map((_, si) => slotN(panel, si)));
  const nRows = Math.max(0, ...slotNLines.map((lines) => lines.length));
  const layout = cellChartLayout(drawnType, slotLabels, tickLabels, fonts, ih, titleChars, arrangement?.panelWidth ?? 0, slotNLines, frames.some((frame) => frame.withTest), frames.some((frame) => frame.testLine), Math.max(0, ...frames.map((frame) => frame.brackets)));
  const channelKeys = parts?.map((part) => part.key);
  const titles = { group: layoutAxis === "populations" ? groupTitle : undefined, facet: facetTitle, ...(parts ? { channels: Object.fromEntries(parts.map((part) => [part.key, part.label])) } : {}) };
  const pageBy = chartPageDimension({ valueKind: "cells", plotType: "violin", ...xAxisFields(layoutAxis), pageBy: arrangement?.pageBy, channels: channelKeys }, model.hasFacet);
  const placed = placedOrOnly(arrangeCellPanels(pagePanels(panels, pageBy, page, (panel) => panel), layoutAxis, model.hasFacet, arrangement, titles, channelKeys), panels, only, (panel) => panel);
  // In a grid with headings, a panel's title leaves out what its column and row headings say.
  const panelTitle = (panel: CellPanel) =>
    placed.headings ? headedPanelTitle(panel, chartPanelDimensions({ valueKind: "cells", plotType: "violin", ...xAxisFields(layoutAxis), channels: channelKeys }, model.hasFacet), placed.headings, titles) : panel.title;

  const markTip = (violin: CellViolin, median: number) => {
    const n = violin.values.length;
    return `${model.catLevels[violin.cat]} · ${violin.group}${violin.facet !== null && model.hasFacet ? ` · ${violin.facet}` : ""}: ${n.toLocaleString("en-US")} ${n === 1 ? "cell" : "cells"} from ${violin.files.length} ${violin.files.length === 1 ? "file" : "files"}, median ${formatMeasured(median)}`;
  };

  // Ridgelines: a row per slot, top to bottom in the chart's order, each a density of the channel
  // along the value axis, which runs along the bottom; the rows overlap as the Illustration's do.
  const renderRidgelines = (panel: CellPanel) => {
    const { model, toDisplay, replicateFrame } = channelOf(panel);
    const M = layout.margin;
    const iw = layout.width - M.left - M.right;
    const plotBottom = M.top + ih;
    const panelAxis = panelAxes?.[panels.indexOf(panel)] ?? axis;
    const [lo, hi] = panelAxis.range;
    const x = (v: number) => M.left + (iw * ((panelAxis.clip ? v : Math.min(hi, Math.max(lo, v))) - lo)) / (hi - lo);
    const inRange = (v: number) => panelAxis.clip || (v >= lo && v <= hi);
    const { ridgeHeight, baselines } = ridgelineRows(panel.slots.length, M.top, ih);
    const ridges: JSX.Element[] = [];
    const points: JSX.Element[] = [];
    panel.slots.forEach((slot, si) => {
      const violin = slot.violin;
      if (!violin || violin.values.length === 0) return;
      const shape = shapes.get(violin)!;
      const colour = colours[tone(panel, slot)] ?? "#888";
      const baseline = baselines[si];
      const tip = markTip(violin, shape.median);
      const kept = shape.outline ? shape.outline.at.map((v, i) => ({ v, w: shape.outline!.width[i] })).filter((p) => inRange(p.v)) : [];
      const marks: JSX.Element[] = [];
      if (kept.length > 1) {
        const top = kept.map((p) => `${x(p.v).toFixed(2)},${(baseline - p.w * ridgeHeight).toFixed(2)}`);
        marks.push(
          <path key="r" className="gl-prop-mark" d={`M${x(kept[0].v).toFixed(2)},${baseline.toFixed(2)}L${top.join("L")}L${x(kept[kept.length - 1].v).toFixed(2)},${baseline.toFixed(2)}Z`} fill={colour} fillOpacity={0.85} stroke="none">
            <title>{tip}</title>
          </path>,
          <path key="l" d={`M${top.join("L")}`} fill="none" stroke={colour} strokeWidth={1} strokeLinejoin="round" />,
        );
      } else if (!(shape.outline && shape.outline.at.length > 1)) {
        // A single value, or cells all alike: a line up from the row's baseline at the value.
        marks.push(
          <line key="r" className="gl-prop-mark" x1={x(shape.box.median)} x2={x(shape.box.median)} y1={baseline} y2={baseline - ridgeHeight} stroke={colour} strokeWidth={2}>
            <title>{tip}</title>
          </line>,
        );
      }
      ridges.push(
        <g key={si} className="gl-prop-mark-group" opacity={markOpacity(tone(panel, slot))}>
          {marks}
        </g>,
      );
      if (replicateFrame) {
        // Each unit's value on its row's baseline, placed through the axis's transform.
        const units = replicateFrame.slotPoints(panel, si);
        const unitMarks = units.flatMap((p, pi) => {
          const at = toDisplay(p.value);
          if (!inRange(at)) return [];
          return [
            <circle key={`u${pi}`} className="gl-prop-point gl-prop-replicate" cx={x(at)} cy={baseline} r={3.2} fill="#fff" stroke="#1f2937" strokeWidth={1.2}>
              <title>{`${p.unit}: ${replicateFrame.statistic} ${formatMeasured(p.value)} of ${p.cells.toLocaleString("en-US")} ${p.cells === 1 ? "cell" : "cells"} from ${p.files.join(", ")}`}</title>
            </circle>,
          ];
        });
        if (unitMarks.length)
          points.push(
            <g key={`u${si}`} className="gl-prop-mark-group" opacity={markOpacity(tone(panel, slot))}>
              {unitMarks}
            </g>,
          );
      }
    });
    const test = replicateFrame?.withTest ? replicateFrame.tests.get(panel.key) : null;
    return (
      <ChartPanel
        key={panel.key}
        width={layout.width}
        height={plotBottom + M.bottom}
        title={panelTitle(panel)}
        titleFont={fonts.title ?? fonts.axis}
        test={test && { label: test.label, tooltip: `${test.name}, statistic ${test.statistic.toFixed(3)}, on one ${replicateFrame!.statistic} per replicate unit, never on the cells`, plotLeft: M.left, plotWidth: iw, plotTop: M.top, fontSize: fonts.tick }}
      >
        <ChartHorizontalValueAxis
          ticks={panelAxis.major}
          minor={panelAxis.minor}
          x={x}
          left={M.left}
          top={M.top}
          plotWidth={iw}
          plotHeight={ih}
          showGrid={appearance.showGrid}
          tickFont={fonts.tick}
          axisFont={fonts.axis}
          title={model.channelLabel}
        />
        <ChartPlotMarks clipId={`${containerId}-clip-${panel.key}`} clip={!!panelAxis.clip} left={M.left} top={M.top} width={iw} height={ih}>
          {ridges}
          {points}
        </ChartPlotMarks>
        {panel.slots.map((slot, si) => (
          <text key={`y${si}`} x={M.left - 6} y={baselines[si] - 2} textAnchor="end" fontSize={fonts.tick} fill="#334155">
            <title>{slot.tick ?? slot.label}</title>
            {compactChartLabel(slot.tick ?? slot.label)}
          </text>
        ))}
        {nRows > 0 &&
          panel.slots.map((_, si) => {
            const lines = slotN(panel, si);
            return lines.length ? (
              <text key={`n${si}`} className="gl-prop-n" x={M.left + iw + 6} y={baselines[si] - 2} textAnchor="start" fontSize={fonts.tick} fill="#475569">
                {lines.join(" ")}
              </text>
            ) : null;
          })}
      </ChartPanel>
    );
  };

  const renderPanel = (panel: CellPanel) => {
    if (drawnType === "ridgeline") return renderRidgelines(panel);
    const { model, toDisplay, replicateFrame } = channelOf(panel);
    const M = layout.margin;
    const iw = layout.width - M.left - M.right;
    const plotBottom = M.top + ih;
    const panelAxis = panelAxes?.[panels.indexOf(panel)] ?? axis;
    const [lo, hi] = panelAxis.range;
    // Shapes are cut at the axis's ends here, not by a clip path, so every export draws them alike;
    // within typed limits a clip path cuts them at the limits (ChartPlotMarks), not moved.
    const y = (v: number) => M.top + ih * (1 - ((panelAxis.clip ? v : Math.min(hi, Math.max(lo, v))) - lo) / (hi - lo));
    const inRange = (v: number) => panelAxis.clip || (v >= lo && v <= hi);
    const step = panel.slots.length ? iw / panel.slots.length : iw;
    const body: JSX.Element[] = [];
    panel.slots.forEach((slot, si) => {
      const cx = M.left + step * (si + 0.5);
      const violin = slot.violin;
      if (!violin || violin.values.length === 0) return;
      const shape = shapes.get(violin)!;
      const { q1, q3, lo: whiskerLo, hi: whiskerHi } = shape.box;
      const colour = colours[tone(panel, slot)] ?? "#888";
      const tip = markTip(violin, shape.median);
      // A split violin's halves share the panel's centre line, the first group's on the left.
      const split = drawnType === "splitViolin";
      const centre = M.left + iw / 2;
      const side = si === 0 ? -1 : 1;
      const half = split ? Math.min(step * 0.84, 44) : Math.min(step * 0.42, drawnType === "violin" ? 22 : 9);
      const marks: JSX.Element[] = [];
      const kept = shape.outline ? shape.outline.at.map((v, i) => ({ v, w: shape.outline!.width[i] })).filter((p) => inRange(p.v)) : [];
      if (split && kept.length > 1) {
        marks.push(
          <path key="v" className="gl-prop-mark" d={halfViolinPath(kept.map((p) => ({ x: p.w * half, y: y(p.v) })), centre, side)} fill={colour} fillOpacity={0.75} stroke="#334155" strokeWidth={0.6}>
            <title>{tip}</title>
          </path>,
        );
        // The half's median across it, and its quartiles as shorter lines.
        const across = (value: number, share: number) => centre + side * Math.max(0.15, outlineWidthAt(shape.outline!, value)) * half * share;
        marks.push(<line key="m" className="gl-prop-split-median" x1={centre} x2={across(shape.box.median, 1)} y1={y(shape.box.median)} y2={y(shape.box.median)} stroke="#1f2937" strokeWidth={1.2} />);
        if (violinBox) {
          marks.push(
            <line key="q1" x1={centre} x2={across(q1, 0.5)} y1={y(q1)} y2={y(q1)} stroke="#1f2937" strokeWidth={0.8} />,
            <line key="q3" x1={centre} x2={across(q3, 0.5)} y1={y(q3)} y2={y(q3)} stroke="#1f2937" strokeWidth={0.8} />,
          );
        }
      } else if (split && shape.outline && shape.outline.at.length > 1) {
        // Every cell lies beyond the axis's range: nothing to draw.
      } else if (split) {
        // A single value, or cells all alike: a mark across the half at the value.
        marks.push(
          <line key="v" className="gl-prop-mark" x1={centre} x2={centre + side * half} y1={y(shape.box.median)} y2={y(shape.box.median)} stroke={colour} strokeWidth={2}>
            <title>{tip}</title>
          </line>,
        );
      } else if (drawnType === "violin" && kept.length > 1) {
        const right = kept.map((p) => `${(cx + p.w * half).toFixed(2)},${y(p.v).toFixed(2)}`);
        const left = kept.map((p) => `${(cx - p.w * half).toFixed(2)},${y(p.v).toFixed(2)}`).reverse();
        marks.push(
          <path key="v" className="gl-prop-mark" d={`M${right.join("L")}L${left.join("L")}Z`} fill={colour} fillOpacity={0.75} stroke="#334155" strokeWidth={0.6}>
            <title>{tip}</title>
          </path>,
        );
        if (violinBox) {
          marks.push(
            <line key="w" x1={cx} x2={cx} y1={y(whiskerHi)} y2={y(whiskerLo)} stroke="#1f2937" strokeWidth={0.8} />,
            <rect key="b" x={cx - 2.5} y={y(q3)} width={5} height={Math.max(0.5, y(q1) - y(q3))} fill="#1f2937" fillOpacity={0.85} />,
            <circle key="m" cx={cx} cy={y(shape.box.median)} r={2} fill="#fff" stroke="#1f2937" strokeWidth={0.5} />,
          );
        }
      } else if (drawnType === "violin" && shape.outline && shape.outline.at.length > 1) {
        // Every cell lies beyond the axis's range: nothing to draw.
      } else if (drawnType === "violin") {
        // A single value, or cells all alike: a mark at the value.
        marks.push(
          <line key="v" className="gl-prop-mark" x1={cx - half} x2={cx + half} y1={y(shape.box.median)} y2={y(shape.box.median)} stroke={colour} strokeWidth={2}>
            <title>{tip}</title>
          </line>,
        );
      } else {
        marks.push(
          <line key="w" x1={cx} x2={cx} y1={y(whiskerHi)} y2={y(whiskerLo)} stroke="#555" strokeWidth={0.8} />,
          <rect key="b" className="gl-prop-mark" x={cx - half} y={y(q3)} width={half * 2} height={Math.max(0.5, y(q1) - y(q3))} fill={colour} fillOpacity={0.85} stroke="#333" strokeWidth={0.5}>
            <title>{tip}</title>
          </rect>,
          <line key="m" x1={cx - half} x2={cx + half} y1={y(shape.box.median)} y2={y(shape.box.median)} stroke="#111" strokeWidth={1} />,
        );
      }
      if (replicateFrame) {
        // Each unit's value over the pooled cells, placed through the axis's transform; a unit
        // beyond the axis's range is not drawn, as the shapes are cut there.
        // On a split violin they sit over their own half.
        const units = replicateFrame.slotPoints(panel, si);
        const spread = split ? half * 0.4 : half * 0.8;
        const unitX = split ? centre + side * half * 0.5 : cx;
        units.forEach((p, pi) => {
          const at = toDisplay(p.value);
          if (!inRange(at)) return;
          const offset = units.length > 1 ? (pi / (units.length - 1) - 0.5) * spread : 0;
          marks.push(
            <circle key={`u${pi}`} className="gl-prop-point gl-prop-replicate" cx={unitX + offset} cy={y(at)} r={3.2} fill="#fff" stroke="#1f2937" strokeWidth={1.2}>
              <title>{`${p.unit}: ${replicateFrame.statistic} ${formatMeasured(p.value)} of ${p.cells.toLocaleString("en-US")} ${p.cells === 1 ? "cell" : "cells"} from ${p.files.join(", ")}`}</title>
            </circle>,
          );
        });
      }
      body.push(
        <g key={si} className="gl-prop-mark-group" opacity={markOpacity(tone(panel, slot))}>
          {marks}
        </g>,
      );
    });
    const PW = layout.width;
    const PH = plotBottom + layout.margin.bottom;
    const test = replicateFrame?.withTest ? replicateFrame.tests.get(panel.key) : null;
    return (
      <ChartPanel
        key={panel.key}
        width={PW}
        height={PH}
        title={panelTitle(panel)}
        titleFont={fonts.title ?? fonts.axis}
        test={test && { label: test.label, tooltip: `${test.name}, statistic ${test.statistic.toFixed(3)}, on one ${replicateFrame!.statistic} per replicate unit, never on the cells`, plotLeft: M.left, plotWidth: iw, plotTop: M.top - (replicateFrame?.brackets ?? 0) * bracketRowHeight(fonts.tick), fontSize: fonts.tick }}
      >
        <ChartValueAxis
          ticks={panelAxis.major}
          minor={panelAxis.minor}
          y={y}
          left={M.left}
          top={M.top}
          plotWidth={iw}
          plotHeight={ih}
          showGrid={appearance.showGrid}
          tickFont={fonts.tick}
          axisFont={fonts.axis}
          title={model.channelLabel}
        />
        <ChartPlotMarks clipId={`${containerId}-clip-${panel.key}`} clip={!!panelAxis.clip} left={M.left} top={M.top} width={iw} height={ih}>
          {body}
        </ChartPlotMarks>
        <ChartBrackets pairs={replicateFrame?.comparisons.get(panel.key) ?? []} x={(slot) => M.left + step * (slot + 0.5)} plotTop={M.top} fontSize={fonts.tick} on={`one ${replicateFrame?.statistic ?? "value"} per replicate unit, never on the cells`} />
        <ChartCategoryAxis ticks={panel.slots.map((slot, si) => ({ x: M.left + step * (si + 0.5), label: slot.tick ?? slot.label }))} plotBottom={plotBottom} rotate={layout.rotateLabels} tickFont={fonts.tick} />
        {nRows > 0 && <ChartNRow ticks={panel.slots.map((_, si) => ({ x: M.left + step * (si + 0.5), lines: slotN(panel, si) }))} baseline={plotBottom + layout.nBaseline} tickFont={fonts.tick} />}
      </ChartPanel>
    );
  };

  const grid = chartGridCells(placed, renderPanel, { font: fonts.title ?? fonts.axis, panelWidth: layout.width, panelHeight: layout.margin.top + ih + layout.margin.bottom });

  return (
    <div
      id={containerId}
      className="gl-prop-chart"
      style={only ? undefined : { minWidth: Math.max(360, legendColumns * 145) }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && highlighted !== null) {
          event.stopPropagation();
          clearHighlight();
        }
      }}
    >
      <div
        className="gl-prop-panels"
        style={{ gridTemplateColumns: grid.template }}
        onClick={pinnedLegend === null ? undefined : clearHighlight}
        title={pinnedLegend === null ? undefined : t("Click to show every category again")}
      >
        {grid.cells}
      </div>
      {pinnedEntry && <ChartHighlightNote label={pinnedEntry.label} onClear={clearHighlight} />}
      <ChartLegend
        entries={legend}
        title={layoutAxis === "groups" ? groupTitle : undefined}
        highlighted={highlighted}
        pinned={pinnedLegend}
        setHovered={setHoveredLegend}
        setPinned={setPinnedLegend}
        hidden={!appearance.showLegend || (!!only && !("legend" in only))}
        ariaLabel={layoutAxis === "groups" ? "Groups" : "Populations"}
        fontSize={fonts.legend}
        columns={legendColumns}
        interactive={!staticLegend}
      />
    </div>
  );
}
