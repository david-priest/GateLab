// A new chart block on a Layout sheet arrived marked "too small" whenever its legend had two rows
// or more (2026-11-12): the frame counted a legend row at its font size + 9 px where the page
// draws it at 1.4 lines + 6 px with 4 px between rows, and left a boxplot's legend title out.
// The heights below are those the browser drew on the release candidate at an 11 px legend: a row
// 21.4 px at a canvas zoom of 100%, 22 px at the zooms that snap it to whole pixels, so a line is
// counted to the pixel above.

import { describe, expect, it } from "vitest";
import { BASE_PROPORTIONS_SETTINGS } from "../engine/proportionsSettings";
import type { ProportionsModel } from "../engine/proportionsModel";
import { chartLegendHeight, chartLegendWidth } from "./chart/ChartLegend";
import { proportionsBlockFrame } from "./LayoutProportions";

const model = (groups: string[], categories: string[]): ProportionsModel => ({
  catLevels: categories,
  perSample: groups.map((group) => ({ group, sample: group, counts: categories.map(() => 1), total: categories.length })) as never,
  hasFacet: false,
});

describe("a chart legend's size on a Layout page", () => {
  it("counts each row as the page draws it", () => {
    // Under the panels: the card's 10 px gap, the rule and padding (11 px), and rows of 22 px 4 px apart.
    expect(chartLegendHeight(1, 11)).toBe(43);
    expect(chartLegendHeight(2, 11)).toBe(69);
    expect(chartLegendHeight(3, 11)).toBe(95);
    // A title is a line of its own over the entries: 16 px and 4 px under it.
    expect(chartLegendHeight(2, 11, true)).toBe(89);
    // A row is never lower than its 12 px swatch.
    expect(chartLegendHeight(1, 5)).toBe(10 + 11 + 12 + 6);
  });

  it("is as wide as its longest label needs", () => {
    expect(chartLegendWidth(["CD4_positive"], 1, 11)).toBeGreaterThan(26 + 12 * 11 * 0.5);
    expect(chartLegendWidth(["a", "a_much_longer_population_name"], 2, 11)).toBeGreaterThan(2 * chartLegendWidth(["a_much_longer_population_name"], 1, 11));
    expect(chartLegendWidth(["a"], 1, 11, "A long title over one short entry")).toBeGreaterThan(chartLegendWidth(["a"], 1, 11));
  });
});

describe("the frame of a block that holds a chart's legend alone", () => {
  const stacked = { ...BASE_PROPORTIONS_SETTINGS, plotType: "stacked" as const, groupSel: "day", fontLegend: 11 };

  it("holds a stacked bar's three categories", () => {
    // The browser drew this legend 83 px high at 100% (rows of 21 px), 85 px with rows snapped to
    // 22 px, in a card of 10 px padding; the frame counts 4 px more than the card.
    expect(proportionsBlockFrame(stacked, model(["0", "7"], ["CD4_positive", "CD8_positive", "rest"]), null, { legend: true }).height).toBe(85 + 20 + 4);
  });

  it("counts the title over a boxplot's groups", () => {
    // Drawn 77 px high, 79 px with its lines snapped: the title's line over the two groups.
    const box = proportionsBlockFrame({ ...stacked, plotType: "box" }, model(["0", "7"], ["CD4_positive"]), null, { legend: true });
    expect(box.height).toBe(79 + 20 + 4);
    const untitled = proportionsBlockFrame({ ...stacked, plotType: "stacked" }, model(["0", "7"], ["CD4_positive", "CD8_positive"]), null, { legend: true });
    expect(box.height).toBeGreaterThan(untitled.height);
  });

  it("is wide enough for a long group name", () => {
    const short = proportionsBlockFrame({ ...stacked, plotType: "box" }, model(["0", "7"], ["CD4_positive"]), null, { legend: true });
    const long = proportionsBlockFrame({ ...stacked, plotType: "box" }, model(["control_donor_D1_batch_B1_day_0.fcs", "treated_donor_D2_batch_B2_day_7.fcs"], ["CD4_positive"]), null, { legend: true });
    expect(short.width).toBe(160 + 24);
    expect(long.width).toBeGreaterThan(26 + 35 * 11 * 0.5 + 24);
  });
});
