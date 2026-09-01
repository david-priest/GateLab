import { describe, expect, it, vi } from "vitest";
import cytofSrc from "../../vendor/GateLabR/inst/app/www/cytof_plot.js?raw";
import miniSrc from "../../vendor/GateLabR/inst/app/www/mini_plot.js?raw";
import { patchCytofForGateLab, patchMiniPlot } from "./loadPlots";

describe("GateLab cytof interaction patches", () => {
  it("removes the delayed Shiny boot that clears GateLab's first painted FCS canvas", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(cytofSrc).toContain("setTimeout(_init, 100)");
    expect(patched).not.toContain("setTimeout(_init, 100)");
    expect(patched).toContain("React owns initialisation");

    warning.mockRestore();
  });

  it("carries the gate's true boundary into the strategy grid", () => {
    // The grid builder rebuilt each gate from the step and left `outline` off the field list, so
    // _bowPts was always null and the Strategy tab drew straight chords whatever edge mode was
    // chosen. Everything either side of it was already right.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchMiniPlot(miniSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(miniSrc).not.toContain("outline: step.outline");
    expect(patched).toContain("outline: step.outline");
    // The draw code that consumes it must still be present.
    expect(patched).toContain("gate.outline && gate.outline.length > 2");

    warning.mockRestore();
  });

  it("applies the edge mode under publication style too", () => {
    // Publication style only swaps colours (black stroke, black label fill). It must keep using
    // the same path the edge-mode patch produces, or figures would silently revert to straight
    // chords exactly where it matters most.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchMiniPlot(miniSrc);

    expect(warning).not.toHaveBeenCalled();
    const pathAssign = patched.indexOf("var pathStr = _toPath(");
    const pubStroke = patched.indexOf("pubStyle ? '#000000' : gate.color");
    expect(pathAssign).toBeGreaterThan(-1);
    expect(pubStroke).toBeGreaterThan(pathAssign);   // the stroke uses the patched path
    expect(patched).not.toContain("var pathStr = 'M' + points.map(");

    warning.mockRestore();
  });

  it("draws grid contours dark rather than in the population colour", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchMiniPlot(miniSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(miniSrc).toContain("line_color: cfg.pop_color || '#111111'");
    expect(patched).not.toContain("line_color: cfg.pop_color || '#111111'");
    expect(patched).toContain("line_color: cfg.contour_color || '#111111'");
    // Histograms keep the population colour, and back-gating keeps its orange.
    expect(patched).toContain("cfg.pop_color || '#444444'");
    expect(patched).toContain("back_color");

    warning.mockRestore();
  });

  it("defaults the grid canvases to the display too, without overriding explicit callers", () => {
    // mini_plot supersampled at a hardcoded 2x. Right on a 2x screen, wrong on a 3x one (the
    // grids become the soft ones) and wasteful on a 1x one, where every cell carries four times
    // the pixels for nothing.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchMiniPlot(miniSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(miniSrc).toContain("CANVAS_SCALE = 2;");
    expect(patched).not.toContain("CANVAS_SCALE = 2;");
    expect(patched).toContain("window.devicePixelRatio");
    expect(patched).toContain("Math.min(3, Math.max(1,");

    // Both render paths in mini_plot, not just the first.
    const sites = patched.split("GateLab: match the display").length - 1;
    expect(sites).toBe(miniSrc.split("CANVAS_SCALE = 2;").length - 1);

    // An explicit canvas_scale must still win — the compensation inspector passes 3 and every
    // export passes dpi/96, and neither may be silently reduced to the screen's ratio.
    expect(patched).toContain("var CANVAS_SCALE = Number(cfg.canvas_scale);");
    const guard = patched.indexOf("var CANVAS_SCALE = Number(cfg.canvas_scale);");
    const fallback = patched.indexOf("window.devicePixelRatio", guard);
    expect(fallback).toBeGreaterThan(guard);

    warning.mockRestore();
  });

  it("sizes the plot canvas to the display, not to CSS pixels", () => {
    // The backing store was PLOT_W x PLOT_H CSS pixels, so on a 2x screen every event was drawn
    // at half the resolution the display can show. mini_plot already renders at 2x.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(cytofSrc).toContain("_canvas.width  = PLOT_W;");
    expect(patched).not.toContain("_canvas.width  = PLOT_W;");
    expect(patched).toContain("Math.round(PLOT_W * _dpr)");
    expect(patched).toContain("window.devicePixelRatio");
    expect(patched).toContain("_ctx.scale(_dpr, _dpr);");
    // The element must stay its original size on screen; only the buffer grows.
    expect(patched).toContain("'width:' + PLOT_W + 'px;height:' + PLOT_H + 'px;'");
    // The scale must be applied AFTER the context exists, or it is a no-op on undefined.
    expect(patched.indexOf("_ctx.scale(_dpr, _dpr);"))
      .toBeGreaterThan(patched.indexOf("_ctx = _canvas.getContext('2d');"));
    // clear() must not wipe in backing-store units once the context is pre-scaled.
    expect(patched).not.toContain("_ctx.clearRect(0, 0, _canvas.width, _canvas.height);");

    warning.mockRestore();
  });

  it("leaves exactly one pan implementation bound to the plot", () => {
    // Two pans ran on the same background drag -- the renderer's and App's -- writing to
    // different places from different bases. Whichever painted last in a frame won, so Shift
    // sometimes appeared not to switch to stretch at all.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(cytofSrc).toContain("_svg.on('pointerdown.navigate', _onNavigatePointerDown)");
    expect(patched).not.toContain("_svg.on('pointerdown.navigate', _onNavigatePointerDown)");
    // Must be LIVE code, not a line the inserted comment swallowed: the whole d3 chain hangs off
    // it, so a comment marker anywhere before it on the same line would silently unbind every
    // gate gesture as well. Assert the statement starts its own line.
    const navLine = patched
      .split("\n")
      .find((line) => line.includes("_svg.on('pointerdown.navigate', null)"));
    expect(navLine, "the disabled-pan binding should be on its own line").toBeDefined();
    expect(navLine!.trimStart().startsWith("_svg.on('pointerdown.navigate', null)")).toBe(true);

    // The gate gestures and the axis-label pickers must survive untouched.
    for (const kept of [
      "on('mousedown.draw', _onMousedown)",
      "on('mousemove.draw', _onMousemove)",
      "on('click.draw',    _onClick)",
    ]) {
      expect(patched).toContain(kept);
    }

    warning.mockRestore();
  });

  it("opens the channel picker upward when it would not fit below the label", () => {
    // The X-axis label sits at the bottom of the plot, so a picker anchored under it ran past
    // the viewport and its last channels could not be reached.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    // The unpatched source positions the panel below the label and never reconsiders.
    expect(cytofSrc).toContain("panel.style.top  = (labelRect.bottom + 4) + 'px';");
    expect(cytofSrc).not.toContain("labelRect.top - margin - h");
    expect(patched).toContain("flip the channel picker above the label");
    expect(patched).toContain("labelRect.top - margin - h");
    // Measured after mounting -- the height depends on the channel count.
    const appendAt = patched.indexOf("document.body.appendChild(panel);");
    const measureAt = patched.indexOf("panel.getBoundingClientRect().height");
    expect(appendAt).toBeGreaterThan(-1);
    expect(measureAt).toBeGreaterThan(appendAt);

    warning.mockRestore();
  });

  it("keeps polygon vertex clicks out of saved-gate drag handlers", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(patched).toContain("_mouseData = null; _polyJustClosed = false;");
    expect(patched).toContain("_g.select('.draw-layer').style('pointer-events', 'none');");
    expect(patched).toMatch(/\(pd\.x_range\s*\|\|\s*\[\]\)\.join\(','\)/);

    // Derived from the CURRENT mode, not from the mode-change argument: _applyMode only runs on
    // a CHANGE, so a one-shot set was dropped the next time _init() rebuilt .gate-layer and
    // saved gates silently began intercepting clicks again mid-draw.
    expect(patched).toContain("var drawing = _mode !== 'navigate';");
    // The layer-level style alone is inert: cytof_plot.js sets pointer-events INLINE on each
    // gate's fill ('all') and hit path ('stroke'), and an inline value beats an inherited one.
    // Only the class, backed by !important in styles.css, actually stops them.
    expect(patched).toContain("classed('gl-gates-inert', drawing)");
    expect(cytofSrc).toContain(".style('pointer-events', 'all')"); // the reason the class is needed
    expect(patched).not.toContain("newMode === 'navigate' ? null : 'none'");
    // Re-asserted at both places the layer can come back: mode change and re-init.
    expect(patched).toContain("_ready = true;\n        _syncGatePointerEvents();");
    expect((patched.match(/_syncGatePointerEvents\(\);/g) ?? []).length).toBe(2);

    warning.mockRestore();
  });

  // The badge is what makes a raw gate and a display gate distinguishable on screen. If this
  // patch silently stops matching, the two become identical again and nothing else would say so.
  it("draws the gating-space badge and its tooltip on the gate label", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(cytofSrc).not.toContain("space_badge");
    expect(patched).toContain("if (gate.space_badge) {");
    expect(patched).toContain("labelG.append('title').text(gate.space_hint)");
    // Below the percentage when there is one, so it never displaces the name.
    expect(patched).toContain("pctLine ? '1.25em' : '1.3em'");
    // Applied once, not once per re-patch.
    expect((patched.match(/if \(gate\.space_badge\) \{/g) ?? []).length).toBe(1);

    warning.mockRestore();
  });

  // An arcsinh scatter axis packs -100, -10, 0, 10, 100 into a few pixels around zero. The
  // thinning that handles this was gated to tick_mode 'asinh'/'logicle', so scatter axes — the
  // ones that actually crowd — never got it, and the labels collided.
  it("thins crowded axis labels on every tick mode, keeping zero", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    // The vendored source only thins two of the three branches per axis.
    expect(cytofSrc).toContain("xTicks.tick_mode === 'asinh' || xTicks.tick_mode === 'logicle'");
    expect(patched).not.toContain("xTicks.tick_mode === 'asinh' || xTicks.tick_mode === 'logicle'");
    expect(patched).not.toContain("yTicks.tick_mode === 'asinh' || yTicks.tick_mode === 'logicle'");
    // Thinning now runs for both axes in every branch: 3 call sites each.
    expect((patched.match(/_hideCompressedLabels\(_g\.select\('\.x-axis'\)/g) ?? []).length).toBe(3);
    expect((patched.match(/_hideCompressedLabels\(_g\.select\('\.y-axis'\)/g) ?? []).length).toBe(3);
    // Zero first, then outward — dropping the anchor is what made the axis unreadable.
    expect(patched).toContain("labeled.sort(function (a, b) { return a.mag - b.mag; })");
    expect(patched).not.toContain("labeled.sort(function(a, b) { return a.px - b.px; })");

    warning.mockRestore();
  });

  it("reports whether a render painted or was deferred by an active drag", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(patched).toContain("// GateLab: report whether render() painted or deferred.");
    expect(patched).toContain("if (!plotData) return false;");
    expect(patched).toMatch(/if \(_dragging\) \{[\s\S]*?return false;\n        \}\n\n        var ctnr/);
    expect(patched).toMatch(/var ctnr = document\.getElementById\(CTNR\);\n        if \(!ctnr\) return false;/);
    expect(patched.match(/if \(!ctnr\) return false;/g)).toHaveLength(1);
    expect(patched).toMatch(/_redraw\(\);\n        return true;\n    \}/);

    warning.mockRestore();
  });

  it("uses the pinned native edge-pile behavior without clamping gate scales", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(cytofSrc).toContain("function _clampPointX(scale, value)");
    expect(patched).toContain("function _clampPointX(scale, value)");
    expect(patched.match(/_clampPointX\(zx, x\[i\]\)/g)).toHaveLength(2);
    expect(patched).toContain("_clampPointX(zx, x[idx])");
    expect(patched).toContain("function _offscalePts()");
    expect(patched).toContain("outlierPts = outlierPts.concat(_offscalePts());");
    expect(patched).toContain("outlierPts: _offscalePts()");
    expect(patched).toContain("pxArr[i] = _clampBaseX(x[i]);");
    expect(patched).not.toContain("d3.scaleLinear().domain(xr).range([0, W]).clamp(true)");

    warning.mockRestore();
  });

  it("biases the quantile pseudocolour ramp without changing density", () => {
    // The renderer maps density by quantile rank (equal-probability, as FlowJo does); the
    // exponent composes with that ramp. Event positions, density bins and event inclusion
    // are untouched either way.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(patched).toContain("var colourPower = Number(_plotData.density_color_power);");
    expect(patched).toContain("colourPower = 1.6;");
    expect(patched).toContain("Math.pow(Math.min(1, cache.rank[i]), colourPower)");
    // The peak-relative mapping must be gone, or the ramp is no longer self-normalising.
    expect(patched).not.toContain("cache.densities[i] / cache.maxDens");
    expect(() => new Function(patched)).not.toThrow();

    warning.mockRestore();
  });

  it("still patches an older pinned renderer that divides by the peak", () => {
    // The submodule can legitimately sit behind GateLabR main, so the pre-quantile form
    // must keep working rather than silently losing the exponent.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const legacy = cytofSrc.replace("var t = cache.rank[i];", "var t = cache.densities[i] / cache.maxDens;");
    const patched = patchCytofForGateLab(legacy);

    expect(warning).not.toHaveBeenCalled();
    expect(patched).toContain("Math.pow(Math.min(1, cache.densities[i] / cache.maxDens), colourPower)");

    warning.mockRestore();
  });

  it("does not duplicate edge-pile logic after GateLabR carries it natively", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const nativeRenderer = patchCytofForGateLab(cytofSrc);
    const repatched = patchCytofForGateLab(nativeRenderer);

    expect(repatched.match(/function _offscalePts\(\)/g)).toHaveLength(1);
    expect(repatched.match(/outlierPts = outlierPts\.concat\(_offscalePts\(\)\);/g)).toHaveLength(1);

    warning.mockRestore();
  });
});

