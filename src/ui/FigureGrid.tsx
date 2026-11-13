import { memo, useEffect, useRef } from "react";
import type {
  FigurePage,
  FigurePanel,
  FigurePanelData,
  FigureValue,
} from "../engine/figure";
import type { IllustrationConfig } from "../engine/workspace";
import { drawFigurePlot } from "../plots/figurePlot";
import { buildHeatmapMatrix, splitHeatmapPage } from "../engine/figureHeatmap";
import { FigureHeatmap } from "./FigureHeatmap";
import { chartLeftMargin, FigureChartPanel, figureStatisticAxes, summaryChartPlacement, type FigureSummaryFrame } from "./FigureChartPanel";
import type { FigureChartData } from "./figureChartData";
import { attachGridPan } from "./gridPan";

/**
 * An overlaid panel leads with the first population that has events, since a plot draws nothing
 * when its main trace is empty; the populations before it are empty overlays. A ridgeline draws
 * each trace on its own row and an empty one as an empty row, so the ridges go back to the
 * legend's order: the empty overlays that match the legend's first entries, then the lead.
 */
function ridgesInLegendOrder(data: Record<string, unknown>): Record<string, unknown> {
  const legend = (data.legend_entries ?? []) as { name: string; color: string }[];
  const overlays = (data.overlay_traces ?? []) as { x?: ArrayLike<number>; y?: unknown; name?: string; color?: string }[];
  if (!(data.x as ArrayLike<number> | undefined)?.length) return {};
  let lead = 0;
  while (
    lead < overlays.length &&
    !overlays[lead].x?.length &&
    overlays[lead].name === legend[lead]?.name &&
    overlays[lead].color === legend[lead]?.color
  )
    lead++;
  if (!lead) return {};
  const ridges = [
    ...overlays.slice(0, lead),
    { x: data.x, y: data.y, name: legend[lead]?.name, color: data.pop_color },
    ...overlays.slice(lead),
  ];
  return { x: ridges[0].x, y: ridges[0].y, pop_color: ridges[0].color, overlay_traces: ridges.slice(1) };
}

export function styledFigurePlot(
  data: Record<string, unknown>,
  config: IllustrationConfig,
  size: number,
  showGates: boolean,
): Record<string, unknown> {
  const fontScale = config.scaleFontsWithPlot ? size / 280 : 1;
  return {
    ...data,
    ...(config.histLayout === "ridgeline" && !data.y_label && !("figure_summary" in data) ? ridgesInLegendOrder(data) : {}),
    plot_size: size,
    display_mode: ((data.overlay_traces ?? []) as unknown[]).length
      ? "scatter"
      : config.displayMode,
    point_size: config.pointSize,
    point_alpha: config.pointAlpha,
    hist_layout: config.histLayout,
    ridge_overlap: config.ridgeOverlap,
    ridge_gradient: config.ridgeGradient,
    summary_show_values: config.heatmapShowValues,
    legend_entries: [],
    density_color_power: config.densityColorPower,
    contour_threshold: config.contourThreshold,
    contour_levels: config.contourLevels ?? 10,
    kde_bandwidth: config.kdeBandwidth,
    hist_line_width: config.histLineWidth,
    hist_fill: config.histFill,
    hist_fill_alpha: config.histFillAlpha,
    hist_overlay_mode: config.histOverlayMode,
    font_sizes: {
      tick: config.fontTick * fontScale,
      axis_label: config.fontAxis * fontScale,
      title: config.fontTitle * fontScale,
      gate_label: config.fontGate * fontScale,
    },
    // A set axis-title distance scales with the fonts it sits among; unset, the renderer sizes
    // it from the tick labels.
    x_axis_label_offset: config.axisTitleOffsetX == null ? undefined : config.axisTitleOffsetX * fontScale,
    y_axis_label_offset: config.axisTitleOffsetY == null ? undefined : config.axisTitleOffsetY * fontScale,
    gates: showGates ? data.gates : [],
    gate_style: {
      pub_style: config.pubStyle,
      line_width: config.gateLineWidth,
      gate_edge_mode: config.gateEdgeMode,
      label_format: config.gateLabelFormat ?? "name-percent",
      ...(config.gateLabelBold ? { label_weight: "bold" } : {}),
      label_background: config.labelBackground ?? 0.6,
    },
  };
}

