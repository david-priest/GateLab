// @vitest-environment jsdom
// Pairwise comparisons on the Plotting charts: brackets stacked without overlap, "significant"
// hiding the right ones, the statistic chart's and the per-cell chart's brackets and panel height,
// the sentence that says what is tested, the CSV's second block and a Layout legend's sentence.
// Synthetic units D1 to D5 in groups control, low, mid, high and top; nothing here is a real
// experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CellValuesModel } from "../../engine/cellValuesModel";
import { formatP } from "../../engine/layoutChart";
import { pairwiseWilcoxon } from "../../engine/rankTests";
import { BASE_PROPORTIONS_SETTINGS, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "../../engine/proportionsSettings";
import { StatisticChart, statisticChartFrame } from "../StatisticChart";
import { CellValuesChart, cellPanels, cellReplicateFrame } from "../CellValuesChart";
import { plottingDataTableCsv, statisticDataTable } from "../plottingData";
import { testSentence } from "../layoutSources";
import { bracketLevels, bracketRowHeight, comparisonDescription, panelTests, shownComparisons, type PanelComparison } from "./chartComparisons";

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

const GROUPS = ["control", "low", "mid", "high", "top"];

/** Every pair of `k` slots, as a panel compares them. */
function allPairs(k: number): Pick<PanelComparison, "a" | "b">[] {
  const out: Pick<PanelComparison, "a" | "b">[] = [];
  for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) out.push({ a, b });
  return out;
}

/** A statistic model of one population: each group's units D1 to D5, each unit's cells all at its value. */
function statisticModel(groups: Record<string, number[]>): CellValuesModel {
  return {
    catLevels: ["CD4_positive"],
    levels: [{ popId: "cd4", depth: 1 }],
    hasFacet: false,
    channelLabel: "FSC-A",
    excluded: [],
    noChannel: [],
    extent: null,
    axisSource: null,
    violins: Object.entries(groups).flatMap(([group, values]) =>
      values.map((value, i) => ({ cat: 0, group, facet: null, unit: `D${i + 1}`, values: Float32Array.from([value, value]), files: [`D${i + 1}-${group}.fcs`] })),
    ),
  };
}

// Three groups: control well above low and high; low and high overlap.
const THREE = { control: [90, 85, 80, 75, 70], low: [45, 70, 60, 50, 65], high: [40, 66, 55, 52, 61] };

