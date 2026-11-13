// PlottingChartView.tsx — a Plotting chart drawn from its settings: the one mapping from a
// settings object and the models built for it to the props of the statistic, per-cell and
// proportion charts. A Layout block (LayoutProportionsSurface) and an Illustration figure's chart
// panel (FigureChartBody) both draw through it, so a setting takes effect the same way in each.

import { useMemo } from "react";
import type { LayoutProportionsPanel } from "../../engine/layout";
import type { PopulationMap } from "../../engine/models";
import type { ProportionsModel, ProportionsSettings } from "../../engine/proportionsModel";
import type { CellValuesModel } from "../../engine/cellValuesModel";
import { divisionWithinName, ProportionsChart, proportionsFactorTitle, proportionsValueTitle } from "../PlottingTab";
import { CellValuesChart, cellPlotType, type CellChannelPart } from "../CellValuesChart";
import { StatisticChart } from "../StatisticChart";
import { valueAxisOptions, type ChartAxisFrame } from "./valueAxis";
import { formatLinearTick } from "./chartFormat";

/** A per-cell chart's value-axis options: each panel fits its own only when the axis is fitted to the cells, not the Gating tab's. */
export function cellAxisOptions(settings: ProportionsSettings) {
  const options = valueAxisOptions(settings);
  return { ...options, shared: options.shared || settings.cellRange === "gating" };
}

/** A measured-value axis relabelled as the flow plots write a linear axis: the ticks whose label is the plain number at their place. */
export function withLinearTickLabels<A extends ChartAxisFrame>(axis: A): A {
  const plain = (tick: { at: number; label: string }) => Number(tick.label.replace(/,/g, "")) === tick.at;
  return axis.major.every(plain) ? { ...axis, major: axis.major.map((tick) => ({ ...tick, label: formatLinearTick(tick.at) })) } : axis;
}

/**
 * The chart the settings draw from the models: a statistic chart, a per-cell chart or a proportion
 * chart. `settings` are the drawn settings (a block laid out to its frame, its panel width and
 * height fitted); `formatTick` set, the value axes are labelled as the flow plots write a linear
 * axis. The caller says when there is nothing to draw; this draws what it is given.
 */
