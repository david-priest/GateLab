// ProportionsChart.tsx — the Plotting tab's proportion chart: stacked bars of each group's
// composition, or a box per group of each replicate unit's share of a population, in panels by
// facet (and population), with an HTML legend; and the composer that redraws the chart and its
// legend as one SVG for export. Moved out of PlottingTab.tsx, which re-exports it.

import { useEffect, useMemo, useState } from "react";
import {
  computeStackedBars,
  computeBoxes,
  perUnitProps,
  nestedBarLayout,
  type SampleComposition,
} from "../engine/proportions";
import type { PopulationMap } from "../engine/models";
import type { PaletteName } from "../engine/palettes";
import { plottingGroupColours } from "./plottingColours";
import { SAMPLE_ID_FIELD } from "../engine/metadata";
import { useI18n } from "./i18n";
import type { ProportionsSettings } from "../engine/proportionsModel";
import { PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR } from "../engine/proportionsSettings";
import { arrangePanels, chartPageDimension, chartPanelDimensions, headedPanelTitle, pagePanels, panelDimensionText, placedOrOnly } from "./panelArrangement";
import { chartGridCells } from "./chart/ChartPanelGrid";
import type { LayoutProportionsPanel } from "../engine/layout";
import { columnValueOrder } from "../engine/levelOrder";
import { formatMeasured, summariseStatistic } from "./StatisticChart";
import { axisTicks } from "../engine/layoutChart";
import { compactChartLabel, formatPercentTick } from "./chart/chartFormat";
import { fittedInnerWidth, labelsRotate, labelWidths, leftForTurnedLabels, longestLabelWidth, nLineHeight, rotatedLabelsBottom, withNRows, type ChartPanelLayout } from "./chart/chartLayout";
import { ChartNRow, nLines, nRowSize, withNUnit } from "./chart/chartN";
import { fittedScale, limitedScale, typedLimits, type ChartScale, type ValueAxisOptions } from "./chart/valueAxis";
import { ChartPlotMarks } from "./chart/ChartPlotMarks";
import { ChartLegendKey } from "./chart/ChartLegend";
import { bracketRowHeight, ChartBrackets, comparisonPaired, comparisonSpace, panelTests, shownComparisons, withBracketRows, type ComparisonOptions, type PanelTests } from "./chart/chartComparisons";

interface ChartProps {
  /** A stacked bar, or a panel per population of one value per replicate unit: a boxplot, bars of the mean, or points with the mean. */
  plotType: "stacked" | "box" | "bar" | "dots";
  /** What a boxplot, bar or point gives each unit: its share of the parent, of the file's root population, or its events. */
  proportionValue?: ProportionsSettings["proportionValue"];
  /** The bars' and points' error bar over the units. */
  errorBar?: ProportionsSettings["errorBar"];
  /** A rank test between the groups in each panel of a boxplot, bars or points. */
  test?: boolean;
  /** Write each group's replicate units under its label, and what they are on the value axis's title. */
  showN?: boolean;
  /** The replicate unit factor, which names what n counts. */
  unitSel?: string;
  model: {
    catLevels: string[];
    perSample: SampleComposition[];
    hasFacet: boolean;
    levels?: { popId: string; depth: number }[];
  };
  catColors: string[];
  palette: PaletteName;
  /** Every group of the chart, over all the files it was made with, before an iteration or a panel narrows them: each group takes the colour of its place here. */
  groupLevels?: readonly string[];
  /** Every facet of the chart, in the order its panels are drawn. */
  facetLevels?: readonly string[];
  averagePerUnit: boolean;
  populations: PopulationMap;
  /** Text sizes; a panel's title takes `title`, else the axis size. */
  fonts: { tick: number; axis: number; legend: number; title?: number };
  /** How an axis of events writes its ticks; unset, as the Plotting tab does. */
  formatTick?: (value: number) => string;
  appearance?: {
    height: number;
    showGrid: boolean;
    showPoints: boolean;
    /** Join each replicate unit's points across the groups of a boxplot. */
    paired?: boolean;
    showLegend: boolean;
    pointRadius: number;
  };
  /** The card's element id, which the export composer finds it by; each chart on a page needs its own. */
  containerId?: string;
  /** The value axis's title, naming what a percentage is of. */
  valueTitle?: string;
  /** What the groups are, for the stacked bar's category axis and the boxplot's legend. */
  groupTitle?: string;
  /** What the facets are, before each panel's value. */
  facetTitle?: string;
  /** Where the panels sit and how wide each is; unset, they wrap five to a row at their natural width. */
  arrangement?: Pick<ProportionsSettings, "panelColumns" | "panelsPerRow" | "panelWidth"> & Partial<Pick<ProportionsSettings, "panelRows" | "pageBy">>;
  /** One panel of the chart, or its legend alone, as a Layout block of one panel draws it. */
  only?: LayoutProportionsPanel;
  /** With pages (`arrangement.pageBy`), the page drawn, by its value; unset, every panel. */
  page?: string;
  /** The legend as a key alone: its entries are not buttons and highlight nothing. A Layout block and a figure's chart panel draw it so. */
  staticLegend?: boolean;
  /** The value axis's limits (per cent, or events for counts), whether it starts at 0, and whether the panels share one; unset, as drawn by default. */
  axisOptions?: ValueAxisOptions;
  /** Pairwise comparisons drawn as brackets, and which; unset, the overall test alone. */
  comparisons?: Pick<ProportionsSettings, "comparisons" | "comparisonsShow">;
}

/** What the chart's percentages are of, for its value axis; for division, `parentName` is the population fitted in. */
export function proportionsValueTitle(
  categoryKind: "population" | "division",
  parentName: string | null,
  includeRest: boolean,
  /** A boxplot's, bars' or points' value other than the share of the parent. */
  value: ProportionsSettings["proportionValue"] = "parent",
): string {
  if (value === "total") return "% of total";
  if (value === "count") return "Events";
  if (categoryKind === "division") return parentName ? `% of ${parentName}` : "% of all events";
  if (!includeRest) return parentName ? `% of the populations shown in ${parentName}` : "% of the populations shown";
  return parentName ? `% of ${parentName}` : "% of all events";
}

