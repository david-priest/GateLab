// proportionsSettings.ts — the Plotting tab's settings as one plain object. The field names are
// the tab's persisted keys without their `prop.` prefix, so a saved workspace's plotting state
// and a Layout block's snapshot of the chart are the same shape. This module has no workspace
// knowledge, so the layout model can normalise a saved block without one.

import { OVERLAY_PALETTES, type PaletteName } from "./palettes";

/** The Group, Replicate unit and Facet pickers' value for the file itself, and for no facet. */
export const PROPORTIONS_SAMPLE_FACTOR = "__sample__";
export const PROPORTIONS_NO_FACTOR = "";

export interface ProportionsSettings {
  /** The files drawn, by id. */
  files: string[];
  hierarchy: string;
  categoryKind: "population" | "division";
  /**
   * What the chart draws: each population's share of its parent (a stacked bar or a boxplot of
   * replicate units), a channel's value in each of the population's cells (a violin or a box), or
   * a statistic of a channel in each replicate unit (a box, bars or points, a point per unit).
   */
  valueKind: "proportion" | "cells" | "statistic";
  /**
   * A stacked bar, a boxplot, bars and points draw proportions; a violin, a split violin (two
   * groups' halves side by side), a boxplot and ridgelines draw cells; a boxplot, bars and points
   * draw a statistic.
   */
  plotType: "stacked" | "box" | "violin" | "bar" | "dots" | "splitViolin" | "ridgeline";
  /** The channel a per-cell or statistic chart draws, by key; empty until one is chosen. The first of `channels`. */
  channel: string;
  /**
   * Every channel a per-cell or statistic chart draws, by key, `channel` first; with more than one,
   * the channels are a panel dimension, each with its own panels and value axis. A chart saved
   * before the list has none and draws `channel`.
   */
  channels: string[];
  /**
   * What runs along a per-cell or statistic panel's x axis: the populations, with a panel per
   * group, or the groups, with a panel per population.
   */
  xAxis: "populations" | "groups";
  /**
   * A statistic chart's statistic, of each replicate unit's cells pooled, taken on the channel's
   * linear values as the Statistics tab takes it ("Raw").
   */
  statistic: "median" | "mean" | "geomean";
  /** A bar chart's error bars over the units: the standard deviation or the standard error of the mean. */
  errorBar: "sd" | "sem";
  /** A rank test between the groups in each panel of a statistic chart, its p value written in the panel. */
  test: boolean;
  /**
   * What the rank test compares: the groups at once (rank-sum for two, Kruskal–Wallis for more), or
   * also every pair of groups, each drawn as a bracket with its Holm-adjusted p.
   */
  comparisons: "overall" | "pairwise";
  /** Which pairwise brackets are drawn: every pair, or those with an adjusted p below 0.05. */
  comparisonsShow: "all" | "significant";
  /**
   * What a proportion chart's boxplot, bars or points give each population in each replicate unit:
   * its share of the parent, its share of the file's root population ("% of total" on the
   * Statistics tab), or its events. A stacked bar is always a composition of the parent.
   */
  proportionValue: "parent" | "total" | "count";
  /**
   * How the panels are arranged: wrapped, `panelsPerRow` to a row, or a column for each value of
   * the populations, the groups or the facets, the chart's other panel dimension down the rows.
   */
  panelColumns: "" | "populations" | "groups" | "facet" | "channels";
  /**
   * A row of panels for each value of one of the chart's panel dimensions; with `panelColumns` set
   * too, a grid headed above each column and beside each row. Empty: as `panelColumns` says.
   */
  panelRows: "" | "populations" | "groups" | "facet" | "channels";
  /**
   * A page for each value of one of the chart's panel dimensions, one page drawn at a time; a
   * Layout block records the page it draws. Empty: one page.
   */
  pageBy: "" | "populations" | "groups" | "facet" | "channels";
  panelsPerRow: number;
  /** Each panel's width in pixels, axes and title included, as an Illustration panel's size is; 0 fits it to its contents. */
  panelWidth: number;
  /** A per-cell chart's value axis: the channel's range on the Gating tab, or fitted to the cells drawn. */
  cellRange: "gating" | "fit";
  /** Draw each violin's median and quartiles inside it. */
  violinBox: boolean;
  /** The population the composition is shown within; the root when unset or gone. */
  parent: string;
  selectedPops: string[];
  includeUngated: boolean;
  groupSel: string;
  unitSel: string;
  facetSel: string;
  palette: PaletteName;
  averagePerUnit: boolean;
  fontTick: number;
  fontAxis: number;
  fontLegend: number;
  height: number;
  grid: boolean;
  points: boolean;
  /** Join each replicate unit's points across the groups of a boxplot, for paired designs. */
  paired: boolean;
  legend: boolean;
  pointRadius: number;
  /** Write each mark's n under its category label: the cells drawn, or the replicate units, as the tooltips give them. */
  showN: boolean;
  /**
   * With the groups along x (`xAxis: "groups"`), colour each mark by its panel's population in
   * place of its group. Absent means by group. An Illustration summary panel sent to Layout sets
   * it, since the figure colours its marks by population.
   */
  colourByPopulation?: boolean;
  /** With the groups along x (`xAxis: "groups"`), draw every population in one panel, side by side at each group and coloured by population, in place of a panel per population. Absent means a panel per population. An Illustration summary panel sent to Layout sets it. */
  populationsTogether?: boolean;
  /**
   * The value axis's lower and upper limits, in the units the axis is labelled in (measured units
   * for a channel, per cent for a proportion, events for a count); null or absent is automatic.
   */
  valueMin?: number | null;
  valueMax?: number | null;
  /**
   * A statistic's, or a proportion boxplot's or points', value axis starts at 0; off, it is fitted to
   * the values with headroom. Bars always start at 0; a per-cell axis and a stacked bar ignore it.
   */
  valueFromZero: boolean;
  /**
   * Every panel on one value axis computed over all of them, or each panel on its own; null, as
   * the chart kind draws it unless told: one axis for a per-cell chart, a stacked bar and a
   * statistic with a panel per group, an axis per panel for a proportion boxplot, bars or points
   * and a statistic with a panel per population.
   */
  shareValueAxis: boolean | null;
  /**
   * A per-cell chart's replicate marks: each replicate unit's median or mean of its own cells,
   * taken on linear values, drawn as a point over the pooled violin or box; "none" draws none.
   */
  replicateMarks: "none" | "median" | "mean";
  /**
   * Draw the tick, axis and legend text at the workspace's figure style sizes (figureStyle.ts)
   * instead of `fontTick`, `fontAxis` and `fontLegend`. New charts have it on; a chart saved
   * before it has none.
   */
  followFigureStyle?: boolean;
}