describe("GateLab mini-plot gate-edge patches", () => {
  // The Strategy and Illustration grids drew straight chords regardless of the edge mode, and
  // those are the views that become figures — so a published gate could differ from the one
  // actually applied. The patch degrades to a console.warn if the vendored source moves, which
  // is invisible in a browser, so the match is asserted here.
  it("honours gate_edge_mode in the Strategy / Illustration grid overlays", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchMiniPlot(miniSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(miniSrc).not.toContain("gate_edge_mode");
    expect(patched).toContain("var _edgeMode = gateStyle.gate_edge_mode || 'straight-bow';");
    // Straight chords stay the default path; the true boundary is opt-in.
    expect(patched).toContain("_toPath((_edgeMode === 'bowed' && _bowPts) ? _bowPts : points)");
    // The grey companion only in straight-bow, and only when an outline exists.
    expect(patched).toContain("if (_edgeMode === 'straight-bow' && _bowPts) {");
    expect(patched).toContain("var _bowPts = (gate.outline && gate.outline.length > 2)");
    // The label centroid still comes from the straight vertices, so it cannot shift with the mode.
    expect(patched).toContain("d3.mean(points, function (p) { return p[0]; })");

    warning.mockRestore();
  });
});

describe("GateLab mini-plot density patches", () => {
  it("uses opt-in clipping, a gating-matched density kernel, and a shared ceiling without dropping events", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchMiniPlot(miniSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(miniSrc).not.toContain("density_clip_quantile");
    expect(patched).toContain("cfg.density_clip_quantile, cfg.density_color_power, cfg.density_color_ceiling, cfg.density_smoothing");
    expect(patched).toContain("var requestedMargins = cfg.plot_margins || {};");
    expect(patched).toContain("!isFinite(Number(requestedMargins.left)) && cfg.y_label");
    expect(patched).toContain("var gridN = 256, pad = blurRadius, extSize = gridN + 2 * pad;");
    expect(patched).toContain("Math.min(24, blurRadius)");
    expect(patched).toContain("var integralGrid = new Float64Array(integralStride * integralStride);");
    expect(patched).toContain("var densityGrid = blurred;");
    expect(patched).toContain("densities[i] = densityGrid[gy * extSize + gx]");
    expect(patched).toContain("var requestedCeiling = Number(densityColorCeiling);");
    expect(patched).toContain("? requestedCeiling : maxDens;");
    expect(patched).toContain("if (qd > 0) occupied.push(qd);");
    expect(patched).toContain("Math.floor(clipQ * (occupied.length - 1))");
    // The colour mapping is now quantile RANK, matching the gating plot; the ceiling still
    // bounds the clip/smoothing path but no longer sets the ramp.
    expect(patched).toContain("Math.pow(Math.min(1, _rank[idx]), colourPower)");
    expect(patched).toContain("var _rank = new Float32Array(n);");
    expect(patched).not.toContain("var t = densities[idx] / maxDens;");
    expect(patched).toContain("density_color_power: data.density_color_power");
    expect(patched).toContain("ctx.arc(px, py, dotR, 0, 6.2832)");
    expect(patched).toContain("H + xAxisLabelOffset");
    expect(patched).toContain("-yAxisLabelOffset");
    expect(patched).toContain("cfg.x_axis_label_offset");
    expect(patched).toContain("cfg.y_axis_label_offset");
    expect(patched).toContain("axisTickSize + 2");
    expect(patched).toContain("axisOuterTickSize === 0");
    expect(() => new Function(patched)).not.toThrow();

    warning.mockRestore();
  });

  it("applies the contour patches once, however many times it runs", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const once = patchCytofForGateLab(cytofSrc);
    const twice = patchCytofForGateLab(once);

    expect(warning).not.toHaveBeenCalled();
    expect(twice).toBe(once);
    expect(once.match(/__glContourDebug/g) ?? []).toHaveLength(1);

    warning.mockRestore();
  });

  it("drops the contour cache wherever pan or stretch changes the base domain", () => {
    // Pan and shift-drag-stretch set the base scale domain and call _redraw(), which never
    // touches the contour cache; the fingerprint is only consulted in render(), which these
    // paths never reach. The cached polygons are in base-scale PIXEL space, so they were drawn
    // against the new domain and the density stayed put while the axes and gates moved.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(cytofSrc).not.toContain("_contourCache = null; // GateLab: base domain changed");
    // Both sites: the rAF flush during a drag, and the commit on release.
    expect(patched.match(/_contourCache = null; \/\/ GateLab: base domain changed/g) ?? [])
      .toHaveLength(2);
    expect(patched).toContain(
      "_yBase.domain(_plotData.y_range); _contourCache = null; // GateLab: base domain changed");
    expect(patched).toContain(
      "_xBase.domain(pend.x); _yBase.domain(pend.y); _contourCache = null; // GateLab: base domain changed");

    warning.mockRestore();
  });

  it("draws gate outlines from the densified path while handles stay on the vertices", () => {
    // A polygon's edges are straight in gating space; under a non-linear axis their image is a
    // curve. Joining transformed vertices with straight lines draws something that is not the
    // gate. The path follows `outline`; the drag handles must keep binding to `vertices`.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(cytofSrc).not.toContain("_gateOutlinePts");
    expect(patched).toContain("function _gateOutlinePts(g)");
    // Both path-building sites: initial draw and the in-place update during a drag.
    expect(patched.match(/_toPx\(_gateOutlinePts\(gate\), zx, zy\)/g) ?? []).toHaveLength(2);
    expect(patched.match(/_gateOutlinePts\(gate\)\.map\(function \(v\)/g) ?? []).toHaveLength(2);
    // Handles are untouched.
    expect(patched).toContain(".data(gate.vertices)");
    expect(patched).not.toContain("_toPx(gate.vertices, zx, zy)");

    warning.mockRestore();
  });

  it("drops the stale outline wherever a drag rewrites the vertices", () => {
    // The outline is computed by React from gating-space vertices; the renderer cannot recompute
    // it, having no access to the channel transforms. A drag rewrites gate.vertices in place, so
    // without this the path keeps drawing the pre-drag curve while the handles move and the edges
    // visibly detach from their own vertices.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(cytofSrc).not.toContain("gate.outline = null");
    // All four: whole-gate move and vertex drag, each in normal and flipped orientation.
    expect(patched.match(/gate\.outline = null; \/\/ stale mid-drag/g) ?? []).toHaveLength(4);

    warning.mockRestore();
  });

  it("renders gate edges in three modes without repainting the cells to switch", () => {
    // Straight edges are what other tools draw but are not the gate on a non-linear axis; the
    // default shows both, so the difference is visible without going looking for it.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(patched).toContain("function _gateEdgeMode()");
    // The main path takes the curve only when asked; the grey companion only in the middle mode.
    expect(patched).toContain("_gateEdgeMode() === 'bowed'");
    expect(patched).toContain("_gateEdgeMode() === 'straight-bow'");
    // Created and kept in step during a drag.
    expect(patched).toContain("'gate-bow'");
    expect(patched).toContain("gg.select('.gate-bow')");
    // Carried on the gates-only path, so switching mode does not repaint the canvas.
    expect(patched).toContain("_plotData.gate_edge_mode = plotData.gate_edge_mode;");

    warning.mockRestore();
  });
});

describe("ellipse draw patches", () => {
  it("lands all three surgical patches in the vendored source", () => {
    const out = patchCytofForGateLab(cytofSrc);
    // Mode admission, live preview, and the centre-out finish that emits the new gate.
    expect(out).toContain("_mode !== 'draw-ellipse'");
    expect(out).toContain("dl.append('ellipse')");
    expect(out).toContain("_notifyNewGate('ellipse'");
    // The axis handles: four circles, resize+rotate, emitting ellipse_edit.
    expect(out).toContain("gg.selectAll('circle.eh')");
    expect(out).toContain("_shinyInput('ellipse_edit'");
    // Handles track a body move: _updateGateElements repositions circle.eh with everything else.
    expect(out).toContain("ellipse axis handles follow the ring");
    // And the payload-controlled editable flag that keeps vertex handles off ellipses.
    expect(out).toContain("gate.editable !== false");
    // Idempotent, like every other patch in this file.
    expect(patchCytofForGateLab(out)).toBe(out);
  });
});
