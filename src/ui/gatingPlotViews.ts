// gatingPlotViews.ts — the Gating tab's plots, when it shows more than one.
//
// The tab holds one to four plots. One is selected, and it is the plot the app has always had:
// its population, channels and histogram view are the app's own state, so the tree, the gate
// list, the axis pickers and the draw tools act on it and on nothing else. The others each keep
// a view (CompanionPlotView) and are redrawn from it as the events change. Selecting another plot
// stores the selected plot's view in its place and loads that plot's view into the app's state.

import type { CompanionPlotView } from "../plots/companionPlotPayload";

export const MAX_GATING_PLOTS = 4;

export interface GatingPlotSlot {
  /** Stable for the life of the plot, so a plot keeps its place when another is removed. */
  id: number;
  /**
   * The engine instance (1 to 4) the plot draws with while it is not the selected one; kept for
   * the life of the plot, so selecting another plot leaves the plots that did not change drawn.
   */
  instance: number;
  /** What the plot shows while it is not the selected one; stale for the selected plot. */
  view: CompanionPlotView;
}

export interface GatingPlots {
  slots: readonly GatingPlotSlot[];
  /** Index into `slots` of the selected plot. */
  selected: number;
  nextId: number;
}

const EMPTY_VIEW: CompanionPlotView = { populationId: null, selectedPopulationIds: [], xKey: "", yKey: "", histogram: false, selectedGateId: null, selectedGateIds: [] };

export const ONE_GATING_PLOT: GatingPlots = { slots: [{ id: 1, instance: 1, view: EMPTY_VIEW }], selected: 0, nextId: 2 };

/**
 * One more plot, showing what the selected plot shows now, and selected: the plot the user
 * meant to change is the new one, and the plot they were on stays as it was.
 */
export function addGatingPlot(plots: GatingPlots, current: CompanionPlotView): GatingPlots {
  if (plots.slots.length >= MAX_GATING_PLOTS) return plots;
  const slots = plots.slots.map((slot, index) => (index === plots.selected ? { ...slot, view: current } : slot));
  const used = new Set(slots.map((slot) => slot.instance));
  let instance = 1;
  while (used.has(instance)) instance++;
  return {
    slots: [...slots, { id: plots.nextId, instance, view: current }],
    selected: slots.length,
    nextId: plots.nextId + 1,
  };
}

/**
 * The plots with `index` selected, and the view to load into the app's state when the selection
 * changed (null when it did not). `current` is what the selected plot shows now.
 */
export function selectGatingPlot(
  plots: GatingPlots,
  index: number,
  current: CompanionPlotView,
): { plots: GatingPlots; load: CompanionPlotView | null } {
  if (index === plots.selected || index < 0 || index >= plots.slots.length) return { plots, load: null };
  const slots = plots.slots.map((slot, at) => (at === plots.selected ? { ...slot, view: current } : slot));
  return { plots: { ...plots, slots, selected: index }, load: slots[index].view };
}

/**
 * The plots without the one at `index`. Removing the selected plot selects its neighbour (the
 * one before it, or the one after the first), whose view is returned to load.
 */
export function removeGatingPlot(
  plots: GatingPlots,
  index: number,
): { plots: GatingPlots; load: CompanionPlotView | null } {
  if (plots.slots.length <= 1 || index < 0 || index >= plots.slots.length) return { plots, load: null };
  const slots = plots.slots.filter((_, at) => at !== index);
  if (index !== plots.selected) {
    return { plots: { ...plots, slots, selected: plots.selected > index ? plots.selected - 1 : plots.selected }, load: null };
  }
  const selected = Math.max(0, index - 1);
  return { plots: { ...plots, slots, selected }, load: slots[selected].view };
}

export interface PlotGridShape {
  columns: number;
  rows: number;
}

/**
 * How `count` square plots share an area. Two take the arrangement with the larger cells: side by
 * side in a wide area, stacked in a tall one. Three and four are always two by two (David,
 * 2026-11-21).
 */
export function plotGridShape(count: number, width: number, height: number): PlotGridShape {
  const n = Math.max(1, Math.min(MAX_GATING_PLOTS, Math.floor(count)));
  if (n >= 3) return { columns: 2, rows: 2 };
  let best: PlotGridShape = { columns: n, rows: 1 };
  let bestSide = -1;
  for (let columns = n; columns >= 1; columns--) {
    const rows = Math.ceil(n / columns);
    const side = Math.min(width / columns, height / rows);
    // More columns win a tie: reading across is the habit, and the area is usually wider than tall.
    if (side > bestSide + 0.5) {
      best = { columns, rows };
      bestSide = side;
    }
  }
  return best;
}

/** The largest side the plot engine draws a plot at in a grid cell (loadPlots: PLOT_W's 630 px cap). */
export const MAX_GRID_PLOT_SIDE = 630;
/** A cell is 32 px larger than the plot drawn in it: the engine's Y-title gutter and the cell's padding. */
const CELL_MARGIN = 32;

/**
 * The grid's columns and its cells' side, in px, for `count` plots in an area `width` x `height`
 * with `gap` between cells. Fitted to the area, a cell is never larger than the largest plot the
 * engine draws: a larger cell left each plot in its top-left corner with a wide gap beside it (David,
 * 2026-11-21). A side set by the grip makes every cell that size, and the plots wrap onto more rows
 * when that many columns no longer fit across.
 */
export function plotGridLayout(count: number, width: number, height: number, gap: number, setSide: number | null): { columns: number; side: number } {
  const shape = plotGridShape(count, width, height);
  if (setSide) {
    const side = Math.min(setSide, MAX_GRID_PLOT_SIDE) + CELL_MARGIN;
    const fit = Math.max(1, Math.floor((width + gap) / (side + gap)));
    return { columns: Math.min(shape.columns, fit), side };
  }
  // Never under the engine's smallest plot and its margin; a smaller area scrolls.
  const fitted = Math.floor(Math.min(
    (width - (shape.columns - 1) * gap) / shape.columns,
    (height - (shape.rows - 1) * gap) / shape.rows,
  ));
  return { columns: shape.columns, side: Math.min(MAX_GRID_PLOT_SIDE + CELL_MARGIN, Math.max(336, fitted)) };
}
