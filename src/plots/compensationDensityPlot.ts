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
  /** A factor on the size-based point radius; 1 is the radius the panel's size gives. */
  readonly pointSize?: number;
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
  // The Gating tab's sizes, scaled down a little for a panel a third the size: a tick label
  // must still be read, and the rotated y title must clear "100K". No fixed label offsets or
  // margins are passed: the renderer sizes them from the tick labels it is about to draw,
  // which is what stopped the title running through the labels on the Strategy grid.
  const tickFontSize = Math.max(9, Math.min(12, 11 * typographyScale));
  const axisFontSize = Math.max(10, Math.min(13, 12 * typographyScale));
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
    point_size: Math.max(0.55, Math.min(1.2, 1.15 * linearScale)) * (options.pointSize ?? 1),
    point_alpha: options.pointAlpha,
    density_clip_quantile: 0.95,
    density_color_power: options.densityColorPower,
    density_color_ceiling: options.densityColorCeiling,
    density_smoothing: options.densitySmoothingRadius,
    axis_tick_size: 6,
    axis_outer_tick_size: 0,
    plot_margins: { top: 22, right: 8 },
    font_sizes: {
      tick: tickFontSize,
      axis_label: axisFontSize,
      title: Math.max(10, Math.min(13, 12 * typographyScale)),
      gate_label: tickFontSize,
    },
  });
}
