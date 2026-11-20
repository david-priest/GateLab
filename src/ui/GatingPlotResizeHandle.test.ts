// The Gating plot's corner grip: the side a drag asks for.

import { describe, expect, it } from "vitest";
import { resizedPlotSide } from "./GatingPlotResizeHandle";

describe("the Gating plot's resize grip", () => {
  it("follows the larger of the two moves, the plot being square", () => {
    expect(resizedPlotSide(400, 60, 10)).toBe(460);
    expect(resizedPlotSide(400, 5, -80)).toBe(320);
  });

  it("keeps the side within 300 to 1200 px", () => {
    expect(resizedPlotSide(400, -500, 0)).toBe(300);
    expect(resizedPlotSide(400, 2000, 0)).toBe(1200);
  });
});
