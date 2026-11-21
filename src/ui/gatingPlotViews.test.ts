// The Gating tab's set of plots: adding, selecting and removing one, and how they share the area.

import { describe, expect, it } from "vitest";
import type { CompanionPlotView } from "../plots/companionPlotPayload";
import { MAX_GATING_PLOTS, MAX_GRID_PLOT_SIDE, ONE_GATING_PLOT, addGatingPlot, plotGridLayout, plotGridShape, removeGatingPlot, selectGatingPlot } from "./gatingPlotViews";

const view = (populationId: string, xKey = "A", yKey = "B"): CompanionPlotView =>
  ({ populationId, selectedPopulationIds: [], xKey, yKey, histogram: false });

describe("adding a plot", () => {
  it("adds a copy of what the selected plot shows and selects it, leaving the plot the user was on as it was", () => {
    const two = addGatingPlot(ONE_GATING_PLOT, view("P1"));
    expect(two.slots.map((slot) => slot.view.populationId)).toEqual(["P1", "P1"]);
    expect(two.selected).toBe(1);
    expect(new Set(two.slots.map((slot) => slot.id)).size).toBe(2);
  });

  it("gives each plot an engine instance of its own, which selecting another plot does not change", () => {
    let plots = addGatingPlot(addGatingPlot(ONE_GATING_PLOT, view("P1")), view("P1"));
    expect(plots.slots.map((slot) => slot.instance)).toEqual([1, 2, 3]);
    plots = selectGatingPlot(plots, 0, view("P2")).plots;
    expect(plots.slots.map((slot) => slot.instance)).toEqual([1, 2, 3]);
    // A plot removed frees its instance for the next one added.
    plots = removeGatingPlot(plots, 1).plots;
    plots = addGatingPlot(plots, view("P3"));
    expect(plots.slots.map((slot) => slot.instance)).toEqual([1, 3, 2]);
  });

  it("stops at four", () => {
    let plots = ONE_GATING_PLOT;
    for (let i = 0; i < 6; i++) plots = addGatingPlot(plots, view(`P${i}`));
    expect(plots.slots).toHaveLength(MAX_GATING_PLOTS);
    expect(addGatingPlot(plots, view("more"))).toBe(plots);
  });
});

describe("selecting a plot", () => {
  it("keeps what the selected plot showed in its place and hands back the other plot's view to load", () => {
    const two = addGatingPlot(ONE_GATING_PLOT, view("P1"));
    // The second plot, selected, has since been moved to P2 on other channels.
    const next = selectGatingPlot(two, 0, view("P2", "C", "D"));
    expect(next.plots.selected).toBe(0);
    expect(next.load).toEqual(view("P1"));
    expect(next.plots.slots[1].view).toEqual(view("P2", "C", "D"));
  });

  it("does nothing for the plot already selected, or one that is not there", () => {
    const two = addGatingPlot(ONE_GATING_PLOT, view("P1"));
    expect(selectGatingPlot(two, 1, view("P2"))).toEqual({ plots: two, load: null });
    expect(selectGatingPlot(two, 5, view("P2"))).toEqual({ plots: two, load: null });
  });
});

describe("removing a plot", () => {
  const three = (() => {
    let plots = addGatingPlot(ONE_GATING_PLOT, view("P1"));
    plots = selectGatingPlot(plots, 0, view("P2")).plots;
    plots = addGatingPlot(plots, view("P1"));
    // slots: P1 (plot 1), P2 (plot 2), P1 (plot 3, selected)
    return plots;
  })();

  it("removes another plot without changing what the selected plot shows", () => {
    const next = removeGatingPlot(three, 0);
    expect(next.load).toBeNull();
    expect(next.plots.slots).toHaveLength(2);
    expect(next.plots.selected).toBe(1);
    expect(next.plots.slots[next.plots.selected].id).toBe(three.slots[2].id);
  });

  it("removes the selected plot and selects the one before it, whose view is loaded", () => {
    const next = removeGatingPlot(three, 2);
    expect(next.plots.selected).toBe(1);
    expect(next.load).toEqual(view("P2"));
  });

  it("removes the first plot when it is selected and selects the next", () => {
    const first = selectGatingPlot(three, 0, view("P3")).plots;
    const next = removeGatingPlot(first, 0);
    expect(next.plots.selected).toBe(0);
    expect(next.load).toEqual(view("P2"));
  });

  it("never removes the last plot", () => {
    expect(removeGatingPlot(ONE_GATING_PLOT, 0)).toEqual({ plots: ONE_GATING_PLOT, load: null });
  });
});

describe("how the plots share the area", () => {
  it("puts two side by side in a wide area and one above the other in a tall one", () => {
    expect(plotGridShape(2, 900, 500)).toEqual({ columns: 2, rows: 1 });
    expect(plotGridShape(2, 500, 900)).toEqual({ columns: 1, rows: 2 });
  });

  it("puts three and four two by two, whatever the area's shape", () => {
    expect(plotGridShape(3, 800, 700)).toEqual({ columns: 2, rows: 2 });
    expect(plotGridShape(4, 800, 700)).toEqual({ columns: 2, rows: 2 });
    expect(plotGridShape(4, 1800, 400)).toEqual({ columns: 2, rows: 2 });
    expect(plotGridShape(3, 1500, 420)).toEqual({ columns: 2, rows: 2 });
  });

  it("makes no cell larger than the largest plot the engine draws", () => {
    // A wide, tall area: fitted, two cells would be 830 px, with each plot 630 px in a corner.
    expect(plotGridLayout(2, 1788, 830, 10, null)).toEqual({ columns: 2, side: MAX_GRID_PLOT_SIDE + 32 });
    expect(plotGridLayout(2, 778, 700, 10, null)).toEqual({ columns: 2, side: 384 });
  });

  it("wraps plots set larger by the grip onto more rows when they no longer fit across", () => {
    expect(plotGridLayout(2, 1000, 700, 10, 400)).toEqual({ columns: 2, side: 432 });
    expect(plotGridLayout(2, 800, 700, 10, 400)).toEqual({ columns: 1, side: 432 });
    expect(plotGridLayout(4, 1000, 700, 10, 600)).toEqual({ columns: 1, side: 632 });
    expect(plotGridLayout(4, 1400, 700, 10, 600)).toEqual({ columns: 2, side: 632 });
    // Never larger than the engine draws.
    expect(plotGridLayout(2, 3000, 2000, 10, 900).side).toBe(MAX_GRID_PLOT_SIDE + 32);
  });

  it("gives one plot the whole area", () => {
    expect(plotGridShape(1, 800, 600)).toEqual({ columns: 1, rows: 1 });
  });
});
