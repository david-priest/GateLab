// layoutBatch.ts — iterating a Layout sheet over files. A sheet that iterates is a template:
// an item that follows the iteration is drawn once per unit (a file), fixed items and text
// repeat on every page, and placeholders in text and titles are filled in per unit. Expansion is
// a pure function from the template and the units to concrete pages, so the tab renders one page
// and the export writes them all.

import { DEFAULT_ITERATION, isPlotLikeRecipe, type LayoutItem, type LayoutIteration, type LayoutPlotRecipe, type LayoutSheet, type LayoutStrategyRecipe } from "./layout";
import { contentBounds } from "./layoutArrange";
import { plotTitle, type PlotTitleContext } from "./layoutTitle";
import type { PopulationMap } from "./models";
import { populationTreeOrder } from "./populations";

export { DEFAULT_ITERATION, normalizeIteration, type LayoutIteration } from "./layout";

/** One thing the template is drawn for: a file, or a population of one file, with what its placeholders read. */
export interface LayoutUnit {
  id: string;
  /** The display name: the file's (the metadata sample id, else the file name), or the population's. */
  name: string;
  fileName: string;
  groupName?: string;
  metadata?: Readonly<Record<string, string>>;
  /** Set for a population unit: the population the iterated items are drawn for, on `sampleName`'s file. */
  populationId?: string;
  sampleName?: string;
}

/** A concrete item on an expanded page: the template item bound to a unit and placed. */
export interface LayoutPageItem extends LayoutItem {
  /** The template item this was expanded from. */
  templateId: string;
  /** The unit this copy is drawn for, when the item follows the iteration. */
  unitId?: string;
  /** The file the template item was designed on, when the copy is drawn for another file. */
  templateSampleId?: string;
  /** The tile's offset from the template's position, to map an edit back. */
  offset: { x: number; y: number };
}

export interface LayoutPage {
  index: number;
  /** The units drawn on this page, in tile order. */
  units: LayoutUnit[];
  items: LayoutPageItem[];
}

/** Whether an item is drawn once per unit; text never is, but its placeholders are filled. */
export function followsIteration(item: LayoutItem): boolean {
  return isPlotLikeRecipe(item.recipe) && item.recipe.iterated === true;
}

/**
 * Fill `{sample}`, `{file}`, `{group}`, `{n}`, `{N}` and `{meta:<column>}` from a unit, and
 * `{population}` from a population unit. `{n}` is the unit's 1-based position and `{N}` the
 * number of units. Unknown placeholders are left as written, so a stray brace is not swallowed,
 * and `{population}` in a plot title is left for the plot to fill when the unit is a file.
 */
export function fillPlaceholders(text: string, unit: LayoutUnit | null, n: number, total: number): string {
  return text.replace(/\{(sample|file|group|population|n|N|meta:[^}]+)\}/g, (whole, key: string) => {
    if (key === "n") return String(n);
    if (key === "N") return String(total);
    if (!unit) return whole;
    if (key === "population") return unit.populationId ? unit.name : whole;
    if (key === "sample") return unit.sampleName ?? unit.name;
    if (key === "file") return unit.fileName;
    if (key === "group") return unit.groupName ?? "";
    if (key.startsWith("meta:")) return unit.metadata?.[key.slice(5).trim()] ?? "";
    return whole;
  });
}

function bindItem(item: LayoutItem, unit: LayoutUnit | null, n: number, total: number, offset: { x: number; y: number }, tileIndex: number): LayoutPageItem {
  const follows = followsIteration(item);
  const recipe = { ...item.recipe };
  let templateSampleId: string | undefined;
  // Text that reads from a plot takes the plot's placeholders later, from the plot as bound;
  // the unit fills only {n} and {N} for it, so an unknown column is not blanked first.
  if (recipe.kind === "text") recipe.text = fillPlaceholders(recipe.text, recipe.readsFrom ? null : unit, n, total);
  else {
    if (follows && unit && unit.populationId) {
      // A population unit: the same file, drawn for this population.
      if ("populationId" in recipe) recipe.populationId = unit.populationId;
    } else if (follows && unit && "sampleId" in recipe && recipe.sampleId !== unit.id) {
      templateSampleId = recipe.sampleId;
      recipe.sampleId = unit.id;
    }
    if (recipe.title) recipe.title = fillPlaceholders(recipe.title, unit, n, total);
  }
  return {
    ...item,
    id: tileIndex === 0 && !offset.x && !offset.y ? item.id : `${item.id}::${tileIndex}`,
    templateId: item.id,
    unitId: follows && unit ? unit.id : undefined,
    ...(templateSampleId ? { templateSampleId } : {}),
    x: item.x + offset.x,
    y: item.y + offset.y,
    offset,
    recipe,
  };
}

/** What a plot's placeholders read, from the app: the plot as bound, and the file it was designed on when drawn for another. */
export type DescribeBoundPlot = (recipe: LayoutPlotRecipe | LayoutStrategyRecipe, templateSampleId?: string) => PlotTitleContext | null;

/**
 * A text block that reads from a plot takes its placeholders from that plot as bound on the
 * same tile, so a heading over a column says what the plot beneath it shows, on every page.
 */
