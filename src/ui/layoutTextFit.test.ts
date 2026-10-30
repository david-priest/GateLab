// @vitest-environment jsdom
// The frame a Layout heading takes on arrival. jsdom lays nothing out, so the surface's measured
// sizes are stubbed: a natural width, and the wrapped height and widest line at a set width.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fitLayoutText } from "./layoutTextFit";

function stubSurface(natural: { width: number; height: number }, wrapped: { width: number; height: number }) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const size = this.style.width === "max-content" ? natural : { width: parseFloat(this.style.width), height: wrapped.height };
    return { ...size, x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, toJSON: () => size } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.style.width === "max-content" ? natural.width : wrapped.width;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.style.width === "max-content" ? natural.height : wrapped.height;
  });
}

afterEach(() => vi.restoreAllMocks());

describe("fitLayoutText", () => {
  it("takes the text's own width on one line, inside the item's border", () => {
    stubSurface({ width: 180.4, height: 22.2 }, { width: 0, height: 0 });
    expect(fitLayoutText("D1 · CD4_positive", 14, 320)).toEqual({ width: 184, height: 25 });
  });

  it("wraps past the widest it may be, and grows down", () => {
    stubSurface({ width: 410, height: 22 }, { width: 250, height: 40 });
    expect(fitLayoutText("treated B1 with a long heading", 14, 260)).toEqual({ width: 263, height: 42 });
  });

  it("widens for a word longer than the widest it may be", () => {
    stubSurface({ width: 410, height: 22 }, { width: 410, height: 22 });
    expect(fitLayoutText("control_B2_without_spaces.fcs", 14, 260)).toEqual({ width: 413, height: 24 });
  });

  it("leaves the caller's size where nothing is laid out", () => {
    stubSurface({ width: 0, height: 0 }, { width: 0, height: 0 });
    expect(fitLayoutText("D2", 14, 320)).toBeNull();
  });

  it("leaves no measuring element behind", () => {
    stubSurface({ width: 50, height: 20 }, { width: 0, height: 0 });
    fitLayoutText("D3", 14, 320);
    expect(document.body.querySelector(".gl-layout-text-surface")).toBeNull();
  });
});
