// @vitest-environment jsdom
// "Populations side by side in one panel" (settings.populationsTogether): with the groups along x,
// a per-cell or statistic chart draws one panel per facet, the populations side by side at each
// group and coloured by population, the group named once under the middle of its populations.
// Synthetic populations CD4_positive and CD8_positive, groups D1, D2 and D3, conditions control and
// treated; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { BASE_PROPORTIONS_SETTINGS } from "../engine/proportionsSettings";
import type { CellValuesModel, CellViolin } from "../engine/cellValuesModel";
import { I18nProvider } from "./i18n";
import { CellValuesChart, cellPanels, cellReplicateFrame } from "./CellValuesChart";
import { StatisticChart, statisticPanels, type StatisticPoint } from "./StatisticChart";
import { chartPanelDimensions } from "./panelArrangement";
import { PlottingTab } from "./PlottingTab";
import { clearPersistedTabState, readProportionsSettings, restorePlottingState, savedPlottingState } from "./tabState";

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

// Two populations in three groups; CD8_positive has no cells in D2.
const violin = (cat: number, group: string, values: number[]): CellViolin => ({ cat, group, facet: null, unit: null, values: Float32Array.from(values), files: [`${group}.fcs`] });
const MODEL: CellValuesModel = {
  catLevels: ["CD4_positive", "CD8_positive"],
  levels: [{ popId: "p4", depth: 1 }, { popId: "p8", depth: 1 }],
  violins: [
    violin(0, "D1", [50, 60, 70]), violin(1, "D1", [10, 20]),
    violin(0, "D2", [55, 65]),
    violin(0, "D3", [75, 85]), violin(1, "D3", [25, 35, 45]),
  ],
  hasFacet: false,
  channelLabel: "FSC-A",
  excluded: [],
  noChannel: [],
  extent: [10, 85],
  axisSource: null,
};
const GROUPS = ["D1", "D2", "D3"];
const point = (cat: number, group: string, value: number): StatisticPoint => ({ cat, group, facet: null, unit: `${group}.fcs`, value, cells: 2, files: [`${group}.fcs`] });
const POINTS = [point(0, "D1", 60), point(1, "D1", 15), point(0, "D2", 60), point(0, "D3", 80), point(1, "D3", 35)];
const COLOURS = ["#aa0000", "#0000aa"];

