// Where a Plotting chart's panels sit: wrapped a set number to a row, or a column per value of one
// of the chart's panel dimensions. Synthetic panel values only.

import { describe, expect, it } from "vitest";
import { arrangedSize, arrangePanels, chartPageDimension, chartPanelDimensions, headedPanelTitle, headingSizes, isPageSelector, matchingPanels, onlyPanelText, pageAsPanels, pagePanels, PANEL_GAP, panelDimensionText, placedOrOnly, type PanelValues } from "./panelArrangement";

interface P {
  facet: string;
  population: string;
}

const panels: P[] = [
  { facet: "D1", population: "CD4_positive" },
  { facet: "D1", population: "CD8_positive" },
  { facet: "D2", population: "CD4_positive" },
  { facet: "D3", population: "CD8_positive" },
];
const value = (panel: P, dimension: string) => (dimension === "facet" ? panel.facet : panel.population);

describe("arrangePanels", () => {
  it("wraps the panels in order, a set number to a row, never more columns than panels", () => {
    expect(arrangePanels(panels, value, ["facet", "populations"], "", 3)).toEqual({ columns: 3, cells: panels });
    expect(arrangePanels(panels, value, ["facet", "populations"], "", 12).columns).toBe(4);
    expect(arrangePanels(panels, value, ["facet", "populations"], "", 0).columns).toBe(1);
  });

  it("gives each value of the chosen dimension a column and each value of the other a row, leaving gaps empty", () => {
    const placed = arrangePanels(panels, value, ["facet", "populations"], "populations", 5);
    expect(placed.columns).toBe(2);
    expect(placed.cells).toEqual([panels[0], panels[1], panels[2], null, null, panels[3]]);
    const byFacet = arrangePanels(panels, value, ["facet", "populations"], "facet", 5);
    expect(byFacet.columns).toBe(3);
    expect(byFacet.cells).toEqual([panels[0], panels[2], null, panels[1], null, panels[3]]);
  });

  it("gives each value of the row dimension a row, the other dimension across the columns", () => {
    const byRow = arrangePanels(panels, value, ["facet", "populations"], "", 5, "facet");
    expect(byRow.columns).toBe(2);
    expect(byRow.cells).toEqual([panels[0], panels[1], panels[2], null, null, panels[3]]);
    expect(byRow.headings).toBeUndefined();
  });

  it("makes a grid by rows and columns, headed above each column and beside each row", () => {
    const heading = (panel: P, dimension: string) => (dimension === "facet" ? `donor: ${panel.facet}` : panel.population);
    const grid = arrangePanels(panels, value, ["facet", "populations"], "populations", 5, "facet", heading);
    expect(grid.columns).toBe(2);
    expect(grid.cells).toEqual([panels[0], panels[1], panels[2], null, null, panels[3]]);
    expect(grid.headings).toEqual({ column: "populations", row: "facet", columns: ["CD4_positive", "CD8_positive"], rows: ["donor: D1", "donor: D2", "donor: D3"] });
    // The same dimension on both is a column only.
    expect(arrangePanels(panels, value, ["facet", "populations"], "populations", 5, "populations", heading).headings).toBeUndefined();
    // The headings take a line above the columns and a width beside the rows.
    const sizes = headingSizes(grid, 10);
    expect(sizes.top).toBeGreaterThan(10);
    expect(sizes.left).toBeGreaterThanOrEqual(40);
    expect(arrangedSize(grid, 200, 150, 10)).toEqual({ width: sizes.left + PANEL_GAP + 2 * 200 + PANEL_GAP, height: sizes.top + PANEL_GAP + 3 * 150 + 2 * PANEL_GAP });
  });

  it("leaves out of a headed panel's title what its headings say", () => {
    const panel = { facet: "D1", group: "treated", population: "CD4_positive" };
    const headings = { column: "populations" as const, row: "facet" as const, columns: [], rows: [] };
    expect(headedPanelTitle(panel, ["facet", "populations"], headings, { facet: "donor" })).toBe("");
    expect(headedPanelTitle(panel, ["facet", "groups"], { ...headings, column: "groups" as const, row: "groups" as const }, { group: "condition", facet: "donor" })).toBe("donor: D1");
    expect(panelDimensionText(panel, "groups", { group: "condition" })).toBe("condition: treated");
    expect(panelDimensionText({ ...panel, facet: "" }, "facet", {})).toBe("(NA)");
  });

  it("wraps when the chosen dimension is not one the chart has", () => {
    expect(arrangePanels(panels, value, ["populations"], "facet", 2)).toEqual({ columns: 2, cells: panels });
  });
});

