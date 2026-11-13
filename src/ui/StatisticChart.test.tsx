// @vitest-environment jsdom
// The Plotting tab's per-sample statistic chart: one value per replicate unit, its summaries, the
// rank test, its hand-off to the Layout tab and its block. Synthetic files D1 to D4; nothing here
// is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { BASE_PROPORTIONS_SETTINGS, PROPORTIONS_SAMPLE_FACTOR } from "../engine/proportionsSettings";
import { buildCellValuesModel, type CellValuesModel } from "../engine/cellValuesModel";
import { I18nProvider } from "./i18n";
import { composeProportionsChartSvg, PlottingTab } from "./PlottingTab";
import { LayoutProportionsSurface, plottingBlockSizer, proportionsSampleRefs } from "./LayoutProportions";
import { clearPersistedTabState, readProportionsSettings, restorePlottingState, savedPlottingState } from "./tabState";
import { createLayoutSheet } from "../engine/layout";
import { StatisticChart, statisticAxis, statisticGroups, statisticPanels, statisticPoints, summariseStatistic } from "./StatisticChart";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearPersistedTabState();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

// Small holds FSC below 25 and Large FSC from 25, in raw units. Per file, Small and Large:
// D1 (control) 10, 20 | 30, 40, 50; D3 (control) 12, 22 | 36; D2 (treated) 15, 18 | 35, 45;
// D4 (treated) 19, 21 | 41, 47. Small medians: control 15 and 17, treated 16.5 and 20.
const FSC: Record<string, number[]> = { D1: [10, 20, 30, 40, 50], D2: [15, 18, 35, 45], D3: [12, 22, 36], D4: [19, 21, 41, 47] };
const METADATA = { D1: { condition: "control" }, D2: { condition: "treated" }, D3: { condition: "control" }, D4: { condition: "treated" } };

function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const small = { ...newGate("Small", "rectangle", "FSC-A", "SSC-A", [[0, 0], [25, 1000]]), space: "raw" as const };
  const large = { ...newGate("Large", "rectangle", "FSC-A", "SSC-A", [[25, 0], [1000, 1000]]), space: "raw" as const };
  const smallPop = newPopulation("Small", [newGateRef(small.gate_id)], rootPop.population_id);
  const largePop = newPopulation("Large", [newGateRef(large.gate_id)], rootPop.population_id);
  rootPop.children = [smallPop.population_id, largePop.population_id];
  Object.assign(state, {
    gates: { [small.gate_id]: small, [large.gate_id]: large },
    gate_order: [small.gate_id, large.gate_id],
    populations: { [rootPop.population_id]: rootPop, [smallPop.population_id]: smallPop, [largePop.population_id]: largePop },
    root_population_id: rootPop.population_id,
    active_population_id: rootPop.population_id,
  });
  const file = (id: string) => {
    const fsc = FSC[id];
    const fcs: FcsFile = {
      version: "FCS3.1",
      nEvents: fsc.length,
      instrument: "flow",
      keywords: {},
      spillover: null,
      channels: [
        { index: 0, name: "SSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from(fsc.map(() => 100)), Float32Array.from(fsc)],
    };
    return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
  };
  return {
    state: state as CoreState,
    samples: ["D1", "D2", "D3", "D4"].map(file),
    small: smallPop.population_id,
    large: largePop.population_id,
  };
}

function mount(fx: ReturnType<typeof fixture>, onAddToLayout?: (settings: unknown) => void, onAddPanelsToLayout?: (settings: unknown, blocks: unknown) => void) {
  act(() =>
    root.render(
      <I18nProvider>
        <PlottingTab
          samples={fx.samples}
          activeSampleId="D1"
          state={fx.state}
          derived={recompute(fx.samples[0].sample, fx.state)}
          metadata={METADATA}
          metadataColumns={[{ name: "condition" }]}
          divisionProfiles={{}}
          dataRevisionKey="r1"
          onAddToLayout={onAddToLayout}
          onAddPanelsToLayout={onAddPanelsToLayout}
        />
      </I18nProvider>,
    ),
  );
}

const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
const radio = (name: string, index: number) => [...host.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)][index];
const labelled = (text: string) =>
  [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.trim().startsWith(text))!.querySelector("input, select") as HTMLInputElement & HTMLSelectElement;
