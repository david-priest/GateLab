// StatisticChart.tsx — the Plotting tab's per-sample statistic chart: a channel's median, mean or
// geometric mean in each replicate unit's cells of each population, taken on linear values as the
// Statistics tab's "Raw" takes them, drawn as a box, a bar with an error bar, or points, with a
// rank test between the groups. Built as the other Plotting charts are (`.gl-prop-chart`,
// `svg.gl-prop-panel` panels, an HTML legend), so their export and Layout block take it as is.

import { useEffect, useMemo, useState } from "react";
import { cellBoxStats, cellStatistic, type CellValuesModel } from "../engine/cellValuesModel";
import { axisTicks } from "../engine/layoutChart";
import type { PaletteName } from "../engine/palettes";
import { plottingGroupColours } from "./plottingColours";
import { PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "../engine/proportionsSettings";
import { useI18n } from "./i18n";
import { cellPanelLayout, togetherTick, type CellPanelLayout, type PlottingLevels } from "./CellValuesChart";
import { chartXAxis, xAxisFields, type ChartXAxis } from "./chart/chartXAxis";
import { compactChartLabel, formatMeasured } from "./chart/chartFormat";
import { ChartCategoryAxis, ChartValueAxis } from "./chart/ChartAxis";
import { ChartPanel } from "./chart/ChartPanel";
import { withNRows } from "./chart/chartLayout";
import { ChartNRow, nLines, nRowSize, withNUnit } from "./chart/chartN";
import { ChartHighlightNote, ChartLegend, chartLegendColumns } from "./chart/ChartLegend";
import { arrangePanels, chartPageDimension, chartPanelDimensions, headedPanelTitle, pagePanels, panelDimensionText, placedOrOnly, type PanelTitles } from "./panelArrangement";
import { chartGridCells } from "./chart/ChartPanelGrid";
import type { LayoutProportionsPanel } from "../engine/layout";
import { columnValueOrder } from "../engine/levelOrder";
import { mean, sampleSd } from "../engine/summaryStats";
import { fittedScale, limitedScale, typedLimits, type ChartAxisFrame } from "./chart/valueAxis";
import { ChartPlotMarks } from "./chart/ChartPlotMarks";
import { bracketRowHeight, bracketRows, ChartBrackets, panelTests, shownComparisons, withBracketRows, type ComparisonOptions, type PanelComparison, type PanelOverallTest } from "./chart/chartComparisons";

/** One replicate unit's statistic for one population in one group (and facet). */
export interface StatisticPoint {
  cat: number;
  group: string;
  facet: string | null;
  /** The unit as shown: its file's name when each file is a unit, else the unit's metadata value. */
  unit: string;
  value: number;
  /** The cells it is taken of. */
  cells: number;
  /** For the geometric mean, the cells left out as not positive; absent for the other statistics. */
  notPositive?: number;
  files: string[];
}

/**
 * Each unit's statistic, from a model pooled by unit on linear values. A unit with no cell of a
 * population has no value for it and is left out. Its cells are those the statistic is taken of:
 * for the geometric mean, the positive ones, with the rest counted apart.
 */
export function statisticPoints(
  model: CellValuesModel,
  statistic: ProportionsSettings["statistic"],
  unitIsFile = false,
  /** The chart's order of its replicate units; without it, the order the model holds them. */
  unitLevels?: readonly string[],
): StatisticPoint[] {
  const out: StatisticPoint[] = [];
  for (const violin of model.violins) {
    const value = cellStatistic(violin.values, statistic);
    if (!Number.isFinite(value)) continue;
    const unit = unitIsFile && violin.files.length === 1 ? violin.files[0] : violin.unit ?? "";
    // The geometric mean is taken of the positive cells only (cellStatistic).
    let notPositive = 0;
    if (statistic === "geomean") for (const v of violin.values) if (!(v > 0)) notPositive++;
    const counts = statistic === "geomean" ? { cells: violin.values.length - notPositive, notPositive } : { cells: violin.values.length };
    out.push({ cat: violin.cat, group: violin.group, facet: violin.facet, unit, value, ...counts, files: violin.files });
  }
  const units = columnValueOrder(out.map((point) => point.unit), unitLevels);
  const rank = new Map(units.map((unit, i) => [unit, i]));
  return out.sort((a, b) => rank.get(a.unit)! - rank.get(b.unit)!);
}

/** The summary drawn at a slot: n, mean, SD, SEM, quartiles and Tukey whiskers of its units' values. */
export interface StatisticSummary {
  n: number;
  mean: number;
  sd: number;
  sem: number;
  median: number;
  q1: number;
  q3: number;
  lo: number;
  hi: number;
}

export function summariseStatistic(values: readonly number[]): StatisticSummary {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  const sd = n > 1 ? sampleSd(sorted) : 0;
  const box = cellBoxStats(sorted);
  return { n, mean: mean(sorted), sd, sem: n > 0 ? sd / Math.sqrt(n) : 0, median: box.median, q1: box.q1, q3: box.q3, lo: box.lo, hi: box.hi };
}

export interface StatisticPanel {
  key: string;
  title: string;
  facet: string | null;
  group: string | null;
  population: string | null;
  /** Its population's id, when a panel per population. */
  populationId: string | null;
  /** Its channel's key, in a chart of several channels. */
  channel?: string;
  /** With the populations together, a slot's label is its group, `cat` its population and `tick` what is written under it. */
  slots: { label: string; colour: number; points: StatisticPoint[]; cat?: number; tick?: string }[];
  /** The rank test between the panel's groups, when asked for and the groups run along x. */
  test: PanelOverallTest | null;
  /** Every pair of the panel's groups tested, with pairwise comparisons on; empty otherwise. */
  comparisons: PanelComparison[];
}

/**
 * The chart's panels: populations along x with a panel per group, groups along x with a panel per
 * population, or groups along x with every population side by side at each in one panel; a set per facet.
 */
export function statisticPanels(
  model: Pick<CellValuesModel, "catLevels" | "hasFacet"> & { levels?: CellValuesModel["levels"] },
  points: readonly StatisticPoint[],
  groups: readonly string[],
  xAxis: ChartXAxis,
  test: boolean,
  groupTitle?: string,
  facetTitle?: string,
  /** The chart's order of its facets; without it, the order the points hold them. */
  facetLevels?: readonly string[],
  /** Pairwise comparisons; unset, the overall test alone. */
  comparisons?: ComparisonOptions,
): StatisticPanel[] {
  const facets = model.hasFacet ? columnValueOrder(points.map((p) => p.facet ?? ""), facetLevels) : [null];
  const at = (cat: number, group: string, facet: string | null) =>
    points.filter((p) => p.cat === cat && p.group === group && (!model.hasFacet || (p.facet ?? "") === facet));
  const facetPart = (facet: string | null) => (model.hasFacet ? (facetTitle ? `${facetTitle}: ${facet || "(NA)"}` : facet || "(NA)") : null);
  const panels: StatisticPanel[] = [];
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
          slots: model.catLevels.map((label, cat) => ({ label, colour: cat, points: at(cat, group, facet) })),
          test: null,
          comparisons: [],
        });
      });
    } else if (xAxis === "together") {
      // No rank test: it compares the groups within a panel of one population.
      panels.push({
        key: `f${fi}`,
        title: facetPart(facet) ?? "",
        facet,
        group: null,
        population: null,
        populationId: null,
        slots: groups.flatMap((group) => model.catLevels.map((_, ci) => ({ label: group, tick: togetherTick(group, ci, model.catLevels.length), cat: ci, colour: ci, points: at(ci, group, facet) }))),
        test: null,
        comparisons: [],
      });
    } else {
      model.catLevels.forEach((cat, ci) => {
        const slots = groups.map((group, gi) => ({ label: group, colour: gi, points: at(ci, group, facet) }));
        const tests = test
          ? panelTests(
              slots.map((slot) => ({ label: slot.label, values: slot.points.map((p) => ({ unit: p.unit, value: p.value })) })),
              comparisons ?? { comparisons: "overall", comparisonsShow: "all", paired: false },
            )
          : null;
        panels.push({
          key: `f${fi}-c${ci}`,
          title: [cat, facetPart(facet)].filter(Boolean).join(" · "),
          facet,
          group: null,
          population: cat,
          populationId: model.levels?.[ci]?.popId ?? null,
          slots,
          test: tests?.overall ?? null,
          comparisons: tests?.pairs ?? [],
        });
      });
    }
  });
  return panels;
}