export function PlottingChartView({
  settings,
  model,
  cellModel,
  unitModel,
  channelParts,
  catColors,
  levelColors,
  populations,
  groupLevels,
  facetLevels,
  unitLevels,
  fonts,
  xAxisFrame,
  statisticAxis,
  groupTitle: groupTitleGiven,
  formatTick,
  containerId,
  only,
  page,
}: Readonly<{
  settings: ProportionsSettings;
  /** The proportion model; empty while the chart draws cells. */
  model: ProportionsModel;
  /** A per-cell or statistic chart's cells; null for a proportion chart. */
  cellModel: CellValuesModel | null;
  /** A per-cell chart's cells pooled by replicate unit, when it draws replicate marks. */
  unitModel: CellValuesModel | null;
  /** A chart of several channels: each channel's cells, axis and replicate marks (blockChannelParts). */
  channelParts?: CellChannelPart[];
  catColors: string[];
  /** A proportion chart's category colours; unset, `catColors`. */
  levelColors?: string[];
  populations: PopulationMap;
  groupLevels?: readonly string[];
  facetLevels?: readonly string[];
  unitLevels?: readonly string[];
  fonts: { tick: number; axis: number; legend: number; title?: number };
  /** A per-cell chart's value axis. */
  xAxisFrame?: ChartAxisFrame | null;
  /** A statistic chart's value axis made outside it, shared with other charts (StatisticChartProps.valueAxis). */
  statisticAxis?: ChartAxisFrame;
  /** What the groups are, in place of the settings' group factor's name; null, nothing. */
  groupTitle?: string | null;
  formatTick?: (value: number) => string;
  containerId: string;
  only?: LayoutProportionsPanel;
  page?: string;
}>) {
  const replicates = useMemo(
    () => (unitModel && settings.replicateMarks !== "none" ? { unitModel, statistic: settings.replicateMarks, unitSel: settings.unitSel, unitLevels, test: settings.test, comparisons: { comparisons: settings.comparisons, comparisonsShow: settings.comparisonsShow } } : undefined),
    [unitModel, settings.replicateMarks, settings.unitSel, unitLevels, settings.test, settings.comparisons, settings.comparisonsShow],
  );
  const groupTitle = groupTitleGiven === undefined ? proportionsFactorTitle(settings.groupSel) : groupTitleGiven ?? undefined;
  const drawnParts = useMemo(() => (formatTick ? channelParts?.map((part) => ({ ...part, axis: withLinearTickLabels(part.axis) })) : channelParts), [formatTick, channelParts]);
  if (cellModel && settings.valueKind === "statistic") {
    return (
      <StatisticChart
        containerId={containerId}
        model={cellModel}
        statistic={settings.statistic}
        plotType={settings.plotType === "bar" ? "bar" : settings.plotType === "dots" ? "dots" : "box"}
        errorBar={settings.errorBar}
        test={settings.test}
        comparisons={settings}
        showN={settings.showN}
        xAxis={settings.xAxis}
        unitSel={settings.unitSel}
        catColors={catColors}
        palette={settings.palette}
        colourByPopulation={settings.colourByPopulation}
        populationsTogether={settings.populationsTogether}
        groupLevels={groupLevels}
        facetLevels={facetLevels}
        unitLevels={unitLevels}
        groupTitle={groupTitle}
        facetTitle={proportionsFactorTitle(settings.facetSel)}
        fonts={fonts}
        formatTick={formatTick}
        appearance={{ height: settings.height, showGrid: settings.grid, showLegend: settings.legend, showPoints: settings.points, pointRadius: settings.pointRadius }}
        arrangement={settings}
        only={only}
        staticLegend
        page={page}
        axisSettings={settings}
        valueAxis={statisticAxis}
        channels={channelParts}
      />
    );
  }
  if (cellModel) {
    return (
      <CellValuesChart
        containerId={containerId}
        model={cellModel}
        plotType={cellPlotType(settings.plotType)}
        xAxis={settings.xAxis}
        violinBox={settings.violinBox}
        showN={settings.showN}
        axis={formatTick ? withLinearTickLabels(xAxisFrame!) : xAxisFrame!}
        replicates={replicates}
        catColors={catColors}
        palette={settings.palette}
        colourByPopulation={settings.colourByPopulation}
        populationsTogether={settings.populationsTogether}
        groupLevels={groupLevels}
        facetLevels={facetLevels}
        groupTitle={groupTitle}
        facetTitle={proportionsFactorTitle(settings.facetSel)}
        fonts={fonts}
        appearance={{ height: settings.height, showGrid: settings.grid, showLegend: settings.legend }}
        arrangement={settings}
        only={only}
        staticLegend
        page={page}
        axisOptions={cellAxisOptions(settings)}
        channels={drawnParts}
      />
    );
  }
  return (
    <ProportionsChart
      containerId={containerId}
      plotType={settings.plotType === "bar" ? "bar" : settings.plotType === "dots" ? "dots" : settings.plotType === "stacked" ? "stacked" : "box"}
      proportionValue={settings.proportionValue}
      errorBar={settings.errorBar}
      test={settings.test}
      comparisons={settings}
      showN={settings.showN}
      unitSel={settings.unitSel}
      model={model}
      catColors={levelColors ?? catColors}
      palette={settings.palette}
      groupLevels={groupLevels}
      facetLevels={facetLevels}
      averagePerUnit={settings.averagePerUnit}
      populations={populations}
      valueTitle={proportionsValueTitle(settings.categoryKind, settings.categoryKind === "division" ? divisionWithinName(model.divisionWithin) : populations[settings.parent]?.parent_id ? populations[settings.parent].name : null, settings.includeUngated, settings.plotType === "stacked" ? "parent" : settings.proportionValue)}
      groupTitle={groupTitle}
      facetTitle={proportionsFactorTitle(settings.facetSel)}
      fonts={fonts}
      formatTick={formatTick}
      appearance={{
        height: settings.height,
        showGrid: settings.grid,
        showPoints: settings.points,
        paired: settings.paired,
        showLegend: settings.legend,
        pointRadius: settings.pointRadius,
      }}
      arrangement={settings}
      only={only}
      staticLegend
      page={page}
      axisOptions={valueAxisOptions(settings)}
    />
  );
}
