// @vitest-environment jsdom
// The Strategy tab sends its strip, or one of its plots, to the Layout tab, and opens a step on
// the Gating tab, from a button and from the grid's right-click menu.
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRATEGY_PAGE_PADDING, StrategyTab, type StrategyConfig } from "./StrategyTab";
import { clearPersistedTabState } from "./tabState";
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
  clearPersistedTabState();
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
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button:not(.gl-menu-trigger)")].find((b) => b.textContent?.trim() === label);

describe("the Strategy tab's draw", () => {
  // Reported from GateLabR as the cursor flickering over a strategy: the grid was drawn again
  // whenever anything else in the app changed, because the label handler, which the caller
  // makes anew at every render of its own, was a dependency of the draw.
  it("is not repeated when the caller re-renders with nothing the strategy draws changed", async () => {
    const fx = fixture();
    // What the strategy is drawn from is held as the app holds it, the same from one render to
    // the next; only the handler is new.
    const derived = { masks: {} } as Derived;
    const globalScales = {};
    const configRef = { current: null };
    const tab = (onGateLabelMove: () => void) => (
      <I18nProvider>
        <StrategyTab
          state={fx.state as CoreState}
          sample={fx.files[0].sample}
          sampleName="D1.fcs"
          derived={derived}
          globalScales={globalScales}
          configRef={configRef}
          dataRevision={0}
          densityColorPower={1}
          onDensityColorPowerChange={vi.fn()}
          onFitChannels={vi.fn()}
          files={fx.files}
          poolIds={null}
          checkedSampleIds={[]}
          onViewFile={vi.fn()}
          activeSampleId="D1"
          onGateLabelMove={onGateLabelMove}
        />
      </I18nProvider>
    );
    const first = vi.fn(), second = vi.fn();
    act(() => root.render(tab(first)));
    await flush();
    const drawn = renderer.renderStrategyGrid.mock.calls.length;
    expect(drawn).toBeGreaterThan(0);
    // The same props, but for a handler of a new identity, as an inline function is.
    act(() => root.render(tab(second)));
    await flush();
    expect(renderer.renderStrategyGrid.mock.calls.length).toBe(drawn);
    // The grid, drawn once, still reports a moved label to the handler of the latest render.
    const payload = renderer.renderStrategyGrid.mock.calls[drawn - 1][1] as { gate_style: { on_label_move: (gateId: string, offset: [number, number]) => void } };
    payload.gate_style.on_label_move(fx.bGateId, [1, 2]);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(fx.state.active_hierarchy_id, fx.bGateId, [1, 2], undefined);
  });
});

