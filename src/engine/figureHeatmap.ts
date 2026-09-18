// figureHeatmap.ts — the summary heatmap of an Illustration figure as one matrix: rows are the
// population × file combinations the page holds, columns the heatmap plots (one channel each),
// each cell the panel's summary statistic. The matrix is scaled, ordered and coloured here, in
// the manner of seekit::plotExprHeatmap1, and FigureHeatmap.tsx draws it.

import type { FigurePage, FigurePanel, FigurePanelData } from "./figure";
import type { IllustrationConfig } from "./workspace";
import { dendrogramSegments, euclidean, hclustAverage, type Clustering } from "./hclust";

export type HeatmapMatrixScale = "none" | "column_quantile" | "column_minmax" | "row_minmax" | "column_zscore";
export type HeatmapMatrixPalette = "rdylbu" | "blue_white_yellow_red" | "viridis" | "heat";
export type HeatmapBars = "none" | "counts";

/** The z-score scale is clamped to ±this, as the legacy heatmap did. */
export const HEATMAP_Z_LIMIT = 2.5;

export interface HeatmapMatrixRow {
  key: string;
  label: string;
  /** Events in the row's population (of the file, or pooled). */
  count: number;
  /** Panel keys by column index, for the tooltip and the export. */
  panelKeys: (string | null)[];
}

export interface HeatmapMatrixColumn {
  plotId: string;
  label: string;
}

export interface HeatmapMatrix {
  rows: HeatmapMatrixRow[];
  columns: HeatmapMatrixColumn[];
  /** The summary statistic, in transformed units; null where the panel had no events. */
  raw: (number | null)[][];
  /** What the colours show: `raw` scaled as the mode says. */
  scaled: (number | null)[][];
  stat: "median" | "mean";
  scale: HeatmapMatrixScale;
  legend: { min: number; max: number; title: string[] };
  /** Row and column indices in drawing order, and the dendrograms when clustering is on. */
  rowOrder: number[];
  columnOrder: number[];
  rowTree: Clustering | null;
  columnTree: Clustering | null;
}

