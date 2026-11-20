// plottingHeatmapModel.ts — the Plotting tab's summary heatmap, built as the Illustration tab builds its
// own: a heatmap plot of the chart's channels, a panel per population in each replicate unit, each
// panel summarised by buildFigurePanel and the panels laid into one matrix by buildHeatmapMatrix.
// The two tabs therefore give the same numbers for the same files, populations and channels.
//
// Rows: each population (in the order the chart lists them) in each replicate unit; a unit is a
// file, or the files sharing the unit column's value, pooled. With a Groups factor the units are
// ordered by group. Columns: the chart's channels, in the order chosen.

import {
  buildFigurePanel,
  captureFigureTransforms,
  migrateFigure,
  type FigurePage,
  type FigurePanel,
  type FigurePanelData,
  type FigurePlot,
  type FigurePopulation,
  type FigureSample,
  type FigureSource,
  type FigureSpec,
} from "../engine/figure";
import { buildHeatmapMatrix, type HeatmapMatrix } from "../engine/figureHeatmap";
import { defaultIllustrationConfig, figureStyle } from "../engine/figureDefaults";
import { resolvePerSampleValue, type PerSampleFactor } from "../engine/factors";
import { SAMPLE_ID_FIELD, sampleDisplayId } from "../engine/metadata";
import { fileListOrder } from "../engine/levelOrder";
import { PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "../engine/proportionsSettings";
import type { StoredHierarchy } from "../engine/hierarchies";
import type { IllustrationConfig } from "../engine/workspace";
import { plottingFactorLevels, type ColumnLevels } from "./plottingColours";

type Metadata = Readonly<Record<string, Readonly<Record<string, string>> | undefined>>;

/** A row's replicate unit: its files, pooled, and the group it is drawn under. */
export interface HeatmapUnit {
  key: string;
  label: string;
  group: string;
  files: string[];
}

const factorSpec = (factor: string): PerSampleFactor =>
  factor === PROPORTIONS_NO_FACTOR || factor === PROPORTIONS_SAMPLE_FACTOR ? { kind: "sample" } : { kind: "metadata", field: factor };

/** A file's value of a Group or Replicate unit picker's factor, as the Plotting models resolve it. */
function fileFactorValue(factor: string, entry: { id: string; name: string }, metadata: Metadata): string {
  const row = { ...metadata[entry.id], [SAMPLE_ID_FIELD]: sampleDisplayId(entry.name, metadata[entry.id]) };
  return resolvePerSampleValue(factorSpec(factor), entry.name, row);
}

/**
 * The replicate units of the chart's files: a file each, or the files sharing the unit column's
 * value pooled; ordered by group (in the order the charts draw the groups), then by the unit's
 * first file in the file list. A unit whose files fall in two groups is a unit in each.
 */
export function plottingHeatmapUnits(
  settings: Pick<ProportionsSettings, "files" | "unitSel" | "groupSel">,
  files: readonly { id: string; name: string }[],
  metadata: Metadata,
  columnLevels?: ColumnLevels,
): HeatmapUnit[] {
  const grouped = settings.groupSel !== PROPORTIONS_NO_FACTOR && settings.groupSel !== PROPORTIONS_SAMPLE_FACTOR;
  const pooled = settings.unitSel !== PROPORTIONS_NO_FACTOR && settings.unitSel !== PROPORTIONS_SAMPLE_FACTOR;
  const units = new Map<string, HeatmapUnit>();
  for (const entry of fileListOrder(files, settings.files)) {
    const group = grouped ? fileFactorValue(settings.groupSel, entry, metadata) : "";
    const label = pooled ? fileFactorValue(settings.unitSel, entry, metadata) : entry.name;
    const key = JSON.stringify([group, pooled ? label : entry.id]);
    const unit = units.get(key) ?? { key, label, group, files: [] };
    unit.files.push(entry.id);
    units.set(key, unit);
  }
  if (!grouped) return [...units.values()];
  const order = plottingFactorLevels(settings, settings.groupSel, files, metadata, columnLevels);
  return [...units.values()].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/**
 * The populations the heatmap draws, as the Plotting tab reads its selection: the ticked
 * populations beneath the parent, in tree order.
 */
export function plottingHeatmapPopulationIds(
  settings: Pick<ProportionsSettings, "parent" | "selectedPops">,
  tree: Pick<StoredHierarchy, "populations" | "root_population_id">,
): string[] {
  const parent = tree.populations[settings.parent] ? settings.parent : tree.root_population_id ?? "";
  const beneath: string[] = [];
  const walk = (id: string) => {
    for (const child of tree.populations[id]?.children ?? []) {
      if (!tree.populations[child]) continue;
      beneath.push(child);
      walk(child);
    }
  };
  walk(parent);
  const ticked = new Set(settings.selectedPops);
  const within = beneath.filter((id) => ticked.has(id));
  // As the tab's own rule: nothing ticked draws nothing; ticks saved against another parent read
  // as the parent's children.
  return within.length || !settings.selectedPops.length ? within : (tree.populations[parent]?.children ?? []).filter((id) => tree.populations[id]);
}

/** The heatmap's one plot: every channel of the chart, a column each. */
export function plottingHeatmapPlot(channels: readonly string[]): FigurePlot {
  return { id: "plotting-heatmap", name: "Summary heatmap", x: channels[0] ?? "", y: channels[0] ?? "", type: "heatmap", channels: [...channels] };
}

/**
 * The figure the panels are built under: the chart's files pooled within a panel, the channels'
 * display transforms captured from the files as an Illustration figure captures them.
 */
export function plottingHeatmapFigure(
  samples: readonly FigureSample[],
  trees: Record<string, StoredHierarchy>,
  hierarchyId: string,
  populations: readonly FigurePopulation[],
  plot: FigurePlot,
): FigureSpec {
  const base = migrateFigure(null, samples, trees, hierarchyId, plot.x, plot.y);
  return captureFigureTransforms(
    {
      ...base,
      sampleIds: samples.map((s) => s.id),
      populations: [...populations],
      plots: [plot],
      rows: ["populations", "plots"],
      columns: ["samples"],
      pages: [],
      composition: "pool",
    },
    samples,
  );
}

/** The panels and the page they make: a panel per population in each unit, population by population. */
export function plottingHeatmapPage(
  units: readonly HeatmapUnit[],
  populations: readonly FigurePopulation[],
  plot: FigurePlot,
): FigurePage {
  const panels: FigurePanel[] = populations.flatMap((population, p) =>
    units.map((unit, u) => ({
      key: JSON.stringify([population.hierarchyId, population.populationId, unit.key]),
      samples: unit.files,
      population,
      plot,
      row: p * units.length + u,
      column: 0,
    })),
  );
  return {
    key: "plotting-heatmap",
    label: "",
    rows: panels.map((panel) => [{ dimension: "populations", id: panel.key, label: panel.population.label }]),
    columns: [[{ dimension: "plots", id: plot.id, label: plot.name }]],
    panels,
  };
}

/** The Illustration config the heatmap engine and its drawing read, from the chart's settings. */
export function plottingHeatmapConfig(settings: ProportionsSettings, fonts: { fontTick: number; fontAxis: number }): IllustrationConfig {
  return {
    ...defaultIllustrationConfig(),
    heatmapStat: settings.statistic === "mean" ? "mean" : "median",
    heatmapScale: settings.heatmapScale,
    heatmapPalette: settings.heatmapPalette,
    heatmapClusterRows: settings.heatmapClusterRows,
    heatmapClusterColumns: settings.heatmapClusterColumns,
    heatmapShowValues: settings.heatmapShowValues,
    heatmapCellSize: settings.heatmapCellSize,
    fontTick: fonts.fontTick,
    fontAxis: fonts.fontAxis,
    fontTitle: fonts.fontAxis,
  };
}

/** One panel's summaries: every channel of the plot over the panel's population in its unit's files, pooled. */
export function buildPlottingHeatmapPanel(
  panel: FigurePanel,
  figure: FigureSpec,
  sources: readonly FigureSource[],
  trees: Record<string, StoredHierarchy>,
  config: IllustrationConfig,
): FigurePanelData {
  return buildFigurePanel(panel, figure, sources as FigureSource[], trees, figureStyle(config, true), {}, true);
}

/**
 * The matrix of the built panels, its rows named by population and, with more than one unit, by
 * unit ("CD4_positive · D1"): a pooled unit is named by its value, not by its files.
 */
export function plottingHeatmapMatrix(
  page: FigurePage,
  units: readonly HeatmapUnit[],
  data: Record<string, FigurePanelData>,
  config: IllustrationConfig,
): HeatmapMatrix | null {
  const matrix = buildHeatmapMatrix(page, data, config);
  if (!matrix) return null;
  const unitOf = new Map(page.panels.map((panel) => [`${panel.population.hierarchyId}|${panel.population.populationId}|${panel.samples.join(",")}`, units[panel.row % units.length]]));
  const named = matrix.rows.map((row) => {
    const unit = unitOf.get(row.key);
    const population = page.panels.find((panel) => `${panel.population.hierarchyId}|${panel.population.populationId}|${panel.samples.join(",")}` === row.key)?.population.label ?? row.label;
    return { ...row, label: units.length > 1 && unit ? `${population} · ${unit.label}` : population };
  });
  return { ...matrix, rows: named };
}

/** The heatmap's table: a row per heatmap row in drawing order, each channel's statistic, then the row's events. */
export function heatmapDataTable(matrix: HeatmapMatrix | null): { header: string[]; rows: (string | number)[][] } {
  if (!matrix) return { header: [], rows: [] };
  const columns = matrix.columnOrder.map((c) => matrix.columns[c]);
  return {
    header: ["Row", ...columns.map((column) => `${column.label} (${matrix.stat})`), "Events"],
    rows: matrix.rowOrder.map((r) => [
      matrix.rows[r].label,
      ...matrix.columnOrder.map((c) => (matrix.raw[r][c] === null ? "" : Number((matrix.raw[r][c] as number).toPrecision(6)))),
      matrix.rows[r].count,
    ]),
  };
}