describe("the box the strategy is drawn in", () => {
  // The panels are fitted to this box's width, so a scrollbar that takes width as it appears
  // would change the fit, the height, and with it whether the scrollbar is needed.
  it("keeps the same width whether or not its scrollbar shows", () => {
    const rule = /\.gl-mini-grid-container \{([^}]*)\}/.exec(readFileSync("src/styles.css", "utf8"))?.[1] ?? "";
    expect(rule).toMatch(/overflow: auto;/);
    expect(rule).toMatch(/scrollbar-gutter: stable;/);
  });

  // The file lists of Strategy, Illustration and Plotting grow with their rows to about two
  // fifths of the window before they scroll, rather than stopping at a fixed short height.
  it("lets the side tabs' file lists grow to 40% of the window height", () => {
    const figureCss = readFileSync("src/ui/figure.css", "utf8");
    const css = readFileSync("src/styles.css", "utf8");
    expect(/\.gl-figure-list \{[^}]*max-height: max\(160px, 40vh\);/.test(figureCss)).toBe(true);
    expect(/\.gl-plotting-filelist \{[^}]*max-height: max\(160px, 40vh\);/.test(css)).toBe(true);
  });

  // Beside the side tabs the figure column can be narrow; what is drawn is named on one line
  // after the status, shortened before the status is.
  it("names the file and the tree on the status line, shortened with an ellipsis", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(/\.gl-strategy-status > span \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/.test(css)).toBe(true);
    // No header row: the tab's one grid row is the side pane beside the strategy.
    expect(/\.gl-plotting-workspace\.gl-strategy-workspace \{ grid-template-rows: minmax\(0, 1fr\); \}/.test(css)).toBe(true);
  });
});

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
          checkedSampleIds={[]}
          onViewFile={vi.fn()}
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
    // As drawn here: its columns, fonts, event cap and appearance travel with it, and its frame
    // holds its panels at the size they were drawn (one 200 px panel, its title and the inset).
    expect(onAddToLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "strategy", sampleId: "D1", populationId: fx.bcellsId, fullPath: false, displayMode: "pseudocolor",
        columns: 1, labelBackground: 0.85,
        style: expect.objectContaining({ pointSize: 1.2, pointAlpha: 0.35, contourLevels: 10, pubStyle: false, maxEvents: 10000, fontGate: 9 }),
      }),
      { width: 208, height: 234 },
    );

    // The full path: two steps, and a right-click on the second offers that step's plot and the Gating tab.
    const fullPath = [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("Full path from root"))!.querySelector("input")!;
    act(() => fullPath.click());
    await flush();
    const cells = host.querySelectorAll<HTMLElement>(".mini-plot-cell");
    expect(cells).toHaveLength(2);
    act(() => { cells[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); });
    expect(menuItems().map((b) => b.textContent)).toEqual([
      "Add the strategy to the Layout tab", "Add this plot to the Layout tab", "Show this step on the Gating tab", "Fit data + gates", "Export PNG", "Export SVG", "Export PDF", "Text sizes…",
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
    expect(onAddToLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "strategy", sampleId: "D1", populationId: fx.bcellsId, fullPath: true, displayMode: "pseudocolor", columns: 2 }),
      { width: 416, height: 234 },
    );
    // Away from a cell, the menu offers the strip and the exports but no step.
    act(() => { host.querySelector<HTMLElement>("#strategy-grid-container")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); });
    expect(menuItems().map((b) => b.textContent)).toEqual(["Add the strategy to the Layout tab", "Fit data + gates", "Export PNG", "Export SVG", "Export PDF", "Text sizes…"]);
    // A panel of the multi-population grid has the renderer's own right-click handler, which stops
    // the event; the tab's menu opens all the same, and the renderer's does not.
    act(() => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    let rendererMenus = 0;
    cells[1].oncontextmenu = (event) => { event.stopPropagation(); rendererMenus += 1; };
    act(() => { cells[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); });
    expect(rendererMenus).toBe(0);
    expect(menuItems().map((b) => b.textContent)).toContain("Add this plot to the Layout tab");
  });

  it("sends the gates' edge style with the strip, and nothing for the default", async () => {
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
          checkedSampleIds={[]}
          onViewFile={vi.fn()}
          activeSampleId="D1"
          onAddToLayout={onAddToLayout}
        />
      </I18nProvider>,
    ));
    await flush();
    act(() => button("Add to Layout")!.click());
    expect(onAddToLayout.mock.calls.at(-1)![0]).not.toHaveProperty("gateEdgeMode");
    const edges = [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.startsWith("Gate edges"))!.querySelector("select")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(edges, "bowed");
      edges.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    act(() => button("Add to Layout")!.click());
    expect(onAddToLayout.mock.calls.at(-1)![0]).toMatchObject({ kind: "strategy", gateEdgeMode: "bowed" });
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
          checkedSampleIds={[]}
          onViewFile={vi.fn()}
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
    // gutter on its right that the arrows run in, the plain 8 px below it, where no line of a
    // tree runs, and its title).
    expect(onAddToLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "strategy", sampleId: "D1", populationId: fx.bcellsId, fullPath: true, displayMode: "pseudocolor",
        populationIds: [fx.bcellsId], layout: "tree", columns: 4, showArrows: true, arrowWidth: 1.5, title: "{sample}",
        plotSize: 200, labelBackground: 0.85,
        // A new strategy uses the workspace's figure style: its gate labels at the style's 9 px.
        style: expect.objectContaining({ pointSize: 1.2, pointAlpha: 0.35, contourLevels: 10, pubStyle: false, fontGate: 9 }),
      }),
      { width: 244, height: 250 },
    );
  });
});

