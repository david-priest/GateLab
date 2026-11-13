// @vitest-environment jsdom
// The Plotting tab's named charts: the picker, New chart, Duplicate, Rename and Delete, and undo
// and redo. Synthetic samples D1 and D2 on one tree; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { workspacePlottingCharts } from "../engine/workspace";
import { BASE_PROPORTIONS_SETTINGS } from "../engine/proportionsSettings";
import { initialCoreState, recompute, type CoreState } from "../store";
import { I18nProvider } from "./i18n";
import { PlottingChartsTab } from "./PlottingCharts";
import {
  canUndoPlotting,
  clearPersistedTabState,
  openPlottingSettingsAsChart,
  plottingCharts,
  readPersistedTabValues,
  restorePlottingCharts,
} from "./tabState";

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
  clearPersistedTabState();
  vi.unstubAllGlobals();
});

function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const child = newPopulation("CD4_positive", [], rootPop.population_id);
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
  return { state: state as CoreState, samples: [sample("D1"), sample("D2")], childId: child.population_id };
}

function render(fx: ReturnType<typeof fixture>, onConfigChange?: () => void) {
  act(() =>
    root.render(
      <I18nProvider>
        <PlottingChartsTab
          samples={fx.samples}
          activeSampleId="D1"
          state={fx.state}
          derived={recompute(fx.samples[0].sample, fx.state)}
          metadata={{ D1: { donor: "D1" }, D2: { donor: "D2" } }}
          metadataColumns={[{ name: "donor" }]}
          divisionProfiles={{}}
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
const picker = () => host.querySelector<HTMLSelectElement>('select[aria-label="Chart"]')!;
const chartNames = () => [...picker().options].map((option) => option.textContent);
const held = (field: string) => readPersistedTabValues(`prop.${field}`)[`prop.${field}`];

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** A spinner click: a whole value, committed at once, with the field focused. */
function spin(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(init: KeyboardEventInit) {
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { cancelable: true, ...init })); });
}

