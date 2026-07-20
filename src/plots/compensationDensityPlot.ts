import type { CompensationDensityPanel } from "../engine/compensationPairPreview";
import { loadMiniPlots } from "./loadPlots";

export interface CompensationPlotFrame {
  readonly eventCount: number;
  readonly xRange: readonly [number, number];
  readonly yRange: readonly [number, number];
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
  loadMiniPlots().renderMiniPlot(container, {
    plot_size: options.size,
    canvas_scale: options.canvasScale ?? 3,
    display_mode: "pseudocolor",
    x: options.panel.x,
    y: options.panel.y,
    x_range: options.preview.xRange,
    y_range: options.preview.yRange,
    x_label: options.sourceLabel,
    y_label: options.receiverLabel,
    title: options.title,
    point_size: Math.max(0.55, Math.min(1.2, 1.15 * linearScale)),
    point_alpha: 0.85,
    density_clip_quantile: 0.95,
    density_color_power: options.densityColorPower,
    density_color_ceiling: options.densityColorCeiling,
    density_smoothing: options.densitySmoothingRadius,
    axis_label_offset: 20,
    axis_tick_size: 3,
    axis_outer_tick_size: 0,
    plot_margins: { top: 20, right: 2, bottom: 30, left: 31 },
    font_sizes: {
      tick: Math.max(6.5, Math.min(10, 9 * typographyScale)),
      axis_label: Math.max(7, Math.min(11, 10 * typographyScale)),
      title: Math.max(7.5, Math.min(12, 11 * typographyScale)),
      gate_label: Math.max(6.5, Math.min(10, 9 * typographyScale)),
    },
  });
}
