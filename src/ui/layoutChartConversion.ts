// layoutChartConversion.ts — a Layout summary chart (recipe kind `chart`) as the Plotting chart
// that draws the same values: the population within its parent, one point per file, grouped by the
// same metadata column, as the same plot type with the same test. The Layout tab's quick start
// builds a new chart the same way, from a population, a statistic and a grouping.

import type { LayoutChartRecipe, LayoutChartStatistic, LayoutProportionsRecipe } from "../engine/layout";
import type { PopulationMap } from "../engine/models";
import {
  BASE_PROPORTIONS_SETTINGS,
  PROPORTIONS_NO_FACTOR,
  PROPORTIONS_NUMERIC_RANGES,
  PROPORTIONS_SAMPLE_FACTOR,
  type ProportionsSettings,
} from "../engine/proportionsSettings";

/** The tree the chart's population was chosen in: its id, populations and root. */
export interface ChartTree {
  id: string;
  populations: PopulationMap;
  root_population_id: string | null;
}

const PLOT_TYPES: Record<LayoutChartRecipe["chartType"], ProportionsSettings["plotType"]> = {
  bars: "bar",
  dots: "dots",
  box: "box",
};

const VALUES: Record<Exclude<LayoutChartStatistic, "median">, ProportionsSettings["proportionValue"]> = {
  percent_of_parent: "parent",
  percent_of_total: "total",
  count: "count",
};

/** A font size within the Plotting chart's bounds for it. */
const within = (key: "fontTick" | "fontAxis", value: number) =>
  Math.max(PROPORTIONS_NUMERIC_RANGES[key][0], Math.min(PROPORTIONS_NUMERIC_RANGES[key][1], value));

/**
 * The Plotting chart's settings for a summary chart. The files are fixed as they are drawn now:
 * every file, or the files checked. The population is the one category, within its parent with
 * the rest of the parent counted, so its share is its percent of parent. Each file is its own
 * replicate unit; with no grouping column, each file is its own group, as the summary chart draws
 * it. A median is the statistic chart's median of the channel in each file's cells.
 */
export function chartPlottingSettings(
  recipe: LayoutChartRecipe,
  tree: ChartTree,
  fileIds: { all: readonly string[]; checked: readonly string[] },
  fonts?: { fontTick: number; fontAxis: number },
): ProportionsSettings {
  const population = tree.populations[recipe.populationId];
  const rootId = tree.root_population_id ?? "";
  const files = recipe.files === "all" ? [...fileIds.all] : fileIds.all.filter((id) => fileIds.checked.includes(id));
  const median = recipe.statistic === "median";
  return {
    ...BASE_PROPORTIONS_SETTINGS,
    files,
    hierarchy: tree.id,
    categoryKind: "population",
    valueKind: median ? "statistic" : "proportion",
    plotType: PLOT_TYPES[recipe.chartType],
    channel: median ? recipe.channel ?? "" : "",
    xAxis: "groups",
    statistic: "median",
    errorBar: "sd",
    test: recipe.test && !!recipe.groupBy,
    proportionValue: recipe.statistic === "median" ? "parent" : VALUES[recipe.statistic],
    parent: population?.parent_id ?? rootId,
    selectedPops: [recipe.populationId],
    includeUngated: true,
    groupSel: recipe.groupBy || PROPORTIONS_SAMPLE_FACTOR,
    unitSel: PROPORTIONS_SAMPLE_FACTOR,
    facetSel: PROPORTIONS_NO_FACTOR,
    points: recipe.chartType === "dots" ? true : recipe.showPoints,
    // The summary chart names its groups under the axis and has no legend.
    legend: false,
    ...(fonts ? { fontTick: within("fontTick", fonts.fontTick), fontAxis: within("fontAxis", fonts.fontAxis) } : {}),
  };
}

/**
 * A summary chart block's recipe as a Plotting chart block's, its title kept. The block draws the
 * population's panel alone, as the summary chart drew it: the chart also counts the rest of the
 * parent, for the share of the parent, which has a panel of its own on the Plotting tab.
 */
export function chartToPlottingRecipe(
  recipe: LayoutChartRecipe,
  tree: ChartTree,
  fileIds: { all: readonly string[]; checked: readonly string[] },
  fonts?: { fontTick: number; fontAxis: number },
): LayoutProportionsRecipe {
  return {
    kind: "proportions",
    settings: chartPlottingSettings(recipe, tree, fileIds, fonts),
    ...(recipe.title ? { title: recipe.title } : {}),
    panel: { populationId: recipe.populationId, population: tree.populations[recipe.populationId]?.name ?? "" },
    textSize: "sheet",
  };
}

/**
 * The quick start's chart: one population of the file it was chosen on, one statistic, grouped by
 * a metadata column (or each file its own group), as bars of the mean with each file a point and
 * the rank test between the groups, as "+ Chart" made it before.
 */
export function quickStartPlottingRecipe(
  choice: { sampleId: string; populationId: string; statistic: Exclude<LayoutChartStatistic, "median">; groupBy: string },
  tree: ChartTree,
  fileIds: { all: readonly string[]; checked: readonly string[] },
  fonts?: { fontTick: number; fontAxis: number },
): LayoutProportionsRecipe {
  return chartToPlottingRecipe(
    { kind: "chart", ...choice, files: "checked", chartType: "bars", showPoints: true, test: true },
    tree,
    fileIds,
    fonts,
  );
}
