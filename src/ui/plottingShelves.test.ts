// A Plotting chart's dimensions on the Arrange dimensions shelves: a saved chart of each kind is
// shown as it draws, and a move writes the settings the chart already reads.

import { describe, expect, it } from "vitest";
import { chartShelfAllowed, chartShelves, placeChartDimension } from "./plottingShelves";
import type { ChartShelfSettings } from "./plottingShelves";

const settings = (patch: Partial<ChartShelfSettings>): ChartShelfSettings => ({ valueKind: "proportion", plotType: "stacked", xAxis: "populations", panelColumns: "", ...patch });

describe("chart shelves", () => {
  it("shows a saved chart of each kind as it draws", () => {
    // A stacked bar: the groups along x, the populations its stack, a panel per facet.
    expect(chartShelves(settings({}), true)).toEqual({ x: ["groups"], columns: [], rows: [], pages: [], wrap: ["facet"], stack: true });
    // A proportion boxplot: the groups along x, a panel per facet and population.
    expect(chartShelves(settings({ plotType: "box", panelColumns: "populations" }), true)).toEqual({ x: ["groups"], columns: ["populations"], rows: [], pages: [], wrap: ["facet"], stack: false });
    // A per-cell chart with the populations along x: a panel per group.
    expect(chartShelves(settings({ valueKind: "cells", plotType: "violin", panelColumns: "groups" }), false)).toEqual({ x: ["populations"], columns: ["groups"], rows: [], pages: [], wrap: [], stack: false });
    // A statistic chart's saved column dimension that is along x is not a column: it draws wrapped.
    expect(chartShelves(settings({ valueKind: "statistic", plotType: "box", xAxis: "groups", panelColumns: "groups" }), false)).toEqual({ x: ["groups"], columns: [], rows: [], pages: [], wrap: ["populations"], stack: false });
  });

  it("keeps a proportion chart's groups along x and a stacked bar's populations as its stack", () => {
    const stacked = settings({});
    expect(chartShelfAllowed(stacked, "groups", "columns")).toBe(false);
    expect(chartShelfAllowed(stacked, "populations", "columns")).toBe(false);
    expect(chartShelfAllowed(stacked, "facet", "columns")).toBe(true);
    const box = settings({ plotType: "box" });
    expect(chartShelfAllowed(box, "populations", "columns")).toBe(true);
    expect(chartShelfAllowed(box, "populations", "x")).toBe(false);
    expect(placeChartDimension(box, true, "populations", "x")).toEqual({});
  });

  it("puts a dimension on Columns or back to wrapping", () => {
    const box = settings({ plotType: "box" });
    expect(placeChartDimension(box, true, "facet", "columns")).toEqual({ panelColumns: "facet" });
    expect(placeChartDimension(settings({ plotType: "box", panelColumns: "facet" }), true, "facet", "wrap")).toEqual({ panelColumns: "" });
    expect(placeChartDimension(settings({ plotType: "box", panelColumns: "facet" }), true, "populations", "wrap")).toEqual({});
  });

  it("puts a dimension on Rows, taking it off Columns, and keeps a saved Rows when it draws", () => {
    const box = settings({ plotType: "box", panelColumns: "populations" });
    expect(placeChartDimension(box, true, "facet", "rows")).toEqual({ panelRows: "facet" });
    expect(chartShelves({ ...box, panelRows: "facet" }, true)).toEqual({ x: ["groups"], columns: ["populations"], rows: ["facet"], pages: [], wrap: [], stack: false });
    // The column dimension moved to Rows leaves Columns; the one on Rows moved back to the wrap leaves Rows.
    expect(placeChartDimension({ ...box, panelRows: "facet" }, true, "populations", "rows")).toEqual({ panelColumns: "", panelRows: "populations" });
    expect(placeChartDimension({ ...box, panelRows: "facet" }, true, "facet", "wrap")).toEqual({ panelRows: "" });
    // A saved Rows that is also the Columns, or a dimension the chart has not, is not a row.
    expect(chartShelves({ ...box, panelRows: "populations" }, true).rows).toEqual([]);
    expect(chartShelves({ ...box, panelRows: "facet" }, false).rows).toEqual([]);
    // The groups leaving Rows for x give their row to the populations.
    const cells = settings({ valueKind: "cells", plotType: "violin", xAxis: "populations", panelRows: "groups" });
    expect(placeChartDimension(cells, false, "groups", "x")).toEqual({ xAxis: "groups", panelRows: "populations" });
  });

  it("swaps the populations and the groups along x of a per-cell or statistic chart", () => {
    const cells = settings({ valueKind: "cells", plotType: "violin", xAxis: "populations", panelColumns: "groups" });
    // The groups come along x from Columns; the populations take their column.
    expect(placeChartDimension(cells, false, "groups", "x")).toEqual({ xAxis: "groups", panelColumns: "populations" });
    // The populations leave x for the wrap: the groups come along x and leave Columns.
    expect(placeChartDimension(cells, false, "populations", "wrap")).toEqual({ xAxis: "groups", panelColumns: "" });
    // The populations leave x for Columns.
    expect(placeChartDimension(settings({ valueKind: "statistic", plotType: "box" }), false, "populations", "columns")).toEqual({ xAxis: "groups", panelColumns: "populations" });
    // A facet never runs along x.
    expect(chartShelfAllowed(cells, "facet", "x")).toBe(false);
    expect(placeChartDimension(cells, true, "facet", "x")).toEqual({});
  });

  it("puts a dimension on Pages, taking it off Columns or Rows, and keeps a saved Pages when it draws", () => {
    const box = settings({ plotType: "box", panelColumns: "populations" });
    expect(placeChartDimension(box, true, "facet", "pages")).toEqual({ pageBy: "facet" });
    expect(chartShelves({ ...box, pageBy: "facet" }, true)).toEqual({ x: ["groups"], columns: ["populations"], rows: [], pages: ["facet"], wrap: [], stack: false });
    // The column dimension moved to Pages leaves Columns; the page dimension moved to Rows leaves Pages.
    expect(placeChartDimension({ ...box, pageBy: "facet" }, true, "populations", "pages")).toEqual({ panelColumns: "", pageBy: "populations" });
    expect(placeChartDimension({ ...box, pageBy: "facet" }, true, "facet", "rows")).toEqual({ panelRows: "facet", pageBy: "" });
    // A saved Pages that is also the Columns, or a dimension the chart has not, is not a page.
    expect(chartShelves({ ...box, pageBy: "populations" }, true).pages).toEqual([]);
    expect(chartShelves({ ...box, pageBy: "facet" }, false).pages).toEqual([]);
    // The groups leaving Pages for x give their pages to the populations.
    const stat = settings({ valueKind: "statistic", plotType: "box", xAxis: "populations", pageBy: "groups" });
    expect(placeChartDimension(stat, false, "groups", "x")).toEqual({ xAxis: "groups", pageBy: "populations" });
  });

  it("puts a chart's several channels on a panel shelf, never along x", () => {
    const cells = settings({ valueKind: "cells", plotType: "violin", xAxis: "populations", channel: "FSC-A", channels: ["FSC-A", "SSC-A"] });
    expect(chartShelves(cells, false)).toEqual({ x: ["populations"], columns: [], rows: [], pages: [], wrap: ["channels", "groups"], stack: false });
    expect(chartShelfAllowed(cells, "channels", "x")).toBe(false);
    expect(placeChartDimension(cells, false, "channels", "columns")).toEqual({ panelColumns: "channels" });
    // One channel is no dimension; a proportion chart has none.
    expect(chartShelves({ ...cells, channels: ["FSC-A"] }, false).wrap).toEqual(["groups"]);
    expect(chartShelves({ ...cells, valueKind: "proportion", plotType: "box" }, false).wrap).toEqual(["populations"]);
  });
});
