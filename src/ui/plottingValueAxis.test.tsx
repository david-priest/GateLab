// @vitest-environment jsdom
// The Plotting charts' value axis: typed limits and the clip they put on the marks, an axis
// fitted to the values against one from zero, one axis over every panel against one per panel,
// in the tab and in Layout blocks of one panel, and the settings kept across a save. Synthetic
// files D1 to D4 in groups control and treated; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { BASE_PROPORTIONS_SETTINGS, type ProportionsSettings } from "../engine/proportionsSettings";
import { buildCellValuesModel } from "../engine/cellValuesModel";
import { I18nProvider } from "./i18n";
import { PlottingTab } from "./PlottingTab";
import { LayoutProportionsSurface, proportionsSampleRefs } from "./LayoutProportions";
import { clearPersistedTabState, readProportionsSettings, restorePlottingState, savedPlottingState } from "./tabState";
import { statisticValueAxis } from "./StatisticChart";
import { cellChartAxis } from "./CellValuesChart";
import { fittedScale, limitedScale, sharesValueAxis } from "./chart/valueAxis";

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

// Small holds FSC below 25 and Large FSC from 25, in raw units; FITC-A (CD4) is FSC × 100, on a
// logicle scale. Per file, Small and Large: D1 (control) 10, 20 | 30, 40, 50; D3 (control) 12, 22 | 36;
// D2 (treated) 15, 18 | 35, 45; D4 (treated) 19, 21 | 41, 47. Small medians 15, 17, 16.5 and 20;
// Large medians 40, 36, 40 and 44.
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
        { index: 2, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from(fsc.map(() => 100)), Float32Array.from(fsc), Float32Array.from(fsc.map((v) => v * 100))],
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

function mount(fx: ReturnType<typeof fixture>, onAddToLayout?: (settings: unknown) => void) {
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
        />
      </I18nProvider>,
    ),
  );
}

const radio = (name: string, index: number) => [...host.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)][index];
const labelled = (text: string) =>
  [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.trim().startsWith(text))!.querySelector("input, select") as HTMLInputElement & HTMLSelectElement;
