// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkerColourBar, type MarkerColourBarTick } from "./MarkerColourBar";
import { markerColourPalette } from "../engine/markerColour";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function render(ticks?: MarkerColourBarTick[]): void {
  act(() => root.render(
    <MarkerColourBar
      label="CD3"
      scale={{ lo: 0, hi: 1 }}
      palette={markerColourPalette("viridis")}
      ticks={ticks}
    />,
  ));
}

function shown(): { label: string; left: number }[] {
  return [...host.querySelectorAll<HTMLElement>(".gl-marker-colour-bar-ticks span")].map((s) => ({
    label: s.textContent ?? "",
    left: parseFloat(s.style.left),
  }));
}

describe("MarkerColourBar", () => {
  it("names the channel and draws the ramp without the missing colour in it", () => {
    render();
    expect(host.textContent).toContain("CD3");
    const ramp = host.querySelector<HTMLElement>(".gl-marker-colour-bar-ramp")!;
    expect(ramp.style.backgroundImage).toContain("linear-gradient");
    // The missing colour sits below the ramp and is not part of it; drawing it would show a
    // grey step at the bottom of a gradient that does not have one.
    expect(ramp.style.backgroundImage).not.toContain("rgb(204, 204, 204)");
  });

  it("positions each label where its value falls, not at even spacing", () => {
    // A logicle channel's decades are unevenly spaced. Spreading the labels evenly would put
    // every one of them somewhere the events of that value are not.
    render([
      { fraction: 0, label: "-1K" },
      { fraction: 0.44, label: "1K" },
      { fraction: 1, label: "1M" },
    ]);
    expect(shown()).toEqual([
      { label: "-1K", left: 0 },
      { label: "1K", left: 44 },
      { label: "1M", left: 100 },
    ]);
  });

  it("thins labels that would print on top of each other, and keeps both ends", () => {
    // The real case: a logicle channel bunches -100, 0 and 100 into the linear region.
    render([
      { fraction: 0.13, label: "-1K" },
      { fraction: 0.26, label: "-100" },
      { fraction: 0.285, label: "0" },
      { fraction: 0.31, label: "100" },
      { fraction: 0.44, label: "1K" },
      { fraction: 0.63, label: "10K" },
      { fraction: 0.82, label: "100K" },
      { fraction: 0.995, label: "1M" },
    ]);
    const labels = shown().map((t) => t.label);
    expect(labels[0]).toBe("-1K");
    expect(labels[labels.length - 1]).toBe("1M");
    expect(labels).not.toContain("0");
    const positions = shown().map((t) => t.left);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i] - positions[i - 1]).toBeGreaterThanOrEqual(12);
    }
  });

  it("keeps the top of the scale even when the tick below it is close", () => {
    render([
      { fraction: 0, label: "low" },
      { fraction: 0.95, label: "nearly" },
      { fraction: 1, label: "top" },
    ]);
    const labels = shown().map((t) => t.label);
    expect(labels).toContain("top");
    expect(labels).not.toContain("nearly");
  });

  it("falls back to the display values for a channel whose axis has no tick scheme", () => {
    // CyTOF metals and QC channels return no ticks; the bar still has to say what it spans.
    act(() => root.render(
      <MarkerColourBar label="Ir191" scale={{ lo: 0.5, hi: 4.5 }} palette={markerColourPalette("viridis")} />,
    ));
    expect(shown().map((t) => t.label)).toEqual(["0.50", "2.5", "4.5"]);
  });

  it("places the fallback labels where the contrast exponent puts those values on the ramp", () => {
    // At an exponent of 2 the midpoint of the scale colours at a quarter of the ramp, so its
    // label belongs there too; evenly spaced labels would have put it in the middle.
    act(() => root.render(
      <MarkerColourBar label="Ir191" scale={{ lo: 0.5, hi: 4.5 }} palette={markerColourPalette("viridis")} power={2} />,
    ));
    expect(shown().map((t) => t.left)).toEqual([0, 25, 100]);
  });
});
