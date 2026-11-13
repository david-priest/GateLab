/**
 * "Every page, one sheet each": a figure's or a chart's pages sent to Layout as a new sheet per
 * page, after the current sheet, each named by its page's label and made with the current
 * sheet's page size, margins and style. Each sheet is filled by the same hand-off the tab's button
 * uses for one page, run on that sheet as the active one. The Layout tab opens on the first new
 * sheet. App.tsx keeps the wiring (the undo seed, the dirty flag and the tab shown), so the whole
 * action is one Layout undo step.
 */
import { cloneLayoutWorkspace, createLayoutSheet, type LayoutGridHeadings, type LayoutPlotRecipe, type LayoutProportionsRecipe, type LayoutWorkspace } from "../../engine/layout";
import type { ProportionsSettings } from "../../engine/proportionsSettings";
import type { IllustrationConfig } from "../../engine/workspace";
import type { PlottingPanelBlock } from "../plottingPanels";
import { addFigureBlock } from "./fromIllustration";
import { addPlottingPanelBlocks, addProportionsBlock, type PlottingBlockSizer } from "./fromPlotting";
import { addPlotsToSheet, type FigureLayout, type HandoffGridCell, type PlotHandoffContext } from "./shared";

/** A name not among `taken`: the name itself, else the name followed by " (2)", " (3)" and so on. */
export function uniqueSheetName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} (${n})`)) n++;
  return `${name} (${n})`;
}

/**
 * A new sheet per label after the active sheet, each filled by `fill` with that sheet active, and
 * the first of them made active. A blank label names its sheet "Page n". Returns `current` when
 * there is no label or no sheet.
 */
export function addSheetPerPage(
  current: LayoutWorkspace,
  labels: readonly string[],
  fill: (workspace: LayoutWorkspace, index: number) => LayoutWorkspace,
): LayoutWorkspace {
  if (!labels.length) return current;
  const next = cloneLayoutWorkspace(current);
  const at = next.sheets.findIndex((sheet) => sheet.id === next.activeSheetId);
  const base = next.sheets[at] ?? next.sheets[0];
  if (!base) return current;
  const taken = new Set(next.sheets.map((sheet) => sheet.name));
  const made = labels.map((label, index) => {
    const name = uniqueSheetName(label.trim() || `Page ${index + 1}`, taken);
    taken.add(name);
    const sheet = createLayoutSheet(name, structuredClone(base.page));
    if (base.style) sheet.style = structuredClone(base.style);
    if (base.followFigureStyle !== undefined) sheet.followFigureStyle = base.followFigureStyle;
    return sheet;
  });
  next.sheets.splice(Math.max(0, at) + 1, 0, ...made);
  let filled: LayoutWorkspace = next;
  made.forEach((sheet, index) => {
    filled = fill({ ...filled, activeSheetId: sheet.id }, index);
  });
  return { ...filled, activeSheetId: made[0].id };
}

/** An Illustration figure, a sheet per page, each holding a figure block of that page. */
export function addFigurePageSheets(
  current: LayoutWorkspace,
  config: IllustrationConfig,
  labels: readonly string[],
  context: Parameters<typeof addFigureBlock>[2],
): LayoutWorkspace {
  return addSheetPerPage(current, labels, (workspace, index) => addFigureBlock(workspace, config, context, index));
}

/** One page's panels of an Illustration figure, as "Add panels to Layout" sends them for one page. */
export interface PanelPage {
  label: string;
  recipes: (LayoutPlotRecipe | LayoutProportionsRecipe)[];
  cells: HandoffGridCell[];
  headings: LayoutGridHeadings;
}

/** An Illustration figure's panels, a sheet per page, each holding that page's panels as the grid, with headings. */
export function addPanelPageSheets(
  current: LayoutWorkspace,
  pages: readonly PanelPage[],
  panelSize: number | undefined,
  context: PlotHandoffContext,
): LayoutWorkspace {
  return addSheetPerPage(current, pages.map((page) => page.label), (workspace, index) =>
    addPlotsToSheet(workspace, pages[index].recipes, pages[index].cells, pages[index].headings, panelSize, context));
}

/** A Plotting chart, a sheet per page, each holding a block of the chart that draws that page. */
export function addChartPageSheets(
  current: LayoutWorkspace,
  settings: ProportionsSettings,
  pages: readonly { label: string; page: string }[],
  sizerFor: (page: string) => PlottingBlockSizer | null,
  figureLayout: FigureLayout,
): LayoutWorkspace {
  return addSheetPerPage(current, pages.map((page) => page.label), (workspace, index) =>
    addProportionsBlock(workspace, settings, sizerFor(pages[index].page), figureLayout, { page: pages[index].page }));
}

/** A Plotting chart's panels, a sheet per page, each holding a block per panel of that page and the legend. */
export function addChartPanelPageSheets(
  current: LayoutWorkspace,
  settings: ProportionsSettings,
  pages: readonly { label: string; blocks: readonly PlottingPanelBlock[] }[],
  panelSizerFor: (blocks: readonly PlottingPanelBlock[]) => PlottingBlockSizer | null,
  legendSizer: PlottingBlockSizer | null,
  figureLayout: FigureLayout,
): LayoutWorkspace {
  const shown = pages.filter((page) => page.blocks.length);
  return addSheetPerPage(current, shown.map((page) => page.label), (workspace, index) =>
    addPlottingPanelBlocks(workspace, settings, shown[index].blocks, panelSizerFor(shown[index].blocks), legendSizer, figureLayout));
}
