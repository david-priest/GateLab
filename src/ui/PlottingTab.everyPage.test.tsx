// @vitest-environment jsdom
// The Plotting tab's header buttons with a chart of several pages: "This page" or "Every page,
// one sheet each". Synthetic files D1 and D2 (control, treated); nothing here is a real experiment.
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
const labelled = (text: string) =>
  [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.trim().startsWith(text))!.querySelector("input, select") as HTMLSelectElement;
const choose = (label: string, value: string) =>
  act(() => {
    const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`) ?? labelled(label);
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
/** A per-cell chart, a panel per condition, a page per file. */
function pageByFile() {
  act(() => [...host.querySelectorAll<HTMLInputElement>('input[name="prop-value"]')][1].click());
  choose("Facet", "__sample__");
  choose("Place Files", "pages");
}

function callbacks() {
  return { onAddToLayout: vi.fn(), onAddPanelsToLayout: vi.fn(), onAddPagesToLayout: vi.fn(), onAddPanelPagesToLayout: vi.fn() };
}

describe("Plotting: sending a chart of several pages to Layout", () => {
  it("acts at once with no pages, as before", () => {
    const fx = fixture();
    const on = callbacks();
    mount(fx, on);
    act(() => button("Add to Layout")!.click());
    act(() => button("Add panels to Layout")!.click());
    expect(menuItems()).toEqual([]);
    expect(on.onAddToLayout).toHaveBeenCalledTimes(1);
    expect(on.onAddPanelsToLayout).toHaveBeenCalledTimes(1);
  });

  it("Add to Layout: This page names the page shown; Every page sends each page with the pager's label", () => {
    const fx = fixture();
    const on = callbacks();
    mount(fx, on);
    pageByFile();
    act(() => button("Next")!.click());
    act(() => button("Add to Layout")!.click());
    expect(menuItems()).toEqual(["This page", "Every page, one sheet each (2)"]);
    act(() => button("This page")!.click());
    expect(on.onAddToLayout).toHaveBeenCalledTimes(1);
    expect(on.onAddToLayout.mock.calls[0][1]).toEqual({ page: "D2.fcs" });
    act(() => button("Add to Layout")!.click());
    act(() => button("Every page, one sheet each (2)")!.click());
    expect(on.onAddPagesToLayout).toHaveBeenCalledTimes(1);
    const [settings, pages] = on.onAddPagesToLayout.mock.calls[0];
    expect(settings.pageBy).toBe("facet");
    expect(pages).toEqual([{ label: "File: D1.fcs", page: "D1.fcs" }, { label: "File: D2.fcs", page: "D2.fcs" }]);
  });

  it("Add panels to Layout: Every page sends each page's panel blocks", () => {
    const fx = fixture();
    const on = callbacks();
    mount(fx, on);
    pageByFile();
    act(() => button("Add panels to Layout")!.click());
    act(() => button("Every page, one sheet each (2)")!.click());
    expect(on.onAddPanelsToLayout).not.toHaveBeenCalled();
    const [, pages] = on.onAddPanelPagesToLayout.mock.calls[0];
    expect(pages.map((page: { label: string; blocks: { panel: { facet?: string; group?: string } }[] }) => [page.label, page.blocks.map(({ panel }) => [panel.facet, panel.group])])).toEqual([
      ["File: D1.fcs", [["D1.fcs", "control"], ["D1.fcs", "treated"]]],
      ["File: D2.fcs", [["D2.fcs", "control"], ["D2.fcs", "treated"]]],
    ]);
  });
});
