// Several populations' plots merged into one Layout plot: the first with events leads, each in
// its population's colour, the legend in the order given. Synthetic values only.

import { describe, expect, it } from "vitest";
import { populationColor } from "../engine/palettes";
import { overlaidPlot } from "./LayoutTab";

describe("overlaidPlot", () => {
  it("leads with a population that has events and keeps the legend's order and colours", () => {
    const merged = overlaidPlot([
      { plot: { x: [], y: [], n_events: 0, x_label: "FSC-A" }, name: "DN", colorSlot: 3 },
      { plot: { x: [1, 2], y: [], n_events: 2 }, name: "DP", colorSlot: 1 },
      { plot: { x: [5], y: [], n_events: 1 }, name: "CD4_positive", colorSlot: 2 },
    ])!;
    expect(merged.config.x).toEqual([1, 2]);
    expect(merged.color).toBe(populationColor("default", 1));
    expect((merged.config.overlay_traces as { name: string }[]).map((t) => t.name)).toEqual(["DN", "CD4_positive"]);
    expect(merged.config.legend_entries).toEqual([
      { name: "DN", color: populationColor("default", 3) },
      { name: "DP", color: populationColor("default", 1) },
      { name: "CD4_positive", color: populationColor("default", 2) },
    ]);
    expect(merged.config.n_events).toBe(3);
  });

  it("draws a population in its own colour where it has one, as every tab does", () => {
    const merged = overlaidPlot([
      { plot: { x: [1, 2], y: [], n_events: 2 }, name: "DP", colorSlot: 1, color: "#123456" },
      { plot: { x: [5], y: [], n_events: 1 }, name: "CD4_positive", colorSlot: 2 },
    ])!;
    expect(merged.color).toBe("#123456");
    expect((merged.config.legend_entries as { color: string }[]).map((l) => l.color)).toEqual(["#123456", populationColor("default", 2)]);
  });

  it("takes the palette in turn when two populations share a colour", () => {
    const merged = overlaidPlot([
      { plot: { x: [1], y: [] }, name: "A", colorSlot: 1 },
      { plot: { x: [2], y: [] }, name: "B", colorSlot: 1 },
    ])!;
    expect((merged.config.legend_entries as { color: string }[]).map((l) => l.color)).toEqual(["#2671c6", "#bc642c"]);
    expect(overlaidPlot([])).toBeNull();
  });
});
