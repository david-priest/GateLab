// loadPlots.ts — install the Shiny shim, then eval GateLabR's D3 sources in global
// scope so they attach `window.d3` and `window.CytofD3` and register their message
// handlers on our shim. We then drive rendering via `window.CytofD3.render(...)`
// (the global entry, cytof_plot.js:1673/1844) and receive gate interactions via the
// shim's `on(...)` (the modules call `Shiny.setInputValue(...)` on drag-end etc.).

import { installShim, type PlotBus } from "./shiny-shim";
import d3Src from "../../vendor/GateLabR/inst/app/www/d3.v7.min.js?raw";
import cytofSrc from "../../vendor/GateLabR/inst/app/www/cytof_plot.js?raw";
import miniSrc from "../../vendor/GateLabR/inst/app/www/mini_plot.js?raw";
import divisionSrc from "../../vendor/GateLabR/inst/app/www/division_plot.js?raw";

export interface CytofD3Api {
  render(payload: unknown, mode?: string): void;
  setMode(mode: string): void;
  clear(): void;
  clearPendingEdit(gateId: string, seq?: number): void;
}

/** mini_plot.js — the Strategy / Illustration grid renderer (window.CytofMiniPlot). */
export interface MiniPlotApi {
  renderMiniPlot(container: HTMLElement, cfg: unknown): void;
  renderStrategyGrid(containerId: string, data: unknown): void;
  renderMultiStrategyGrid(containerId: string, data: unknown): void;
  renderIllustrationGrid(containerId: string, data: unknown): void;
  exportGridPNG(gridId: string, filename: string): void;
}

/** division_plot.js — the Division profiler (window.DivisionD3); emits "division_gates" on drag-end. */
export interface DivisionApi {
  render(data: unknown): void;
  clear(): void;
}

let loaded = false;
let cached: { CytofD3: CytofD3Api; bus: PlotBus } | null = null;

// GateLab adaptations kept OUT of the pristine vendored submodule.
export function patchCytofForGateLab(src: string): string {
  let out = src;

  // cytof caches contours by point data. Include the view range so pan/stretch cannot leave
  // the density frozen while axes and gates move.
  const contourNeedle = "pd.contour_threshold || 5];";
  if (!out.includes(contourNeedle)) {
    console.warn("[GateLab] cytof contour-key patch did not match — contour may lag on pan.");
  } else {
    out = out.replace(
      contourNeedle,
      "pd.contour_threshold || 5, (pd.x_range||[]).join(','), (pd.y_range||[]).join(',')];",
    );
  }

  // A polygon closed on mousedown sets this guard to swallow that physical click. React can
  // switch back to navigate before the click arrives, leaving the guard set; the first click of
  // the next polygon was then lost. A mode change always starts a fresh drawing transaction.
  const resetNeedle = "_polyVerts = []; _mouseData = null;\n        _rectStart = null; _rectCurrent = null;";
  if (!out.includes(resetNeedle)) {
    console.warn("[GateLab] cytof polygon-close guard patch did not match.");
  } else {
    out = out.replace(
      resetNeedle,
      "_polyVerts = []; _mouseData = null; _polyJustClosed = false;\n        _rectStart = null; _rectCurrent = null;",
    );
  }

  // Saved gate fills have D3 drag handlers and cover large parts of the plot. While drawing,
  // make the entire saved-gate layer transparent to pointer input so every click reaches the
  // plot overlay. The preview itself is visual-only; close detection is coordinate based.
  const modeNeedle = `_g.select('.cytof-overlay').style('cursor',
            newMode === 'navigate' ? 'default' : 'crosshair');`;
  if (!out.includes(modeNeedle)) {
    console.warn("[GateLab] cytof draw-mode pointer patch did not match.");
  } else {
    out = out.replace(
      modeNeedle,
      `${modeNeedle}
        _g.select('.gate-layer').style('pointer-events',
            newMode === 'navigate' ? null : 'none');
        _g.select('.draw-layer').style('pointer-events', 'none');`,
    );
  }

  return out;
}

// GateLab adaptation (kept OUT of the pristine vendored submodule): mini_plot's contour uses a
// FIXED 18 levels + 1.0px lines regardless of panel size, so shrinking a panel (e.g. more
// columns) crams 18 lines into a tiny plot and looks too busy. Scale the level count and line
// width with the panel's inner dimension (baseline ~270px = the original 18 levels / 1.0px).
function patchMiniPlot(src: string): string {
  let out = src;
  const levelNeedle = "var nLevels = 18;";
  const lineNeedle = "ctx.lineWidth = 1.0;";
  if (out.includes(levelNeedle)) {
    out = out.replace(levelNeedle, "var nLevels = Math.max(6, Math.min(18, Math.round(18 * Math.min(W, H) / 270)));");
  } else {
    console.warn("[GateLab] mini_plot contour-levels patch did not match.");
  }
  if (out.includes(lineNeedle)) {
    out = out.replace(lineNeedle, "ctx.lineWidth = Math.max(0.5, Math.min(1.0, Math.min(W, H) / 270));");
  }
  return out;
}

export function loadPlots(): { CytofD3: CytofD3Api; bus: PlotBus } {
  if (cached) return cached;
  const bus = installShim();
  if (!loaded) {
    // Indirect eval → runs in global scope so UMD/IIFE assignments land on window.
    const globalEval = eval;
    globalEval(d3Src); // → window.d3
    globalEval(patchCytofForGateLab(cytofSrc)); // → window.CytofD3 (+ registers updatePlot/setMode/... on window.Shiny)
    globalEval(patchMiniPlot(miniSrc)); // → window.CytofMiniPlot (Strategy / Illustration grids)
    globalEval(divisionSrc); // → window.DivisionD3 (Division profiler)
    loaded = true;
  }
  const CytofD3 = (window as unknown as { CytofD3?: CytofD3Api }).CytofD3;
  if (!CytofD3 || typeof CytofD3.render !== "function") {
    throw new Error("[GateLab] CytofD3 failed to load from the GateLabR D3 bundle.");
  }
  cached = { CytofD3, bus };
  return cached;
}

/** Access the mini-plot grid renderer (loads the bundle if needed). */
export function loadMiniPlots(): MiniPlotApi {
  loadPlots(); // ensures d3 + shim + mini_plot are eval'd
  const api = (window as unknown as { CytofMiniPlot?: MiniPlotApi }).CytofMiniPlot;
  if (!api || typeof api.renderStrategyGrid !== "function") {
    throw new Error("[GateLab] CytofMiniPlot failed to load from the GateLabR D3 bundle.");
  }
  return api;
}

/** Access the Division profiler (loads the bundle if needed). Returns the api + the event bus. */
export function loadDivisionPlots(): { api: DivisionApi; bus: PlotBus } {
  const { bus } = loadPlots(); // ensures d3 + shim + division_plot are eval'd
  const api = (window as unknown as { DivisionD3?: DivisionApi }).DivisionD3;
  if (!api || typeof api.render !== "function") {
    throw new Error("[GateLab] DivisionD3 failed to load from the GateLabR D3 bundle.");
  }
  return { api, bus };
}