const choose = (label: string, value: string) =>
  act(() => {
    const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
const panelTitles = () => [...host.querySelectorAll("#gl-prop-svg svg.gl-prop-panel")].map((svg) => svg.querySelector("text > title")?.textContent);
const pointTips = () => [...host.querySelectorAll("#gl-prop-svg circle.gl-prop-point")].map((c) => c.querySelector("title")?.textContent);
const markTips = () => [...host.querySelectorAll("#gl-prop-svg .gl-prop-mark")].map((m) => m.querySelector("title")?.textContent);

function chooseStatistic() {
  act(() => radio("prop-value", 2).click());
}

describe("Plotting tab: channel statistic per sample", () => {
  it("draws one point per file and population, the groups along x and a panel per population", () => {
    const fx = fixture();
    mount(fx);
    chooseStatistic();
    expect([...host.querySelectorAll<HTMLInputElement>('input[name="prop-type"]')].map((input) => input.parentElement!.textContent)).toEqual(["Boxplot", "Bar", "Points"]);
    expect(host.querySelector('[data-shelf="x"] .gl-figure-dimension > span')?.textContent).toBe("condition");
    expect(panelTitles()).toEqual(["Small", "Large"]);
    const tips = pointTips();
    expect(tips).toHaveLength(8);
    expect(tips).toContain("D1.fcs: median 15 of 2 cells from 1 file");
    expect(tips).toContain("D3.fcs: median 17 of 2 cells from 1 file");
    expect(tips).toContain("D4.fcs: median 44 of 2 cells from 1 file");
    expect(labelled("Replicate unit").disabled).toBe(false);
    expect(labelled("Include ungated").disabled).toBe(true);
  });

  it("takes the statistic asked for, on linear values", () => {
    const fx = fixture();
    mount(fx);
    chooseStatistic();
    choose("Statistic", "geomean");
    expect(pointTips()).toContain("D1.fcs: geometric mean 14.14 of 2 cells from 1 file");
    choose("Statistic", "mean");
    expect(pointTips()).toContain("D1.fcs: mean 40 of 3 cells from 1 file");
  });

  it("draws a bar at the mean with SD or SEM, and a box at the quartiles", () => {
    const fx = fixture();
    mount(fx);
    chooseStatistic();
    expect(markTips()[0]).toBe("Small · control: 2 units, median 16, quartiles 15.5–16.5");
    act(() => radio("prop-type", 1).click());
    expect(markTips()[0]).toBe("Small · control: 2 units, mean 16 ± SD 1.414");
    choose("Error bar", "sem");
    expect(markTips()[0]).toBe("Small · control: 2 units, mean 16 ± SEM 1");
    act(() => radio("prop-type", 2).click());
    expect(labelled("Show replicate points").disabled).toBe(true);
    expect(pointTips()).toHaveLength(8);
  });

  it("tests between the groups on the units' values, only with the groups along x", () => {
    const fx = fixture();
    mount(fx);
    chooseStatistic();
    expect(host.querySelectorAll("#gl-prop-svg .gl-prop-test")).toHaveLength(0);
    act(() => labelled("Rank test between groups").click());
    const tests = [...host.querySelectorAll("#gl-prop-svg .gl-prop-test")].map((t) => t.textContent?.replace(t.querySelector("title")?.textContent ?? "", ""));
    // Two units a group, Wilcoxon rank-sum on each population's four unit values: exact for Small,
    // as R gives it (0.667); Large has a tie, so the corrected normal approximation, as in R.
    expect(tests).toEqual(["Wilcoxon p = 0.67", "Wilcoxon p = 0.41"]);
    // A panel per population is framed on its own values; a panel per group shares one axis.
    const topTick = () => [...host.querySelectorAll("#gl-prop-svg svg.gl-prop-panel")].map((svg) => [...svg.querySelectorAll('text[text-anchor="end"]')].map((t) => t.textContent).at(-1));
    expect(topTick()).toEqual(["25", "50"]);
    choose("Place Populations", "x");
    expect(topTick()).toEqual(["50", "50"]);
    expect(labelled("Rank test between groups").disabled).toBe(true);
    expect(host.querySelectorAll("#gl-prop-svg .gl-prop-test")).toHaveLength(0);
    expect(panelTitles()).toEqual(["condition: control", "condition: treated"]);
  });

  it("keeps its settings across a save and reopen, hands them to Layout, and the block draws them", () => {
    const fx = fixture();
    const onAddToLayout = vi.fn();
    mount(fx, onAddToLayout);
    chooseStatistic();
    act(() => radio("prop-type", 1).click());
    choose("Statistic", "mean");
    act(() => labelled("Rank test between groups").click());
    const saved = savedPlottingState();
    clearPersistedTabState();
    restorePlottingState(saved);
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS)).toMatchObject({ valueKind: "statistic", plotType: "bar", statistic: "mean", test: true, xAxis: "groups" });

    act(() => button("Add to Layout")!.click());
    const settings = onAddToLayout.mock.calls[0][0];
    expect(settings).toMatchObject({ valueKind: "statistic", plotType: "bar", statistic: "mean", errorBar: "sd", test: true });
    const refs = fx.samples.map((s) => ({ ...s, fileName: s.name }));
    const frame = plottingBlockSizer(settings, proportionsSampleRefs(refs as never), fx.state, METADATA, {})!(createLayoutSheet());
    expect(frame.width).toBeGreaterThan(360);
    act(() =>
      root.render(
        <I18nProvider>
          <LayoutProportionsSurface
            recipe={{ kind: "proportions", settings }}
            samples={refs as never}
            state={fx.state}
            metadataById={METADATA}
            divisionProfiles={{}}
            width={600}
            height={400}
            containerId="layout-stat-x"
          />
        </I18nProvider>,
      ),
    );
    expect(host.querySelectorAll("#layout-stat-x circle.gl-prop-point")).toHaveLength(8);
    expect(host.querySelectorAll("#layout-stat-x .gl-prop-test")).toHaveLength(2);
    const composed = composeProportionsChartSvg("layout-stat-x")!;
    expect(composed.root.querySelectorAll("rect.gl-prop-mark")).toHaveLength(4);
  });

  it("sends a block per population panel, and a block draws that population's panel with its test", () => {
    const fx = fixture();
    const onAddPanelsToLayout = vi.fn();
    mount(fx, vi.fn(), onAddPanelsToLayout);
    chooseStatistic();
    act(() => labelled("Rank test between groups").click());
    act(() => button("Add panels to Layout")!.click());
    const [settings, blocks] = onAddPanelsToLayout.mock.calls[0] as [never, { panel: { population?: string }; row: number; column: number }[]];
    expect(blocks.map(({ row, column }) => [row, column])).toEqual([[0, 0], [0, 1]]);
    expect(blocks.every(({ panel }) => panel.population && Object.keys(panel).sort().join() === "population,populationId")).toBe(true);
    const refs = fx.samples.map((s) => ({ ...s, fileName: s.name }));
    act(() =>
      root.render(
        <I18nProvider>
          <LayoutProportionsSurface
            recipe={{ kind: "proportions", settings, panel: blocks[1].panel }}
            samples={refs as never}
            state={fx.state}
            metadataById={METADATA}
            divisionProfiles={{}}
            width={600}
            height={400}
            containerId="layout-stat-panel"
          />
        </I18nProvider>,
      ),
    );
    // Large alone: its four files' medians and its own test.
    expect(host.querySelectorAll("#layout-stat-panel svg.gl-prop-panel")).toHaveLength(1);
    expect(host.querySelectorAll("#layout-stat-panel circle.gl-prop-point")).toHaveLength(4);
    const tests = [...host.querySelectorAll("#layout-stat-panel .gl-prop-test")].map((t) => t.textContent?.replace(t.querySelector("title")?.textContent ?? "", ""));
    expect(tests).toEqual(["Wilcoxon p = 0.41"]);
  });

  it("draws pairwise brackets under the test control, keeps the choice across a save and reopen, and a Layout block and the export draw them", () => {
    const fx = fixture();
    const onAddToLayout = vi.fn();
    mount(fx, onAddToLayout);
    chooseStatistic();
    expect(labelled("Comparisons").disabled).toBe(true);
    act(() => labelled("Rank test between groups").click());
    expect(host.querySelector(".gl-prop-test-description")?.textContent).toBe("Wilcoxon rank-sum test on the files' medians.");
    choose("Comparisons", "pairwise");
    // Two groups: one bracket a panel, with the rank-sum p the line gave, instead of the line.
    expect(host.querySelectorAll("#gl-prop-svg .gl-prop-test")).toHaveLength(0);
    expect([...host.querySelectorAll("#gl-prop-svg .gl-prop-bracket text")].map((t) => t.textContent)).toEqual(["p = 0.67", "p = 0.41"]);
    choose("Brackets", "significant");
    expect(host.querySelectorAll("#gl-prop-svg .gl-prop-bracket")).toHaveLength(0);
    choose("Brackets", "all");
    const saved = savedPlottingState();
    clearPersistedTabState();
    restorePlottingState(saved);
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS)).toMatchObject({ test: true, comparisons: "pairwise", comparisonsShow: "all" });
    act(() => button("Add to Layout")!.click());
    const settings = onAddToLayout.mock.calls[0][0];
    expect(settings).toMatchObject({ comparisons: "pairwise", comparisonsShow: "all" });
    const refs = fx.samples.map((s) => ({ ...s, fileName: s.name }));
    act(() =>
      root.render(
        <I18nProvider>
          <LayoutProportionsSurface recipe={{ kind: "proportions", settings }} samples={refs as never} state={fx.state} metadataById={METADATA} divisionProfiles={{}} width={600} height={400} containerId="layout-stat-pairs" />
        </I18nProvider>,
      ),
    );
    expect(host.querySelectorAll("#layout-stat-pairs .gl-prop-bracket")).toHaveLength(2);
    const composed = composeProportionsChartSvg("layout-stat-pairs")!;
    expect(composed.root.querySelectorAll(".gl-prop-bracket")).toHaveLength(2);
  });
});

