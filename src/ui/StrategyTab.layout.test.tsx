// @vitest-environment jsdom
// The Strategy tab sends its strip, or one of its plots, to the Layout tab, and opens a step on
// the Gating tab, from a button and from the grid's right-click menu.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrategyTab } from "./StrategyTab";
import { I18nProvider } from "./i18n";
import { initialCoreState, type CoreState, type Derived } from "../store";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import type { FigureSample } from "../engine/figure";

const renderer = vi.hoisted(() => ({
  renderStrategyGrid: vi.fn(),
  renderMultiStrategyGrid: vi.fn(),
}));
vi.mock("../plots/loadPlots", () => ({ loadMiniPlots: () => renderer }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  // The renderer stands in for mini_plot: one cell per step, keyed by its gate as the real grid keys them.
  renderer.renderStrategyGrid.mockImplementation((containerId: string, payload: { steps: { gate_id: string }[] }) => {
    const container = document.getElementById(containerId)!;
    container.replaceChildren();
    for (const step of payload.steps) {
      const cell = document.createElement("div");
      cell.className = "mini-plot-cell";
      cell.dataset.plotKey = step.gate_id;
      container.appendChild(cell);
    }
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await vi.runAllTimersAsync(); });
}

/** All Events › Lymphocytes (FSC-A/SSC-A) › B cells (CD19/CD3): a two-step path. */
function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const lymph = newPopulation("Lymphocytes", [], rootPop.population_id);
  const lymphGate = newGate("Lymph_gate", "rectangle", "FSC-A", "SSC-A", [[0, 0], [15, 35]]);
  lymph.gate_refs = [{ gate_id: lymphGate.gate_id, include: true }];
  const bcells = newPopulation("B cells", [], lymph.population_id);
  const bGate = newGate("B_gate", "rectangle", "CD19", "CD3", [[5, 0], [40, 20]]);
  bcells.gate_refs = [{ gate_id: bGate.gate_id, include: true }];
  rootPop.children = [lymph.population_id];
  lymph.children = [bcells.population_id];
  Object.assign(state, {
    gates: { [lymphGate.gate_id]: lymphGate, [bGate.gate_id]: bGate },
    gate_order: [lymphGate.gate_id, bGate.gate_id],
    populations: { [rootPop.population_id]: rootPop, [lymph.population_id]: lymph, [bcells.population_id]: bcells },
    root_population_id: rootPop.population_id,
    active_population_id: bcells.population_id,
    active_hierarchy_id: DEFAULT_HIERARCHY_ID,
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
      { index: 2, name: "CD19", marker: null, bits: 32, range: 262144 },
      { index: 3, name: "CD3", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([10, 20, 30]), Float32Array.from([30, 20, 10]), Float32Array.from([10, 20, 30]), Float32Array.from([5, 10, 15])],
  };
  const files: FigureSample[] = [{ id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) }];
  return { state, files, rootId: rootPop.population_id, lymphId: lymph.population_id, bcellsId: bcells.population_id, lymphGateId: lymphGate.gate_id, bGateId: bGate.gate_id };
}

const menuItems = () => [...host.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
const menuItem = (label: string) => menuItems().find((b) => b.textContent === label);
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);

