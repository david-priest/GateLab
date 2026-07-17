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
});
