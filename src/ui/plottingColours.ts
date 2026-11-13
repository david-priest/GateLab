// plottingColours.ts — the colours a Plotting chart gives its groups and its division levels, by
// place among all the files the chart was made with, so a group or a level keeps one colour when a
// Layout iteration or a panel draws only some of those files.

import { divisionLevels, resolvePerSampleValue, type DivisionProfileLike, type PerSampleFactor } from "../engine/factors";
import { SAMPLE_ID_FIELD, sampleDisplayId } from "../engine/metadata";
import { paletteColors, type PaletteName } from "../engine/palettes";
import { PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "../engine/proportionsSettings";
import { columnValueOrder, fileListOrder } from "../engine/levelOrder";

/** The metadata columns' own orders of their levels, by column name (`MetadataColumn.levels`). */
export type ColumnLevels = Readonly<Record<string, readonly string[]>>;

/**
 * A factor's levels over the files the chart's settings name, in the order the charts draw them:
 * a metadata column's values in the column's order of its levels where it has one, else at their
 * first file in the file list's order, as Illustration and the file list order them; the files
 * themselves in the file list's order. `factor` is a Group, Replicate unit or Facet picker's value;
 * a file resolves to its level as the Plotting models resolve it (no group is a group per file, a
 * file is named by its file name).
 */
export function plottingFactorLevels(
  settings: Pick<ProportionsSettings, "files">,
  factor: string,
  files: readonly { id: string; name: string }[],
  metadata: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
  columnLevels?: ColumnLevels,
): string[] {
  const spec: PerSampleFactor =
    factor === PROPORTIONS_NO_FACTOR || factor === PROPORTIONS_SAMPLE_FACTOR ? { kind: "sample" } : { kind: "metadata", field: factor };
  const values = fileListOrder(files, settings.files).map((entry) => {
    const row = { ...metadata[entry.id], [SAMPLE_ID_FIELD]: sampleDisplayId(entry.name, metadata[entry.id]) };
    return resolvePerSampleValue(spec, entry.name, row);
  });
  return columnValueOrder(values, spec.kind === "metadata" ? columnLevels?.[spec.field] : undefined);
}

/** The chart's groups over the files its settings name, in the order the charts draw them. */
export function plottingGroupLevels(
  settings: Pick<ProportionsSettings, "files" | "groupSel">,
  files: readonly { id: string; name: string }[],
  metadata: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
  columnLevels?: ColumnLevels,
): string[] {
  return plottingFactorLevels(settings, settings.groupSel, files, metadata, columnLevels);
}

/** The chart's facets over the files its settings name, in the order the charts draw them; none without a facet. */
export function plottingFacetLevels(
  settings: Pick<ProportionsSettings, "files" | "facetSel">,
  files: readonly { id: string; name: string }[],
  metadata: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
  columnLevels?: ColumnLevels,
): string[] {
  return settings.facetSel === PROPORTIONS_NO_FACTOR ? [] : plottingFactorLevels(settings, settings.facetSel, files, metadata, columnLevels);
}

/**
 * The colours of the groups drawn, one per group in order: each the colour of its place in the
 * chart's full list of groups when given, else of its place among the groups drawn.
 */
export function plottingGroupColours(palette: PaletteName, groups: readonly string[], levels?: readonly string[]): string[] {
  const all = levels ? [...levels, ...groups.filter((group) => !levels.includes(group))] : groups;
  const colours = paletteColors(palette, Math.max(1, all.length));
  return groups.map((group) => colours[all.indexOf(group)]);
}

/** The division levels over the files the chart was made with, those with a division profile. */
export function plottingDivisionLevels(fileIds: readonly string[], divisionProfiles: Readonly<Record<string, DivisionProfileLike>>): string[] {
  return divisionLevels(Math.max(0, ...fileIds.map((id) => divisionProfiles[id]?.n ?? 0)));
}
