// layoutSources.ts — where a Layout block's data comes from: its files, populations, channels,
// the value it shows, the replicate unit and n per group, the centre and spread drawn, and the
// test with its p values. Each description is read from the models the block draws from (the
// plot's counts, a Plotting chart's cached models, the old chart's data), never counted another
// way. The inspector, the sheet's hover note, the source placeholders of titles and text, and the
// generated legend all read these descriptions.

import { figureHierarchies, resolvePopulationInTree, type FigureSample } from "../engine/figure";
import type { DivisionProfileLike } from "../engine/factors";
import { followsIteration, type LayoutChartRecipe, type LayoutFigureRecipe, type LayoutItem, type LayoutPlotRecipe, type LayoutProportionsPanel, type LayoutProportionsRecipe, type LayoutStrategyRecipe } from "../engine/layout";
import type { DescribeBoundPlot } from "../engine/layoutBatch";
import { SAMPLE_ID_FIELD } from "../engine/metadata";
import { perUnitProps } from "../engine/proportions";
import { proportionsPopulations } from "../engine/proportionsModel";
import { PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR } from "../engine/proportionsSettings";
import type { CoreState } from "../store";
import { chartData, type ChartSource } from "./LayoutChart";
import { plottingBlockModels } from "./LayoutProportions";
import { chartPageDimension, matchingPanels, onlyPanelText, pageAsPanels, panelDimensionText, selectorPage } from "./panelArrangement";
import { divisionWithinName, proportionsFactorTitle, proportionsValueTitle } from "./PlottingTab";
import { statisticChartFrame, statisticTitle } from "./StatisticChart";
import { comparisonDescription, comparisonPaired, shownComparisons, type PanelComparison, type PanelOverallTest } from "./chart/chartComparisons";
import { proportionPanelTests } from "./ProportionsChart";
import { columnValueOrder } from "../engine/levelOrder";
import { cellPanels, cellReplicateFrame } from "./CellValuesChart";
import { chartXAxis } from "./chart/chartXAxis";

/** A group of a chart and how many replicate units (or cells, or files) it holds, per population where the chart has several. */
export interface SourceGroup {
  label: string;
  /** The population, where the block shows more than one. */
  population?: string;
  n: number;
}

/** A test drawn on the block: in which panel, which test, and its p. */
export interface SourceTest {
  panel: string;
  name: PanelOverallTest["name"];
  p: number;
}

/** A pair of groups compared on the block, drawn as a bracket: in which panel, which test, and its Holm-adjusted p. */
export interface SourceComparison {
  panel: string;
  groupA: string;
  groupB: string;
  name: PanelComparison["test"];
  p: number;
  pAdjusted: number;
}

export type BlockSourceKind = "plot" | "overlay" | "pool" | "strategy" | "figure" | "proportion" | "cells" | "statistic" | "chart" | "legend";

/** What a block shows and where its data comes from. */
export interface BlockSource {
  kind: BlockSourceKind;
  /** What it shows, as a phrase that starts a sentence: "Median CD4 (FITC-A) of CD4_positive cells per file". */
  shows: string;
  /** The files it draws, by name. */
  files: string[];
  populations: string[];
  /** The channels, by label. */
  channels: string[];
  /** Each population's events, aligned with `populations`, for a plot or strategy. */
  counts?: number[];
  /** The value drawn, for a chart: "% of CD3_positive", "Median CD4 (FITC-A)". */
  value?: string;
  /** The statistic taken, in words: "median", "mean", "percentage", "event count". */
  statistic?: string;
  /** What n counts, plural: "files", "donors", "cells", "events". */
  unit?: string;
  /** What the groups are: a metadata column's name, "File". */
  groupTitle?: string;
  groups?: SourceGroup[];
  /** The centre and spread drawn, as a sentence. */
  centre?: string;
  /** The tests drawn; empty when asked for and none could be made. */
  tests?: SourceTest[];
  /** A test was asked for. */
  testAsked?: boolean;
  /** The pairs compared and drawn as brackets, with pairwise comparisons on. */
  comparisons?: SourceComparison[];
  /** What the tests test and on what (comparisonDescription), where they are pairwise or paired; unset otherwise. */
  testDescription?: string;
  /** The block is drawn for each unit of the sheet's iteration. */
  follows: boolean;
  /** The block is one panel of a chart: which. */
  panel?: string;
  /** The block is one page of a chart with pages: which, as the tab's pager names it. */
  page?: string;
}