const FigurePlot = memo(function FigurePlot({
  data,
  config,
  size,
  showGates,
  onLabelMove,
}: {
  data: FigurePanelData;
  config: IllustrationConfig;
  size: number;
  showGates: boolean;
  onLabelMove?: (gateId: string, offset: [number, number], quadrant?: number, flipped?: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The latest handler, so a drag started on one render lands on the current figure.
  const onLabelMoveRef = useRef(onLabelMove);
  onLabelMoveRef.current = onLabelMove;
  // Redraw on the style the panel is drawn with, not on the config object: every edit of the
  // figure (a moved label among them) makes a new config, and redrawing the old data then
  // snapped a moved label back until the rebuilt panel arrived.
  const configRef = useRef(config);
  configRef.current = config;
  const styleKey = JSON.stringify([
    config.displayMode, config.pointSize, config.pointAlpha, config.histLayout, config.ridgeOverlap,
    config.ridgeGradient, config.heatmapShowValues, config.densityColorPower, config.contourThreshold,
    config.contourLevels, config.kdeBandwidth, config.histLineWidth, config.histFill, config.histFillAlpha,
    config.histOverlayMode, config.fontTick, config.fontAxis, config.fontTitle, config.fontGate,
    config.scaleFontsWithPlot, config.pubStyle, config.gateLineWidth, config.gateEdgeMode, config.gateLabelFormat,
    config.axisTitleOffsetX, config.axisTitleOffsetY, config.gateLabelBold, config.labelBackground,
  ]);
  useEffect(() => {
    if (!ref.current || !data.config) return;
    const node = ref.current;
    const config = configRef.current;
    const styled = styledFigurePlot(data.config, config, size, showGates);
    drawFigurePlot(node, {
      ...styled,
      ...(config.histLayout === "ridgeline" && !data.config.y_label
        ? {}
        : { legend_entries: [] }),
      // The label drag travels with the gate style, which is what the mini plot's gate code sees.
      ...(onLabelMove
        ? {
            gate_style: {
              ...(styled.gate_style as Record<string, unknown>),
              on_label_move: (gateId: string, offset: [number, number], quadrant?: number) => {
                const gate = (data.config?.gates as { gate_id: string; flipped?: boolean }[] | undefined)?.find((g) => g.gate_id === gateId);
                onLabelMoveRef.current?.(gateId, offset, quadrant, !!gate?.flipped);
              },
            },
          }
        : {}),
    });
    return () => {
      node.replaceChildren();
    };
  }, [data, styleKey, size, showGates, !!onLabelMove]); // eslint-disable-line react-hooks/exhaustive-deps
  if (data.omitted)
    return (
      <span
        className="gl-figure-not-applicable"
        title="This population does not apply to this file"
      >
        —
      </span>
    );
  if (!data.config)
    return (
      <div
        className="gl-figure-missing"
        style={{ width: size, minHeight: size }}
        role="status"
      >
        {data.omitted ? "Not included" : data.problem}
      </div>
    );
  const count = Number(data.config.n_events);
  const shown =
    (data.config.x as number[]).length +
    ((data.config.overlay_traces ?? []) as { x: number[] }[]).reduce(
      (n, t) => n + t.x.length,
      0,
    );
  return (
    <div className="gl-figure-panel">
      {data.config.population_label ? (
        <div className="illustration-row-header gl-figure-panel-meta">
          Fixed population: {String(data.config.population_label)}
        </div>
      ) : null}
      <div className="illustration-row-header gl-figure-panel-meta">
        {count.toLocaleString()}{" "}
        {data.config.population_memberships ? "memberships" : "events"}
        {shown < count && !("figure_summary" in data.config)
          ? ` · ${shown.toLocaleString()} drawn`
          : ""}
      </div>
      <div
        ref={ref}
        className="mini-plot-cell"
        style={{ width: size, height: size, position: "relative" }}
        role="img"
        aria-label={`${data.config.x_label} versus ${data.config.y_label ?? "density"}; ${count} events`}
      />
      <div className="gl-figure-legend" style={{ maxWidth: size }}>
        {(
          (data.config.legend_entries ?? []) as {
            name: string;
            color: string;
          }[]
        ).map((entry, i) => (
          <span
            key={i}
            className="illustration-row-header"
            style={{
              color:
                config.histLayout === "ridgeline" && config.ridgeGradient
                  ? "#334155"
                  : entry.color,
            }}
          >
            {config.histLayout === "ridgeline" ? `${i + 1}.` : "●"} {entry.name}
          </span>
        ))}
      </div>
      {data.mappings.some((m) => m.status === "tailored") && (
        <div className="illustration-row-header gl-figure-tailored">
          Tailored boundary
        </div>
      )}
      {data.note && (
        // As wide as the panel, wrapping: the note never sets the column's width.
        <div className="illustration-row-header gl-figure-tailored" style={{ width: 0, minWidth: "100%" }}>
          {data.note}
        </div>
      )}
    </div>
  );
});

/** The space between the grid's cells: the table's border-spacing in figure.css. */
export const FIGURE_GRID_SPACING = 12;

/**
 * A summary panel's frame over the cells it spans, at the grid's panel size: spanning columns, the
 * columns' pitch, so its places sit under their columns' centres. Spanning rows only (the files
 * down the rows), it is one panel high, at the top of its column: a chart stretched down every
 * row could not be read.
 */
export function summaryFrame(panel: FigurePanel, size: number): FigureSummaryFrame | undefined {
  if (!panel.span) return undefined;
  const across = (n: number) => n * size + (n - 1) * FIGURE_GRID_SPACING;
  return {
    width: across(panel.span.columns),
    height: panel.span.columns === 1 ? size : across(panel.span.rows),
    ...(panel.span.rows === 1 ? { columns: { count: panel.span.columns, pitch: size + FIGURE_GRID_SPACING } } : {}),
  };
}

function prefix(group: FigureValue[], depth: number) {
  return JSON.stringify(group.slice(0, depth + 1));
}

/** Normalisation is explicit and uses the whole visible page, never the sampled point cloud. */
export function colourFigureSummaries(
  page: FigurePage,
  panels: Record<string, FigurePanelData>,
  config: IllustrationConfig,
): Record<string, FigurePanelData> {
  const summaries = page.panels.filter(
    (p) => typeof panels[p.key]?.config?.figure_summary === "number",
  );
  if (!summaries.length) return panels;
  const output = { ...panels };
  for (const panel of summaries) {
    const mode = config.heatmapScale ?? "none";
    const peers = summaries.filter((p) =>
      mode.startsWith("column")
        ? p.plot.id === panel.plot.id
        : mode === "row_minmax"
          ? refKeyForSummary(p.population) ===
            refKeyForSummary(panel.population)
          : true,
    );
    const values = peers.map((p) =>
      Number(panels[p.key].config!.figure_summary),
    );
    const value = Number(panels[panel.key].config!.figure_summary),
      lo = Math.min(...values),
      hi = Math.max(...values);
    let t = hi > lo ? (value - lo) / (hi - lo) : 0.5;
    if (mode === "column_zscore") {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const sd = Math.sqrt(
        values.reduce((n, v) => n + (v - mean) ** 2, 0) / values.length,
      );
      t = sd ? Math.max(0, Math.min(1, ((value - mean) / sd + 2) / 4)) : 0.5;
    }
    const stops =
      config.heatmapPalette === "heat"
        ? [
            [255, 255, 204],
            [253, 141, 60],
            [128, 0, 38],
          ]
        : config.heatmapPalette === "viridis"
          ? [
              [68, 1, 84],
              [59, 82, 139],
              [33, 145, 140],
              [94, 201, 98],
              [253, 231, 37],
            ]
          : [
              [49, 54, 149],
              [255, 255, 255],
              [255, 255, 100],
              [165, 0, 38],
            ];
    const pos = t * (stops.length - 1),
      index = Math.min(stops.length - 2, Math.floor(pos)),
      f = pos - index;
    const rgb = stops[index].map((v, i) =>
      Math.round(v + (stops[index + 1][i] - v) * f),
    );
    const color = `rgb(${rgb.join(",")})`,
      luminance = (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255;
    output[panel.key] = {
      ...panels[panel.key],
      config: {
        ...panels[panel.key].config,
        summary_color: color,
        summary_text_color: luminance < 0.5 ? "#ffffff" : "#26364a",
      },
    };
  }
  return output;
}
function refKeyForSummary(ref: { hierarchyId: string; populationId: string }) {
  return JSON.stringify([ref.hierarchyId, ref.populationId]);
}

export function FigureGrid({
  page,
  panels,
  config,
  size,
  showGates,
  id = "figure-preview-grid",
  onLabelMove,
  onPanelContextMenu,
  onMatrixContextMenu,
  selectedPanels,
  onPanelClick,
  onPanelScaleChange,
}: {
  page: FigurePage;
  panels: Record<string, FigurePanelData>;
  config: IllustrationConfig;
  size: number;
  showGates: boolean;
  id?: string;
  /**
   * A panel panned or stretched by the Gating tab's navigate drag: the channel's new range, for
   * the workspace's scales. Offered only while the figure follows the Gating tab's axes, which is
   * where the range then shows.
   */
  onPanelScaleChange?: (channelKey: string, range: [number, number]) => void;
  /** A gate label was dragged in a panel: the gate's id (in that panel's tree), its new offset, the quadrant for a quadrant gate's label, and whether the panel showed the gate with its axes swapped. */
  onLabelMove?: (gateId: string, offset: [number, number], quadrant?: number, flipped?: boolean) => void;
  /** A right-click on a panel, for a menu about it. */
  onPanelContextMenu?: (panel: FigurePanel, event: React.MouseEvent<HTMLElement>) => void;
  /** A right-click on the summary heatmap matrix. */
  onMatrixContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
  /** The panels chosen, by key, and a click on a panel, which chooses. */
  selectedPanels?: ReadonlySet<string>;
  onPanelClick?: (panel: FigurePanel, event: React.MouseEvent<HTMLElement>) => void;
}) {
  // A press that moved, as when a gate label is dragged, is not a click on the panel.
  const pressed = useRef<[number, number] | null>(null);
  // The navigate drag on a panel: the panel's channels and ranges read from the latest page and
  // data, the ranges handed on as the Gating tab's own drag hands them on.
  const tableRef = useRef<HTMLTableElement>(null);
  const latest = useRef({ page, panels, onPanelScaleChange });
  latest.current = { page, panels, onPanelScaleChange };
  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    return attachGridPan(
      table,
      (cell) => {
        const { page: current, panels: data, onPanelScaleChange: handler } = latest.current;
        if (!handler) return null;
        const key = cell.closest<HTMLElement>("[data-figure-panel]")?.getAttribute("data-figure-panel");
        const panel = key ? current.panels.find((candidate) => candidate.key === key) : undefined;
        const cfg = key ? data[key]?.config : null;
        if (!panel || !cfg || panel.plot.type !== "biplot") return null;
        const xr = cfg.x_range as [number, number] | undefined, yr = cfg.y_range as [number, number] | undefined;
        if (!xr || !yr) return null;
        return { xKey: panel.plot.x, yKey: panel.plot.y, xr, yr };
      },
      (panel, xr, yr) => {
        const handler = latest.current.onPanelScaleChange;
        handler?.(panel.xKey, xr);
        if (panel.yKey !== panel.xKey) handler?.(panel.yKey, yr);
      },
    );
  }, []);
  const clickPanel = (panel: FigurePanel, event: React.MouseEvent<HTMLElement>) => {
    const from = pressed.current;
    pressed.current = null;
    if (from && Math.hypot(event.clientX - from[0], event.clientY - from[1]) > 4) return;
    onPanelClick?.(panel, event);
  };
  // Summary heatmap panels are drawn as one matrix beneath the plot table; the table keeps the
  // other panels, and is left out when every panel on the page is a heatmap.
  const { table } = splitHeatmapPage(page);
  const matrix = buildHeatmapMatrix(page, panels, config);
  const grid = table ?? page;
  // A chart plot names its populations in their colours once, under its first drawn panel.
  const chartLegends = new Set<string>();
  for (const plotId of new Set(grid.panels.filter((p) => p.plot.type === "chart").map((p) => p.plot.id))) {
    const first = grid.panels.find((p) => p.plot.id === plotId && panels[p.key]?.config);
    if (first) chartLegends.add(first.key);
  }
  // A statistic plot's panels share one value axis while the figure's axes are shared.
  const statisticAxes = figureStatisticAxes(grid.panels, panels, config);
  // A summary spanning columns from the first draws its value axis left of that column: the row
  // headings (or the grid's edge) leave it the room.
  const hang = Math.max(0, ...grid.panels.map((p) => {
    const chart = panels[p.key]?.config?.chart as FigureChartData | undefined;
    const columns = p.column === 0 && p.plot.chart ? summaryFrame(p, size)?.columns : undefined;
    return columns && chart ? summaryChartPlacement({ left: chartLeftMargin(p.plot.chart!, chart, config, size, statisticAxes.get(p.key)), right: 0 }, size, columns).hang : 0;
  }));
  const hangRoom = Math.max(0, Math.ceil(hang) - FIGURE_GRID_SPACING);
  const rowDepth = grid.rows[0]?.length ?? 0;
  const colDepth = Math.max(1, grid.columns[0]?.length ?? 0);
  return (
    <table
      ref={tableRef}
      id={id}
      className="gl-figure-grid"
      aria-label={page.label}
      style={
        {
          "--figure-heading-size": `${config.fontTitle * (config.scaleFontsWithPlot ? size / 280 : 1)}px`,
          ...(hangRoom && rowDepth === 0 ? { paddingLeft: hangRoom } : {}),
        } as React.CSSProperties
      }
    >
      <caption className="illustration-row-header">{page.label}</caption>
      {table && (
        <>
      <thead>
        {Array.from({ length: colDepth }, (_, depth) => (
          <tr key={depth}>
            {depth === 0 && rowDepth > 0 && (
              <th rowSpan={colDepth} colSpan={rowDepth} />
            )}
            {grid.columns.flatMap((group, index) => {
              if (
                index &&
                prefix(grid.columns[index - 1], depth) === prefix(group, depth)
              )
                return [];
              let span = 1;
              while (
                index + span < grid.columns.length &&
                prefix(grid.columns[index + span], depth) ===
                  prefix(group, depth)
              )
                span++;
              return (
                <th
                  key={index}
                  colSpan={span}
                  scope="colgroup"
                  className="illustration-row-header"
                  style={{ maxWidth: size * span }}
                >
                  {group[depth]?.label ?? "Plots"}
                </th>
              );
            })}
          </tr>
        ))}
      </thead>
      <tbody>
        {grid.rows.map((group, row) => (
          <tr key={row}>
            {group.flatMap((value, depth) => {
              if (
                row &&
                prefix(grid.rows[row - 1], depth) === prefix(group, depth)
              )
                return [];
              let span = 1;
              while (
                row + span < grid.rows.length &&
                prefix(grid.rows[row + span], depth) === prefix(group, depth)
              )
                span++;
              return (
                <th
                  key={depth}
                  rowSpan={span}
                  scope="rowgroup"
                  className="illustration-row-header gl-figure-row-heading"
                  style={hangRoom && depth === rowDepth - 1 ? { paddingRight: hangRoom } : undefined}
                >
                  {value.label}
                </th>
              );
            })}
            {grid.columns.map((_, column) => {
              const panel = grid.panels[row * grid.columns.length + column];
              // A cell a summary panel covers is part of that panel's cell.
              if (panel.coveredBy) return null;
              const data = panels[panel.key];
              const frame = summaryFrame(panel, size);
              const panelSize =
                data?.config && "figure_summary" in data.config
                  ? Math.max(50, config.heatmapCellSize ?? 80)
                  : size;
              return (
                <td
                  key={column}
                  {...(panel.span ? { colSpan: panel.span.columns, rowSpan: panel.span.rows } : {})}
                  data-figure-panel={panel.key}
                  className={selectedPanels?.has(panel.key) ? "is-selected" : undefined}
                  aria-selected={selectedPanels ? selectedPanels.has(panel.key) : undefined}
                  onPointerDown={onPanelClick ? (event) => { pressed.current = [event.clientX, event.clientY]; } : undefined}
                  onClick={onPanelClick ? (event) => clickPanel(panel, event) : undefined}
                  onContextMenu={onPanelContextMenu ? (event) => onPanelContextMenu(panel, event) : undefined}
                >
                  {data?.config && panel.plot.type === "chart" && panel.plot.chart ? (
                    <FigureChartPanel
                      chart={panel.plot.chart}
                      data={data}
                      config={config}
                      size={size}
                      containerId={`${id}-chart-${row}-${column}`}
                      showLegend={chartLegends.has(panel.key)}
                      valueAxis={statisticAxes.get(panel.key)}
                      frame={frame}
                    />
                  ) : data ? (
                    <FigurePlot
                      data={data}
                      config={config}
                      size={panelSize}
                      showGates={showGates}
                      onLabelMove={onLabelMove}
                    />
                  ) : (
                    <div
                      className="gl-figure-missing"
                      style={{ width: size, minHeight: size }}
                    >
                      Preparing panel…
                    </div>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
        </>
      )}
      {matrix && (
        <tbody className="gl-figure-heatmap-body">
          <tr>
            <td colSpan={Math.max(1, rowDepth + grid.columns.length)} data-figure-panel="heatmap-matrix" onContextMenu={onMatrixContextMenu}>
              <FigureHeatmap matrix={matrix} config={config} cellSize={Math.max(12, Math.min(120, config.heatmapCellSize ?? 28))} />
            </td>
          </tr>
        </tbody>
      )}
    </table>
  );
}