describe("Plotting tab: data export", () => {
  it("downloads the table the chart is drawn from as CSV", async () => {
    const fx = fixture();
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (blob: Blob) => (blobs.push(blob), "blob:x"), revokeObjectURL: () => undefined }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    mount(fx);
    chooseStatistic();
    act(() => button("Data (CSV)")!.click());
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe("text/csv");
    const text = await blobs[0].text();
    expect(text.split("\r\n")[0]).toBe("File,condition,Population,Files,Cells,Median FSC-A");
    expect(text).toContain("D3.fcs,control,Small,D3.fcs,2,17\r\n");
    click.mockRestore();
  });
});

describe("Plotting tab: a statistic chart drawn from given values", () => {
  const unitModel = (values: Record<string, number[]>): CellValuesModel => ({
    catLevels: ["Small"],
    levels: [{ popId: "p", depth: 1 }],
    violins: Object.entries(values).map(([unit, v], i) => ({
      cat: 0,
      group: i % 2 ? "treated" : "control",
      facet: null,
      unit,
      values: Float32Array.from(v),
      files: [`${unit}.fcs`],
    })),
    hasFacet: false,
    channelLabel: "FSC-A",
    excluded: [],
    noChannel: [],
    extent: null,
    axisSource: null,
  });
  const draw = (model: CellValuesModel, statistic: "median" | "mean" | "geomean") =>
    act(() =>
      root.render(
        <I18nProvider>
          <StatisticChart
            model={model}
            statistic={statistic}
            plotType="box"
            errorBar="sd"
            test={false}
            xAxis="groups"
            unitSel={PROPORTIONS_SAMPLE_FACTOR}
            catColors={["#1f77b4"]}
            palette={BASE_PROPORTIONS_SETTINGS.palette}
            fonts={{ tick: 10, axis: 11, legend: 10 }}
            appearance={{ height: 200, showGrid: true, showLegend: true, showPoints: true, pointRadius: 2 }}
          />
        </I18nProvider>,
      ),
    );

  it("labels its ticks apart when every value is 0", () => {
    draw(unitModel({ D1: [0, 0], D2: [0, 0, 0], D3: [0], D4: [0, 0] }), "median");
    const labels = [...host.querySelectorAll("#gl-prop-svg svg.gl-prop-panel")][0].querySelectorAll('text[text-anchor="end"]');
    // The value ticks; the group labels below the axis carry a title.
    const ticks = [...labels].filter((t) => !t.querySelector("title")).map((t) => t.textContent);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(ticks).toEqual(["0", "0.2", "0.4", "0.6", "0.8", "1"]);
  });

  it("gives a geometric mean's cells as those it is taken of, and those left out as not positive", () => {
    draw(unitModel({ D1: [-5, 0, 2, 8], D2: [1, 4] }), "geomean");
    expect(pointTips()).toEqual(["D1.fcs: geometric mean 4 of 2 cells, 2 not positive left out, from 1 file", "D2.fcs: geometric mean 2 of 2 cells from 1 file"]);
    draw(unitModel({ D1: [-5, 0, 2, 8], D2: [1, 4] }), "median");
    expect(pointTips()).toEqual(["D1.fcs: median 1 of 4 cells from 1 file", "D2.fcs: median 2.5 of 2 cells from 1 file"]);
  });
});

