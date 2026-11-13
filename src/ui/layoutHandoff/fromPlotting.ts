/**
 * The Plotting tab's hand-offs to Layout (moved from App.tsx): a chart as one block, or as a block
 * per panel with its legend below. App.tsx makes the sizers (plottingBlockSizer in
 * LayoutProportions.tsx) from the files and the gating ranges it holds.
 */
import { cloneLayoutWorkspace, layoutGridFrames, nextLayoutItemPosition, type LayoutProportionsPanel, type LayoutSheet, type LayoutWorkspace } from "../../engine/layout";
import type { ProportionsSettings } from "../../engine/proportionsSettings";
import { placeBlockOnPage } from "../layoutPlacement";
import type { PlottingPanelBlock } from "../plottingPanels";
import type { FigureLayout } from "./shared";

/** A block's frame size on a sheet, as plottingBlockSizer returns it. */
export type PlottingBlockSizer = (sheet: LayoutSheet, figure?: FigureLayout | null) => { width: number; height: number };

/** The Plotting tab's chart as one Layout block, at its natural size, on the active sheet; with `panel`, the page it names. */
export function addProportionsBlock(
  current: LayoutWorkspace,
  settings: ProportionsSettings,
  sizer: PlottingBlockSizer | null,
  figureLayout: FigureLayout,
  panel?: LayoutProportionsPanel,
): LayoutWorkspace {
  const next = cloneLayoutWorkspace(current);
  const sheet = next.sheets.find((s0) => s0.id === next.activeSheetId) ?? next.sheets[0];
  if (!sheet) return current;
  const size = sizer?.(sheet, figureLayout) ?? { width: 360, height: 280 };
  const frame = nextLayoutItemPosition(sheet, size.width, size.height);
  sheet.items.push({ id: crypto.randomUUID(), ...frame, recipe: { kind: "proportions", settings, ...(panel ? { panel } : {}), textSize: "sheet" } });
  sheet.width = Math.max(sheet.width, frame.x + frame.width + 48);
  sheet.height = Math.max(sheet.height, frame.y + frame.height + 48);
  return next;
}

/**
 * A Plotting chart as a block per panel on the Layout tab's current sheet, in the arrangement the
 * tab draws them in, below what the sheet holds, with the legend as a block of its own below
 * them. The blocks follow the sheet's file or metadata iteration when they differ only in their
 * populations; panels of different files or facets keep their own, since following would draw
 * them all alike. `blocks` is not empty (App.tsx returns before calling with none).
 */
export function addPlottingPanelBlocks(
  current: LayoutWorkspace,
  settings: ProportionsSettings,
  blocks: readonly PlottingPanelBlock[],
  panelSizer: PlottingBlockSizer | null,
  legendSizer: PlottingBlockSizer | null,
  figureLayout: FigureLayout,
): LayoutWorkspace {
  const next = cloneLayoutWorkspace(current);
  const sheet = next.sheets.find((s0) => s0.id === next.activeSheetId) ?? next.sheets[0];
  if (!sheet) return current;
  const size = panelSizer?.(sheet, figureLayout) ?? { width: 300, height: 300 };
  const frames = layoutGridFrames(sheet, blocks.map(({ row, column }) => ({ row, column })), size.width, size.height);
  const mode = sheet.iteration?.mode ?? "off";
  const panelKeys = new Set(blocks.map(({ panel }) => ("legend" in panel ? "" : `${panel.group ?? ""}\0${panel.facet ?? ""}`)));
  const follow = (mode === "files" || mode === "metadata") && panelKeys.size <= 1;
  const firstAdded = sheet.items.length;
  let z = Math.max(0, ...sheet.items.map((item) => item.z));
  const add = (panel: LayoutProportionsPanel, frame: { x: number; y: number; width: number; height: number }) =>
    sheet.items.push({ id: crypto.randomUUID(), ...frame, z: ++z, recipe: { kind: "proportions", settings, panel, textSize: "sheet", ...(follow ? { iterated: true } : {}) } });
  blocks.forEach((block, index) => add(block.panel, frames[index]));
  const legend = legendSizer?.(sheet, figureLayout);
  if (legend) {
    add({ legend: true }, {
      x: Math.min(...frames.map((frame) => frame.x)),
      y: Math.max(...frames.map((frame) => frame.y + frame.height)) + 12,
      width: legend.width,
      height: legend.height,
    });
  }
  placeBlockOnPage(sheet, sheet.items.slice(firstAdded));
  for (const item of sheet.items.slice(firstAdded)) {
    sheet.width = Math.max(sheet.width, item.x + item.width + 48);
    sheet.height = Math.max(sheet.height, item.y + item.height + 48);
  }
  return next;
}
