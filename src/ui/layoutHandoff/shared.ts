/**
 * What the Layout hand-offs share (moved from App.tsx): plots placed on the active sheet, each in
 * the next free place or as a grid with headings. These functions take the current Layout
 * workspace and return the next one; App.tsx keeps the wiring (the undo seed, the dirty flag and
 * the tab shown).
 */
import {
  cloneLayoutWorkspace,
  layoutGridFrames,
  nextLayoutItemPosition,
  normalizeLayoutStyle,
  type LayoutGridCell,
  type LayoutGridHeading,
  type LayoutGridHeadings,
  type LayoutPlotRecipe,
  type LayoutPlotStyle,
  type LayoutProportionsRecipe,
  type LayoutWorkspace,
} from "../../engine/layout";
import { plotTitle, plotTitleContext } from "../../engine/layoutTitle";
import { sampleDisplayId } from "../../engine/metadata";
import { followSheetIteration } from "../layoutFollow";
import { placeBlockOnPage, styleBeyondSheet } from "../layoutPlacement";
import { fitLayoutText } from "../layoutTextFit";

/** The workspace's figure style as Layout style fields (figureLayoutFields in figureStyle.tsx). */
export type FigureLayout = Partial<LayoutPlotStyle>;

/** The loaded files and what is known of them, as App.tsx holds them. */
export interface HandoffFiles<S extends { id: string; name: string } = { id: string; name: string }> {
  samples: readonly S[];
  metadata: Record<string, Record<string, string>>;
  hierarchyOfFile: (id: string) => string;
}

/** What placing plots reads besides the workspace: the files, their trees, and the figure style. */
export interface PlotHandoffContext extends HandoffFiles {
  treeOf: (hierarchyId: string) => { populations: Readonly<Record<string, { name: string }>> } | null;
  populationMetadata: Readonly<Record<string, Readonly<Record<string, string>>>>;
  figureLayout: FigureLayout;
}

/** A cell of a grid of plots put on a sheet, and how many rows and columns of the grid a plot there spans (an Illustration summary panel); absent, one. */
export type HandoffGridCell = LayoutGridCell & { span?: { rows: number; columns: number } };

/**
 * Plots on the Layout tab's current sheet. With `cells`, one per recipe, they keep the
 * arrangement they had where they came from, as a grid below what the sheet holds; without,
 * each takes the next free place on the page. Returns `current` when the workspace has no sheet.
 */
