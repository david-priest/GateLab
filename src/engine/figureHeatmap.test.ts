import { describe, expect, it } from "vitest";
import type { FigurePage, FigurePanel, FigurePanelData } from "./figure";
import { buildHeatmapMatrix, paletteColour, splitHeatmapPage, HEATMAP_PALETTES } from "./figureHeatmap";
import { dendrogramSegments, euclidean, hclustAverage } from "./hclust";
import { quantileSketch } from "./figure";

const population = (label: string) => ({ hierarchyId: "h", populationId: label, label });
const plot = (id: string, type: "heatmap" | "biplot" = "heatmap") => ({ id, name: id, x: id, y: "", type });

/** A page with populations down the rows and plots across the columns, one file. */
function page(populations: string[], plots: ReturnType<typeof plot>[]): FigurePage {
  const panels: FigurePanel[] = [];
  populations.forEach((p, row) => plots.forEach((pl, column) => panels.push({ key: `${p}|${pl.id}`, samples: ["f1"], population: population(p), plot: pl, row, column })));
  return {
    key: "page",
    label: "Page",
    rows: populations.map((p) => [{ dimension: "populations", id: p, label: p }]),
    columns: plots.map((pl) => [{ dimension: "plots", id: pl.id, label: pl.name }]),
    panels,
  };
}
function data(values: Record<string, { value: number | null; count: number; sketch?: number[] }>): Record<string, FigurePanelData> {
  return Object.fromEntries(Object.entries(values).map(([key, v]) => [key, {
    mappings: [],
    config: { figure_summary: v.value, n_events: v.count, summary_quantiles: v.sketch ?? (v.value === null ? [] : [v.value - 1, v.value, v.value + 1]) },
  }]));
}

describe("hclustAverage", () => {
  it("joins the closest pair first and keeps the input's left-to-right sense", () => {
    // Three points on a line: 0, 1, 10. The first two join, then the third.
    const xs = [0, 10, 1];
    const tree = hclustAverage(3, (i, j) => Math.abs(xs[i] - xs[j]));
    expect(tree.order).toEqual([0, 2, 1]);
    expect(tree.root?.height).toBeCloseTo((10 + 9) / 2, 6); // average linkage: mean of d(0,10) and d(1,10)
    const { segments, maxHeight } = dendrogramSegments(tree.root);
    expect(segments).toHaveLength(6);
    expect(maxHeight).toBeCloseTo(9.5, 6);
  });
  it("ignores missing dimensions in the distance and handles one item", () => {
    expect(euclidean([1, null, 3], [4, 5, 7])).toBeCloseTo(Math.sqrt((9 + 16) * 3 / 2), 6);
    expect(hclustAverage(1, () => 0)).toEqual({ order: [0], root: { leaf: 0, height: 0, leaves: [0] } });
  });
});

