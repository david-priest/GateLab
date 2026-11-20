// @vitest-environment jsdom
// The Plotting chart's right-click menu: the chart, the panel under the pointer or every panel to
// the Layout tab, and the exports. Synthetic files D1 and D2 (control, treated); nothing here is a
// real experiment.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { I18nProvider } from "./i18n";
import { PlottingTab } from "./PlottingTab";
import { clearPersistedTabState } from "./tabState";

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
  const small = { ...newGate("Small", "rectangle", "FSC-A", "SSC-A", [[0, 0], [25, 1000]]), space: "raw" as const };
  const smallPop = newPopulation("CD4_positive", [newGateRef(small.gate_id)], rootPop.population_id);
  rootPop.children = [smallPop.population_id];
  Object.assign(state, {
    gates: { [small.gate_id]: small },
    gate_order: [small.gate_id],
    populations: { [rootPop.population_id]: rootPop, [smallPop.population_id]: smallPop },
    root_population_id: rootPop.population_id,
    active_population_id: rootPop.population_id,
  });
  const file = (id: string, fsc: number[]) => {
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
  return { state: state as CoreState, samples: [file("D1", [10, 20, 30]), file("D2", [15, 18, 35])] };
}

function mount(fx: ReturnType<typeof fixture>, callbacks: Record<string, unknown>) {
  act(() =>
    root.render(
      <I18nProvider>
        <PlottingTab
          samples={fx.samples}
          activeSampleId="D1"
          state={fx.state}
          derived={recompute(fx.samples[0].sample, fx.state)}
          metadata={{ D1: { condition: "control" }, D2: { condition: "treated" } }}
          metadataColumns={[{ name: "condition" }]}
          divisionProfiles={{}}
          dataRevisionKey="r1"
          {...callbacks}
        />
      </I18nProvider>,
    ),
  );
}

const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('.gl-context-menu [role="menuitem"]')].map((b) => b.textContent);
function callbacks() {
  return { onAddToLayout: vi.fn(), onAddPanelsToLayout: vi.fn(), onAddPagesToLayout: vi.fn(), onAddPanelPagesToLayout: vi.fn() };
}

const rightClick = (target: Element) =>
  act(() => {
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
  });
const menuButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.gl-context-menu [role="menuitem"]')].find((b) => b.textContent === text)!;

describe("Plotting: the chart's right-click menu", () => {
  it("offers the chart, the panel under the pointer and every panel to Layout, then the exports", () => {
    const fx = fixture();
    const on = callbacks();
    mount(fx, on);
    // A per-cell chart, a panel per file.
    act(() => [...host.querySelectorAll<HTMLInputElement>('input[name="prop-value"]')][1].click());
    const panels = [...host.querySelectorAll(".gl-prop-panels svg.gl-prop-panel")];
    expect(panels).toHaveLength(2);
    rightClick(panels[1]);
    expect(menuItems()).toEqual(["Add the chart to Layout", "Add this panel to Layout", "Add panels to Layout", "Export PNG", "Export SVG", "Export PDF", "Export the data (CSV)"]);
    act(() => menuButton("Add this panel to Layout").click());
    expect(on.onAddToLayout).toHaveBeenCalledTimes(1);
    // The panel sent is the second of the blocks "Add panels" sends, as drawn.
    act(() => button("Add panels to Layout")!.click());
    const blocks = on.onAddPanelsToLayout.mock.calls[0][1];
    expect(on.onAddToLayout.mock.calls[0][1]).toEqual(blocks[1].panel);
    expect(on.onAddToLayout.mock.calls[0][1]).not.toEqual(blocks[0].panel);
    // The menu closes on a choice; on the chart outside a panel there is no panel to offer.
    expect(menuItems()).toEqual([]);
    rightClick(host.querySelector(".gl-prop-chart")!);
    expect(menuItems()).not.toContain("Add this panel to Layout");
    act(() => menuButton("Add the chart to Layout").click());
    expect(on.onAddToLayout).toHaveBeenCalledTimes(2);
    expect(on.onAddToLayout.mock.calls[1][1]).toBeUndefined();
  });

  it("offers only the exports with no Layout tab, and nothing outside the chart", () => {
    const fx = fixture();
    mount(fx, {});
    rightClick(host.querySelector(".gl-prop-chart")!);
    expect(menuItems()).toEqual(["Export PNG", "Export SVG", "Export PDF", "Export the data (CSV)"]);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(menuItems()).toEqual([]);
    rightClick(host.querySelector(".gl-plotting-inspector")!);
    expect(menuItems()).toEqual([]);
  });
});