export const PROPORTIONS_NUMERIC_RANGES: Record<string, [number, number]> = {
  fontTick: [5, 20],
  fontAxis: [5, 24],
  fontLegend: [5, 20],
  height: [140, 800],
  pointRadius: [0.5, 5],
  panelsPerRow: [1, 12],
};

/** A set panel width's bounds; 0 means the panel is fitted to its contents. */
export const PANEL_WIDTH_RANGE: [number, number] = [120, 800];

/** The presentation defaults; the workspace-bound fields are filled by `defaultProportionsSettings`. */
export const BASE_PROPORTIONS_SETTINGS: ProportionsSettings = {
  files: [],
  hierarchy: "",
  categoryKind: "population",
  valueKind: "proportion",
  plotType: "stacked",
  channel: "",
  channels: [],
  xAxis: "populations",
  statistic: "median",
  errorBar: "sd",
  test: false,
  comparisons: "overall",
  comparisonsShow: "all",
  proportionValue: "parent",
  panelColumns: "",
  panelRows: "",
  pageBy: "",
  panelsPerRow: 5,
  panelWidth: 0,
  cellRange: "gating",
  violinBox: true,
  parent: "",
  selectedPops: [],
  includeUngated: true,
  groupSel: PROPORTIONS_SAMPLE_FACTOR,
  unitSel: PROPORTIONS_SAMPLE_FACTOR,
  facetSel: PROPORTIONS_NO_FACTOR,
  palette: "paired",
  averagePerUnit: true,
  fontTick: 9,
  fontAxis: 10,
  fontLegend: 11,
  height: 280,
  grid: true,
  points: true,
  paired: false,
  legend: true,
  pointRadius: 2,
  showN: false,
  valueMin: null,
  valueMax: null,
  valueFromZero: true,
  shareValueAxis: null,
  replicateMarks: "none",
};

