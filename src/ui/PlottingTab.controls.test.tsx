// @vitest-environment jsdom
// The Plotting tab's controls: what each does in each mode, and when the workspace is marked unsaved.
// Synthetic samples D1, D2 and D3 on one tree; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { I18nProvider } from "./i18n";
import { composeProportionsChartSvg, divisionWithinName, PlottingTab, proportionsValueTitle } from "./PlottingTab";
import { clearPersistedTabState, readPersistedTabValues, readProportionsSettings, restorePlottingState } from "./tabState";
import { BASE_PROPORTIONS_SETTINGS } from "../engine/proportionsSettings";

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

function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const child = newPopulation("Lymphocytes", [], rootPop.population_id);
  rootPop.children = [child.population_id];
  Object.assign(state, {
    populations: { [rootPop.population_id]: rootPop, [child.population_id]: child },
    root_population_id: rootPop.population_id,
    active_population_id: rootPop.population_id,
  });
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: 3,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([10, 20, 30]), Float32Array.from([30, 20, 10])],
  };
  const sample = (id: string) => ({ id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) });
  return { state: state as CoreState, samples: [sample("D1"), sample("D2")], extra: sample("D3"), childId: child.population_id };
}

function render(
  fx: ReturnType<typeof fixture>,
  samples = fx.samples,
  onConfigChange?: () => void,
  divisionProfiles: Record<string, { channelKey: string; boundaries: number[]; n: number }> = {},
) {
  act(() =>
    root.render(
      <I18nProvider>
        <PlottingTab
          samples={samples}
          activeSampleId="D1"
          state={fx.state}
          derived={recompute(samples[0].sample, fx.state)}
          metadata={{ D1: { donor: "D1" }, D2: { donor: "D2" }, D3: { donor: "D3" } }}
          metadataColumns={[{ name: "donor" }]}
          divisionProfiles={divisionProfiles}
          dataRevisionKey="r1"
          onConfigChange={onConfigChange}
        />
      </I18nProvider>,
    ),
  );
}

const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
const checkbox = (label: string) =>
  [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.trim() === label)!.querySelector("input")!;
const fieldInput = (label: string) =>
  [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.trim().startsWith(label))!.querySelector("input")!;
const unitSelect = () =>
  [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.trim().startsWith("Replicate unit"))!.querySelector("select")!;
const plotType = (index: 0 | 1 | 2 | 3) => act(() => [...host.querySelectorAll<HTMLInputElement>('input[name="prop-type"]')][index].click());

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    input.focus();
    setter.call(input, value);
    // Typing carries an inputType, as a keyboard does; a spinner's input event does not.
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  });
}

