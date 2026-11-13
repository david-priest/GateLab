// The heading of a panel that overlays chosen populations. Synthetic populations only.

import { describe, expect, it } from "vitest";
import type { FigurePage, FigurePanel, FigurePlot, FigureValue } from "../engine/figure";
import { headOverlaidPopulations, overlayHeading } from "./overlayHeading";

const ref = (label: string) => ({ hierarchyId: "h", populationId: label, label });
const population = (label: string): FigureValue => ({ dimension: "populations", id: "0", label });
const plotValue = (plot: FigurePlot): FigureValue => ({ dimension: "plots", id: plot.id, label: plot.name });

describe("overlayHeading", () => {
  it("joins the populations in the order chosen", () => {
    expect(overlayHeading(["CD8_positive", "CD4_positive"])).toBe("CD8_positive, CD4_positive");
  });
  it("is the plot's name when the joined names are too long, else the first and how many more", () => {
    const names = ["CD4_positive", "CD8_positive", "CD4_CD8_double_negative", "CD4_CD8_double_positive"];
    expect(overlayHeading(names, "Quadrants")).toBe("Quadrants");
    expect(overlayHeading(names)).toBe("CD4_positive + 3 more");
    expect(overlayHeading(names, " ")).toBe("CD4_positive + 3 more");
  });
});

describe("headOverlaidPopulations", () => {
  const overlay: FigurePlot = { id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram", populations: [ref("Q1"), ref("Q2")] };
  const single: FigurePlot = { id: "quad", name: "Quadrants", x: "FSC-A", y: "SSC-A", type: "biplot" };
  const panel = (plot: FigurePlot, row: number, column: number): FigurePanel => ({
    key: `${row}-${column}`, samples: ["D1"], population: ref("All Events"), plot, row, column,
    ...(plot.populations ? { populations: plot.populations } : {}),
  });

  it("heads a row of overlaid panels by their populations, and leaves the other rows as they were", () => {
    const page: FigurePage = {
      key: "[]", label: "Figure",
      rows: [[population("All Events"), plotValue(single)], [population("All Events"), plotValue(overlay)]],
      columns: [[{ dimension: "samples", id: "D1", label: "D1.fcs" }]],
      panels: [panel(single, 0, 0), panel(overlay, 1, 0)],
    };
    const headed = headOverlaidPopulations(page);
    expect(headed.rows.map((group) => group.map((value) => value.label))).toEqual([["All Events", "Quadrants"], ["Q1, Q2", "Size"]]);
    expect(headed.columns).toEqual(page.columns);
    expect(headed.panels).toBe(page.panels);
  });

  it("leaves a heading over panels that draw different populations as it was", () => {
    const page: FigurePage = {
      key: "[]", label: "Figure",
      rows: [[population("All Events")]],
      columns: [[plotValue(single)], [plotValue(overlay)]],
      panels: [panel(single, 0, 0), panel(overlay, 0, 1)],
    };
    expect(headOverlaidPopulations(page).rows).toEqual(page.rows);
  });

  it("heads a page of overlaid panels by their populations", () => {
    const values = [population("All Events")];
    const page: FigurePage = {
      key: JSON.stringify(values), label: "All Events",
      rows: [[plotValue(overlay)]], columns: [[]],
      panels: [panel(overlay, 0, 0)],
    };
    expect(headOverlaidPopulations(page).label).toBe("Q1, Q2");
  });
});
