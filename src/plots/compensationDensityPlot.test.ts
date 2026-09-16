// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { renderMiniPlot } = vi.hoisted(() => ({ renderMiniPlot: vi.fn() }));

vi.mock("./loadPlots", () => ({
  loadMiniPlots: () => ({ renderMiniPlot }),
}));

import { renderCompensationDensityBiplotSurface } from "./compensationDensityPlot";

describe("compensation density plot frame", () => {
  beforeEach(() => renderMiniPlot.mockClear());

  it("leaves the label offsets and margins to the renderer, with visible ticks and readable fonts", () => {
    renderCompensationDensityBiplotSurface(document.createElement("div"), {
      title: "Compensated",
      panel: { x: [0, 1], y: [0, 1], zeroPile: { source: 0, receiver: 0, corner: 0 } },
      preview: { eventCount: 2, xRange: [0, 1], yRange: [0, 1], xTicks: null, yTicks: null },
      sourceLabel: "149Sm_BLIMP1",
      receiverLabel: "151Eu_IgD",
      size: 220,
      densitySmoothingRadius: 3,
      densityColorPower: 1.6,
      pointAlpha: 0.85,
    });

    const config = renderMiniPlot.mock.calls[0][1];
    // The renderer sizes the title offsets and the left and bottom margins from the tick labels
    // it draws; a fixed 20px offset put the rotated y title through "100".
    expect(config.x_axis_label_offset).toBeUndefined();
    expect(config.y_axis_label_offset).toBeUndefined();
    expect(config.plot_margins.left).toBeUndefined();
    expect(config.plot_margins.bottom).toBeUndefined();
    expect(config.axis_tick_size).toBe(6);
    expect(config.font_sizes.tick).toBeGreaterThanOrEqual(9);
    expect(config.font_sizes.axis_label).toBeGreaterThanOrEqual(10);
  });
});
