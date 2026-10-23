// @vitest-environment jsdom
//
// The Division tab's per-division labels sit at their band's centre. Bands a few pixels wide put
// their labels on top of each other; the patch staggers them into rows instead.
import d3Src from "../../vendor/GateLabR/inst/app/www/d3.v7.min.js?raw";
import divisionSrc from "../../vendor/GateLabR/inst/app/www/division_plot.js?raw";
import { beforeAll, describe, expect, it } from "vitest";
import { patchDivisionPlot } from "./loadPlots";

interface DivisionWindow { DivisionD3: { render: (payload: Record<string, unknown>) => void } }

beforeAll(() => {
  const globalEval = eval;
  globalEval(d3Src);
  globalEval(patchDivisionPlot(divisionSrc));
});

function labelsFor(boundaries: number[]) {
  document.body.innerHTML = '<div id="division-plot-container"></div>';
  (window as unknown as DivisionWindow).DivisionD3.render({
    x: [0.5, 1.02, 1.07, 2, 5, 6],
    x_range: [0, 8],
    bins: 40,
    boundaries,
    bin_labels: Array.from({ length: boundaries.length + 1 }, (_, i) => `Div${i}`),
  });
  return [...document.querySelectorAll<SVGTextElement>(".division-bin-labels text")].map((text) => ({
    name: text.firstChild?.textContent ?? "",
    x: Number(text.getAttribute("x")),
    y: Number(text.getAttribute("y")),
    tooltip: text.querySelector("title")?.textContent ?? null,
  }));
}

describe("division labels", () => {
  it("keep one row while the bands are wide enough for them", () => {
    const labels = labelsFor([2, 4, 6]);
    expect(labels.map((label) => label.y)).toEqual([12, 12, 12, 12]);
    expect(labels.map((label) => label.tooltip)).toEqual(labels.map((label) => label.name));
  });

  it("stagger into rows where narrow bands would draw them over each other", () => {
    const labels = labelsFor([1, 1.05, 1.1, 4]);
    expect(labels).toHaveLength(5);
    // No two labels on the same row overlap, at the width the renderer allows a label.
    const width = (name: string) => name.length * 7 + 6;
    for (let a = 0; a < labels.length; a++) {
      for (let b = a + 1; b < labels.length; b++) {
        if (labels[a].y !== labels[b].y) continue;
        const apart = Math.abs(labels[a].x - labels[b].x);
        expect(apart, `${labels[a].name} and ${labels[b].name}`).toBeGreaterThanOrEqual((width(labels[a].name) + width(labels[b].name)) / 2);
      }
    }
    expect(new Set(labels.map((label) => label.y)).size).toBeGreaterThan(1);
    // Each label names its band in its tooltip, and the text drawn is still the band's name alone.
    expect(labels.every((label) => /^Div\d$/.test(label.name) && label.tooltip === label.name)).toBe(true);
  });

  it("goes back to one row when the boundaries move apart", () => {
    labelsFor([1, 1.05, 1.1, 4]);
    const labels = labelsFor([1, 2.5, 4, 6]);
    expect(labels.map((label) => label.y)).toEqual([12, 12, 12, 12, 12]);
  });
});
