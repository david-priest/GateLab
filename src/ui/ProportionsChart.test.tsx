// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeProportionsChartSvg, ProportionsChart } from "./PlottingTab";

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

// The legend's entries in category order (B cells, T cells); the stacked legend lists them top to
// bottom as the stack draws them, which is the reverse.
const legendByCategory = () =>
  ["B cells", "T cells"].map((label) =>
    [...host.querySelectorAll<HTMLButtonElement>(".gl-prop-legend-item")].find((item) => item.textContent === label)!);

describe("Proportions legend interaction", () => {
  it("lists a stacked bar's categories top to bottom as the stack draws them", () => {
    expect([...host.querySelectorAll(".gl-prop-legend-item")].map((item) => item.textContent)).toEqual(["T cells", "B cells"]);
    const rects = [...host.querySelectorAll<SVGRectElement>("rect.gl-prop-mark")];
    const top = (name: string) => Number(rects.find((rect) => rect.querySelector("title")?.textContent?.startsWith(name))!.getAttribute("y"));
    expect(top("T cells")).toBeLessThan(top("B cells"));
  });

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
    const legend = legendByCategory();
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

  it("says when a legend entry is pinned, and a click on the chart, Show all or Escape clears it", () => {
    const legend = legendByCategory();
    const marks = () => [...host.querySelectorAll<SVGRectElement>(".gl-prop-mark")].map((mark) => mark.getAttribute("opacity"));
    expect(host.querySelector(".gl-prop-highlight-note")).toBeNull();

    act(() => legend[1].click());
    act(() => legend[1].dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
    expect(marks()).toEqual(["0.16", "1"]);
    const note = host.querySelector<HTMLElement>(".gl-prop-highlight-note")!;
    expect(note.textContent).toContain("Highlighting T cells");

    act(() => host.querySelector<HTMLElement>(".gl-prop-panels")!.click());
    expect(marks()).toEqual(["1", "1"]);
    expect(host.querySelector(".gl-prop-highlight-note")).toBeNull();

    act(() => legend[1].click());
    act(() => host.querySelector<HTMLElement>(".gl-prop-highlight-note button")!.click());
    expect(marks()).toEqual(["1", "1"]);

    act(() => legend[0].click());
    act(() => host.querySelector<HTMLElement>(".gl-prop-chart")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(marks()).toEqual(["1", "1"]);
    expect(legend[0].getAttribute("aria-pressed")).toBe("false");
  });

  it("drops a stale highlight when the legend changes under it", () => {
    const legend = legendByCategory();
    act(() => legend[1].click());
    expect(host.querySelector(".gl-prop-highlight-note")).not.toBeNull();
    act(() => root.render(
      <ProportionsChart
        plotType="stacked"
        model={{
          catLevels: ["B cells", "T cells", "NK cells"],
          perSample: [{ unit: "s1", group: "s1", facet: null, catCounts: [1, 2, 3] }],
          hasFacet: false,
        }}
        catColors={["#2f80ed", "#e15759", "#59a14f"]}
        palette="paired"
        averagePerUnit
        populations={{}}
        fonts={{ tick: 9, axis: 10, legend: 11 }}
      />,
    ));
    expect(host.querySelector(".gl-prop-highlight-note")).toBeNull();
    expect([...host.querySelectorAll<SVGRectElement>(".gl-prop-mark")].map((mark) => mark.getAttribute("opacity"))).toEqual(["1", "1", "1"]);
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

// Groups are drawn in the chart's order of them, the file list's unless the user set another, as
// Illustration draws files; a label sort put files 1, 10, 100 apart from the order they are listed.
describe("Proportions chart ordering", () => {
  it("draws the groups in the chart's order of them, else in the order the files give them", () => {
    const names = ["1", "10", "2", "D10", "D2", "100"];
    const chartHost = document.createElement("div");
    document.body.appendChild(chartHost);
    const chartRoot = createRoot(chartHost);
    act(() => chartRoot.render(
      <ProportionsChart
        plotType="stacked"
        model={{
          catLevels: ["B cells", "T cells"],
          perSample: names.map((name) => ({ unit: name, group: name, facet: null, catCounts: [60, 40] })),
          hasFacet: false,
        }}
        catColors={["#2f80ed", "#e15759"]}
        palette="paired"
        averagePerUnit
        populations={{}}
        fonts={{ tick: 9, axis: 10, legend: 11 }}
      />,
    ));
    // A tick's text node only: the <title> inside it repeats the label.
    const ticks = [...chartHost.querySelectorAll("svg text")]
      .map((text) => [...text.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(""))
      .filter((text) => names.includes(text));
    expect(ticks).toEqual(names);
    const ordered = ["D2", "D10", "1", "2", "10", "100"];
    act(() => chartRoot.render(
      <ProportionsChart
        plotType="stacked"
        model={{
          catLevels: ["B cells", "T cells"],
          perSample: names.map((name) => ({ unit: name, group: name, facet: null, catCounts: [60, 40] })),
          hasFacet: false,
        }}
        catColors={["#2f80ed", "#e15759"]}
        palette="paired"
        groupLevels={ordered}
        averagePerUnit
        populations={{}}
        fonts={{ tick: 9, axis: 10, legend: 11 }}
      />,
    ));
    const reordered = [...chartHost.querySelectorAll("svg text")]
      .map((text) => [...text.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(""))
      .filter((text) => names.includes(text));
    expect(reordered).toEqual(ordered);
    act(() => chartRoot.unmount());
    chartHost.remove();
  });
});
