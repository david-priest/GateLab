import type {
  IllustrationDimensionValue,
  IllustrationLayoutPayload,
} from "../engine/illustrationLayout";
import { loadMiniPlots } from "./loadPlots";

const GRID_GAP = 8;
const ROW_HEADER_WIDTH = 190;
const MIN_FITTED_PLOT_SIZE = 120;

export function effectiveIllustrationPlotSize(
  requestedSize: number,
  fitToColumns: boolean,
  availableWidth: number,
  columnCount: number,
  hasRowHeaders: boolean,
): number {
  const requested = Math.max(MIN_FITTED_PLOT_SIZE, Math.min(800, Math.round(requestedSize) || 200));
  if (!fitToColumns || columnCount < 1 || availableWidth <= 0) return requested;
  const header = hasRowHeaders ? ROW_HEADER_WIDTH + GRID_GAP : 0;
  const gaps = GRID_GAP * Math.max(0, columnCount - 1);
  const fitted = Math.floor((availableWidth - header - gaps) / columnCount);
  // "Fit" is a ceiling, not an instruction to inflate every plot until it fills the viewport.
  // The requested size therefore remains observable while crowded grids shrink to avoid overflow.
  return Math.max(MIN_FITTED_PLOT_SIZE, Math.min(requested, fitted));
}

function scaledFontSizes(
  base: IllustrationLayoutPayload["fontSizes"],
  size: number,
  enabled: boolean,
): IllustrationLayoutPayload["fontSizes"] {
  if (!enabled) return { ...base };
  const ratio = size / 200;
  const scale = Math.max(0.8, Math.min(1.6, Math.sqrt(ratio > 0 ? ratio : 1)));
  const value = (input: number, fallback: number) => {
    const n = Number.isFinite(input) && input > 0 ? input : fallback;
    return Math.max(6, Math.round(n * scale * 2) / 2);
  };
  return {
    tick: value(base.tick, 9),
    axis_label: value(base.axis_label, 12),
    gate_label: value(base.gate_label, 10),
    title: value(base.title, 12),
  };
}

function headerText(values: readonly IllustrationDimensionValue[]): string {
  return values.map(({ label }) => label).join(" · ");
}

function headerTitle(values: readonly IllustrationDimensionValue[]): string {
  return values.map(({ dimension, label }) => `${dimension}: ${label}`).join("\n");
}

/** Render the structured Rows × Columns Illustration grid through the shared mini-plot engine. */
export function renderIllustrationLayout(
  containerId: string,
  payload: IllustrationLayoutPayload,
): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";
  container.style.overflow = "auto";

  const columnCount = Math.max(1, payload.columnGroups.length);
  const rowCount = Math.max(1, payload.rowGroups.length);
  const hasRowHeaders = payload.layout.rows.length > 0;
  const plotSize = effectiveIllustrationPlotSize(
    payload.plotSize,
    payload.fitToColumns,
    container.getBoundingClientRect().width || container.clientWidth,
    columnCount,
    hasRowHeaders,
  );
  const fonts = scaledFontSizes(payload.fontSizes, plotSize, payload.scaleFontsWithPlot);
  const api = loadMiniPlots();

  const grid = document.createElement("div");
  grid.id = `${containerId}-grid`;
  grid.className = "mini-plot-grid illustration-grid gl-illustration-layout-grid";
  grid.style.gridTemplateColumns = `${hasRowHeaders ? `${ROW_HEADER_WIDTH}px ` : ""}repeat(${columnCount}, ${plotSize}px)`;
  grid.style.gap = `${GRID_GAP}px`;
  grid.style.width = "max-content";
  container.appendChild(grid);

  const columnOffset = hasRowHeaders ? 2 : 1;
  if (hasRowHeaders) {
    const corner = document.createElement("div");
    corner.className = "illustration-row-header gl-illustration-grid-corner";
    corner.style.gridColumn = "1";
    corner.style.gridRow = "1";
    corner.textContent = payload.overlayLabel || "Illustration";
    grid.appendChild(corner);
  }
  payload.columnGroups.forEach((values, index) => {
    const header = document.createElement("div");
    header.className = "illustration-row-header gl-illustration-column-header";
    header.style.gridColumn = String(index + columnOffset);
    header.style.gridRow = "1";
    header.style.width = `${plotSize}px`;
    header.textContent = headerText(values) || payload.overlayLabel || "Plot";
    header.title = headerTitle(values);
    grid.appendChild(header);
  });

  payload.rowGroups.forEach((values, index) => {
    if (!hasRowHeaders) return;
    const header = document.createElement("div");
    header.className = "illustration-row-header gl-illustration-row-header";
    header.style.gridColumn = "1";
    header.style.gridRow = String(index + 2);
    header.textContent = headerText(values) || payload.overlayLabel || "Plot";
    header.title = headerTitle(values);
    grid.appendChild(header);
  });

  const renderVersion = String(Date.now());
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      const panel = payload.panels[rowIndex * columnCount + columnIndex];
      const cell = document.createElement("div");
      cell.style.gridColumn = String(columnIndex + columnOffset);
      cell.style.gridRow = String(rowIndex + 2);
      cell.style.width = `${plotSize}px`;
      cell.style.height = `${plotSize}px`;
      cell.title = panel?.description ?? "";
      if (!panel?.config) {
        cell.className = "gl-illustration-empty-cell";
        cell.textContent = "No selected data";
        grid.appendChild(cell);
        continue;
      }
      cell.className = "mini-plot-cell gl-illustration-plot-cell";
      cell.setAttribute("data-render-family", "illustration");
      cell.setAttribute("data-plot-key", panel.key);
      cell.setAttribute("data-render-version", renderVersion);
      grid.appendChild(cell);
      api.renderMiniPlot(cell, {
        ...panel.config,
        plot_size: plotSize,
        font_sizes: fonts,
      });
    }
  }
}