describe("the Strategy tab's controls", () => {
  it("sit in side tabs, Data / Plot / Style / Export, with Mode and Population first", async () => {
    const fx = fixture();
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
          checkedSampleIds={[]}
          onViewFile={vi.fn()}
          activeSampleId="D1"
          onAddToLayout={vi.fn()}
        />
      </I18nProvider>,
    ));
    await flush();
    const inspector = host.querySelector<HTMLElement>(".gl-strategy-inspector")!;
    const tabs = [...inspector.querySelectorAll<HTMLButtonElement>(".gl-presentation-tabs button")];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Data", "Plot", "Style", "Export"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    const sections = () => [...inspector.querySelectorAll<HTMLElement>("section.gl-strategy-section")];
    const shown = () => sections().filter((section) => !section.hidden);
    expect(shown()).toHaveLength(1);

    // Data: Mode first, then the population and its path, then the pool and what each step shows.
    const data = shown()[0];
    expect(data.querySelector("h3")!.textContent).toBe("Mode");
    const text = data.textContent ?? "";
    const order = ["Single", "Multiple pops", "Population", "Full path from root", "Pool checked files", "Gate view", "Back-gated", "Max events/panel"];
    expect(order.map((word) => text.indexOf(word))).toEqual([...order.map((word) => text.indexOf(word))].sort((a, b) => a - b));
    expect(order.every((word) => text.includes(word))).toBe(true);
    expect(data.querySelector<HTMLSelectElement>("select")!.value).toBe(fx.bcellsId);

    // Each side tab shows its own controls and nothing else.
    const open = (label: string) => act(() => tabs.find((tab) => tab.textContent === label)!.click());
    open("Plot");
    expect(shown()[0].textContent).toContain("Plot size");
    expect(shown()[0].textContent).toContain("Fit data + gates");
    open("Style");
    expect(shown()[0].textContent).toContain("Point size");
    expect(shown()[0].textContent).toContain("Gate edges");
    open("Export");
    expect(shown()[0].textContent).toContain("With gating tree");
    // Add to Layout is under Export, as on the Illustration and Plotting tabs, and the tab has no header row.
    expect([...shown()[0].querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Add to Layout", "PNG", "SVG", "PDF"]);
    expect([...shown()[0].querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["To the Layout tab", "Export"]);
    expect(host.querySelector(".gl-plotting-head")).toBeNull();
    expect(shown()).toHaveLength(1);
    // The old stacked rows and the Appearance fold are gone.
    expect(host.querySelector(".gl-strategy-controls")).toBeNull();
    expect(host.querySelector("details")).toBeNull();
  });
});

describe("Fit to columns", () => {
  it("sizes the panels so the steps fill the width, and draws Plot size once unticked", async () => {
    const fx = fixture();
    let observed: ((entries: { contentRect: { width: number } }[]) => void) | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: (entries: { contentRect: { width: number } }[]) => void) { observed = callback; }
      observe() {}
      disconnect() {}
    });
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
          checkedSampleIds={[]}
          onViewFile={vi.fn()}
          activeSampleId="D1"
        />
      </I18nProvider>,
    ));
    act(() => observed!([{ contentRect: { width: 608 } }]));
    await flush();
    const drawn = () => renderer.renderStrategyGrid.mock.calls.at(-1)![1] as { plot_size: number; n_columns: number; fit_to_columns: boolean; steps: unknown[] };
    // One step fills the width, up to the cap, rather than drawing one 200 px panel in it.
    expect(drawn().steps).toHaveLength(1);
    expect(drawn().plot_size).toBe(500);
    // The renderer makes its grid as wide as the columns it is given, so it is given the one
    // drawn, not the four allowed: the page, and the grip in its corner, end at the plot.
    expect(drawn().n_columns).toBe(1);
    // The full path to B cells is two steps: two columns, not four of 200 px, in the width less
    // the page's margins, (608 - 8 - 2 × 14 - 8) / 2 px each.
    const fullPath = [...host.querySelectorAll<HTMLLabelElement>("label")].find((label) => label.textContent === "Full path from root")!.querySelector("input")!;
    act(() => fullPath.click());
    await flush();
    expect(drawn().steps).toHaveLength(2);
    expect(drawn().plot_size).toBe(282);
    expect(drawn().n_columns).toBe(2);
    expect(drawn().fit_to_columns).toBe(false);
    expect(host.textContent).toContain("drawn at 282 px");

    // A wide figure area is capped.
    act(() => observed!([{ contentRect: { width: 2000 } }]));
    await flush();
    expect(drawn().plot_size).toBe(500);

    // A size typed in Plot size is the size wanted: Fit switches off and the panels are that size.
    const plotSize = [...host.querySelectorAll<HTMLLabelElement>("label")].find((label) => label.textContent?.includes("Plot size"))!.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(plotSize, "250");
      plotSize.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    expect(drawn().plot_size).toBe(250);
    expect(host.textContent).not.toContain("drawn at");
    // More columns allowed than there are steps: the grid is still the two drawn.
    expect(drawn().n_columns).toBe(2);
  });

  // The grid of several populations has its own margins: 4 px at the left and, at the right, the
  // gutter its arrows run in. Fitted, the page with that grid on it is no wider than the box, so
  // the grip in the page's corner is in view.
  it("fits the grid of several populations, its arrows' gutter and the page's margins into the width", async () => {
    const fx = fixture();
    // Lymphocytes holds every event, so the panel its events are drawn on is there.
    const derived = { masks: { [fx.lymphId]: Uint8Array.from([1, 1, 1]) } } as unknown as Derived;
    let observed: ((entries: { contentRect: { width: number } }[]) => void) | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: (entries: { contentRect: { width: number } }[]) => void) { observed = callback; }
      observe() {}
      disconnect() {}
    });
    act(() => root.render(
      <I18nProvider>
        <StrategyTab
          state={fx.state as CoreState}
          sample={fx.files[0].sample}
          sampleName="D1.fcs"
          derived={derived}
          globalScales={{}}
          configRef={{ current: null }}
          dataRevision={0}
          densityColorPower={1}
          onDensityColorPowerChange={vi.fn()}
          onFitChannels={vi.fn()}
          files={fx.files}
          poolIds={null}
          checkedSampleIds={[]}
          onViewFile={vi.fn()}
          activeSampleId="D1"
        />
      </I18nProvider>,
    ));
    act(() => observed!([{ contentRect: { width: 700 } }]));
    await flush();
    act(() => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("Multiple pops"))!.querySelector("input")!.click());
    await flush();
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".gl-strategy-pops button")].find((b) => b.textContent === "All")!.click());
    await flush();
    const drawn = renderer.renderMultiStrategyGrid.mock.calls.at(-1)![1] as { plot_size: number; grid_gap: number; nodes: { col: number }[] };
    // Two panels side by side, an arrow from the first to the second.
    const columns = Math.max(...drawn.nodes.map((node) => node.col)) + 1;
    expect(columns).toBe(2);
    expect(drawn.grid_gap).toBeGreaterThan(8);
    const page = 2 * STRATEGY_PAGE_PADDING + 4 + columns * drawn.plot_size + (columns - 1) * drawn.grid_gap + drawn.grid_gap;
    expect(page).toBeLessThanOrEqual(700);
    // And no narrower than the whole pixels of two columns allow.
    expect(page).toBeGreaterThan(700 - columns);
  });
});

