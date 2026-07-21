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

  it("keeps polygon vertex clicks out of saved-gate drag handlers", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(patched).toContain("_mouseData = null; _polyJustClosed = false;");
    expect(patched).toContain("newMode === 'navigate' ? null : 'none'");
    expect(patched).toContain("_g.select('.draw-layer').style('pointer-events', 'none');");
    expect(patched).toMatch(/\(pd\.x_range\s*\|\|\s*\[\]\)\.join\(','\)/);

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

  it("reserves warm pseudocolours for denser event cores without changing density", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchCytofForGateLab(cytofSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(patched).toContain("var colourPower = Number(_plotData.density_color_power);");
    expect(patched).toContain("colourPower = 1.6;");
    expect(patched).toContain("Math.pow(Math.min(1, cache.densities[i] / cache.maxDens), colourPower)");
    expect(() => new Function(patched)).not.toThrow();

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

describe("GateLab mini-plot density patches", () => {
  it("uses opt-in clipping, a gating-matched density kernel, and a shared ceiling without dropping events", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const patched = patchMiniPlot(miniSrc);

    expect(warning).not.toHaveBeenCalled();
    expect(miniSrc).not.toContain("density_clip_quantile");
    expect(patched).toContain("cfg.density_clip_quantile, cfg.density_color_power, cfg.density_color_ceiling, cfg.density_smoothing");
    expect(patched).toContain("var requestedMargins = cfg.plot_margins || {};");
    expect(patched).toContain("var gridN = 256, pad = blurRadius, extSize = gridN + 2 * pad;");
    expect(patched).toContain("Math.min(24, blurRadius)");
    expect(patched).toContain("var integralGrid = new Float64Array(integralStride * integralStride);");
    expect(patched).toContain("var densityGrid = blurred;");
    expect(patched).toContain("densities[i] = densityGrid[gy * extSize + gx]");
    expect(patched).toContain("var requestedCeiling = Number(densityColorCeiling);");
    expect(patched).toContain("? requestedCeiling : maxDens;");
    expect(patched).toContain("if (qd > 0) occupied.push(qd);");
    expect(patched).toContain("Math.floor(clipQ * (occupied.length - 1))");
    expect(patched).toContain("Math.pow(Math.min(1, densities[idx] / colourCeiling), colourPower)");
    expect(patched).toContain("density_color_power: data.density_color_power");
    expect(patched).toContain("ctx.arc(px, py, dotR, 0, 6.2832)");
    expect(patched).toContain("H + axisLabelOffset");
    expect(patched).toContain("-axisLabelOffset");
    expect(patched).toContain("axisTickSize + 2");
    expect(patched).toContain("axisOuterTickSize === 0");
    expect(() => new Function(patched)).not.toThrow();

    warning.mockRestore();
  });
});
