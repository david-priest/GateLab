// The scatter plot's axis titles boxed like the histogram view's channel field (patchAxisLabelBoxes).

import { describe, expect, it, vi } from "vitest";
import cytofSrc from "../../vendor/GateLabR/inst/app/www/cytof_plot.js?raw";
import { patchAxisLabelBoxes, patchCytofForGateLab } from "./loadPlots";

describe("GateLab cytof axis-label boxes", () => {
  it("boxes both axis titles after every render and clear, passing clicks through to the title", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const patched = patchAxisLabelBoxes(cytofSrc);
    expect(warn).not.toHaveBeenCalled();
    expect(patched).toContain("function _glAxisLabelBoxes()");
    expect(patched).toContain("_g.select('.cytof-ylabel').text(plotData.y_label || '');\n        _glAxisLabelBoxes();");
    expect(patched).toContain("_g.select('.cytof-ylabel').text('');\n            _glAxisLabelBoxes();");
    expect(patched).toContain("style('pointer-events', 'none')");
    // Idempotent, part of the full patch set, and the patched source still parses.
    expect(patchAxisLabelBoxes(patched)).toBe(patched);
    const full = patchCytofForGateLab(cytofSrc);
    expect(full).toContain("function _glAxisLabelBoxes()");
    expect(() => new Function(full)).not.toThrow();
    warn.mockRestore();
  });
});