describe("choosing several populations", () => {
  it("happens in the Data side tab, from the tree as one column, and not from the Gating tab's ticks", async () => {
    const fx = fixture();
    // Ticked on the Gating tab: the Strategy tab's selection is its own and ignores this.
    fx.state.selected_pop_ids = [fx.lymphId];
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
          checkedSampleIds={[]}
          onViewFile={vi.fn()}
          activeSampleId="D1"
        />
      </I18nProvider>,
    ));
    await flush();
    const data = () => host.querySelector<HTMLElement>('.gl-strategy-inspector section[aria-label="Data"]')!;
    // Single: the Population list, and no checklist.
    expect(data().querySelector("select")).not.toBeNull();
    expect(host.querySelector(".gl-strategy-pops")).toBeNull();

    const multiple = [...data().querySelectorAll<HTMLLabelElement>("label")].find((label) => label.textContent === "Multiple pops")!.querySelector("input")!;
    act(() => multiple.click());
    await flush();
    // Nothing ticked: the note says where to tick; there is no Render button, it draws on a tick.
    const empty = renderer.renderMultiStrategyGrid.mock.calls.at(-1)![1] as { error_msg?: string };
    expect(empty.error_msg).toBe("Tick populations in the Data tab to draw their strategy.");
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Tick populations in the Data tab to draw their strategy.");
    const picker = data().querySelector<HTMLElement>(".gl-strategy-pops.is-compact")!;
    expect(picker).not.toBeNull();
    // It replaces the Population list, and nothing above the figure picks populations any more.
    expect(data().querySelector("select")).toBeNull();
    expect(host.querySelectorAll(".gl-strategy-pops")).toHaveLength(1);
    expect(host.querySelector(".gl-strategy-body .gl-strategy-pops")).toBeNull();
    // One column of the tree below the root, each row named in full in its tooltip.
    expect(picker.querySelectorAll(".gl-strategy-pops-column")).toHaveLength(1);
    const rows = [...picker.querySelectorAll<HTMLLabelElement>(".gl-strategy-pop-row")];
    expect(rows.map((row) => row.title)).toEqual(["Lymphocytes", "B cells"]);
    expect(rows.every((row) => !row.querySelector("input")!.checked)).toBe(true);
    const actions = [...picker.querySelectorAll<HTMLButtonElement>(".gl-strategy-pops-actions button")].map((b) => b.textContent);
    expect(actions).toEqual(["All", "None", "Leaves"]);

    const pick = (label: string) => act(() => [...picker.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!.click());
    pick("Leaves");
    await flush();
    expect(rows.map((row) => row.querySelector("input")!.checked)).toEqual([false, true]);
    const multi = () => renderer.renderMultiStrategyGrid.mock.calls.at(-1)![1] as { strategy_context_title?: string };
    expect(renderer.renderMultiStrategyGrid).toHaveBeenCalled();
    expect(JSON.stringify(multi())).toContain("1 population");
    expect((multi() as { error_msg?: string }).error_msg).toBeUndefined();
    pick("All");
    expect(rows.map((row) => row.querySelector("input")!.checked)).toEqual([true, true]);
    pick("None");
    expect(rows.map((row) => row.querySelector("input")!.checked)).toEqual([false, false]);
  });
});