describe("Populations side by side in one panel: the slots", () => {
  it("lays the per-cell chart's populations side by side at each group, in one panel, with one empty slot", () => {
    const { panels, groups } = cellPanels(MODEL, "together");
    expect(groups).toEqual(GROUPS);
    expect(panels).toHaveLength(1);
    const [panel] = panels;
    expect([panel.group, panel.population, panel.populationId]).toEqual([null, null, null]);
    // slot = group × populations + population.
    expect(panel.slots.map((slot) => [slot.label, slot.cat, slot.colour, slot.tick])).toEqual([
      ["D1", 0, 0, "D1"], ["D1", 1, 1, ""],
      ["D2", 0, 0, "D2"], ["D2", 1, 1, ""],
      ["D3", 0, 0, "D3"], ["D3", 1, 1, ""],
    ]);
    expect(panel.slots.map((slot) => slot.violin?.values.length ?? 0)).toEqual([3, 2, 2, 0, 2, 3]);
    expect(panel.slots[3].violin).toBeUndefined();
    // The population is not a panel dimension.
    expect(chartPanelDimensions({ valueKind: "cells", plotType: "violin", xAxis: "groups", populationsTogether: true }, false)).toEqual([]);
    expect(chartPanelDimensions({ valueKind: "cells", plotType: "violin", xAxis: "groups" }, false)).toEqual(["populations"]);
  });

  it("lays the statistic chart's populations side by side, without a rank test", () => {
    const panels = statisticPanels(MODEL, POINTS, GROUPS, "together", true);
    expect(panels).toHaveLength(1);
    const [panel] = panels;
    expect(panel.slots.map((slot) => [slot.label, slot.cat, slot.colour, slot.tick, slot.points.map((p) => p.value)])).toEqual([
      ["D1", 0, 0, "D1", [60]], ["D1", 1, 1, "", [15]],
      ["D2", 0, 0, "D2", [60]], ["D2", 1, 1, "", []],
      ["D3", 0, 0, "D3", [80]], ["D3", 1, 1, "", [35]],
    ]);
    expect(panel.test).toBeNull();
    expect(panel.comparisons).toEqual([]);
  });

  it("with one population, holds the same slots as that population's panel with the groups along x", () => {
    const one: CellValuesModel = { ...MODEL, catLevels: ["CD4_positive"], levels: [MODEL.levels[0]], violins: MODEL.violins.filter((v) => v.cat === 0) };
    const strip = (slots: { label: string; violin?: CellViolin; colour: number }[]) => slots.map((slot) => ({ label: slot.label, violin: slot.violin, colour: slot.colour }));
    const [together] = cellPanels(one, "together").panels;
    const [groups] = cellPanels(one, "groups").panels;
    expect(together.slots.map((slot) => slot.tick)).toEqual(GROUPS);
    expect(strip(together.slots).map((slot) => [slot.label, slot.violin])).toEqual(strip(groups.slots).map((slot) => [slot.label, slot.violin]));
    const onePoints = POINTS.filter((p) => p.cat === 0);
    const [stTogether] = statisticPanels(one, onePoints, GROUPS, "together", false);
    const [stGroups] = statisticPanels(one, onePoints, GROUPS, "groups", false);
    expect(stTogether.slots.map((slot) => [slot.label, slot.points])).toEqual(stGroups.slots.map((slot) => [slot.label, slot.points]));
  });

  it("puts each slot's replicate marks on its own population and group, with no rank test", () => {
    const { panels, groups } = cellPanels(MODEL, "together");
    const unitModel: CellValuesModel = { ...MODEL, violins: MODEL.violins.map((v) => ({ ...v, unit: `${v.group}.fcs` })) };
    const frame = cellReplicateFrame(MODEL, panels, groups, "together", { unitModel, statistic: "median", unitSel: "condition", test: true });
    expect(frame.withTest).toBe(false);
    expect(panels[0].slots.map((_, si) => frame.slotPoints(panels[0], si).map((p) => [p.cat, p.group, p.value]))).toEqual([
      [[0, "D1", 60]], [[1, "D1", 15]], [[0, "D2", 60]], [], [[0, "D3", 80]], [[1, "D3", 35]],
    ]);
  });
});

describe("Populations side by side in one panel: drawn", () => {
  const axis = { range: [0, 100] as [number, number], major: [{ at: 0, label: "0" }, { at: 100, label: "100" }], minor: [] };
  const tickTexts = () => [...host.querySelectorAll("svg.gl-prop-panel text > title")].map((title) => title.textContent);

  it("draws a per-cell chart's marks in their populations' colours, the populations in the legend and each group's name once", () => {
    act(() =>
      root.render(
        <I18nProvider>
          <CellValuesChart
            model={MODEL} plotType="violin" xAxis="groups" populationsTogether violinBox={false} axis={axis}
            catColors={COLOURS} palette="paired" fonts={{ tick: 9, axis: 10, legend: 11 }}
            appearance={{ height: 200, showGrid: false, showLegend: true }} groupTitle="condition"
          />
        </I18nProvider>,
      ),
    );
    expect(host.querySelectorAll("svg.gl-prop-panel")).toHaveLength(1);
    expect([...host.querySelectorAll("path.gl-prop-mark")].map((mark) => mark.getAttribute("fill"))).toEqual(["#aa0000", "#0000aa", "#aa0000", "#aa0000", "#0000aa"]);
    expect([...host.querySelectorAll(".gl-prop-legend-label")].map((label) => label.textContent)).toEqual(["CD4_positive", "CD8_positive"]);
    expect(host.querySelector(".gl-prop-legend-title")).toBeNull();
    for (const group of GROUPS) expect(tickTexts().filter((text) => text === group)).toHaveLength(1);
  });

  it("draws a statistic chart's marks in their populations' colours, the populations in the legend, each group's name once and no test", () => {
    const unitModel: CellValuesModel = { ...MODEL, violins: MODEL.violins.map((v) => ({ ...v, unit: `${v.group}.fcs` })) };
    act(() =>
      root.render(
        <I18nProvider>
          <StatisticChart
            model={unitModel} statistic="median" plotType="bar" errorBar="sd" test xAxis="groups" populationsTogether unitSel="__sample__"
            catColors={COLOURS} palette="paired" fonts={{ tick: 9, axis: 10, legend: 11 }}
            appearance={{ height: 200, showGrid: false, showLegend: true, showPoints: false, pointRadius: 2 }}
          />
        </I18nProvider>,
      ),
    );
    expect(host.querySelectorAll("svg.gl-prop-panel")).toHaveLength(1);
    expect([...host.querySelectorAll("rect.gl-prop-mark")].map((mark) => mark.getAttribute("fill"))).toEqual(["#aa0000", "#0000aa", "#aa0000", "#aa0000", "#0000aa"]);
    expect([...host.querySelectorAll(".gl-prop-legend-label")].map((label) => label.textContent)).toEqual(["CD4_positive", "CD8_positive"]);
    for (const group of GROUPS) expect(tickTexts().filter((text) => text === group)).toHaveLength(1);
    expect(host.querySelector(".gl-prop-test")).toBeNull();
  });
});

