import { describe, expect, it } from "vitest";
import { clampSidePaneWidth, MIN_PLOT_AREA_WIDTH, MIN_SIDE_PANE_WIDTH, restoredSidePaneWidth, sidePaneMaxWidthCss } from "./sidePaneWidth";

describe("clampSidePaneWidth", () => {
  it("lets the pane grow past the old 900 px cap on a wide window", () => {
    expect(clampSidePaneWidth(1600, 2560, 330)).toBe(1600);
  });

  it("keeps room for the plot beside the left pane", () => {
    expect(clampSidePaneWidth(2400, 2560, 330)).toBe(2560 - 330 - MIN_PLOT_AREA_WIDTH);
  });

  it("keeps the pane minimum, which wins on a window too narrow for both", () => {
    expect(clampSidePaneWidth(100, 2560, 330)).toBe(MIN_SIDE_PANE_WIDTH);
    expect(clampSidePaneWidth(800, 900, 330)).toBe(MIN_SIDE_PANE_WIDTH);
  });

  it("leaves a width inside the old 320–900 px range as it was", () => {
    for (const width of [320, 672, 900]) expect(clampSidePaneWidth(width, 1920, 330)).toBe(width);
  });
});

describe("restoredSidePaneWidth", () => {
  it("loads a width saved under the old cap unchanged", () => {
    for (const saved of [320, 672, 900]) expect(restoredSidePaneWidth(saved)).toBe(saved);
  });

  it("loads a wide saved width whatever the window, and keeps the pane minimum", () => {
    expect(restoredSidePaneWidth(1600)).toBe(1600);
    expect(restoredSidePaneWidth(120)).toBe(MIN_SIDE_PANE_WIDTH);
  });
});

describe("sidePaneMaxWidthCss", () => {
  it("holds the plot's room as the window is resized", () => {
    expect(sidePaneMaxWidthCss(330)).toBe("calc(100vw - 750px)");
  });
});