/** The population a division chart counts within, for its value axis: one name, null for all events, or a phrase when files differ. */
export function divisionWithinName(within: (string | null)[] | undefined): string | null {
  if (!within || within.length === 0) return null;
  return within.length === 1 ? within[0] : "the population each file's division was fitted in";
}

/** A Group, Replicate unit or Facet picker's value as a title: the file, the sample id or the metadata column. */
export function proportionsFactorTitle(value: string): string | undefined {
  if (value === PROPORTIONS_NO_FACTOR) return undefined;
  if (value === PROPORTIONS_SAMPLE_FACTOR) return "File";
  if (value === SAMPLE_ID_FIELD) return "Sample ID";
  return value;
}

export type ProportionPanelLayout = ChartPanelLayout;

/** Size each panel from its actual x-axis content instead of squeezing every plot into 380px. */
export function proportionPanelLayout(
  plotType: "stacked" | "box",
  labels: string[],
  groupCount: number,
  tickFont: number,
  /** The panel's whole width when set (an Illustration panel's size); 0 fits it to its labels. */
  panelWidth = 0,
  /** A line above the plot for the rank test, at the tick font. */
  withTest = false,
  /** The width a slot needs for its line of n; 0 without it. */
  nWidth = 0,
): ProportionPanelLayout {
  const margin = { top: 22 + (withTest ? tickFont + 6 : 0), right: 20, bottom: 46, left: 60 };
  // A boxplot panel is one population with a box per group; a stacked bar, a bar per group.
  void groupCount;
  const slotWidth = Math.max(plotType === "box" ? 34 : 72, nWidth);
  const innerAt = (left: number) => fittedInnerWidth(panelWidth, { left, right: margin.right }, Math.max(plotType === "box" ? 90 : 280, labels.length * slotWidth));
  let innerWidth = innerAt(margin.left);
  const step = labels.length ? innerWidth / labels.length : innerWidth;
  const longestLabelPx = longestLabelWidth(labels, tickFont);
  const rotateLabels = labelsRotate(longestLabelPx, step, 70);
  if (rotateLabels) {
    margin.bottom = rotatedLabelsBottom(longestLabelPx, 68);
    // The first labels, turned, reach left past the plot; the margin makes room for them (drawn shortened to 30 characters).
    margin.left = leftForTurnedLabels(margin.left, labelWidths(labels, tickFont, 30), innerAt);
    innerWidth = innerAt(margin.left);
  }
  return {
    width: margin.left + innerWidth + margin.right,
    height: margin.top + 240 + margin.bottom,
    margin,
    rotateLabels,
  };
}

const FULL_AXIS = { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };

/**
 * The rank tests of a boxplot's, bars' or points' panels, by panel key (`p<facet>-<category>`):
 * each panel's groups compared on their replicate units' values, as the chart draws them.
 */
export function proportionPanelTests(
  model: { catLevels: readonly string[]; perSample: SampleComposition[]; hasFacet: boolean },
  facets: readonly (string | null)[],
  groups: readonly string[],
  proportionValue: ProportionsSettings["proportionValue"],
  options: ComparisonOptions,
): Map<string, PanelTests> {
  const out = new Map<string, PanelTests>();
  const nCat = model.catLevels.length;
  facets.forEach((facet, i) => {
    const sub = model.hasFacet ? model.perSample.filter((s) => (s.facet ?? "") === facet) : model.perSample;
    const boxes = computeBoxes(perUnitProps(sub, nCat, proportionValue), nCat, false);
    for (let ci = 0; ci < nCat; ci++) {
      const slots = groups.map((group) => {
        const box = boxes.find((candidate) => candidate.cat === ci && candidate.group === group);
        return { label: group, values: box ? box.values.map((value, vi) => ({ unit: box.units[vi], value })) : [] };
      });
      out.set(`p${i}-${ci}`, panelTests(slots, options));
    }
  });
  return out;
}

/** A value axis from 0 to a round number just above `highest` (a fraction), with three to five ticks. */
export function fittedValueAxis(highest: number): { max: number; ticks: number[] } {
  if (!(highest > 0)) return FULL_AXIS;
  const target = Math.min(1, highest * 1.05);
  const raw = target / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((candidate) => candidate >= raw)!;
  const max = Math.min(1, Math.ceil(target / step - 1e-9) * step);
  const ticks: number[] = [];
  for (let i = 0; i * step <= max + step * 1e-6; i++) ticks.push(Number((i * step).toPrecision(12)));
  return { max, ticks };
}