/** The groups of a model, in the chart's order of its groups when given, else in the order the model holds them. */
export function statisticGroups(model: Pick<CellValuesModel, "violins">, groupLevels?: readonly string[]): string[] {
  return columnValueOrder(model.violins.map((v) => v.group), groupLevels);
}

/** The values a statistic axis must hold: every point, and each slot's error bar for bars and points. */
export function statisticAxisValues(
  points: readonly StatisticPoint[],
  panels: readonly StatisticPanel[],
  plotType: "box" | "bar" | "dots",
  errorBar: ProportionsSettings["errorBar"],
): number[] {
  const values = points.map((p) => p.value);
  if (plotType !== "box") {
    for (const panel of panels)
      for (const slot of panel.slots) {
        if (!slot.points.length) continue;
        const s = summariseStatistic(slot.points.map((p) => p.value));
        const err = errorBar === "sem" ? s.sem : s.sd;
        values.push(s.mean + err, s.mean - err);
      }
  }
  return values;
}

/** How a statistic axis is framed: from 0 (unset) or fitted to the values, within typed limits. */
export interface StatisticAxisOptions {
  fromZero?: boolean;
  limits?: [number | null, number | null] | null;
}

/**
 * The value axis: linear, in measured units, from 0 (or below, for a negative value) to above the
 * highest point, error bar or whisker, or fitted to them with headroom; a bar's length and an SD
 * can be read only on a linear axis. Typed limits replace either end and cut the marks there.
 */
