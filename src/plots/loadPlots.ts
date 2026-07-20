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
  /** True only when this call actually painted; false when the legacy engine deferred it. */
  render(payload: unknown, mode?: string): boolean;
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

  // React must not accept plot interactions for a new sample/assay identity until that identity
  // is actually visible. The legacy renderer silently queues render() while a gate drag is active,
  // so a void return cannot distinguish a real paint from a deferred one. Give the wrapper an
  // explicit acknowledgement without changing GateLabR's source copy.
  const renderAckMarker = "// GateLab: report whether render() painted or deferred.";
  if (!out.includes(renderAckMarker)) {
    const renderAckPatches: [string, string][] = [
      [
        `    function render(plotData, mode) {
        if (!plotData) return;`,
        `    function render(plotData, mode) {
        ${renderAckMarker}
        if (!plotData) return false;`,
      ],
      [
        "        if (!forced && _isStalePlot(plotData)) return;",
        "        if (!forced && _isStalePlot(plotData)) return false;",
      ],
      [
        `            return;
        }

        var ctnr = document.getElementById(CTNR);
        if (!ctnr) return;`,
        `            return false;
        }

        var ctnr = document.getElementById(CTNR);
        if (!ctnr) return false;`,
      ],
      [
        `            if (!_dragging) _drawGates(_zx(), _zy());
            return;
        }`,
        `            if (!_dragging) _drawGates(_zx(), _zy());
            return true;
        }`,
      ],
      [
        `        _redraw();
    }

    function setMode(mode) {`,
        `        _redraw();
        return true;
    }

    function setMode(mode) {`,
      ],
    ];
    if (renderAckPatches.every(([needle]) => out.includes(needle))) {
      for (const [needle, replacement] of renderAckPatches) out = out.replace(needle, replacement);
    } else {
      console.warn("[GateLab] cytof render-acknowledgement patch did not match.");
    }
  }

  // GateLab exposes a shared pseudocolour transfer exponent. It affects only the mapping from
  // estimated density to the jet palette: event positions, density bins, and event inclusion are
  // unchanged. A value above one reserves yellow/red for the genuinely densest event cores.
  const densityPowerSetupNeedle = `_ctx.globalAlpha = _plotData.point_alpha || 0.85;

        for (var j = 0; j < n; j++) {`;
  const densityPowerSetupPatch = `_ctx.globalAlpha = _plotData.point_alpha || 0.85;
        var colourPower = Number(_plotData.density_color_power);
        if (!isFinite(colourPower) || colourPower <= 0) colourPower = 1.6;

        for (var j = 0; j < n; j++) {`;
  const densityPowerNeedle = "var t = cache.densities[i] / cache.maxDens;";
  const densityPowerPatch = "var t = Math.pow(Math.min(1, cache.densities[i] / cache.maxDens), colourPower);";
  if (out.includes(densityPowerSetupNeedle)) out = out.replace(densityPowerSetupNeedle, densityPowerSetupPatch);
  if (out.includes(densityPowerNeedle)) out = out.replace(densityPowerNeedle, densityPowerPatch);
  if (!out.includes("_plotData.density_color_power") || !out.includes(densityPowerPatch)) {
    console.warn("[GateLab] cytof pseudocolour-transfer patch did not match.");
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
export function patchMiniPlot(src: string): string {
  let out = src;
  const marginNeedle = "var M = { top: 22, right: 8, bottom: 38, left: 42 };";
  const marginPatch = `var requestedMargins = cfg.plot_margins || {};
        function _resolvedMargin(name, fallback, minimum, maximum) {
            var value = Number(requestedMargins[name]);
            if (!isFinite(value)) value = fallback;
            return Math.max(minimum, Math.min(maximum, value));
        }
        var M = {
            top: _resolvedMargin('top', 22, 10, 40),
            right: _resolvedMargin('right', 8, 2, 30),
            bottom: _resolvedMargin('bottom', 38, 24, 55),
            left: _resolvedMargin('left', 42, 28, 65)
        };`;
  if (out.includes(marginNeedle)) {
    out = out.replace(marginNeedle, marginPatch);
  } else if (!out.includes("var requestedMargins = cfg.plot_margins || {};")) {
    console.warn("[GateLab] mini_plot configurable-margin patch did not match.");
  }
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

  // Compensation biplots can contain a very large exact-zero pile. Scaling the colour ramp to
  // the single densest point makes every informative off-axis population faint. When explicitly
  // requested, match SpillQC's robust hexbin convention: cap the colour ceiling at a quantile of
  // OCCUPIED density cells (not events), then apply an optional sqrt-like colour power. All events
  // are still drawn; this changes only colour normalisation and cannot hide the zero pile.
  const pseudocolorCall = "_drawPseudocolor(ctx, x, y, xScale, yScale, M, W, H, dotR, cfgAlpha);";
  const robustPseudocolorCall = "_drawPseudocolor(ctx, x, y, xScale, yScale, M, W, H, dotR, cfgAlpha, cfg.density_clip_quantile, cfg.density_color_power, cfg.density_color_ceiling, cfg.density_smoothing);";
  const pseudocolorSignature = "function _drawPseudocolor(ctx, x, y, xScale, yScale, M, W, H, dotR, pointAlpha) {";
  const robustPseudocolorSignature = "function _drawPseudocolor(ctx, x, y, xScale, yScale, M, W, H, dotR, pointAlpha, densityClipQuantile, densityColorPower, densityColorCeiling, densitySmoothing) {";
  const densityGridSizeNeedle = "var gridN = 128, pad = 2, extSize = gridN + 2 * pad;";
  const densityGridSizePatch = `var blurRadius = Math.round(Number(densitySmoothing));
        if (!isFinite(blurRadius)) blurRadius = 3;
        blurRadius = Math.max(1, Math.min(24, blurRadius));
        // Match the gating editor: a 256 × 256 density grid padded by the blur radius.
        // GateLab scales the supplied radius to plot size before calling this renderer.
        var gridN = 256, pad = blurRadius, extSize = gridN + 2 * pad;`;
  const densityBlurNeedle = `        // Simple box blur (2 passes)
        var blurred = new Float32Array(extSize * extSize);
        for (var pass = 0; pass < 2; pass++) {
            var src = pass === 0 ? grid : blurred;
            var dst = pass === 0 ? blurred : grid;
            for (var ry = 1; ry < extSize - 1; ry++) {
                for (var rx = 1; rx < extSize - 1; rx++) {
                    var sum = 0;
                    for (var dy = -1; dy <= 1; dy++)
                        for (var dx = -1; dx <= 1; dx++)
                            sum += src[(ry + dy) * extSize + (rx + dx)];
                    dst[ry * extSize + rx] = sum / 9;
                }
            }
        }`;
  const densityBlurPatch = `        // One configurable box blur, matching the gating editor's pseudocolour kernel at
        // radius 3. A summed-area table keeps this O(grid cells), which matters when dozens of
        // cached gallery plots are rendered together. Both assay layers use the same radius.
        var blurred = new Float32Array(extSize * extSize);
        var kernelWidth = blurRadius * 2 + 1;
        var kernelArea = kernelWidth * kernelWidth;
        var integralStride = extSize + 1;
        var integralGrid = new Float64Array(integralStride * integralStride);
        for (var iy = 0; iy < extSize; iy++) {
            var rowTotal = 0;
            for (var ix = 0; ix < extSize; ix++) {
                rowTotal += grid[iy * extSize + ix];
                integralGrid[(iy + 1) * integralStride + ix + 1] =
                    integralGrid[iy * integralStride + ix + 1] + rowTotal;
            }
        }
        for (var ry = blurRadius; ry < extSize - blurRadius; ry++) {
            var y0 = ry - blurRadius, y1 = ry + blurRadius + 1;
            for (var rx = blurRadius; rx < extSize - blurRadius; rx++) {
                var x0 = rx - blurRadius, x1 = rx + blurRadius + 1;
                var sum = integralGrid[y1 * integralStride + x1]
                    - integralGrid[y0 * integralStride + x1]
                    - integralGrid[y1 * integralStride + x0]
                    + integralGrid[y0 * integralStride + x0];
                blurred[ry * extSize + rx] = sum / kernelArea;
            }
        }
        var densityGrid = blurred;

        // Compute per-point density`;
  const densityLookupNeedle = "densities[i] = grid[gy * extSize + gx];";
  const densityLookupPatch = "densities[i] = densityGrid[gy * extSize + gx];";
  const densityCeilingNeedle = `        if (!maxDens) return;

        // Sort by density`;
  const densityCeilingPatch = `        if (!maxDens) return;

        var requestedCeiling = Number(densityColorCeiling);
        var colourCeiling = isFinite(requestedCeiling) && requestedCeiling > 0
            ? requestedCeiling : maxDens;
        var clipQ = Number(densityClipQuantile);
        if (!(isFinite(requestedCeiling) && requestedCeiling > 0) && isFinite(clipQ) && clipQ > 0 && clipQ < 1) {
            var occupied = [];
            for (var qy = pad; qy < pad + gridN; qy++) {
                for (var qx = pad; qx < pad + gridN; qx++) {
                    var qd = densityGrid[qy * extSize + qx];
                    if (qd > 0) occupied.push(qd);
                }
            }
            if (occupied.length) {
                occupied.sort(function (a, b) { return a - b; });
                var qi = Math.max(0, Math.min(occupied.length - 1,
                    Math.floor(clipQ * (occupied.length - 1))));
                colourCeiling = Math.max(occupied[qi], 1e-12);
            }
        }
        var colourPower = Number(densityColorPower);
        if (!isFinite(colourPower) || colourPower <= 0) colourPower = 1;

        // Sort by density`;
  const densityRatioNeedle = "var t = densities[idx] / maxDens;";
  const densityRatioPatch = "var t = Math.pow(Math.min(1, densities[idx] / colourCeiling), colourPower);";
  if (out.includes(pseudocolorCall)) out = out.replace(pseudocolorCall, robustPseudocolorCall);
  if (out.includes(pseudocolorSignature)) out = out.replace(pseudocolorSignature, robustPseudocolorSignature);
  if (out.includes(densityGridSizeNeedle)) out = out.replace(densityGridSizeNeedle, densityGridSizePatch);
  if (out.includes(densityBlurNeedle)) out = out.replace(densityBlurNeedle, densityBlurPatch);
  if (out.includes(densityLookupNeedle)) out = out.replace(densityLookupNeedle, densityLookupPatch);
  if (out.includes(densityCeilingNeedle)) out = out.replace(densityCeilingNeedle, densityCeilingPatch);
  if (out.includes(densityRatioNeedle)) out = out.replace(densityRatioNeedle, densityRatioPatch);

  // The grid renderers unpack a top-level style payload into each mini-plot configuration. Keep
  // the shared density transfer setting intact through that boundary for Strategy/Illustration.
  const compactPointStyleNeedle = `point_alpha: pointAlpha,
                point_size: pointSize,`;
  const compactPointStylePatch = `point_alpha: pointAlpha,
                density_color_power: data.density_color_power,
                point_size: pointSize,`;
  const alignedPointStyleNeedle = "point_alpha:     pointAlpha,";
  const alignedPointStylePatch = `point_alpha:     pointAlpha,
                    density_color_power: data.density_color_power,`;
  if (out.includes(compactPointStyleNeedle)) out = out.replace(compactPointStyleNeedle, compactPointStylePatch);
  if (out.includes(alignedPointStyleNeedle)) out = out.split(alignedPointStyleNeedle).join(alignedPointStylePatch);
  out = out.replace(
    "if (!isFinite(colourPower) || colourPower <= 0) colourPower = 1;",
    "if (!isFinite(colourPower) || colourPower <= 0) colourPower = 1.6;",
  );

  // Compensation biplots use a tighter label inset than publication-oriented mini-plots.
  // Keeping this configurable avoids changing Strategy and Illustration output.
  const titleFontNeedle = "var titleFs = (fs.title || 11) + 'px';";
  const axisOffsetPatch = `${titleFontNeedle}
        var axisLabelOffset = Number(cfg.axis_label_offset);
        if (!isFinite(axisLabelOffset)) axisLabelOffset = 32;
        axisLabelOffset = Math.max(14, Math.min(40, axisLabelOffset));
        var axisTickSize = Number(cfg.axis_tick_size);
        if (!isFinite(axisTickSize)) axisTickSize = 6;
        axisTickSize = Math.max(2, Math.min(8, axisTickSize));
        var axisOuterTickSize = Number(cfg.axis_outer_tick_size);
        if (!isFinite(axisOuterTickSize)) axisOuterTickSize = 6;
        axisOuterTickSize = Math.max(0, Math.min(8, axisOuterTickSize));`;
  const xLabelNeedle = ".attr('x', W / 2).attr('y', H + 32)";
  const yLabelNeedle = ".attr('x', -H / 2).attr('y', -32)";
  const xTickNeedle = "xAxisSel.selectAll('text').style('font-size', tickFs);";
  const xTickPatch = `${xTickNeedle}
        xAxisSel.selectAll('.tick line').attr('y2', axisTickSize);
        xAxisSel.selectAll('.tick text').attr('y', axisTickSize + 2);
        if (axisOuterTickSize === 0) {
            xAxisSel.select('.domain').attr('d', 'M0.5,0.5H' + (W + 0.5));
        }`;
  const yTickNeedle = "yAxisSel.selectAll('text').style('font-size', tickFs);";
  const yTickPatch = `${yTickNeedle}
            yAxisSel.selectAll('.tick line').attr('x2', -axisTickSize);
            yAxisSel.selectAll('.tick text').attr('x', -(axisTickSize + 2));
            if (axisOuterTickSize === 0) {
                yAxisSel.select('.domain').attr('d', 'M-0.5,' + (H + 0.5) + 'V0.5');
            }`;
  if (out.includes(titleFontNeedle)) out = out.replace(titleFontNeedle, axisOffsetPatch);
  if (out.includes(xLabelNeedle)) out = out.replace(xLabelNeedle, ".attr('x', W / 2).attr('y', H + axisLabelOffset)");
  if (out.includes(yLabelNeedle)) out = out.replace(yLabelNeedle, ".attr('x', -H / 2).attr('y', -axisLabelOffset)");
  if (out.includes(xTickNeedle)) out = out.replace(xTickNeedle, xTickPatch);
  if (out.includes(yTickNeedle)) out = out.replace(yTickNeedle, yTickPatch);
  if (
    !out.includes(robustPseudocolorCall) ||
    !out.includes(robustPseudocolorSignature) ||
    !out.includes("var requestedMargins = cfg.plot_margins || {};") ||
    !out.includes("var gridN = 256, pad = blurRadius, extSize = gridN + 2 * pad;") ||
    !out.includes("var integralGrid = new Float64Array(integralStride * integralStride);") ||
    !out.includes(densityLookupPatch) ||
    !out.includes("var requestedCeiling = Number(densityColorCeiling);") ||
    !out.includes(densityRatioPatch) ||
    !out.includes("density_color_power: data.density_color_power") ||
    !out.includes("H + axisLabelOffset") ||
    !out.includes("-axisLabelOffset") ||
    !out.includes("axisTickSize + 2") ||
    !out.includes("axisOuterTickSize === 0")
  ) {
    console.warn("[GateLab] mini_plot robust-density patch did not match.");
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
