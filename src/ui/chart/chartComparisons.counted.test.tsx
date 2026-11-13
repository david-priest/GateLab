// @vitest-environment jsdom
// The Plotting boxplot's pairwise brackets and paired test on a population counted through a drawn
// gate: each donor's share as the gate list counts it, compared between three conditions pair by
// pair (pairwiseWilcoxon) and within donors (wilcoxonSignedRank, Holm-adjusted), as the chart
// writes them above its plot and in its table. Synthetic donors D1 to D5 in control, low and high;
// nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation, type Population } from "../../engine/models";
import { Sample } from "../../engine/sample";
import type { FcsFile } from "../../engine/fcs";
import { initialCoreState, recompute, type CoreState } from "../../store";
import { buildProportionsModel, defaultProportionsSettings, type ProportionsSampleRef } from "../../engine/proportionsModel";
import { formatP } from "../../engine/layoutChart";
import { holmAdjust, pairwiseWilcoxon, wilcoxonSignedRank } from "../../engine/rankTests";
import type { ProportionsSettings } from "../../engine/proportionsSettings";
import { ProportionsChart } from "../ProportionsChart";
import { plottingDataTableCsv, proportionsDataTable } from "../plottingData";
import { comparisonDescription } from "./chartComparisons";

// Gate A holds FSC below 55, in raw units.
function tree() {
  const state = initialCoreState();
  const root = newRootPopulation();
  const gate = newGate("A", "rectangle", "FSC-A", "SSC-A", [[0, 0], [55, 1000]]);
  const a = newPopulation("A", [newGateRef(gate.gate_id)], root.population_id);
  root.children = [a.population_id];
  const populations: Record<string, Population> = { [root.population_id]: root, [a.population_id]: a };
  Object.assign(state, {
    gates: { [gate.gate_id]: gate },
    gate_order: [gate.gate_id],
    populations,
    root_population_id: root.population_id,
    active_population_id: root.population_id,
  });
  return { state: state as CoreState, a: a.population_id };
}

// Twenty events a file, `inside` of them in A (FSC 10 to 44) and the rest outside it (FSC 60 to 98).
function file(id: string, inside: number): ProportionsSampleRef {
  const fsc = Array.from({ length: 20 }, (_, i) => (i < inside ? 10 + 2 * i : 60 + 2 * (i - inside)));
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: fsc.length,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from(fsc), Float32Array.from(fsc.map(() => 10))],
  };
  return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
}

// Events in A per donor and condition.
const DONORS = [
  { id: "D1", control: 18, low: 9, high: 4 },
  { id: "D2", control: 17, low: 14, high: 6 },
  { id: "D3", control: 16, low: 12, high: 5 },
  { id: "D4", control: 15, low: 10, high: 8 },
  { id: "D5", control: 11, low: 13, high: 7 },
];
const CONDITIONS = ["control", "low", "high"] as const;
const FILES = DONORS.flatMap((donor) => CONDITIONS.map((condition) => file(`${donor.id}-${condition}`, donor[condition])));
const METADATA = Object.fromEntries(DONORS.flatMap((donor) => CONDITIONS.map((condition) => [`${donor.id}-${condition}`, { donor: donor.id, condition }])));

function fixture() {
  const fx = tree();
  const settings: ProportionsSettings = {
    ...defaultProportionsSettings(FILES, fx.state, []),
    selectedPops: [fx.a],
    groupSel: "condition",
    unitSel: "donor",
    plotType: "box",
    test: true,
    comparisons: "pairwise",
  };
  const model = buildProportionsModel(settings, FILES, fx.state, METADATA, {});
  // The shares as the gate list counts them, in per cent of the file.
  const shares = Object.fromEntries(CONDITIONS.map((condition) => [condition, DONORS.map((donor) => {
    const entry = FILES.find((f) => f.id === `${donor.id}-${condition}`)!;
    return ((recompute(entry.sample, fx.state).populations[fx.a].event_count ?? 0) / 20) * 100;
  })])) as Record<(typeof CONDITIONS)[number], number[]>;
  return { settings, model, shares };
}

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

function draw(model: ReturnType<typeof fixture>["model"], settings: ProportionsSettings) {
  act(() =>
    root.render(
      <ProportionsChart
        plotType="box"
        test
        comparisons={settings}
        unitSel={settings.unitSel}
        model={model}
        catColors={["#2f80ed", "#e15759"]}
        palette="paired"
        averagePerUnit
        populations={{}}
        fonts={{ tick: 9, axis: 10, legend: 11 }}
        appearance={{ height: 240, showGrid: true, showPoints: true, paired: settings.paired, showLegend: true, pointRadius: 2 }}
      />,
    ),
  );
}

const panel = () => host.querySelectorAll("svg.gl-prop-panel")[0];
const brackets = () => [...panel().querySelectorAll(".gl-prop-bracket")].map((g) => ({ label: g.querySelector("text")!.textContent, title: g.querySelector("title")!.textContent! }));