function fillBoundText(items: LayoutPageItem[], describe: DescribeBoundPlot | undefined): void {
  if (!describe) return;
  for (const item of items) {
    if (item.recipe.kind !== "text" || !item.recipe.readsFrom) continue;
    const readsFrom = item.recipe.readsFrom;
    const source = items.find((candidate) =>
      candidate.templateId === readsFrom && candidate.offset.x === item.offset.x && candidate.offset.y === item.offset.y);
    if (!source || !isPlotLikeRecipe(source.recipe)) continue;
    const context = describe(source.recipe, source.templateSampleId);
    if (context) item.recipe = { ...item.recipe, text: plotTitle(item.recipe.text, context) };
  }
}

/**
 * Expand a sheet over its units. With iteration off, one page: the template itself. One page
 * per unit: the template bound to each unit in turn. Tiles: the template's extent is the tile,
 * laid rows × columns per page with the gap, in row-major or column-major order; every item of
 * the template is in the tile, so headings written with placeholders label each tile. Text that
 * reads from a plot is filled from that plot as bound, when `describe` says what it shows.
 */
export function expandLayoutSheet(sheet: LayoutSheet, units: readonly LayoutUnit[], describe?: DescribeBoundPlot): LayoutPage[] {
  const pages = expandPages(sheet, units);
  for (const page of pages) fillBoundText(page.items, describe);
  return pages;
}

function expandPages(sheet: LayoutSheet, units: readonly LayoutUnit[]): LayoutPage[] {
  const iteration = sheet.iteration ?? DEFAULT_ITERATION;
  if (iteration.mode === "off" || !units.length) {
    return [{ index: 0, units: [], items: sheet.items.map((item) => bindItem(item, null, 1, 1, { x: 0, y: 0 }, 0)) }];
  }
  const total = units.length;
  if (iteration.arrangement.kind === "page-per-unit") {
    return units.map((unit, index) => ({
      index,
      units: [unit],
      items: sheet.items.map((item) => bindItem(item, unit, index + 1, total, { x: 0, y: 0 }, 0)),
    }));
  }
  const { rows, columns, order, gap } = iteration.arrangement;
  const bounds = contentBounds(sheet.items);
  if (!bounds) return [{ index: 0, units: [], items: [] }];
  const perPage = rows * columns;
  // The tile grid is anchored where the template sits; the tile step is the template's extent
  // plus the gap, so tiles never overlap whatever the page size.
  const stepX = bounds.width + gap;
  const stepY = bounds.height + gap;
  const pages: LayoutPage[] = [];
  for (let start = 0; start < total; start += perPage) {
    const pageUnits = units.slice(start, start + perPage);
    const items: LayoutPageItem[] = [];
    pageUnits.forEach((unit, tile) => {
      const row = order === "row-major" ? Math.floor(tile / columns) : tile % rows;
      const column = order === "row-major" ? tile % columns : Math.floor(tile / rows);
      const offset = { x: column * stepX, y: row * stepY };
      for (const item of sheet.items) items.push(bindItem(item, unit, start + tile + 1, total, offset, tile));
    });
    pages.push({ index: pages.length, units: pageUnits, items });
  }
  return pages;
}

/** The units an iteration draws, from the files the app knows, in the Samples pane's order. */
export function iterationUnits(
  iteration: LayoutIteration,
  files: readonly { id: string; name: string; fileName?: string; metadata?: Readonly<Record<string, string>> }[],
  checkedIds: readonly string[],
  groups: readonly { id: string; name: string }[],
  fileGroups: Readonly<Record<string, string>>,
): LayoutUnit[] {
  const unitOf = (file: (typeof files)[number]): LayoutUnit => ({
    id: file.id,
    name: file.name,
    fileName: file.fileName ?? file.name,
    groupName: groups.find((group) => group.id === fileGroups[file.id])?.name,
    metadata: file.metadata,
  });
  const source = iteration.source;
  return files
    .filter((file) => {
      if (source.kind === "all") return true;
      if (source.kind === "checked") return checkedIds.includes(file.id);
      if (source.kind === "group") return fileGroups[file.id] === source.groupId;
      return (file.metadata?.[source.column] ?? "") === source.value;
    })
    .map(unitOf);
}

/**
 * The units of a population iteration: every population of the tree but the root, in tree
 * order, or those under the chosen branch. All are drawn on the one file the iterated items name.
 */
export function populationUnits(
  iteration: LayoutIteration,
  tree: { populations: PopulationMap; root_population_id: string | null },
  file: { id: string; name: string; fileName?: string },
): LayoutUnit[] {
  const root = tree.root_population_id;
  const branch = iteration.populations?.kind === "branch" ? iteration.populations.populationId : null;
  const under = (popId: string): boolean => {
    if (!branch) return true;
    let cursor: string | null | undefined = tree.populations[popId]?.parent_id;
    while (cursor) {
      if (cursor === branch) return true;
      cursor = tree.populations[cursor]?.parent_id;
    }
    return false;
  };
  return populationTreeOrder(tree.populations, root)
    .filter(({ popId }) => popId !== root && under(popId))
    .map(({ popId }) => ({
      id: popId,
      name: tree.populations[popId]?.name ?? popId,
      fileName: file.fileName ?? file.name,
      sampleName: file.name,
      populationId: popId,
    }));
}

/** The template item and the tile offset a page item's id and frame refer to. */
export function templateFrame(pageItem: Pick<LayoutPageItem, "templateId" | "offset">, frame: { x: number; y: number; width: number; height: number }) {
  return { id: pageItem.templateId, x: frame.x - pageItem.offset.x, y: frame.y - pageItem.offset.y, width: frame.width, height: frame.height };
}
