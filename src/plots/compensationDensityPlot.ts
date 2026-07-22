import type { CompensationDensityPanel } from "../engine/compensationPairPreview";
import type { AxisTicks } from "../engine/ticks";
import { loadMiniPlots } from "./loadPlots";

export interface CompensationPlotFrame {
  readonly eventCount: number;
  readonly xRange: readonly [number, number];
  readonly yRange: readonly [number, number];
  /** FlowJo-style decade ticks (null → linear), so compensation biplots match the Gating tab. */
  readonly xTicks?: AxisTicks | null;
  readonly yTicks?: AxisTicks | null;
}

export interface CompensationDensityPlotOptions {
  readonly title: string;
  readonly panel: CompensationDensityPanel;
  readonly preview: CompensationPlotFrame;
  readonly sourceLabel: string;
  readonly receiverLabel: string;
  readonly size: number;
  readonly densityColorCeiling?: number;
  readonly densitySmoothingRadius: number;
  readonly densityColorPower: number;
  readonly pointAlpha: number;
  readonly canvasScale?: number;
}

/**
 * Render the shared compensation biplot surface used on screen and in comparison exports.
 * Keeping one configuration boundary prevents exported axes, point geometry, and smoothing
 * from drifting away from the inspector view.
 */
export function renderCompensationDensityBiplotSurface(
  container: HTMLElement,
  options: Readonly<CompensationDensityPlotOptions>,
): void {
  const linearScale = options.size / 220;
  const typographyScale = Math.sqrt(linearScale);
  const axisFontSize = Math.max(7, Math.min(11, 10 * typographyScale));
  // The y title sits yAxisLabelOffset pixels left of the axis. Reserve its font height too so
  // multi-character FlowJo ticks and the rotated title cannot touch the SVG boundary.
  const yAxisLabelOffset = 20;
  const leftMargin = Math.ceil(yAxisLabelOffset + axisFontSize + 4);
  loadMiniPlots().renderMiniPlot(container, {
    plot_size: options.size,
    canvas_scale: options.canvasScale ?? 3,
    display_mode: "pseudocolor",
    x: options.panel.x,
    y: options.panel.y,
    x_range: options.preview.xRange,
    y_range: options.preview.yRange,
    x_is_logicle: !!options.preview.xTicks,
    x_logicle_ticks: options.preview.xTicks ?? null,
    y_is_logicle: !!options.preview.yTicks,
    y_logicle_ticks: options.preview.yTicks ?? null,
    x_label: options.sourceLabel,
    y_label: options.receiverLabel,
    title: options.title,
    point_size: Math.max(0.55, Math.min(1.2, 1.15 * linearScale)),
    point_alpha: options.pointAlpha,
    density_clip_quantile: 0.95,
    density_color_power: options.densityColorPower,
    density_color_ceiling: options.densityColorCeiling,
    density_smoothing: options.densitySmoothingRadius,
    x_axis_label_offset: 24,
    y_axis_label_offset: yAxisLabelOffset,
    axis_tick_size: 3,
    axis_outer_tick_size: 0,
    plot_margins: { top: 20, right: 2, bottom: 30, left: leftMargin },
    font_sizes: {
      tick: Math.max(6.5, Math.min(10, 9 * typographyScale)),
      axis_label: axisFontSize,
      title: Math.max(7.5, Math.min(12, 11 * typographyScale)),
      gate_label: Math.max(6.5, Math.min(10, 9 * typographyScale)),
    },
  });
}