// The Plotting tab. Small holds FSC below 25 and Large FSC from 25, in raw units.
function tabFixture() {
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
  const file = (id: string, fsc: number[]) => {
    const fcs: FcsFile = {
      version: "FCS3.1", nEvents: fsc.length, instrument: "flow", keywords: {}, spillover: null,
      channels: [
        { index: 0, name: "SSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from(fsc.map(() => 100)), Float32Array.from(fsc)],
    };
    return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
  };
  return { state: state as CoreState, samples: [file("D1", [10, 20, 30, 40, 50]), file("D2", [15, 18, 35, 45])] };
}

describe("Populations side by side in one panel: the Plotting tab", () => {
  const mount = (fx: ReturnType<typeof tabFixture>) =>
    act(() =>
      root.render(
        <I18nProvider>
          <PlottingTab
            samples={fx.samples} activeSampleId="D1" state={fx.state} derived={recompute(fx.samples[0].sample, fx.state)}
            metadata={{ D1: { condition: "control" }, D2: { condition: "treated" } }} metadataColumns={[{ name: "condition" }]}
            divisionProfiles={{}} dataRevisionKey="r1" gatingRange={(channel) => (channel === "FSC-A" ? [0, 100] : undefined)}
          />
        </I18nProvider>,
      ),
    );
  const option = (text: string) => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.trim() === text)?.querySelector("input");
  const groupsAlongX = () =>
    act(() => {
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Place condition"]')!;
      select.value = "x";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

  it("shows the checkbox with the groups along x, draws one panel, ticks and disables Colour by population, and keeps the choice", () => {
    mount(tabFixture());
    act(() => [...host.querySelectorAll<HTMLInputElement>('input[name="prop-value"]')][1].click());
    expect(option("Populations side by side in one panel")).toBeUndefined();
    groupsAlongX();
    expect(host.querySelectorAll("#gl-prop-svg svg.gl-prop-panel")).toHaveLength(2);
    act(() => option("Populations side by side in one panel")!.click());
    expect(host.querySelectorAll("#gl-prop-svg svg.gl-prop-panel")).toHaveLength(1);
    expect(host.querySelectorAll("#gl-prop-svg path.gl-prop-mark")).toHaveLength(4);
    expect(option("Colour by population")!.checked).toBe(true);
    expect(option("Colour by population")!.disabled).toBe(true);
    expect(savedPlottingState()["prop.populationsTogether"]).toBe(true);
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS).populationsTogether).toBe(true);
    // A saved chart state without the setting loads without it.
    const { "prop.populationsTogether": _dropped, ...older } = savedPlottingState();
    void _dropped;
    clearPersistedTabState();
    restorePlottingState(older);
    expect("populationsTogether" in readProportionsSettings(BASE_PROPORTIONS_SETTINGS)).toBe(false);
    restorePlottingState({ ...older, "prop.populationsTogether": true });
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS).populationsTogether).toBe(true);
  });
});
