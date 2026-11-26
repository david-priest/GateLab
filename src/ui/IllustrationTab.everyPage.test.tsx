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

describe("QC sheets from the Illustration data selection", () => {
  function openQc(controls = false, configure?: (props: ReturnType<typeof fixture>) => void) {
    const props = fixture();
    props.samples.forEach((file, i) => {
      const fcs = file.sample.fcs;
      file.name = i === 0 ? "FITC control.fcs" : i === 1 ? "PE control.fcs" : "D3.fcs";
      file.sample = new Sample({ ...fcs, channels: [
        { ...fcs.channels[0], name: "Time" },
        { ...fcs.channels[0], index: 1, name: "FITC-A", marker: "Marker " + i },
        { ...fcs.channels[0], index: 2, name: "PE-A", marker: "Reference" },
      ], columns: [...fcs.columns, fcs.columns[0]] });
    });
    configure?.(props);
    act(() => root.render(<IllustrationTab {...props} />));
    const details = [...host.querySelectorAll("details")].find((el) => el.querySelector("summary")?.textContent === "QC sheets")!;
    act(() => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    const selects = () => [...details.querySelectorAll("select")];
    const choose = (el: HTMLSelectElement, value: string) => act(() => { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); });
    if (controls) choose(selects()[0], "control");
    return { props, selects, choose, details, create: () => button("Create QC sheets in Layout")! };
  }
  it("uses the Time axis and the file's own population id in each Layout sheet", () => {
    const { props, details, create } = openQc();
    act(() => (details.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    expect(create().disabled).toBe(false);
    act(() => create().click());
    const [pages] = props.onAddPanelPagesToLayout.mock.calls[0];
    expect(pages).toHaveLength(3);
    for (const [i, page] of pages.entries()) {
      expect(page.recipes).toHaveLength(1);
      expect(page.recipes[0]).toMatchObject({ xChannel: "Time", sampleId: props.samples[i].id,
        populationId: props.state.root_population_id, yChannel: props.samples[i].sample.channels[2].key });
    }
  });
  it("requires a primary detector for every control, then resolves each receiver to the correct local channel", () => {
    const { props, selects, choose, details, create } = openQc(true);
    expect(selects().slice(1).map((s) => s.value)).toEqual(["FITC-A", "PE-A", ""]);
    for (const checkbox of details.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) act(() => checkbox.click());
    expect(create().disabled).toBe(true);
    choose(selects()[3], "PE-A");
    act(() => create().click());
    const [pages] = props.onAddPanelPagesToLayout.mock.calls[0];
    expect(pages).toHaveLength(3);
    for (const [i, page] of pages.entries()) {
      const c = props.samples[i].sample.channels;
      expect(page.recipes).toHaveLength(1);
      expect(page.recipes[0]).toMatchObject({ sampleId: props.samples[i].id,
        xChannel: c[i === 0 ? 1 : 2].key, yChannel: c[i === 0 ? 2 : 1].key });
    }
  });
  it("adds a selected child only to files where the figure includes that population", () => {
    const { props, details, create } = openQc(false, (props) => {
      const rootId = props.state.root_population_id!;
      const child = { ...newRootPopulation(), population_id: "child", name: "Selected", parent_id: rootId };
      props.state.populations[child.population_id] = child;
      props.state.populations[rootId].children = [child.population_id];
      const ref = { hierarchyId: DEFAULT_HIERARCHY_ID, populationId: child.population_id, label: child.name };
      const fig = props.configRef.current!.figure!;
      fig.populations = [ref];
      fig.samplePopulations = { D2: [ref] };
    });
    act(() => (details.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    act(() => create().click());
    const [pages] = props.onAddPanelPagesToLayout.mock.calls[0];
    expect(pages.map((page: { recipes: Array<{ populationId: string }> }) => page.recipes.map((p) => p.populationId)))
      .toEqual([[props.state.root_population_id], [props.state.root_population_id, "child"], [props.state.root_population_id]]);
  });
});
