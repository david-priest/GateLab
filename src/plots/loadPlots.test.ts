import { describe, expect, it, vi } from "vitest";
import cytofSrc from "../../vendor/GateLabR/inst/app/www/cytof_plot.js?raw";
import { patchCytofForGateLab } from "./loadPlots";

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

  it("does not duplicate edge-pile logic after GateLabR carries it natively", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const nativeRenderer = patchCytofForGateLab(cytofSrc);
    const repatched = patchCytofForGateLab(nativeRenderer);

    expect(repatched.match(/function _offscalePts\(\)/g)).toHaveLength(1);
    expect(repatched.match(/outlierPts = outlierPts\.concat\(_offscalePts\(\)\);/g)).toHaveLength(1);

    warning.mockRestore();
  });
});
