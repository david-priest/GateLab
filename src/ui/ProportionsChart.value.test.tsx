// @vitest-environment jsdom
// The Plotting chart's boxplot, bars and points of proportions: the value chosen (% of parent,
// % of total or events), the value axis and tooltips that follow it, and the rank test.
// Synthetic donors D1 to D4 in two conditions; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProportionsChart, proportionsValueTitle } from "./PlottingTab";
import { proportionsDataCsv } from "./plottingData";

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

// CD4_positive within a parent of 100 events, in files of 200 events.
const MODEL = {
  catLevels: ["CD4_positive", "rest"],
  hasFacet: false,
  perSample: [
    { unit: "D1", group: "control", facet: null, catCounts: [10, 90], popCounts: [10], totalCount: 200 },
    { unit: "D2", group: "control", facet: null, catCounts: [20, 80], popCounts: [20], totalCount: 200 },
    { unit: "D3", group: "treated", facet: null, catCounts: [40, 60], popCounts: [40], totalCount: 200 },
    { unit: "D4", group: "treated", facet: null, catCounts: [50, 50], popCounts: [50], totalCount: 200 },
  ],
};

function draw(plotType: "box" | "bar" | "dots", proportionValue: "parent" | "total" | "count", test = false) {
  act(() =>
    root.render(
      <ProportionsChart
        plotType={plotType}
        proportionValue={proportionValue}
        errorBar="sd"
        test={test}
        model={MODEL}
        catColors={["#2f80ed", "#e15759"]}
        palette="paired"
        averagePerUnit
        populations={{}}
        valueTitle={proportionsValueTitle("population", "Lymphocytes", true, proportionValue)}
        fonts={{ tick: 9, axis: 10, legend: 11 }}
        appearance={{ height: 240, showGrid: true, showPoints: true, showLegend: true, pointRadius: 2 }}
      />,
    ),
  );
}

const panel = () => host.querySelectorAll("svg.gl-prop-panel")[0];
const titles = () => [...panel().querySelectorAll("title")].map((t) => t.textContent);

describe("Plotting chart of proportions: the value chosen", () => {
  it("titles the value axis by what the value is", () => {
    expect(proportionsValueTitle("population", "Lymphocytes", true)).toBe("% of Lymphocytes");
    expect(proportionsValueTitle("population", "Lymphocytes", true, "total")).toBe("% of total");
    expect(proportionsValueTitle("population", "Lymphocytes", true, "count")).toBe("Events");
  });

  it("draws a box of each unit's share of the total, and of its events", () => {
    draw("box", "total");
    expect(panel().textContent).toContain("% of total");
    // Control: 10 and 20 of 200 events, a median of 7.5%.
    expect(titles()).toContain("CD4_positive · control: median 7.5%, n = 2");
    draw("box", "count");
    expect(panel().textContent).toContain("Events");
    expect(titles()).toContain("CD4_positive · treated: median 45 events, n = 2");
    // The ticks are events, not percentages.
    expect(panel().textContent).not.toContain("%");
  });

  it("draws bars of the mean with an error bar, and points with the mean, a point per unit", () => {
    draw("bar", "parent");
    // Control: 10% and 20% of the parent, a mean of 15% ± SD 7.1%.
    expect(titles()).toContain("CD4_positive · control: mean 15.0% ± SD 7.1%, n = 2");
    expect(panel().querySelectorAll("rect.gl-prop-mark")).toHaveLength(2);
    expect(panel().querySelectorAll("circle.gl-prop-point")).toHaveLength(4);
    draw("dots", "count");
    expect(panel().querySelectorAll("rect.gl-prop-mark")).toHaveLength(0);
    expect(panel().querySelectorAll("line.gl-prop-mark")).toHaveLength(2);
    expect(titles()).toContain("D3: 40 events");
  });

  it("writes the rank test between the groups above each panel when asked", () => {
    draw("box", "count");
    expect(panel().querySelector(".gl-prop-test")).toBeNull();
    draw("box", "count", true);
    // wilcox.test(c(10, 20), c(40, 50)): W = 0, p = 0.3333 (exact).
    expect(panel().querySelector(".gl-prop-test")?.lastChild?.textContent).toBe("Wilcoxon p = 0.33");
    draw("dots", "total", true);
    expect(panel().querySelector(".gl-prop-test")?.lastChild?.textContent).toBe("Wilcoxon p = 0.33");
  });

  it("adds the file's events and the share of them to the table for % of total", () => {
    const csv = proportionsDataCsv({ ...MODEL, excluded: [] }, { group: "condition" }, (id) => `${id}.fcs`, true, {}, "total");
    const [header, first] = csv.trim().split(/\r?\n/);
    expect(header.endsWith("Total events,Whole percent of total")).toBe(true);
    expect(first.endsWith("200,5")).toBe(true);
    expect(proportionsDataCsv({ ...MODEL, excluded: [] }, { group: "condition" }, (id) => `${id}.fcs`, true)).not.toContain("Total events");
  });
});