describe("Plotting tab controls", () => {
  it("does not mark the workspace unsaved when it opens, only when a setting changes", () => {
    const fx = fixture();
    const onConfigChange = vi.fn();
    render(fx, fx.samples, onConfigChange);
    expect(onConfigChange).not.toHaveBeenCalled();
    act(() => checkbox("Grid lines").click());
    expect(onConfigChange).toHaveBeenCalledTimes(1);
  });

  it("draws a file added to the workspace while the tab is open, and keeps an unticked file unticked", () => {
    const fx = fixture();
    render(fx);
    // A file's row shows its values in the metadata columns in use after its name.
    const fileBox = (name: string) =>
      [...host.querySelectorAll<HTMLLabelElement>(".gl-plotting-filelist label")].find((l) => l.querySelector(".gl-figure-row-name")?.textContent === name)!.querySelector("input")!;
    act(() => fileBox("D2.fcs").click());
    expect(readPersistedTabValues("prop.files")["prop.files"]).toEqual(["D1"]);
    render(fx, [...fx.samples, fx.extra]);
    expect(readPersistedTabValues("prop.files")["prop.files"]).toEqual(["D1", "D3"]);
    expect(fileBox("D3.fcs").checked).toBe(true);
    expect(fileBox("D2.fcs").checked).toBe(false);
  });

  it("takes a typed font size or height on Enter or leaving the field, not at the first keystroke", () => {
    const fx = fixture();
    // A chart at its own text sizes, as one saved before the figure style is.
    restorePlottingState({ "prop.followFigureStyle": false });
    render(fx);
    const tick = fieldInput("Tick");
    type(tick, "1");
    expect(readPersistedTabValues("prop.fontTick")["prop.fontTick"]).toBe(9);
    type(tick, "12");
    act(() => tick.blur());
    expect(readPersistedTabValues("prop.fontTick")["prop.fontTick"]).toBe(12);
    const height = fieldInput("Plot height");
    type(height, "3");
    type(height, "360");
    act(() => height.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(readPersistedTabValues("prop.height")["prop.height"]).toBe(360);
  });

  it("offers each control only in the chart type it changes", () => {
    const fx = fixture();
    render(fx);
    // Stacked: averaging applies, points do not; a pooled bar has no replicate units.
    expect(checkbox("Average per unit").disabled).toBe(false);
    expect(checkbox("Show replicate points").disabled).toBe(true);
    expect(fieldInput("Point size").disabled).toBe(true);
    act(() => checkbox("Average per unit").click());
    expect(unitSelect().disabled).toBe(true);
    // Boxplot: one value per unit always, points drawn.
    plotType(1);
    expect(checkbox("Average per unit").disabled).toBe(true);
    expect(unitSelect().disabled).toBe(false);
    expect(checkbox("Show replicate points").disabled).toBe(false);
    expect(fieldInput("Point size").disabled).toBe(false);
    act(() => checkbox("Show replicate points").click());
    expect(fieldInput("Point size").disabled).toBe(true);
  });

  it("disables the palette where colour stands for populations, which take their own colours", () => {
    const fx = fixture();
    render(fx);
    const palette = () => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.trim().startsWith("Palette"))!.querySelector("select")!;
    const hint = "Population colours are set in the population tree";
    // Stacked: each population is a category in its own colour.
    expect(palette().disabled).toBe(true);
    expect(host.textContent).toContain(hint);
    // Boxplot: colour stands for the groups, which take the palette.
    plotType(1);
    expect(palette().disabled).toBe(false);
    expect(host.textContent).not.toContain(hint);
  });

  it("offers paired lines only on a boxplot whose replicate unit can sit in two groups, off by default", () => {
    const fx = fixture();
    render(fx);
    const paired = () => checkbox("Join each unit across groups");
    expect(paired().checked).toBe(false);
    expect(paired().disabled).toBe(true);
    plotType(1);
    // Each file its own unit: no unit is in two groups.
    expect(paired().disabled).toBe(true);
    const unit = unitSelect();
    act(() => {
      unit.value = "donor";
      unit.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(paired().disabled).toBe(false);
    act(() => paired().click());
    expect(readPersistedTabValues("prop.paired")["prop.paired"]).toBe(true);
  });

  it("writes n under the marks with Show n, off by default, and keeps it in the saved settings", () => {
    const fx = fixture();
    render(fx);
    const showN = () => checkbox("Show n");
    expect(showN().checked).toBe(false);
    plotType(1);
    expect(host.querySelectorAll("#gl-prop-svg .gl-prop-n")).toHaveLength(0);
    act(() => showN().click());
    expect(readPersistedTabValues("prop.showN")["prop.showN"]).toBe(true);
    // A box per file, each file its own unit: n = 1 under each, and the axis says what n counts.
    expect([...host.querySelectorAll("#gl-prop-svg .gl-prop-n")].map((n) => n.textContent)).toEqual(["n = 1", "n = 1", "n = 1", "n = 1"]);
    expect(host.querySelector("#gl-prop-svg")?.textContent).toContain("n: files");
    clearPersistedTabState();
    restorePlottingState({ "prop.showN": true, "prop.legend": "x" });
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS).showN).toBe(true);
  });

  it("says what is missing when there is nothing to draw", () => {
    const fx = fixture();
    render(fx);
    act(() => button("None").click());
    expect(host.querySelector(".gl-tab-empty")?.textContent).toContain("No file is ticked");
    act(() => button("All").click());
    const populationNone = [...host.querySelectorAll<HTMLButtonElement>(".gl-plotting-populations button")].find((b) => b.textContent?.trim() === "None")!;
    act(() => populationNone.click());
    expect(host.querySelector(".gl-tab-empty")?.textContent).toContain("No population is ticked");
  });

  it("changes the parent with an explicit control above the tree, then offers the parent's descendants", () => {
    const fx = fixture();
    render(fx);
    const section = () => host.querySelector<HTMLElement>(".gl-plotting-populations")!;
    const rootName = fx.state.populations[fx.state.root_population_id!].name;
    expect(section().querySelector(".gl-plotting-parent")!.textContent).toBe(`Parent: ${rootName}Change`);
    // The parent's descendants as the shared population picker, each with its tick.
    const rows = () => [...section().querySelectorAll<HTMLElement>(".gl-strategy-pop-row")];
    expect(rows().map((row) => row.title)).toEqual(["Lymphocytes"]);
    expect(rows()[0].querySelector<HTMLInputElement>("input[type=checkbox]")!.checked).toBe(true);
    act(() => rows()[0].querySelector<HTMLInputElement>("input")!.click());
    expect(readPersistedTabValues("prop.selectedPops")["prop.selectedPops"]).toEqual([]);
    // Change: the whole tree, a click picks the parent; its children are ticked, as clicking a name did.
    act(() => [...section().querySelectorAll<HTMLButtonElement>(".gl-plotting-parent button")][0].click());
    expect(rows().map((row) => [row.tagName, row.textContent, row.getAttribute("aria-pressed")])).toEqual([
      ["BUTTON", rootName, "true"],
      ["BUTTON", "Lymphocytes", "false"],
    ]);
    act(() => (rows()[1] as HTMLButtonElement).click());
    expect(readPersistedTabValues("prop.parent")["prop.parent"]).toBe(fx.childId);
    expect(readPersistedTabValues("prop.selectedPops")["prop.selectedPops"]).toEqual([]);
    expect(section().querySelector(".gl-plotting-parent")!.textContent).toBe("Parent: LymphocytesChange");
    expect(rows()).toHaveLength(0);
    expect(section().textContent).toContain("This population has nothing beneath it to compose.");
  });

  it("puts the population picker in the left panel under the files, with no populations pane on the right", () => {
    const fx = fixture();
    render(fx);
    const inspector = host.querySelector<HTMLElement>('aside[aria-label="Plotting controls"]')!;
    const section = inspector.querySelector<HTMLElement>('section[aria-label="Populations"]')!;
    expect(section).not.toBeNull();
    expect(section.classList.contains("gl-plotting-populations")).toBe(true);
    // Under the file list, above the settings.
    expect(section.previousElementSibling?.classList.contains("gl-plotting-files")).toBe(true);
    expect(host.querySelector('aside[aria-label="Populations"]')).toBeNull();
    expect(host.querySelector(".gl-plotting-inspector-right")).toBeNull();
    expect(host.querySelector(".gl-plotting-workspace")!.classList.contains("pane-populations")).toBe(false);
    // Ticking a population there redraws the chart and saves the same state as before.
    const marks = () => host.querySelectorAll("#gl-prop-svg .gl-prop-mark").length;
    expect(marks()).toBeGreaterThan(0);
    const tick = () => section.querySelector<HTMLInputElement>(".gl-strategy-pop-row input[type=checkbox]")!;
    act(() => tick().click());
    expect(readPersistedTabValues("prop.selectedPops")["prop.selectedPops"]).toEqual([]);
    expect(host.querySelector(".gl-tab-empty")?.textContent).toContain("No population is ticked");
    act(() => tick().click());
    expect(readPersistedTabValues("prop.selectedPops")["prop.selectedPops"]).toEqual([fx.childId]);
    expect(marks()).toBeGreaterThan(0);
  });

  it("draws the Population / Division choice only when a division profile can be chosen", () => {
    const fx = fixture();
    const categoryRadios = () => host.querySelectorAll<HTMLInputElement>('input[name="prop-cat"]');
    render(fx);
    expect(categoryRadios()).toHaveLength(0);
    expect([...host.querySelectorAll("label")].some((l) => l.textContent?.trim() === "Division")).toBe(false);
    const channelKey = fx.samples[0].sample.channels[0].key;
    const profiles = { D1: { channelKey, boundaries: [15], n: 1 }, D2: { channelKey, boundaries: [15], n: 1 } };
    render(fx, fx.samples, undefined, profiles);
    expect([...categoryRadios()].map((r) => [r.closest("label")!.textContent?.trim(), r.disabled])).toEqual([
      ["Population", false],
      ["Division", false],
    ]);
    // A per-cell or statistic chart cannot draw divisions: no choice is drawn.
    const valueRadio = (index: number) => host.querySelectorAll<HTMLInputElement>('input[name="prop-value"]')[index];
    act(() => valueRadio(1).click());
    expect(categoryRadios()).toHaveLength(0);
    act(() => valueRadio(2).click());
    expect(categoryRadios()).toHaveLength(0);
    act(() => valueRadio(0).click());
    expect(categoryRadios()).toHaveLength(2);
  });

  it("names what each value choice draws", () => {
    const fx = fixture();
    render(fx);
    expect([...host.querySelectorAll<HTMLInputElement>('input[name="prop-value"]')].map((r) => r.closest("label")!.textContent?.trim())).toEqual([
      "Proportions",
      "Channel per cell (violins, boxes)",
      "Channel statistic per sample (points, bars)",
    ]);
  });

  it("names what a percentage is of on the value axis", () => {
    const fx = fixture();
    render(fx);
    expect(host.querySelector("#gl-prop-svg")?.textContent).toContain("% of all events");
    expect(proportionsValueTitle("population", "Lymphocytes", true)).toBe("% of Lymphocytes");
    expect(proportionsValueTitle("population", "Lymphocytes", false)).toBe("% of the populations shown in Lymphocytes");
    expect(proportionsValueTitle("population", null, false)).toBe("% of the populations shown");
    // A division chart is a percentage of the population its profiles were fitted in.
    expect(proportionsValueTitle("division", divisionWithinName(["Lymphocytes"]), true)).toBe("% of Lymphocytes");
    expect(proportionsValueTitle("division", divisionWithinName([null]), true)).toBe("% of all events");
    expect(proportionsValueTitle("division", divisionWithinName(["Lymphocytes", null]), true)).toBe("% of the population each file's division was fitted in");
  });

  it("exports the chart without a legend highlight", () => {
    const fx = fixture();
    render(fx);
    // Highlight the rest of the parent, so the population is drawn faded.
    const item = [...host.querySelectorAll<HTMLButtonElement>(".gl-prop-legend-item")].find((entry) => entry.textContent === "ungated")!;
    act(() => item.click());
    expect([...host.querySelectorAll("#gl-prop-svg .gl-prop-mark")].some((mark) => mark.getAttribute("opacity") === "0.16")).toBe(true);
    const composed = composeProportionsChartSvg("gl-prop-svg")!;
    const marks = [...composed.root.querySelectorAll(".gl-prop-mark, .gl-prop-mark-group")];
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((mark) => !mark.hasAttribute("opacity"))).toBe(true);
  });
});