export function addPlotsToSheet(
  current: LayoutWorkspace,
  recipes: readonly (LayoutPlotRecipe | LayoutProportionsRecipe)[],
  cells: readonly HandoffGridCell[] | undefined,
  headings: LayoutGridHeadings | undefined,
  panelSize: number | undefined,
  context: PlotHandoffContext,
): LayoutWorkspace {
  const { samples, metadata, hierarchyOfFile, treeOf, populationMetadata, figureLayout } = context;
  const next = cloneLayoutWorkspace(current);
  const sheet = next.sheets.find((s0) => s0.id === next.activeSheetId) ?? next.sheets[0];
  if (!sheet) return current;
  // A grid from the Illustration tab keeps its panels' size: the frame holds the plot drawn at
  // that size inside the plot host's 8 px inset.
  const cellSize = panelSize && panelSize > 0 ? panelSize + 8 : null;
  const frames = cells && cells.length === recipes.length
    ? (cellSize ? layoutGridFrames(sheet, cells, cellSize, cellSize) : layoutGridFrames(sheet, cells))
    : null;
  // A plot spanning cells takes their frames and the 12 px between them (layoutGridFrames).
  if (frames && cells)
    cells.forEach((cell, index) => {
      if (!cell.span) return;
      frames[index].width += (cell.span.columns - 1) * (frames[index].width + 12);
      // Spanning rows only, a summary is one panel high, as the figure draws it (FigureGrid's summaryFrame).
      if (cell.span.columns > 1) frames[index].height += (cell.span.rows - 1) * (frames[index].height + 12);
    });
  const firstIn = (pick: (cell: LayoutGridCell) => boolean, order: (cell: LayoutGridCell) => number): number => {
    let best = -1;
    cells?.forEach((cell, index) => { if (pick(cell) && (best < 0 || order(cell) < order(cells[best]))) best = index; });
    return best;
  };
  // Headings sit above the columns and left of the rows, so the grid moves down and right to
  // leave them room; each reads the first plot of its column or row. Each heading's frame is
  // sized to the text the Layout tab will draw in it (its template filled from that plot), so
  // none arrives clipped: a row heading takes its text's width, wrapping past 320 px, and a
  // column heading wraps within its column and grows down.
  const headingFontSize = 14;
  const drawnHeading = (heading: LayoutGridHeading, index: number): string => {
    const recipe = recipes[index];
    // A chart block (an Illustration chart panel) reads no file; its heading is written out.
    if (!recipe || recipe.kind === "proportions") return heading.text;
    const entry = samples.find(({ id }) => id === recipe.sampleId);
    if (!heading.template || !entry) return heading.text;
    const population = treeOf(hierarchyOfFile(entry.id))?.populations[recipe.populationId];
    const file = { name: sampleDisplayId(entry.name, metadata[entry.id]), fileName: entry.name, metadata: metadata[entry.id] };
    return plotTitle(heading.template, plotTitleContext(recipe, file, population ? { id: recipe.populationId, name: population.name } : null, undefined, populationMetadata)) || heading.text;
  };
  const columnFirst = (headings?.columns ?? []).map((_, column) => firstIn((cell) => cell.column === column, (cell) => cell.row));
  const rowFirst = (headings?.rows ?? []).map((_, row) => firstIn((cell) => cell.row === row, (cell) => cell.column));
  const columnFits = frames ? (headings?.columns ?? []).map((heading, column) => fitLayoutText(drawnHeading(heading, columnFirst[column]), headingFontSize, frames[0].width)) : [];
  const rowFits = frames ? (headings?.rows ?? []).map((heading, row) => fitLayoutText(drawnHeading(heading, rowFirst[row]), headingFontSize, 320)) : [];
  const columnHeight = Math.max(28, ...columnFits.map((fit) => fit?.height ?? 0));
  const rowWidth = rowFits.every(Boolean) ? Math.max(0, ...rowFits.map((fit) => fit!.width)) : 138;
  const headRoom = frames && headings?.columns.length ? columnHeight + 6 : 0;
  const sideRoom = frames && headings?.rows.length ? rowWidth + 12 : 0;
  if (frames) for (const frame of frames) { frame.y += headRoom; frame.x += sideRoom; }
  const ids: string[] = [];
  const firstAdded = sheet.items.length;
  followSheetIteration(sheet, recipes).forEach((recipe, index) => {
    const frame = frames ? frames[index] : nextLayoutItemPosition(sheet);
    const id = crypto.randomUUID();
    ids.push(id);
    const style = recipe.kind === "proportions" ? undefined : styleBeyondSheet(sheet, recipe.style && normalizeLayoutStyle(recipe.style), figureLayout);
    const rest = recipe.kind === "proportions" ? recipe : (({ style: _given, ...plot }) => plot)(recipe);
    const item = { id, ...frame, recipe: style ? { ...rest, style } : rest };
    sheet.items.push(item);
    // A plot placed alone goes onto a page; a grid goes as one block, below.
    if (!frames) placeBlockOnPage(sheet, [item]);
  });
  if (frames && cells && headings) {
    let z = Math.max(0, ...sheet.items.map((item) => item.z));
    const label = (heading: LayoutGridHeading, index: number, frame: { x: number; y: number; width: number; height: number }) => {
      // A chart block reads no file or population, so a heading over one is written out, as it was sized.
      const template = recipes[index]?.kind === "proportions" ? undefined : heading.template;
      sheet.items.push({
        id: crypto.randomUUID(), ...frame, z: ++z,
        recipe: { kind: "text", text: template ?? heading.text, fontSize: headingFontSize, ...(template ? { readsFrom: ids[index] } : {}) },
      });
    };
    headings.columns.forEach((heading, column) => {
      const index = columnFirst[column];
      if (index >= 0) label(heading, index, { x: frames[index].x, y: frames[index].y - headRoom, width: Math.max(frames[index].width, columnFits[column]?.width ?? 0), height: columnFits[column]?.height ?? 28 });
    });
    headings.rows.forEach((heading, row) => {
      const index = rowFirst[row];
      if (index >= 0) label(heading, index, { x: frames[index].x - sideRoom, y: frames[index].y, width: sideRoom - 12, height: Math.max(28, rowFits[row]?.height ?? 0) });
    });
  }
  if (frames) placeBlockOnPage(sheet, sheet.items.slice(firstAdded));
  for (const item of sheet.items.slice(firstAdded)) {
    sheet.width = Math.max(sheet.width, item.x + item.width + 48);
    sheet.height = Math.max(sheet.height, item.y + item.height + 48);
  }
  return next;
}