describe("buildHeatmapMatrix", () => {
  const pg = page(["A", "B", "C"], [plot("CD3"), plot("CD19")]);
  const panels = data({
    "A|CD3": { value: 5, count: 100, sketch: [4, 5, 6] }, "A|CD19": { value: 1, count: 100, sketch: [0, 1, 2] },
    "B|CD3": { value: 1, count: 300, sketch: [0, 1, 2] }, "B|CD19": { value: 5, count: 300, sketch: [4, 5, 6] },
    "C|CD3": { value: 4.8, count: 50, sketch: [4, 4.8, 6] }, "C|CD19": { value: null, count: 0 },
  });

  it("lays populations down the rows and heatmap plots across, and scales per channel by pooled percentiles", () => {
    const m = buildHeatmapMatrix(pg, panels, { heatmapScale: "column_quantile", heatmapClusterRows: false, heatmapClusterColumns: false } as never)!;
    expect(m.rows.map((r) => [r.label, r.count])).toEqual([["A", 100], ["B", 300], ["C", 50]]);
    expect(m.columns.map((c) => c.label)).toEqual(["CD3", "CD19"]);
    expect(m.raw).toEqual([[5, 1], [1, 5], [4.8, null]]);
    // CD3's pooled events run 0..6, so 5 sits at 5/6 and 1 at 1/6.
    expect(m.scaled[0][0]).toBeCloseTo(5 / 6, 6);
    expect(m.scaled[1][0]).toBeCloseTo(1 / 6, 6);
    expect(m.scaled[2][1]).toBeNull();
    expect(m.legend).toEqual({ min: 0, max: 1, title: ["median scaled", "expression"] });
    expect(m.rowOrder).toEqual([0, 1, 2]);
  });

  it("keeps the page's order unless clustering is switched on, and offers the other scalings", () => {
    const plain = buildHeatmapMatrix(pg, panels, {} as never)!;
    expect(plain.rowOrder).toEqual([0, 1, 2]);
    expect(plain.rowTree).toBeNull();
    const clustered = buildHeatmapMatrix(pg, panels, { heatmapClusterRows: true, heatmapClusterColumns: true } as never)!;
    // A and C are alike (CD3 high); B is the odd one out, so it does not sit between them.
    expect(clustered.rowOrder.indexOf(1)).not.toBe(1);
    expect(clustered.rowTree?.root?.children).toBeDefined();
    const z = buildHeatmapMatrix(pg, panels, { heatmapScale: "column_zscore", heatmapClusterRows: false, heatmapClusterColumns: false } as never)!;
    expect(z.legend.min).toBe(-2.5);
    expect(z.scaled[0][0]).toBeGreaterThan(0);
    const none = buildHeatmapMatrix(pg, panels, { heatmapScale: "none", heatmapStat: "mean" } as never)!;
    expect(none.legend).toEqual({ min: 1, max: 5, title: ["mean", "expression"] });
    const rows = buildHeatmapMatrix(pg, panels, { heatmapScale: "row_minmax" } as never)!;
    expect(rows.scaled[0]).toEqual([1, 0]);
  });

  it("names the file in a row only when the rows hold more than one file", () => {
    const two: FigurePage = {
      key: "p", label: "P",
      rows: [[{ dimension: "samples", id: "f1", label: "D1.fcs" }], [{ dimension: "samples", id: "f2", label: "D2.fcs" }]],
      columns: [[{ dimension: "plots", id: "CD3", label: "CD3" }]],
      panels: [
        { key: "f1", samples: ["f1"], population: population("A"), plot: plot("CD3"), row: 0, column: 0 },
        { key: "f2", samples: ["f2"], population: population("A"), plot: plot("CD3"), row: 1, column: 0 },
      ],
    };
    const m = buildHeatmapMatrix(two, data({ f1: { value: 1, count: 10 }, f2: { value: 2, count: 20 } }), { heatmapClusterRows: false } as never)!;
    expect(m.rows.map((r) => r.label)).toEqual(["A · D1.fcs", "A · D2.fcs"]);
  });

  it("splits a mixed page into the plot table and the heatmap panels", () => {
    const mixed = page(["A", "B"], [plot("FSC", "biplot"), plot("CD3")]);
    const { table, heatmapPanels } = splitHeatmapPage(mixed);
    expect(heatmapPanels.map((p) => p.key)).toEqual(["A|CD3", "B|CD3"]);
    expect(table?.columns).toHaveLength(1);
    expect(table?.panels.map((p) => p.key)).toEqual(["A|FSC", "B|FSC"]);
    expect(splitHeatmapPage(pg).table).toBeNull();
    expect(buildHeatmapMatrix(page(["A"], [plot("FSC", "biplot")]), {}, {} as never)).toBeNull();
  });
});

describe("palette and sketch", () => {
  it("interpolates the reversed RdYlBu from blue to red and knows which text is light", () => {
    expect(paletteColour(HEATMAP_PALETTES.rdylbu, 0)).toEqual({ colour: "rgb(49,54,149)", light: true });
    expect(paletteColour(HEATMAP_PALETTES.rdylbu, 1)).toEqual({ colour: "rgb(165,0,38)", light: true });
    expect(paletteColour(HEATMAP_PALETTES.rdylbu, 0.5).light).toBe(false);
  });
  it("sketches quantiles from the minimum to the maximum", () => {
    expect(quantileSketch([5, 1, 3, 2, 4], 3)).toEqual([1, 3, 5]);
    expect(quantileSketch([], 5)).toEqual([]);
  });
});
