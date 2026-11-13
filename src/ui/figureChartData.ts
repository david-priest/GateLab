// figureChartData.ts — a chart plot's panel in an Illustration figure as data: the panel's
// populations in the panel's files, built by the Plotting tab's builders as a Layout block's are
// (plottingBlockModels), with the settings the panel is drawn with (PlottingChartView).

import {
  resolveFigurePopulation,
  type FigurePanel,
  type FigurePanelData,
  type FigurePopulation,
  type FigureSample,
  type FigureSource,
  type FigureSpec,
} from "../engine/figure";
import type { StoredHierarchy } from "../engine/hierarchies";
import type { CellValuesModel, CellViolin } from "../engine/cellValuesModel";
import type { ProportionsModel } from "../engine/proportionsModel";
import type { SampleComposition } from "../engine/proportions";
import { populationTreeOrder } from "../engine/populations";
import { populationColor, populationColorOf, UNGATED_COLOR } from "../engine/palettes";
import type { PopulationMap } from "../engine/models";
import type { Sample } from "../engine/sample";
import type { CoreState } from "../store";
import { figureChartOwnSettings, PROPORTIONS_NO_FACTOR, type ProportionsSettings } from "../engine/proportionsSettings";
import { figureChartDataSettings } from "./figureLayoutRecipes";
import { proportionsFactorTitle } from "./ProportionsChart";
import { chartXAxis } from "./chart/chartXAxis";
import { plottingBlockModels } from "./LayoutProportions";

/** What a chart panel draws, kept in its panel data's `config.chart`. */
export interface FigureChartData {
  valueKind: "cells" | "statistic" | "proportion";
  /**
   * The settings the panel is drawn with: figureChartDataSettings's for the panel, the figure's own
   * decisions (no legend, no grid, the violin's box, the value axis's range), then the settings
   * the chart carries (figureChartOwnSettings). The panel's width, plot height and fonts are set
   * where it is drawn (FigureChartBody).
   */
  settings: ProportionsSettings;
  /**
   * The per-cell or statistic chart's cells as Plotting's builders give them, on the display scale
   * for cells, linear for a statistic: the populations in the panel's order and named by its
   * labels, and, for a summary, each mark's group its place, named by the place's label.
   */
  cells: CellValuesModel | null;
  /** A per-cell chart's cells pooled by replicate unit, as `cells`, when the settings draw replicate marks. */
  unitModel: CellValuesModel | null;
  /** The composition: a bar per file of the populations' shares of their common parent. */
  proportions: (ProportionsModel & { populations: PopulationMap }) | null;
  /** The populations' colours, in category order (the rest of the parent last, for a composition). */
  colors: string[];
  /** A summary's groups in the order of its places; unset, the model's order. */
  groupLevels?: string[];
  /** What the groups are, written by the chart, when the chart names its own groups (its own `groupSel`); unset, none. */
  groupTitle?: string;
  /** The value axis's range for a per-cell chart shared across the figure's files; absent, fitted to the panel. */
  range?: [number, number];
  /** How many files the panel draws. */
  files: number;
  /**
   * A summary panel (`chart.summary`): its marks run along x by file (or by metadata value, with
   * `grouped`), every population side by side at each file's place; `legend` names the populations.
   */
  summary?: { grouped: boolean; legend: { name: string; color: string }[] };
}

/** A population's colour, as every tab colours it (populationColorOf); a population without one takes a slot by its place. */
export function figurePopulationColour(
  ref: FigurePopulation,
  trees: Record<string, StoredHierarchy>,
  populationColors: Readonly<Record<string, string>> | undefined,
  index: number,
): string {
  const pop = trees[ref.hierarchyId]?.populations[ref.populationId];
  return populationColorOf(pop) ?? populationColors?.[ref.populationId] ?? populationColor("default", index);
}

/**
 * Names for a note under a panel: up to `shown` of them, then how many more. A note naming twenty
 * files ran to some 900 characters and widened the whole figure page.
 */
