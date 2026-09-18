// LayoutFigure.tsx — an Illustration figure drawn on a Layout page by the Illustration tab's own
// machinery: the same page layout, the same panel builder, the same grid and heatmap, with the
// figure's own style. The block holds the figure as it was when added; "Edit in Illustration"
// hands it back to that tab, and the block can be replaced with the tab's current figure.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  figureHierarchies,
  layoutFigure,
  migrateFigure,
  type FigureSample,
  type FigureSource,
} from "../engine/figure";
import { defaultIllustrationConfig } from "../engine/figureDefaults";
import { splitHeatmapPage } from "../engine/figureHeatmap";
import type { LayoutFigureRecipe, LayoutSheet } from "../engine/layout";
import { pageContentBox } from "../engine/layoutArrange";
import type { IllustrationConfig } from "../engine/workspace";
import type { CoreState } from "../store";
import { FigureGrid, colourFigureSummaries } from "./FigureGrid";
import { useFigurePanels } from "./useFigurePanels";

/** The block's config with every field the grid reads present, and its figure migrated to the files at hand. */
export function figureOfBlock(
  recipe: LayoutFigureRecipe,
  files: readonly FigureSample[],
  state: CoreState,
): IllustrationConfig {
  const trees = figureHierarchies(state);
  const config: IllustrationConfig = { ...defaultIllustrationConfig(), ...recipe.illustration };
  const first = config.figure?.plots[0];
  return {
    ...config,
    figure: migrateFigure(config, files, trees, state.active_hierarchy_id, first?.x ?? "", first?.y ?? ""),
  };
}

/**
 * A frame for a new figure block: the figure's first page at its natural size, as the
 * Illustration tab lays it out, within the sheet's page content box. The plot table and the
 * heatmap matrix beneath it are sized apart, as the grid draws them.
 */
export function figureBlockFrame(
  config: IllustrationConfig,
  files: readonly FigureSample[],
  state: CoreState,
  sheet: LayoutSheet,
): { width: number; height: number } {
  const box = pageContentBox(sheet);
  const figure = config.figure;
  if (!figure) return { width: Math.min(520, box.width), height: Math.min(400, box.height) };
  const page = layoutFigure(figure, files, figureHierarchies(state))[0];
  const { heatmapPanels, table } = page ? splitHeatmapPage(page) : { heatmapPanels: [], table: null };
  const panel = figure.panelSize;
  let width = 0;
  let height = 40;
  if (table) {
    const rowDepth = table.rows[0]?.length ?? 1;
    const columnDepth = table.columns[0]?.length ?? 1;
    width = table.columns.length * (panel + 14) + rowDepth * 110 + 24;
    height += table.rows.length * (panel + 54) + columnDepth * 26;
  }
  if (heatmapPanels.length) {
    // Row labels, the matrix, the count bars and the legend across; column labels down.
    const cell = Math.max(12, Math.min(120, config.heatmapCellSize ?? 28));
    const columns = Math.max(1, new Set(heatmapPanels.map((p) => p.plot.id)).size);
    const rows = Math.ceil(heatmapPanels.length / columns);
    width = Math.max(width, 170 + columns * cell + 220);
    height += 60 + Math.max(rows * cell, 80) + 90;
  }
  if (!width) width = 520;
  return { width: Math.round(Math.min(width, box.width)), height: Math.round(Math.min(height, box.height)) };
}

export function LayoutFigureSurface({
  recipe,
  files,
  sources,
  state,
  globalScales,
  width,
  height,
}: Readonly<{
  recipe: LayoutFigureRecipe;
  files: readonly FigureSample[];
  /** The prepared files, gated under their trees: what the panels are built from. */
  sources: readonly FigureSource[];
  state: CoreState;
  globalScales: Record<string, [number, number]>;
  width: number;
  height: number;
}>) {
  const trees = useMemo(() => figureHierarchies(state), [state]);
  const config = useMemo(() => figureOfBlock(recipe, files, state), [recipe, files, state]);
  const figure = config.figure!;
  const pages = useMemo(() => layoutFigure(figure, files, trees), [figure, files, trees]);
  const page = pages[Math.min(recipe.page, Math.max(0, pages.length - 1))];
  const built = useFigurePanels(
    page,
    figure,
    sources as FigureSource[],
    trees,
    false,
    config.maxEvents,
    config.heatmapStat,
    globalScales,
  );
  const panels = useMemo(
    () => (page ? colourFigureSummaries(page, built.data, config) : built.data),
    [page, built.data, config],
  );
  // The grid is laid out at its natural size and zoomed to fit the frame, never enlarged.
  const gridRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  useLayoutEffect(() => {
    const node = gridRef.current;
    if (!node) return;
    const measure = () => {
      const natural = node.firstElementChild as HTMLElement | null;
      if (!natural) return;
      const w = natural.offsetWidth;
      const h = natural.offsetHeight;
      if (!w || !h) return;
      setZoom(Math.min(1, width / w, height / h));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [width, height, panels, page?.key]);

  if (!page) {
    return (
      <div className="gl-layout-plot-host gl-layout-figure-host is-missing">
        {figure.sampleIds.length && figure.populations.length && figure.plots.length
          ? "The figure's files are not in this workspace."
          : "The figure has no files, populations or plots."}
      </div>
    );
  }
  return (
    <div className="gl-layout-plot-host gl-layout-figure-host" style={{ width, height }}>
      <div ref={gridRef} className="gl-layout-figure-zoom" style={{ zoom, width: "max-content" }}>
        <FigureGrid
          id={`layout-figure-${recipe.page}-${figure.name.replace(/[^a-z0-9]+/gi, "-")}`}
          page={page}
          panels={panels}
          config={config}
          size={figure.panelSize}
          showGates={figure.showGates}
        />
      </div>
    </div>
  );
}
