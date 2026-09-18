// proportionsModel.ts — the Plotting tab's chart as data: the composition model built from its
// settings and the workspace, and the categories' colours, so the tab and a Layout block draw the
// same chart from the same numbers.

import { recompute, type CoreState } from "../store";
import type { Sample } from "./sample";
import { populationTreeOrder } from "./populations";
import {
  divisionCountsFor,
  divisionLevels,
  partitionCountsWithin,
  populationDisplayNames,
  resolvePartitionLevels,
  resolvePerSampleValue,
  type DivisionProfileLike,
  type PerSampleFactor,
} from "./factors";
import type { SampleComposition } from "./proportions";
import type { PopulationMap } from "./models";
import { paletteColors, populationColor, UNGATED_COLOR } from "./palettes";
import { SAMPLE_ID_FIELD, sampleDisplayId } from "./metadata";
import { figureHierarchies, resolveFigurePopulation } from "./figure";
import {
  BASE_PROPORTIONS_SETTINGS,
  PROPORTIONS_NO_FACTOR,
  PROPORTIONS_SAMPLE_FACTOR,
  type ProportionsSettings,
} from "./proportionsSettings";

export type { ProportionsSettings } from "./proportionsSettings";

export interface ProportionsSampleRef {
  id: string;
  /** The file name: what the Group, Unit and Facet pickers read when set to the file. */
  name: string;
  sample: Sample;
  hierarchyId?: string;
}

export interface ProportionsModel {
  catLevels: string[];
  perSample: SampleComposition[];
  hasFacet: boolean;
  /** Population categories with their depth, so the chart nests daughters inside parents. */
  levels?: { popId: string; depth: number }[];
  /** Files left out: their tree lacks a selected population, or holds it changed. */
  excluded?: string[];
}

/** The tab's settings before the user touches anything: every file, the active tree, its populations, the first metadata column. */
export function defaultProportionsSettings(
  files: readonly { id: string }[],
  activeState: CoreState,
  metadataColumns: readonly { name: string }[],
): ProportionsSettings {
  const rootId = activeState.root_population_id ?? "";
  return {
    ...BASE_PROPORTIONS_SETTINGS,
    files: files.map((file) => file.id),
    hierarchy: activeState.active_hierarchy_id,
    parent: rootId,
    selectedPops: populationTreeOrder(activeState.populations, rootId)
      .filter(({ popId }) => popId !== rootId)
      .map(({ popId }) => popId),
    groupSel: metadataColumns[0]?.name ?? PROPORTIONS_SAMPLE_FACTOR,
  };
}

function parseFactor(value: string): PerSampleFactor | null {
  if (value === PROPORTIONS_NO_FACTOR) return null;
  if (value === PROPORTIONS_SAMPLE_FACTOR) return { kind: "sample" };
  return { kind: "metadata", field: value };
}

/** The parent the composition is shown within: the chosen population when the tree holds it, else the root. */
export function proportionsParentId(populations: PopulationMap, parent: string, rootId: string): string {
  return populations[parent] ? parent : rootId;
}

/** Everything beneath the parent, at every depth, in tree order. */
export function proportionsArmIds(populations: PopulationMap, parentId: string): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    for (const child of populations[id]?.children ?? []) {
      if (!populations[child]) continue;
      out.add(child);
      walk(child);
    }
  };
  walk(parentId);
  return out;
}

/**
 * The populations shown: those selected that lie beneath the parent. A selection saved against
 * another arm, or a whole tree, reads as the parent's children; an empty selection stays empty.
 */
export function proportionsSelection(populations: PopulationMap, parentId: string, selected: readonly string[]): string[] {
  const arm = proportionsArmIds(populations, parentId);
  const within = selected.filter((id) => arm.has(id));
  if (within.length || selected.length === 0) return within;
  return populations[parentId]?.children.filter((id) => populations[id]) ?? [];
}

/**
 * The composition model: one row per file drawn, with its counts per category. Population
 * categories are resolved in each file's own tree by provenance; a file whose tree lacks one, or
 * holds it changed, is listed as excluded rather than drawn wrong. Division categories come from
 * the files with a division profile; without any, the population categories are drawn.
 */
