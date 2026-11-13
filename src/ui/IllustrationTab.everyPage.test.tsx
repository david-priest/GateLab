// @vitest-environment jsdom
// The Illustration tab's header buttons with a figure of several pages: "This page" or "Every
// page, one sheet each". Synthetic files D1, D2 and D3 on one tree; nothing here is a real experiment.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IllustrationTab } from "./IllustrationTab";
import { initialCoreState } from "../store";
import { newRootPopulation } from "../engine/models";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { figureHierarchies, migrateFigure, type FigureSample } from "../engine/figure";
import type { IllustrationConfig } from "../engine/workspace";
import { defaultIllustrationConfig } from "../engine/figureDefaults";

vi.mock("../plots/figurePlot", () => ({
  drawFigurePlot: (node: HTMLElement) => {
    node.innerHTML = '<svg aria-label="Rendered plot"></svg>';
  },
}));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
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
  for (let i = 0; i < 5; i++) await act(async () => { await vi.runAllTimersAsync(); });
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('.gl-context-menu [role="menuitem"]')].map((b) => b.textContent);

/** Three files, the figure's files on pages (one page each) unless `onePage`. */
function fixture(onePage = false) {
  const state = initialCoreState();
  const population = newRootPopulation();
  Object.assign(state, {
    populations: { [population.population_id]: population },
    root_population_id: population.population_id,
    active_population_id: population.population_id,
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
  const samples: FigureSample[] = ["D1", "D2", "D3"].map((id) => ({ id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) }));
  const config: IllustrationConfig = { ...defaultIllustrationConfig(), popIds: [population.population_id], xChannels: ["FSC-A"], yChannel: "SSC-A" };
  config.figure = migrateFigure(config, samples, figureHierarchies(state), DEFAULT_HIERARCHY_ID, "FSC-A", "SSC-A");
  config.figure.rows = [];
  config.figure.columns = onePage ? ["samples", "populations", "plots"] : ["populations", "plots"];
  config.figure.pages = onePage ? [] : ["samples"];
  const callbacks = {
    onAddToLayout: vi.fn(),
    onAddFigureToLayout: vi.fn(),
    onAddFigurePagesToLayout: vi.fn(),
    onAddPanelPagesToLayout: vi.fn(),
  };
  const props = {
    samples,
    state,
    configRef: { current: config } as { current: IllustrationConfig | null },
    checkedSampleIds: samples.map((s) => s.id),
    defaultX: "FSC-A",
    defaultY: "SSC-A",
    presets: [],
    onSavePreset: vi.fn(),
    onDeletePreset: vi.fn(),
    onConfigChange: vi.fn(),
    onOpenGating: vi.fn(),
    dataRevision: "initial",
    ...callbacks,
  };
  return props;
}

describe("Illustration: sending a figure of several pages to Layout", () => {
  it("acts at once with one page, as before", async () => {
    const props = fixture(true);
    act(() => root.render(<IllustrationTab {...props} />));
    await flush();
    act(() => button("Add to Layout")!.click());
    expect(menuItems()).toEqual([]);
    expect(props.onAddFigureToLayout).toHaveBeenCalledTimes(1);
    expect(props.onAddFigureToLayout.mock.calls[0][1]).toBe(0);
    act(() => button("Add panels to Layout")!.click());
    expect(menuItems()).toEqual([]);
    expect(props.onAddToLayout).toHaveBeenCalledTimes(1);
    expect(props.onAddToLayout.mock.calls[0][0]).toHaveLength(3);
  });

  it("Add to Layout: This page sends the page shown; Every page sends each page's label", async () => {
    const props = fixture();
    act(() => root.render(<IllustrationTab {...props} />));
    await flush();
    act(() => button("Next")!.click());
    await flush();
    act(() => button("Add to Layout")!.click());
    expect(menuItems()).toEqual(["This page", "Every page, one sheet each (3)"]);
    expect(props.onAddFigureToLayout).not.toHaveBeenCalled();
    act(() => button("This page")!.click());
    expect(menuItems()).toEqual([]);
    expect(props.onAddFigureToLayout).toHaveBeenCalledTimes(1);
    expect(props.onAddFigureToLayout.mock.calls[0][1]).toBe(1);
    act(() => button("Add to Layout")!.click());
    act(() => button("Every page, one sheet each (3)")!.click());
    expect(props.onAddFigurePagesToLayout).toHaveBeenCalledTimes(1);
    const [config, labels] = props.onAddFigurePagesToLayout.mock.calls[0];
    expect(config.figure.pages).toEqual(["samples"]);
    expect(labels).toEqual(["D1.fcs", "D2.fcs", "D3.fcs"]);
  });

  it("Add panels to Layout: Every page sends each page's own panels in their grid cells, with the page's headings", async () => {
    const props = fixture();
    act(() => root.render(<IllustrationTab {...props} />));
    await flush();
    act(() => button("Add panels to Layout")!.click());
    expect(menuItems()).toEqual(["This page", "Every page, one sheet each (3)"]);
    act(() => button("Every page, one sheet each (3)")!.click());
    expect(props.onAddToLayout).not.toHaveBeenCalled();
    expect(props.onAddPanelPagesToLayout).toHaveBeenCalledTimes(1);
    const [pages, panelSize] = props.onAddPanelPagesToLayout.mock.calls[0];
    expect(panelSize).toBe(props.configRef.current!.figure!.panelSize);
    expect(pages).toHaveLength(3);
    expect(pages.map((page: { recipes: { sampleId: string }[] }) => page.recipes.map((recipe) => recipe.sampleId))).toEqual([["D1"], ["D2"], ["D3"]]);
    for (const page of pages) {
      expect(page.cells).toEqual([{ row: 0, column: 0 }]);
      expect(page.headings).toEqual(expect.objectContaining({ columns: expect.any(Array), rows: expect.any(Array) }));
    }
    // This page: today's hand-off of the page shown.
    act(() => button("Add panels to Layout")!.click());
    act(() => button("This page")!.click());
    expect(props.onAddToLayout).toHaveBeenCalledTimes(1);
    expect(props.onAddToLayout.mock.calls[0][0].map((recipe: { sampleId: string }) => recipe.sampleId)).toEqual(["D1"]);
  });
});