export function statisticAxis(
  points: readonly StatisticPoint[],
  panels: readonly StatisticPanel[],
  plotType: "box" | "bar" | "dots",
  errorBar: ProportionsSettings["errorBar"],
  options: StatisticAxisOptions = {},
): ChartAxisFrame {
  return statisticValueAxis(statisticAxisValues(points, panels, plotType, errorBar), options);
}

/** A statistic axis over the values given, as `statisticAxis` frames it. */
export function statisticValueAxis(values: readonly number[], options: StatisticAxisOptions = {}): ChartAxisFrame {
  const auto = options.fromZero === false ? fittedScale(values.length ? values : [0, 1]) : axisTicks(values.length ? values : [0, 1]);
  const scale = limitedScale(auto, options.limits ?? null);
  return {
    range: [scale.min, scale.max],
    major: scale.ticks.map((at) => ({ at, label: formatMeasured(at) })),
    minor: [],
    ...(scale.clip ? { clip: true } : {}),
  };
}

// The measured-value format (chart/chartFormat), still exported from here.
export { formatMeasured };

/** A panel's size: as a per-cell box panel's, with a line above the plot for the test when shown. */
export function statisticPanelLayout(
  labels: readonly string[],
  tickLabels: readonly string[],
  fonts: { tick: number; axis: number },
  plotHeight: number,
  titleChars: number,
  panelWidth: number,
  withTest: boolean,
  /** The width a slot needs for its line of n; 0 without it. */
  nWidth = 0,
): CellPanelLayout {
  const base = cellPanelLayout("box", labels, tickLabels, fonts.tick, plotHeight, titleChars, fonts.axis, panelWidth, nWidth);
  if (!withTest) return base;
  const extra = fonts.tick + 6;
  return { ...base, height: base.height + extra, margin: { ...base.margin, top: base.margin.top + extra } };
}

const STATISTIC_NAMES: Record<ProportionsSettings["statistic"], string> = {
  median: "Median",
  mean: "Mean",
  geomean: "Geometric mean",
};

/** The value axis's title: the statistic and the channel. */
export function statisticTitle(statistic: ProportionsSettings["statistic"], channelLabel: string): string {
  return `${STATISTIC_NAMES[statistic]} ${channelLabel}`;
}

/** A slot's n as written under it: its replicate units, one point each; none for an empty slot. */
export function statisticSlotN(slot: { points: readonly StatisticPoint[] }): string[] {
  return slot.points.length ? nLines(slot.points.length) : [];
}

