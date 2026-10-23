// @vitest-environment jsdom
// The Strategy tab's exports with the gating tree: off by default, so an export is as it was; ticked,
// the tree is the PDF's second page and a second file beside a PNG or SVG; and each number on it is
// the one the strategy's panels were drawn with, for one population's path and for several.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrategyTab, type StrategyConfig } from "./StrategyTab";
import { clearPersistedTabState } from "./tabState";
import { I18nProvider } from "./i18n";
import { initialCoreState, recomputeGating, type CoreState, type Derived } from "../store";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import type { FigureSample } from "../engine/figure";
import type { ComposedPage } from "../plots/gridExport";

const renderer = vi.hoisted(() => ({
  renderStrategyGrid: vi.fn(),
  renderMultiStrategyGrid: vi.fn(),
}));
vi.mock("../plots/loadPlots", () => ({ loadMiniPlots: () => renderer }));
const exporter = vi.hoisted(() => ({
  exportGridPNG: vi.fn(async () => undefined),
  exportGridSVG: vi.fn(),
  exportGridPDF: vi.fn(async () => undefined),
  exportComposedPNG: vi.fn(async () => undefined),
  exportComposedSVG: vi.fn(),
}));
vi.mock("../plots/gridExport", () => exporter);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  clearPersistedTabState();
  clearPersistedTabState();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  // No canvas here: the tree page estimates its text widths, as it does wherever none exists.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext;
});
async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await vi.runAllTimersAsync(); });
}

/**
 * All Events › Lymphocytes (FSC-A/SSC-A) › CD4_positive and CD8_positive (CD4/CD8), on ten events:
 * seven lymphocytes, three of them CD4_positive and two CD8_positive. Three events outside the
 * lymphocyte gate would pass the CD4 gate, so a share taken of all events would differ.
 */
function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const lymph = newPopulation("Lymphocytes", [], rootPop.population_id);
  const lymphGate = newGate("Lymphocytes", "rectangle", "FSC-A", "SSC-A", [[15, 0], [85, 1000]]);
  lymph.gate_refs = [{ gate_id: lymphGate.gate_id, include: true }];
  const cd4 = newPopulation("CD4_positive", [], lymph.population_id);
  const cd4Gate = newGate("CD4_positive", "rectangle", "CD4", "CD8", [[50, 0], [200, 40]]);
  cd4.gate_refs = [{ gate_id: cd4Gate.gate_id, include: true }];
  const cd8 = newPopulation("CD8_positive", [], lymph.population_id);
  const cd8Gate = newGate("CD8_positive", "rectangle", "CD4", "CD8", [[0, 50], [40, 200]]);
  cd8.gate_refs = [{ gate_id: cd8Gate.gate_id, include: true }];
  rootPop.children = [lymph.population_id];
  lymph.children = [cd4.population_id, cd8.population_id];
  Object.assign(state, {
    gates: { [lymphGate.gate_id]: lymphGate, [cd4Gate.gate_id]: cd4Gate, [cd8Gate.gate_id]: cd8Gate },
    gate_order: [lymphGate.gate_id, cd4Gate.gate_id, cd8Gate.gate_id],
    populations: { [rootPop.population_id]: rootPop, [lymph.population_id]: lymph, [cd4.population_id]: cd4, [cd8.population_id]: cd8 },
    root_population_id: rootPop.population_id,
    active_population_id: cd4.population_id,
    active_hierarchy_id: DEFAULT_HIERARCHY_ID,
  });
  const column = (values: number[]) => Float32Array.from(values);
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: 10,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      { index: 2, name: "CD4", marker: null, bits: 32, range: 262144 },
      { index: 3, name: "CD8", marker: null, bits: 32, range: 262144 },
    ],
    columns: [
      column([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]),
      column([100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
      column([100, 100, 120, 150, 10, 20, 30, 45, 100, 100]),
      column([10, 10, 20, 5, 100, 150, 30, 45, 10, 10]),
    ],
  };
  const sample = new Sample(fcs);
  const derived = { masks: recomputeGating(sample, state as CoreState).masks } as Derived;
  const files: FigureSample[] = [{ id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample }];
  return { state: state as CoreState, sample, derived, files, lymphId: lymph.population_id, cd4Id: cd4.population_id, cd8Id: cd8.population_id };
}

