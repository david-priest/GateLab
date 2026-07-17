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

  // In Shiny the plot bundle boots itself after a short delay, because the container may
  // appear after the script. GateLab's React wrapper instead calls render() as soon as the
  // first FCS payload is ready; render() initialises synchronously. Leaving the legacy timer
  // active re-runs _init() ~100 ms later, replacing the freshly painted canvas with a blank
  // one until the next user interaction happens to trigger a redraw.
  const bootNeedle = `if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(_init, 100);
        });
    } else {
        setTimeout(_init, 100);
    }`;
  const bootPatchedNeedle = "// GateLab: React owns initialisation;";
  if (out.includes(bootNeedle)) {
    out = out.replace(
      bootNeedle,
      `${bootPatchedNeedle} render() calls _init() synchronously when needed.`,
    );
  } else if (!out.includes(bootPatchedNeedle)) {
    console.warn("[GateLab] cytof delayed-boot patch did not match — the first plot may be cleared.");
  }

  // cytof caches contours by point data. Include the view range so pan/stretch cannot leave
  // the density frozen while axes and gates move.
  const contourNeedle = "pd.contour_threshold || 5];";
  const contourPatchedNeedle = "(pd.x_range || []).join(',')";
  if (out.includes(contourNeedle)) {
    out = out.replace(
      contourNeedle,
      "pd.contour_threshold || 5, (pd.x_range||[]).join(','), (pd.y_range||[]).join(',')];",
    );
  } else if (!out.includes(contourPatchedNeedle) && !out.includes("(pd.x_range||[]).join(',')")) {
    console.warn("[GateLab] cytof contour-key patch did not match — contour may lag on pan.");
  }

  // A polygon closed on mousedown sets this guard to swallow that physical click. React can
  // switch back to navigate before the click arrives, leaving the guard set; the first click of
  // the next polygon was then lost. A mode change always starts a fresh drawing transaction.
  const resetNeedle = "_polyVerts = []; _mouseData = null;\n        _rectStart = null; _rectCurrent = null;";
  if (out.includes(resetNeedle)) {
    out = out.replace(
      resetNeedle,
      "_polyVerts = []; _mouseData = null; _polyJustClosed = false;\n        _rectStart = null; _rectCurrent = null;",
    );
  } else if (!out.includes("_mouseData = null; _polyJustClosed = false;")) {
    console.warn("[GateLab] cytof polygon-close guard patch did not match.");
  }

  // Saved gate fills have D3 drag handlers and cover large parts of the plot. While drawing,
  // make the entire saved-gate layer transparent to pointer input so every click reaches the
  // plot overlay. The preview itself is visual-only; close detection is coordinate based.
  const modeNeedle = `_g.select('.cytof-overlay').style('cursor',
            newMode === 'navigate' ? 'default' : 'crosshair');`;
  if (out.includes(modeNeedle)) {
    out = out.replace(
      modeNeedle,
      `${modeNeedle}
        _g.select('.gate-layer').style('pointer-events',
            newMode === 'navigate' ? null : 'none');
        _g.select('.draw-layer').style('pointer-events', 'none');`,
    );
  } else if (!out.includes("_g.select('.gate-layer').style('pointer-events'")) {
    console.warn("[GateLab] cytof draw-mode pointer patch did not match.");
  }

  // Robust auto ranges intentionally leave a small tail off-scale. Keep those events visible
  // as a pile-up on the corresponding plot edge (the FlowJo/Cytobank convention), while the
  // underlying scales remain unclamped so gates and pointer-coordinate inversion are untouched.
  // GateLabR now carries this behavior natively; keep the compatibility patch only for an older
  // pinned renderer so updating the submodule cannot apply the pile-up logic a second time.
  const nativeOffscaleNeedle = "function _offscalePts()";
  if (out.includes(nativeOffscaleNeedle)) return out;
  const canvasMarker = "    // ── Canvas rendering ──────────────────────────────────────────────────────";
  const clampHelperNeedle = "function _clampPointX(scale, value)";
  if (out.includes(canvasMarker) && !out.includes(clampHelperNeedle)) {
    out = out.replace(
      canvasMarker,
      `${canvasMarker}
    function _clampPointX(scale, value) {
        return Math.max(M.left + 1.5, Math.min(M.left + W - 1.5, scale(value) + M.left));
    }
    function _clampPointY(scale, value) {
        return Math.max(M.top + 1.5, Math.min(M.top + H - 1.5, scale(value) + M.top));
    }
    function _clampBaseX(value) {
        return Math.max(0, Math.min(W, _xBase(value)));
    }
    function _clampBaseY(value) {
        return Math.max(0, Math.min(H, _yBase(value)));
    }`,
    );
  } else if (!out.includes(clampHelperNeedle)) {
    console.warn("[GateLab] cytof off-scale point helper patch did not match.");
  }

  const indexedPointNeedle = `var px = zx(x[i]) + M.left;
            var py = zy(y[i]) + M.top;`;
  const indexedPointPatch = `var px = _clampPointX(zx, x[i]);
            var py = _clampPointY(zy, y[i]);`;
  const indexedPointMatches = out.split(indexedPointNeedle).length - 1;
  if (indexedPointMatches === 2) {
    out = out.split(indexedPointNeedle).join(indexedPointPatch);
  } else if (!out.includes(indexedPointPatch)) {
    console.warn("[GateLab] cytof off-scale scatter/pseudocolor patch did not match.");
  }

  const overlayPointNeedle = `var px = zx(x[idx]) + M.left;
                var py = zy(y[idx]) + M.top;`;
  const overlayPointPatch = `var px = _clampPointX(zx, x[idx]);
                var py = _clampPointY(zy, y[idx]);`;
  if (out.includes(overlayPointNeedle)) {
    out = out.replace(overlayPointNeedle, overlayPointPatch);
  } else if (!out.includes(overlayPointPatch)) {
    console.warn("[GateLab] cytof off-scale overlay patch did not match.");
  }

  const contourPointsNeedle = `    function _ptsInDomain() {
        // Return base-scale pixel coords filtered to the plot area [0,W]×[0,H]
        var x = _plotData.x, y = _plotData.y, pts = [];
        for (var i = 0; i < x.length; i++) {
            var px = _xBase(x[i]), py = _yBase(y[i]);
            if (px >= 0 && px <= W && py >= 0 && py <= H) pts.push([px, py]);
        }
        return pts;
    }`;
  const contourPointsPatch = `${contourPointsNeedle}

    function _offscalePts() {
        // Keep off-scale tails out of the KDE (which would create artificial edge contours),
        // but return clamped pixels so contour mode can draw them as boundary outlier dots.
        var x = _plotData.x, y = _plotData.y, pts = [];
        for (var i = 0; i < x.length; i++) {
            var px = _xBase(x[i]), py = _yBase(y[i]);
            if (px < 0 || px > W || py < 0 || py > H) {
                pts.push([_clampBaseX(x[i]), _clampBaseY(y[i])]);
            }
        }
        return pts;
    }`;
  if (out.includes(contourPointsNeedle)) {
    out = out.replace(contourPointsNeedle, contourPointsPatch);
  } else if (!out.includes(contourPointsPatch)) {
    console.warn("[GateLab] cytof off-scale contour-point patch did not match.");
  }

  const emptyContourNeedle = "_contourCache = { contours: [], outlierPts: [] }; return;";
  const emptyContourPatch = "_contourCache = { contours: [], outlierPts: _offscalePts() }; return;";
  const emptyContourMatches = out.split(emptyContourNeedle).length - 1;
  if (emptyContourMatches === 4) {
    out = out.split(emptyContourNeedle).join(emptyContourPatch);
  } else if (!out.includes(emptyContourPatch)) {
    console.warn("[GateLab] cytof empty-contour off-scale patch did not match.");
  }

  const contourOutlierNeedle = `            var outlierPts = pts.filter(function (pt) {
                var gx = Math.max(0, Math.min(offN - 1, Math.floor(pt[0] * oxS)));
                var gy = Math.max(0, Math.min(offN - 1, Math.floor(pt[1] * oyS)));
                return pixels[(gy * offN + gx) * 4] < 128;  // black = outside contour
            });`;
  const contourOutlierPatch = `${contourOutlierNeedle}
            outlierPts = outlierPts.concat(_offscalePts());`;
  if (out.includes(contourOutlierNeedle)) {
    out = out.replace(contourOutlierNeedle, contourOutlierPatch);
  } else if (!out.includes("outlierPts = outlierPts.concat(_offscalePts());")) {
    console.warn("[GateLab] cytof contour outlier-pile patch did not match.");
  }

  const densityPointNeedle = `pxArr[i] = _xBase(x[i]);
                pyArr[i] = _yBase(y[i]);`;
  const densityPointPatch = `pxArr[i] = _clampBaseX(x[i]);
                pyArr[i] = _clampBaseY(y[i]);`;
  if (out.includes(densityPointNeedle)) {
    out = out.replace(densityPointNeedle, densityPointPatch);
  } else if (!out.includes(densityPointPatch)) {
    console.warn("[GateLab] cytof off-scale density patch did not match.");
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
  const levelPatchedNeedle = "var nLevels = Math.max(6, Math.min(18, Math.round(18 * Math.min(W, H) / 270)));";
  const lineNeedle = "ctx.lineWidth = 1.0;";
  if (out.includes(levelNeedle)) {
    out = out.replace(levelNeedle, levelPatchedNeedle);
  } else if (!out.includes(levelPatchedNeedle)) {
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