/** What a description is read from: the app's files, their prepared views, the gating, and the plot describer the titles use. */
export interface BlockSourceContext {
  files: readonly FigureSample[];
  samples: readonly ChartSource[];
  state: CoreState;
  metadataById: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>;
  checkedSampleIds: readonly string[];
  divisionProfiles: Readonly<Record<string, DivisionProfileLike>>;
  dataRevision: string | number;
  describePlot: DescribeBoundPlot;
}

/** A block as placed on a page: the bound recipe, and the file it was designed on when drawn for another. */
export type SourceItem = LayoutItem & { templateSampleId?: string; unitId?: string };

const BOX_UNITS = (unit: string) =>
  `Boxes show the median and quartiles of the ${unit}; whiskers extend to the most extreme ${singular(unit)} within 1.5 times the interquartile range.`;

function singular(unit: string): string {
  if (unit === "cells") return "cell";
  if (unit === "files") return "file";
  if (unit === "events") return "event";
  return unit.endsWith("s") ? unit.slice(0, -1) : unit;
}

/** What the replicate unit is called, singular and plural: a file, a sample, or a metadata column's value. */
export function unitNoun(unitSel: string): { one: string; many: string } {
  if (unitSel === PROPORTIONS_SAMPLE_FACTOR || unitSel === PROPORTIONS_NO_FACTOR) return { one: "file", many: "files" };
  if (unitSel === SAMPLE_ID_FIELD) return { one: "sample", many: "samples" };
  if (/^[A-Za-z][A-Za-z ]*$/.test(unitSel)) {
    const one = unitSel.trim().toLowerCase();
    return { one, many: one.endsWith("s") ? one : `${one}s` };
  }
  return { one: `unit of ${unitSel}`, many: `units of ${unitSel}` };
}