/** The heatmap panels of a page, and the page with those panels taken out for the plot table. */
export function splitHeatmapPage(page: FigurePage): { heatmapPanels: FigurePanel[]; table: FigurePage | null } {
  const heatmapPanels = page.panels.filter((panel) => panel.plot.type === "heatmap");
  if (!heatmapPanels.length) return { heatmapPanels, table: page };
  const columnCount = page.columns.length;
  const keepRows = page.rows.map((_, row) => page.panels.slice(row * columnCount, (row + 1) * columnCount).some((p) => p.plot.type !== "heatmap"));
  const keepColumns = page.columns.map((_, column) => page.rows.some((_, row) => page.panels[row * columnCount + column]?.plot.type !== "heatmap"));
  if (!keepRows.some(Boolean) || !keepColumns.some(Boolean)) return { heatmapPanels, table: null };
  const panels: FigurePanel[] = [];
  page.rows.forEach((_, row) => {
    if (!keepRows[row]) return;
    page.columns.forEach((_, column) => {
      if (keepColumns[column]) panels.push(page.panels[row * columnCount + column]);
    });
  });
  return {
    heatmapPanels,
    table: {
      ...page,
      rows: page.rows.filter((_, row) => keepRows[row]),
      columns: page.columns.filter((_, column) => keepColumns[column]),
      panels,
    },
  };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The quantile at `p` (0–1) of a weighted set of points. */
function weightedQuantile(points: { value: number; weight: number }[], p: number): number | null {
  if (!points.length) return null;
  const sorted = [...points].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  if (!(total > 0)) return sorted[0].value;
  let cumulative = 0;
  for (const point of sorted) {
    cumulative += point.weight;
    if (cumulative >= p * total) return point.value;
  }
  return sorted[sorted.length - 1].value;
}

const minmax = (values: (number | null)[]): (number | null)[] => {
  const present = values.filter(finite);
  if (!present.length) return values.map(() => null);
  const lo = Math.min(...present);
  const hi = Math.max(...present);
  return values.map((v) => (finite(v) ? (hi > lo ? (v - lo) / (hi - lo) : 0.5) : null));
};

/**
 * Build the matrix for a page. Rows are the distinct population × file combinations among the
 * heatmap panels, in page order; columns the distinct heatmap plots, in page order. The file is
 * named in a row label only when the rows hold more than one file.
 */
export function buildHeatmapMatrix(
  page: FigurePage,
  panels: Record<string, FigurePanelData>,
  config: IllustrationConfig,
): HeatmapMatrix | null {
  const heatmapPanels = page.panels.filter((panel) => panel.plot.type === "heatmap");
  if (!heatmapPanels.length) return null;
  const sampleLabel = new Map<string, string>();
  for (const group of [...page.rows, ...page.columns]) {
    for (const value of group) if (value.dimension === "samples") sampleLabel.set(value.id, value.label);
  }
  const columns: HeatmapMatrixColumn[] = [];
  const columnIndex = new Map<string, number>();
  const rowIndex = new Map<string, number>();
  const rowsRaw: { key: string; population: string; samples: string[]; count: number; cells: Map<number, string> }[] = [];
  for (const panel of heatmapPanels) {
    if (!columnIndex.has(panel.plot.id)) {
      columnIndex.set(panel.plot.id, columns.length);
      // The channel names the column: a plot is called "Plot 2" unless the user renamed it.
      columns.push({ plotId: panel.plot.id, label: panel.plot.x || panel.plot.name });
    }
    const key = `${panel.population.hierarchyId}|${panel.population.populationId}|${panel.samples.join(",")}`;
    if (!rowIndex.has(key)) {
      rowIndex.set(key, rowsRaw.length);
      rowsRaw.push({ key, population: panel.population.label, samples: panel.samples, count: 0, cells: new Map() });
    }
    const row = rowsRaw[rowIndex.get(key)!];
    row.cells.set(columnIndex.get(panel.plot.id)!, panel.key);
    const count = Number(panels[panel.key]?.config?.n_events);
    if (finite(count)) row.count = Math.max(row.count, count);
  }
  const sampleSets = new Set(rowsRaw.map((row) => row.samples.join(",")));
  const rows: HeatmapMatrixRow[] = rowsRaw.map((row) => {
    const files = row.samples.map((id) => sampleLabel.get(id) ?? id);
    const suffix = sampleSets.size > 1 ? ` · ${files.length > 1 ? `${files.length} files` : files[0]}` : "";
    return {
      key: row.key,
      label: `${row.population}${suffix}`,
      count: row.count,
      panelKeys: columns.map((_, c) => row.cells.get(c) ?? null),
    };
  });
  const raw: (number | null)[][] = rows.map((row) =>
    row.panelKeys.map((key) => {
      const value = key ? panels[key]?.config?.figure_summary : null;
      return finite(value) ? value : null;
    }),
  );
  const stat = (config.heatmapStat ?? "median") as "median" | "mean";
  const scale = (config.heatmapScale ?? "column_quantile") as HeatmapMatrixScale;
  let scaled: (number | null)[][];
  let legend: HeatmapMatrix["legend"];
  const statWord = stat;
  if (scale === "none") {
    scaled = raw.map((row) => [...row]);
    const present = raw.flat().filter(finite);
    legend = { min: present.length ? Math.min(...present) : 0, max: present.length ? Math.max(...present) : 1, title: [statWord, "expression"] };
  } else if (scale === "row_minmax") {
    scaled = raw.map(minmax);
    legend = { min: 0, max: 1, title: [`scaled ${statWord}`, "expression"] };
  } else if (scale === "column_minmax") {
    scaled = raw.map((row) => [...row]);
    columns.forEach((_, c) => {
      const column = minmax(raw.map((row) => row[c]));
      column.forEach((v, r) => { scaled[r][c] = v; });
    });
    legend = { min: 0, max: 1, title: [`scaled ${statWord}`, "expression"] };
  } else if (scale === "column_zscore") {
    scaled = raw.map((row) => [...row]);
    columns.forEach((_, c) => {
      const values = raw.map((row) => row[c]);
      const present = values.filter(finite);
      const mean = present.length ? present.reduce((s, v) => s + v, 0) / present.length : 0;
      const sd = present.length > 1 ? Math.sqrt(present.reduce((s, v) => s + (v - mean) ** 2, 0) / (present.length - 1)) : 0;
      values.forEach((v, r) => {
        scaled[r][c] = finite(v) ? (sd > 0 ? Math.max(-HEATMAP_Z_LIMIT, Math.min(HEATMAP_Z_LIMIT, (v - mean) / sd)) : 0) : null;
      });
    });
    legend = { min: -HEATMAP_Z_LIMIT, max: HEATMAP_Z_LIMIT, title: [`${statWord} expression`, "z-score"] };
  } else {
    // Per channel, the 1st and 99th percentiles of the events pooled over the rows, as
    // plotExprHeatmap1's scale = "first": scaling before summarising commutes with the median,
    // so the summary is scaled with the same bounds. Each panel carries a quantile sketch of its
    // events; pooling them weighted by event count is the whole-page quantile to sketch precision.
    scaled = raw.map((row) => [...row]);
    columns.forEach((_, c) => {
      const points: { value: number; weight: number }[] = [];
      rows.forEach((row) => {
        const key = row.panelKeys[c];
        const sketch = key ? (panels[key]?.config?.summary_quantiles as unknown) : null;
        const count = key ? Number(panels[key]?.config?.n_events) : 0;
        if (!Array.isArray(sketch) || !sketch.length || !(count > 0)) return;
        const weight = count / sketch.length;
        for (const value of sketch) if (finite(value)) points.push({ value, weight });
      });
      const lo = weightedQuantile(points, 0.01);
      const hi = weightedQuantile(points, 0.99);
      raw.forEach((row, r) => {
        const v = row[c];
        scaled[r][c] = !finite(v) ? null : lo === null || hi === null || !(hi > lo) ? 0.5 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
      });
    });
    legend = { min: 0, max: 1, title: [`${statWord} scaled`, "expression"] };
  }
  // Ordering: the page's (populations as arranged, channels in plot order) unless clustering is
  // switched on, when the dendrogram's order takes over.
  const rowTree = config.heatmapClusterRows === true && rows.length > 1
    ? hclustAverage(rows.length, (i, j) => euclidean(scaled[i], scaled[j]))
    : null;
  const columnTree = config.heatmapClusterColumns === true && columns.length > 1
    ? hclustAverage(columns.length, (i, j) => euclidean(scaled.map((row) => row[i]), scaled.map((row) => row[j])))
    : null;
  return {
    rows,
    columns,
    raw,
    scaled,
    stat,
    scale,
    legend,
    rowOrder: rowTree ? rowTree.order : rows.map((_, i) => i),
    columnOrder: columnTree ? columnTree.order : columns.map((_, i) => i),
    rowTree,
    columnTree,
  };
}

/** ColorBrewer RdYlBu, reversed, as plotExprHeatmap1's default (`rev(brewer.pal(11, "RdYlBu"))`). */
const RDYLBU_REVERSED = ["#313695", "#4575b4", "#74add1", "#abd9e9", "#e0f3f8", "#ffffbf", "#fee090", "#fdae61", "#f46d43", "#d73027", "#a50026"];

export const HEATMAP_PALETTES: Record<HeatmapMatrixPalette, readonly string[]> = {
  rdylbu: RDYLBU_REVERSED,
  blue_white_yellow_red: ["#313695", "#ffffff", "#ffff64", "#a50026"],
  viridis: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
  heat: ["#ffffcc", "#fd8d3c", "#800026"],
};

function hex(color: string): [number, number, number] {
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The colour at `t` in 0–1 along a palette's stops, and whether text over it should be light. */
export function paletteColour(palette: readonly string[], t: number): { colour: string; light: boolean } {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const pos = clamped * (palette.length - 1);
  const index = Math.min(palette.length - 2, Math.floor(pos));
  const f = pos - index;
  const a = hex(palette[index]);
  const b = hex(palette[index + 1]);
  const rgb = a.map((v, i) => Math.round(v + (b[i] - v) * f));
  const luminance = (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255;
  return { colour: `rgb(${rgb.join(",")})`, light: luminance < 0.5 };
}

export { dendrogramSegments };
