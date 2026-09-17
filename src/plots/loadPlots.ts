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
  renderRidgelinePanel(container: HTMLElement, cfg: unknown): void;
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
/**
 * Ellipse handle geometry in PIXEL space, prepended to the plot script.
 *
 * The four handles must sit at the ellipse's on-screen vertices: the two points farthest from
 * the centre and the two nearest. Those are the axis ends of the ellipse as drawn in pixels,
 * which are not the axis ends in display units whenever the two axes have different pixel
 * scales, because per-axis scaling rotates an ellipse's principal axes. So the display-space
 * covariance is mapped through the linear part of the display→pixel map (M·Σ·Mᵀ), the axes are
 * re-derived from the result, and a handle drag goes back the same way (M⁻¹·Σ·M⁻ᵀ). Exported
 * so the mathematics can be tested outside the browser.
 */
export const ELLIPSE_PIXEL_GEOMETRY_SRC =
  "var _glEll = (function () {\n" +
  "    function mul(A, B) { return [[A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]],\n" +
  "                                 [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]]]; }\n" +
  "    function tr(A) { return [[A[0][0], A[1][0]], [A[0][1], A[1][1]]]; }\n" +
  "    function inv(A) { var d = A[0][0] * A[1][1] - A[0][1] * A[1][0];\n" +
  "                      return [[A[1][1] / d, -A[0][1] / d], [-A[1][0] / d, A[0][0] / d]]; }\n" +
  "    function covFromAxes(a, b, th) { var ca = Math.cos(th), sa = Math.sin(th), l1 = a * a, l2 = b * b;\n" +
  "        return [[l1 * ca * ca + l2 * sa * sa, (l1 - l2) * ca * sa], [(l1 - l2) * ca * sa, l1 * sa * sa + l2 * ca * ca]]; }\n" +
  "    function axesFromCov(C) { var a = C[0][0], b = C[0][1], c = C[1][1]; var t = a + c, det = a * c - b * b;\n" +
  "        var disc = Math.sqrt(Math.max(0, t * t / 4 - det)); var l1 = t / 2 + disc, l2 = t / 2 - disc;\n" +
  "        var th = Math.abs(b) < 1e-300 ? (a >= c ? 0 : Math.PI / 2) : Math.atan2(l1 - a, b);\n" +
  "        return { a: Math.sqrt(Math.max(0, l1)), b: Math.sqrt(Math.max(0, l2)), th: th }; }\n" +
  "    // Linear part of the display→pixel map for the current scales; flipped swaps the axes.\n" +
  "    function M(zx, zy, flipped) { var sx = zx(1) - zx(0), sy = zy(1) - zy(0);\n" +
  "        return flipped ? [[0, sx], [sy, 0]] : [[sx, 0], [0, sy]]; }\n" +
  "    function toPx(m, zx, zy, flipped) { return flipped ? [zx(m[1]), zy(m[0])] : [zx(m[0]), zy(m[1])]; }\n" +
  "    function toPixelAxes(a, b, th, zx, zy, flipped) { var m = M(zx, zy, flipped);\n" +
  "        return axesFromCov(mul(mul(m, covFromAxes(a, b, th)), tr(m))); }\n" +
  "    function toDisplayAxes(a, b, th, zx, zy, flipped) { var mi = inv(M(zx, zy, flipped));\n" +
  "        return axesFromCov(mul(mul(mi, covFromAxes(a, b, th)), tr(mi))); }\n" +
  "    // The four handles in pixels: major ends (0, 1) then minor ends (2, 3); the third field is the index.\n" +
  "    function handlePx(c, P) { var ca = Math.cos(P.th), sa = Math.sin(P.th);\n" +
  "        return [[c[0] + P.a * ca, c[1] + P.a * sa, 0], [c[0] - P.a * ca, c[1] - P.a * sa, 1],\n" +
  "                [c[0] - P.b * sa, c[1] + P.b * ca, 2], [c[0] + P.b * sa, c[1] - P.b * ca, 3]]; }\n" +
  "    return { toPx: toPx, toPixelAxes: toPixelAxes, toDisplayAxes: toDisplayAxes, handlePx: handlePx, axesFromCov: axesFromCov, covFromAxes: covFromAxes };\n" +
  "})();\n";

