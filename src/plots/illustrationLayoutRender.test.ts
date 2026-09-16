import { describe, expect, it } from "vitest";
import { effectiveIllustrationPlotSize } from "./illustrationLayoutRender";

describe("Illustration fitted plot size", () => {
  it("preserves the requested size when the columns already fit", () => {
    expect(effectiveIllustrationPlotSize(175, true, 1200, 3, true)).toBe(175);
    expect(effectiveIllustrationPlotSize(425, true, 1600, 3, true)).toBe(425);
  });

  it("shrinks crowded columns but never below the usable minimum", () => {
    expect(effectiveIllustrationPlotSize(500, true, 1000, 3, true)).toBe(262);
    expect(effectiveIllustrationPlotSize(500, true, 400, 4, true)).toBe(120);
  });

  it("uses the requested size when fitting is off", () => {
    expect(effectiveIllustrationPlotSize(350, false, 500, 6, true)).toBe(350);
  });
});