function renderTab(fx: ReturnType<typeof fixture>, configRef: { current: StrategyConfig | null }, poolIds: string[] | null = null) {
  act(() => root.render(
    <I18nProvider>
      <StrategyTab
        state={fx.state}
        sample={fx.sample}
        sampleName="D1.fcs"
        derived={fx.derived}
        globalScales={{}}
        configRef={configRef}
        dataRevision={0}
        densityColorPower={1}
        onDensityColorPowerChange={vi.fn()}
        onFitChannels={vi.fn()}
        files={fx.files}
        poolIds={poolIds}
        checkedSampleIds={[]}
        onViewFile={vi.fn()}
        activeSampleId="D1"
      />
    </I18nProvider>,
  ));
}

const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button:not(.gl-menu-trigger)")].find((b) => b.textContent?.trim() === label)!;
const checkbox = (label: string) => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.trim() === label)!.querySelector("input")!;

/** The tree page's rows as written: name, events, % of parent. */
function treeRows(page: ComposedPage): Record<string, { count: string; percent: string | undefined }> {
  const rows: Record<string, { count: string; percent: string | undefined }> = {};
  for (const group of page.root.querySelectorAll("#gating-tree > g[id^='row-']")) {
    const [name, count, percent] = [...group.querySelectorAll(":scope > text")].map((text) => text.textContent ?? "");
    rows[name] = { count, percent };
  }
  return rows;
}

