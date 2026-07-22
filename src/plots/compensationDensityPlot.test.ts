// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { renderMiniPlot } = vi.hoisted(() => ({ renderMiniPlot: vi.fn() }));

vi.mock("./loadPlots", () => ({
  loadMiniPlots: () => ({ renderMiniPlot }),
}));

import { renderCompensationDensityBiplotSurface } from "./compensationDensityPlot";

describe("compensation density plot frame", () => {
  beforeEach(() => renderMiniPlot.mockClear());

  it("reserves enough left margin for the y tick labels and rotated axis title", () => {
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
    expect(config.x_axis_label_offset).toBe(24);
    expect(config.y_axis_label_offset).toBe(20);
    expect(config.font_sizes.axis_label).toBe(10);
    expect(config.plot_margins.left).toBe(34);
  });
});