export function namesListed(names: readonly string[], shown = 3): string {
  if (names.length <= shown + 1) return names.join(", ");
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

/**
 * A summary panel's places along x, in the figure's order: a place per covered cell, or, where a
 * metadata column is on the spanned shelf, a place per value of it with its cells' files pooled.
 * Null for a panel of its own cell.
 */
export function summaryPlaces(panel: Pick<FigurePanel, "cells">): { label: string; samples: string[] }[] | null {
  if (!panel.cells) return null;
  if (!panel.cells.some((cell) => cell.group !== undefined)) return panel.cells.map(({ label, samples }) => ({ label, samples }));
  const out: { label: string; samples: string[] }[] = [];
  for (const cell of panel.cells) {
    const label = cell.group ?? cell.label;
    const place = out.find((p) => p.label === label);
    if (place) place.samples.push(...cell.samples);
    else out.push({ label, samples: [...cell.samples] });
  }
  return out;
}

/** How many panels a per-cell or statistic chart lays its cells out in: one with every population together, else one per group or per population. */
function chartPanelCount(settings: ProportionsSettings, model: CellValuesModel): number {
  const xAxis = chartXAxis(settings);
  if (xAxis === "together") return 1;
  return xAxis === "populations" ? new Set(model.violins.map((violin) => violin.group)).size : model.catLevels.length;
}

/** Each shown sample's sample for Plotting's builders, kept so their models are cached and its gating memo reused. */
const builderSamples = new WeakMap<Sample, Sample>();

/**
 * A file's sample for Plotting's builders: the one the figure shows (its display values and axes,
 * under the figure's transforms), gated on the file's own sample as the figure's prepared file was
 * (prepareFigureSource), so its populations hold the same events.
 */
function builderSample(shown: Sample, gated: Sample | undefined): Sample {
  if (!gated || gated === shown) return shown;
  let out = builderSamples.get(shown);
  if (!out) {
    out = Object.create(shown) as Sample;
    out.gateAssayData = () => gated.gateAssayData();
    builderSamples.set(shown, out);
  }
  return out;
}

/**
 * A chart panel's data, built by the Plotting tab's builders (plottingBlockModels) from the
 * settings figureChartDataSettings gives for it, with each file's populations as the figure
 * resolves them (its per-file overrides and selections), and shaped as the figure draws it. A
 * population a file's tree lacks, or holds changed, is left out of that file and named in the
 * panel's note; a file with none of the populations, or without their parent, is left out, as is a
 * file without the channel. A composition of the tree's root alone draws the root's children, as
 * Plotting does. The panel shows a problem only when nothing can be drawn.
 */
export function buildFigureChartPanel(
  panel: FigurePanel,
  figure: FigureSpec,
  sources: readonly FigureSource[],
  trees: Record<string, StoredHierarchy>,
  options: {
    populationColors?: Readonly<Record<string, string>>;
    /** The workspace the models are built from. */
    state: CoreState;
    /** The files as prepared, before the figure's transforms (`sources` are drawn under them): what each file is gated on. */
    gatingSources?: readonly FigureSource[];
  },
  /** Each channel's range shared across the figure's files, as the flow plots use it. */
  sharedRanges: Record<string, [number, number]> = {},
): FigurePanelData {
  const chart = panel.plot.chart;
  if (!chart) return { config: null, mappings: [], problem: "The chart plot has nothing to draw" };
  if (!panel.samples.length) return { config: null, omitted: true, mappings: [] };
  const refs = panel.populations?.length ? panel.populations : [panel.population];
  const mappings: FigurePanelData["mappings"] = [];
  const missing = new Set<string>();
  const channel = panel.plot.x;
  const files: { source: FigureSource; local: (string | null)[] }[] = [];
  for (const id of panel.samples) {
    const source = sources.find((s) => s.id === id);
    if (!source) return { config: null, problem: "Sample unavailable", mappings };
    const local = refs.map((ref) => {
      const override = figure.populationOverrides?.[source.id]?.[JSON.stringify([ref.hierarchyId, ref.populationId])];
      const resolved = resolveFigurePopulation(
        override ? { hierarchyId: source.tree.id, populationId: override, label: ref.label } : ref,
        source.tree,
        trees,
      );
      mappings.push({ sample: source.name, status: resolved.status });
      const selected = !figure.samplePopulations
        || (figure.samplePopulations[id] ?? []).some((p) => resolveFigurePopulation(p, source.tree, trees).id === resolved.id);
      if (!resolved.id || resolved.status === "changed" || !selected) {
        missing.add(ref.label);
        return null;
      }
      return resolved.id;
    });
    files.push({ source, local });
  }
  const template = trees[refs[0].hierarchyId];
  const order = template ? populationTreeOrder(template.populations, template.root_population_id ?? "") : [];
  const depthOf = (id: string) => order.find((entry) => entry.popId === id)?.depth ?? 1;

  // Plotting's settings for the panel, and each file's populations as the figure resolves them,
  // keyed by the populations' ids in the settings' tree. A population with no counterpart in that
  // tree is not drawn, and is named in the note.
  const { settings: panelSettings, populations } = figureChartDataSettings(panel, () => true, trees)!;
  populations.forEach((id, i) => {
    if (!id) missing.add(refs[i].label);
  });
  const filePopulations: Record<string, Record<string, string | null>> = {};
  for (const { source, local } of files) {
    const named: Record<string, string | null> = {};
    populations.forEach((id, i) => {
      if (id && !(id in named)) named[id] = local[i];
    });
    filePopulations[source.id] = named;
  }
  const gatedOn = new Map((options.gatingSources ?? []).map((s) => [s.id, s.sample]));
  const samples: FigureSample[] = files.map(({ source }) => ({
    id: source.id,
    name: source.name,
    sample: builderSample(source.sample, gatedOn.get(source.id)),
    hierarchyId: source.tree.id,
    ...(source.metadata ? { metadata: source.metadata } : {}),
  }));
  // A summary's places along x: its cells, or the metadata values its cells hold, in order.
  const places = summaryPlaces(panel);
  // A per-cell chart's value axis: shared across the figure's files, or the Gating tab's range
  // where the figure follows it; fitted to the panel when each file's axes are its own.
  const range = chart.valueKind === "cells" && figure.scalePolicy !== "individual" ? sharedRanges[channel] : undefined;
  // The settings the panel is drawn with: the panel's, then the figure's decisions, then the
  // chart's own settings, which win. A panel of its own cell draws its files as one group, named
  // by the panel's heading.
  const figureSettings: ProportionsSettings = {
    ...panelSettings,
    ...(!places && chart.valueKind !== "proportion" ? { groupSel: PROPORTIONS_NO_FACTOR } : {}),
    violinBox: chart.violinBox !== false,
    cellRange: range ? "gating" : "fit",
    panelColumns: "",
    panelsPerRow: 1,
    grid: false,
    legend: false,
  };
  const metadataById = Object.fromEntries(files.map(({ source }) => [source.id, source.metadata]));
  const revision = `figure:${files.map(({ source }) => source.sample.dataRevision).join(",")}`;
  const modelsOf = (drawnSettings: ProportionsSettings) => plottingBlockModels(drawnSettings, samples, options.state, metadataById, {}, revision, filePopulations);
  let carried = figureChartOwnSettings(chart);
  let settings: ProportionsSettings = { ...figureSettings, ...carried };
  let models = modelsOf(settings);
  // The panel is one panel of the chart: an arrangement the chart carries (what runs along x, its
  // groups) that would draw its cells in several panels cannot be drawn here, and is left out.
  if (models.cellModel && chartPanelCount(settings, models.cellModel) > 1 && ["xAxis", "populationsTogether", "groupSel"].some((key) => key in carried)) {
    const { xAxis: _xAxis, populationsTogether: _together, groupSel: _groupSel, ...kept } = carried;
    carried = kept;
    settings = { ...figureSettings, ...carried };
    models = modelsOf(settings);
  }
  // A chart that names its own groups keeps them, and their title; otherwise the figure names them.
  const ownGroups = carried.groupSel !== undefined;
  const groupTitle = ownGroups ? proportionsFactorTitle(settings.groupSel) : undefined;
  const nameOf = new Map(files.map(({ source }) => [source.id, source.name]));
  const idOfName = new Map(files.map(({ source }) => [source.name, source.id]));

  /** The panel's populations the model draws, in the panel's order: each one's place among the model's categories. */
  const drawnIn = (levels: readonly { popId: string }[]) =>
    refs.flatMap((ref, i) => {
      const at = populations[i] ? levels.findIndex((level) => level.popId === populations[i]) : -1;
      return at >= 0 ? [{ ref, i, at }] : [];
    });
  const colourOf = (i: number) => figurePopulationColour(refs[i], trees, options.populationColors, i);
  const placeOf = (id: string) => places?.findIndex((place) => place.samples.includes(id)) ?? -1;
  const summaryOf = (names: string[], colors: string[]) =>
    places ? { summary: { grouped: panel.cells!.some((cell) => cell.group !== undefined), legend: names.map((name, i) => ({ name, color: colors[i] })) } } : {};
  const noteOf = () => (missing.size ? { note: `Not drawn in every file: ${namesListed([...missing])}` } : {});

  if (chart.valueKind === "proportion") {
    const model = models.model;
    const rootId = template?.root_population_id ?? null;
    const parentId = settings.parent && settings.parent !== rootId && template?.populations[settings.parent] ? settings.parent : null;
    const parentRef = parentId && template ? { hierarchyId: template.id, populationId: parentId, label: template.populations[parentId].name } : null;
    // The parent in each file's tree; a file without it is left out, and the parent named.
    if (parentRef)
      for (const { source } of files) {
        const localParent = resolveFigurePopulation(parentRef, source.tree, trees);
        if (!localParent.id || localParent.status === "changed") missing.add(parentRef.label);
      }
    const levelCount = model.levels?.length ?? 0;
    if (!model.perSample.length || !levelCount) return { config: null, mappings, problem: "No file has these populations' parent" };
    // The panel's populations in its order; or, for the root alone, the root's children Plotting draws, in tree order.
    const drawn = drawnIn(model.levels!);
    const own = drawn.length === levelCount;
    const at = own ? drawn.map((d) => d.at) : model.levels!.map((_, c) => c);
    const names = own ? drawn.map((d) => d.ref.label) : model.catLevels.slice(0, levelCount);
    const colors = own
      ? drawn.map((d) => colourOf(d.i))
      : model.levels!.map((level, c) => figurePopulationColour({ hierarchyId: settings.hierarchy, populationId: level.popId, label: names[c] }, trees, options.populationColors, c));
    const levels = own ? drawn.map((d) => ({ popId: d.ref.populationId, depth: depthOf(d.ref.populationId) })) : model.levels!.map((level) => ({ ...level }));
    // The rest of the parent last, unless the settings leave it out.
    const rest = settings.includeUngated;
    const perSample: SampleComposition[] = model.perSample.map((row) => ({
      unit: row.unit,
      group: ownGroups ? row.group : places ? places[placeOf(row.unit)].label : files.length > 1 ? nameOf.get(row.unit) ?? row.unit : "",
      facet: null,
      catCounts: [...at.map((c) => row.catCounts[c]), ...(rest ? [row.catCounts[levelCount]] : [])],
    }));
    const total = perSample.reduce((sum, row) => sum + row.catCounts.reduce((a, b) => a + b, 0), 0);
    const restName = parentRef ? `rest of ${parentRef.label}` : "ungated";
    const data: FigureChartData = {
      valueKind: "proportion",
      settings,
      cells: null,
      unitModel: null,
      proportions: {
        catLevels: [...names, ...(rest ? [restName] : [])],
        perSample,
        hasFacet: false,
        levels,
        populations: template?.populations ?? {},
      },
      colors: [...colors, ...(rest ? [UNGATED_COLOR] : [])],
      ...(places && !ownGroups ? { groupLevels: places.map((place) => place.label) } : {}),
      ...(groupTitle !== undefined ? { groupTitle } : {}),
      files: perSample.length,
      ...summaryOf(names, colors),
    };
    return { mappings, ...noteOf(), config: { chart: data, n_events: total, x_label: panel.plot.name, x: [], y: [] } };
  }

  // A violin or box pools the panel's files' cells, on the display scale the flow plots use; a
  // statistic is taken of each file's cells on their linear values, a point per file.
  const statistic = chart.valueKind === "statistic";
  const model = models.cellModel;
  if (!model?.axisSource) return { config: null, mappings, problem: `${files[0]?.source.name ?? "File"}: channel unavailable` };
  const drawn = drawnIn(model.levels);
  const catOf = new Map<number, number>();
  drawn.forEach((d, k) => {
    if (!catOf.has(d.at)) catOf.set(d.at, k);
  });
  const catLevels = drawn.map((d) => d.ref.label);
  const levels = drawn.map((d) => ({ popId: d.ref.populationId, depth: depthOf(d.ref.populationId) }));
  const colors = drawn.map((d) => colourOf(d.i));
  // A summary's marks are grouped by place, each group named by its place's label.
  const fileOf = (violin: CellViolin) => violin.unit ?? idOfName.get(violin.files[0]) ?? "";
  const placed = places && !ownGroups;
  const fileIndex = new Map(files.map(({ source }, i) => [source.id, i]));
  /** The model's marks of the panel's populations, in the panel's order, each a summary's in its place. */
  const remapped = (of: CellValuesModel, byUnit: boolean) => {
    const violins = of.violins.flatMap((violin) => {
      const k = catOf.get(violin.cat);
      if (k === undefined) return [];
      return [{ ...violin, cat: k, ...(placed ? { group: places[placeOf(fileOf(violin))].label } : {}) }];
    });
    // A place with no marks (its files lack the channel) keeps its slot, empty, so every other
    // place's marks stay under their own column: the chart's groups are the groups it has marks of.
    if (placed && catLevels.length)
      for (const place of places)
        if (!violins.some((violin) => violin.group === place.label))
          violins.push({ cat: 0, group: place.label, facet: null, unit: null, values: new Float32Array(0), files: [] });
    // A point per file and population, in the panel's files' order, each file's in the panel's order;
    // a summary's pooled marks in its places' order.
    const place = (violin: CellViolin) => (placed ? placeOf(fileOf(violin)) : 0);
    violins.sort((a, b) => byUnit
      ? (fileIndex.get(a.unit ?? "") ?? 0) - (fileIndex.get(b.unit ?? "") ?? 0) || a.cat - b.cat
      : place(a) - place(b) || a.cat - b.cat);
    return { ...of, catLevels, levels, violins, hasFacet: of.hasFacet, excluded: [] };
  };
  const remappedCells = remapped(model, statistic);
  let lo = Infinity;
  let hi = -Infinity;
  let total = 0;
  for (const violin of remappedCells.violins) {
    total += violin.values.length;
    if (!statistic && violin.values.length) {
      lo = Math.min(lo, violin.values[0]);
      hi = Math.max(hi, violin.values[violin.values.length - 1]);
    }
  }
  const noChannel = model.noChannel;
  const cells: CellValuesModel = { ...remappedCells, extent: Number.isFinite(lo) ? [lo, hi] : null };
  const data: FigureChartData = {
    valueKind: chart.valueKind,
    settings,
    cells,
    unitModel: models.unitModel ? remapped(models.unitModel, true) : null,
    proportions: null,
    colors,
    ...(placed ? { groupLevels: places.map((place) => place.label) } : {}),
    ...(groupTitle !== undefined ? { groupTitle } : {}),
    ...(range ? { range } : {}),
    files: files.length - noChannel.length,
    ...summaryOf(catLevels, colors),
  };
  return { mappings, ...noteOf(), ...(noChannel.length && !missing.size ? { note: `No ${channel} in ${namesListed(noChannel)}` } : {}), config: { chart: data, n_events: total, x_label: panel.plot.name, x: [], y: [] } };
}