/** Names joined as a sentence lists them: "A", "A and B", "A, B and C". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const count = (n: number) => n.toLocaleString("en-US");

function fileNamer(ctx: BlockSourceContext) {
  return (id: string) => {
    const file = ctx.files.find((entry) => entry.id === id);
    return file ? file.fileName ?? file.name : ctx.samples.find((entry) => entry.id === id)?.name ?? id;
  };
}

function plotSource(item: SourceItem, recipe: LayoutPlotRecipe, ctx: BlockSourceContext): BlockSource {
  const context = ctx.describePlot(recipe, item.templateSampleId, item.unitId);
  const view = ctx.samples.find((entry) => entry.id === recipe.sampleId) ?? null;
  const name = fileNamer(ctx);
  const pool = recipe.pool && recipe.pool.sampleIds.length > 1 ? recipe.pool.sampleIds : null;
  const files = (pool ?? [recipe.sampleId]).map(name);
  const label = (key: string) => (view ? view.sample.labelForKey(key) : key);
  const channels = [recipe.xChannel, ...(recipe.kind === "biplot" && recipe.yChannel ? [recipe.yChannel] : [])].filter(Boolean).map(label);
  // The populations as describePlot finds them, so a count is the one the title's {count} reads.
  let populations: string[] = context?.population ? [context.population] : [];
  let counts: number[] | undefined = typeof context?.count === "number" ? [context.count] : undefined;
  if (recipe.populationIds && recipe.populationIds.length > 1 && view && context?.counts?.length) {
    const trees = figureHierarchies(ctx.state);
    const templateTreeId = item.templateSampleId && item.templateSampleId !== recipe.sampleId ? ctx.samples.find((entry) => entry.id === item.templateSampleId)?.tree.id : undefined;
    populations = recipe.populationIds.flatMap((asked) => {
      const found = resolvePopulationInTree(asked, view.tree, trees, templateTreeId);
      const named = found.missing ? undefined : view.tree.populations[found.id];
      return named ? [named.name] : [];
    });
    counts = [...context.counts];
  }
  const what = recipe.kind === "histogram" ? `Histogram of ${channels[0] ?? "a channel"}` : `${channels[0] ?? "X"} against ${channels[1] ?? "Y"}`;
  const kind: BlockSourceKind = populations.length > 1 ? "overlay" : pool ? "pool" : "plot";
  const where = pool ? `${files.length} files pooled` : files[0] ?? "";
  const populationsPart = populations.length > 1 ? `${listWords(populations)} overlaid` : `${populations[0] ?? "the population"} cells`;
  return {
    kind,
    shows: `${what} of ${populationsPart}${where ? ` in ${where}` : ""}`,
    files,
    populations,
    channels,
    ...(counts ? { counts } : {}),
    unit: "events",
    follows: followsIteration(item),
  };
}

function strategySource(item: SourceItem, recipe: LayoutStrategyRecipe, ctx: BlockSourceContext): BlockSource {
  const view = ctx.samples.find((entry) => entry.id === recipe.sampleId) ?? null;
  const name = fileNamer(ctx);
  const trees = figureHierarchies(ctx.state);
  const templateTreeId = item.templateSampleId && item.templateSampleId !== recipe.sampleId ? ctx.samples.find((entry) => entry.id === item.templateSampleId)?.tree.id : undefined;
  const asked = recipe.populationIds?.length ? recipe.populationIds : [recipe.populationId];
  const found = view
    ? asked.flatMap((id) => {
        const resolved = resolvePopulationInTree(id, view.tree, trees, templateTreeId);
        const population = resolved.missing ? undefined : view.tree.populations[resolved.id];
        return population ? [{ name: population.name, count: view.derived.stats.event_count[resolved.id] ?? 0 }] : [];
      })
    : [];
  const file = name(recipe.sampleId);
  return {
    kind: "strategy",
    shows: `Gating steps leading to ${listWords(found.map((entry) => entry.name)) || "the population"} in ${file}`,
    files: [file],
    populations: found.map((entry) => entry.name),
    channels: [],
    counts: found.map((entry) => entry.count),
    unit: "events",
    follows: followsIteration(item),
  };
}

function figureSource(item: SourceItem, recipe: LayoutFigureRecipe, ctx: BlockSourceContext): BlockSource {
  const spec = recipe.illustration.figure;
  const name = fileNamer(ctx);
  const files = (spec?.sampleIds ?? []).filter((id) => ctx.files.some((entry) => entry.id === id) || ctx.samples.some((entry) => entry.id === id)).map(name);
  const populations = [...new Set((spec?.populations ?? []).map((population) => population.label).filter(Boolean))];
  const label = (key: string) => {
    const file = ctx.files.find((entry) => spec?.sampleIds.includes(entry.id));
    return file ? file.sample.labelForKey(key) : key;
  };
  const plots = spec?.plots ?? [];
  const channels = [...new Set(plots.flatMap((plot) => [plot.x, plot.type === "biplot" ? plot.y : ""]).filter(Boolean))].map(label);
  const kinds = [...new Set(plots.map((plot) => (plot.type === "histogram" ? "histograms" : plot.type === "heatmap" ? "heatmaps" : "biplots")))];
  const composition = spec?.composition === "pool" ? ", files pooled" : spec?.composition === "overlay" ? ", files overlaid" : "";
  return {
    kind: "figure",
    shows: `${kinds.length ? listWords(kinds).replace(/^./, (c) => c.toUpperCase()) : "Plots"} of ${listWords(populations) || "the populations"} in ${files.length === 1 ? files[0] : `${files.length} files`}${composition}`,
    files,
    populations,
    channels,
    unit: "events",
    follows: followsIteration(item),
  };
}

function chartSource(recipe: LayoutChartRecipe, ctx: BlockSourceContext): BlockSource {
  const data = chartData(recipe, ctx.samples, ctx.metadataById, ctx.checkedSampleIds, ctx.state);
  const channel = recipe.statistic === "median" && recipe.channel
    ? (ctx.samples.find((entry) => entry.id === recipe.sampleId) ?? ctx.samples[0])?.sample.labelForKey(recipe.channel) ?? recipe.channel
    : "";
  const centre = recipe.chartType === "bars"
    ? "Bars show the mean and error bars the standard deviation."
    : recipe.chartType === "box"
      ? "Boxes show the median and quartiles; whiskers extend to the lowest and highest file."
      : "Points show each file and the line the mean.";
  const grouped = !!recipe.groupBy;
  const statistic = recipe.statistic === "median" ? "median" : recipe.statistic === "count" ? "event count" : "percentage";
  return {
    kind: "chart",
    shows: `${data.axis} of ${data.population} per file`,
    files: data.points.map((point) => point.name),
    populations: [data.population],
    channels: channel ? [channel] : [],
    value: data.axis,
    statistic,
    unit: "files",
    ...(grouped ? { groupTitle: recipe.groupBy } : {}),
    groups: data.groups.map((group) => ({ label: group.label, n: group.n })),
    centre,
    testAsked: recipe.test && grouped,
    tests: data.test ? [{ panel: "", name: data.test.name, p: data.test.p }] : [],
    follows: false,
  };
}

/** Whether a value belongs to the panel a block of one panel draws. */
function inPanel(only: LayoutProportionsPanel | undefined, values: { facet: string | null; group: string | null; population: string | null; populationId: string | null }): boolean {
  if (!only || "legend" in only) return true;
  return (
    (only.facet === undefined || (values.facet ?? "") === only.facet) &&
    (only.group === undefined || values.group === null || values.group === only.group) &&
    (only.populationId !== undefined && values.populationId
      ? values.populationId === only.populationId
      : only.population === undefined || values.population === null || values.population === only.population)
  );
}