describe("Plotting charts", () => {
  it("shows one chart named Chart 1 at the top of the side panel, which cannot be deleted", () => {
    render(fixture());
    const panel = host.querySelector(".gl-plotting-inspector")!;
    expect(panel.firstElementChild?.classList.contains("gl-plotting-charts")).toBe(true);
    expect(chartNames()).toEqual(["Chart 1"]);
    expect(button("Delete").disabled).toBe(true);
    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(true);
  });

  it("keeps each chart's settings: a new chart has the defaults, a duplicate the shown chart's, and switching is not a step", () => {
    const onConfigChange = vi.fn();
    render(fixture(), onConfigChange);
    act(() => checkbox("Grid lines").click());
    expect(held("grid")).toBe(false);
    act(() => button("New chart").click());
    expect(chartNames()).toEqual(["Chart 1", "Chart 2"]);
    expect(picker().value).toBe(picker().options[1].value);
    expect(checkbox("Grid lines").checked).toBe(true);
    expect(held("grid")).toBe(true);
    // Back to the first chart: its own setting, and no step for the switch.
    const steps = plottingCharts();
    choose(picker(), "chart-1");
    expect(checkbox("Grid lines").checked).toBe(false);
    act(() => button("Undo").click());
    // The undo took back the new chart, not the switch.
    expect(chartNames()).toEqual(["Chart 1"]);
    expect(steps.charts).toHaveLength(2);
    act(() => button("Redo").click());
    expect(chartNames()).toEqual(["Chart 1", "Chart 2"]);
    choose(picker(), "chart-1");
    act(() => button("Duplicate").click());
    expect(chartNames()).toEqual(["Chart 1", "Chart 1 copy", "Chart 2"]);
    expect(checkbox("Grid lines").checked).toBe(false);
    expect(button("Delete").disabled).toBe(false);
    expect(onConfigChange).toHaveBeenCalled();
  });

  it("starts a new workspace's chart and a new chart on the workspace figure style, and a chart saved before it on its own sizes", () => {
    // A new workspace, before the tab is opened, and once it is.
    expect(plottingCharts().charts[0].plotting["prop.followFigureStyle"]).toBe(true);
    render(fixture());
    expect(held("followFigureStyle")).toBe(true);
    act(() => button("New chart").click());
    expect(held("followFigureStyle")).toBe(true);
    // A workspace saved before the style: its chart keeps its own sizes, saved as such.
    restorePlottingCharts(workspacePlottingCharts({ plotting: { "prop.fontTick": 12 } }));
    expect(held("followFigureStyle")).toBe(false);
    expect(plottingCharts().charts[0].plotting).toEqual({ "prop.fontTick": 12, "prop.followFigureStyle": false });
  });

  it("renames and deletes the shown chart, each as one step", () => {
    render(fixture());
    act(() => button("New chart").click());
    act(() => button("Rename").click());
    const name = host.querySelector<HTMLInputElement>('input[aria-label="Chart name"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => { setter.call(name, "treated"); name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    act(() => name.blur());
    expect(chartNames()).toEqual(["Chart 1", "treated"]);
    act(() => button("Delete").click());
    expect(chartNames()).toEqual(["Chart 1"]);
    expect(button("Delete").disabled).toBe(true);
    act(() => button("Undo").click());
    expect(chartNames()).toEqual(["Chart 1", "treated"]);
    expect(picker().selectedOptions[0].textContent).toBe("treated");
    act(() => button("Undo").click());
    expect(chartNames()).toEqual(["Chart 1", "Chart 2"]);
  });

  it("undoes and redoes each setting change, by the buttons and by Cmd-Z and Shift-Cmd-Z", () => {
    render(fixture());
    act(() => checkbox("Grid lines").click());
    act(() => checkbox("Show legend").click());
    expect([held("grid"), held("legend")]).toEqual([false, false]);
    act(() => button("Undo").click());
    expect([held("grid"), held("legend")]).toEqual([false, true]);
    expect(checkbox("Show legend").checked).toBe(true);
    // The app's own listener, which undoes the last gating edit, does not get the key.
    const appUndo = vi.fn();
    window.addEventListener("keydown", appUndo);
    key({ key: "z", metaKey: true });
    window.removeEventListener("keydown", appUndo);
    expect(appUndo).not.toHaveBeenCalled();
    expect([held("grid"), held("legend")]).toEqual([true, true]);
    expect(button("Undo").disabled).toBe(true);
    key({ key: "z", metaKey: true, shiftKey: true });
    expect(held("grid")).toBe(false);
    act(() => button("Redo").click());
    expect(held("legend")).toBe(false);
    expect(button("Redo").disabled).toBe(true);
  });

  it("takes a run of changes to one number field as one step, and a change to another field as the next", () => {
    // A chart at its own text sizes, as one saved before the figure style is.
    restorePlottingCharts(workspacePlottingCharts({}));
    render(fixture());
    act(() => button("Style").click());
    const tick = fieldInput("Tick");
    spin(tick, "10");
    spin(tick, "11");
    spin(tick, "12");
    expect(held("fontTick")).toBe(12);
    const axis = fieldInput("Axis");
    spin(axis, "11");
    expect(held("fontAxis")).toBe(11);
    act(() => button("Undo").click());
    expect([held("fontTick"), held("fontAxis")]).toEqual([12, 10]);
    act(() => button("Undo").click());
    expect(held("fontTick")).toBe(9);
    expect(button("Undo").disabled).toBe(true);
  });

  it("opens a workspace's charts showing the one it was saved on, and a Layout block as a new chart", () => {
    const fx = fixture();
    restorePlottingCharts(workspacePlottingCharts({
      plottingCharts: {
        activeId: "chart-b",
        charts: [
          { id: "chart-a", name: "control", plotting: { "prop.grid": false } },
          { id: "chart-b", name: "treated", plotting: { "prop.legend": false } },
        ],
      },
    }));
    // Opened from the Layout tab before the Plotting tab is shown.
    openPlottingSettingsAsChart({ ...BASE_PROPORTIONS_SETTINGS, files: ["D1"], selectedPops: [fx.childId], points: false }, "treated");
    expect(canUndoPlotting()).toBe(true);
    render(fx);
    expect(chartNames()).toEqual(["control", "treated", "treated (2)"]);
    expect(picker().selectedOptions[0].textContent).toBe("treated (2)");
    expect(held("files")).toEqual(["D1"]);
    choose(picker(), "chart-b");
    expect(checkbox("Show legend").checked).toBe(false);
    expect(checkbox("Grid lines").checked).toBe(true);
    // Undo takes back the chart the Layout block made; the one it was opened over is untouched.
    act(() => button("Undo").click());
    expect(chartNames()).toEqual(["control", "treated"]);
    expect(picker().value).toBe("chart-b");
    expect(held("legend")).toBe(false);
  });
});