describe("statistic summaries", () => {
  it("summarises the units' values and frames a linear axis from 0 over the error bars", () => {
    const s = summariseStatistic([15, 17]);
    expect(s).toMatchObject({ n: 2, mean: 16, median: 16, q1: 15.5, q3: 16.5 });
    expect(s.sd).toBeCloseTo(Math.SQRT2, 10);
    expect(s.sem).toBeCloseTo(1, 10);

    const fx = fixture();
    const settings = { ...BASE_PROPORTIONS_SETTINGS, valueKind: "statistic" as const, channel: "FSC-A", files: ["D1", "D2", "D3", "D4"], selectedPops: [fx.small, fx.large], groupSel: "condition" };
    const refs = proportionsSampleRefs(fx.samples.map((f) => ({ ...f, fileName: f.name })) as never);
    const model = buildCellValuesModel(settings, refs, fx.state, METADATA, { poolBy: "unit", values: "raw" });
    const points = statisticPoints(model, "median");
    const panels = statisticPanels(model, points, statisticGroups(model), "groups", false);
    const axis = statisticAxis(points, panels, "bar", "sd");
    expect(axis.range[0]).toBe(0);
    // Large, treated: medians 40 and 44, mean 42 + SD 2.83 must fit.
    expect(axis.range[1]).toBeGreaterThan(42 + 2 * Math.SQRT2);
  });
});