function plottingSource(item: SourceItem, recipe: LayoutProportionsRecipe, ctx: BlockSourceContext): BlockSource {
  const settings = recipe.settings;
  const follows = followsIteration(item);
  const name = fileNamer(ctx);
  const files = settings.files.filter((id) => ctx.files.some((entry) => entry.id === id)).map(name);
  const panel = recipe.panel && !("legend" in recipe.panel) ? onlyPanelText(recipe.panel) || undefined : undefined;
  if (recipe.panel && "legend" in recipe.panel) {
    return { kind: "legend", shows: "Legend of a Plotting chart", files, populations: [], channels: [], follows };
  }
  const { model, cellModel: firstModel, channels: channelModels } = plottingBlockModels(settings, ctx.files, ctx.state, ctx.metadataById, ctx.divisionProfiles, ctx.dataRevision);
  const groupTitle = proportionsFactorTitle(settings.groupSel);
  const perFile = settings.groupSel === PROPORTIONS_SAMPLE_FACTOR;
  const unit = unitNoun(settings.unitSel);
  // A block of a page describes the page's panels: the selector of every panel on it.
  const pageBy = chartPageDimension({ ...settings, channels: channelModels.map((part) => part.key) }, firstModel ? firstModel.hasFacet : model.hasFacet);
  const pageValue = selectorPage(recipe.panel);
  const selected = pageAsPanels(recipe.panel, pageBy);
  const channelLabels = Object.fromEntries(channelModels.map((part) => [part.key, part.label]));
  const page = pageValue !== undefined && pageBy
    ? panelDimensionText({ facet: pageValue, group: pageValue, population: pageValue, channel: pageValue }, pageBy, { group: groupTitle, facet: proportionsFactorTitle(settings.facetSel), channels: channelLabels })
    : undefined;
  // A chart of several channels: a block of one channel (a panel or a page of it) describes that
  // channel's cells, the whole chart the first channel's cells with every channel named.
  const chosen = channelModels.find((part) => selected && !("legend" in selected) && part.key === selected.channel);
  const cellModel = chosen?.model ?? firstModel;
  const only = chosen && selected && !("legend" in selected) ? (({ channel: _channel, ...rest }) => rest)(selected) : selected;
  const allChannels = !chosen && channelModels.length > 1 ? channelModels.map((part) => part.label) : null;
  const base = { files, follows, ...(panel && pageValue === undefined ? { panel } : {}), ...(page ? { page } : {}), ...(groupTitle && !perFile ? { groupTitle } : {}) };

  if (settings.valueKind === "statistic" && cellModel) {
    const plotType = settings.plotType === "bar" ? "bar" : settings.plotType === "dots" ? "dots" : "box";
    const frame = statisticChartFrame(cellModel, { ...settings, plotType }, groupTitle, proportionsFactorTitle(settings.facetSel));
    const panels = only && !("legend" in only) ? matchingPanels(frame.panels, only, (p) => p).slice(0, page ? undefined : 1) : frame.panels;
    const groups: SourceGroup[] = [];
    for (const p of panels)
      for (const slot of p.slots) {
        if (!slot.points.length) continue;
        // With the populations together, a slot's label is its group and `cat` its population.
        const group = settings.xAxis === "groups" ? slot.label : p.group ?? "";
        const population = slot.cat !== undefined ? cellModel.catLevels[slot.cat] ?? "" : settings.xAxis === "groups" ? p.population ?? "" : slot.label;
        groups.push({ label: group, population, n: slot.points.length });
      }
    const populations = [...new Set(groups.map((g) => g.population ?? ""))].filter(Boolean);
    const channel = allChannels ? listWords(allChannels) : cellModel.channelLabel || settings.channel;
    const value = statisticTitle(settings.statistic, channel);
    const err = settings.errorBar === "sem" ? "standard error of the mean" : "standard deviation";
    const centre = plotType === "box"
      ? BOX_UNITS(unit.many)
      : plotType === "bar"
        ? `Bars show the mean of the ${unit.many} and error bars the ${err}.`
        : `Points show each ${unit.one}; lines show the mean and error bars the ${err}.`;
    const tested = settings.test && chartXAxis(settings) === "groups";
    const pairwise = tested && settings.comparisons === "pairwise";
    return {
      ...base,
      kind: "statistic",
      shows: `${value} of ${listWords(populations) || "the populations'"} cells per ${unit.one}`,
      populations,
      channels: allChannels ?? [channel],
      value,
      statistic: settings.statistic === "geomean" ? "geometric mean" : settings.statistic,
      unit: unit.many,
      groups,
      centre,
      testAsked: tested,
      tests: tested ? panels.flatMap((p) => (p.test ? [{ panel: p.title, name: p.test.name, p: p.test.p }] : [])) : [],
      ...(pairwise
        ? {
            comparisons: panels.flatMap((p) => sourceComparisons(p.title, shownComparisons(p.comparisons, settings.comparisonsShow))),
            testDescription: comparisonDescription(settings, frame.groups.length),
          }
        : {}),
    };
  }

  if (settings.valueKind === "cells" && cellModel) {
    const violins = cellModel.violins.filter((violin) =>
      inPanel(only, { facet: violin.facet, group: violin.group, population: cellModel.catLevels[violin.cat] ?? null, populationId: cellModel.levels[violin.cat]?.popId ?? null }));
    const groups: SourceGroup[] = [];
    for (const violin of violins) {
      if (!violin.values.length) continue;
      const population = cellModel.catLevels[violin.cat];
      const found = groups.find((g) => g.label === violin.group && g.population === population);
      if (found) found.n += violin.values.length;
      else groups.push({ label: violin.group, population, n: violin.values.length });
    }
    const populations = [...new Set(groups.map((g) => g.population ?? ""))].filter(Boolean);
    const channel = allChannels ? listWords(allChannels) : cellModel.channelLabel || settings.channel;
    const centre = settings.plotType === "box"
      ? BOX_UNITS("cells")
      : settings.plotType === "ridgeline"
        ? "Ridgelines show the density of the cells (Silverman's bandwidth), each row scaled to its own peak."
        : settings.plotType === "splitViolin" && new Set(groups.map((g) => g.label)).size === 2 && chartXAxis(settings) === "groups"
          ? `Split violins show the density of each group's cells on its own half (Silverman's bandwidth), with each half's median${settings.violinBox ? " and quartiles" : ""} marked across it.`
          : `Violins show the density of the cells (Silverman's bandwidth)${settings.violinBox ? ", with the median and quartiles marked inside" : ""}.`;
    // With replicate marks, the rank test on the units' values, as the chart draws it.
    const replicateTests = settings.test && chartXAxis(settings) === "groups" && settings.replicateMarks !== "none" && (chosen ? chosen.unitModel : plottingUnitModel(settings, ctx));
    const frame = replicateTests ? replicateTestFrame(settings, cellModel, replicateTests, only) : null;
    return {
      ...base,
      ...(frame ?? {}),
      kind: "cells",
      shows: `${channel} in each cell of ${listWords(populations) || "the populations"}, the cells of each group's files pooled`,
      populations,
      channels: allChannels ?? [channel],
      value: `${channel} per cell`,
      statistic: "value per cell",
      unit: "cells",
      groups,
      centre,
    };
  }

  // A proportion chart: each population's share, per replicate unit for a boxplot or an averaged stacked bar.
  const box = settings.plotType !== "stacked";
  const populationsMap = proportionsPopulations(settings, ctx.state);
  const parentName = settings.categoryKind === "division"
    ? divisionWithinName(model.divisionWithin)
    : populationsMap[settings.parent]?.parent_id ? populationsMap[settings.parent].name : null;
  const value = proportionsValueTitle(settings.categoryKind, parentName, settings.includeUngated);
  const cats = model.catLevels.map((population, cat) => ({ population, cat, populationId: model.levels?.[cat]?.popId ?? null }))
    // The populations alone: the facet picks the rows below, and a population has none.
    .filter((entry) => inPanel(only && !("legend" in only) ? { ...only, facet: undefined } : only, { facet: null, group: null, population: entry.population, populationId: entry.populationId }));
  const rows = model.perSample.filter((row) => !only || "legend" in only || only.facet === undefined || (row.facet ?? "") === only.facet);
  const units = perUnitProps(rows, model.catLevels.length);
  const groupLabels = [...new Set(units.map((u) => u.group))];
  const pooled = !box && !settings.averagePerUnit;
  const groups: SourceGroup[] = pooled
    ? groupLabels.map((label) => ({ label, n: rows.filter((row) => row.group === label).reduce((total, row) => total + row.catCounts.reduce((a, b) => a + b, 0), 0) }))
    : groupLabels.map((label) => ({ label, n: units.filter((u) => u.group === label).length }));
  const populations = cats.map((entry) => entry.population);
  const centre = box
    ? BOX_UNITS(unit.many)
    : pooled
      ? "Each bar shows the composition of its group's events, pooled over its files."
      : `Each bar shows the mean composition of the ${unit.many} in its group.`;
  const tested = box && settings.test;
  const allGroups = columnValueOrder(model.perSample.map((row) => row.group));
  const facets = model.hasFacet ? columnValueOrder(model.perSample.map((row) => row.facet ?? "")) : [null];
  const options = { comparisons: settings.comparisons, comparisonsShow: settings.comparisonsShow, paired: comparisonPaired(settings) };
  const panelTests = tested ? proportionPanelTests(model, facets, allGroups, settings.proportionValue, options) : new Map();
  const testPanels = facets.flatMap((facet, fi) => cats.map((entry) => ({ title: [entry.population, model.hasFacet ? facet || "(NA)" : null].filter(Boolean).join(" · "), facet, tests: panelTests.get(`p${fi}-${entry.cat}`) })))
    .filter((entry) => entry.tests && (!only || "legend" in only || only.facet === undefined || (entry.facet ?? "") === only.facet));
  const described = settings.comparisons === "pairwise" || options.paired;
  return {
    ...base,
    ...(tested
      ? {
          testAsked: true,
          tests: testPanels.flatMap((entry) => (entry.tests.overall ? [{ panel: testPanels.length > 1 ? entry.title : "", name: entry.tests.overall.name, p: entry.tests.overall.p }] : [])),
          ...(described
            ? {
                comparisons: testPanels.flatMap((entry) => sourceComparisons(testPanels.length > 1 ? entry.title : "", shownComparisons(entry.tests.pairs, settings.comparisonsShow))),
                testDescription: comparisonDescription(settings, allGroups.length),
              }
            : {}),
        }
      : {}),
    kind: "proportion",
    shows: `${value} for ${listWords(populations) || "the populations"}${pooled ? ", events pooled per group" : ` per ${unit.one}`}`,
    populations,
    channels: [],
    value,
    statistic: "percentage",
    unit: pooled ? "events" : unit.many,
    groups,
    centre,
  };
}