export function patchCytofForGateLab(src: string): string {
  let out = src;
  if (!out.includes("var _glEll = ")) out = ELLIPSE_PIXEL_GEOMETRY_SRC + out;

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

  // The gates-only fast path copies just gates and selection, so the edge mode would go stale
  // there and switching it would do nothing until something else forced a full render. Carrying
  // it means changing the mode redraws the overlays and leaves the cells alone, like any other
  // gate-only change.
  const fastPathNeedle = "_plotData.selected_gate_id = plotData.selected_gate_id;";
  if (out.includes(fastPathNeedle) && !out.includes("_plotData.gate_edge_mode =")) {
    out = out.replace(
      fastPathNeedle,
      fastPathNeedle + "\n              _plotData.gate_edge_mode = plotData.gate_edge_mode;",
    );
  } else if (!out.includes("_plotData.gate_edge_mode =")) {
    console.warn("[GateLab] cytof gate-edge-mode fast-path patch did not match — the edge toggle may need a full redraw.");
  }

  // The grey companion path: drawn under the straight edges so the user can see how far the real
  // boundary departs from what they drew, without having to switch modes to find out.
  const bowCreateNeedle = "// ── Gate label — data-space centroid + draggable offset ──────";
  if (out.includes(bowCreateNeedle) && !out.includes("'gate-bow'")) {
    out = out.replace(
      bowCreateNeedle,
      "var _bowPts = _bowPx(gate, zx, zy, isFlipped);\n" +
        "              if (_bowPts) {\n" +
        "                  gg.append('path').attr('class', 'gate-bow')\n" +
        "                      .datum(_bowPts).attr('d', line)\n" +
        "                      .attr('fill', 'none')\n" +
        "                      .attr('stroke', '#8a8a8a')\n" +
        "                      .attr('stroke-width', 1)\n" +
        "                      .attr('stroke-opacity', 0.9)\n" +
        "                      .style('pointer-events', 'none');\n" +
        "              }\n\n              " +
        bowCreateNeedle,
    );
  }

  // ...and kept in step during a drag, alongside the three paths already updated in place.
  const bowUpdateNeedle = "gg.select('.gate-outline').datum(pts).attr('d', pathD);";
  if (out.includes(bowUpdateNeedle) && !out.includes("gg.select('.gate-bow')")) {
    out = out.replace(
      bowUpdateNeedle,
      bowUpdateNeedle +
        "\n          var _bowUpd = _bowPx(gate, zx, zy, flipped);\n" +
        "          gg.select('.gate-bow').attr('d', _bowUpd ? line(_bowUpd) : null);",
    );
  }

  // A live drag rewrites gate.vertices in place, but `outline` is computed by React from the
  // gating-space vertices and cannot be recomputed here -- the renderer has no access to the
  // channel transforms. Left alone, the path keeps drawing the pre-drag curve while the handles
  // move, so the edges detach from their own vertices. Dropping the stale outline as the
  // vertices change makes _gateOutlinePts fall back to them, so edges track the drag as straight
  // segments and settle onto the true boundary when React sends the next payload on release.
  // ── Ellipse gates: the payload marks them editable:false ──────────────────────────────────
  // An ellipse is presented to the renderer as its sampled boundary polygon. Body select/move
  // must keep working, but vertex handles would offer 64 draggable sample points whose edits
  // cannot be mapped back to a covariance — so the payload's editable flag now gates the
  // handles, where before the engine hardcoded every gate editable.
  const editableNeedle = "var isEditable = true;";
  if (out.includes(editableNeedle)) {
    out = out.replace(editableNeedle, "var isEditable = gate.editable !== false;");
  } else if (!out.includes("gate.editable !== false")) {
    console.warn("[GateLab] cytof editable patch: needle not found — ellipse gates may grow vertex handles.");
  }

  // ── Ellipse draw mode ─────────────────────────────────────────────────────────────────────
  // Reuses the rectangle rubber-band machinery wholesale: the same mousedown handler and the
  // same _rectStart/_rectCurrent state, so _applyMode's cancel path needs no change. The drag
  // reads centre-out — press at the centre, pull to set the radii — with a live <ellipse>
  // preview, and emits new_gate("ellipse", [[cx,cy],[cx+rx,cy+ry]]) in display coordinates.
  const ellipseModeNeedle = "if (_mode !== 'draw-rect') return;";
  if (out.includes(ellipseModeNeedle)) {
    out = out.replace(ellipseModeNeedle,
      "if (_mode !== 'draw-rect' && _mode !== 'draw-ellipse') return;");
  } else if (!out.includes("_mode !== 'draw-ellipse'")) {
    console.warn("[GateLab] cytof ellipse mode patch: mousedown needle not found — ellipse drawing disabled.");
  }

  const ellipsePreviewNeedle =
    "        dl.append('rect').attr('class', 'rubber-band')\n" +
    "            .attr('x', sx).attr('y', sy)\n" +
    "            .attr('width',  Math.max(0, ex - sx))\n" +
    "            .attr('height', Math.max(0, ey - sy));";
  const ellipsePreviewPatch =
    "        if (_mode === 'draw-ellipse') {\n" +
    "            dl.append('ellipse').attr('class', 'rubber-band')\n" +
    "                .attr('cx', zx(_rectStart.dx)).attr('cy', zy(_rectStart.dy))\n" +
    "                .attr('rx', Math.abs(zx(_rectCurrent.dx) - zx(_rectStart.dx)))\n" +
    "                .attr('ry', Math.abs(zy(_rectCurrent.dy) - zy(_rectStart.dy)));\n" +
    "        } else {\n" +
    ellipsePreviewNeedle + "\n" +
    "        }";
  // The needle survives inside the patch's own else-branch, so idempotency needs the
  // already-patched check on the PRIMARY condition, not only on the warning.
  if (out.includes(ellipsePreviewNeedle) && !out.includes("dl.append('ellipse')")) {
    out = out.replace(ellipsePreviewNeedle, ellipsePreviewPatch);
  } else if (!out.includes("dl.append('ellipse')")) {
    console.warn("[GateLab] cytof ellipse preview patch: needle not found — no live preview while drawing.");
  }

  // The finish branch runs BEFORE the rectangle's min/max, which would average the press point
  // away: for a centre-out ellipse the press point (_rectStart) IS the centre.
  const ellipseFinishNeedle =
    "        _rectCurrent = { dx: zx.invert(px), dy: zy.invert(py) };\n\n" +
    "        var x0 = Math.min(";
  const ellipseFinishPatch =
    "        _rectCurrent = { dx: zx.invert(px), dy: zy.invert(py) };\n\n" +
    "        if (_mode === 'draw-ellipse') {\n" +
    "            var ecx = _rectStart.dx, ecy = _rectStart.dy;\n" +
    "            var erx = Math.abs(_rectCurrent.dx - ecx), ery = Math.abs(_rectCurrent.dy - ecy);\n" +
    "            _rectStart = null; _rectCurrent = null;\n" +
    "            _g.select('.draw-layer').selectAll('*').remove();\n" +
    "            if (Math.abs(zx(ecx + erx) - zx(ecx)) < 5 || Math.abs(zy(ecy + ery) - zy(ecy)) < 5) return;\n" +
    "            _notifyNewGate('ellipse', [[ecx - erx, ecy - ery], [ecx + erx, ecy + ery]]);\n" +
    "            return;\n" +
    "        }\n\n" +
    "        var x0 = Math.min(";
  if (out.includes(ellipseFinishNeedle)) {
    out = out.replace(ellipseFinishNeedle, ellipseFinishPatch);
  } else if (!out.includes("_notifyNewGate('ellipse'")) {
    console.warn("[GateLab] cytof ellipse finish patch: needle not found — ellipse drawing disabled.");
  }

  // ── Ellipse axis handles: resize + rotate ──────────────────────────────────────────────────
  // Injected after the vertex-handle block. A selected gate carrying payload `ellipse` geometry
  // gets four handles at its on-screen vertices: the geometry is display-space (mean, major,
  // minor, angle), and _glEll maps it into pixels so the handles sit at the drawn ellipse's
  // axis ends however the two axes are scaled. Dragging a MAJOR handle sets that axis length
  // and rotates the ellipse to point at the cursor; a MINOR handle does the same with the
  // perpendicular constraint — so rotation needs no separate grip. The drag keeps its own
  // pixel-space axes so the handle under the cursor never swaps with its partner, converts
  // them back to display space for the live ring, and drag end emits ellipse_edit with the
  // display-space parameters, which the app maps back into the gate's covariance.
  const ellipseHandleAnchor =
    "                vertCircles.each(function (d, i) {\n" +
    "                    d3.select(this).call(\n" +
    "                        _makeVertexDrag(gate, i, gg, fillEl, outlineEl,\n" +
    "                                        vertCircles, labelG, zx, zy, isFlipped)\n" +
    "                    );\n" +
    "                });\n" +
    "            }";
  const ellipseHandleBlock = ellipseHandleAnchor + "\n" +
    "            if (isSel && gate.ellipse) {\n" +
    "                var E = { m: [gate.ellipse.mean[0], gate.ellipse.mean[1]],\n" +
    "                          a: gate.ellipse.major, b: gate.ellipse.minor, th: gate.ellipse.angle };\n" +
    "                var _ehC = function (zx2, zy2) { return _glEll.toPx(E.m, zx2, zy2, isFlipped); };\n" +
    "                var _ehPts = function (zx2, zy2) {\n" +
    "                    return _glEll.handlePx(_ehC(zx2, zy2), _glEll.toPixelAxes(E.a, E.b, E.th, zx2, zy2, isFlipped));\n" +
    "                };\n" +
    "                var _ehRing = function () {\n" +
    "                    var out = [], ca = Math.cos(E.th), sa = Math.sin(E.th);\n" +
    "                    for (var i = 0; i < 64; i++) {\n" +
    "                        var t = 2 * Math.PI * i / 64;\n" +
    "                        var px = E.a * Math.cos(t), py = E.b * Math.sin(t);\n" +
    "                        out.push([E.m[0] + px * ca - py * sa, E.m[1] + px * sa + py * ca]);\n" +
    "                    }\n" +
    "                    return out;\n" +
    "                };\n" +
    "                var ehCircles = gg.selectAll('circle.eh')\n" +
    "                    .data(_ehPts(zx, zy))\n" +
    "                    .enter().append('circle').attr('class', 'eh')\n" +
    "                    .attr('cx', function (d) { return d[0]; })\n" +
    "                    .attr('cy', function (d) { return d[1]; })\n" +
    "                    .attr('r', VRAD)\n" +
    "                    .attr('fill', color).attr('fill-opacity', 0.9)\n" +
    "                    .attr('stroke', 'white').attr('stroke-width', 2)\n" +
    "                    .style('cursor', 'grab').style('pointer-events', 'all');\n" +
    "                ehCircles.each(function (d0) {\n" +
    "                    var idx = d0[2], P = null;\n" +
    "                    d3.select(this).call(d3.drag()\n" +
    "                        .on('start', function (event) {\n" +
    "                            _dragging = true; event.sourceEvent.stopPropagation();\n" +
    "                            P = _glEll.toPixelAxes(E.a, E.b, E.th, _zx(), _zy(), isFlipped);\n" +
    "                        })\n" +
    "                        .on('drag', function (event) {\n" +
    "                            var p = _ptr(event), zx2 = _zx(), zy2 = _zy();\n" +
    "                            var c = _ehC(zx2, zy2);\n" +
    "                            var dx = p[0] - c[0], dy = p[1] - c[1];\n" +
    "                            var r = Math.hypot(dx, dy), phi = Math.atan2(dy, dx);\n" +
    "                            if (!(r > 1e-9) || !P) return;\n" +
    "                            // Keep the dragged handle under the cursor: each index has its own\n" +
    "                            // direction relative to the major axis.\n" +
    "                            if (idx === 0) { P.a = r; P.th = phi; }\n" +
    "                            else if (idx === 1) { P.a = r; P.th = phi + Math.PI; }\n" +
    "                            else if (idx === 2) { P.b = r; P.th = phi - Math.PI / 2; }\n" +
    "                            else { P.b = r; P.th = phi + Math.PI / 2; }\n" +
    "                            var D = _glEll.toDisplayAxes(P.a, P.b, P.th, zx2, zy2, isFlipped);\n" +
    "                            E.a = D.a; E.b = D.b; E.th = D.th;\n" +
    "                            gate.outline = null; // ring is stale during a handle drag\n" +
    "                            gate.vertices = _ehRing();\n" +
    "                            _updateGateElements(gate, gg, zx2, zy2, isFlipped);\n" +
    "                            gg.selectAll('circle.eh').data(_glEll.handlePx(c, P))\n" +
    "                                .attr('cx', function (d) { return d[0]; })\n" +
    "                                .attr('cy', function (d) { return d[1]; });\n" +
    "                        })\n" +
    "                        .on('end', function () {\n" +
    "                            _dragging = false;\n" +
    "                            _shinyInput('ellipse_edit', { gate_id: gate.gate_id,\n" +
    "                                mean: [E.m[0], E.m[1]], major: E.a, minor: E.b, angle: E.th,\n" +
    "                                _ts: Date.now() });\n" +
    "                        }));\n" +
    "                });\n" +
    "            }";
  if (out.includes(ellipseHandleAnchor) && !out.includes("gg.selectAll('circle.eh')")) {
    out = out.replace(ellipseHandleAnchor, ellipseHandleBlock);
  } else if (!out.includes("gg.selectAll('circle.eh')")) {
    console.warn("[GateLab] cytof ellipse handle patch: anchor not found — ellipse resize/rotate disabled.");
  }

  // Body-moving a gate goes through _updateGateElements, which repositions the fill, outline,
  // label and `circle.vh` vertex handles — but the ellipse's `circle.eh` axis handles were
  // injected later, so they froze in place until the drag-end payload rebuild. Reposition them
  // from the live ring: a body move only translates the ellipse, so the centre is the ring's
  // centroid and the axis offsets come unchanged from the payload's ellipse geometry. During a
  // HANDLE drag this runs with stale major/minor/angle, but that drag rewrites the same circles
  // from its own live parameters immediately after, in the same call.
  const ehFollowNeedle =
    "        // Update label position — data-space centroid + label_offset (preserves user-moved position)";
  const ehFollowBlock =
    "        // GateLab: ellipse axis handles follow the ring during a body move.\n" +
    "        if (gate.ellipse) {\n" +
    "            var ecx2 = d3.mean(gate.vertices, function (v) { return v[0]; });\n" +
    "            var ecy2 = d3.mean(gate.vertices, function (v) { return v[1]; });\n" +
    "            var ehc2 = _glEll.toPx([ecx2, ecy2], zx, zy, flipped);\n" +
    "            var ehP2 = _glEll.toPixelAxes(gate.ellipse.major, gate.ellipse.minor, gate.ellipse.angle, zx, zy, flipped);\n" +
    "            var ehp2 = _glEll.handlePx(ehc2, ehP2);\n" +
    "            gg.selectAll('circle.eh').each(function (d, i) {\n" +
    "                d3.select(this).attr('cx', ehp2[i][0]).attr('cy', ehp2[i][1]);\n" +
    "            });\n" +
    "        }\n\n" +
    ehFollowNeedle;
  if (out.includes(ehFollowNeedle) && !out.includes("ellipse axis handles follow the ring")) {
    out = out.replace(ehFollowNeedle, ehFollowBlock);
  } else if (!out.includes("ellipse axis handles follow the ring")) {
    console.warn(
      "[GateLab] cytof ellipse handle-follow patch: needle not found — handles will lag a body move.",
    );
  }

  const dragVertexNeedle = "gate.vertices = origVerts.map(";
  if (!out.includes("gate.outline = null; // stale mid-drag")) {
    const hits = out.split(dragVertexNeedle).length - 1;
    if (hits === 4) {
      out = out.split(dragVertexNeedle)
        .join("gate.outline = null; // stale mid-drag\n                    gate.vertices = origVerts.map(");
    } else {
      console.warn(
        `[GateLab] cytof drag-outline patch matched ${hits}/4 vertex mutations — gate edges may ` +
          "lag their handles while dragging.",
      );
    }
  }

  // A polygon's edges are straight in GATING space, where membership is decided. Under a
  // non-linear axis their image is a curve, so joining the transformed vertices with straight
  // lines draws something that is not the gate -- on an arcsinh axis crossing zero the drawn edge
  // misses the real boundary by hundreds of pixels, and events sit on the visibly wrong side of
  // it. GateLab now sends a densified `outline` alongside `vertices`; the path follows it while
  // the drag handles stay bound to `vertices`, so the editable set is unchanged.
  const outlineFlipped = "gate.vertices.map(function (v) { return [zx(v[1]), zy(v[0])]; })";
  const outlineDirect = "_toPx(gate.vertices, zx, zy)";
  if (!out.includes("_gateOutlinePts")) {
    const flippedHits = out.split(outlineFlipped).length - 1;
    const directHits = out.split(outlineDirect).length - 1;
    const defAnchor = "    function _closedLine()";
    if (flippedHits === 2 && directHits === 2 && out.includes(defAnchor)) {
      out = out.split(outlineFlipped).join(
        "_gateOutlinePts(gate).map(function (v) { return [zx(v[1]), zy(v[0])]; })",
      );
      out = out.split(outlineDirect).join("_toPx(_gateOutlinePts(gate), zx, zy)");
      out = out.replace(
        defAnchor,
        "    function _gateEdgeMode() {\n" +
          "        return (_plotData && _plotData.gate_edge_mode) || 'straight-bow';\n" +
          "    }\n" +
          "    function _hasBow(g) { return !!(g.outline && g.outline.length > 2); }\n" +
          "    // The path the gate is drawn with: the true curve only when asked for it.\n" +
          "    function _gateOutlinePts(g) {\n" +
          "        return (_gateEdgeMode() === 'bowed' && _hasBow(g)) ? g.outline : g.vertices;\n" +
          "    }\n" +
          "    // The thin grey companion showing the real boundary behind straight edges.\n" +
          "    function _gateBowPts(g) {\n" +
          "        return (_gateEdgeMode() === 'straight-bow' && _hasBow(g)) ? g.outline : null;\n" +
          "    }\n" +
          "    function _bowPx(g, zx, zy, flipped) {\n" +
          "        var b = _gateBowPts(g);\n" +
          "        if (!b) return null;\n" +
          "        return flipped\n" +
          "            ? b.map(function (v) { return [zx(v[1]), zy(v[0])]; })\n" +
          "            : _toPx(b, zx, zy);\n" +
          "    }\n\n" +
          defAnchor,
      );
    } else {
      console.warn(
        `[GateLab] cytof gate-outline patch matched ${flippedHits}/2 flipped and ` +
          `${directHits}/2 direct sites — curved gate outlines are not applied.`,
      );
    }
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

  // ...and the display binding, which is what actually changes when a logicle W is moved. The
  // range and the sampled point values are not reliable proxies for it: a W change can leave the
  // stated range untouched while remapping every point, and the contour is cached in display
  // pixel space. Pseudocolour never showed this because its cache is cleared on every render;
  // contour only clears when this fingerprint changes, so the density sat still while the axes
  // and gates moved under it.
  const bindingNeedle = "(pd.x_range || []).join(','), (pd.y_range || []).join(',')];";
  const bindingAlt = "(pd.x_range||[]).join(','), (pd.y_range||[]).join(',')];";
  const bindingPatched = "pd.x_binding || ''";
  if (!out.includes(bindingPatched)) {
    const needle = out.includes(bindingNeedle) ? bindingNeedle
      : out.includes(bindingAlt) ? bindingAlt : null;
    if (needle) {
      out = out.replace(
        needle,
        needle.slice(0, -2) + ", pd.x_binding || '', pd.y_binding || ''];",
      );
    } else {
      console.warn("[GateLab] cytof contour binding-key patch did not match — contour may freeze on a scale change.");
    }
  }

  // Draw the events at the display's real resolution.
  //
  // The canvas backing store was sized in CSS pixels, so on a 2x screen a 460x460 bitmap was
  // stretched over 920x920 physical pixels and every event was drawn at half the resolution the
  // display can show. mini_plot already renders at 2x "for crisp on-screen display" (mini_plot.js
  // :103), which is why the Strategy and Illustration grids look sharper than the main plot.
  //
  // The backing store grows; the CSS size does not, and the context is pre-scaled so every
  // drawing call keeps using the same logical 0..PLOT_W coordinates. Nothing downstream changes:
  // there is no setTransform anywhere in the renderer, and every save() is paired with a
  // restore(), so the base scale survives the zoom transform in _drawContour.
  //
  // Clamped to 3: beyond that the buffer grows quadratically for no visible gain (a 630px plot
  // at 4x is a 2520-square buffer, 25MB) and the density passes get slower with it.
  const dprNeedle = `        _canvas = document.createElement('canvas');
        _canvas.width  = PLOT_W;
        _canvas.height = PLOT_H;
        _canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
        ctnr.appendChild(_canvas);
        _ctx = _canvas.getContext('2d');`;
  const dprPatched = "// GateLab: canvas at device resolution; see loadPlots.ts.";
  if (!out.includes(dprPatched)) {
    if (out.includes(dprNeedle)) {
      out = out.replace(
        dprNeedle,
        [
          `        ${dprPatched}`,
          "        var _dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));",
          "        _canvas = document.createElement('canvas');",
          "        _canvas.width  = Math.round(PLOT_W * _dpr);",
          "        _canvas.height = Math.round(PLOT_H * _dpr);",
          "        _canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;' +",
          "            'width:' + PLOT_W + 'px;height:' + PLOT_H + 'px;';",
          "        ctnr.appendChild(_canvas);",
          "        _ctx = _canvas.getContext('2d');",
          "        _ctx.scale(_dpr, _dpr);",
        ].join("\n"),
      );
      // clear() wipes using the backing-store size, which is now _dpr times the logical extent.
      // Harmless (it over-clears past the edge) but wrong on its face, so it says what it means.
      out = out.replace(
        "_ctx.clearRect(0, 0, _canvas.width, _canvas.height);",
        "_ctx.clearRect(0, 0, PLOT_W, PLOT_H); // logical units: the context is pre-scaled",
      );
    } else {
      console.warn("[GateLab] cytof canvas-resolution patch did not match — the plot renders at CSS resolution.");
    }
  }

  // ONE owner for the view: GateLab's pan, not the renderer's.
  //
  // cytof binds `pointerdown.navigate` and runs a complete second pan/stretch implementation on
  // the same background drag that App's `mousedown` handler takes -- both fire, neither knows
  // about the other. They compute from different bases and write to different places: cytof
  // mutates _plotData.x_range/_y_range and _redraw()s immediately, while App writes React state
  // that paints a frame later. Whichever landed last in a given frame is what you saw, so the
  // gesture was nondeterministic -- most visibly with Shift, where the plot would keep panning
  // while the range fields showed a stretch.
  //
  // App's is the one to keep: it commits to globalScales so the Strategy and Illustration tabs
  // inherit the view, it keeps the Min/Max fields in lockstep, and it defers range writes in
  // contour mode. The renderer's is left over from the Shiny app and owns nothing GateLab needs.
  // Only the pan binding goes -- every gate gesture (mousedown.draw, mousemove.draw, click.draw)
  // and the axis-label pickers are untouched.
  //
  // _panActive therefore stays false throughout a drag. That is fine: the only thing it gated was
  // degrading contour to scatter for speed mid-pan, and App does that itself, drawing a
  // contour-mode drag as dots and restoring contours when the drag commits, so the KDE still
  // rebuilds exactly once.
  const navPanNeedle = "_svg.on('pointerdown.navigate', _onNavigatePointerDown)";
  const navPanPatched = "// GateLab: the renderer's pan is disabled; App owns the view. See loadPlots.ts.";
  if (!out.includes(navPanPatched)) {
    if (out.includes(navPanNeedle)) {
      out = out.replace(
        navPanNeedle,
        `${navPanPatched}\n        _svg.on('pointerdown.navigate', null)`,
      );
    } else {
      console.warn("[GateLab] cytof navigate-pan removal did not match — two pan handlers may race.");
    }
  }

  // Pan and shift-drag-stretch change the base scale domain directly and then call _redraw(),
  // which never touches the contour cache. The fingerprint is only consulted inside render(),
  // which these paths never call -- so the cached polygons, which are in BASE-SCALE PIXEL space,
  // get drawn against the new domain and the density sits still while the axes and gates move.
  // The comment on the _finishPan call claims "contour rebuilds at the final range"; nothing
  // rebuilds it. Pseudocolour is unaffected because _redraw() recomputes it from the scales.
  //
  // Clearing the cache where the domain is set is enough: during a drag App sends the plot as
  // dots, so _drawScatter runs instead of _drawContour and the KDE is recomputed exactly once,
  // on release.
  const panFlushNeedle = "_yBase.domain(_plotData.y_range);";
  const panFinishNeedle = "_xBase.domain(pend.x); _yBase.domain(pend.y);";
  const panPatched = "_contourCache = null; // GateLab: base domain changed";
  if (!out.includes(panPatched)) {
    let applied = 0;
    if (out.includes(panFlushNeedle)) {
      out = out.replace(panFlushNeedle, `${panFlushNeedle} ${panPatched}`);
      applied++;
    }
    if (out.includes(panFinishNeedle)) {
      out = out.replace(panFinishNeedle, `${panFinishNeedle} ${panPatched}`);
      applied++;
    }
    if (applied < 2) {
      console.warn("[GateLab] cytof pan contour-invalidation patch matched " + applied +
        "/2 sites — contour may freeze when panning or stretching.");
    }
  }

  // Opt-in diagnostic for the contour cache. It lives in a closure, so there is no way to see
  // from the console whether a redraw reused or rebuilt it -- which is exactly what you need to
  // know when the density sits still while the axes move. Set window.__glContourDebug = true and
  // reproduce; every render logs which part of the fingerprint moved, if any.
  const debugNeedle = "var newContourKey = _makeContourKey(plotData);";
  if (out.includes(debugNeedle) && !out.includes("__glContourDebug")) {
    out = out.replace(
      debugNeedle,
      debugNeedle +
        "\n          if (typeof window !== 'undefined' && window.__glContourDebug) {" +
        "\n              var _kOld = (_contourKey || '').split('|'), _kNew = (newContourKey || '').split('|');" +
        "\n              var _names = ['n','x_label','y_label','bandwidth','threshold','x_range','y_range','x_binding','y_binding'];" +
        "\n              var _changed = [];" +
        "\n              _names.forEach(function (nm, i) { if (_kOld[i] !== _kNew[i]) _changed.push(nm); });" +
        "\n              console.log('[GateLab contour]', newContourKey === _contourKey ? 'REUSED cache' : 'REBUILD'," +
        "\n                  '| changed:', _changed.length ? _changed.join(',') : 'none'," +
        "\n                  '| PLOT_W:', PLOT_W, '| canvas:', (document.querySelector('.gl-plot canvas')||{}).width," +
        "\n                  '| mode:', plotData.display_mode);" +
        "\n          }",
    );
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

  // A workspace can hold raw-space and display-space gates side by side and they look identical
  // on screen, so the space rides on the label as two letters (x then y): R raw, A arcsinh,
  // L logicle, N linear. Without it the two kinds are indistinguishable, which is the silent
  // footgun the whole gating-space design exists to prevent. Suppressed on CyTOF upstream.
  const badgeNeedle = `            var bb = txt.node().getBBox();`;
  const badgePatch = `            if (gate.space_badge) {
                txt.append('tspan')
                    .attr('x', 0).attr('dy', pctLine ? '1.25em' : '1.3em')
                    .style('font-size', '9px')
                    .style('letter-spacing', '0.09em')
                    .attr('fill-opacity', 0.8)
                    .text(gate.space_badge);
            }
            if (gate.space_hint) labelG.append('title').text(gate.space_hint);
${badgeNeedle}`;
  if (out.includes(badgeNeedle) && !out.includes("gate.space_badge")) {
    out = out.replace(badgeNeedle, badgePatch);
  } else if (!out.includes("gate.space_badge")) {
    console.warn("[GateLab] cytof gate space-badge patch did not match.");
  }

  // Quadrant labels: "55.7% (n = 747)", one per screen quadrant, each movable like a gate label
  // with its own offset (quadrant_label_offsets, Q1 to Q4, display units), reported through
  // gate_label_move with the quadrant index. The vendored labels sat fixed at the midpoints,
  // ignored pointer events and read "747  55.7%".
  const quadrantLabelNeedle =
    "        // Four quadrant count/% labels, one per screen quadrant. The data quadrant\n" +
    "        // for each screen corner is derived by inverting the midpoint, so it's\n" +
    "        // correct in both normal and flipped orientation.\n" +
    "        var counts = gate.quadrant_counts || [];\n" +
    "        var pcts   = gate.quadrant_pcts || [];\n" +
    "        var mids = [[cxp / 2, cyp / 2], [(cxp + W) / 2, cyp / 2],\n" +
    "                    [(cxp + W) / 2, (cyp + H) / 2], [cxp / 2, (cyp + H) / 2]];\n" +
    "        mids.forEach(function (pt) {\n" +
    "            var dataX = isFlipped ? zy.invert(pt[1]) : zx.invert(pt[0]);\n" +
    "            var dataY = isFlipped ? zx.invert(pt[0]) : zy.invert(pt[1]);\n" +
    "            var q = (dataX < cx) ? (dataY >= cy ? 1 : 4) : (dataY >= cy ? 2 : 3);\n" +
    "            var n = counts[q - 1], p = pcts[q - 1];\n" +
    "            var txt = (n != null ? Number(n).toLocaleString() : '') +\n" +
    "                      (p != null ? '  ' + Number(p).toFixed(1) + '%' : '');\n" +
    "            if (!txt) return;\n" +
    "            var lx = Math.max(6, Math.min(W - 6, pt[0]));\n" +
    "            var ly = Math.max(12, Math.min(H - 6, pt[1]));\n" +
    "            var lg = gg.append('g').attr('transform', 'translate(' + lx + ',' + ly + ')')\n" +
    "                .style('pointer-events', 'none');\n" +
    "            var t = lg.append('text').attr('text-anchor', 'middle').attr('fill', color)\n" +
    "                .style('font-size', '11px').style('font-weight', '600').text(txt);\n" +
    "            var bb = t.node().getBBox();\n" +
    "            lg.insert('rect', 'text').attr('x', bb.x - 3).attr('y', bb.y - 1)\n" +
    "                .attr('width', bb.width + 6).attr('height', bb.height + 2)\n" +
    "                .attr('rx', 2).attr('fill', 'rgba(255,255,255,0.78)');\n" +
    "        });\n";
  const quadrantLabelPatch =
    "        // GateLab: four quadrant labels, one per screen quadrant, reading \"55.7% (n = 747)\". Each\n" +
    "        // is movable like a gate label: its place is the screen quadrant's midpoint plus a dragged\n" +
    "        // offset in display units, kept per quadrant (quadrant_label_offsets, Q1 to Q4).\n" +
    "        var counts = gate.quadrant_counts || [];\n" +
    "        var pcts   = gate.quadrant_pcts || [];\n" +
    "        var qOffs  = gate.quadrant_label_offsets || [];\n" +
    "        var mids = [[cxp / 2, cyp / 2], [(cxp + W) / 2, cyp / 2],\n" +
    "                    [(cxp + W) / 2, (cyp + H) / 2], [cxp / 2, (cyp + H) / 2]];\n" +
    "        mids.forEach(function (pt) {\n" +
    "            var dataX = isFlipped ? zy.invert(pt[1]) : zx.invert(pt[0]);\n" +
    "            var dataY = isFlipped ? zx.invert(pt[0]) : zy.invert(pt[1]);\n" +
    "            var q = (dataX < cx) ? (dataY >= cy ? 1 : 4) : (dataY >= cy ? 2 : 3);\n" +
    "            var n = counts[q - 1], p = pcts[q - 1];\n" +
    "            var txt = (p != null ? Number(p).toFixed(1) + '%' +\n" +
    "                          (gate.percent_scope ? ' ' + gate.percent_scope : '') : '') +\n" +
    "                      (n != null ? ' (n = ' + Number(n).toLocaleString() + ')' : '');\n" +
    "            if (!txt) return;\n" +
    "            var off = qOffs[q - 1] || [0, 0];\n" +
    "            function qPos(o, zxs, zys) {\n" +
    "                return isFlipped ? [zxs(dataY + o[1]), zys(dataX + o[0])] : [zxs(dataX + o[0]), zys(dataY + o[1])];\n" +
    "            }\n" +
    "            var pos = qPos(off, zx, zy);\n" +
    "            var lg = gg.append('g').attr('class', 'quadrant-label')\n" +
    "                .attr('transform', 'translate(' + pos[0] + ',' + pos[1] + ')')\n" +
    "                .style('cursor', 'move').style('pointer-events', 'all');\n" +
    "            var t = lg.append('text').attr('text-anchor', 'middle').attr('fill', color)\n" +
    "                .style('font-size', '11px').style('font-weight', '600').text(txt);\n" +
    "            var bb = t.node().getBBox();\n" +
    "            lg.insert('rect', 'text').attr('x', bb.x - 3).attr('y', bb.y - 1)\n" +
    "                .attr('width', bb.width + 6).attr('height', bb.height + 2)\n" +
    "                .attr('rx', 2).attr('fill', 'rgba(255,255,255,0.78)');\n" +
    "            (function (g_ref, qi) {\n" +
    "                var origOffset, startX, startY;\n" +
    "                lg.call(d3.drag()\n" +
    "                    .on('start', function (event) {\n" +
    "                        _dragging = true; event.sourceEvent.stopPropagation();\n" +
    "                        origOffset = off.slice();\n" +
    "                        var p0 = _ptr(event);\n" +
    "                        startX = _zx().invert(p0[0]); startY = _zy().invert(p0[1]);\n" +
    "                    })\n" +
    "                    .on('drag', function (event) {\n" +
    "                        var p1 = _ptr(event), zx2 = _zx(), zy2 = _zy();\n" +
    "                        var ddx = zx2.invert(p1[0]) - startX, ddy = zy2.invert(p1[1]) - startY;\n" +
    "                        off = isFlipped ? [origOffset[0] + ddy, origOffset[1] + ddx]\n" +
    "                                        : [origOffset[0] + ddx, origOffset[1] + ddy];\n" +
    "                        var np = qPos(off, zx2, zy2);\n" +
    "                        lg.attr('transform', 'translate(' + np[0] + ',' + np[1] + ')');\n" +
    "                    })\n" +
    "                    .on('end', function () {\n" +
    "                        _dragging = false;\n" +
    "                        _shinyInput('gate_label_move', { gate_id: g_ref.gate_id, label_offset: off, quadrant: qi });\n" +
    "                        _flushDeferredPlot();\n" +
    "                    }));\n" +
    "            }(gate, q - 1));\n" +
    "        });\n";
  if (out.includes(quadrantLabelNeedle) && !out.includes("quadrant_label_offsets")) {
    out = out.replace(quadrantLabelNeedle, quadrantLabelPatch);
  } else if (!out.includes("quadrant_label_offsets")) {
    console.warn("[GateLab] cytof quadrant-label patch did not match — quadrant labels stay fixed.");
  }

  // A gate count is exact for the file it was taken from. When the plot pools several checked
  // files the app supplies counts pooled over the same files and names that scope, and the label
  // says so beside the percentage: a bare "0.0%" under a dense pooled cloud is the misreading
  // this prevents. The scope's hint takes the label tooltip, carrying the space hint with it,
  // since a browser shows only the first <title>.
  const scopeNeedle =
    "                ? Number(gate.percent_of_parent).toFixed(1) + '%'\n" +
    "                : null;";
  const scopePatch =
    "                ? Number(gate.percent_of_parent).toFixed(1) + '%' +\n" +
    "                  (gate.percent_scope ? ' ' + gate.percent_scope : '')\n" +
    "                : null;\n" +
    "            if (gate.percent_scope_hint) {\n" +
    "                labelG.append('title').text(gate.percent_scope_hint +\n" +
    "                    (gate.space_hint ? '\\n' + gate.space_hint : ''));\n" +
    "            }";
  // The quadrant labels carry the scope themselves (quadrantLabelPatch above).
  if (out.includes(scopeNeedle) && !out.includes("labelG.append('title').text(gate.percent_scope_hint")) {
    out = out.replace(scopeNeedle, scopePatch);
  } else if (!out.includes("labelG.append('title').text(gate.percent_scope_hint")) {
    console.warn("[GateLab] cytof gate count-scope patch did not match.");
  }

  // Curly quadrants: a quadrant payload may carry `arms`, the bent dividers beyond the crosshair
  // as display-space polylines (gatePayload.ts). They are drawn as paths, the straight halves
  // stay lines, and when the gate is selected a handle at the end of each arm sets its bend:
  // during the drag the arm's bend is scaled so its end follows the pointer, and on drop the
  // handle's display position goes to the host, which recomputes the coefficient exactly.
  const curlyLinesNeedle =
    "        // Visible crosshair (non-interactive).\n" +
    "        var vline = gg.append('line').attr('class', 'q-vline')\n" +
    "            .attr('x1', cxp).attr('y1', 0).attr('x2', cxp).attr('y2', H)\n" +
    "            .attr('stroke', color).attr('stroke-width', lw).style('pointer-events', 'none');\n" +
    "        var hline = gg.append('line').attr('class', 'q-hline')\n" +
    "            .attr('x1', 0).attr('y1', cyp).attr('x2', W).attr('y2', cyp)\n" +
    "            .attr('stroke', color).attr('stroke-width', lw).style('pointer-events', 'none');";
  const curlyLinesPatch =
    "        // Visible crosshair (non-interactive); with bent arms, the straight halves only.\n" +
    "        var arms = gate.arms && gate.arms.h && gate.arms.v ? gate.arms : null;\n" +
    "        var _armPx = function (pts) { return pts.map(function (p) {\n" +
    "            return isFlipped ? [zx(p[1]), zy(p[0])] : [zx(p[0]), zy(p[1])]; }); };\n" +
    "        var _armPath = function (pts) { return pts.map(function (p, i) {\n" +
    "            return (i ? 'L' : 'M') + p[0].toFixed(2) + ',' + p[1].toFixed(2); }).join(''); };\n" +
    "        var vline = gg.append('line').attr('class', 'q-vline')\n" +
    "            .attr('x1', cxp).attr('y1', arms ? cyp : 0).attr('x2', cxp).attr('y2', H)\n" +
    "            .attr('stroke', color).attr('stroke-width', lw).style('pointer-events', 'none');\n" +
    "        var hline = gg.append('line').attr('class', 'q-hline')\n" +
    "            .attr('x1', 0).attr('y1', cyp).attr('x2', arms ? cxp : W).attr('y2', cyp)\n" +
    "            .attr('stroke', color).attr('stroke-width', lw).style('pointer-events', 'none');\n" +
    "        var armH = null, armV = null, armHpx = null, armVpx = null, armHandleSel = [];\n" +
    "        if (arms) {\n" +
    "            armHpx = _armPx(arms.h); armVpx = _armPx(arms.v);\n" +
    "            armH = gg.append('path').attr('class', 'q-arm-h').attr('d', _armPath(armHpx))\n" +
    "                .attr('fill', 'none').attr('stroke', color).attr('stroke-width', lw).style('pointer-events', 'none');\n" +
    "            armV = gg.append('path').attr('class', 'q-arm-v').attr('d', _armPath(armVpx))\n" +
    "                .attr('fill', 'none').attr('stroke', color).attr('stroke-width', lw).style('pointer-events', 'none');\n" +
    "        }";
  const curlyDragNeedle =
    "                    vline.attr('x1', ncxp).attr('x2', ncxp);\n" +
    "                    hline.attr('y1', ncyp).attr('y2', ncyp);\n" +
    "                    handle.attr('cx', ncxp).attr('cy', ncyp);";
  const curlyDragPatch =
    "                    vline.attr('x1', ncxp).attr('x2', ncxp);\n" +
    "                    hline.attr('y1', ncyp).attr('y2', ncyp);\n" +
    "                    handle.attr('cx', ncxp).attr('cy', ncyp);\n" +
    "                    if (arms) {\n" +
    "                        vline.attr('y1', ncyp); hline.attr('x2', ncxp);\n" +
    "                        var tr = 'translate(' + (ncxp - cxp) + ',' + (ncyp - cyp) + ')';\n" +
    "                        if (armH) armH.attr('transform', tr);\n" +
    "                        if (armV) armV.attr('transform', tr);\n" +
    "                        armHandleSel.forEach(function (c) { c.attr('transform', tr); });\n" +
    "                    }";
  const curlyHandleNeedle =
    "            handle.call(drag);\n" +
    "        }\n" +
    "    }\n" +
    "\n" +
    "    function _drawGates(zx, zy) {";
  const curlyHandlePatch =
    "            handle.call(drag);\n" +
    "            if (arms && armHpx && armVpx && armHpx.length > 1 && armVpx.length > 1) {\n" +
    "                var _armHandle = function (which, pathSel, pxs) {\n" +
    "                    // The arm runs to the plot's edge; its handle sits part-way along it,\n" +
    "                    // where it can be reached and where the bend is already visible.\n" +
    "                    var base = pxs[0], end = pxs[Math.max(1, Math.round((pxs.length - 1) * 0.6))];\n" +
    "                    // The arm runs along screen x when it is the data-x arm and the axes are\n" +
    "                    // not flipped, or the data-y arm and they are; its bend is on the other axis.\n" +
    "                    var alongX = (which === 'h') !== isFlipped;\n" +
    "                    var hx = end[0], hy = end[1];\n" +
    "                    var h = gg.append('circle').attr('class', 'vh')\n" +
    "                        .attr('cx', hx).attr('cy', hy).attr('r', VRAD)\n" +
    "                        .attr('fill', 'white').attr('stroke', color).attr('stroke-width', 2)\n" +
    "                        .style('cursor', alongX ? 'ns-resize' : 'ew-resize').style('pointer-events', 'all');\n" +
    "                    armHandleSel.push(h);\n" +
    "                    var moved = false;\n" +
    "                    var dragArm = d3.drag()\n" +
    "                        .on('start', function (event) { _dragging = true; event.sourceEvent.stopPropagation(); })\n" +
    "                        .on('drag', function (event) {\n" +
    "                            var p = _ptr(event); moved = true;\n" +
    "                            var n = pxs.length - 1, pts;\n" +
    "                            if (alongX) {\n" +
    "                                hy = p[1];\n" +
    "                                var have = end[1] - base[1], want = hy - base[1];\n" +
    "                                pts = pxs.map(function (q, i) { return [q[0], base[1] + (Math.abs(have) > 1\n" +
    "                                    ? (q[1] - base[1]) * (want / have) : want * Math.pow(i / n, 1.5))]; });\n" +
    "                            } else {\n" +
    "                                hx = p[0];\n" +
    "                                var haveX = end[0] - base[0], wantX = hx - base[0];\n" +
    "                                pts = pxs.map(function (q, i) { return [base[0] + (Math.abs(haveX) > 1\n" +
    "                                    ? (q[0] - base[0]) * (wantX / haveX) : wantX * Math.pow(i / n, 1.5)), q[1]]; });\n" +
    "                            }\n" +
    "                            h.attr('cx', hx).attr('cy', hy);\n" +
    "                            pathSel.attr('d', _armPath(pts));\n" +
    "                        })\n" +
    "                        .on('end', function () {\n" +
    "                            _dragging = false;\n" +
    "                            if (!moved) return;\n" +
    "                            _editSeq++;\n" +
    "                            var at = isFlipped ? [zy.invert(hy), zx.invert(hx)] : [zx.invert(hx), zy.invert(hy)];\n" +
    "                            _shinyInput('gate_quadrant_curl', { gate_id: gate.gate_id, arm: which, at: at, seq: _editSeq });\n" +
    "                            _flushDeferredPlot();\n" +
    "                        });\n" +
    "                    h.call(dragArm);\n" +
    "                };\n" +
    "                _armHandle('h', armH, armHpx);\n" +
    "                _armHandle('v', armV, armVpx);\n" +
    "            }\n" +
    "        }\n" +
    "    }\n" +
    "\n" +
    "    function _drawGates(zx, zy) {";
  if (out.includes(curlyLinesNeedle) && out.includes(curlyDragNeedle) && out.includes(curlyHandleNeedle)) {
    out = out.replace(curlyLinesNeedle, curlyLinesPatch)
      .replace(curlyDragNeedle, curlyDragPatch)
      .replace(curlyHandleNeedle, curlyHandlePatch);
  } else if (!out.includes("gate_quadrant_curl")) {
    console.warn("[GateLab] cytof curly-quadrant patch did not match — bent arms will draw as a straight crosshair.");
  }

  // Two fixes to axis-label crowding, both around zero.
  //
  // 1. The label thinning ran only for tick_mode 'asinh' and 'logicle'. Scatter axes were excluded
  //    on the stated grounds that "decade-spaced labels never overlap" — true of a pure log10
  //    axis, false of an ARCSINH scatter axis, which packs -100, -10, 0, 10, 100 into a few pixels
  //    either side of zero. Now run for every tick mode; it is a no-op when nothing is crowded.
  //
  // 2. The thinning kept labels left-to-right, so the crowd around zero was resolved by keeping
  //    whichever label happened to be leftmost and dropping the rest — including 0 itself. On a
  //    transformed axis 0 is the anchor that shows where the linear region sits, so it is now
  //    considered first and the rest fan outward from it.
  const thinNeedle = `    function _hideCompressedLabels(sel, scale, minSpacingPx) {`;
  const thinBody = /_hideCompressedLabels\(sel, scale, minSpacingPx\) \{[\s\S]*?\n    \}\n/;
  if (out.includes(thinNeedle) && !out.includes("labeled.sort(function (a, b) { return a.mag - b.mag; })")) {
    out = out.replace(
      thinBody,
      `_hideCompressedLabels(sel, scale, minSpacingPx) {
        var labeled = [];
        sel.selectAll('.tick text').each(function(d) {
            var el = d3.select(this);
            if (el.style('display') !== 'none' && el.text() !== '') {
                labeled.push({ el: el, px: scale(d), mag: Math.abs(Number(d)) });
            }
        });
        labeled.sort(function (a, b) { return a.mag - b.mag; });
        var kept = [];
        for (var i = 0; i < labeled.length; i++) {
            var clash = false;
            for (var j = 0; j < kept.length; j++) {
                if (Math.abs(labeled[i].px - kept[j]) < minSpacingPx) { clash = true; break; }
            }
            if (clash) labeled[i].el.style('display', 'none');
            else kept.push(labeled[i].px);
        }
    }\n`,
    );
  }
  const scatterThinX = `            if (xTicks.tick_mode === 'asinh' || xTicks.tick_mode === 'logicle') {
                _hideCompressedLabels(_g.select('.x-axis'), zx, 28);
            }`;
  const scatterThinY = `            if (yTicks.tick_mode === 'asinh' || yTicks.tick_mode === 'logicle') {
                _hideCompressedLabels(_g.select('.y-axis'), zy, 18);
            }`;
  let thinHits = 0;
  if (out.includes(scatterThinX)) {
    thinHits++;
    out = out.replace(scatterThinX, `            _hideCompressedLabels(_g.select('.x-axis'), zx, 28);`);
  }
  if (out.includes(scatterThinY)) {
    thinHits++;
    out = out.replace(scatterThinY, `            _hideCompressedLabels(_g.select('.y-axis'), zy, 18);`);
  }
  if (thinHits !== 2 && !out.includes("labeled.sort(function (a, b) { return a.mag - b.mag; })")) {
    console.warn(`[GateLab] cytof axis-label thinning patch matched ${thinHits}/2 axes.`);
  }

  // Saved gate fills have D3 drag handlers and cover large parts of the plot. While drawing, the
  // whole saved-gate layer must be transparent to pointer input so every click reaches the plot
  // overlay — otherwise a new gate cannot be started inside an existing one, and the move cursor
  // appears over gates mid-draw. The preview is visual-only; close detection is coordinate based.
  //
  // Derived from the CURRENT mode and re-asserted wherever the layer is rebuilt, rather than set
  // once when the mode changes. _init() recreates .gate-layer (first paint, a missing canvas, or a
  // >30px column resize) and _applyMode only runs on a CHANGE of mode, so the one-shot version was
  // silently dropped by the next re-init and gates started intercepting clicks again.
  const syncMarker = "function _syncGatePointerEvents()";
  const applyModeNeedle = "    function _applyMode(newMode) {";
  const modeNeedle = `_g.select('.cytof-overlay').style('cursor',
            newMode === 'navigate' ? 'default' : 'crosshair');`;
  const readyNeedle = "        _ready = true;";
  if (!out.includes(syncMarker)) {
    let hits = 0;
    if (out.includes(applyModeNeedle)) {
      hits++;
      out = out.replace(
        applyModeNeedle,
        `    // GateLab: gate pointer-events follow the current mode; see loadPlots.ts.
    function _syncGatePointerEvents() {
        if (!_g) return;
        var drawing = _mode !== 'navigate';
        // The class is what actually works: the gate children declare pointer-events inline, and
        // an inline value beats one inherited from this group. See .gl-gates-inert in styles.css.
        _g.select('.gate-layer').classed('gl-gates-inert', drawing)
            .style('pointer-events', drawing ? 'none' : null);
        _g.select('.draw-layer').style('pointer-events', 'none');
        _g.select('.cytof-overlay').style('cursor', drawing ? 'crosshair' : 'default');
    }

${applyModeNeedle}`,
      );
    }
    if (out.includes(modeNeedle)) {
      hits++;
      out = out.replace(modeNeedle, "_syncGatePointerEvents();");
    }
    if (out.includes(readyNeedle)) {
      hits++;
      out = out.replace(readyNeedle, `${readyNeedle}\n        _syncGatePointerEvents();`);
    }
    if (hits !== 3) {
      console.warn(
        `[GateLab] cytof draw-mode pointer patch matched ${hits}/3 sites — saved gates will ` +
          "intercept clicks while a gate tool is active.",
      );
    }
  }

  // The channel picker opens UPWARD when there is no room below it.
  //
  // The panel is anchored at labelRect.bottom + 4, which is right for the Y-axis label (up the
  // left edge) and wrong for the X-axis label, which sits at the BOTTOM of the plot: the list
  // then extends past the viewport and the channels at its end cannot be reached at all. The
  // panel is measured after mounting, because its height depends on how many channels the file
  // has -- `sel.size` is min(channels, 12), so a 13-channel file and a 40-channel file differ.
  const pickerFitMarker = "// GateLab: flip the channel picker above the label when it will not fit below.";
  const pickerAppendNeedle = "        document.body.appendChild(panel);";
  if (!out.includes(pickerFitMarker) && out.includes(pickerAppendNeedle)) {
    out = out.replace(
      pickerAppendNeedle,
      `${pickerAppendNeedle}
        ${pickerFitMarker}
        (function () {
            var margin = 4;
            var h = panel.getBoundingClientRect().height;
            var below = window.innerHeight - (labelRect.bottom + margin);
            var above = labelRect.top - margin;
            if (h <= below) return;                       // fits where it is
            if (above > below) {
                // Flip above, clamped so the top of the list stays reachable on a short window.
                panel.style.top = Math.max(margin, labelRect.top - margin - h) + 'px';
            } else {
                // More room below than above, but still not enough: sit against the bottom edge.
                panel.style.top = Math.max(margin, window.innerHeight - h - margin) + 'px';
            }
        })();`,
    );
  } else if (!out.includes(pickerFitMarker)) {
    console.warn("[GateLab] cytof channel-picker fit patch did not match — the X picker may open off-screen.");
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
  // The renderer now maps density by quantile rank (equal-probability, as FlowJo does).
  // The exponent composes with it as a bias on that ramp, which keeps its documented meaning
  // — above one still reserves yellow/red for the genuinely densest cores — while the ramp
  // itself stays self-normalising across samples.
  const densityPowerNeedle = "var t = cache.rank[i];";
  const densityPowerPatch = "var t = Math.pow(Math.min(1, cache.rank[i]), colourPower);";
  // Kept so an older pinned submodule, which still divides by the peak, is patched too.
  const legacyPeakNeedle = "var t = cache.densities[i] / cache.maxDens;";
  const legacyPeakPatch = "var t = Math.pow(Math.min(1, cache.densities[i] / cache.maxDens), colourPower);";
  if (out.includes(legacyPeakNeedle)) out = out.replace(legacyPeakNeedle, legacyPeakPatch);
  if (out.includes(densityPowerSetupNeedle)) out = out.replace(densityPowerSetupNeedle, densityPowerSetupPatch);
  if (out.includes(densityPowerNeedle)) out = out.replace(densityPowerNeedle, densityPowerPatch);
  if (
    !out.includes("_plotData.density_color_power") ||
    !(out.includes(densityPowerPatch) || out.includes(legacyPeakPatch))
  ) {
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
  // Expose the existing renderer to the React figure compositor without modifying the submodule.
  src = src.replace("renderMiniPlot: renderMiniPlot,", "renderMiniPlot: renderMiniPlot, renderRidgelinePanel: renderRidgelinePanel,");
  // Default the grid canvases to the DISPLAY's resolution, as the gating plot now does.
  //
  // mini_plot already supersamples, but at a hardcoded 2x. That happens to be right on a 2x
  // screen, which is why the Strategy and Illustration grids looked sharper than the main plot
  // while it was still drawing at CSS resolution. It is wrong in both directions elsewhere: on a
  // 3x display the grids are now the soft ones, and on a 1x display every grid cell carries four
  // times the pixels for no visible gain, which matters when dozens are rendered at once.
  //
  // Only the DEFAULT changes. Callers that pass canvas_scale explicitly still win, so the
  // compensation inspector keeps its 3x and every export keeps its dpi/96.
  const gridDprNeedle = "if (!isFinite(CANVAS_SCALE) || CANVAS_SCALE <= 0) CANVAS_SCALE = 2;";
  const gridDprPatch =
    "if (!isFinite(CANVAS_SCALE) || CANVAS_SCALE <= 0) {\n" +
    "            // GateLab: match the display, capped like the gating plot. See loadPlots.ts.\n" +
    "            CANVAS_SCALE = Math.min(3, Math.max(1, window.devicePixelRatio || 1));\n" +
    "        }";
  const gridDprSites = src.split(gridDprNeedle).length - 1;

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
            bottom: _resolvedMargin('bottom', 50, 24, 90),
            left: _resolvedMargin('left', 54, 28, 100)
        };
        // Size the title offsets from the ACTUAL tick-label vocabulary. A fixed 32px offset put a
        // rotated y title through labels such as "100K"; a wider outer margin alone only moved the
        // overlap. Explicit compensation-inspector margins and offsets still win.
        var _baseFs = cfg.font_sizes || {};
        var _tickFsForMargin = Number(_baseFs.tick);
        if (!isFinite(_tickFsForMargin)) _tickFsForMargin = 9;
        var _axisFsForMargin = Number(_baseFs.axis_label);
        if (!isFinite(_axisFsForMargin)) _axisFsForMargin = 11;
        var _yTickLabels = cfg.y_logicle_ticks && cfg.y_logicle_ticks.major_labels;
        var _maxYChars = Array.isArray(_yTickLabels) && _yTickLabels.length
            ? Math.max.apply(null, _yTickLabels.map(function (label) { return String(label).length; }))
            : 5;
        var _estimatedYTickWidth = _maxYChars * _tickFsForMargin * 0.62;
        if (!isFinite(Number(cfg.y_axis_label_offset))) {
            cfg.y_axis_label_offset = Math.ceil(Math.max(32, _estimatedYTickWidth + 15));
        }
        if (!isFinite(Number(cfg.x_axis_label_offset))) {
            cfg.x_axis_label_offset = Math.ceil(Math.max(34, _tickFsForMargin + 24));
        }
        if (!isFinite(Number(requestedMargins.left)) && cfg.y_label) {
            var _neededLeft = Math.ceil(Number(cfg.y_axis_label_offset) + _axisFsForMargin + 4);
            if (_neededLeft > M.left) M.left = Math.min(140, _neededLeft);
        }
        if (!isFinite(Number(requestedMargins.bottom))) {
            var _neededBottom = Math.ceil(Number(cfg.x_axis_label_offset) + _axisFsForMargin + 4);
            if (_neededBottom > M.bottom) M.bottom = Math.min(100, _neededBottom);
        }
        // Keep every tick mark, but suppress labels that cannot fit at the actual panel size.
        // Zero has priority in the compressed region of a logicle axis.
        function _spacedTicks(ticks, range, pixels, vertical) {
            if (!ticks || !Array.isArray(ticks.major_pos) || !Array.isArray(ticks.major_labels) || !range || !(range[1] > range[0])) return ticks;
            var labels = ticks.major_labels.map(function () { return ''; }), occupied = [];
            var indices = ticks.major_pos.map(function (_, i) { return i; });
            indices.sort(function (a, b) { return (String(ticks.major_labels[b]) === '0' ? 1 : 0) - (String(ticks.major_labels[a]) === '0' ? 1 : 0) || a - b; });
            indices.forEach(function (i) {
                var label = String(ticks.major_labels[i] || '');
                var position = (ticks.major_pos[i] - range[0]) / (range[1] - range[0]) * pixels;
                var half = (vertical ? _tickFsForMargin : label.length * _tickFsForMargin * 0.62) / 2 + 4;
                if (label && occupied.every(function (other) { return position + half < other[0] || position - half > other[1]; })) {
                    labels[i] = label; occupied.push([position - half, position + half]);
                }
            });
            return Object.assign({}, ticks, { major_labels: labels });
        }
        cfg = Object.assign({}, cfg, {
            x_logicle_ticks: _spacedTicks(cfg.x_logicle_ticks, cfg.x_range, Number(cfg.plot_size || 200) - M.left - M.right, false),
            y_logicle_ticks: _spacedTicks(cfg.y_logicle_ticks, cfg.y_range, Number(cfg.plot_size || 200) - M.top - M.bottom, true)
        });`;
  if (out.includes(marginNeedle)) {
    out = out.replace(marginNeedle, marginPatch);
  } else if (!out.includes("var requestedMargins = cfg.plot_margins || {};")) {
    console.warn("[GateLab] mini_plot configurable-margin patch did not match.");
  }

  // The Illustration payload has always dropped quadrant gates because mini_plot only understood
  // closed polygons. Teach the shared static overlay renderer the same crosshair vocabulary as the
  // interactive plot: straight or bent positive arms, four percentages, and publication styling.
  const quadrantOverlayNeedle = `        var verts = gate.vertices;
        if (!verts || verts.length < 2) return;`;
  const quadrantOverlayPatch = `        if (gate.gate_type === 'quadrant') {
            var qc = gate.center || [];
            var qcx = xScale(qc[0]), qcy = yScale(qc[1]);
            if (!isFinite(qcx) || !isFinite(qcy)) return;
            var qColor = pubStyle ? '#000000' : (gate.color || '#e41a1c');
            var qArms = gate.arms && gate.arms.h && gate.arms.v ? gate.arms : null;
            var qg = g.append('g').attr('class', 'quadrant-gate mini-quadrant-gate');
            function qPath(points) {
                return points.map(function (point, index) {
                    return (index ? 'L' : 'M') + xScale(point[0]) + ',' + yScale(point[1]);
                }).join('');
            }
            // Negative halves remain straight. Positive x/y arms may carry FlowJo's curl.
            qg.append('line').attr('x1', 0).attr('y1', qcy)
                .attr('x2', qArms ? qcx : W).attr('y2', qcy)
                .attr('stroke', qColor).attr('stroke-width', lineWidth);
            qg.append('line').attr('x1', qcx).attr('y1', H)
                .attr('x2', qcx).attr('y2', qArms ? qcy : 0)
                .attr('stroke', qColor).attr('stroke-width', lineWidth);
            if (qArms) {
                qg.append('path').attr('d', qPath(qArms.h)).attr('fill', 'none')
                    .attr('stroke', qColor).attr('stroke-width', lineWidth);
                qg.append('path').attr('d', qPath(qArms.v)).attr('fill', 'none')
                    .attr('stroke', qColor).attr('stroke-width', lineWidth);
            }
            var qCounts = gate.quadrant_counts || [];
            var qPcts = gate.quadrant_pcts || [];
            var qMids = [[qcx / 2, qcy / 2], [(qcx + W) / 2, qcy / 2],
                         [(qcx + W) / 2, (qcy + H) / 2], [qcx / 2, (qcy + H) / 2]];
            var qFs = parseFloat(gateFs);
            if (!isFinite(qFs) || qFs <= 0) qFs = 9;
            var qOffs = gate.quadrant_label_offsets || [];
            qMids.forEach(function (point, index) {
                var count = qCounts[index], pct = qPcts[index];
                var text = (pct != null ? Number(pct).toFixed(1) + '%' : '') +
                    (count != null ? ' (n = ' + Number(count).toLocaleString() + ')' : '');
                // A label the user moved on the gating plot sits at the same offset here.
                var qOff = qOffs[index];
                if (qOff) point = [xScale(xScale.invert(point[0]) + qOff[0]), yScale(yScale.invert(point[1]) + qOff[1])];
                var label = qg.append('g').attr('class', 'quadrant-label')
                    .attr('transform', 'translate(' + point[0] + ',' + point[1] + ')');
                // The host may let the label move: report its offset from the crosshair-relative
                // resting point, in display units, with the quadrant it belongs to.
                if (gateStyle && typeof gateStyle.on_label_move === 'function' && gate.gate_id) {
                    var rest = qMids[index], qx = point[0], qy = point[1], qMoved = false;
                    label.style('cursor', 'move').style('pointer-events', 'all')
                        .call(d3.drag()
                            .on('start', function (event) { if (event.sourceEvent) event.sourceEvent.stopPropagation(); })
                            .on('drag', function (event) {
                                qx += event.dx; qy += event.dy; qMoved = true;
                                label.attr('transform', 'translate(' + qx + ',' + qy + ')');
                            })
                            .on('end', function () {
                                if (!qMoved) return;
                                gateStyle.on_label_move(gate.gate_id,
                                    [xScale.invert(qx) - xScale.invert(rest[0]), yScale.invert(qy) - yScale.invert(rest[1])], index);
                            }));
                }
                var textNode = label.append('text').attr('text-anchor', 'middle')
                    .attr('fill', qColor).style('font-size', gateFs).style('font-weight', 600)
                    .text(text);
                if (!pubStyle) {
                    var box;
                    try { box = textNode.node().getBBox(); }
                    catch (_quadrantBoxError) {
                        box = { x: -text.length * qFs * 0.3, y: -qFs * 0.8,
                                width: text.length * qFs * 0.6, height: qFs };
                    }
                    label.insert('rect', 'text').attr('x', box.x - 3).attr('y', box.y - 1)
                        .attr('width', box.width + 6).attr('height', box.height + 2)
                        .attr('rx', 2).attr('fill', 'rgba(255,255,255,0.78)');
                }
            });
            return;
        }

        var verts = gate.vertices;
        if (!verts || verts.length < 2) return;`;
  if (out.includes(quadrantOverlayNeedle)) {
    out = out.replace(quadrantOverlayNeedle, quadrantOverlayPatch);
  } else if (!out.includes("mini-quadrant-gate")) {
    console.warn("[GateLab] mini_plot quadrant-overlay patch did not match.");
  }
  const illustrationFitNeedle = `                // Expand to fit if possible, but never shrink below requested size.
                effectivePlotSize = Math.max(plotSize, fitSize);`;
  const illustrationFitPatch = `                // Fit is a ceiling: preserve the requested size when it fits and shrink only
                // when the chosen columns would otherwise overflow. It must never inflate a
                // 150px request into the same viewport-filling panel as a 500px request.
                effectivePlotSize = Math.max(120, Math.min(plotSize, fitSize));`;
  if (out.includes(illustrationFitNeedle)) {
    out = out.replace(illustrationFitNeedle, illustrationFitPatch);
  } else if (!out.includes("Fit is a ceiling")) {
    console.warn("[GateLab] mini_plot illustration fit-to-columns patch did not match.");
  }
  // A gate is straight only in the space it was drawn in, so it bows once an axis is shown on a
  // different scale. The main gating plot has offered straight / straight+grey bow / bowed since
  // v0.6.0, but the Strategy and Illustration grids always drew straight chords — and those are
  // the views that become figures, so a published gate could differ from the one actually applied.
  // gate_style already reaches both grids, so the mode rides along with no other plumbing.
  const edgeNeedle =
    "        var pathStr = 'M' + points.map(function (p) {\n" +
    "            return p[0] + ',' + p[1];\n" +
    "        }).join('L') + 'Z';";
  const edgePatch =
    "        var _edgeMode = gateStyle.gate_edge_mode || 'straight-bow';\n" +
    "        function _toPath(pts) {\n" +
    "            return 'M' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join('L') + 'Z';\n" +
    "        }\n" +
    "        // Same test the gating plot uses: rectangles and quadrants carry no outline and\n" +
    "        // provably never bow, so they are unaffected by the mode.\n" +
    "        var _bowPts = (gate.outline && gate.outline.length > 2)\n" +
    "            ? gate.outline.map(function (v) { return [xScale(v[0]), yScale(v[1])]; })\n" +
    "            : null;\n" +
    "        if (_edgeMode === 'straight-bow' && _bowPts) {\n" +
    "            g.append('path')\n" +
    "                .attr('d', _toPath(_bowPts))\n" +
    "                .attr('fill', 'none')\n" +
    "                .attr('stroke', '#8a8a8a')\n" +
    "                .attr('stroke-width', Math.max(0.5, lineWidth * 0.67))\n" +
    "                .attr('stroke-opacity', 0.9);\n" +
    "        }\n" +
    "        // The label stays on the straight centroid so it does not shift with the mode.\n" +
    "        var pathStr = _toPath((_edgeMode === 'bowed' && _bowPts) ? _bowPts : points);";
  if (out.includes(edgeNeedle)) {
    out = out.replace(edgeNeedle, edgePatch);
  } else if (!out.includes("var _edgeMode = gateStyle.gate_edge_mode")) {
    console.warn("[GateLab] mini_plot gate-edge-mode patch did not match.");
  }

  const levelNeedle = "var nLevels = 18;";
  const levelPatchedNeedle = "var nLevels = Math.max(6, Math.min(18, Math.round(18 * Math.min(W, H) / 270)));";
  const lineNeedle = "ctx.lineWidth = 1.0;";
  if (out.includes(levelNeedle)) {
    out = out.replace(levelNeedle, levelPatchedNeedle);
  } else if (!out.includes(levelPatchedNeedle) && !out.includes("var requestedLevels = Number((cfg || {}).contour_levels)")) {
    console.warn("[GateLab] mini_plot contour-levels patch did not match.");
  }
  if (out.includes(lineNeedle)) {
    out = out.replace(lineNeedle, "ctx.lineWidth = Math.max(0.5, Math.min(1.0, Math.min(W, H) / 270));");
  }

  // Compensation biplots can contain a very large exact-zero pile. Scaling the colour ramp to
  // the single densest point makes every informative off-axis population faint. When explicitly
  // requested, match SpillQC's robust hexbin convention: cap the colour ceiling at a quantile of
  // OCCUPIED density cells (not events), then apply the shared colour transfer. Compensation callers
  // provide a power-adjusted shared ceiling so clipped red plateaus contract at higher settings.
  // All events are still drawn; this changes only colour normalisation and cannot hide a zero pile.
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
  // Carry the gate's true boundary into the strategy grid.
  //
  // The grid builder rebuilds each gate as a fresh object from the step, and its field list left
  // out `outline` — the densified true edge. Everything downstream was already correct: the
  // payload computes the outline, the gate-edge mode reaches the renderer, and the draw code
  // reads gate.outline. It was simply never on the object, so _bowPts was always null and the
  // Strategy grid drew straight chords no matter which mode was selected.
  const strategyOutlineNeedle = "                    label_offset: step.label_offset";
  const strategyOutlinePatch =
    "                    label_offset: step.label_offset,\n" +
    "                    outline: step.outline";
  if (out.includes(strategyOutlineNeedle) && !out.includes("outline: step.outline")) {
    out = out.replace(strategyOutlineNeedle, strategyOutlinePatch);
  } else if (!out.includes("outline: step.outline")) {
    console.warn("[GateLab] mini_plot strategy-outline patch did not match — the grid cannot draw true gate edges.");
  }

  // Contours are drawn dark in the grids, as they are on the gating plot.
  //
  // The strategy-grid builder hardcodes pop_color '#3182ce', which is right for a histogram fill
  // and wrong for a contour: the contour path took it for both its lines and its outlier dots, so
  // every Strategy panel in contour mode came out blue while the same population on the gating
  // plot was black. Reading a dedicated contour_color instead leaves histograms their fill and
  // leaves the back-gated overlay its orange, which is doing real work distinguishing the two.
  const contourColourNeedle =
    "                    line_color: cfg.pop_color || '#111111',\n" +
    "                    outlier_color: cfg.pop_color || '#111111',";
  const contourColourPatch =
    "                    line_color: cfg.contour_color || '#111111',\n" +
    "                    outlier_color: cfg.contour_color || '#111111',";
  if (out.includes(contourColourNeedle)) {
    out = out.replace(contourColourNeedle, contourColourPatch);
  } else if (!out.includes("cfg.contour_color")) {
    console.warn("[GateLab] mini_plot contour-colour patch did not match — grid contours stay population-coloured.");
  }

  // Colour by QUANTILE RANK, the same mapping the gating plot uses, so a population does not
  // change colour when you look at it in a grid instead of on the main plot.
  //
  // The two renderers had drifted apart: cytof_plot maps by equal-probability rank (as FlowJo
  // does), while this one mapped density as a fraction of a ceiling. Rank is self-normalising,
  // which is what the ceiling was working around -- an exact-zero pile occupies the bottom of
  // the ramp by construction rather than dragging the top of it upward. Ties share a mid-rank,
  // so two events in the same density bin cannot take different colours from their sort order.
  //
  // The ceiling machinery above still runs; it now only bounds the smoothing/clip path, and an
  // explicit density_color_ceiling is still honoured by callers that set one.
  const densityRatioNeedle = "var t = densities[idx] / maxDens;";
  const densityRatioPatch =
    "var t = Math.pow(Math.min(1, _rank[idx]), colourPower);";
  // The rank array, built from the sort this renderer already performs.
  const rankSetupNeedle = "        ctx.globalAlpha = pointAlpha;";
  const rankSetupPatch = `        var _rank = new Float32Array(n);
        var _denom = n > 1 ? n - 1 : 1;
        for (var _r = 0; _r < n; ) {
            var _runStart = _r;
            while (_r + 1 < n && densities[indices[_r + 1]] === densities[indices[_runStart]]) _r++;
            var _mid = ((_runStart + _r) / 2) / _denom;
            for (var _k = _runStart; _k <= _r; _k++) _rank[indices[_k]] = _mid;
            _r++;
        }

        ctx.globalAlpha = pointAlpha;`;
  if (out.includes(pseudocolorCall)) out = out.replace(pseudocolorCall, robustPseudocolorCall);
  if (out.includes(pseudocolorSignature)) out = out.replace(pseudocolorSignature, robustPseudocolorSignature);
  if (out.includes(densityGridSizeNeedle)) out = out.replace(densityGridSizeNeedle, densityGridSizePatch);
  if (out.includes(densityBlurNeedle)) out = out.replace(densityBlurNeedle, densityBlurPatch);
  if (out.includes(densityLookupNeedle)) out = out.replace(densityLookupNeedle, densityLookupPatch);
  if (out.includes(densityCeilingNeedle)) out = out.replace(densityCeilingNeedle, densityCeilingPatch);
  if (out.includes(rankSetupNeedle)) out = out.replace(rankSetupNeedle, rankSetupPatch);
  if (out.includes(densityRatioNeedle)) out = out.replace(densityRatioNeedle, densityRatioPatch);
  if (!out.includes("var _rank = new Float32Array(n);") || !out.includes("_rank[idx]")) {
    console.warn("[GateLab] mini_plot quantile-rank pseudocolour patch did not match — grids will not match the gating plot.");
  }

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
        if (!isFinite(axisLabelOffset)) axisLabelOffset = 34;
        axisLabelOffset = Math.max(14, Math.min(100, axisLabelOffset));
        var xAxisLabelOffset = Number(cfg.x_axis_label_offset);
        if (!isFinite(xAxisLabelOffset)) xAxisLabelOffset = axisLabelOffset;
        xAxisLabelOffset = Math.max(14, Math.min(100, xAxisLabelOffset));
        var yAxisLabelOffset = Number(cfg.y_axis_label_offset);
        if (!isFinite(yAxisLabelOffset)) yAxisLabelOffset = axisLabelOffset;
        yAxisLabelOffset = Math.max(14, Math.min(100, yAxisLabelOffset));
        var axisTickSize = Number(cfg.axis_tick_size);
        if (!isFinite(axisTickSize)) axisTickSize = 6;
        axisTickSize = Math.max(2, Math.min(8, axisTickSize));
        var axisOuterTickSize = Number(cfg.axis_outer_tick_size);
        if (!isFinite(axisOuterTickSize)) axisOuterTickSize = 6;
        axisOuterTickSize = Math.max(0, Math.min(8, axisOuterTickSize));`;
  const xLabelNeedle = ".attr('x', W / 2).attr('y', H + 32)";
  const yLabelNeedle = ".attr('x', -H / 2).attr('y', -32)";
  const xTickNeedle = "xAxisSel.selectAll('text').style('font-size', tickFs);";
  // The tick size applies to the major ticks; a minor tick, which _styleLogicleAxis had already
  // drawn at half length, keeps that ratio rather than being stretched to the major length.
  const xTickPatch = `${xTickNeedle}
        xAxisSel.selectAll('.tick line').attr('y2', function () {
            var was = Math.abs(Number(d3.select(this).attr('y2'))) || 6;
            return was < 6 ? axisTickSize / 2 : axisTickSize;
        });
        xAxisSel.selectAll('.tick text').attr('y', axisTickSize + 2);
        if (axisOuterTickSize === 0) {
            xAxisSel.select('.domain').attr('d', 'M0.5,0.5H' + (W + 0.5));
        }`;
  const yTickNeedle = "yAxisSel.selectAll('text').style('font-size', tickFs);";
  const yTickPatch = `${yTickNeedle}
            yAxisSel.selectAll('.tick line').attr('x2', function () {
                var was = Math.abs(Number(d3.select(this).attr('x2'))) || 6;
                return -(was < 6 ? axisTickSize / 2 : axisTickSize);
            });
            yAxisSel.selectAll('.tick text').attr('x', -(axisTickSize + 2));
            if (axisOuterTickSize === 0) {
                yAxisSel.select('.domain').attr('d', 'M-0.5,' + (H + 0.5) + 'V0.5');
            }`;
  if (out.includes(titleFontNeedle)) out = out.replace(titleFontNeedle, axisOffsetPatch);
  if (out.includes(xLabelNeedle)) out = out.replace(xLabelNeedle, ".attr('x', W / 2).attr('y', H + xAxisLabelOffset)");
  if (out.includes(yLabelNeedle)) out = out.replace(yLabelNeedle, ".attr('x', -H / 2).attr('y', -yAxisLabelOffset)");
  // Illustration labels move: when the host passes `on_label_move`, each gate label carries a
  // d3 drag that shifts it during the drag and reports the new offset, in the axes' display
  // units, on release. The handler travels in gate_style: the label code runs in
  // _drawGateOverlay, which sees the gate style and not the panel config. The Gating tab's own labels are untouched: the figure keeps its own.
  const labelNeedle = "            var label = g.append('g').attr('transform', 'translate(' + lx + ',' + ly + ')');\n";
  const labelPatch = labelNeedle +
    "            if (gateStyle && typeof gateStyle.on_label_move === 'function' && gate.gate_id) {\n" +
    "                var _lx = lx, _ly = ly, _moved = false;\n" +
    "                label.style('cursor', 'move').style('pointer-events', 'all')\n" +
    "                    .call(d3.drag()\n" +
    "                        .on('start', function (event) { if (event.sourceEvent) event.sourceEvent.stopPropagation(); })\n" +
    "                        .on('drag', function (event) {\n" +
    "                            _lx += event.dx; _ly += event.dy; _moved = true;\n" +
    "                            label.attr('transform', 'translate(' + _lx + ',' + _ly + ')');\n" +
    "                        })\n" +
    "                        .on('end', function () {\n" +
    "                            if (!_moved) return;\n" +
    "                            // The offset the label now has from the gate's centre, in display units.\n" +
    "                            var ox2 = xScale.invert(_lx) - xScale.invert(cx);\n" +
    "                            var oy2 = yScale.invert(_ly) - yScale.invert(cy);\n" +
    "                            gateStyle.on_label_move(gate.gate_id, [ox2, oy2]);\n" +
    "                        }));\n" +
    "            }\n";
  if (out.includes(labelNeedle)) out = out.replace(labelNeedle, labelPatch);
  else console.warn("[GateLab] mini_plot label-drag patch did not match -- figure labels will not move.");
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
    !out.includes("H + xAxisLabelOffset") ||
    !out.includes("-yAxisLabelOffset") ||
    !out.includes("axisTickSize + 2") ||
    !out.includes("axisOuterTickSize === 0")
  ) {
    console.warn("[GateLab] mini_plot robust-density patch did not match.");
  }
  if (gridDprSites > 0 && !out.includes("GateLab: match the display, capped like the gating plot")) {
    const before = out;
    out = out.split(gridDprNeedle).join(gridDprPatch);
    if (out === before) {
      console.warn("[GateLab] mini_plot canvas-resolution patch did not match — grids stay at a fixed 2x.");
    }
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
