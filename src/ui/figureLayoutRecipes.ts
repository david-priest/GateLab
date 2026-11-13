// figureLayoutRecipes.ts — an Illustration figure's panels as Layout plots: the conversion the
// Illustration tab's "Add … to the Layout tab" and the Layout tab's "Add Illustration selection"
// both use, so a panel arrives as the same plot from either.

import { resolveFigurePopulation, type FigurePanel, type FigureSpec, type FigureValue } from "../engine/figure";
import type { StoredHierarchy } from "../engine/hierarchies";
import type { LayoutDisplayMode, LayoutPlotRecipe, LayoutProportionsRecipe } from "../engine/layout";
import type { IllustrationConfig } from "../engine/workspace";
import { BASE_PROPORTIONS_SETTINGS, figureChartOwnSettings, PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "../engine/proportionsSettings";

/** Layout plots for these panels: one per file and plot of each, the population followed into the file's tree. */
export function figureLayoutRecipes(
  targets: readonly FigurePanel[],
  figure: FigureSpec,
  config: IllustrationConfig,
  /** A panel's file as prepared, with its tree; undefined for a file not available. */
  sourceOf: (sampleId: string) => { tree: StoredHierarchy } | undefined,
  trees: Record<string, StoredHierarchy>,
): LayoutPlotRecipe[] {
  const recipes: LayoutPlotRecipe[] = [];
  const layoutFontScale = config.scaleFontsWithPlot ? figure.panelSize / 280 : 1;
  for (const panel of targets) {
    if (panel.plot.type === "heatmap" || panel.plot.type === "chart") continue;
    const perFile: { sampleId: string; populationId: string; populationIds?: string[] }[] = [];
    for (const sampleId of panel.samples) {
      const source = sourceOf(sampleId);
      if (!source) continue;
      const resolved = resolveFigurePopulation(panel.population, source.tree, trees);
      const populationId = resolved.id ?? source.tree.root_population_id;
      if (!populationId) continue;
      // A panel overlaying populations is one plot of them there, each followed into the file's tree.
      const overlaid = panel.populations && panel.populations.length > 1
        ? panel.populations.flatMap((ref) => resolveFigurePopulation(ref, source.tree, trees).id ?? [])
        : [];
      perFile.push(overlaid.length > 1 ? { sampleId, populationId: overlaid[0], populationIds: overlaid } : { sampleId, populationId });
    }
    const recipe = (file: { sampleId: string; populationId: string; populationIds?: string[] }): LayoutPlotRecipe => ({
      kind: panel.plot.type as "biplot" | "histogram",
      sampleId: file.sampleId,
      populationId: file.populationId,
      ...(file.populationIds ? { populationIds: file.populationIds } : {}),
      xChannel: panel.plot.x,
      yChannel: panel.plot.type === "histogram" ? null : panel.plot.y,
      displayMode: (figure.composition === "overlay" ? "scatter" : config.displayMode) as LayoutDisplayMode,
      // Overlaid histograms fill where they overlap as they do here.
      ...(panel.plot.type === "histogram" ? { histOverlayMode: config.histOverlayMode === "blend" ? "blend" as const : "front_opaque" as const } : {}),
      // Titled by the sheet's template there; the plot carries its name here for {plot}, so a
      // heading reads there as it does here.
      ...(panel.plot.name ? { label: panel.plot.name } : {}),
      // Drawn there as here: this figure's style, as the plot's own. Fields the sheet already
      // has are dropped when it is placed, so the sheet's Style still reaches the rest.
      style: {
        pointSize: config.pointSize,
        pointAlpha: config.pointAlpha,
        maxEvents: config.allEvents ? 0 : config.maxEvents,
        contourThreshold: config.contourThreshold,
        ...(config.contourLevels !== undefined ? { contourLevels: config.contourLevels } : {}),
        kdeBandwidth: config.kdeBandwidth,
        gateLineWidth: config.gateLineWidth,
        pubStyle: config.pubStyle,
        gateLabels: config.gateLabelFormat ?? "name-percent",
        histLineWidth: config.histLineWidth,
        histFill: config.histFill,
        histFillAlpha: config.histFillAlpha,
        // The sizes the panels are drawn with here (styledFigurePlot): scaled with the panel when
        // the figure scales its fonts, since the Layout plot draws its fonts as given.
        fontTick: config.fontTick * layoutFontScale,
        fontAxis: config.fontAxis * layoutFontScale,
        fontTitle: config.fontTitle * layoutFontScale,
        fontGate: config.fontGate * layoutFontScale,
      },
    });
    // A pooled panel is one pooled plot there, its first file the reference; otherwise one
    // plot per file.
    if (figure.composition === "pool" && perFile.length > 1) {
      recipes.push({ ...recipe(perFile[0]), pool: { sampleIds: perFile.map((file) => file.sampleId) } });
    } else {
      for (const file of perFile) recipes.push(recipe(file));
    }
  }
  return recipes;
}

/** The populations' nearest common ancestor in their tree, the root when they share no other. */
function commonAncestor(tree: StoredHierarchy | undefined, ids: readonly string[]): string {
  const root = tree?.root_population_id ?? "";
  if (!tree) return root;
  const ancestors = (id: string) => {
    const out: string[] = [];
    let at = tree.populations[id]?.parent_id ?? null;
    while (at && tree.populations[at] && !out.includes(at)) {
      out.push(at);
      at = tree.populations[at].parent_id ?? null;
    }
    return out;
  };
  const chains = ids.map(ancestors);
  return chains[0]?.find((id) => !ids.includes(id) && chains.every((chain) => chain.includes(id))) ?? root;
}

/**
 * What a chart panel draws, as Plotting's settings: its files and tree, its populations and their
 * parent, the value it takes and how its files are grouped, the settings that say how it is drawn
 * at Plotting's defaults. A per-cell or statistic chart's files are one group, as the panel draws
 * them: the panel's value of a metadata column where it is one, else one group without a name. A
 * composition draws a bar per file. A summary panel's files run along x as groups, a group per file
 * or per value of the metadata column it groups them by. A population on another tree than the
 * first's is followed into the first's tree by provenance; one with no counterpart there is left
 * out (`populations` holds null for it). A statistic is a box with three files or more, else
 * points; a summary's, a box per group of files, else a point per file. figureChartRecipe and the
 * figure's panel (buildFigureChartPanel) both build on it.
 */
export function figureChartDataSettings(
  panel: FigurePanel,
  available: (sampleId: string) => boolean,
  trees: Record<string, StoredHierarchy>,
): { settings: ProportionsSettings; populations: (string | null)[]; metadataField?: string; grouped: boolean } | null {
  const chart = panel.plot.chart;
  if (panel.plot.type !== "chart" || !chart) return null;
  const files = panel.samples.filter(available);
  const refs = panel.populations?.length ? panel.populations : [panel.population];
  if (!files.length || !refs.length) return null;
  let metadataField: string | undefined;
  try {
    metadataField = (JSON.parse(panel.key) as FigureValue[]).find((value) => value.dimension.startsWith("metadata:"))?.dimension.slice(9);
  } catch {
    metadataField = undefined;
  }
  const hierarchy = refs[0].hierarchyId;
  const first = trees[hierarchy];
  const populations = refs.map((ref) =>
    ref.hierarchyId === hierarchy ? ref.populationId : first ? resolveFigurePopulation(ref, first, trees).id ?? null : null,
  );
  const populationIds = populations.filter((id): id is string => id !== null);
  // A summary panel: its files along x, a group per file, or per value of the metadata column its cells are grouped by.
  const grouped = !!panel.cells?.some((cell) => cell.group !== undefined);
  const summaryField = grouped ? metadataField : undefined;
  const settings: ProportionsSettings = {
    ...BASE_PROPORTIONS_SETTINGS,
    files,
    hierarchy,
    categoryKind: "population",
    valueKind: chart.valueKind,
    plotType: chart.valueKind === "statistic" ? ((panel.span ? grouped : files.length >= 3) ? "box" : "dots") : chart.plotType,
    channel: chart.valueKind === "proportion" ? "" : panel.plot.x,
    xAxis: panel.span && chart.valueKind !== "proportion" ? "groups" : "populations",
    // A summary draws every population side by side at each of its places, in one panel.
    ...(panel.span && chart.valueKind !== "proportion" ? { populationsTogether: true } : {}),
    statistic: chart.statistic ?? "median",
    parent: chart.valueKind === "proportion" ? commonAncestor(first, populationIds) : "",
    selectedPops: populationIds,
    includeUngated: chart.valueKind === "proportion",
    groupSel: panel.span
      ? summaryField ?? PROPORTIONS_SAMPLE_FACTOR
      : chart.valueKind === "proportion" ? PROPORTIONS_SAMPLE_FACTOR : metadataField ?? PROPORTIONS_NO_FACTOR,
    unitSel: PROPORTIONS_SAMPLE_FACTOR,
    averagePerUnit: false,
  };
  return { settings, populations, ...(metadataField !== undefined ? { metadataField } : {}), grouped };
}

/**
 * A chart panel as a Plotting chart block of one panel: the panel's files and populations, the
 * plot's chart (figureChartDataSettings), drawn at the panel's width with the figure's fonts, no
 * legend and no title. A summary panel is as wide as the cells it spans.
 */
export function figureChartRecipe(
  panel: FigurePanel,
  figure: FigureSpec,
  config: IllustrationConfig,
  available: (sampleId: string) => boolean,
  trees: Record<string, StoredHierarchy>,
  /**
   * The value axis's range the figure drew the panel on, in measured units, when its axes are
   * shared: the block keeps it, so a row of blocks compares as the panels did. Unset, it fits its own.
   */
  valueRange?: readonly [number, number],
): LayoutProportionsRecipe | null {
  const chart = panel.plot.chart;
  const data = figureChartDataSettings(panel, available, trees);
  if (!chart || !data) return null;
  const own = figureChartOwnSettings(chart);
  const fontScale = config.scaleFontsWithPlot ? figure.panelSize / 280 : 1;
  // As wide as the cells a summary spans (the Layout grid's frames are the panel and an 8 px
  // inset, 12 px apart: addPlotsToSheet).
  const spanWidth = panel.span ? panel.span.columns * figure.panelSize + (panel.span.columns - 1) * 20 : figure.panelSize;
  const settings: ProportionsSettings = {
    ...data.settings,
    panelColumns: "",
    panelsPerRow: 1,
    panelWidth: spanWidth,
    cellRange: figure.scalePolicy === "individual" ? "fit" : "gating",
    violinBox: chart.violinBox !== false,
    fontTick: Math.round(config.fontTick * fontScale),
    fontAxis: Math.round(config.fontAxis * fontScale),
    grid: false,
    legend: false,
    // The settings the chart carries, as the figure draws it with them.
    ...own,
    ...(valueRange ? { valueMin: own.valueMin ?? valueRange[0], valueMax: own.valueMax ?? valueRange[1] } : {}),
  };
  // Drawn at its frame's size, the grid cell's, with the sheet's text sizes.
  return { kind: "proportions", settings, panel: {}, textSize: "sheet", ...(panel.plot.name ? { title: panel.plot.name } : {}) };
}