describe("Plotting tab: the value of a boxplot, bars or points", () => {
  it("offers % of parent, % of total and events for the boxplot, bars and points, not the stacked bar", () => {
    const fx = fixture();
    render(fx);
    const value = () => [...host.querySelectorAll<HTMLSelectElement>('select[aria-label="Value"]')][0];
    const test = () => checkbox("Rank test between groups");
    expect([...value().options].map((o) => o.textContent)).toEqual(["% of parent", "% of total", "Count"]);
    expect(value().disabled).toBe(true);
    expect(test().disabled).toBe(true);
    plotType(1);
    expect(value().disabled).toBe(false);
    expect(test().disabled).toBe(false);
    act(() => {
      value().value = "count";
      value().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(readPersistedTabValues("prop.proportionValue")["prop.proportionValue"]).toBe("count");
    // Each file's three events, on an axis of events.
    expect(host.querySelector("#gl-prop-svg")?.textContent).toContain("Events");
    expect([...host.querySelectorAll("#gl-prop-svg title")].map((t) => t.textContent)).toContain("Lymphocytes · D1: median 3 events, n = 1");
    // Bars: an error bar to choose, and points to show.
    plotType(2);
    expect(host.querySelector('select[aria-label="Error bar"]')).not.toBeNull();
    expect(checkbox("Show replicate points").disabled).toBe(false);
    // A panel for Lymphocytes and one for ungated, a bar per donor in each.
    expect(host.querySelectorAll("#gl-prop-svg rect.gl-prop-mark")).toHaveLength(4);
    // Points: always drawn.
    plotType(3);
    expect(checkbox("Show replicate points").disabled).toBe(true);
    expect(host.querySelectorAll("#gl-prop-svg circle.gl-prop-point")).toHaveLength(4);
  });
});