describe("Brackets", () => {
  it.each([3, 4, 5])("stack for %i groups without two in a row overlapping, each above every bracket under its span", (k) => {
    const pairs = allPairs(k);
    const levels = bracketLevels(pairs);
    pairs.forEach((p, i) =>
      pairs.forEach((q, j) => {
        if (i === j) return;
        const overlap = p.a <= q.b && q.a <= p.b;
        if (overlap) expect(levels[i]).not.toBe(levels[j]);
        // A bracket that holds another inside its span stands above it.
        if (p.a <= q.a && q.b <= p.b) expect(levels[i]).toBeGreaterThan(levels[j]);
      }),
    );
    // Neighbours first: every adjacent pair sits on the lowest two rows.
    pairs.forEach((p, i) => {
      if (p.b - p.a === 1) expect(levels[i]).toBeLessThanOrEqual(1);
    });
  });

  it("are drawn in a statistic panel without two overlapping, and the panel grows by their rows", () => {
    const groups = Object.fromEntries(GROUPS.slice(0, 4).map((g, i) => [g, [10, 20, 30, 40, 50].map((v) => v + i * 30)]));
    const model = statisticModel(groups);
    const settings = { ...BASE_PROPORTIONS_SETTINGS, valueKind: "statistic" as const, plotType: "box" as const, xAxis: "groups" as const, test: true, unitSel: "donor" };
    const overall = statisticChartFrame(model, settings);
    const pairwise = statisticChartFrame(model, { ...settings, comparisons: "pairwise" });
    const rows = Math.max(...bracketLevels(allPairs(4))) + 1;
    expect(pairwise.brackets).toBe(rows);
    expect(pairwise.layout.height - overall.layout.height).toBe(rows * bracketRowHeight(settings.fontTick));
    act(() =>
      root.render(
        <StatisticChart model={model} statistic="median" plotType="box" errorBar="sd" test comparisons={{ comparisons: "pairwise", comparisonsShow: "all" }} xAxis="groups" unitSel="donor" catColors={["#888"]} palette="paired" fonts={{ tick: 9, axis: 10, legend: 11 }} appearance={{ height: 240, showGrid: true, showLegend: true, showPoints: true, pointRadius: 2 }} />,
      ),
    );
    const drawn = [...host.querySelectorAll(".gl-prop-bracket")].map((g) => {
      const d = g.querySelector("path")!.getAttribute("d")!;
      const [x1, y] = d.slice(1).split("V")[0].split(",").map(Number);
      const x2 = Number(d.split("H")[1].split("V")[0]);
      return { x1, x2, y, label: g.querySelector("text")!.textContent };
    });
    expect(drawn).toHaveLength(6);
    for (const p of drawn)
      for (const q of drawn) if (p !== q && p.y === q.y) expect(p.x2 < q.x1 || q.x2 < p.x1).toBe(true);
    // Every bracket stands above the plot, and the Kruskal–Wallis line above every bracket.
    const plotTop = pairwise.layout.margin.top;
    expect(drawn.every((b) => b.y < plotTop)).toBe(true);
    const line = Number(host.querySelector(".gl-prop-test")!.getAttribute("y"));
    expect(drawn.every((b) => line < b.y - 9)).toBe(true);
    // The p on each bracket is pairwiseWilcoxon's Holm-adjusted p.
    const expected = pairwiseWilcoxon(Object.values(groups)).map((pair) => formatP(pair.pAdjusted!));
    expect(drawn.map((b) => b.label).sort()).toEqual(expected.sort());
  });

  it("with significant only, keep the pairs with an adjusted p below 0.05", () => {
    const tests = panelTests(Object.entries(THREE).map(([label, values]) => ({ label, values: values.map((value, i) => ({ unit: `D${i + 1}`, value })) })), { comparisons: "pairwise", comparisonsShow: "all", paired: false });
    const byPair = Object.fromEntries(tests.pairs.map((pair) => [`${pair.groupA}-${pair.groupB}`, pair.pAdjusted!]));
    expect(byPair["control-low"]).toBeLessThan(0.05);
    expect(byPair["control-high"]).toBeLessThan(0.05);
    expect(byPair["low-high"]).toBeGreaterThanOrEqual(0.05);
    expect(shownComparisons(tests.pairs, "all")).toHaveLength(3);
    expect(shownComparisons(tests.pairs, "significant").map((pair) => `${pair.groupA}-${pair.groupB}`)).toEqual(["control-low", "control-high"]);
    expect(tests.overall?.name).toBe("Kruskal–Wallis");
  });

  it("with two groups, draw one bracket with the rank-sum p and no line", () => {
    const two = { control: THREE.control, low: THREE.low };
    const tests = panelTests(Object.entries(two).map(([label, values]) => ({ label, values: values.map((value, i) => ({ unit: `D${i + 1}`, value })) })), { comparisons: "pairwise", comparisonsShow: "all", paired: false });
    expect(tests.overall).toBeNull();
    expect(tests.pairs).toHaveLength(1);
    expect(tests.pairs[0].test).toBe("Wilcoxon rank-sum");
    expect(tests.pairs[0].pAdjusted).toBe(tests.pairs[0].p);
    // The statistic panel then keeps no line's row: only the bracket's.
    const model = statisticModel(two);
    const settings = { ...BASE_PROPORTIONS_SETTINGS, valueKind: "statistic" as const, plotType: "box" as const, xAxis: "groups" as const, test: true };
    const overall = statisticChartFrame(model, settings);
    const pairwise = statisticChartFrame(model, { ...settings, comparisons: "pairwise" });
    expect(pairwise.layout.height - overall.layout.height).toBe(bracketRowHeight(settings.fontTick) - (settings.fontTick + 6));
  });

  it("are drawn over a per-cell chart's replicate marks, on the units' values", () => {
    const model = statisticModel(THREE);
    const { panels, groups } = cellPanels(model, "groups");
    const frame = cellReplicateFrame(model, panels, groups, "groups", { unitModel: model, statistic: "median", unitSel: "donor", test: true, comparisons: { comparisons: "pairwise", comparisonsShow: "significant" } });
    expect(frame.comparisons.get(panels[0].key)!.map((pair) => `${pair.groupA}-${pair.groupB}`)).toEqual(["control-low", "control-high"]);
    act(() =>
      root.render(
        <CellValuesChart model={model} plotType="box" xAxis="groups" violinBox={false} axis={{ range: [0, 100], major: [{ at: 0, label: "0" }, { at: 100, label: "100" }], minor: [] }} catColors={["#888"]} palette="paired" fonts={{ tick: 9, axis: 10, legend: 11 }} appearance={{ height: 240, showGrid: true, showLegend: true }} replicates={{ unitModel: model, statistic: "median", unitSel: "donor", test: true, comparisons: { comparisons: "pairwise", comparisonsShow: "significant" } }} />,
      ),
    );
    expect(host.querySelectorAll(".gl-prop-bracket")).toHaveLength(2);
    expect(host.querySelector(".gl-prop-bracket title")!.textContent).toContain("never on the cells");
  });
});

