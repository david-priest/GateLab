import { describe, expect, it } from "vitest";
import cytofSrc from "../../vendor/GateLabR/inst/app/www/cytof_plot.js?raw";
import { CYTOF_OWNED_TARGETS } from "../App";

/**
 * GateLab runs its own plot-wide pan alongside the renderer's gate gestures, so it keeps a list
 * of elements whose drags belong to the renderer. That list is a copy of one inside cytof_plot.js,
 * and the two drifting apart is not hypothetical: GateLab's omitted `.gate-label`, so dragging a
 * gate label started a pan as well, and the range it committed on mouseup looked like the scale
 * snapping back on its own.
 */
describe("the pan guard matches the renderer's own", () => {
  it("excludes every element cytof claims", () => {
    // The renderer's list, read from its source rather than restated here.
    const match = cytofSrc.match(/'(\.saved-gate,[^']*)'/);
    expect(match, "cytof's owned-target list should be findable").toBeTruthy();
    const rendererClasses = match![1].split(",").map((c) => c.trim()).sort();
    const ourClasses = CYTOF_OWNED_TARGETS.split(",").map((c) => c.trim()).sort();

    expect(ourClasses).toEqual(rendererClasses);
    // The one that was missing, named explicitly so a future edit cannot quietly drop it again.
    expect(ourClasses).toContain(".gate-label");
  });
});
