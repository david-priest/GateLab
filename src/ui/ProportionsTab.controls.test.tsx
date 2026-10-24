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
import { composeProportionsChartSvg, divisionWithinName, ProportionsTab, proportionsValueTitle } from "./ProportionsTab";
import { clearPersistedTabState, readPersistedTabValues } from "./tabState";

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

function render(fx: ReturnType<typeof fixture>, samples = fx.samples, onConfigChange?: () => void) {
  act(() =>
    root.render(
      <I18nProvider>
        <ProportionsTab
          samples={samples}
          activeSampleId="D1"
          state={fx.state}
          derived={recompute(samples[0].sample, fx.state)}
          metadata={{ D1: { donor: "D1" }, D2: { donor: "D2" }, D3: { donor: "D3" } }}
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
const plotType = (index: 0 | 1) => act(() => [...host.querySelectorAll<HTMLInputElement>('input[name="prop-type"]')][index].click());

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
    act(() => checkbox("D2.fcs").click());
    expect(readPersistedTabValues("prop.files")["prop.files"]).toEqual(["D1"]);
    render(fx, [...fx.samples, fx.extra]);
    expect(readPersistedTabValues("prop.files")["prop.files"]).toEqual(["D1", "D3"]);
    expect(checkbox("D3.fcs").checked).toBe(true);
    expect(checkbox("D2.fcs").checked).toBe(false);
  });

  it("takes a typed font size or height on Enter or leaving the field, not at the first keystroke", () => {
    const fx = fixture();
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
    expect(host.querySelectorAll("select")[1].disabled).toBe(true);
    // Boxplot: one value per unit always, points drawn.
    plotType(1);
    expect(checkbox("Average per unit").disabled).toBe(true);
    expect(host.querySelectorAll("select")[1].disabled).toBe(false);
    expect(checkbox("Show replicate points").disabled).toBe(false);
    expect(fieldInput("Point size").disabled).toBe(false);
    act(() => checkbox("Show replicate points").click());
    expect(fieldInput("Point size").disabled).toBe(true);
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
    const unit = host.querySelectorAll("select")[1];
    act(() => {
      unit.value = "donor";
      unit.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(paired().disabled).toBe(false);
    act(() => paired().click());
    expect(readPersistedTabValues("prop.paired")["prop.paired"]).toBe(true);
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