const choose = (label: string, value: string) =>
  act(() => {
    const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
const typeLimit = (label: "Value axis minimum" | "Value axis maximum", text: string) =>
  act(() => {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
const panels = (id = "gl-prop-svg") => [...host.querySelectorAll<SVGSVGElement>(`#${id} svg.gl-prop-panel`)];
/** Each panel's value ticks, bottom to top; the category labels below the axis carry a title. */
const ticks = (id = "gl-prop-svg") =>
  panels(id).map((svg) => [...svg.querySelectorAll('text[text-anchor="end"]')].filter((t) => !t.querySelector("title")).map((t) => t.textContent));

describe("value axis scales", () => {
  it("fits an axis to the values with headroom, where a zero-based one crowds them at its top", () => {
    // Two medians of 60,000 and 68,000: from zero they sit in the top fifth of the panel.
    const zero = statisticValueAxis([60000, 68000]);
    expect(zero.range[0]).toBe(0);
    expect(fittedScale([60000, 68000])).toEqual({ min: 58000, max: 70000, ticks: [58000, 60000, 62000, 64000, 66000, 68000, 70000] });
    expect(statisticValueAxis([60000, 68000], { fromZero: false }).range).toEqual([58000, 70000]);
    // A share is kept within 0 to 100%.
    expect(fittedScale([0.01, 0.98], [0, 1])).toMatchObject({ min: 0, max: 1 });
  });

  it("replaces either end with a typed limit, finds the ticks again and asks for the clip", () => {
    const auto = { min: 0, max: 50, ticks: [0, 10, 20, 30, 40, 50] };
    expect(limitedScale(auto, null)).toBe(auto);
    expect(limitedScale(auto, [10, 30])).toEqual({ min: 10, max: 30, ticks: [10, 15, 20, 25, 30], clip: true });
    expect(limitedScale(auto, [null, 20])).toMatchObject({ min: 0, max: 20, clip: true });
    // A limit that leaves no range is ignored.
    expect(limitedScale(auto, [60, null])).toBe(auto);
  });

  it("keeps each chart kind's own sharing unless told", () => {
    const base = { ...BASE_PROPORTIONS_SETTINGS };
    expect(sharesValueAxis({ ...base, valueKind: "cells", plotType: "violin" })).toBe(true);
    expect(sharesValueAxis({ ...base, valueKind: "statistic", plotType: "box", xAxis: "groups" })).toBe(false);
    expect(sharesValueAxis({ ...base, valueKind: "statistic", plotType: "box", xAxis: "populations" })).toBe(true);
    expect(sharesValueAxis({ ...base, valueKind: "proportion", plotType: "box" })).toBe(false);
    expect(sharesValueAxis({ ...base, valueKind: "proportion", plotType: "stacked" })).toBe(true);
    expect(sharesValueAxis({ ...base, valueKind: "proportion", plotType: "box", shareValueAxis: true })).toBe(true);
  });
});

describe("Plotting tab: a statistic chart's value axis", () => {
  it("starts at zero, or fits the values; bars always start at zero", () => {
    mount(fixture());
    act(() => radio("prop-value", 2).click());
    expect(ticks().map((panel) => panel[0])).toEqual(["0", "0"]);
    act(() => labelled("Start at zero").click());
    // Small's medians 15 to 20 and Large's 36 to 44, each panel fitted to its own.
    expect(ticks()).toEqual([
      ["14", "15", "16", "17", "18", "19", "20", "21"],
      ["34", "36", "38", "40", "42", "44", "46"],
    ]);
    act(() => radio("prop-type", 1).click());
    expect(labelled("Start at zero").disabled).toBe(true);
    expect(labelled("Start at zero").checked).toBe(true);
    expect(ticks().map((panel) => panel[0])).toEqual(["0", "0"]);
  });

  it("puts every panel on one axis, or each on its own", () => {
    mount(fixture());
    act(() => radio("prop-value", 2).click());
    // A panel per population fits its own, as before.
    expect(labelled("Same axis in every panel").checked).toBe(false);
    expect(ticks().map((panel) => panel.at(-1))).toEqual(["25", "50"]);
    act(() => labelled("Same axis in every panel").click());
    expect(ticks().map((panel) => panel.at(-1))).toEqual(["50", "50"]);
  });

  it("limits the axis to the typed values and cuts the marks beyond them at the plot's edge", () => {
    mount(fixture());
    act(() => radio("prop-value", 2).click());
    expect(host.querySelector("#gl-prop-svg clipPath")).toBeNull();
    typeLimit("Value axis minimum", "10");
    typeLimit("Value axis maximum", "30");
    expect(ticks()).toEqual([["10", "15", "20", "25", "30"], ["10", "15", "20", "25", "30"]]);
    const large = panels()[1];
    const clip = large.querySelector("clipPath rect")!;
    const top = Number(clip.getAttribute("y"));
    // Large's medians, 36 and up, lie above the limit: drawn beyond the edge and cut, not moved onto it.
    const points = [...large.querySelectorAll("g.gl-prop-plot-clip circle.gl-prop-point")];
    expect(points).toHaveLength(4);
    expect(points.every((p) => Number(p.getAttribute("cy")) < top)).toBe(true);
    expect(large.querySelector("g.gl-prop-plot-clip")!.getAttribute("clip-path")).toBe(`url(#${large.querySelector("clipPath")!.id})`);
    // Blank is automatic again.
    typeLimit("Value axis minimum", "");
    typeLimit("Value axis maximum", "");
    expect(host.querySelector("#gl-prop-svg clipPath")).toBeNull();
    expect(ticks().map((panel) => panel.at(-1))).toEqual(["25", "50"]);
  });
});

describe("Plotting tab: a proportion chart's value axis", () => {
  it("takes its limits in per cent, shares one axis when asked, and has no start or sharing for a stacked bar", () => {
    mount(fixture());
    expect(labelled("Same axis in every panel").disabled).toBe(true);
    expect(labelled("Start at zero").disabled).toBe(true);
    typeLimit("Value axis maximum", "50");
    expect(ticks()[0].at(-1)).toBe("50%");
    expect(panels()[0].querySelector("clipPath")).not.toBeNull();
    typeLimit("Value axis maximum", "");
    // A boxplot of events: Small has 2 in every file, Large up to 3, each on its own axis.
    act(() => radio("prop-type", 1).click());
    choose("Value", "count");
    const own = ticks().map((panel) => panel.at(-1));
    expect(own[0]).not.toBe(own[1]);
    act(() => labelled("Same axis in every panel").click());
    const shared = ticks().map((panel) => panel.at(-1));
    expect(shared[0]).toBe(shared[1]);
    expect(shared[0]).toBe(own[1]);
    // Fitted, each panel's axis no longer starts at 0: Small's, of 2 events in every file, is about 2.
    act(() => labelled("Same axis in every panel").click());
    act(() => labelled("Start at zero").click());
    expect(ticks()[0][0]).toBe("1.7");
    expect(ticks()[0].at(-1)).toBe("2.3");
  });
});

describe("Plotting tab: a per-cell chart's value axis", () => {
  it("places a typed minimum through the channel's transform", () => {
    const fx = fixture();
    const settings: ProportionsSettings = { ...BASE_PROPORTIONS_SETTINGS, valueKind: "cells", plotType: "violin", channel: "CD4", files: ["D1", "D2", "D3", "D4"], selectedPops: [fx.small, fx.large], groupSel: "condition" };
    const refs = proportionsSampleRefs(fx.samples.map((f) => ({ ...f, fileName: f.name })) as never);
    const model = buildCellValuesModel(settings, refs, fx.state, METADATA);
    const sample = model.axisSource!.sample;
    const auto = cellChartAxis(model, "fit", undefined)!;
    expect(auto.clip).toBeUndefined();
    const limited = cellChartAxis(model, "fit", undefined, { min: 1000 })!;
    // CD4 (FITC-A) is logicle: 1,000 measured is not 1,000 on the display scale.
    expect(sample.rawToDisplay("CD4", 1000)).not.toBe(1000);
    expect(limited.range[0]).toBeCloseTo(sample.rawToDisplay("CD4", 1000), 9);
    expect(limited.range[1]).toBe(auto.range[1]);
    expect(limited.clip).toBe(true);
  });

  it("shares one axis by default, and fits each panel when the axis is fitted to the cells", () => {
    mount(fixture());
    act(() => radio("prop-value", 1).click());
    choose("Channel", "FSC-A");
    choose("Place condition", "x");
    // The Gating tab's range is one range for every panel.
    expect(labelled("Same axis in every panel").disabled).toBe(true);
    choose("Value axis", "fit");
    expect(labelled("Same axis in every panel").checked).toBe(true);
    const shared = ticks();
    expect(shared[0]).toEqual(shared[1]);
    act(() => labelled("Same axis in every panel").click());
    const own = ticks();
    expect(own[0]).not.toEqual(own[1]);
  });
});

describe("Layout: a block of one panel", () => {
  it("draws the axis shared over the whole chart, or its panel's own", () => {
    const fx = fixture();
    const refs = fx.samples.map((s) => ({ ...s, fileName: s.name }));
    const settings: ProportionsSettings = {
      ...BASE_PROPORTIONS_SETTINGS,
      valueKind: "statistic",
      plotType: "box",
      channel: "FSC-A",
      xAxis: "groups",
      files: ["D1", "D2", "D3", "D4"],
      selectedPops: [fx.small, fx.large],
      groupSel: "condition",
      hierarchy: fx.state.active_hierarchy_id,
      parent: fx.state.root_population_id!,
    };
    const draw = (shareValueAxis: boolean, valueMax: number | null = null) =>
      act(() =>
        root.render(
          <I18nProvider>
            <LayoutProportionsSurface
              recipe={{ kind: "proportions", settings: { ...settings, shareValueAxis, valueMax }, panel: { population: "Small", populationId: fx.small } }}
              samples={refs as never}
              state={fx.state}
              metadataById={METADATA}
              divisionProfiles={{}}
              width={600}
              height={400}
              containerId="layout-axis"
            />
          </I18nProvider>,
        ),
      );
    draw(false);
    expect(ticks("layout-axis")).toHaveLength(1);
    expect(ticks("layout-axis")[0].at(-1)).toBe("25");
    // Shared: Small's panel on the axis that holds Large's medians too.
    draw(true);
    expect(ticks("layout-axis")[0].at(-1)).toBe("50");
    draw(true, 30);
    expect(ticks("layout-axis")[0].at(-1)).toBe("30");
    expect(host.querySelector("#layout-axis clipPath")).not.toBeNull();
  });
});

describe("Plotting tab: value-axis settings kept", () => {
  it("keeps them across a save and reopen and hands them to Layout; an older save loads with the defaults", () => {
    const onAddToLayout = vi.fn();
    mount(fixture(), onAddToLayout);
    act(() => radio("prop-value", 2).click());
    typeLimit("Value axis minimum", "12.5");
    act(() => labelled("Start at zero").click());
    act(() => labelled("Same axis in every panel").click());
    const saved = savedPlottingState();
    expect(saved).toMatchObject({ "prop.valueMin": 12.5, "prop.valueMax": null, "prop.valueFromZero": false, "prop.shareValueAxis": true });
    clearPersistedTabState();
    restorePlottingState(JSON.parse(JSON.stringify(saved)));
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS)).toMatchObject({ valueMin: 12.5, valueMax: null, valueFromZero: false, shareValueAxis: true });
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add to Layout")!.click());
    expect(onAddToLayout.mock.calls[0][0]).toMatchObject({ valueMin: 12.5, valueMax: null, valueFromZero: false, shareValueAxis: true });

    // Saved before these settings: the defaults; malformed values are dropped.
    clearPersistedTabState();
    restorePlottingState({ "prop.valueKind": "statistic" });
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS)).toMatchObject({ valueMin: null, valueMax: null, valueFromZero: true, shareValueAxis: null });
    clearPersistedTabState();
    restorePlottingState({ "prop.valueMin": "10", "prop.valueMax": Infinity, "prop.valueFromZero": 1, "prop.shareValueAxis": "yes" });
    expect(savedPlottingState()).toEqual({});
  });
});