/** A statistic chart's panels placed as its settings say, headed as the titles name the group and facet. */
export function arrangeStatisticPanels(
  panels: readonly StatisticPanel[],
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
    chartPanelDimensions({ valueKind: "statistic", plotType: "box", ...xAxisFields(xAxis), channels: channels ? [...channels] : undefined }, hasFacet),
    arrangement?.panelColumns ?? "",
    arrangement?.panelsPerRow ?? 5,
    arrangement?.panelRows ?? "",
    (panel, dimension) => panelDimensionText(panel, dimension, titles),
  );
}

export interface StatisticChartProps {
  /** The value axis's limits, in measured units, whether it starts at 0, and whether every panel shares one; unset, as the chart kind draws it. */
  axisSettings?: Pick<ProportionsSettings, "valueMin" | "valueMax" | "valueFromZero" | "shareValueAxis">;
  /** One value axis for every panel, made outside the chart: over the panels of several charts drawn side by side. */
  valueAxis?: ChartAxisFrame;
  /** The cells pooled by replicate unit, on linear values. */
  model: CellValuesModel;
  statistic: ProportionsSettings["statistic"];
  plotType: "box" | "bar" | "dots";
  errorBar: ProportionsSettings["errorBar"];
  /** A rank test between the groups of each panel; drawn only with the groups along x. */
  test: boolean;
  /** Write each slot's replicate units under its label, and what they are on the value axis's title. */
  showN?: boolean;
  xAxis: "populations" | "groups";
  /** The replicate unit factor, so a unit that is a file is named by its file. */
  unitSel: string;
  catColors: string[];
  palette: PaletteName;
  /** With the groups along x, colour each mark by its panel's population in place of its group (settings.colourByPopulation). */
  colourByPopulation?: boolean;
  /** With the groups along x, every population in one panel, side by side at each group (settings.populationsTogether). */
  populationsTogether?: boolean;
  /** Every group of the chart, over all the files it was made with, before an iteration or a panel narrows them: each group takes the colour of its place here. */
  groupLevels?: readonly string[];
  /** Every facet and replicate unit of the chart, in the order they are drawn. */
  facetLevels?: readonly string[];
  unitLevels?: readonly string[];
  /** Text sizes; a panel's title takes `title`, else the axis size. */
  fonts: { tick: number; axis: number; legend: number; title?: number };
  /** How the value axis writes its ticks; unset, as the Plotting tab does. */
  formatTick?: (value: number) => string;
  appearance: { height: number; showGrid: boolean; showLegend: boolean; showPoints: boolean; pointRadius: number };
  containerId?: string;
  groupTitle?: string;
  facetTitle?: string;
  arrangement?: Pick<ProportionsSettings, "panelColumns" | "panelsPerRow" | "panelWidth"> & Partial<Pick<ProportionsSettings, "panelRows" | "pageBy">>;
  /** One panel of the chart, or its legend alone, as a Layout block of one panel draws it. */
  only?: LayoutProportionsPanel;
  /** With pages (`arrangement.pageBy`), the page drawn, by its value; unset, every panel. */
  page?: string;
  /** The legend as a key alone: its entries are not buttons and highlight nothing. A Layout block and a figure's chart panel draw it so. */
  staticLegend?: boolean;
  /** Pairwise comparisons drawn as brackets, and which; unset, the overall test alone. */
  comparisons?: Pick<ProportionsSettings, "comparisons" | "comparisonsShow">;
  /**
   * Several channels, each drawn in panels of its own on its own value axis, its axis settings
   * taken within the channel; unset or one, the chart draws `model`.
   */
  channels?: readonly StatisticChannelPart[];
}

/** One channel of a statistic chart of several: its cells pooled by replicate unit, on linear values. */
export interface StatisticChannelPart {
  key: string;
  label: string;
  model: CellValuesModel;
}

/**
 * A statistic chart of several channels laid out: each channel's frame (statisticChartFrame), its
 * panels keyed and titled with the channel and on the channel's axes, and one panel layout that
 * holds every channel's: the widest margins and plot. The groups are the first channel's.
 */