/** A settings object from anything saved: known fields within range over the defaults given, the rest dropped. */
export function normalizeProportionsSettings(value: unknown, defaults: ProportionsSettings = BASE_PROPORTIONS_SETTINGS): ProportionsSettings {
  const out: ProportionsSettings = { ...defaults, files: [...defaults.files], selectedPops: [...defaults.selectedPops], channels: [...(defaults.channels ?? [])] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const candidate = value as Record<string, unknown>;
  for (const key of ["files", "selectedPops"] as const) {
    const list = candidate[key];
    if (Array.isArray(list) && list.every((entry) => typeof entry === "string")) out[key] = [...list];
  }
  for (const key of ["hierarchy", "parent", "groupSel", "unitSel", "facetSel", "channel"] as const) {
    if (typeof candidate[key] === "string") out[key] = candidate[key] as string;
  }
  out.channels = consistentChannels(candidate.channels, out.channel);
  if (out.channels.length) out.channel = out.channels[0];
  if (candidate.categoryKind === "population" || candidate.categoryKind === "division") out.categoryKind = candidate.categoryKind;
  if (candidate.valueKind === "proportion" || candidate.valueKind === "cells" || candidate.valueKind === "statistic") out.valueKind = candidate.valueKind;
  if (["stacked", "box", "violin", "bar", "dots", "splitViolin", "ridgeline"].includes(candidate.plotType as string)) out.plotType = candidate.plotType as ProportionsSettings["plotType"];
  if (candidate.statistic === "median" || candidate.statistic === "mean" || candidate.statistic === "geomean") out.statistic = candidate.statistic;
  if (candidate.errorBar === "sd" || candidate.errorBar === "sem") out.errorBar = candidate.errorBar;
  if (candidate.proportionValue === "parent" || candidate.proportionValue === "total" || candidate.proportionValue === "count") out.proportionValue = candidate.proportionValue;
  if (PANEL_SHELF_VALUES.includes(candidate.panelColumns as string)) out.panelColumns = candidate.panelColumns as ProportionsSettings["panelColumns"];
  if (PANEL_SHELF_VALUES.includes(candidate.panelRows as string)) out.panelRows = candidate.panelRows as ProportionsSettings["panelRows"];
  if (PANEL_SHELF_VALUES.includes(candidate.pageBy as string)) out.pageBy = candidate.pageBy as ProportionsSettings["pageBy"];
  out.panelWidth = normalizePanelWidth(candidate.panelWidth, out.panelWidth);
  if (candidate.xAxis === "populations" || candidate.xAxis === "groups") out.xAxis = candidate.xAxis;
  if (candidate.cellRange === "gating" || candidate.cellRange === "fit") out.cellRange = candidate.cellRange;
  if (candidate.comparisons === "overall" || candidate.comparisons === "pairwise") out.comparisons = candidate.comparisons;
  if (candidate.comparisonsShow === "all" || candidate.comparisonsShow === "significant") out.comparisonsShow = candidate.comparisonsShow;
  if (candidate.replicateMarks === "none" || candidate.replicateMarks === "median" || candidate.replicateMarks === "mean") out.replicateMarks = candidate.replicateMarks;
  if (OVERLAY_PALETTES.some((palette) => palette.value === candidate.palette)) out.palette = candidate.palette as PaletteName;
  for (const key of ["valueMin", "valueMax"] as const) {
    const limit = candidate[key];
    if (limit === null || (typeof limit === "number" && Number.isFinite(limit))) out[key] = limit;
  }
  if (candidate.shareValueAxis === null || typeof candidate.shareValueAxis === "boolean") out.shareValueAxis = candidate.shareValueAxis;
  for (const key of ["includeUngated", "averagePerUnit", "grid", "points", "paired", "legend", "violinBox", "test", "showN", "valueFromZero"] as const) {
    if (typeof candidate[key] === "boolean") out[key] = candidate[key] as boolean;
  }
  if (typeof candidate.followFigureStyle === "boolean") out.followFigureStyle = candidate.followFigureStyle;
  if (candidate.colourByPopulation === true) out.colourByPopulation = true;
  if (candidate.populationsTogether === true) out.populationsTogether = true;
  for (const [key, [min, max]] of Object.entries(PROPORTIONS_NUMERIC_RANGES)) {
    const number = candidate[key];
    if (typeof number === "number" && Number.isFinite(number)) (out as unknown as Record<string, number>)[key] = Math.max(min, Math.min(max, number));
  }
  return consistentPlotType(out);
}

/**
 * The Plotting settings an Illustration figure's chart plot may carry under their Plotting names:
 * those the figure's grid does not decide. `valueKind`, `plotType`, `statistic` and `violinBox` are
 * the chart's own fields (figure.ts); the files, populations, channel, panel arrangement, size and
 * text sizes are the figure's.
 */
export const FIGURE_CHART_SETTING_KEYS = [
  "xAxis", "errorBar", "test", "comparisons", "comparisonsShow", "proportionValue", "groupSel", "unitSel",
  "palette", "averagePerUnit", "points", "paired", "legend", "pointRadius", "showN", "valueMin", "valueMax",
  "valueFromZero", "shareValueAxis", "replicateMarks", "colourByPopulation", "populationsTogether", "includeUngated", "grid",
] as const;
export type FigureChartSettings = Partial<Pick<ProportionsSettings, (typeof FIGURE_CHART_SETTING_KEYS)[number]>>;

/**
 * The settings of FIGURE_CHART_SETTING_KEYS a figure's chart plot carries, each validated as
 * `normalizeProportionsSettings` validates it; a key absent, invalid or not one of them is left out.
 */
export function figureChartOwnSettings(chart: unknown): FigureChartSettings {
  if (!chart || typeof chart !== "object" || Array.isArray(chart)) return {};
  const held = chart as Record<string, unknown>;
  const unset = Symbol("unset");
  const defaults: Record<string, unknown> = { ...BASE_PROPORTIONS_SETTINGS };
  for (const key of FIGURE_CHART_SETTING_KEYS) defaults[key] = unset;
  const candidate = Object.fromEntries(FIGURE_CHART_SETTING_KEYS.filter((key) => key in held).map((key) => [key, held[key]]));
  const valid = normalizeProportionsSettings(candidate, defaults as unknown as ProportionsSettings) as unknown as Record<string, unknown>;
  return Object.fromEntries(FIGURE_CHART_SETTING_KEYS.filter((key) => valid[key] !== unset).map((key) => [key, valid[key]]));
}

/** What the Columns, Rows and Pages shelves may hold, as saved. */
const PANEL_SHELF_VALUES = ["", "populations", "groups", "facet", "channels"];

/**
 * The channels drawn from anything saved: a list of distinct keys, `channel` first; a save before
 * the list, or a list that does not start with `channel`, takes `channel` alone (or none).
 */
export function consistentChannels(value: unknown, channel: string): string[] {
  const list = Array.isArray(value) ? [...new Set(value.filter((key): key is string => typeof key === "string" && key !== ""))] : [];
  if (list.length && (!channel || list[0] === channel)) return list;
  return channel ? [channel] : [];
}

/** A panel width from anything saved: 0 (fitted) for zero or less, else within PANEL_WIDTH_RANGE; the fallback for anything not a number. */
export function normalizePanelWidth(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  return Math.round(Math.max(PANEL_WIDTH_RANGE[0], Math.min(PANEL_WIDTH_RANGE[1], value)));
}

/** The plot types each value kind draws, its default first. */
export const PLOT_TYPES_BY_VALUE: Record<ProportionsSettings["valueKind"], readonly ProportionsSettings["plotType"][]> = {
  proportion: ["stacked", "box", "bar", "dots"],
  cells: ["violin", "box", "splitViolin", "ridgeline"],
  statistic: ["box", "bar", "dots"],
};

/**
 * The plot type the value kind can draw: a proportion chart is a stacked bar, a boxplot, bars or points, a
 * per-cell chart a violin, a split violin, a boxplot or ridgelines, a statistic chart a boxplot, bars or points. A mismatch,
 * from a hand-edited file or a settings object put together from parts, takes the kind's first type.
 */
export function consistentPlotType(settings: ProportionsSettings): ProportionsSettings {
  const allowed = PLOT_TYPES_BY_VALUE[settings.valueKind];
  return allowed.includes(settings.plotType) ? settings : { ...settings, plotType: allowed[0] };
}