describe("What is tested", () => {
  const base: ProportionsSettings = { ...BASE_PROPORTIONS_SETTINGS, valueKind: "statistic", plotType: "box", xAxis: "groups", test: true, unitSel: PROPORTIONS_SAMPLE_FACTOR };

  it("says the test, what it is on and the adjustment", () => {
    expect(comparisonDescription(base, 2)).toBe("Wilcoxon rank-sum test on the files' medians");
    expect(comparisonDescription(base, 3)).toBe("Kruskal–Wallis test on the files' medians");
    expect(comparisonDescription({ ...base, comparisons: "pairwise" }, 3)).toBe(
      "Kruskal–Wallis test across the groups, and Wilcoxon rank-sum test of each pair, on the files' medians, Holm-adjusted over 3 pairs",
    );
    expect(comparisonDescription({ ...base, test: false }, 3)).toBe("");
    expect(comparisonDescription({ ...base, xAxis: "populations" }, 3)).toBe("");
    // A proportion boxplot joined across groups by donor: paired.
    const proportion = { ...base, valueKind: "proportion" as const, unitSel: "donor", paired: true };
    expect(comparisonDescription(proportion, 2)).toBe("Wilcoxon signed-rank test on the donors' shares of the parent, each donor paired with itself across the groups");
    expect(comparisonDescription(proportion, 3)).toBe("Kruskal–Wallis test on the donors' shares of the parent; it does not take the pairing into account");
    // Joined lines on files pair nothing, and bars are never joined: unpaired.
    expect(comparisonDescription({ ...proportion, unitSel: PROPORTIONS_SAMPLE_FACTOR }, 2)).toBe("Wilcoxon rank-sum test on the files' shares of the parent");
    expect(comparisonDescription({ ...proportion, plotType: "bar" }, 2)).toBe("Wilcoxon rank-sum test on the donors' shares of the parent");
  });

  it("names a paired test against an unpaired one, with their own values", () => {
    const slots = Object.entries({ control: THREE.control, low: THREE.low }).map(([label, values]) => ({ label, values: values.map((value, i) => ({ unit: `D${i + 1}`, value })) }));
    const unpaired = panelTests(slots, { comparisons: "overall", comparisonsShow: "all", paired: false }).overall!;
    const paired = panelTests(slots, { comparisons: "overall", comparisonsShow: "all", paired: true }).overall!;
    expect(unpaired.name).toBe("Wilcoxon rank-sum");
    expect(paired.name).toBe("Wilcoxon signed-rank");
    expect(paired.pairs).toBe(5);
    expect(paired.label).toMatch(/^Wilcoxon signed-rank p = /);
    expect(paired.p).not.toBe(unpaired.p);
  });

  it("writes a legend's sentence naming the pairwise test, and the defaults' sentence as before", () => {
    expect(testSentence({ tests: [{ panel: "", name: "Wilcoxon rank-sum", p: 0.1 }], testAsked: true })).toBe("Wilcoxon rank-sum test, p = 0.10.");
    expect(
      testSentence({
        tests: [{ panel: "", name: "Kruskal–Wallis", p: 0.002 }],
        testAsked: true,
        testDescription: "Kruskal–Wallis test across the groups, and Wilcoxon rank-sum test of each pair, on the files' medians, Holm-adjusted over 3 pairs",
        comparisons: [{ panel: "", groupA: "control", groupB: "low", name: "Wilcoxon rank-sum", p: 0.008, pAdjusted: 0.024 }],
      }),
    ).toBe(
      "Kruskal–Wallis test across the groups, and Wilcoxon rank-sum test of each pair, on the files' medians, Holm-adjusted over 3 pairs. Kruskal–Wallis test, p = 0.0020. Pairs, Holm-adjusted: control against low, p = 0.024.",
    );
  });

  it("puts a statistic chart's pairs in a second block of its CSV, its rows unchanged", () => {
    const model = statisticModel(THREE);
    const settings = { ...BASE_PROPORTIONS_SETTINGS, valueKind: "statistic" as const, plotType: "box" as const, xAxis: "groups" as const, test: true, unitSel: "donor" };
    const plain = statisticDataTable(model, settings, { unit: "donor", group: "condition" }, "FSC-A");
    const table = statisticDataTable(model, { ...settings, comparisons: "pairwise" }, { unit: "donor", group: "condition" }, "FSC-A");
    expect(plain.comparisons).toBeUndefined();
    expect(table.header).toEqual(plain.header);
    expect(table.rows).toEqual(plain.rows);
    expect(table.comparisons!.rows.map((row) => row.slice(1, 4))).toEqual([
      ["", "", "Kruskal–Wallis"],
      ["control", "low", "Wilcoxon rank-sum"],
      ["control", "high", "Wilcoxon rank-sum"],
      ["low", "high", "Wilcoxon rank-sum"],
    ]);
    expect(plottingDataTableCsv(table)).toContain("\r\n\r\nPopulation,Group 1,Group 2,Test,Statistic,n 1,n 2,p,Adjusted p\r\n");
  });
});