export function statisticChannelsFrame(
  parts: readonly StatisticChannelPart[],
  settings: Parameters<typeof statisticChartFrame>[1],
  groupTitle?: string,
  facetTitle?: string,
  order: PlottingLevels = {},
): ReturnType<typeof statisticChartFrame> {
  const frames = parts.map((part) => statisticChartFrame(part.model, settings, groupTitle, facetTitle, order));
  const layouts = frames.map((frame) => frame.layout);
  const most = (of: (layout: (typeof layouts)[number]) => number) => Math.max(0, ...layouts.map(of));
  const margin = { top: most((l) => l.margin.top), right: most((l) => l.margin.right), bottom: most((l) => l.margin.bottom), left: most((l) => l.margin.left) };
  const inner = most((l) => l.width - l.margin.left - l.margin.right);
  return {
    points: frames.flatMap((frame) => frame.points),
    groups: frames[0]?.groups ?? [],
    panels: frames.flatMap((frame, ci) => frame.panels.map((panel) => ({ ...panel, key: `c${ci}-${panel.key}`, channel: parts[ci].key, title: [panel.title, parts[ci].label].filter(Boolean).join(" · ") }))),
    axes: frames.flatMap((frame) => frame.axes),
    layout: {
      ...layouts[0],
      margin,
      width: margin.left + inner + margin.right,
      height: margin.top + settings.height + margin.bottom,
      rotateLabels: layouts.some((l) => l.rotateLabels),
      nBaseline: most((l) => l.nBaseline),
    },
    comparisons: frames[0].comparisons,
    brackets: Math.max(0, ...frames.map((frame) => frame.brackets)),
  };
}

/** Everything the chart and its Layout frame lay out from, worked out once. */
export function statisticChartFrame(
  model: CellValuesModel,
  settings: Pick<ProportionsSettings, "statistic" | "errorBar" | "test" | "xAxis" | "unitSel" | "panelWidth" | "height" | "fontTick" | "fontAxis"> &
    Partial<Pick<ProportionsSettings, "valueMin" | "valueMax" | "valueFromZero" | "shareValueAxis" | "comparisons" | "comparisonsShow" | "populationsTogether">> & { plotType: "box" | "bar" | "dots"; showN?: boolean },
  groupTitle?: string,
  facetTitle?: string,
  /** The chart's order of its groups, facets and replicate units; without it, the order the model holds them. */
  order: PlottingLevels = {},
  /** One axis for every panel, made outside the chart (StatisticChartProps.valueAxis). */
  valueAxis?: ChartAxisFrame,
) {
  const points = statisticPoints(model, settings.statistic, settings.unitSel === PROPORTIONS_SAMPLE_FACTOR || settings.unitSel === PROPORTIONS_NO_FACTOR, order.units);
  const groups = statisticGroups(model, order.groups);
  const xAxis = chartXAxis(settings);
  const withTest = settings.test && xAxis === "groups";
  const comparisons: ComparisonOptions = { comparisons: settings.comparisons ?? "overall", comparisonsShow: settings.comparisonsShow ?? "all", paired: false };
  const panels = statisticPanels(model, points, groups, xAxis, withTest, xAxis === "populations" ? groupTitle : undefined, facetTitle, order.facets, comparisons);
  // Pairwise, a panel of two groups draws a bracket instead of the line, so the line's row is kept
  // only where a panel writes one; the brackets take the rows the most stacked panel needs.
  const testLine = withTest && (comparisons.comparisons === "overall" || panels.some((panel) => panel.test));
  const brackets = withTest ? Math.max(0, ...panels.map((panel) => bracketRows(shownComparisons(panel.comparisons, comparisons.comparisonsShow)))) : 0;
  // With a panel per population, each panel is framed on its own values, as the proportion
  // boxplot frames each population, since populations can differ by orders of magnitude; with a
  // panel per group, the panels share one axis so the groups compare across them. Either can be
  // set (shareValueAxis); bars always start at 0, a bar's length being its value. With the
  // populations together, a panel per facet, the panels share one axis as with a panel per group.
  const options = { fromZero: settings.plotType === "bar" || settings.valueFromZero !== false, limits: typedLimits(settings.valueMin, settings.valueMax) };
  const shared = valueAxis ?? statisticAxis(points, panels, settings.plotType, settings.errorBar, options);
  const axes = !valueAxis && !(settings.shareValueAxis ?? xAxis !== "groups")
    ? panels.map((panel) => {
        const own = panel.slots.flatMap((slot) => slot.points);
        return own.length ? statisticAxis(own, [panel], settings.plotType, settings.errorBar, options) : shared;
      })
    : panels.map(() => shared);
  const nSize = nRowSize(settings.showN ? panels.flatMap((panel) => panel.slots.map(statisticSlotN)) : [], settings.fontTick);
  const layout = withNRows(
    withBracketRows(statisticPanelLayout(
      panels[0]?.slots.map((slot) => slot.tick ?? slot.label) ?? [],
      axes.flatMap((axis) => axis.major.map((tick) => tick.label)),
      { tick: settings.fontTick, axis: settings.fontAxis },
      settings.height,
      Math.max(0, ...panels.map((panel) => panel.title.length)),
      settings.panelWidth,
      testLine,
      nSize.width,
    ), settings.fontTick, brackets),
    settings.fontTick,
    nSize.rows,
  );
  return { points, groups, panels, axes, layout, comparisons, brackets };
}

