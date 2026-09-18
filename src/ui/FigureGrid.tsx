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

export function styledFigurePlot(
  data: Record<string, unknown>,
  config: IllustrationConfig,
  size: number,
  showGates: boolean,
): Record<string, unknown> {
  const fontScale = config.scaleFontsWithPlot ? size / 280 : 1;
  return {
    ...data,
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
    gates: showGates ? data.gates : [],
    gate_style: {
      pub_style: config.pubStyle,
      line_width: config.gateLineWidth,
      gate_edge_mode: config.gateEdgeMode,
      label_format: config.gateLabelFormat ?? "name-percent",
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
    </div>
  );
});

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
}: {
  page: FigurePage;
  panels: Record<string, FigurePanelData>;
  config: IllustrationConfig;
  size: number;
  showGates: boolean;
  id?: string;
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
  const rowDepth = grid.rows[0]?.length ?? 0;
  const colDepth = Math.max(1, grid.columns[0]?.length ?? 0);
  return (
    <table
      id={id}
      className="gl-figure-grid"
      aria-label={page.label}
      style={
        {
          "--figure-heading-size": `${config.fontTitle * (config.scaleFontsWithPlot ? size / 280 : 1)}px`,
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
                >
                  {value.label}
                </th>
              );
            })}
            {grid.columns.map((_, column) => {
              const panel = grid.panels[row * grid.columns.length + column];
              const data = panels[panel.key];
              const panelSize =
                data?.config && "figure_summary" in data.config
                  ? Math.max(50, config.heatmapCellSize ?? 80)
                  : size;
              return (
                <td
                  key={column}
                  data-figure-panel={panel.key}
                  className={selectedPanels?.has(panel.key) ? "is-selected" : undefined}
                  aria-selected={selectedPanels ? selectedPanels.has(panel.key) : undefined}
                  onPointerDown={onPanelClick ? (event) => { pressed.current = [event.clientX, event.clientY]; } : undefined}
                  onClick={onPanelClick ? (event) => clickPanel(panel, event) : undefined}
                  onContextMenu={onPanelContextMenu ? (event) => onPanelContextMenu(panel, event) : undefined}
                >
                  {data ? (
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