describe("the Strategy tab's gating tree export", () => {
  it("is off by default, so the exports write the strategy alone, as before", async () => {
    const fx = fixture();
    const configRef = { current: null as StrategyConfig | null };
    renderTab(fx, configRef);
    await flush();
    expect(checkbox("With gating tree").checked).toBe(false);
    await act(async () => { button("PDF").click(); });
    expect(exporter.exportGridPDF).toHaveBeenCalledWith("strategy-grid-container-grid", "CD4_positive_strategy", 300, []);
    await act(async () => { button("SVG").click(); });
    await act(async () => { button("PNG").click(); });
    expect(exporter.exportGridSVG).toHaveBeenCalledWith("strategy-grid-container-grid", "CD4_positive_strategy", 300);
    expect(exporter.exportGridPNG).toHaveBeenCalledWith("strategy-grid-container-grid", "CD4_positive_strategy", 300);
    expect(exporter.exportComposedSVG).not.toHaveBeenCalled();
    expect(exporter.exportComposedPNG).not.toHaveBeenCalled();
    expect(configRef.current?.exportTree).toBe(false);
  });

  it("puts the tree on the PDF's second page and beside a PNG or SVG as <strategy>_tree, the same page each time", async () => {
    const fx = fixture();
    const configRef = { current: null as StrategyConfig | null };
    renderTab(fx, configRef);
    await flush();
    act(() => checkbox("With gating tree").click());
    expect(configRef.current?.exportTree).toBe(true);

    await act(async () => { button("PDF").click(); });
    const [, , , pages] = exporter.exportGridPDF.mock.calls[0] as unknown as [string, string, number, ComposedPage[]];
    expect(pages).toHaveLength(1);
    expect(pages[0].root.querySelector("#gating-tree-title")!.textContent).toBe("Gating tree · D1.fcs");

    await act(async () => { button("SVG").click(); });
    expect(exporter.exportGridSVG).toHaveBeenCalledWith("strategy-grid-container-grid", "CD4_positive_strategy", 300);
    expect(exporter.exportComposedSVG).toHaveBeenCalledWith(expect.anything(), "CD4_positive_strategy_tree");
    await act(async () => { button("PNG").click(); });
    expect(exporter.exportGridPNG).toHaveBeenCalledWith("strategy-grid-container-grid", "CD4_positive_strategy", 300);
    expect(exporter.exportComposedPNG).toHaveBeenCalledWith(expect.anything(), "CD4_positive_strategy_tree", 300);

    // One drawing three ways: the rows of the PDF page, the SVG file and the PNG file agree.
    const svgPage = exporter.exportComposedSVG.mock.calls[0][0] as unknown as ComposedPage;
    const pngPage = (exporter.exportComposedPNG.mock.calls[0] as unknown as [ComposedPage])[0];
    expect(treeRows(svgPage)).toEqual(treeRows(pages[0]));
    expect(treeRows(pngPage)).toEqual(treeRows(pages[0]));
  });

  it("gives, on one population's full path, each population's count and % of parent as its step shows them", async () => {
    const fx = fixture();
    renderTab(fx, { current: { exportTree: true } as StrategyConfig });
    await flush();
    act(() => checkbox("Full path from root").click());
    await flush();
    await act(async () => { button("PDF").click(); });
    const [, , , pages] = exporter.exportGridPDF.mock.calls[0] as unknown as [string, string, number, ComposedPage[]];
    const rows = treeRows(pages[0]);
    expect(Object.keys(rows)).toEqual(["All Events", "Lymphocytes", "CD4_positive"]);

    const payload = renderer.renderStrategyGrid.mock.calls.at(-1)![1] as { steps: { gate_name: string; n_before: number; n_after: number; pct_pass: number }[] };
    expect(payload.steps.map((step) => step.gate_name)).toEqual(["Lymphocytes", "CD4_positive"]);
    for (const step of payload.steps) {
      expect(rows[step.gate_name]).toEqual({ count: step.n_after.toLocaleString(), percent: `${step.pct_pass.toFixed(1)}%` });
    }
    expect(rows["All Events"].count).toBe(payload.steps[0].n_before.toLocaleString());
    expect(rows).toEqual({
      "All Events": { count: "10", percent: undefined },
      Lymphocytes: { count: "7", percent: "70.0%" },
      CD4_positive: { count: "3", percent: "42.9%" },
    });
  });

  it("gives, for several populations, each panel's count and each gate's % of parent as the panels show them", async () => {
    const fx = fixture();
    renderTab(fx, { current: { exportTree: true } as StrategyConfig });
    await flush();
    act(() => checkbox("Multiple pops").click());
    await flush();
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".gl-strategy-pops button")].find((b) => b.textContent === "Leaves")!.click());
    await flush();
    await act(async () => { button("PDF").click(); });
    const [, name, , pages] = exporter.exportGridPDF.mock.calls[0] as unknown as [string, string, number, ComposedPage[]];
    expect(name).toBe("CD4_positive_strategy");
    const rows = treeRows(pages[0]);
    expect(Object.keys(rows)).toEqual(["All Events", "Lymphocytes", "CD4_positive", "CD8_positive"]);

    const payload = renderer.renderMultiStrategyGrid.mock.calls.at(-1)![1] as {
      nodes: { parent_pop_name: string; n_events: number; gates: { name: string; percent_of_parent: number }[] }[];
    };
    expect(payload.nodes).toHaveLength(2);
    for (const node of payload.nodes) {
      // The panel's title: its parent population and that population's events.
      expect(rows[node.parent_pop_name].count).toBe(node.n_events.toLocaleString());
      // Each gate's label: the population it makes, as a share of the parent.
      for (const gate of node.gates) expect(rows[gate.name].percent).toBe(`${gate.percent_of_parent.toFixed(1)}%`);
    }
    expect(rows).toEqual({
      "All Events": { count: "10", percent: undefined },
      Lymphocytes: { count: "7", percent: "70.0%" },
      CD4_positive: { count: "3", percent: "42.9%" },
      CD8_positive: { count: "2", percent: "28.6%" },
    });
  });

  it("comes back ticked from a saved config, and is not offered while files are pooled", async () => {
    const fx = fixture();
    renderTab(fx, { current: { exportTree: true } as StrategyConfig });
    await flush();
    expect(checkbox("With gating tree").checked).toBe(true);
    expect(checkbox("With gating tree").disabled).toBe(false);

    // Pooled from the Strategy tab's own file list.
    act(() => checkbox("Pool checked files").click());
    await flush();
    const box = checkbox("With gating tree");
    expect(box.disabled).toBe(true);
    expect(box.closest("label")!.title).toBe("The gating tree gives one file's counts, so it is not exported while files are pooled");
  });
});
