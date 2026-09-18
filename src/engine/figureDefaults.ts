import type { IllustrationConfig } from "./workspace";
import type { IllustrationOptions } from "./illustration";

export function defaultIllustrationConfig(): IllustrationConfig {
  return {
    popIds: [],
    xChannels: [],
    yChannel: "",
    displayMode: "pseudocolor",
    plotSize: 280,
    nColumns: 3,
    fitToColumns: false,
    maxEvents: 10000,
    allEvents: false,
    colorByPop: false,
    overlayPops: false,
    popColors: {},
    pointSize: 1.2,
    pointAlpha: 0.35,
    densityColorPower: 1.6,
    contourThreshold: 5,
    kdeBandwidth: 0,
    pubStyle: false,
    gateLineWidth: 1.5,
    gateEdgeMode: "straight-bow",
    histLineWidth: 1.8,
    histFill: false,
    histFillAlpha: 0.22,
    histOverlayMode: "blend",
    histLayout: "grid",
    ridgeOverlap: 0.7,
    ridgeColGap: 8,
    ridgeGradient: true,
    fontTick: 10,
    fontAxis: 12,
    fontTitle: 12,
    fontGate: 11,
    scaleFontsWithPlot: false,
  };
}

export function figureStyle(
  config: IllustrationConfig,
  exportAll = false,
): IllustrationOptions {
  return {
    ...config,
    maxEvents: exportAll
      ? Infinity
      : Math.max(1, Math.min(config.maxEvents || 10000, 1_000_000)),
    populationColors: config.popColors,
    scaleFontsWithPlot: false,
    densityColorPower: config.densityColorPower ?? 1.6,
    summaryStat: config.heatmapStat ?? "median",
    fontSizes: {
      tick: config.fontTick,
      axis_label: config.fontAxis,
      title: config.fontTitle,
      gate_label: config.fontGate,
    },
  };
}
