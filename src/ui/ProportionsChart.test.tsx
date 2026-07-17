// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeProportionsChartSvg, ProportionsChart } from "./ProportionsTab";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(
    <ProportionsChart
      plotType="stacked"
      model={{
        catLevels: ["B cells", "T cells"],
        perSample: [{ unit: "sample.fcs", group: "sample.fcs", facet: null, catCounts: [60, 40] }],
        hasFacet: false,
      }}
      catColors={["#2f80ed", "#e15759"]}
      palette="paired"
      averagePerUnit
      populations={{}}
      fonts={{ tick: 9, axis: 10, legend: 11 }}
    />,
  ));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Proportions legend interaction", () => {
  it("includes the HTML legend in a self-contained export SVG", () => {
    const composed = composeProportionsChartSvg("gl-prop-svg");

    expect(composed).not.toBeNull();
    expect(composed?.root.querySelectorAll("svg.gl-prop-panel")).toHaveLength(1);
    expect(composed?.root.querySelectorAll(".gl-prop-export-legend-item")).toHaveLength(2);
    expect(composed?.root.textContent).toContain("B cells");
    expect(composed?.root.textContent).toContain("T cells");
    expect(composed!.height).toBeGreaterThan(308);
  });

  it("includes every facet panel in the composed export", () => {
    act(() => root.render(
      <ProportionsChart
        plotType="stacked"
        model={{
          catLevels: ["B cells", "T cells"],
          perSample: [
            { unit: "a.fcs", group: "control", facet: "donor A", catCounts: [60, 40] },
            { unit: "b.fcs", group: "control", facet: "donor B", catCounts: [50, 50] },
          ],
          hasFacet: true,
        }}
        catColors={["#2f80ed", "#e15759"]}
        palette="paired"
        averagePerUnit
        populations={{}}
        fonts={{ tick: 9, axis: 10, legend: 11 }}
      />,
    ));

    const composed = composeProportionsChartSvg("gl-prop-svg");
    expect(composed?.root.querySelectorAll("svg.gl-prop-panel")).toHaveLength(2);
    expect(composed?.root.textContent).toContain("donor A");
    expect(composed?.root.textContent).toContain("donor B");
  });

  it("links hover and pinned legend states to the matching chart marks", () => {
    const legend = [...host.querySelectorAll<HTMLButtonElement>(".gl-prop-legend-item")];
    const marks = [...host.querySelectorAll<SVGRectElement>(".gl-prop-mark")];
    expect(legend).toHaveLength(2);
    expect(marks).toHaveLength(2);

    act(() => legend[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(marks.map((mark) => mark.getAttribute("opacity"))).toEqual(["1", "0.16"]);

    act(() => legend[0].click());
    act(() => legend[0].dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
    expect(legend[0].getAttribute("aria-pressed")).toBe("true");
    expect(marks.map((mark) => mark.getAttribute("opacity"))).toEqual(["1", "0.16"]);

    act(() => legend[0].click());
    expect(legend[0].getAttribute("aria-pressed")).toBe("false");
    expect(marks.map((mark) => mark.getAttribute("opacity"))).toEqual(["1", "1"]);
  });

  it("links boxplot group legends to every box in the matching group", () => {
    act(() => root.render(
      <ProportionsChart
        plotType="box"
        model={{
          catLevels: ["B cells", "T cells"],
          perSample: [
            { unit: "c1", group: "control", facet: null, catCounts: [70, 30] },
            { unit: "c2", group: "control", facet: null, catCounts: [60, 40] },
            { unit: "s1", group: "stim", facet: null, catCounts: [40, 60] },
            { unit: "s2", group: "stim", facet: null, catCounts: [30, 70] },
          ],
          hasFacet: false,
        }}
        catColors={["#2f80ed", "#e15759"]}
        palette="paired"
        averagePerUnit
        populations={{}}
        fonts={{ tick: 9, axis: 10, legend: 11 }}
      />,
    ));

    const stim = [...host.querySelectorAll<HTMLButtonElement>(".gl-prop-legend-item")]
      .find((button) => button.textContent === "stim")!;
    act(() => stim.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));

    const groups = [...host.querySelectorAll<SVGGElement>(".gl-prop-mark-group")];
    expect(groups.map((group) => group.getAttribute("opacity"))).toEqual(["0.16", "1", "0.16", "1"]);
  });
});