describe("the Strategy tab and the Layout tab", () => {
  it("sends the strip from the button, and from the right-click menu the strip, a step's plot or the step to the Gating tab", async () => {
    const fx = fixture();
    const onAddToLayout = vi.fn();
    const onOpenStep = vi.fn();
    act(() => root.render(
      <I18nProvider>
        <StrategyTab
          state={fx.state as CoreState}
          sample={fx.files[0].sample}
          sampleName="D1.fcs"
          derived={{ masks: {} } as Derived}
          globalScales={{}}
          configRef={{ current: null }}
          dataRevision={0}
          densityColorPower={1}
          onDensityColorPowerChange={vi.fn()}
          onFitChannels={vi.fn()}
          files={fx.files}
          poolIds={null}
          poolable={false}
          onPoolChange={vi.fn()}
          activeSampleId="D1"
          onAddToLayout={onAddToLayout}
          onOpenStep={onOpenStep}
        />
      </I18nProvider>,
    ));
    await flush();
    // Full path from root is off by default: the strip is the population's own gate.
    expect(host.querySelectorAll(".mini-plot-cell")).toHaveLength(1);
    act(() => button("Add to Layout")!.click());
    expect(onAddToLayout).toHaveBeenLastCalledWith({ kind: "strategy", sampleId: "D1", populationId: fx.bcellsId, fullPath: false, displayMode: "pseudocolor" });

    // The full path: two steps, and a right-click on the second offers that step's plot and the Gating tab.
    const fullPath = [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("Full path from root"))!.querySelector("input")!;
    act(() => fullPath.click());
    await flush();
    const cells = host.querySelectorAll<HTMLElement>(".mini-plot-cell");
    expect(cells).toHaveLength(2);
    act(() => { cells[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); });
    expect(menuItems().map((b) => b.textContent)).toEqual([
      "Add the strategy to the Layout tab", "Add this plot to the Layout tab", "Show this step on the Gating tab", "Fit data + gates", "Export PNG", "Export SVG", "Export PDF",
    ]);
    // The second step shows the lymphocytes on the B cell gate's channels.
    act(() => menuItem("Add this plot to the Layout tab")!.click());
    expect(onAddToLayout).toHaveBeenLastCalledWith({ kind: "biplot", sampleId: "D1", populationId: fx.lymphId, xChannel: "CD19", yChannel: "CD3", displayMode: "pseudocolor" });
    expect(menuItems()).toHaveLength(0);
    act(() => { cells[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); });
    act(() => menuItem("Show this step on the Gating tab")!.click());
    expect(onOpenStep).toHaveBeenCalledWith(fx.lymphId, "CD19", "CD3");
    // The strip from the menu carries the full path now.
    act(() => { cells[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); });
    act(() => menuItem("Add the strategy to the Layout tab")!.click());
    expect(onAddToLayout).toHaveBeenLastCalledWith({ kind: "strategy", sampleId: "D1", populationId: fx.bcellsId, fullPath: true, displayMode: "pseudocolor" });
    // Away from a cell, the menu offers the strip and the exports but no step.
    act(() => { host.querySelector<HTMLElement>("#strategy-grid-container")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); });
    expect(menuItems().map((b) => b.textContent)).toEqual(["Add the strategy to the Layout tab", "Fit data + gates", "Export PNG", "Export SVG", "Export PDF"]);
  });

  it("offers the strategy of several populations as one Layout block, arrows and layout included", async () => {
    const fx = fixture();
    const onAddToLayout = vi.fn();
    act(() => root.render(
      <I18nProvider>
        <StrategyTab
          state={fx.state as CoreState}
          sample={fx.files[0].sample}
          sampleName="D1.fcs"
          derived={{ masks: {} } as Derived}
          globalScales={{}}
          configRef={{ current: null }}
          dataRevision={0}
          densityColorPower={1}
          onDensityColorPowerChange={vi.fn()}
          onFitChannels={vi.fn()}
          files={fx.files}
          poolIds={null}
          poolable={false}
          onPoolChange={vi.fn()}
          activeSampleId="D1"
          onAddToLayout={onAddToLayout}
        />
      </I18nProvider>,
    ));
    await flush();
    const multi = [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("Multiple pops"))!.querySelector("input")!;
    act(() => multi.click());
    await flush();
    // Nothing chosen yet: nothing to add.
    expect(button("Add to Layout")!.disabled).toBe(true);
    expect(button("Add to Layout")!.title).toContain("Choose populations first");
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".gl-strategy-pops button")].find((b) => b.textContent === "Leaves")!.click());
    await flush();
    expect(button("Add to Layout")!.disabled).toBe(false);
    act(() => button("Add to Layout")!.click());
    // The block as drawn here: the panel size, the layout, the arrows and the appearance travel
    // with it, and its frame is the grid's own size (one leaf: a 1 × 1 grid of 200 px, the
    // gutter on its right and below it that the arrows run in, and its title).
    expect(onAddToLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "strategy", sampleId: "D1", populationId: fx.bcellsId, fullPath: true, displayMode: "pseudocolor",
        populationIds: [fx.bcellsId], layout: "tree", columns: 4, showArrows: true, arrowWidth: 1.5, title: "{sample}",
        plotSize: 200, labelBackground: 0.6,
        style: expect.objectContaining({ pointSize: 1.2, pointAlpha: 0.35, contourLevels: 10, pubStyle: false, fontGate: 12 }),
      }),
      { width: 244, height: 270 },
    );
  });
});