/** A panel's brackets as a block's source gives them. */
function sourceComparisons(panel: string, pairs: readonly PanelComparison[]): SourceComparison[] {
  return pairs.flatMap((pair) => (pair.p !== null && pair.pAdjusted !== null ? [{ panel, groupA: pair.groupA, groupB: pair.groupB, name: pair.test, p: pair.p, pAdjusted: pair.pAdjusted }] : []));
}

/** A per-cell chart's units pooled for its replicate marks, as the block draws them. */
function plottingUnitModel(settings: LayoutProportionsRecipe["settings"], ctx: BlockSourceContext) {
  return plottingBlockModels(settings, ctx.files, ctx.state, ctx.metadataById, ctx.divisionProfiles, ctx.dataRevision).unitModel;
}

/** The rank tests of a per-cell chart's replicate marks, in a block's description. */
function replicateTestFrame(
  settings: LayoutProportionsRecipe["settings"],
  cellModel: NonNullable<ReturnType<typeof plottingBlockModels>["cellModel"]>,
  unitModel: NonNullable<ReturnType<typeof plottingBlockModels>["unitModel"]>,
  only: LayoutProportionsPanel | undefined,
): Pick<BlockSource, "testAsked" | "tests" | "comparisons" | "testDescription"> {
  const { panels, groups } = cellPanels(cellModel, settings.xAxis, undefined, proportionsFactorTitle(settings.facetSel));
  const frame = cellReplicateFrame(cellModel, panels, groups, settings.xAxis, { unitModel, statistic: settings.replicateMarks === "mean" ? "mean" : "median", unitSel: settings.unitSel, test: true, comparisons: settings });
  const shown = panels.filter((panel) => inPanel(only, panel));
  const title = (panel: (typeof panels)[number]) => (shown.length > 1 ? panel.title : "");
  return {
    testAsked: true,
    tests: shown.flatMap((panel) => {
      const test = frame.tests.get(panel.key);
      return test ? [{ panel: title(panel), name: test.name, p: test.p }] : [];
    }),
    ...(settings.comparisons === "pairwise"
      ? {
          comparisons: shown.flatMap((panel) => sourceComparisons(title(panel), frame.comparisons.get(panel.key) ?? [])),
          testDescription: comparisonDescription(settings, groups.length),
        }
      : {}),
  };
}

