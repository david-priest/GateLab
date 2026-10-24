// @vitest-environment jsdom
// The Plotting chart's titles (what the groups and facets are, what a bar stands on) and its box whiskers.
// Synthetic donors D1 to D4; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeProportionsChartSvg, fittedValueAxis, ProportionsChart, proportionsFactorTitle } from "./ProportionsTab";

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

// Two conditions of two donors each, in two batches; a rare population at 1 to 4 events in 100.
const MODEL = {
  catLevels: ["rare", "common"],
  hasFacet: true,
  perSample: [
    { unit: "D1", group: "control", facet: "B1", catCounts: [1, 99] },
    { unit: "D2", group: "control", facet: "B1", catCounts: [2, 98] },
    { unit: "D3", group: "treated", facet: "B2", catCounts: [3, 97] },
    { unit: "D4", group: "treated", facet: "B2", catCounts: [4, 96] },
  ],
};

function draw(plotType: "stacked" | "box", averagePerUnit = true) {
  act(() =>
    root.render(
      <ProportionsChart
        plotType={plotType}
        model={MODEL}
        catColors={["#2f80ed", "#e15759"]}
        palette="paired"
        averagePerUnit={averagePerUnit}
        populations={{}}
        groupTitle="condition"
        facetTitle="batch"
        fonts={{ tick: 9, axis: 10, legend: 11 }}
        appearance={{ height: 240, showGrid: true, showPoints: true, showLegend: true, pointRadius: 2 }}
      />,
    ),
  );
}

const texts = () => [...host.querySelectorAll("svg.gl-prop-panel text")].map((text) => text.textContent);

describe("Plotting chart titles", () => {
  it("titles the facets and the stacked bar's groups with the columns they come from", () => {
    draw("stacked");
    expect(texts()).toEqual(expect.arrayContaining(["batch: B1", "batch: B2", "condition"]));
    expect(proportionsFactorTitle("__sample__")).toBe("File");
    expect(proportionsFactorTitle("")).toBeUndefined();
    expect(proportionsFactorTitle("condition")).toBe("condition");
  });

  it("says what a bar stands on: its replicate units averaged, or its events pooled", () => {
    draw("stacked");
    const titles = () => [...host.querySelectorAll(".gl-prop-mark title")].map((title) => title.textContent);
    expect(titles()).toContain("rare: 1.5% (mean of 2 replicate units)");
    draw("stacked", false);
    expect(titles()).toContain("rare: 1.5% (200 events)");
  });

  it("titles a boxplot's legend with the group column, in the export too", () => {
    draw("box");
    expect(host.querySelector(".gl-prop-legend-title")?.textContent).toBe("condition");
    const composed = composeProportionsChartSvg("gl-prop-svg")!;
    expect([...composed.root.querySelectorAll("text")].map((text) => text.textContent)).toContain("condition");
  });
});

describe("boxplot whiskers on the chart", () => {
  it("end at the furthest unit within 1.5 × IQR, with the unit beyond still drawn as a point", () => {
    // One group of nine units; the rare share is 1..8 in 100 and one unit at 30 in 100.
    const shares = [1, 2, 3, 4, 5, 6, 7, 8, 30];
    act(() =>
      root.render(
        <ProportionsChart
          plotType="box"
          model={{ catLevels: ["rare", "rest"], hasFacet: false, perSample: shares.map((v, i) => ({ unit: `D${i}`, group: "control", facet: null, catCounts: [v, 100 - v] })) }}
          catColors={["#2f80ed", "#e15759"]}
          palette="paired"
          averagePerUnit
          populations={{}}
          fonts={{ tick: 9, axis: 10, legend: 11 }}
          appearance={{ height: 200, showGrid: true, showPoints: true, showLegend: true, pointRadius: 2 }}
        />,
      ),
    );
    const group = host.querySelector("g.gl-prop-mark-group")!;
    const whisker = group.querySelector("line")!;
    // The rare panel's axis runs to 40%, just above its highest unit (30%): y = 22 + 200 × (1 − v / 0.4).
    const y = (v: number) => 22 + 200 * (1 - v / 0.4);
    expect(Number(whisker.getAttribute("y1"))).toBeCloseTo(y(0.08), 6);
    expect(Number(whisker.getAttribute("y2"))).toBeCloseTo(y(0.01), 6);
    const points = [...group.querySelectorAll("circle")].map((c) => Number(c.getAttribute("cy")));
    expect(points).toHaveLength(9);
    expect(Math.min(...points)).toBeCloseTo(y(0.3), 6);
  });
});

describe("one boxplot panel per population", () => {
  it("draws a panel per category and facet, each titled, each with its own fitted axis", () => {
    draw("box");
    const panels = [...host.querySelectorAll("svg.gl-prop-panel")];
    // Two facets × two categories.
    expect(panels).toHaveLength(4);
    const title = (panel: Element) => panel.querySelector(":scope > text")?.textContent;
    expect(panels.map(title)).toEqual(["rare · batch: B1", "common · batch: B1", "rare · batch: B2", "common · batch: B2"]);
    const ticks = (panel: Element) => [...panel.querySelectorAll("g > text")].map((text) => text.textContent);
    // The rare population (1 to 4 in 100) on an axis to 6%, the same in both facets; the common one to 100%.
    expect(ticks(panels[0])).toEqual(["0%", "2%", "4%", "6%"]);
    expect(ticks(panels[2])).toEqual(ticks(panels[0]));
    expect(ticks(panels[1])).toEqual(["0%", "25%", "50%", "75%", "100%"]);
  });

  it("fits an axis to a round number just above the highest value, with the decimals its ticks need", () => {
    expect(fittedValueAxis(0.04)).toEqual({ max: 0.06, ticks: [0, 0.02, 0.04, 0.06] });
    expect(fittedValueAxis(0.09)).toEqual({ max: 0.1, ticks: [0, 0.025, 0.05, 0.075, 0.1] });
    expect(fittedValueAxis(0.37)).toEqual({ max: 0.4, ticks: [0, 0.1, 0.2, 0.3, 0.4] });
    expect(fittedValueAxis(0.99).max).toBe(1);
    expect(fittedValueAxis(0)).toEqual({ max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
  });
});
