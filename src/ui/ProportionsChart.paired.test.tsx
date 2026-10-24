// @vitest-environment jsdom
// The Plotting boxplot's paired lines: each replicate unit's points joined across the groups.
// Synthetic donors D1 to D3; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProportionsChart } from "./ProportionsTab";

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

// D1 and D2 in both conditions; D3 in control only, so it has nothing to join.
const MODEL = {
  catLevels: ["CD4_positive", "rest"],
  hasFacet: false,
  perSample: [
    { unit: "D1", group: "control", facet: null, catCounts: [10, 90] },
    { unit: "D2", group: "control", facet: null, catCounts: [20, 80] },
    { unit: "D3", group: "control", facet: null, catCounts: [30, 70] },
    { unit: "D1", group: "treated", facet: null, catCounts: [40, 60] },
    { unit: "D2", group: "treated", facet: null, catCounts: [5, 95] },
  ],
};

function draw(paired: boolean | undefined, showPoints = true) {
  act(() =>
    root.render(
      <ProportionsChart
        plotType="box"
        model={MODEL}
        catColors={["#2f80ed", "#e15759"]}
        palette="paired"
        averagePerUnit
        populations={{}}
        fonts={{ tick: 9, axis: 10, legend: 11 }}
        appearance={{ height: 240, showGrid: true, showPoints, paired, showLegend: true, pointRadius: 2 }}
      />,
    ),
  );
}

const panel = () => host.querySelectorAll("svg.gl-prop-panel")[0];
const lines = () => [...panel().querySelectorAll(".gl-prop-paired polyline")];
const ends = (line: Element) => line.getAttribute("points")!.split(" ").map((pair) => pair.split(",").map(Number));

describe("Plotting paired lines", () => {
  it("draws none unless asked", () => {
    draw(undefined);
    expect(host.querySelectorAll(".gl-prop-paired polyline")).toHaveLength(0);
    draw(false);
    expect(host.querySelectorAll(".gl-prop-paired polyline")).toHaveLength(0);
  });

  it("joins each unit in two groups from its control point to its treated point", () => {
    draw(true);
    expect(lines().map((line) => line.textContent)).toEqual(["D1", "D2"]);
    const circles = [...panel().querySelectorAll("circle")].map((c) => [Number(c.getAttribute("cx")), Number(c.getAttribute("cy"))]);
    // Five units drawn: three in control, two in treated.
    expect(circles).toHaveLength(5);
    for (const line of lines()) {
      const [from, to] = ends(line);
      expect(circles).toContainEqual(from);
      expect(circles).toContainEqual(to);
      expect(to[0]).toBeGreaterThan(from[0]);
    }
    // D1 rises from 10% to 40% and D2 falls from 20% to 5%: on an SVG axis, up is a smaller y.
    const [d1, d2] = lines().map(ends);
    expect(d1[1][1]).toBeLessThan(d1[0][1]);
    expect(d2[1][1]).toBeGreaterThan(d2[0][1]);
  });

  it("joins the box centres when the points are hidden", () => {
    draw(true, false);
    expect(panel().querySelectorAll("circle")).toHaveLength(0);
    const [d1] = lines().map(ends);
    const xs = new Set(lines().flatMap((line) => ends(line).map(([x]) => x)));
    // Two groups, so two x positions: the two box centres.
    expect(xs.size).toBe(2);
    expect(d1).toHaveLength(2);
  });
});