/** The description of a block on a page; null for text, image walls and cell panels, which draw no counted data. */
export function describeLayoutBlock(item: SourceItem, ctx: BlockSourceContext): BlockSource | null {
  const recipe = item.recipe;
  if (recipe.kind === "biplot" || recipe.kind === "histogram") return plotSource(item, recipe, ctx);
  if (recipe.kind === "strategy") return strategySource(item, recipe, ctx);
  if (recipe.kind === "figure") return figureSource(item, recipe, ctx);
  if (recipe.kind === "chart") return chartSource(recipe, ctx);
  if (recipe.kind === "proportions") return plottingSource(item, recipe, ctx);
  return null;
}

/** A p value as a legend gives it: two significant figures, or a power of ten below 0.001. */
export function exactP(p: number): string {
  if (!Number.isFinite(p)) return "p not computed";
  if (p >= 0.001) return `p = ${p.toPrecision(2)}`;
  const [mantissa, exponent] = p.toExponential(1).split("e");
  return `p = ${mantissa} × 10^${Number(exponent)}`;
}

/** A test's name as a legend gives it. */
export function testName(name: SourceTest["name"]): string {
  return name === "Wilcoxon rank-sum" ? "Wilcoxon rank-sum test" : name === "Wilcoxon signed-rank" ? "Wilcoxon signed-rank test" : "Kruskal–Wallis test";
}