export function buildProportionsModel(
  settings: ProportionsSettings,
  files: readonly ProportionsSampleRef[],
  activeState: CoreState,
  metadata: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
  divisionProfiles: Readonly<Record<string, DivisionProfileLike>>,
): ProportionsModel {
  const trees = figureHierarchies(activeState);
  const tree = trees[settings.hierarchy] ?? trees[activeState.active_hierarchy_id];
  const state = { ...activeState, ...tree };
  const rootId = state.root_population_id ?? "";
  const samples = files.filter((file) => settings.files.includes(file.id));
  const groupSpec = parseFactor(settings.groupSel) ?? { kind: "sample" as const };
  const unitSpec = parseFactor(settings.unitSel) ?? { kind: "sample" as const };
  const facetSpec = parseFactor(settings.facetSel);
  const scalar = (entry: ProportionsSampleRef) => {
    const row = { ...metadata[entry.id], [SAMPLE_ID_FIELD]: sampleDisplayId(entry.name, metadata[entry.id]) };
    return {
      unit: unitSpec.kind === "sample" ? entry.id : resolvePerSampleValue(unitSpec, entry.name, row),
      group: resolvePerSampleValue(groupSpec, entry.name, row),
      facet: facetSpec ? resolvePerSampleValue(facetSpec, entry.name, row) : null,
    };
  };

  const divisionSamples = samples.filter((entry) => divisionProfiles[entry.id]);
  if (settings.categoryKind === "division" && divisionSamples.length) {
    const maxN = Math.max(0, ...divisionSamples.map((entry) => divisionProfiles[entry.id].n));
    const catLevels = divisionLevels(maxN);
    const perSample: SampleComposition[] = divisionSamples.map((entry) => ({
      ...scalar(entry),
      catCounts: divisionCountsFor(entry.sample, divisionProfiles[entry.id], maxN),
    }));
    return { catLevels, perSample, hasFacet: !!facetSpec };
  }

  const parentId = proportionsParentId(state.populations, settings.parent, rootId);
  const selectedPops = proportionsSelection(state.populations, parentId, settings.selectedPops);
  const displayNames = populationDisplayNames(state.populations);
  const levels = resolvePartitionLevels(state.populations, rootId, selectedPops);
  if (!levels.length) return { catLevels: [], perSample: [], hasFacet: !!facetSpec, excluded: [] };
  const restName = parentId === rootId ? "ungated" : `rest of ${displayNames[parentId] ?? state.populations[parentId]?.name ?? "parent"}`;
  const catLevels = settings.includeUngated
    ? [...levels.map((level) => displayNames[level.popId] ?? level.name), restName]
    : levels.map((level) => displayNames[level.popId] ?? level.name);
  const excluded: string[] = [];
  const perSample: SampleComposition[] = samples.flatMap((entry) => {
    const own = trees[entry.hierarchyId ?? tree.id];
    if (!own) {
      excluded.push(entry.name);
      return [];
    }
    const matches = levels.map((level) =>
      resolveFigurePopulation({ hierarchyId: tree.id, populationId: level.popId, label: level.name }, own, trees),
    );
    if (matches.some((match) => !match.id || match.status === "changed")) {
      excluded.push(entry.name);
      return [];
    }
    const localLevels = levels.map((level, index) => ({ ...level, popId: matches[index].id! }));
    const masks = recompute(entry.sample, { ...activeState, ...own }).masks;
    // The parent in this file's own tree: the same population by provenance.
    const localParent = parentId === rootId
      ? null
      : resolveFigurePopulation({ hierarchyId: tree.id, populationId: parentId, label: state.populations[parentId]?.name ?? "" }, own, trees);
    if (parentId !== rootId && (!localParent?.id || localParent.status === "changed")) {
      excluded.push(entry.name);
      return [];
    }
    const { counts, rest } = partitionCountsWithin(masks, localLevels, localParent?.id ?? null, entry.sample.fcs.nEvents);
    return [{ ...scalar(entry), catCounts: settings.includeUngated ? [...counts, rest] : counts }];
  });
  return {
    catLevels,
    perSample,
    hasFacet: !!facetSpec,
    levels: levels.map((level) => ({ popId: level.popId, depth: level.depth })),
    excluded,
  };
}

/**
 * The categories' colours. Population categories take each population's stable colour slot, so
 * adding a population never reshuffles the others, with ungated in fixed grey; division
 * categories are a fixed ladder and take the palette in order.
 */
export function proportionsCategoryColors(
  model: Pick<ProportionsModel, "catLevels" | "levels">,
  settings: Pick<ProportionsSettings, "palette" | "includeUngated">,
  populations: PopulationMap,
): string[] {
  if (model.levels) {
    return [
      ...model.levels.map((level) => populationColor(settings.palette, populations[level.popId]?.colorSlot)),
      ...(settings.includeUngated ? [UNGATED_COLOR] : []),
    ];
  }
  return paletteColors(settings.palette, Math.max(1, model.catLevels.length));
}

/** The populations of the tree the settings name, for the chart's nesting and colours. */
export function proportionsPopulations(settings: Pick<ProportionsSettings, "hierarchy">, activeState: CoreState): PopulationMap {
  const trees = figureHierarchies(activeState);
  return (trees[settings.hierarchy] ?? trees[activeState.active_hierarchy_id])?.populations ?? activeState.populations;
}