describe("the strategy's corner grip", () => {
  const strategy = (fx: ReturnType<typeof fixture>, state: CoreState, configRef: { current: StrategyConfig | null }) => (
    <I18nProvider>
      <StrategyTab
        state={state}
        sample={fx.files[0].sample}
        sampleName="D1.fcs"
        derived={{ masks: {} } as Derived}
        globalScales={{}}
        configRef={configRef}
        dataRevision={0}
        densityColorPower={1}
        onDensityColorPowerChange={vi.fn()}
        onFitChannels={vi.fn()}
        files={fx.files}
        poolIds={null}
        checkedSampleIds={[]}
        onViewFile={vi.fn()}
        activeSampleId="D1"
      />
    </I18nProvider>
  );
  const pointer = (type: string, target: EventTarget, x: number, y: number) =>
    act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y })); });
  const sized = () => {
    const page = host.querySelector<HTMLElement>(".gl-strategy-page")!;
    page.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) });
    return page;
  };

  it("sets Plot size on release, stretching the page while dragged; Escape cancels; a double-click fits the columns", async () => {
    const fx = fixture();
    const configRef = { current: null as StrategyConfig | null };
    act(() => root.render(strategy(fx, fx.state as CoreState, configRef)));
    await flush();
    expect(configRef.current).toMatchObject({ plotSize: 200, fitToColumns: true });
    const page = sized();
    // Half as wide again: the page is stretched by 1.5 while dragged, the plots 200 → 300 px on release.
    pointer("pointerdown", host.querySelector<HTMLElement>(".gl-strategy-page > .gl-figure-resize")!, 600, 400);
    pointer("pointermove", window, 900, 410);
    expect(page.style.transform).toBe("scale(1.5)");
    expect(host.textContent).toContain("Plot size 300 px");
    pointer("pointerup", window, 900, 410);
    await flush();
    expect(page.style.transform).toBe("");
    // A size dragged is the size wanted, as one typed is: Fit to columns goes off with it.
    expect(configRef.current).toMatchObject({ plotSize: 300, fitToColumns: false });
    expect((renderer.renderStrategyGrid.mock.calls.at(-1)![1] as { plot_size: number }).plot_size).toBe(300);

    // Escape leaves the size as it was.
    sized();
    pointer("pointerdown", host.querySelector<HTMLElement>(".gl-strategy-page > .gl-figure-resize")!, 600, 400);
    pointer("pointermove", window, 300, 400);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    pointer("pointerup", window, 300, 400);
    await flush();
    expect(configRef.current).toMatchObject({ plotSize: 300, fitToColumns: false });

    // The plots never go under the renderer's smallest panel or over the Plot size field's largest.
    sized();
    pointer("pointerdown", host.querySelector<HTMLElement>(".gl-strategy-page > .gl-figure-resize")!, 600, 400);
    pointer("pointermove", window, 60, 400);
    expect(host.textContent).toContain("Plot size 120 px");
    pointer("pointermove", window, 3000, 400);
    expect(host.textContent).toContain("Plot size 500 px");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });

    act(() => { host.querySelector<HTMLElement>(".gl-strategy-page > .gl-figure-resize")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    await flush();
    expect(configRef.current).toMatchObject({ plotSize: 300, fitToColumns: true });
  });

  it("is not shown while there is no strategy drawn", async () => {
    const fx = fixture();
    // The root has no gates to trace.
    act(() => root.render(strategy(fx, { ...fx.state, active_population_id: fx.rootId } as CoreState, { current: null })));
    await flush();
    expect(host.querySelector("#strategy-grid-container")!.getAttribute("data-state")).toBe("empty");
    expect(host.querySelector(".gl-figure-resize")).toBeNull();
  });

  // The renderer empties its container at every draw, so the grip lives beside it; and it asks its
  // container to scroll, which the box around the page does instead.
  it("lives beside the renderer's container, on the page inside the box that scrolls", async () => {
    const fx = fixture();
    act(() => root.render(strategy(fx, fx.state as CoreState, { current: null })));
    await flush();
    const container = host.querySelector<HTMLElement>("#strategy-grid-container")!;
    expect(container.querySelector(".gl-figure-resize")).toBeNull();
    const page = container.parentElement!;
    expect(page.classList.contains("gl-strategy-page")).toBe(true);
    expect(page.querySelector(":scope > .gl-figure-resize")).not.toBeNull();
    expect(page.parentElement!.classList.contains("gl-mini-grid-container")).toBe(true);
    const css = readFileSync("src/styles.css", "utf8");
    expect(/\.gl-strategy-page > #strategy-grid-container \{[^}]*overflow: visible !important;/.test(css)).toBe(true);
  });

  // Reported from the dev server: with one step drawn the grip sat at the far right of the pane,
  // and the white box ran on below the plot and the grip. The page is as wide and as tall as
  // what is drawn on it, it is the white the strategy is seen on, and the grip is in its corner.
  it("sits in the corner of a white page as wide and as tall as the strategy drawn", async () => {
    const fx = fixture();
    act(() => root.render(strategy(fx, fx.state as CoreState, { current: null })));
    await flush();
    const page = host.querySelector<HTMLElement>(".gl-strategy-page")!;
    expect(page.classList.contains("is-drawn")).toBe(true);
    const css = readFileSync("src/styles.css", "utf8");
    // The page takes its content's width, and the grip's place is the page's corner (figure.css).
    expect(/\.gl-strategy-page \{[^}]*position: relative;[^}]*width: max-content;/.test(css)).toBe(true);
    expect(/\.gl-figure-resize \{[^}]*position: absolute; right: 3px; bottom: 3px;/.test(readFileSync("src/ui/figure.css", "utf8"))).toBe(true);
    // The page is the white, with the margin Fit to columns leaves room for; the box around it is not.
    const drawn = /\.gl-strategy-page\.is-drawn \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(drawn).toMatch(/background: #fff;/);
    expect(drawn).toContain(`padding: ${STRATEGY_PAGE_PADDING}px;`);
    expect(/\.gl-mini-grid-container\.gl-strategy-viewport \{[^}]*background: transparent;[^}]*border: 0;/.test(css)).toBe(true);
  });

  it("leaves a note that nothing is drawn off the page", async () => {
    const fx = fixture();
    act(() => root.render(strategy(fx, { ...fx.state, active_population_id: fx.rootId } as CoreState, { current: null })));
    await flush();
    expect(host.querySelector(".gl-strategy-page")!.classList.contains("is-drawn")).toBe(false);
  });
});