describe("Pairwise brackets on a drawn gate", () => {
  it("write each pair's Holm-adjusted p as pairwiseWilcoxon gives it on the counted shares", () => {
    const { settings, model, shares } = fixture();
    expect(CONDITIONS.map((c) => shares[c].map(Math.round))).toEqual([[90, 85, 80, 75, 55], [45, 70, 60, 50, 65], [20, 30, 25, 40, 35]]);
    draw(model, settings);
    const expected = pairwiseWilcoxon(CONDITIONS.map((c) => shares[c]));
    const drawn = brackets();
    expect(drawn).toHaveLength(3);
    expected.forEach((pair) => {
      const bracket = drawn.find((b) => b.title.includes(`${CONDITIONS[pair.a]} against ${CONDITIONS[pair.b]}`))!;
      expect(bracket.label).toBe(formatP(pair.pAdjusted!));
      expect(bracket.title).toContain(`U = ${pair.statistic}`);
      expect(bracket.title).toContain("Wilcoxon rank-sum");
    });
    // control against low: 14 / 252; the other two 6 / 252 after Holm's adjustment.
    expect(drawn.map((b) => b.label).sort()).toEqual(["p = 0.02", "p = 0.02", "p = 0.06"]);
    // Kruskal–Wallis stays as the line above the brackets.
    expect(panel().querySelector(".gl-prop-test")!.textContent).toMatch(/^Kruskal–Wallis/);
  });

  it("with significant only, hides the pair at adjusted p of 0.05 or more", () => {
    const { settings, model } = fixture();
    draw(model, { ...settings, comparisonsShow: "significant" });
    expect(brackets().map((b) => b.label)).toEqual(["p = 0.02", "p = 0.02"]);
    expect(brackets().some((b) => b.title.includes("control against low"))).toBe(false);
  });

  it("joined across groups, tests each pair by the signed-rank test on the donors, Holm-adjusted, and drops the overall line", () => {
    const { settings, model, shares } = fixture();
    const paired = { ...settings, paired: true };
    draw(model, paired);
    const tests = [[0, 1], [0, 2], [1, 2]].map(([i, j]) => wilcoxonSignedRank(shares[CONDITIONS[i]], shares[CONDITIONS[j]])!);
    const adjusted = holmAdjust(tests.map((test) => test.p));
    const drawn = brackets();
    expect(drawn).toHaveLength(3);
    [[0, 1], [0, 2], [1, 2]].forEach(([i, j], k) => {
      const bracket = drawn.find((b) => b.title.includes(`${CONDITIONS[i]} against ${CONDITIONS[j]}`))!;
      expect(bracket.title).toContain("Wilcoxon signed-rank");
      expect(bracket.title).toContain(`V = ${tests[k].statistic}`);
      expect(bracket.title).toContain("5 pairs");
      expect(bracket.label).toBe(formatP(adjusted[k]!));
    });
    expect(panel().querySelector(".gl-prop-test")).toBeNull();
    expect(comparisonDescription(paired, 3)).toBe(
      "Wilcoxon signed-rank test of each pair of groups on the donors' shares of the parent, each donor paired with itself across the groups, Holm-adjusted over 3 pairs; no overall test is made for paired groups",
    );
  });

  it("joined across two groups, writes the signed-rank test on the line, and only on the donors in both", () => {
    const { settings, model, shares } = fixture();
    // Without D5's low file, control against low has four pairs.
    const twoGroups = { ...model, perSample: model.perSample.filter((row) => row.group !== "high" && !(row.unit === "D5" && row.group === "low")) };
    draw(twoGroups, { ...settings, paired: true, comparisons: "overall" });
    const expected = wilcoxonSignedRank(shares.control.slice(0, 4), shares.low.slice(0, 4))!;
    const line = panel().querySelector(".gl-prop-test")!;
    expect(line.lastChild!.textContent).toBe(expected.label);
    expect(expected.label).toMatch(/^Wilcoxon signed-rank/);
    expect(line.querySelector("title")!.textContent).toContain("4 pairs");
    expect(brackets()).toHaveLength(0);
  });

  it("puts each pair's test, statistic, p and adjusted p in a second block of the CSV, the first block unchanged", () => {
    const { model, shares } = fixture();
    const order = {};
    const plain = proportionsDataTable(model, { group: "condition", unit: "donor" }, (id) => id, false, order, "parent");
    const table = proportionsDataTable(model, { group: "condition", unit: "donor" }, (id) => id, false, order, "parent", { comparisons: "pairwise", comparisonsShow: "all", paired: false });
    expect(table.header).toEqual(plain.header);
    expect(table.rows).toEqual(plain.rows);
    expect(table.comparisons!.header).toEqual(["Population", "Group 1", "Group 2", "Test", "Statistic", "n 1", "n 2", "p", "Adjusted p"]);
    const pairs = pairwiseWilcoxon(CONDITIONS.map((c) => shares[c]));
    const rows = table.comparisons!.rows.filter((row) => row[0] === "A");
    expect(rows[0].slice(0, 4)).toEqual(["A", "", "", "Kruskal–Wallis"]);
    expect(rows.slice(1).map((row) => [row[1], row[2], row[3], Number(row[4]), Number(row[7]), Number(row[8])])).toEqual(
      pairs.map((pair) => [CONDITIONS[pair.a], CONDITIONS[pair.b], "Wilcoxon rank-sum", pair.statistic, expect.closeTo(pair.p!, 5), expect.closeTo(pair.pAdjusted!, 5)]),
    );
    const csv = plottingDataTableCsv(table);
    expect(csv.startsWith(plottingDataTableCsv(plain))).toBe(true);
    expect(csv).toContain("\r\n\r\nPopulation,Group 1,Group 2,Test,Statistic,n 1,n 2,p,Adjusted p\r\n");
    // With the defaults there is no second block.
    expect(proportionsDataTable(model, { group: "condition", unit: "donor" }, (id) => id, false, order, "parent", { comparisons: "overall", comparisonsShow: "all", paired: false }).comparisons).toBeUndefined();
  });
});
