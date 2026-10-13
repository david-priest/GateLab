// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { displayToPixel, insideFrame, pixelRadius, pixelToDisplay, plotFrame } from "./plotGeometry";

function areaWithOverlay(area: DOMRect, overlay: DOMRect | null): HTMLElement {
  const plotArea = document.createElement("div");
  Object.defineProperty(plotArea, "getBoundingClientRect", { value: () => area });
  if (overlay) {
    const rect = document.createElement("div");
    rect.className = "cytof-overlay";
    Object.defineProperty(rect, "getBoundingClientRect", { value: () => overlay });
    plotArea.appendChild(rect);
  }
  return plotArea;
}

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

describe("plotFrame", () => {
  it("places the data area relative to the plot area and maps both ways", () => {
    const area = areaWithOverlay(rect(100, 50, 600, 500), rect(155, 70, 400, 400));
    const frame = plotFrame(area, [0, 10], [0, 100])!;
    expect(frame).toMatchObject({ left: 55, top: 20, width: 400, height: 400 });
    expect(pixelToDisplay(frame, 55, 20)).toEqual([0, 100]);
    expect(pixelToDisplay(frame, 455, 420)).toEqual([10, 0]);
    expect(pixelToDisplay(frame, 255, 220)).toEqual([5, 50]);
    expect(displayToPixel(frame, 5, 50)).toEqual([255, 220]);
    expect(displayToPixel(frame, 0, 0)).toEqual([55, 420]);
    expect(pixelRadius(frame, 8)).toEqual([0.2, 2]);
    expect(insideFrame(frame, 60, 30)).toBe(true);
    expect(insideFrame(frame, 10, 30)).toBe(false);
  });

  it("is null before the renderer has drawn, and for an empty range", () => {
    expect(plotFrame(areaWithOverlay(rect(0, 0, 100, 100), null), [0, 1], [0, 1])).toBeNull();
    expect(plotFrame(areaWithOverlay(rect(0, 0, 100, 100), rect(0, 0, 0, 0)), [0, 1], [0, 1])).toBeNull();
    expect(plotFrame(areaWithOverlay(rect(0, 0, 100, 100), rect(0, 0, 10, 10)), [1, 1], [0, 1])).toBeNull();
    expect(plotFrame(areaWithOverlay(rect(0, 0, 100, 100), rect(0, 0, 10, 10)), null, [0, 1])).toBeNull();
  });
});