export function StatisticChart({
  model,
  statistic,
  plotType,
  errorBar,
  test,
  showN = false,
  xAxis,
  unitSel,
  catColors,
  palette,
  colourByPopulation,
  populationsTogether,
  groupLevels,
  facetLevels,
  unitLevels,
  fonts,
  formatTick,
  appearance,
  containerId = "gl-prop-svg",
  groupTitle,
  facetTitle,
  arrangement,
  only,
  page,
  staticLegend = false,
  axisSettings,
  valueAxis,
  comparisons: comparisonSettings,
  channels,
}: StatisticChartProps) {
  const { t } = useI18n();
  const [hoveredLegend, setHoveredLegend] = useState<number | null>(null);
  const [pinnedLegend, setPinnedLegend] = useState<number | null>(null);
  const highlighted = hoveredLegend ?? pinnedLegend;
  // Several channels: each channel's panels on its own axes; one channel draws `model` as before.
  const parts = channels && channels.length > 1 ? channels : null;
  const { groups, panels, axes, layout, comparisons, brackets } = useMemo(
    () => {
      const frameSettings = { statistic, errorBar, test, showN, xAxis, populationsTogether, unitSel, plotType, panelWidth: arrangement?.panelWidth ?? 0, height: appearance.height, fontTick: fonts.tick, fontAxis: fonts.axis, valueMin: axisSettings?.valueMin, valueMax: axisSettings?.valueMax, valueFromZero: axisSettings?.valueFromZero, shareValueAxis: axisSettings?.shareValueAxis, comparisons: comparisonSettings?.comparisons, comparisonsShow: comparisonSettings?.comparisonsShow };
      const order = { groups: groupLevels, facets: facetLevels, units: unitLevels };
      return parts
        ? statisticChannelsFrame(parts, frameSettings, groupTitle, facetTitle, order)
        : statisticChartFrame(model, frameSettings, groupTitle, facetTitle, order, valueAxis);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parts, model, statistic, errorBar, test, showN, xAxis, populationsTogether, unitSel, plotType, arrangement?.panelWidth, appearance.height, fonts.tick, fonts.axis, groupTitle, facetTitle, groupLevels, facetLevels, unitLevels, axisSettings?.valueMin, axisSettings?.valueMax, axisSettings?.valueFromZero, axisSettings?.shareValueAxis, valueAxis, comparisonSettings?.comparisons, comparisonSettings?.comparisonsShow],
  );
  const groupColors = plottingGroupColours(palette, groups, groupLevels);
  // With the populations together, one panel per facet: the groups along x, the populations side by side at each.
  const layoutAxis = chartXAxis({ xAxis, populationsTogether });
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
  const channelKeys = parts?.map((part) => part.key);
  const titles = { group: layoutAxis === "populations" ? groupTitle : undefined, facet: facetTitle, ...(parts ? { channels: Object.fromEntries(parts.map((part) => [part.key, part.label])) } : {}) };
  const pageBy = chartPageDimension({ valueKind: "statistic", plotType: "box", ...xAxisFields(layoutAxis), pageBy: arrangement?.pageBy, channels: channelKeys }, model.hasFacet);
  const placed = placedOrOnly(arrangeStatisticPanels(pagePanels(panels, pageBy, page, (panel) => panel), layoutAxis, model.hasFacet, arrangement, titles, channelKeys), panels, only, (panel) => panel);
  // In a grid with headings, a panel's title leaves out what its column and row headings say.
  const panelTitle = (panel: StatisticPanel) =>
    placed.headings ? headedPanelTitle(panel, chartPanelDimensions({ valueKind: "statistic", plotType: "box", ...xAxisFields(layoutAxis), channels: channelKeys }, model.hasFacet), placed.headings, titles) : panel.title;
  // A panel's channel: its cells and its value axis's title.
  const channelOf = (panel: StatisticPanel) => {
    const of = parts?.find((part) => part.key === panel.channel)?.model ?? model;
    return { model: of, valueTitle: showN ? withNUnit(statisticTitle(statistic, of.channelLabel), unitSel) : statisticTitle(statistic, of.channelLabel) };
  };
  const ih = appearance.height;

  const renderPanel = (panel: StatisticPanel) => {
    const { model, valueTitle } = channelOf(panel);
    const axis = axes[panels.indexOf(panel)] ?? axes[0];
    const [lo, hi] = axis.range;
    const M = layout.margin;
    const iw = layout.width - M.left - M.right;
    const plotBottom = M.top + ih;
    // Within typed limits the marks are not held to the axis but cut at it (ChartPlotMarks).
    const y = (v: number) => M.top + ih * (1 - ((axis.clip ? v : Math.min(hi, Math.max(lo, v))) - lo) / (hi - lo));
    const step = panel.slots.length ? iw / panel.slots.length : iw;
    const half = Math.min(step * 0.36, 16);
    const body: JSX.Element[] = [];
    panel.slots.forEach((slot, si) => {
      if (!slot.points.length) return;
      const cx = M.left + step * (si + 0.5);
      const colour = colours[tone(panel, slot)] ?? "#888";
      const s = summariseStatistic(slot.points.map((p) => p.value));
      const err = errorBar === "sem" ? s.sem : s.sd;
      const where = `${slot.points[0] ? model.catLevels[slot.points[0].cat] : ""} · ${slot.points[0]?.group ?? ""}`;
      const tip =
        plotType === "box"
          ? `${where}: ${s.n} ${s.n === 1 ? "unit" : "units"}, median ${formatMeasured(s.median)}, quartiles ${formatMeasured(s.q1)}–${formatMeasured(s.q3)}`
          : `${where}: ${s.n} ${s.n === 1 ? "unit" : "units"}, mean ${formatMeasured(s.mean)} ± ${errorBar === "sem" ? "SEM" : "SD"} ${formatMeasured(err)}`;
      const marks: JSX.Element[] = [];
      if (plotType === "box") {
        marks.push(
          <line key="w" x1={cx} x2={cx} y1={y(s.hi)} y2={y(s.lo)} stroke="#555" strokeWidth={0.8} />,
          <rect key="b" className="gl-prop-mark" x={cx - half} y={y(s.q3)} width={half * 2} height={Math.max(0.5, y(s.q1) - y(s.q3))} fill={colour} fillOpacity={appearance.showPoints ? 0.35 : 0.85} stroke="#333" strokeWidth={0.5}>
            <title>{tip}</title>
          </rect>,
          <line key="m" x1={cx - half} x2={cx + half} y1={y(s.median)} y2={y(s.median)} stroke="#111" strokeWidth={1.2} />,
        );
      } else {
        if (plotType === "bar") {
          const base = y(Math.max(lo, Math.min(hi, 0)));
          const top = y(s.mean);
          marks.push(
            <rect key="b" className="gl-prop-mark" x={cx - half} y={Math.min(base, top)} width={half * 2} height={Math.max(0.5, Math.abs(base - top))} fill={colour} fillOpacity={appearance.showPoints ? 0.45 : 0.85} stroke="#333" strokeWidth={0.5}>
              <title>{tip}</title>
            </rect>,
          );
        } else {
          marks.push(
            <line key="b" className="gl-prop-mark" x1={cx - half} x2={cx + half} y1={y(s.mean)} y2={y(s.mean)} stroke="#111" strokeWidth={1.6}>
              <title>{tip}</title>
            </line>,
          );
        }
        if (s.n > 1) {
          const cap = half * 0.5;
          marks.push(
            <line key="e" x1={cx} x2={cx} y1={y(s.mean + err)} y2={y(s.mean - err)} stroke="#111" strokeWidth={0.9} />,
            <line key="eh" x1={cx - cap} x2={cx + cap} y1={y(s.mean + err)} y2={y(s.mean + err)} stroke="#111" strokeWidth={0.9} />,
            <line key="el" x1={cx - cap} x2={cx + cap} y1={y(s.mean - err)} y2={y(s.mean - err)} stroke="#111" strokeWidth={0.9} />,
          );
        }
      }
      if (appearance.showPoints || plotType === "dots") {
        const spread = half * 0.8;
        slot.points.forEach((p, pi) => {
          const offset = slot.points.length > 1 ? (pi / (slot.points.length - 1) - 0.5) * spread : 0;
          marks.push(
            <circle key={`p${pi}`} className="gl-prop-point" cx={cx + offset} cy={y(p.value)} r={appearance.pointRadius + 0.5} fill={colour} stroke="#1f2937" strokeWidth={0.6}>
              <title>{`${p.unit}: ${STATISTIC_NAMES[statistic].toLowerCase()} ${formatMeasured(p.value)} of ${p.cells.toLocaleString("en-US")} ${p.cells === 1 ? "cell" : "cells"}${p.notPositive ? `, ${p.notPositive.toLocaleString("en-US")} not positive left out,` : ""} from ${p.files.length} ${p.files.length === 1 ? "file" : "files"}`}</title>
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
    const PH = plotBottom + M.bottom;
    return (
      <ChartPanel
        key={panel.key}
        width={PW}
        height={PH}
        title={panelTitle(panel)}
        titleFont={fonts.title ?? fonts.axis}
        test={panel.test && { label: panel.test.label, tooltip: `${panel.test.name}, statistic ${panel.test.statistic.toFixed(3)}, on one value per replicate unit`, plotLeft: M.left, plotWidth: iw, plotTop: M.top - brackets * bracketRowHeight(fonts.tick), fontSize: fonts.tick }}
      >
        <ChartValueAxis
          ticks={formatTick ? axis.major.map((tick) => ({ ...tick, label: formatTick(tick.at) })) : axis.major}
          y={y}
          left={M.left}
          top={M.top}
          plotWidth={iw}
          plotHeight={ih}
          showGrid={appearance.showGrid}
          tickFont={fonts.tick}
          axisFont={fonts.axis}
          title={
            <>
              <title>{valueTitle}</title>
              {compactChartLabel(valueTitle, Math.max(8, Math.floor(ih / (fonts.axis * 0.6))))}
            </>
          }
        />
        <ChartPlotMarks clipId={`${containerId}-clip-${panel.key}`} clip={!!axis.clip} left={M.left} top={M.top} width={iw} height={ih}>
          {body}
        </ChartPlotMarks>
        <ChartBrackets pairs={shownComparisons(panel.comparisons, comparisons.comparisonsShow)} x={(slot) => M.left + step * (slot + 0.5)} plotTop={M.top} fontSize={fonts.tick} on="one value per replicate unit" />
        <ChartCategoryAxis ticks={panel.slots.map((slot, si) => ({ x: M.left + step * (si + 0.5), label: slot.tick ?? slot.label }))} plotBottom={plotBottom} rotate={layout.rotateLabels} tickFont={fonts.tick} />
        {showN && <ChartNRow ticks={panel.slots.map((slot, si) => ({ x: M.left + step * (si + 0.5), lines: statisticSlotN(slot) }))} baseline={plotBottom + layout.nBaseline} tickFont={fonts.tick} />}
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
