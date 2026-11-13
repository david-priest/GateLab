// FigureChartPanel.tsx — a chart plot's panel in an Illustration figure: one panel of a Plotting
// chart, no legend and no title, drawn from its settings as a Layout block is (PlottingChartView)
// at the grid's panel size, in the figure's fonts.

import { useLayoutEffect, useMemo, useRef } from "react";
import type { FigureChart, FigurePanel, FigurePanelData } from "../engine/figure";
import type { IllustrationConfig } from "../engine/workspace";
import type { CellValuesModel } from "../engine/cellValuesModel";
import { PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "../engine/proportionsSettings";
import { cellChartAxis, cellChartLayout, cellPanelAxes, cellPanels, cellPlotType, cellReplicateFrame, cellSlotN } from "./CellValuesChart";
import { statisticAxisValues, statisticChartFrame, statisticGroups, statisticPanels, statisticPoints, statisticValueAxis } from "./StatisticChart";
import { proportionPanelLayout } from "./PlottingTab";
import type { FigureChartData } from "./figureChartData";
import { typedLimits, type ChartAxisFrame } from "./chart/valueAxis";
import { chartXAxis } from "./chart/chartXAxis";
import { cellAxisOptions, PlottingChartView } from "./chart/PlottingChartView";

/** A panel of one, no legend: what a Layout block of one panel draws. */
const ONE_PANEL = {};

/** The figure's fonts at this panel size, as the flow plots take them (styledFigurePlot). */
export function figureChartFonts(config: IllustrationConfig, size: number) {
  const scale = config.scaleFontsWithPlot ? size / 280 : 1;
  return { tick: config.fontTick * scale, axis: config.fontAxis * scale, legend: config.fontTick * scale };
}

/**
 * The publication style the flow plots take: black axes, ticks and text. The chart components draw
 * in the app's greys, so the drawn panel is restyled; the export calls this on its copy too.
 */
export function applyFigureChartStyle(root: ParentNode, config: Pick<IllustrationConfig, "pubStyle">): void {
  if (!config.pubStyle) return;
  for (const el of root.querySelectorAll("svg.gl-prop-panel line, svg.gl-prop-panel path, svg.gl-prop-panel rect")) {
    const stroke = el.getAttribute("stroke");
    if (stroke && !["#fff", "#ffffff", "#eee", "none", "white"].includes(stroke.toLowerCase())) el.setAttribute("stroke", "#000");
  }
  for (const el of root.querySelectorAll("svg.gl-prop-panel text")) el.setAttribute("fill", "#000");
}

/** A statistic chart's plot type, as the chart takes it from the settings. */
function statisticPlotType(settings: Pick<ProportionsSettings, "plotType">): "box" | "bar" | "dots" {
  return settings.plotType === "bar" ? "bar" : settings.plotType === "dots" ? "dots" : "box";
}

/**
 * Where a summary panel is drawn: its whole width and height over the cells it spans, and, when it
 * spans columns, the grid's column pitch, so its places sit under their columns' centres.
 */
export interface FigureSummaryFrame {
  width: number;
  height: number;
  /** Spanning columns: how many, and the distance between the centres of neighbouring columns. */
  columns?: { count: number; pitch: number };
}

/** A per-cell chart's value axis: the figure's shared range or fitted to the cells, within the settings' limits. */
function figureCellAxis(data: FigureChartData, cells: CellValuesModel): ChartAxisFrame | null {
  return cellChartAxis(cells, data.settings.cellRange, data.range, { min: data.settings.valueMin, max: data.settings.valueMax });
}

/**
 * A per-cell or statistic panel's layout at a panel width with no plot height: its margins and the
 * height they take, as the chart lays the panel out from the drawn settings.
 */
function cellsFrame(
  data: FigureChartData,
  model: CellValuesModel,
  fonts: ReturnType<typeof figureChartFonts>,
  panelWidth: number,
  valueAxis?: ChartAxisFrame,
): { height: number; margin: { left: number; right: number } } | null {
  const settings = data.settings;
  if (data.valueKind === "statistic")
    return statisticChartFrame(
      model,
      { ...settings, plotType: statisticPlotType(settings), panelWidth, height: 0, fontTick: fonts.tick, fontAxis: fonts.axis },
      data.groupTitle,
      undefined,
      { groups: data.groupLevels },
      data.summary ? valueAxis : undefined,
    ).layout;
  const axis = figureCellAxis(data, model);
  if (!axis) return null;
  const layoutAxis = chartXAxis(settings);
  const { panels, groups } = cellPanels(model, layoutAxis, layoutAxis === "populations" ? data.groupTitle : undefined, undefined, { groups: data.groupLevels });
  const replicates = data.unitModel && settings.replicateMarks !== "none"
    ? cellReplicateFrame(model, panels, groups, layoutAxis, { unitModel: data.unitModel, statistic: settings.replicateMarks, unitSel: settings.unitSel, test: settings.test, comparisons: settings })
    : null;
  const axes = cellPanelAxes(model, panels, axis, cellAxisOptions(settings)) ?? [axis];
  return cellChartLayout(
    cellPlotType(settings.plotType),
    panels[0]?.slots.map((slot) => slot.tick ?? slot.label) ?? [],
    axes.flatMap((own) => own.major.map((tick) => tick.label)),
    fonts,
    0,
    Math.max(0, ...panels.map((panel) => panel.title.length)),
    panelWidth,
    settings.showN ? panels.flatMap((panel) => panel.slots.map((_, si) => cellSlotN(panel, si, replicates))) : [],
    !!replicates?.withTest,
    !!replicates?.testLine,
    replicates?.brackets ?? 0,
  );
}

/**
 * The left margin a chart panel draws its value axis in, from the axis's tick labels, as the chart
 * lays it out: what a summary spanning columns reaches left of its first column (summaryChartPlacement).
 */
export function chartLeftMargin(_chart: FigureChart, data: FigureChartData, config: IllustrationConfig, size: number, valueAxis?: ChartAxisFrame): number {
  const fonts = figureChartFonts(config, size);
  if (data.valueKind === "proportion") return proportionPanelLayout("stacked", [], 0, fonts.tick, size).margin.left;
  return cellsFrame(data, data.cells as CellValuesModel, fonts, size, valueAxis)?.margin.left ?? 0;
}

/**
 * The chart's width and the distance its left edge sits left of the panel, for a summary spanning
 * columns: its plot area is the columns' width, one pitch per column, so each place's centre is its
 * column's centre, and the value axis sits in the margin left of the first column.
 */
export function summaryChartPlacement(margin: { left: number; right: number }, size: number, columns: { count: number; pitch: number }): { width: number; hang: number } {
  return { width: margin.left + columns.count * columns.pitch + margin.right, hang: margin.left + (columns.pitch - size) / 2 };
}

/**
 * One value axis for the panels of each statistic plot on the page, over every panel's points and
 * error bars, so a row of them compares, as a per-cell plot's panels share the figure's range;
 * none when each file's axes are its own (the figure's axis policy), each panel then fitting its own.
 */
export function figureStatisticAxes(
  panels: readonly FigurePanel[],
  data: Readonly<Record<string, FigurePanelData>>,
  config: Pick<IllustrationConfig, "figure">,
): Map<string, ChartAxisFrame> {
  const out = new Map<string, ChartAxisFrame>();
  if (!config.figure || config.figure.scalePolicy === "individual") return out;
  const byPlot = new Map<string, { keys: string[]; values: number[]; settings: ProportionsSettings }>();
  for (const panel of panels) {
    const chart = data[panel.key]?.config?.chart as FigureChartData | undefined;
    if (panel.plot.type !== "chart" || chart?.valueKind !== "statistic" || !chart.cells) continue;
    const settings = chart.settings;
    const unitIsFile = settings.unitSel === PROPORTIONS_SAMPLE_FACTOR || settings.unitSel === PROPORTIONS_NO_FACTOR;
    const points = statisticPoints(chart.cells, settings.statistic, unitIsFile);
    const slots = statisticPanels(chart.cells, points, statisticGroups(chart.cells, chart.groupLevels), chartXAxis(settings), false);
    const entry = byPlot.get(panel.plot.id) ?? { keys: [], values: [], settings };
    entry.keys.push(panel.key);
    entry.values.push(...statisticAxisValues(points, slots, statisticPlotType(settings), settings.errorBar));
    byPlot.set(panel.plot.id, entry);
  }
  for (const { keys, values, settings } of byPlot.values()) {
    // Within the limits the chart carries, from 0 unless it says otherwise, as the chart frames its own.
    const axis = statisticValueAxis(values, { fromZero: settings.plotType === "bar" || settings.valueFromZero !== false, limits: typedLimits(settings.valueMin, settings.valueMax) });
    for (const key of keys) out.set(key, axis);
  }
  return out;
}

/** The model with its population names blanked, for a panel drawn without them. */
function withoutLabels<T extends { catLevels: string[] }>(model: T): T {
  return { ...model, catLevels: model.catLevels.map(() => "") };
}

/** A composition with its groups named by blanks, one more for each group, for a summary drawn without its file labels. */
function withoutGroupNames<T extends { perSample: { group: string }[] }>(model: T): T {
  const groups = [...new Set(model.perSample.map((row) => row.group))];
  return { ...model, perSample: model.perSample.map((row) => ({ ...row, group: " ".repeat(groups.indexOf(row.group) + 1) })) };
}

/** Cells with their groups named by blanks, one more for each group, for a summary drawn without its file labels. */
function withoutCellGroupNames<T extends { violins: { group: string }[] }>(model: T, levels: readonly string[]): T {
  const name = (group: string) => " ".repeat(levels.indexOf(group) + 1);
  return { ...model, violins: model.violins.map((violin) => ({ ...violin, group: name(violin.group) })) };
}

/** The chart, sized to the panel: its whole width and height are the grid's panel size. */
export function FigureChartBody({
  chart,
  data,
  config,
  size,
  containerId,
  valueAxis,
  frame,
}: {
  chart: FigureChart;
  data: FigureChartData;
  config: IllustrationConfig;
  size: number;
  containerId: string;
  /** A statistic plot's value axis shared by its panels (figureStatisticAxes); unset, the panel fits its own. */
  valueAxis?: ChartAxisFrame;
  /** A summary panel's frame over the cells it spans; unset, the panel is `size` square. */
  frame?: FigureSummaryFrame;
}) {
  const fonts = figureChartFonts(config, size);
  // A summary names its files (or groups) under its marks unless they sit under the columns' headings.
  const labels = data.summary ? (chart.fileLabels ?? !frame?.columns) : chart.populationLabels !== false;
  const width = frame?.width ?? size;
  const height = frame?.height ?? size;
  // Spanning columns, the chart is drawn wider than the panel and moved left by `hang`.
  // The margins are taken at the width the chart is drawn: turned labels widen the left margin by
  // what its slots leave them, so the placement is worked out again until the two agree.
  const placed = (marginAt: (panelWidth: number) => { left: number; right: number }) => {
    if (!frame?.columns) return { width, hang: 0 };
    let place = summaryChartPlacement(marginAt(width), size, frame.columns);
    for (let round = 0; round < 4; round++) {
      const next = summaryChartPlacement(marginAt(place.width), size, frame.columns);
      if (next.width === place.width && next.hang === place.hang) break;
      place = next;
    }
    return place;
  };
  const shifted = (hang: number, chartElement: React.ReactElement) =>
    hang ? <div className="gl-figure-summary-chart" style={{ marginLeft: -hang }}>{chartElement}</div> : chartElement;
  if (data.valueKind === "proportion" && data.proportions) {
    // A composition's x axis is its files, named by the grid's headings when there is one.
    // A summary without its labels names each bar's group by blanks of its own length, which keeps the bars apart.
    const model = !data.summary || labels ? data.proportions : withoutGroupNames(data.proportions);
    const groups = [...new Set(model.perSample.map((row) => row.group))];
    const frameAt = (panelWidth: number) => proportionPanelLayout("stacked", groups, groups.length, fonts.tick, panelWidth);
    const place = placed((panelWidth) => frameAt(panelWidth).margin);
    const margins = frameAt(place.width).height - 240;
    const settings = { ...data.settings, panelWidth: place.width, height: Math.max(30, height - margins) };
    return shifted(place.hang,
      <PlottingChartView
        settings={settings}
        model={model}
        cellModel={null}
        unitModel={null}
        catColors={data.colors}
        populations={model.populations}
        groupLevels={!data.summary || labels ? data.groupLevels : undefined}
        groupTitle={data.groupTitle ?? null}
        fonts={fonts}
        containerId={containerId}
        only={ONE_PANEL}
      />,
    );
  }
  const cells = data.cells as CellValuesModel;
  return <CellsBody data={data} cells={cells} labels={labels} fonts={fonts} width={width} height={height} placed={placed} shifted={shifted} containerId={containerId} valueAxis={valueAxis} />;
}

/** A per-cell or statistic chart; the model without names is made once, so the violins' shapes are not worked out again on every repaint. */
function CellsBody({
  data,
  cells,
  labels,
  fonts,
  width,
  height,
  placed,
  shifted,
  containerId,
  valueAxis,
}: {
  data: FigureChartData;
  cells: CellValuesModel;
  labels: boolean;
  fonts: ReturnType<typeof figureChartFonts>;
  width: number;
  height: number;
  placed: (marginAt: (panelWidth: number) => { left: number; right: number }) => { width: number; hang: number };
  shifted: (hang: number, chartElement: React.ReactElement) => React.ReactElement;
  containerId: string;
  valueAxis?: ChartAxisFrame;
}) {
  // Without labels: a panel's population names blanked; a summary's places named by blanks, which keep them apart.
  const groupLevels = data.summary && !labels && data.groupLevels ? data.groupLevels.map((_, i) => " ".repeat(i + 1)) : data.groupLevels;
  const model = useMemo(
    () => (labels ? cells : data.summary ? withoutCellGroupNames(cells, data.groupLevels ?? []) : withoutLabels(cells)),
    [labels, cells, data.summary, data.groupLevels],
  );
  const unitModel = useMemo(
    () => (!data.unitModel || labels ? data.unitModel : data.summary ? withoutCellGroupNames(data.unitModel, data.groupLevels ?? []) : withoutLabels(data.unitModel)),
    [labels, data.unitModel, data.summary, data.groupLevels],
  );
  const drawnData = { ...data, groupLevels };
  const axis = data.valueKind === "cells" ? figureCellAxis(data, cells) : null;
  if (data.valueKind === "cells" && !axis) return <div className="gl-figure-missing" style={{ width, minHeight: height }} role="status">No cells in these populations</div>;
  // The panel's margins are those of the axis it is drawn on, at the width it is drawn.
  const place = placed((panelWidth) => cellsFrame(drawnData, model, fonts, panelWidth, valueAxis)!.margin);
  const margins = cellsFrame(drawnData, model, fonts, place.width, valueAxis)!.height;
  const settings = { ...data.settings, panelWidth: place.width, height: Math.max(30, height - margins) };
  return shifted(place.hang,
    <PlottingChartView
      settings={settings}
      model={{ catLevels: [], perSample: [], hasFacet: false }}
      cellModel={model}
      unitModel={unitModel}
      catColors={data.colors}
      populations={{}}
      groupLevels={groupLevels}
      groupTitle={data.groupTitle ?? null}
      fonts={fonts}
      xAxisFrame={axis}
      statisticAxis={valueAxis}
      containerId={containerId}
      only={ONE_PANEL}
    />,
  );
}

/** A chart panel in the grid: its count above, as a flow plot's, the chart, and the legend where asked for. */
export function FigureChartPanel({
  chart,
  data,
  config,
  size,
  containerId,
  showLegend = false,
  valueAxis,
  frame,
}: {
  chart: FigureChart;
  data: FigurePanelData;
  config: IllustrationConfig;
  size: number;
  containerId: string;
  /** Name the populations in their colours under this panel: once for each chart plot. */
  showLegend?: boolean;
  /** A statistic plot's value axis shared by its panels (figureStatisticAxes). */
  valueAxis?: ChartAxisFrame;
  /** A summary panel's frame over the cells it spans. */
  frame?: FigureSummaryFrame;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) applyFigureChartStyle(ref.current, config);
  });
  const chartData = data.config?.chart as FigureChartData | undefined;
  if (!chartData) return null;
  const count = Number(data.config!.n_events);
  const legend = chartData.summary?.legend
    ?? (chartData.cells?.catLevels ?? chartData.proportions?.catLevels ?? []).map((name, i) => ({ name, color: chartData.colors[i] }));
  const width = frame?.width ?? size;
  return (
    <div className="gl-figure-panel gl-figure-chart-panel">
      <div className="illustration-row-header gl-figure-panel-meta">
        {count.toLocaleString()} {chartData.valueKind === "proportion" ? "events" : "cells"}
      </div>
      <div
        ref={ref}
        className={frame ? "gl-figure-chart gl-figure-summary" : "gl-figure-chart"}
        style={{ width, height: frame?.height ?? size }}
        role="img"
        aria-label={`${String(data.config!.x_label ?? "Chart")}; ${count} ${chartData.valueKind === "proportion" ? "events" : "cells"}`}
      >
        <FigureChartBody chart={chart} data={chartData} config={config} size={size} containerId={containerId} valueAxis={valueAxis} frame={frame} />
      </div>
      {showLegend && (
        <div className="gl-figure-legend" style={{ maxWidth: width }}>
          {legend.map(({ name, color }, i) => (
            <span key={i} className="illustration-row-header" style={{ color }}>
              ● {name}
            </span>
          ))}
        </div>
      )}
      {/* As wide as the panel, wrapping: the note never sets the column's width. */}
      {data.note && <div className="illustration-row-header gl-figure-tailored" style={{ width: 0, minWidth: "100%" }}>{data.note}</div>}
    </div>
  );
}