/**
 * The tests of a block as one sentence: "Wilcoxon rank-sum test, p = 0.10." A block of several
 * panels names each panel's p. A test asked for that could not be made says so. Empty for none.
 */
export function testSentence(source: Pick<BlockSource, "tests" | "testAsked"> & Partial<Pick<BlockSource, "comparisons" | "testDescription">>): string {
  const tests = source.tests ?? [];
  const pairs = source.comparisons ?? [];
  // Pairwise or paired, the sentence first says what is tested, then gives each line's and each
  // bracket's p; otherwise it is as it always was.
  if (source.testDescription) {
    const parts = [`${source.testDescription}.`];
    const overall = testSentence({ tests, testAsked: false });
    if (overall) parts.push(overall);
    if (pairs.length) parts.push(`Pairs, Holm-adjusted: ${pairs.map((pair) => `${pair.panel ? `${pair.panel}, ` : ""}${pair.groupA} against ${pair.groupB}, ${exactP(pair.pAdjusted)}`).join("; ")}.`);
    else if (!overall && source.testAsked) parts.push("No pair could be tested: each group needs two or more values.");
    return parts.join(" ");
  }
  if (!tests.length) return source.testAsked ? "No test was made: each group needs two or more values, and there must be two or more groups." : "";
  const names = [...new Set(tests.map((test) => test.name))];
  if (tests.length === 1) return `${testName(tests[0].name)}, ${exactP(tests[0].p)}.`;
  const lead = names.length === 1 ? `${testName(names[0])} in each panel` : "Tests in each panel";
  return `${lead}: ${tests.map((test) => `${test.panel ? `${test.panel}, ` : ""}${names.length === 1 ? "" : `${testName(test.name)}, `}${exactP(test.p)}`).join("; ")}.`;
}

/**
 * The groups with their n, as a legend gives them: "control, n = 3 files; treated, n = 3 files".
 * Where a group's populations differ in n, its range is given.
 */
export function sizesText(source: Pick<BlockSource, "groups" | "unit" | "counts" | "populations">): string {
  const unit = source.unit ?? "";
  if (source.groups?.length) {
    const labels = [...new Set(source.groups.map((g) => g.label))];
    return labels.map((label) => {
      const ns = source.groups!.filter((g) => g.label === label).map((g) => g.n);
      const lo = Math.min(...ns), hi = Math.max(...ns);
      const n = lo === hi ? count(lo) : `${count(lo)} to ${count(hi)}`;
      return `${label || "(none)"}, n = ${n} ${hi === 1 ? singular(unit) : unit}`.trim();
    }).join("; ");
  }
  if (source.counts?.length) {
    if (source.counts.length === 1) return `n = ${count(source.counts[0])} ${source.counts[0] === 1 ? "event" : "events"}`;
    return source.populations.map((population, i) => {
      const n = source.counts![i] ?? 0;
      return `${population}, n = ${count(n)} ${n === 1 ? "event" : "events"}`;
    }).join("; ");
  }
  return "";
}

/** The source placeholders a title or text may use, each with what it reads. `{n}` is the iteration's page number, so the n per group is `{sizes}`. */
export const SOURCE_PLACEHOLDERS: readonly { token: string; label: string }[] = [
  { token: "{files}", label: "Files" },
  { token: "{sizes}", label: "n per group" },
  { token: "{unit}", label: "What n counts" },
  { token: "{channel}", label: "Channel" },
  { token: "{statistic}", label: "Statistic" },
  { token: "{test}", label: "Test" },
  { token: "{p}", label: "p" },
];

