// The Plotting chart's population colours: twelve slots as everywhere else, then twelve more, and
// never two categories alike in one chart.

import { describe, expect, it } from "vitest";
import { OVERLAY_PALETTES, PLOTTING_COLOR_COUNT, plottingPopulationColors, populationColor, UNGATED_COLOR } from "./palettes";

describe("plottingPopulationColors", () => {
  it("gives slots 0 to 11 the colours every other view gives them", () => {
    for (const { value } of OVERLAY_PALETTES) {
      const slots = Array.from({ length: 12 }, (_, i) => i);
      expect(plottingPopulationColors(value, slots)).toEqual(slots.map((slot) => populationColor(value, slot)));
    }
  });

  it("gives up to 24 categories 24 different colours, none the rest-of-parent grey", () => {
    for (const { value } of OVERLAY_PALETTES) {
      const colors = plottingPopulationColors(value, Array.from({ length: PLOTTING_COLOR_COUNT }, (_, i) => i));
      expect(new Set(colors).size).toBe(PLOTTING_COLOR_COUNT);
      expect(colors).not.toContain(UNGATED_COLOR);
    }
  });

  it("moves a category whose slot colour is already in the chart to the next free one", () => {
    // Slots 0 and 24 share a colour; the second takes slot 1's, and slot 1 then slot 2's.
    const colors = plottingPopulationColors("paired", [0, 24, 1]);
    expect(new Set(colors).size).toBe(3);
    expect(colors[0]).toBe(populationColor("paired", 0));
    // Slot 12 used to repeat slot 0; it is a colour of its own now.
    expect(plottingPopulationColors("paired", [0, 12])[1]).not.toBe(populationColor("paired", 0));
  });
});