export function ProportionsChart({
  plotType,
  proportionValue = "parent",
  errorBar = "sd",
  test = false,
  showN = false,
  unitSel,
  model,
  catColors,
  averagePerUnit,
  palette,
  groupLevels,
  facetLevels,
  populations,
  fonts,
  formatTick = formatMeasured,
  appearance,
  containerId = "gl-prop-svg",
  valueTitle,
  groupTitle,
  facetTitle,
  arrangement,
  only,
  page,
  staticLegend = false,
  axisOptions,
  comparisons,
}: ChartProps) {
  const { catLevels, perSample, hasFacet, levels } = model;
  const { t } = useI18n();
  const [hoveredLegend, setHoveredLegend] = useState<number | null>(null);
  const [pinnedLegend, setPinnedLegend] = useState<number | null>(null);
  const highlightedLegend = hoveredLegend ?? pinnedLegend;
  const nCat = catLevels.length;
  // A boxplot, bars or points: one value per replicate unit, in a panel per population.
  const perUnit = plotType !== "stacked";
  const counts = perUnit && proportionValue === "count";
  const withTest = perUnit && test;
  const facets = hasFacet
    ? columnValueOrder(perSample.map((s) => s.facet ?? ""), facetLevels)
    : [null];

  // Legend entities: categories for stacked, groups for box.
  const groups = columnValueOrder(perSample.map((s) => s.group), groupLevels);
  const groupColors = plottingGroupColours(palette, groups, groupLevels);
  // Each panel's tests, worked out once: the panels share one layout, so the room above the plots
  // is the most any panel needs.
  const comparisonOptions: ComparisonOptions = {
    comparisons: comparisons?.comparisons ?? "overall",
    comparisonsShow: comparisons?.comparisonsShow ?? "all",
    paired: comparisonPaired({ valueKind: "proportion", plotType, paired: !!appearance?.paired, unitSel: unitSel ?? PROPORTIONS_SAMPLE_FACTOR }),
  };
  const panelTestsByKey = useMemo(
    () => (withTest ? proportionPanelTests(model, facets, groups, proportionValue, comparisonOptions) : new Map<string, PanelTests>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [withTest, model, facets.join("\0"), groups.join("\0"), proportionValue, comparisonOptions.comparisons, comparisonOptions.paired],
  );
  const testSpace = comparisonSpace(panelTestsByKey.values(), comparisonOptions);
  // `index` is the category or group a legend entry stands for, which the marks' highlight reads.
  // A stacked bar's legend reads as its stack does, top to bottom: the stack draws the first
  // category at the bottom and nests each population's daughters above its own events, so the
  // stack from the top is the categories in reverse tree order, the rest of the parent first.
  const legend =
    plotType === "stacked"
      ? catLevels.map((l, i) => ({ index: i, label: l, color: catColors[i] })).reverse()
      : groups.map((g, i) => ({ index: i, label: g, color: groupColors[i] }));
  const pinnedEntry = pinnedLegend === null ? undefined : legend.find((entry) => entry.index === pinnedLegend);

  // Keep large category sets compact: at most ten rows, up to four columns. The chart card
  // expands horizontally rather than becoming a mostly-empty page-height legend column.
  const legendColumns = Math.min(4, Math.max(1, Math.ceil(legend.length / 10)));
  const markOpacity = (legendIndex: number) =>
    highlightedLegend === null || highlightedLegend === legendIndex ? 1 : 0.16;
  // A highlight dims every other mark, and a pinned one stays until it is cleared, which read as
  // the chart stuck faint: the pin says so under the legend, a click on the chart or Escape
  // clears it, and a highlight is dropped when the legend it was made on changes.
  const clearHighlight = () => {
    setHoveredLegend(null);
    setPinnedLegend(null);
  };
  useEffect(() => {
    setHoveredLegend(null);
    setPinnedLegend(null);
  }, [plotType, legend.length]);

  // A boxplot draws one panel per category, each with a value axis of its own, fitted to the
  // category's highest unit across every facet, so a population at 0.5% fills its panel. Bars and
  // points fit their error bars too; events are on an axis of their own numbers. Set, the panels
  // share one axis, the axis is fitted to the values rather than held to 0 (never for bars), and
  // typed limits, in per cent or events, replace its ends.
  const limits = useMemo(() => {
    const typed = typedLimits(axisOptions?.min, axisOptions?.max);
    return typed && !counts ? typed.map((v) => (v === null ? null : v / 100)) as [number | null, number | null] : typed;
  }, [axisOptions?.min, axisOptions?.max, counts]);
  const boxAxes = useMemo((): ChartScale[] => {
    if (!perUnit) return [];
    const units = perUnitProps(perSample, nCat, proportionValue);
    const boxes = computeBoxes(units, nCat, false);
    const fromZero = plotType === "bar" || axisOptions?.fromZero !== false;
    // Error bars over each facet's group, as the panels draw them; below the mean too on a fitted axis.
    const reach = (ci: number) => plotType === "box" ? [] : computeBoxes(units, nCat, model.hasFacet).filter((box) => box.cat === ci).map((box) => {
      const summary = summariseStatistic(box.values);
      const err = errorBar === "sem" ? summary.sem : summary.sd;
      return fromZero ? [summary.mean + err] : [summary.mean + err, summary.mean - err];
    }).flat();
    const scaleOf = (values: number[]): ChartScale => {
      if (!fromZero) return fittedScale(values, counts ? [0, Infinity] : [0, 1]);
      if (!counts) return { min: 0, ...fittedValueAxis(Math.max(0, ...values)) };
      const scale = axisTicks(values.length ? values : [0, 1]);
      return { min: 0, max: scale.max, ticks: scale.ticks };
    };
    const perCat = catLevels.map((_, ci) => [...boxes.filter((box) => box.cat === ci).flatMap((box) => box.values), ...reach(ci)]);
    const shared = axisOptions?.shared ? scaleOf(perCat.flat()) : null;
    return perCat.map((values) => limitedScale(shared ?? scaleOf(values), limits));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perUnit, plotType, perSample, nCat, catLevels, proportionValue, counts, errorBar, model.hasFacet, axisOptions?.fromZero, axisOptions?.shared, limits]);
  const stackedAxis = useMemo(() => limitedScale({ min: 0, ...FULL_AXIS }, limits), [limits]);

  // The panels, each a facet (and a population, for a boxplot), placed as the arrangement says:
  // wrapped, five to a row by default, or a column per value of one of their dimensions.
  const panelList = perUnit
    ? facets.flatMap((facet, i) => catLevels.map((_, cat) => ({ key: `p${i}-${cat}`, facet, cat })))
    : facets.map((facet, i) => ({ key: `p${i}`, facet, cat: undefined as number | undefined }));
  const panelDimensions = chartPanelDimensions({ valueKind: "proportion", plotType, xAxis: "groups" }, hasFacet);
  const panelValues = (panel: { facet: string | null; cat?: number }) => ({ facet: hasFacet ? panel.facet : null, group: null, population: panel.cat === undefined ? null : catLevels[panel.cat] ?? null, populationId: panel.cat === undefined ? null : levels?.[panel.cat]?.popId ?? null });
  const pageBy = chartPageDimension({ valueKind: "proportion", plotType, xAxis: "groups", pageBy: arrangement?.pageBy }, hasFacet);
  const placed = placedOrOnly(
    arrangePanels(
      pagePanels(panelList, pageBy, page, panelValues),
      (panel, dimension) => (dimension === "facet" ? panel.facet ?? "" : levels?.[panel.cat ?? 0]?.popId ?? catLevels[panel.cat ?? 0] ?? ""),
      panelDimensions,
      arrangement?.panelColumns ?? "",
      arrangement?.panelsPerRow ?? 5,
      arrangement?.panelRows ?? "",
      (panel, dimension) => panelDimensionText(panelValues(panel), dimension, { facet: facetTitle }),
    ),
    panelList,
    only,
    panelValues,
  );

  // Each panel's n under each group: the replicate units of a boxplot, bars or points, and the
  // units a stacked bar averages where it holds more than one file.
  const panelN = (facet: string | null, cat?: number): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    if (!showN) return out;
    const sub = hasFacet ? perSample.filter((s) => (s.facet ?? "") === facet) : perSample;
    if (perUnit) {
      for (const box of computeBoxes(perUnitProps(sub, nCat, proportionValue), nCat, false))
        if (box.cat === cat && box.values.length) out.set(box.group, nLines(box.values.length));
    } else if (averagePerUnit) {
      const units = perUnitProps(sub, nCat);
      for (const group of groups) {
        const n = units.filter((unit) => unit.group === group).length;
        if (n && sub.filter((s) => s.group === group).length > 1) out.set(group, nLines(n));
      }
    }
    return out;
  };
  const nSize = nRowSize(showN ? panelList.flatMap((panel) => [...panelN(panel.facet, panel.cat).values()]) : [], fonts.tick);

  const renderPanel = (facet: string | null, key: string, boxCat?: number) => {
    const sub = hasFacet
      ? perSample.filter((s) => (s.facet ?? "") === facet)
      : perSample;
    const stackedBars =
      plotType === "stacked"
        ? computeStackedBars(sub, nCat, {
            averagePerUnit,
            hasUnit: true,
            hasFacet: false,
          }).sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group))
        : null;
    const xLabels = stackedBars
      ? stackedBars.map((bar) => bar.group)
      : groups;
    const layout = withNRows(
      withBracketRows(proportionPanelLayout(perUnit ? "box" : "stacked", xLabels, groups.length, fonts.tick, arrangement?.panelWidth ?? 0, withTest && testSpace.testLine, nSize.width), fonts.tick, testSpace.brackets),
      fonts.tick,
      nSize.rows,
    );
    const M = layout.margin;
    const iw = layout.width - M.left - M.right,
      ih = appearance?.height ?? 240;
    const plotBottom = M.top + ih;
    // The stacked bar's category axis is the groups, titled under its labels: below the
    // margin rotated labels take, else just under the labels' one line.
    const xTitleY = stackedBars && groupTitle
      ? layout.rotateLabels
        ? plotBottom + M.bottom + fonts.axis
        : plotBottom + 18 + fonts.tick + fonts.axis + nSize.rows * nLineHeight(fonts.tick)
      : null;
    const PW = layout.width,
      PH = Math.max(plotBottom + M.bottom, xTitleY === null ? 0 : xTitleY + 6);
    const axis = boxCat === undefined ? stackedAxis : boxAxes[boxCat] ?? stackedAxis;
    const y = (v: number) => M.top + ih * (1 - (v - axis.min) / (axis.max - axis.min)); // v in [0,1]
    let body: JSX.Element[] = [];
    // The test is written above the plot, outside the clip a limited axis puts on the marks.
    let testMark: JSX.Element | null = null;
    let xTicks: { x: number; label: string }[] = [];

    if (stackedBars) {
      const bars = stackedBars;
      // What each bar stands on: its replicate units when averaged, else its events.
      const units = averagePerUnit ? perUnitProps(sub, nCat) : [];
      const basis = (group: string, total: number) => {
        if (!averagePerUnit) return `${Math.round(total).toLocaleString("en-US")} events`;
        const n = units.filter((unit) => unit.group === group).length;
        return n === 1 ? "1 replicate unit" : `mean of ${n} replicate units`;
      };
      const bw = bars.length ? Math.min(64, (iw / bars.length) * 0.7) : 0;
      const step = bars.length ? iw / bars.length : 0;
      bars.forEach((bar, bi) => {
        const cx = M.left + step * (bi + 0.5);
        xTicks.push({ x: cx, label: bar.group });
        if (levels && levels.length) {
          // NESTED: each population's subtree, its selected children stacked inside it (inset by
          // depth so daughters read as within their parent). `nestedBarLayout` ignores any trailing
          // "ungated" segment; draw that as a flat cap on top.
          const nodes = nestedBarLayout(levels, bar.segments, populations);
          const INSET = 5;
          nodes.forEach((node) => {
            if (node.y1 - node.y0 <= 1e-9) return;
            const inset = Math.min(node.depth * INSET, bw * 0.45);
            const x = cx - bw / 2 + inset;
            const yTop = y(node.y1),
              yBot = y(node.y0);
            body.push(
              <rect
                className="gl-prop-mark"
                key={`${bi}-${node.popId}`}
                x={x}
                y={yTop}
                width={Math.max(1, bw - inset)}
                height={Math.max(0, yBot - yTop)}
                fill={catColors[node.cat]}
                stroke="#fff"
                strokeWidth={0.4}
                opacity={markOpacity(node.cat)}
              >
                <title>{`${catLevels[node.cat]}: ${((node.y1 - node.y0) * 100).toFixed(1)}% (${basis(bar.group, bar.total)})`}</title>
              </rect>,
            );
          });
          const nestedTotal = bar.segments
            .slice(0, levels.length)
            .reduce((a, s) => a + s.value, 0);
          const ungated = bar.segments[levels.length]?.value ?? 0; // present only when "include ungated"
          if (ungated > 1e-9) {
            const yTop = y(nestedTotal + ungated),
              yBot = y(nestedTotal);
            body.push(
              <rect
                className="gl-prop-mark"
                key={`${bi}-ungated`}
                x={cx - bw / 2}
                y={yTop}
                width={bw}
                height={Math.max(0, yBot - yTop)}
                fill={catColors[levels.length]}
                stroke="#fff"
                strokeWidth={0.4}
                opacity={markOpacity(levels.length)}
              >
                <title>{`${catLevels[levels.length]}: ${(ungated * 100).toFixed(1)}%`}</title>
              </rect>,
            );
          }
          return;
        }
        let acc = 0;
        bar.segments.forEach((seg) => {
          if (seg.value <= 0) return;
          const y0 = y(acc),
            y1 = y(acc + seg.value);
          body.push(
            <rect
              className="gl-prop-mark"
              key={`${bi}-${seg.cat}`}
              x={cx - bw / 2}
              y={y1}
              width={bw}
              height={Math.max(0, y0 - y1)}
              fill={catColors[seg.cat]}
              stroke="#444"
              strokeWidth={0.2}
              opacity={markOpacity(seg.cat)}
            >
              <title>{`${catLevels[seg.cat]}: ${(seg.value * 100).toFixed(1)}% (${basis(bar.group, bar.total)})`}</title>
            </rect>,
          );
          acc += seg.value;
        });
      });
    } else {
      const ci = boxCat ?? 0;
      const boxes = computeBoxes(perUnitProps(sub, nCat, proportionValue), nCat, false).filter((box) => box.cat === ci);
      // A value as the tooltips give it: a percentage, or events.
      const shown = (v: number) => (counts ? `${formatMeasured(v)} events` : `${(v * 100).toFixed(1)}%`);
      const clamped = (v: number) => y(axis.clip ? v : Math.max(axis.min, Math.min(axis.max, v)));
      const step = groups.length ? iw / groups.length : iw;
      if (withTest) {
        const tests = panelTestsByKey.get(key);
        const result = tests?.overall;
        if (result) {
          testMark = (
            <text key={`test-${ci}`} className="gl-prop-test" x={M.left + iw / 2} y={M.top - 6 - testSpace.brackets * bracketRowHeight(fonts.tick)} textAnchor="middle" fontSize={fonts.tick} fill="#334155">
              <title>{`${result.name}, statistic ${result.statistic.toFixed(3)}, on one value per replicate unit${result.pairs !== undefined ? `, ${result.pairs} ${result.pairs === 1 ? "pair" : "pairs"}` : ""}`}</title>
              {result.label}
            </text>
          );
        }
        const drawnPairs = tests ? shownComparisons(tests.pairs, comparisonOptions.comparisonsShow) : [];
        if (drawnPairs.length)
          testMark = (
            <g key={`tests-${ci}`}>
              {testMark}
              <ChartBrackets pairs={drawnPairs} x={(slot) => M.left + step * (slot + 0.5)} plotTop={M.top} fontSize={fonts.tick} on="one value per replicate unit" />
            </g>
          );
      }
      const bw = Math.min(18, step * 0.6);
      const showPoints = appearance?.showPoints !== false;
      // A point's place in its box, spread over up to five columns so close values stay visible.
      const pointX = (cx: number, count: number, vi: number) =>
        showPoints ? cx + ((vi % Math.min(5, count)) - (Math.min(5, count) - 1) / 2) * 2.1 : cx;
      // Where each unit is drawn in each group, in group order, for the paired lines.
      const unitPath = new Map<string, { x: number; y: number }[]>();
      groups.forEach((group, gi) => {
        const cx = M.left + step * (gi + 0.5);
        xTicks.push({ x: cx, label: group });
        const box = boxes.find((candidate) => candidate.group === group);
        if (!box) return;
        const col = groupColors[gi] ?? "#888";
        const { q1, med, q3, lo, hi } = box.stats;
        box.units.forEach((unit, vi) => {
          const at = { x: pointX(cx, box.values.length, vi), y: y(box.values[vi]) };
          unitPath.set(unit, [...(unitPath.get(unit) ?? []), at]);
        });
        if (plotType !== "box") {
          // Bars of the mean, or points with the mean, each with its error bar over the units.
          const summary = summariseStatistic(box.values);
          const err = errorBar === "sem" ? summary.sem : summary.sd;
          const half = Math.min(step * 0.36, 16);
          const tip = `${catLevels[ci]} · ${box.group}: mean ${shown(summary.mean)} ± ${errorBar === "sem" ? "SEM" : "SD"} ${shown(err)}, n = ${box.values.length}`;
          body.push(
            <g key={`b-${ci}-${box.group}`} className="gl-prop-mark-group" opacity={markOpacity(gi)}>
              {plotType === "bar" ? (
                <rect className="gl-prop-mark" x={cx - half} y={Math.min(clamped(0), clamped(summary.mean))} width={half * 2} height={Math.max(0.5, Math.abs(clamped(0) - clamped(summary.mean)))} fill={col} fillOpacity={showPoints ? 0.45 : 0.85} stroke="#333" strokeWidth={0.5}>
                  <title>{tip}</title>
                </rect>
              ) : (
                <line className="gl-prop-mark" x1={cx - half} x2={cx + half} y1={clamped(summary.mean)} y2={clamped(summary.mean)} stroke="#111" strokeWidth={1.6}>
                  <title>{tip}</title>
                </line>
              )}
              {summary.n > 1 && (
                <g stroke="#111" strokeWidth={0.9}>
                  <line x1={cx} x2={cx} y1={clamped(summary.mean + err)} y2={clamped(summary.mean - err)} />
                  <line x1={cx - half / 2} x2={cx + half / 2} y1={clamped(summary.mean + err)} y2={clamped(summary.mean + err)} />
                  <line x1={cx - half / 2} x2={cx + half / 2} y1={clamped(summary.mean - err)} y2={clamped(summary.mean - err)} />
                </g>
              )}
              {(showPoints || plotType === "dots") &&
                box.values.map((v, vi) => (
                  <circle key={vi} className="gl-prop-point" cx={cx + ((vi % Math.min(5, box.values.length)) - (Math.min(5, box.values.length) - 1) / 2) * 2.1} cy={clamped(v)} r={(appearance?.pointRadius ?? 1.5) + 0.5} fill={col} stroke="#1f2937" strokeWidth={0.6}>
                    <title>{`${box.units[vi]}: ${shown(v)}`}</title>
                  </circle>
                ))}
            </g>,
          );
          return;
        }
        body.push(
          <g
            key={`b-${ci}-${box.group}`}
            className="gl-prop-mark-group"
            opacity={markOpacity(gi)}
          >
            <line
              x1={cx}
              x2={cx}
              y1={y(hi)}
              y2={y(lo)}
              stroke="#555"
              strokeWidth={0.8}
            />
            <rect
              className="gl-prop-mark"
              x={cx - bw / 2}
              y={y(q3)}
              width={bw}
              height={Math.max(0.5, y(q1) - y(q3))}
              fill={col}
              fillOpacity={0.85}
              stroke="#333"
              strokeWidth={0.5}
            >
              <title>{`${catLevels[ci]} · ${box.group}: median ${shown(med)}, n = ${box.values.length}`}</title>
            </rect>
            <line
              x1={cx - bw / 2}
              x2={cx + bw / 2}
              y1={y(med)}
              y2={y(med)}
              stroke="#111"
              strokeWidth={1}
            />
            {showPoints &&
              box.values.map((v, vi) => (
                <circle
                  key={vi}
                  cx={pointX(cx, box.values.length, vi)}
                  cy={y(v)}
                  r={appearance?.pointRadius ?? 1.5}
                  fill="#222"
                  fillOpacity={0.65}
                />
              ))}
          </g>,
        );
      });
      if (appearance?.paired && plotType === "box") {
        body.push(
          <g key={`paired-${ci}`} className="gl-prop-paired" fill="none" stroke="#666" strokeWidth={0.6} strokeOpacity={0.7}>
            {[...unitPath].filter(([, path]) => path.length > 1).map(([unit, path]) => (
              <polyline key={unit} points={path.map((p) => `${p.x},${p.y}`).join(" ")}>
                <title>{unit}</title>
              </polyline>
            ))}
          </g>,
        );
      }
    }

    return (
      <svg
        key={key}
        width={PW}
        height={PH}
        viewBox={`0 0 ${PW} ${PH}`}
        className="gl-prop-panel"
      >
        {(hasFacet || boxCat !== undefined) && (
          <text
            x={PW / 2}
            y={14}
            textAnchor="middle"
            fontSize={fonts.title ?? fonts.axis}
            fontWeight={600}
            fill="#334155"
          >
            {placed.headings
              ? headedPanelTitle(panelValues({ facet, cat: boxCat }), panelDimensions, placed.headings, { facet: facetTitle })
              : [
                  boxCat !== undefined ? catLevels[boxCat] : null,
                  hasFacet ? (facetTitle ? `${facetTitle}: ${facet || "(NA)"}` : facet || "(NA)") : null,
                ].filter(Boolean).join(" · ")}
          </text>
        )}
        {/* y grid + axis (percent) */}
        {axis.ticks.map((t) => (
          <g key={t}>
            {appearance?.showGrid !== false && (
              <line
                x1={M.left}
                x2={M.left + iw}
                y1={y(t)}
                y2={y(t)}
                stroke="#eee"
              />
            )}
            <text
              x={M.left - 6}
              y={y(t) + 3}
              textAnchor="end"
              fontSize={fonts.tick}
              fill="#666"
            >
              {counts ? formatTick(t) : formatPercentTick(t, axis.ticks)}
            </text>
          </g>
        ))}
        <line
          x1={M.left}
          x2={M.left}
          y1={M.top}
          y2={plotBottom}
          stroke="#94a3b8"
        />
        <line
          x1={M.left}
          x2={M.left + iw}
          y1={plotBottom}
          y2={plotBottom}
          stroke="#94a3b8"
        />
        <text
          x={16}
          y={M.top + ih / 2}
          textAnchor="middle"
          fontSize={fonts.axis}
          fill="#475569"
          transform={`rotate(-90 16 ${M.top + ih / 2})`}
        >
          {nSize.rows > 0
            ? withNUnit(valueTitle ?? (plotType === "stacked" ? "Composition (%)" : "Events (%)"), unitSel)
            : valueTitle ?? (plotType === "stacked" ? "Composition (%)" : "Events (%)")}
        </text>
        {testMark}
        <ChartPlotMarks clipId={`${containerId}-clip-${key}`} clip={!!axis.clip} left={M.left} top={M.top} width={iw} height={ih}>
          {body}
        </ChartPlotMarks>
        {xTitleY !== null && (
          <text
            x={M.left + iw / 2}
            y={xTitleY}
            textAnchor="middle"
            fontSize={fonts.axis}
            fill="#475569"
          >
            {groupTitle}
          </text>
        )}
        {xTicks.map((t, i) => (
          <text
            key={i}
            x={t.x}
            y={plotBottom + 18}
            textAnchor={layout.rotateLabels ? "end" : "middle"}
            fontSize={fonts.tick}
            fill="#334155"
            transform={
              layout.rotateLabels
                ? `rotate(-35 ${t.x} ${plotBottom + 18})`
                : undefined
            }
          >
            <title>{t.label}</title>
            {compactChartLabel(t.label)}
          </text>
        ))}
        {nSize.rows > 0 && <ChartNRow ticks={xTicks.map((tick) => ({ x: tick.x, lines: panelN(facet, boxCat).get(tick.label) ?? [] }))} baseline={plotBottom + layout.nBaseline} tickFont={fonts.tick} />}
      </svg>
    );
  };

  // A grid with headings is of a boxplot's panels, each as wide and tall as the others.
  const headed = placed.headings ? withNRows(proportionPanelLayout("box", groups, groups.length, fonts.tick, arrangement?.panelWidth ?? 0, withTest, nSize.width), fonts.tick, nSize.rows) : null;
  const grid = chartGridCells(placed, (panel) => renderPanel(panel.facet, panel.key, panel.cat), {
    font: fonts.title ?? fonts.axis,
    panelWidth: headed?.width ?? 0,
    panelHeight: headed ? headed.margin.top + (appearance?.height ?? 240) + headed.margin.bottom : 0,
  });

  return (
    <div
      id={containerId}
      className="gl-prop-chart"
      style={only ? undefined : { minWidth: Math.max(360, legendColumns * 145) }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && (hoveredLegend !== null || pinnedLegend !== null)) {
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
      {pinnedEntry && (
        <p className="gl-prop-highlight-note" role="status">
          {t("Highlighting {label}; the rest is faded. Click it again, the chart or Show all to clear.", { label: pinnedEntry.label })}
          <button type="button" className="gl-mini-btn" onClick={clearHighlight}>{t("Show all")}</button>
        </p>
      )}
      <div
        className="gl-prop-legend"
        onPointerLeave={staticLegend ? undefined : () => setHoveredLegend(null)}
        hidden={appearance?.showLegend === false || (!!only && !("legend" in only))}
        aria-label={plotType === "stacked" ? "Categories" : "Groups"}
        style={{
          fontSize: fonts.legend,
          gridTemplateColumns: `repeat(${legendColumns}, minmax(0, 1fr))`,
        }}
      >
        {perUnit && groupTitle && <span className="gl-prop-legend-title">{groupTitle}</span>}
        {legend.map(({ index: i, ...l }) => staticLegend ? <ChartLegendKey key={i} label={l.label} color={l.color} /> : (
          <button
            type="button"
            key={i}
            className={
              "gl-prop-legend-item" +
              (highlightedLegend === i ? " highlighted" : "")
            }
            title={t("{label} — hover to highlight; click to keep it highlighted, click again to clear", { label: l.label })}
            aria-pressed={pinnedLegend === i}
            onMouseEnter={() => setHoveredLegend(i)}
            onMouseLeave={() => setHoveredLegend(null)}
            onFocus={() => setHoveredLegend(i)}
            onBlur={() => setHoveredLegend(null)}
            onClick={() =>
              setPinnedLegend((current) => (current === i ? null : i))
            }
          >
            <span className="gl-prop-swatch" style={{ background: l.color }} />
            <span className="gl-prop-legend-label">{l.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const SVG_NS = "http://www.w3.org/2000/svg";

interface ProportionsExport {
  root: SVGSVGElement;
  width: number;
  height: number;
}

function svgDimension(svg: SVGSVGElement, name: "width" | "height"): number {
  const direct = Number.parseFloat(svg.getAttribute(name) ?? "");
  if (Number.isFinite(direct) && direct > 0) return direct;
  const viewBox = svg.viewBox.baseVal;
  return name === "width" ? viewBox.width : viewBox.height;
}

/**
 * Compose the complete Proportions card as one self-contained SVG. The on-screen legend is
 * deliberately HTML so it can provide linked hover/click behaviour; exports must redraw it as
 * SVG alongside every facet panel rather than serializing only the first chart SVG.
 */
export function composeProportionsChartSvg(
  chart: string | HTMLElement,
): ProportionsExport | null {
  const container = typeof chart === "string" ? document.getElementById(chart) : chart;
  if (!container) return null;
  const panels = [
    ...container.querySelectorAll<SVGSVGElement>("svg.gl-prop-panel, svg.gl-prop-heading"),
  ];
  if (!panels.length) return null;

  const containerRect = container.getBoundingClientRect();
  const hasLiveLayout = containerRect.width > 0 && containerRect.height > 0;
  // Under a CSS zoom (a Layout block fits its chart to its frame) client rects are zoomed and the
  // panels' own sizes are not, so every measure is taken back to the chart's own scale.
  const k = hasLiveLayout ? container.offsetWidth / containerRect.width : 1;
  const padding = 10;
  const panelGap = 12;
  const fallbackPanelSizes = panels.map((panel) => ({
    width: svgDimension(panel, "width"),
    height: svgDimension(panel, "height"),
  }));
  const fallbackPanelsWidth =
    fallbackPanelSizes.reduce((sum, size) => sum + size.width, 0) +
    Math.max(0, panels.length - 1) * panelGap;
  const fallbackPanelsHeight = Math.max(
    ...fallbackPanelSizes.map((size) => size.height),
  );

  const legend = container.querySelector<HTMLElement>(".gl-prop-legend");
  const legendItems =
    legend && !legend.hidden
      ? [...legend.querySelectorAll<HTMLElement>(".gl-prop-legend-item")]
      : [];
  const legendColumns = Math.min(
    4,
    Math.max(1, Math.ceil(legendItems.length / 10)),
  );
  const legendFontSize = Number.parseFloat(legend?.style.fontSize ?? "") || 11;
  const legendRowHeight = Math.max(18, legendFontSize + 7);
  const legendRows = Math.max(1, Math.ceil(legendItems.length / legendColumns));
  const fallbackInnerWidth = Math.max(
    360,
    fallbackPanelsWidth,
    legendColumns * 145,
  );
  const fallbackLegendTop = padding + fallbackPanelsHeight + 10;
  const fallbackWidth = fallbackInnerWidth + padding * 2;
  const legendTitleRows = legendItems.length && legend?.querySelector(".gl-prop-legend-title") ? 1 : 0;
  const fallbackHeight =
    fallbackLegendTop + 10 + (legendRows + legendTitleRows) * legendRowHeight + padding;
  const width = Math.max(
    1,
    Math.ceil(hasLiveLayout ? containerRect.width * k : fallbackWidth),
  );
  const height = Math.max(
    1,
    Math.ceil(hasLiveLayout ? containerRect.height * k : fallbackHeight),
  );

  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("xmlns", SVG_NS);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", "Proportions chart with legend");

  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("width", "100%");
  background.setAttribute("height", "100%");
  background.setAttribute("fill", "#ffffff");
  root.appendChild(background);

  let fallbackX = padding;
  panels.forEach((panel, index) => {
    const rect = panel.getBoundingClientRect();
    const useRect = hasLiveLayout && rect.width > 0 && rect.height > 0;
    const x = useRect ? (rect.left - containerRect.left) * k : fallbackX;
    const y = useRect ? (rect.top - containerRect.top) * k : padding;
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute(
      "transform",
      `translate(${Math.round(x)},${Math.round(y)})`,
    );
    const clone = panel.cloneNode(true) as SVGSVGElement;
    // A legend highlight is a way of looking at the chart, not part of it.
    clone.querySelectorAll(".gl-prop-mark, .gl-prop-mark-group").forEach((mark) => mark.removeAttribute("opacity"));
    clone.setAttribute("x", "0");
    clone.setAttribute("y", "0");
    group.appendChild(clone);
    root.appendChild(group);
    fallbackX += fallbackPanelSizes[index].width + panelGap;
  });

  if (legend && legendItems.length) {
    const legendRect = legend.getBoundingClientRect();
    const useLegendRect =
      hasLiveLayout && legendRect.width > 0 && legendRect.height > 0;
    const legendX = useLegendRect
      ? (legendRect.left - containerRect.left) * k
      : padding;
    const legendTop = useLegendRect
      ? (legendRect.top - containerRect.top) * k
      : fallbackLegendTop;
    const legendWidth = useLegendRect ? legendRect.width * k : width - padding * 2;

    const divider = document.createElementNS(SVG_NS, "line");
    divider.setAttribute("x1", String(Math.round(legendX)));
    divider.setAttribute("x2", String(Math.round(legendX + legendWidth)));
    divider.setAttribute("y1", String(Math.round(legendTop)));
    divider.setAttribute("y2", String(Math.round(legendTop)));
    divider.setAttribute("stroke", "#e2e8f0");
    divider.setAttribute("stroke-width", "1");
    root.appendChild(divider);

    const title = legend.querySelector<HTMLElement>(".gl-prop-legend-title");
    const titleRect = title?.getBoundingClientRect();
    const titleRow = title ? legendRowHeight : 0;
    if (title) {
      const useTitleRect = useLegendRect && !!titleRect && titleRect.height > 0;
      const exportTitle = document.createElementNS(SVG_NS, "text");
      exportTitle.setAttribute("x", String(Math.round(useTitleRect ? (titleRect!.left - containerRect.left) * k : legendX)));
      exportTitle.setAttribute("y", String(Math.round(useTitleRect ? (titleRect!.top - containerRect.top + titleRect!.height / 2) * k : legendTop + 10 + legendRowHeight / 2)));
      exportTitle.setAttribute("dy", "0.35em");
      exportTitle.setAttribute("font-size", String(legendFontSize));
      exportTitle.setAttribute("font-weight", "bold");
      exportTitle.setAttribute("fill", "#334155");
      exportTitle.textContent = title.textContent ?? "";
      root.appendChild(exportTitle);
    }
    const fallbackColumnWidth = legendWidth / legendColumns;
    legendItems.forEach((item, index) => {
      const itemRect = item.getBoundingClientRect();
      const useItemRect =
        useLegendRect && itemRect.width > 0 && itemRect.height > 0;
      const column = index % legendColumns;
      const row = Math.floor(index / legendColumns);
      const itemX = useItemRect
        ? (itemRect.left - containerRect.left) * k
        : legendX + column * fallbackColumnWidth;
      const itemY = useItemRect
        ? (itemRect.top - containerRect.top) * k
        : legendTop + 10 + titleRow + row * legendRowHeight;
      const itemHeight = useItemRect ? itemRect.height * k : legendRowHeight;
      const swatch = item.querySelector<HTMLElement>(".gl-prop-swatch");
      const label =
        item
          .querySelector<HTMLElement>(".gl-prop-legend-label")
          ?.textContent?.trim() ?? "";
      const color =
        swatch?.style.backgroundColor || swatch?.style.background || "#94a3b8";

      const exportItem = document.createElementNS(SVG_NS, "g");
      exportItem.setAttribute("class", "gl-prop-export-legend-item");
      const exportSwatch = document.createElementNS(SVG_NS, "rect");
      exportSwatch.setAttribute("x", String(Math.round(itemX)));
      exportSwatch.setAttribute(
        "y",
        String(Math.round(itemY + (itemHeight - 12) / 2)),
      );
      exportSwatch.setAttribute("width", "12");
      exportSwatch.setAttribute("height", "12");
      exportSwatch.setAttribute("rx", "2");
      exportSwatch.setAttribute("fill", color);
      exportSwatch.setAttribute("stroke", "rgba(0,0,0,0.2)");
      exportItem.appendChild(exportSwatch);

      const exportLabel = document.createElementNS(SVG_NS, "text");
      exportLabel.setAttribute("x", String(Math.round(itemX + 18)));
      exportLabel.setAttribute("y", String(Math.round(itemY + itemHeight / 2)));
      // Illustrator ignores dominant-baseline; a shift of a third of an em centres the label the same way.
      exportLabel.setAttribute("dy", "0.35em");
      exportLabel.setAttribute("font-size", String(legendFontSize));
      exportLabel.setAttribute("font-family", "Arial, Helvetica, sans-serif");
      exportLabel.setAttribute("fill", "#334155");
      exportLabel.textContent = label;
      exportItem.appendChild(exportLabel);
      root.appendChild(exportItem);
    });
  }

  return { root, width, height };
}