/** What each source placeholder reads for a block. */
export function sourcePlaceholderValues(source: BlockSource): Record<string, string> {
  const tests = source.tests ?? [];
  return {
    files: source.files.length <= 3 ? source.files.join(", ") : `${source.files.length} files`,
    sizes: sizesText(source),
    unit: source.unit ?? "",
    channel: source.channels.join(" vs "),
    statistic: source.value ?? source.statistic ?? "",
    test: [...new Set([...tests.map((test) => testName(test.name)), ...(source.comparisons ?? []).map((pair) => testName(pair.name))])].join(", "),
    p: [...tests.map((test) => exactP(test.p)), ...(source.comparisons ?? []).map((pair) => `${pair.groupA} against ${pair.groupB}, adjusted ${exactP(pair.pAdjusted)}`)].join("; "),
  };
}

const SOURCE_TOKEN = /\{(files|sizes|unit|channel|statistic|test|p)\}/g;

/** Whether a text uses a source placeholder. */
export function hasSourcePlaceholder(text: string): boolean {
  return /\{(files|sizes|unit|channel|statistic|test|p)\}/.test(text);
}

/** A text with its source placeholders filled from a block; any other placeholder is left as typed. */
export function fillSourcePlaceholders(text: string, source: BlockSource | null): string {
  if (!source) return text;
  const values = sourcePlaceholderValues(source);
  return text.replace(SOURCE_TOKEN, (_whole, key: string) => values[key] ?? "");
}

/** One row of a block's Data list: a term (with a count, for a list), its value, and the full value where the shown one is cut. */
export interface SourceRow {
  term: string;
  count?: number;
  value: string;
  full?: string;
}

/** Names cut to three and "+ n more"; the full list where cut. */
export function shortList(names: readonly string[]): { value: string; full?: string } {
  if (names.length <= 3) return { value: names.join(", ") };
  return { value: `${names.slice(0, 3).join(", ")} + ${names.length - 3} more`, full: names.join(", ") };
}

/** The Data list's rows for a block, in the order shown. */
export function sourceRows(source: BlockSource): SourceRow[] {
  const rows: SourceRow[] = [{ term: "Shows", value: source.shows }];
  if (source.panel) rows.push({ term: "Panel", value: source.panel });
  if (source.page) rows.push({ term: "Page", value: source.page });
  if (source.files.length) rows.push({ term: source.files.length === 1 ? "File" : "Files", ...(source.files.length > 1 ? { count: source.files.length } : {}), ...shortList(source.files) });
  if (source.populations.length) rows.push({ term: source.populations.length === 1 ? "Population" : "Populations", ...shortList(source.populations) });
  if (source.channels.length) rows.push({ term: source.channels.length === 1 ? "Channel" : "Channels", value: source.channels.join(", ") });
  if (source.value) rows.push({ term: "Value", value: source.value });
  if (source.groupTitle) rows.push({ term: "Grouped by", value: source.groupTitle });
  const sizes = sizesText(source);
  if (sizes) rows.push({ term: "n", value: sizes });
  if (source.centre) rows.push({ term: "Drawn", value: source.centre });
  const test = testSentence(source);
  if (test) rows.push({ term: "Test", value: test });
  rows.push({ term: "Iteration", value: source.follows ? "Drawn for each unit of the sheet's iteration" : "Drawn once" });
  return rows;
}

/** A placed block with what binds it to its tile: the template it came from and its tile's offset. */
type PagePlaced = SourceItem & { templateId: string; offset: { x: number; y: number } };

/**
 * An item as the sheet draws it, its source placeholders filled: a text block's from the block it
 * reads from on the same tile, an old chart block's title from its own data. Anything else, and an
 * item without a source placeholder, is returned as it is.
 */
export function withSourceFields<T extends PagePlaced>(item: T, pageItems: readonly T[], describe: (item: T) => BlockSource | null): T {
  const recipe = item.recipe;
  if (recipe.kind === "text" && recipe.readsFrom && hasSourcePlaceholder(recipe.text)) {
    const readsFrom = recipe.readsFrom;
    const source = pageItems.find((candidate) => candidate.templateId === readsFrom && candidate.offset.x === item.offset.x && candidate.offset.y === item.offset.y);
    return source ? { ...item, recipe: { ...recipe, text: fillSourcePlaceholders(recipe.text, describe(source)) } } : item;
  }
  if (recipe.kind === "chart" && recipe.title && hasSourcePlaceholder(recipe.title)) {
    return { ...item, recipe: { ...recipe, title: fillSourcePlaceholders(recipe.title, describe(item)) } };
  }
  return item;
}