describe("chartPanelDimensions", () => {
  it("lists the dimensions each chart has a panel per", () => {
    expect(chartPanelDimensions({ valueKind: "proportion", plotType: "stacked", xAxis: "populations" }, false)).toEqual([]);
    expect(chartPanelDimensions({ valueKind: "proportion", plotType: "box", xAxis: "groups" }, true)).toEqual(["facet", "populations"]);
    expect(chartPanelDimensions({ valueKind: "cells", plotType: "violin", xAxis: "populations" }, false)).toEqual(["groups"]);
    expect(chartPanelDimensions({ valueKind: "cells", plotType: "violin", xAxis: "groups" }, true)).toEqual(["facet", "populations"]);
  });
});

describe("arrangedSize", () => {
  it("counts the gaps between panels, not around them", () => {
    const placed = arrangePanels(panels, value, ["facet", "populations"], "populations", 5);
    expect(arrangedSize(placed, 200, 150)).toEqual({ width: 2 * 200 + PANEL_GAP, height: 3 * 150 + 2 * PANEL_GAP });
  });
});

describe("matchingPanels", () => {
  // Two populations of one name, told apart only by their ids.
  const twins: PanelValues[] = [
    { facet: null, group: null, population: "Ki67_positive", populationId: "p1" },
    { facet: null, group: null, population: "Ki67_positive", populationId: "p2" },
  ];
  it("matches a population by id where the block records it, by name otherwise", () => {
    expect(matchingPanels(twins, { population: "Ki67_positive", populationId: "p2" }, (p) => p)).toEqual([twins[1]]);
    expect(matchingPanels(twins, { population: "Renamed", populationId: "p1" }, (p) => p)).toEqual([twins[0]]);
    expect(matchingPanels(twins, { population: "Ki67_positive" }, (p) => p)).toEqual(twins);
    // An id the chart does not hold falls back to the name.
    expect(matchingPanels(twins, { population: "Ki67_positive", populationId: "gone" }, (p) => p)).toEqual(twins);
    expect(matchingPanels(twins, { legend: true }, (p) => p)).toEqual([]);
  });
  it("draws only the first panel a block matches", () => {
    expect(placedOrOnly({ columns: 2, cells: twins }, twins, { population: "Ki67_positive" }, (p) => p)).toEqual({ columns: 1, cells: [twins[0]] });
  });
});

describe("pages", () => {
  const values: PanelValues[] = [
    { facet: "D1", group: "control", population: null },
    { facet: "D1", group: "treated", population: null },
    { facet: "D2", group: "control", population: null },
    { facet: "D2", group: "treated", population: null },
  ];
  it("takes a page's panels by the value of the page dimension, and every panel without a page", () => {
    expect(pagePanels(values, "facet", "D2", (p) => p)).toEqual(values.slice(2));
    expect(pagePanels(values, "groups", "treated", (p) => p)).toEqual([values[1], values[3]]);
    expect(pagePanels(values, "facet", undefined, (p) => p)).toEqual(values);
    expect(pagePanels(values, "", "D2", (p) => p)).toEqual(values);
  });
  it("pages by a dimension only where the chart has it", () => {
    expect(chartPageDimension({ valueKind: "cells", plotType: "violin", xAxis: "populations", pageBy: "groups" }, false)).toBe("groups");
    // With the groups along x, a panel per population: no page per group.
    expect(chartPageDimension({ valueKind: "cells", plotType: "violin", xAxis: "groups", pageBy: "groups" }, false)).toBe("");
    expect(chartPageDimension({ valueKind: "proportion", plotType: "stacked", xAxis: "populations", pageBy: "facet" }, false)).toBe("");
  });
  it("tells a page's selector from a panel's, and finds the page's panels with it", () => {
    expect(isPageSelector({ page: "D1" })).toBe(true);
    expect(isPageSelector({ page: "D1", group: "control" })).toBe(false);
    expect(isPageSelector({ legend: true })).toBe(false);
    expect(isPageSelector(undefined)).toBe(false);
    expect(matchingPanels(values, pageAsPanels({ page: "D1" }, "facet")!, (p) => p)).toEqual(values.slice(0, 2));
    expect(pageAsPanels({ page: "D1" }, "")).toBeUndefined();
    expect(pageAsPanels({ group: "control" }, "facet")).toEqual({ group: "control" });
    expect(onlyPanelText({ page: "D1" })).toBe("page D1");
  });

  it("matches a channel's panel by its channel, and pages by channel", () => {
    const both: PanelValues[] = [
      { facet: null, group: "control", population: null, channel: "FSC-A" },
      { facet: null, group: "control", population: null, channel: "SSC-A" },
    ];
    expect(matchingPanels(both, { channel: "SSC-A", group: "control" }, (p) => p)).toEqual([both[1]]);
    expect(matchingPanels(both, pageAsPanels({ page: "FSC-A" }, "channels")!, (p) => p)).toEqual([both[0]]);
    expect(onlyPanelText({ channel: "SSC-A", group: "control" })).toBe("SSC-A, control");
    expect(panelDimensionText(both[1], "channels", { channels: { "SSC-A": "SSC-A (side scatter)" } })).toBe("SSC-A (side scatter)");
  });
});
