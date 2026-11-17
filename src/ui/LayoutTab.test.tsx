// @vitest-environment jsdom
// The Layout tab: sheets and free placement, and the editing that any layout editor needs.
// Moveable and Selecto (the canvas libraries) are stood in for by props recorders, so the tab's
// handlers are driven directly; their behaviour in a real browser is checked headlessly.
// Synthetic sample D1 with two channels; nothing here is a real experiment.

import { act, useImperativeHandle, useState, forwardRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutWorkspace, DEFAULT_ITERATION, normalizeLayoutStyle, normalizeLayoutWorkspace, type LayoutChartRecipe, type LayoutIteration, type LayoutWorkspace } from "../engine/layout";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import type { FigureSample } from "../engine/figure";
import { initialCoreState, type CoreState } from "../store";
import { I18nProvider } from "./i18n";
import { LayoutTab } from "./LayoutTab";
import { defaultIllustrationConfig } from "../engine/figureDefaults";
import { BASE_PROPORTIONS_SETTINGS } from "../engine/proportionsSettings";
import type { IllustrationConfig } from "../engine/workspace";

const draws = vi.hoisted(() => ({
  plots: [] as { host: HTMLElement; config: Record<string, unknown> }[],
  strategies: [] as { id: string; payload: unknown }[],
  multiStrategies: [] as { id: string; payload: unknown }[],
  exports: [] as { name: string; format: string; pages: number }[],
  /** What the export writer reports back, for a test that needs it to have done otherwise than asked. */
  writeReport: undefined as unknown,
  /** The zoom each composition of the export was given. */
  composedZooms: [] as number[],
  moveable: null as Record<string, any> | null,
  selecto: null as Record<string, any> | null,
  frameUpdates: 0,
  dragStarts: [] as unknown[],
  stopDrags: 0,
  selectoTargets: [] as Element[],
  selectoClicks: [] as { shift: boolean; target: Element }[],
  /** Set, the plot renderer throws this message, as a drawing that fails does. */
  fail: null as string | null,
  /** How many times a figure has been laid out into pages. */
  figureLayouts: 0,
  /** How many exact medians have been taken. */
  medians: 0,
}));
vi.mock("../engine/heatmap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/heatmap")>();
  return {
    ...actual,
    exactMedian: (values: number[]) => {
      draws.medians += 1;
      return actual.exactMedian(values);
    },
  };
});
vi.mock("../engine/figure", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/figure")>();
  return {
    ...actual,
    layoutFigure: (...args: Parameters<typeof actual.layoutFigure>) => {
      draws.figureLayouts += 1;
      return actual.layoutFigure(...args);
    },
  };
});
vi.mock("../plots/loadPlots", () => ({
  loadMiniPlots: () => ({
    renderMiniPlot: (host: HTMLElement, config: Record<string, unknown>) => {
      if (draws.fail) throw new Error(draws.fail);
      draws.plots.push({ host, config });
      host.setAttribute("style", "position: relative; width: 200px; height: 200px; flex: 0 0 auto; display: inline-block;");
    },
    renderStrategyGrid: (id: string, payload: unknown) => {
      draws.strategies.push({ id, payload });
      const container = document.getElementById(id);
      if (container) container.innerHTML = '<div class="strategy-context-title"></div><div class="mini-plot-grid strategy-grid"></div>';
    },
    // The multi-population grid as the renderer lays it out: its title, then a grid 216 px wide.
    renderMultiStrategyGrid: (id: string, payload: unknown) => {
      draws.multiStrategies.push({ id, payload });
      const container = document.getElementById(id)!;
      container.innerHTML = '<div class="strategy-context-title"></div><div class="mini-plot-grid multi-strategy-grid"></div>';
      Object.defineProperty(container.querySelector(".multi-strategy-grid")!, "offsetWidth", { value: 216 });
    },
  }),
}));
vi.mock("../plots/layoutExport", () => ({
  composeSheetPages: (_canvas: HTMLElement, sheet: { page: { columns: number; rows: number } }, options: { zoom: number }) => {
    draws.composedZooms.push(options.zoom);
    return Array.from({ length: sheet.page.columns * sheet.page.rows }, () => ({ root: null, width: 0, height: 0 }));
  },
  writeComposedPages: async (composed: unknown[], sheet: { name: string }, format: string) => {
    draws.exports.push({ name: sheet.name, format, pages: composed.length });
    return draws.writeReport;
  },
}));
vi.mock("react-moveable", () => ({
  default: forwardRef((props: Record<string, any>, ref) => {
    draws.moveable = props;
    useImperativeHandle(ref, () => ({
      isMoveableElement: () => false,
      waitToChangeTarget: async () => {},
      dragStart: (event: unknown) => { draws.dragStarts.push(event); },
      stopDrag: () => { draws.stopDrags += 1; },
      updateRect: () => { draws.frameUpdates += 1; },
    }));
    return null;
  }),
}));
vi.mock("react-selecto", () => ({
  default: forwardRef((props: Record<string, any>, ref) => {
    draws.selecto = props;
    useImperativeHandle(ref, () => ({
      setSelectedTargets: (targets: Element[]) => { draws.selectoTargets = targets; },
      clickTarget: (event: MouseEvent, target: Element) => { draws.selectoClicks.push({ shift: !!event.shiftKey, target }); },
    }));
    return null;
  }),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  draws.plots = [];
  draws.strategies = [];
  draws.multiStrategies = [];
  draws.exports = [];
  draws.writeReport = undefined;
  draws.composedZooms = [];
  draws.moveable = null;
  draws.selecto = null;
  draws.selectoTargets = [];
  draws.selectoClicks = [];
  draws.dragStarts = [];
  draws.stopDrags = 0;
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
const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
const page = () => host.querySelector<HTMLDivElement>(".gl-layout-canvas-scroll")!;
const key = (init: KeyboardEventInit) => act(() => {
  page().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});
const element = (id: string) => host.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!;
/** What Selecto reports when the user clicks or marquees these items. */
const select = (...ids: string[]) => act(() => {
  draws.selecto!.onSelectEnd({ selected: ids.map(element), isDragStart: false, isClick: ids.length <= 1, inputEvent: {} });
});
/** Opens a text block's editor as a double-click on its words does, and returns the editor. */
const openEditor = (id: string) => {
  act(() => { element(id).querySelector<HTMLElement>(".gl-layout-text-surface")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  return element(id).querySelector<HTMLTextAreaElement>("textarea")!;
};
/** What Moveable reports for a drag of one item to a new place. */
const drag = (id: string, to: { x: number; y: number }, altKey = false) => act(() => {
  const el = element(id);
  const datas: Record<string, unknown> = {};
  draws.moveable!.onDragStart({ target: el, datas, inputEvent: { altKey } });
  draws.moveable!.onDrag({ target: el, left: to.x, top: to.y, datas });
  draws.moveable!.onDragEnd({ target: el, isDrag: true, datas });
});

/** One gated sample on the workspace tree: All Events with one child population. */
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
  const samples: FigureSample[] = [
    { id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs), metadata: { donor: "D1", day: "7" } },
    { id: "D2", name: "D2.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs), metadata: { donor: "D2", day: "0" } },
  ];
  return { state, samples, rootId: rootPop.population_id, childId: child.population_id };
}

/**
 * The fixture with a rectangle under Lymphocytes: FSC-A 0..15 × SSC-A 0..35 holds (10,30), one of
 * each file's three events. With `third`, a D3 of the same events on day 7.
 */
function gatedFixture(third = false) {
  const fx = fixture();
  const gate = newGate("Lymph_gate", "rectangle", "FSC-A", "SSC-A", [[0, 0], [15, 35]]);
  fx.state.gates = { [gate.gate_id]: gate };
  fx.state.gate_order = [gate.gate_id];
  fx.state.populations[fx.childId].gate_refs = [{ gate_id: gate.gate_id, include: true }];
  if (third) fx.samples.push({ id: "D3", name: "D3.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fx.samples[0].sample.fcs), metadata: { donor: "D3", day: "7" } });
  return fx;
}

function mount(fx: ReturnType<typeof fixture>, globalScales: Record<string, [number, number]> = {}, illustrationConfig: IllustrationConfig | null = null, extra: Record<string, unknown> = {}, initial?: LayoutWorkspace) {
  const changes: LayoutWorkspace[] = [];
  function Harness() {
    const [workspace, setWorkspace] = useState(() => initial ?? createDefaultLayoutWorkspace());
    return (
      <I18nProvider>
        <LayoutTab
          workspace={workspace}
          onChange={(next) => { changes.push(next); setWorkspace(next); }}
          samples={fx.samples}
          checkedSampleIds={["D1", "D2"]}
          metadataColumns={["donor", "day"]}
          activeSampleId="D1"
          activePopulationId={fx.rootId}
          state={fx.state as CoreState}
          globalScales={globalScales}
          defaultX="FSC-A"
          defaultY="SSC-A"
          illustrationConfig={illustrationConfig}
          dataRevision={0}
          densityColorPower={1.6}
          onOpenInGating={vi.fn()}
          {...extra}
        />
      </I18nProvider>
    );
  }
  act(() => root.render(<Harness />));
  return changes;
}
const items = (changes: LayoutWorkspace[]) => changes.at(-1)!.sheets[0].items;

/** A sheet saved before "+ Chart" made Plotting charts: one summary chart block, as the old button made it. */
function olderSheetWithChart(fx: ReturnType<typeof fixture>, chart: Partial<LayoutChartRecipe> = {}): LayoutWorkspace {
  const workspace = createDefaultLayoutWorkspace();
  const saved = JSON.parse(JSON.stringify(workspace));
  saved.sheets[0].items = [{
    id: "chart-1", x: 80, y: 90, width: 320, height: 240, z: 0,
    recipe: { kind: "chart", sampleId: "D1", populationId: fx.rootId, statistic: "percent_of_parent", files: "checked", groupBy: "donor", chartType: "bars", showPoints: true, test: true, ...chart },
  }];
  return normalizeLayoutWorkspace(saved);
}

/**
 * A sheet saved while the Layout tab could still start an iteration: empty, drawn once per
 * checked file unless told otherwise. Iteration is retired from Layout, so only such a sheet
 * shows the Iterate tab.
 */
function iteratingSheet(iteration: Partial<LayoutIteration> = {}): LayoutWorkspace {
  const saved = JSON.parse(JSON.stringify(createDefaultLayoutWorkspace()));
  saved.sheets[0].iteration = { ...DEFAULT_ITERATION, mode: "files", ...iteration };
  return normalizeLayoutWorkspace(saved);
}

describe("LayoutTab sheets", () => {
  it("keeps a heading reading its own plot when the sheet or the pair is duplicated, and frees it when the plot goes", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    act(() => button("+ Text").click());
    await flush();
    const [plot, note] = items(changes);
    select(note.id);
    const readsFrom = host.querySelector<HTMLSelectElement>('select[aria-label="Reads from"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(readsFrom, plot.id);
      readsFrom.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(items(changes)[1].recipe).toMatchObject({ readsFrom: plot.id });
    // The pair duplicated: the copied heading reads the copied plot.
    select(plot.id, note.id);
    key({ key: "d", metaKey: true });
    const [, , plotCopy, noteCopy] = items(changes);
    expect(noteCopy.recipe).toMatchObject({ kind: "text", readsFrom: plotCopy.id });
    // The sheet duplicated: every heading reads its own sheet's plot.
    act(() => button("Duplicate sheet").click());
    const copy = changes.at(-1)!.sheets[1];
    const copyIds = new Set(copy.items.map((item) => item.id));
    for (const item of copy.items) if (item.recipe.kind === "text") expect(copyIds.has(item.recipe.readsFrom!)).toBe(true);
    // A plot removed: the heading that read it becomes plain text.
    act(() => host.querySelector<HTMLButtonElement>(".gl-layout-sheet-tab")!.click());
    select(plot.id);
    key({ key: "Delete" });
    expect(items(changes).find((item) => item.id === note.id)?.recipe).not.toHaveProperty("readsFrom");
  });

  it("adds text blocks, creates sheets, and renames a sheet inline", () => {
    const changes = mount(fixture());
    expect(host.textContent).toContain("Blank layout");
    act(() => button("+ Text").click());
    expect(host.querySelectorAll(".gl-layout-item")).toHaveLength(1);
    expect(items(changes)[0].recipe).toMatchObject({ kind: "text", text: "Text" });
    expect(items(changes)[0]).toMatchObject({ x: 57, y: 57 }); // inside the 15 mm margin

    const addSheet = host.querySelector<HTMLButtonElement>(".gl-layout-sheet-add")!;
    act(() => addSheet.click());
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(changes.at(-1)?.sheets).toHaveLength(2);

    const activeTab = host.querySelector<HTMLButtonElement>(".gl-layout-sheet-tab.active")!;
    act(() => activeTab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const rename = host.querySelector<HTMLInputElement>(".gl-layout-sheet-rename")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(rename, "Figure 2");
      rename.dispatchEvent(new Event("input", { bubbles: true }));
      rename.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(changes.at(-1)?.sheets[1].name).toBe("Figure 2");
  });

  it("places new items on free spots of the first page, never over one another", () => {
    const changes = mount(fixture());
    for (let i = 0; i < 6; i++) act(() => button("+ Text").click());
    const placed = items(changes).map(({ x, y }) => `${x},${y}`);
    expect(new Set(placed).size).toBe(6);
    // Every text block (160 × 32) sits inside the page: 1123 × 794 with a 57 px margin.
    for (const { x, y, width, height } of items(changes)) {
      expect(x).toBeGreaterThanOrEqual(57);
      expect(y).toBeGreaterThanOrEqual(57);
      expect(x + width).toBeLessThanOrEqual(1123 - 57);
      expect(y + height).toBeLessThanOrEqual(794 - 57);
    }
  });
});

describe("LayoutTab plots", () => {
  it("opens a menu on a right-click: an item's actions, or a new item where the page was clicked", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    const id = items(changes)[0].id;
    act(() => { element(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 150 })); });
    const menuItem = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === label)!;
    expect(menuItem("Duplicate")).toBeDefined();
    act(() => menuItem("Duplicate").click());
    await flush();
    expect(items(changes)).toHaveLength(2);
    expect(host.querySelector('.gl-context-menu')).toBeNull(); // closed by the choice
    // Empty page: the menu adds where the pointer was, in page coordinates.
    const canvas = host.querySelector<HTMLElement>(".gl-layout-canvas")!;
    act(() => { canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 250 })); });
    act(() => menuItem("+ Text").click());
    await flush();
    const zoom = Number(/scale\(([\d.]+)\)/.exec(canvas.style.transform)?.[1] ?? 1);
    const text = items(changes).find((item) => item.recipe.kind === "text")!;
    expect(text).toBeDefined();
    expect([text.x, text.y]).toEqual([Math.round(300 / zoom), Math.round(250 / zoom)]);
  });

  it("adds the Illustration tab's figure as one block, drawn by the figure grid", async () => {
    const fx = fixture();
    const config = {
      ...defaultIllustrationConfig(),
      figure: {
        version: 1 as const, name: "Comparison", sampleIds: ["D1", "D2"], populations: [{ hierarchyId: DEFAULT_HIERARCHY_ID, populationId: fx.rootId, label: "All Events" }],
        plots: [{ id: "p1", name: "FSC-A", x: "FSC-A", y: "SSC-A", type: "biplot" as const }],
        rows: ["populations" as const, "plots" as const], columns: ["samples" as const], pages: [], composition: "separate" as const, scalePolicy: "gating" as const, transforms: {}, showGates: true, panelSize: 200,
      },
    };
    const changes = mount(fx, {}, config);
    await flush();
    act(() => button("+ Illustration figure").click());
    await flush();
    expect(items(changes)[0].recipe).toMatchObject({ kind: "figure", page: 0, illustration: { figure: { name: "Comparison" } } });
    const grid = host.querySelector(".gl-layout-figure-host .gl-figure-grid")!;
    expect(grid).not.toBeNull();
    // One panel per file: two cells drawn by the same renderer the Illustration tab uses.
    expect(grid.querySelectorAll("td[data-figure-panel]")).toHaveLength(2);
    expect(draws.plots.length).toBeGreaterThanOrEqual(2);
  });

  it("marks a figure block pending until its panels are built, so an export waits for them", async () => {
    const fx = fixture();
    const config = {
      ...defaultIllustrationConfig(),
      figure: {
        version: 1 as const, name: "Comparison", sampleIds: ["D1", "D2"], populations: [{ hierarchyId: DEFAULT_HIERARCHY_ID, populationId: fx.rootId, label: "All Events" }],
        plots: [{ id: "p1", name: "FSC-A", x: "FSC-A", y: "SSC-A", type: "biplot" as const }],
        rows: ["populations" as const, "plots" as const], columns: ["samples" as const], pages: [], composition: "separate" as const, scalePolicy: "gating" as const, transforms: {}, showGates: true, panelSize: 200,
      },
    };
    mount(fx, {}, config);
    await flush();
    act(() => button("+ Illustration figure").click());
    const block = () => host.querySelector(".gl-layout-figure-host")!;
    expect(block().hasAttribute("data-layout-pending")).toBe(true);
    await flush();
    expect(block().querySelectorAll("td[data-figure-panel]")).toHaveLength(2);
    expect(block().hasAttribute("data-layout-pending")).toBe(false);
  });

  it("gives two blocks of the same figure page ids of their own", async () => {
    const fx = fixture();
    const config = {
      ...defaultIllustrationConfig(),
      figure: {
        version: 1 as const, name: "Comparison", sampleIds: ["D1", "D2"], populations: [{ hierarchyId: DEFAULT_HIERARCHY_ID, populationId: fx.rootId, label: "All Events" }],
        plots: [{ id: "p1", name: "FSC-A", x: "FSC-A", y: "SSC-A", type: "biplot" as const }],
        rows: ["populations" as const, "plots" as const], columns: ["samples" as const], pages: [], composition: "separate" as const, scalePolicy: "gating" as const, transforms: {}, showGates: true, panelSize: 200,
      },
    };
    mount(fx, {}, config);
    await flush();
    act(() => button("+ Illustration figure").click());
    act(() => button("+ Illustration figure").click());
    await flush();
    const grids = [...host.querySelectorAll(".gl-layout-figure-host .gl-figure-grid")];
    expect(grids).toHaveLength(2);
    // The grid's id is what its chart panels' ids and clip paths are made from.
    const ids = [...host.querySelectorAll(".gl-layout-canvas [id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(grids[0].id).not.toBe(grids[1].id);
  });

  it("does not lay a figure block out again for an edit to another item", async () => {
    const fx = fixture();
    const config = {
      ...defaultIllustrationConfig(),
      figure: {
        version: 1 as const, name: "Comparison", sampleIds: ["D1", "D2"], populations: [{ hierarchyId: DEFAULT_HIERARCHY_ID, populationId: fx.rootId, label: "All Events" }],
        plots: [{ id: "p1", name: "FSC-A", x: "FSC-A", y: "SSC-A", type: "biplot" as const }],
        rows: ["populations" as const, "plots" as const], columns: ["samples" as const], pages: [], composition: "separate" as const, scalePolicy: "gating" as const, transforms: {}, showGates: true, panelSize: 200,
      },
    };
    mount(fx, {}, config);
    await flush();
    act(() => button("+ Illustration figure").click());
    await flush();
    const before = draws.figureLayouts;
    act(() => button("+ Text").click());
    await flush();
    expect(host.querySelectorAll(".gl-layout-figure-host .gl-figure-grid")).toHaveLength(1);
    expect(draws.figureLayouts).toBe(before);
  });

  it("takes a chart block's medians once, not again on a render that changes nothing it draws", async () => {
    const fx = fixture();
    mount(fx, {}, null, {}, olderSheetWithChart(fx, { statistic: "median", channel: "FSC-A" }));
    await flush();
    expect(host.querySelectorAll(".gl-layout-chart svg circle")).toHaveLength(2);
    const before = draws.medians;
    expect(before).toBeGreaterThan(0);
    act(() => button("Snap grid").click());
    await flush();
    expect(draws.medians).toBe(before);
    expect(host.querySelectorAll(".gl-layout-chart svg circle")).toHaveLength(2);
  });

  it("draws a summary chart saved on an older sheet, of a population across the files, grouped by a metadata column", async () => {
    const fx = fixture();
    const changes = mount(fx, {}, null, {}, olderSheetWithChart(fx));
    await flush();
    select("chart-1");
    // Nothing is converted on loading: the block is the summary chart it was.
    expect(changes).toHaveLength(0);
    const chart = host.querySelector(".gl-layout-chart svg")!;
    expect(chart).not.toBeNull();
    // Two files, one per donor: a bar and a point for each, and no test with one file per group.
    expect(chart.querySelectorAll("circle")).toHaveLength(2);
    expect([...chart.querySelectorAll(".gl-layout-chart-groups > g > text")].map((t) => t.textContent)).toEqual(["D1", "D2"]);
    expect(chart.querySelector(".gl-layout-chart-test")).toBeNull();
    expect(chart.querySelectorAll("rect").length).toBeGreaterThanOrEqual(3); // the background and a bar per group
  });

  it("draws a file without a value in the grouping column as Unassigned, and says so in the inspector", async () => {
    const fx = fixture();
    fx.samples[1].metadata = { day: "0" };
    mount(fx, {}, null, {}, olderSheetWithChart(fx));
    await flush();
    select("chart-1");
    const chart = host.querySelector(".gl-layout-chart svg")!;
    expect([...chart.querySelectorAll(".gl-layout-chart-groups > g > text")].map((t) => t.textContent)).toEqual(["D1", "Unassigned"]);
    expect(host.textContent).toContain("Files without a value in the column are drawn as Unassigned and left out of the test.");
  });

  it("draws the sheet's style, and an item's own values over it", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    expect(draws.plots.at(-1)?.config).toMatchObject({ point_size: 1.1, contour_levels: 10, gate_style: { pub_style: false, line_width: 1.5, label_format: "name-percent" } });
    const set = (label: string, value: string) => act(() => {
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => button("Style").click());
    set("Point size", "3");
    await flush();
    expect(changes.at(-1)?.sheets[0].style).toEqual({ pointSize: 3 });
    expect(draws.plots.at(-1)?.config.point_size).toBe(3);
    // The item's own value wins over the sheet's, until the sheet sets that field again: a field
    // set on the sheet reaches every plot on it.
    const id = items(changes)[0].id;
    act(() => button("Items").click());
    select(id);
    set("Contour levels", "4");
    await flush();
    expect(items(changes)[0].recipe).toMatchObject({ style: { contourLevels: 4 } });
    expect(draws.plots.at(-1)?.config).toMatchObject({ point_size: 3, contour_levels: 4 });
    set("Point opacity", "0.8");
    await flush();
    act(() => button("Style").click());
    set("Contour levels", "20");
    await flush();
    expect(changes.at(-1)?.sheets[0].style).toEqual({ pointSize: 3, contourLevels: 20 });
    expect(items(changes)[0].recipe).toMatchObject({ style: { pointAlpha: 0.8 } });
    expect(draws.plots.at(-1)?.config).toMatchObject({ point_size: 3, contour_levels: 20, point_alpha: 0.8 });
    // Dropping the item's own values puts it back on the sheet's style.
    act(() => button("Items").click());
    select(id);
    act(() => button("Follow the sheet").click());
    await flush();
    expect("style" in items(changes)[0].recipe).toBe(false);
    expect(draws.plots.at(-1)?.config).toMatchObject({ contour_levels: 20, point_alpha: 0.4 });
  });

  it("draws a plot on the Gating tab's range, sized to the frame, once the files are prepared", async () => {
    const changes = mount(fixture(), { "FSC-A": [5, 40], "SSC-A": [5, 40] });
    // Until the per-file sources are prepared the add buttons say so and do nothing.
    expect(button("+ Biplot").disabled).toBe(true);
    expect(button("+ Biplot").title).toContain("Preparing");
    await flush();
    expect(button("+ Biplot").disabled).toBe(false);
    act(() => button("+ Biplot").click());
    await flush();
    expect(draws.plots).toHaveLength(1);
    const { host: target, config } = draws.plots[0];
    expect(target.className).toBe("gl-layout-plot-host");
    expect(config.x_range).toEqual([5, 40]);
    expect(config.y_range).toEqual([5, 40]);
    expect(config.plot_size).toBe(252);
    expect(items(changes)[0].recipe).toMatchObject({ kind: "biplot", xChannel: "FSC-A", yChannel: "SSC-A" });
  });

  it("gives a new strategy block the deepest population when the root is active", async () => {
    const fx = fixture();
    const changes = mount(fx);
    await flush();
    act(() => button("+ Gating strategy").click());
    await flush();
    expect(items(changes)[0].recipe).toMatchObject({ kind: "strategy", populationId: fx.childId });
    expect(draws.strategies).toHaveLength(1);
    expect(draws.strategies[0].id).toMatch(/^layout-strategy-/);
  });
});

describe("LayoutTab moving, copying and arranging", () => {
  it("takes Moveable's drag and resize as the item's frame, and an Option-drag as a copy", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    const [first] = items(changes);
    select(first.id);
    expect(draws.moveable).not.toBeNull();
    expect(draws.moveable!.target).toBe(element(first.id));
    drag(first.id, { x: 200, y: 150 });
    expect(items(changes)[0]).toMatchObject({ x: 200, y: 150 });

    // A resize from the west handle moves the left edge too.
    act(() => {
      const el = element(first.id);
      draws.moveable!.onResize({ target: el, width: 300, height: 40, drag: { left: 180, top: 150 } });
      draws.moveable!.onResizeEnd({ target: el, isDrag: true, datas: {} });
    });
    expect(items(changes)[0]).toMatchObject({ x: 180, y: 150, width: 300, height: 40 });

    // Option-drag: the original stays, a copy takes the dropped frame and is selected.
    const edits = changes.length;
    drag(first.id, { x: 400, y: 300 }, true);
    expect(changes.length).toBe(edits + 1);
    expect(items(changes)).toHaveLength(2);
    expect(items(changes)[0]).toMatchObject({ x: 180, y: 150 });
    expect(items(changes)[1]).toMatchObject({ x: 400, y: 300, width: 300, height: 40, z: 2 });
    expect(element(first.id).style.left).toBe("180px");
    expect(host.querySelectorAll(".gl-layout-item.is-selected")).toHaveLength(1);
    expect(host.querySelector(".gl-layout-item.is-selected")?.getAttribute("data-item-id")).toBe(items(changes)[1].id);

    // A press without a move is not an edit.
    act(() => draws.moveable!.onDragEnd({ target: element(first.id), isDrag: false, datas: {} }));
    expect(changes.length).toBe(edits + 1);
  });

  it("aligns and spreads a selection, moves a group together, and locks an item against edits", () => {
    const changes = mount(fixture());
    for (let i = 0; i < 3; i++) act(() => button("+ Text").click());
    const [a, b, c] = items(changes);
    select(a.id); drag(a.id, { x: 100, y: 100 });
    select(b.id); drag(b.id, { x: 300, y: 250 });
    select(c.id); drag(c.id, { x: 500, y: 400 });
    select(a.id, b.id, c.id);
    expect(host.textContent).toContain("3 items selected");
    expect(Array.isArray(draws.moveable!.target)).toBe(true);
    act(() => button("Left").click());
    expect(items(changes).map((i) => i.x)).toEqual([100, 100, 100]);
    act(() => button("Distribute ↕").click());
    expect(items(changes).map((i) => i.y)).toEqual([100, 250, 400]); // already even, so unchanged

    // The whole group moves with a group drag.
    act(() => {
      const events = [a, b, c].map((item, index) => ({ target: element(item.id), left: 10 + index * 20, top: 20 }));
      const datas: Record<string, unknown> = {};
      draws.moveable!.onDragGroupStart({ datas, inputEvent: {} });
      draws.moveable!.onDragGroup({ events });
      draws.moveable!.onDragGroupEnd({ targets: events.map((e) => e.target), isDrag: true, datas });
    });
    expect(items(changes).map(({ x, y }) => [x, y])).toEqual([[10, 20], [30, 20], [50, 20]]);

    // Locking: the group is no longer draggable; nudges skip the locked items; unlocking restores it.
    act(() => button("Lock").click());
    expect(items(changes).every((i) => i.locked)).toBe(true);
    // Locked items are not Moveable's to move: with every selected item locked, it has no target.
    expect(draws.moveable!.target).toEqual([]);
    key({ key: "ArrowRight" });
    expect(items(changes).map((i) => i.x)).toEqual([10, 30, 50]);
    act(() => button("Unlock").click());
    expect(draws.moveable!.draggable).toBe(true);
    key({ key: "ArrowRight" });
    expect(items(changes).map((i) => i.x)).toEqual([11, 31, 51]);
  });

  it("sets a text block bold, and leaves a ghost of the original while an Option-drag copies it", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    const first = items(changes)[0];
    select(first.id);
    const bold = [...host.querySelectorAll<HTMLLabelElement>("label.gl-check")].find((label) => label.textContent?.trim() === "Bold")!.querySelector("input")!;
    act(() => bold.click());
    expect(items(changes)[0].recipe).toMatchObject({ kind: "text", bold: true });
    expect(host.querySelector<HTMLElement>(`[data-item-id="${first.id}"] .gl-layout-text-surface`)!.style.fontWeight).toBe("700");
    act(() => bold.click());
    expect(items(changes)[0].recipe).not.toHaveProperty("bold");
    // An Option-drag: while it is under way a ghost stands where the original was; on the drop
    // the ghost goes, the original is back in place and the copy sits where it was dropped.
    const el = element(first.id);
    const datas: Record<string, unknown> = {};
    act(() => { draws.moveable!.onDragStart({ datas, target: el, inputEvent: { altKey: true } }); });
    const ghost = host.querySelector<HTMLElement>(".gl-layout-ghost")!;
    expect(ghost).not.toBeNull();
    expect(ghost.style.left).toBe(el.style.left);
    expect(ghost.hasAttribute("data-item-id")).toBe(false);
    act(() => { draws.moveable!.onDrag({ target: el, left: 300, top: 200 }); });
    expect(el.style.left).toBe("300px");
    act(() => { draws.moveable!.onDragEnd({ target: el, isDrag: true, datas }); });
    expect(host.querySelector(".gl-layout-ghost")).toBeNull();
    // No snap-distance digits beside the guidelines while dragging.
    expect(draws.moveable!.isDisplaySnapDigit).toBe(false);
    expect(draws.moveable!.isDisplayInnerSnapDigit).toBe(false);
    expect(items(changes)).toHaveLength(2);
    expect(items(changes)[0]).toMatchObject({ x: first.x, y: first.y });
    expect(items(changes)[1]).toMatchObject({ x: 300, y: 200 });
  });

  it("nudges, duplicates, restacks, removes, selects all and undoes from the keyboard", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    const first = items(changes)[0];
    select(first.id);
    key({ key: "ArrowRight" });
    expect(items(changes)[0]).toMatchObject({ x: 58, y: 57 });
    key({ key: "ArrowDown", shiftKey: true });
    expect(items(changes)[0]).toMatchObject({ x: 58, y: 67 });

    key({ key: "d", metaKey: true });
    expect(items(changes)).toHaveLength(2);
    expect(items(changes)[1]).toMatchObject({ x: 78, y: 87, z: 2 });
    act(() => button("Send to back").click());
    expect(items(changes).map(({ z }) => z)).toEqual([1, 0]);
    act(() => button("Bring to front").click());
    expect(items(changes).map(({ z }) => z)).toEqual([0, 1]);

    key({ key: "a", metaKey: true });
    expect(host.querySelectorAll(".gl-layout-item.is-selected")).toHaveLength(2);
    key({ key: "Delete" });
    expect(items(changes)).toHaveLength(0);
    key({ key: "z", metaKey: true });
    expect(items(changes)).toHaveLength(2);
    key({ key: "z", metaKey: true, shiftKey: true });
    expect(items(changes)).toHaveLength(0);
  });

  it("keeps the selection frame on the items: Moveable watches them and is re-measured after a nudge, an undo and an alignment", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    act(() => button("+ Text").click());
    const [a, b] = items(changes);
    select(a.id);
    expect(draws.moveable).toMatchObject({ useMutationObserver: true, useResizeObserver: true });
    // Every change of the page's items re-measures the frame, so it follows a move made by the
    // keyboard, by undo or by the toolbar rather than by a drag of its own.
    let measured = draws.frameUpdates;
    key({ key: "ArrowRight" });
    expect(items(changes)[0].x).toBe(58);
    expect(draws.frameUpdates).toBeGreaterThan(measured);
    measured = draws.frameUpdates;
    key({ key: "z", metaKey: true });
    expect(items(changes)[0].x).toBe(57);
    expect(draws.frameUpdates).toBeGreaterThan(measured);
    measured = draws.frameUpdates;
    select(a.id, b.id);
    act(() => button("Left").click());
    expect(draws.frameUpdates).toBeGreaterThan(measured);
  });

  it("groups with Cmd-G: a member selects the group, Shift-click takes it out whole, copies form their own group, Shift-Cmd-G dissolves it", () => {
    const changes = mount(fixture());
    for (let i = 0; i < 3; i++) act(() => button("+ Text").click());
    const [a, b, c] = items(changes);
    const selected = () => [...host.querySelectorAll(".gl-layout-item.is-selected")].map((el) => el.getAttribute("data-item-id"));
    select(a.id, b.id);
    key({ key: "g", metaKey: true });
    const group = items(changes)[0].group;
    expect(group).toBeTruthy();
    expect(items(changes).map((item) => item.group)).toEqual([group, group, undefined]);
    expect(host.textContent).toContain("2 items selected, one group");
    // A click on one member selects the group.
    select(c.id);
    expect(selected()).toEqual([c.id]);
    select(a.id);
    expect(selected()).toEqual([a.id, b.id]);
    // Shift-click on a member takes the whole group out; Shift-click on the loose item adds it alone.
    act(() => { draws.selecto!.onSelectEnd({ selected: [element(b.id)], removed: [element(a.id)], added: [], isDragStart: false, isClick: true, inputEvent: { shiftKey: true } }); });
    expect(selected()).toEqual([]);
    act(() => { draws.selecto!.onSelectEnd({ selected: [element(c.id), element(a.id)], removed: [], added: [element(a.id)], isDragStart: false, isClick: true, inputEvent: { shiftKey: true } }); });
    expect(selected()).toEqual([a.id, b.id, c.id]);
    // Distribute wants three units: the group counts once, so it is off; ungrouped, on.
    expect(button("Distribute ↔").disabled).toBe(true);
    // Copies of the group make a group of their own.
    select(a.id);
    key({ key: "d", metaKey: true });
    const copies = items(changes).slice(3);
    expect(copies).toHaveLength(2);
    expect(copies[0].group).toBeTruthy();
    expect(copies[0].group).toBe(copies[1].group);
    expect(copies[0].group).not.toBe(group);
    // Shift-Cmd-G dissolves the group under the selection; the items stay put and selected.
    select(a.id);
    const before = items(changes).slice(0, 2).map(({ x, y }) => [x, y]);
    key({ key: "g", metaKey: true, shiftKey: true });
    expect(items(changes).slice(0, 2).map((item) => item.group)).toEqual([undefined, undefined]);
    expect(items(changes).slice(0, 2).map(({ x, y }) => [x, y])).toEqual(before);
    expect(selected()).toEqual([a.id, b.id]);
    select(a.id, b.id, c.id);
    expect(button("Distribute ↔").disabled).toBe(false);
  });

  it("draws each item of a selection with no group in its own frame, so Ungroup shows at once, and a drag on one moves them all", () => {
    const changes = mount(fixture());
    for (let i = 0; i < 3; i++) act(() => button("+ Text").click());
    const [a, b, c] = items(changes);
    const ownFrames = () => !!draws.moveable!.individualGroupable;
    // One item: its own frame, as ever. Several loose items: each its own.
    select(a.id);
    expect(ownFrames()).toBe(false);
    select(a.id, b.id);
    expect(ownFrames()).toBe(true);
    // Grouped: one frame for the group; with a loose item beside it, still one frame.
    key({ key: "g", metaKey: true });
    expect(ownFrames()).toBe(false);
    act(() => { draws.selecto!.onSelectEnd({ selected: [element(a.id), element(b.id), element(c.id)], removed: [], added: [element(c.id)], isDragStart: false, isClick: true, inputEvent: { shiftKey: true } }); });
    expect(ownFrames()).toBe(false);
    // Ungrouped with nothing else pressed: the two items are in their own frames on the same render.
    select(a.id);
    key({ key: "g", metaKey: true, shiftKey: true });
    expect([...host.querySelectorAll(".gl-layout-item.is-selected")].map((el) => el.getAttribute("data-item-id"))).toEqual([a.id, b.id]);
    expect(ownFrames()).toBe(true);
    // A drag on one of them carries the other by the same distance, and both are committed.
    const [ax, ay, bx, by] = [items(changes)[0].x, items(changes)[0].y, items(changes)[1].x, items(changes)[1].y];
    drag(a.id, { x: ax + 40, y: ay + 25 });
    expect(items(changes).slice(0, 2).map(({ x, y }) => [x, y])).toEqual([[ax + 40, ay + 25], [bx + 40, by + 25]]);
    expect(items(changes)[2]).toMatchObject({ x: c.x, y: c.y });
    // A plain click on one of them, which Moveable reports as its own click, takes it alone.
    act(() => { draws.moveable!.onClick({ inputEvent: { shiftKey: false }, inputTarget: element(b.id) }); });
    // Compared by identity: a deep match on a DOM element walks the whole document.
    expect(draws.selectoClicks.at(-1)?.shift).toBe(false);
    expect(draws.selectoClicks.at(-1)?.target).toBe(element(b.id));
  });

  it("acts on a right-clicked group whole from the item menu, Ungroup included, when the group was not selected", () => {
    const changes = mount(fixture());
    for (let i = 0; i < 3; i++) act(() => button("+ Text").click());
    const [a, b] = items(changes);
    select(a.id, b.id);
    key({ key: "g", metaKey: true });
    key({ key: "Escape" });
    expect(host.querySelectorAll(".gl-layout-item.is-selected")).toHaveLength(0);
    const menuItem = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent === label)!;
    const openOn = (id: string) => act(() => { element(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 150 })); });
    // Lock from the menu takes the whole group, not the member under the pointer.
    openOn(b.id);
    act(() => menuItem("Lock").click());
    expect(items(changes).slice(0, 2).map((item) => !!item.locked)).toEqual([true, true]);
    openOn(b.id);
    act(() => menuItem("Unlock").click());
    key({ key: "Escape" });
    // Ungroup from the menu of an unselected group dissolves it, and the members stay selected,
    // each in a frame of its own.
    openOn(b.id);
    act(() => menuItem("Ungroup").click());
    expect(items(changes).slice(0, 2).map((item) => item.group)).toEqual([undefined, undefined]);
    expect([...host.querySelectorAll(".gl-layout-item.is-selected")].map((el) => el.getAttribute("data-item-id"))).toEqual([a.id, b.id]);
    expect(draws.moveable!.individualGroupable).toBe(true);
  });

  it("cancels a drag of items in their own frames with Escape, putting every one back", () => {
    const changes = mount(fixture());
    for (let i = 0; i < 2; i++) act(() => button("+ Text").click());
    const [a, b] = items(changes);
    select(a.id, b.id);
    const datas: Record<string, unknown> = {};
    act(() => {
      draws.moveable!.onDragStart({ target: element(a.id), datas, inputEvent: {} });
      draws.moveable!.onDrag({ target: element(a.id), left: a.x + 80, top: a.y + 80, datas });
    });
    expect(element(b.id).style.left).toBe(`${b.x + 80}px`);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect([element(a.id).style.left, element(b.id).style.left]).toEqual([`${a.x}px`, `${b.x}px`]);
    act(() => { draws.moveable!.onDragEnd({ target: element(a.id), isDrag: true, datas, lastEvent: { dist: [80, 80] } }); });
    expect(items(changes).map(({ x }) => x)).toEqual([a.x, b.x]);
  });

  it("sets a style field on every selected plot at once, and puts them all back on the sheet's style", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    act(() => button("+ Biplot").click());
    await flush();
    key({ key: "a", metaKey: true });
    expect(host.textContent).toContain("Style of the 2 selected plots");
    act(() => {
      const input = host.querySelector<HTMLInputElement>('input[aria-label="Contour levels"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "4");
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(items(changes).map((item) => item.recipe)).toEqual([
      expect.objectContaining({ style: { contourLevels: 4 } }),
      expect.objectContaining({ style: { contourLevels: 4 } }),
    ]);
    act(() => button("Follow the sheet").click());
    expect(items(changes).every((item) => !("style" in item.recipe))).toBe(true);
  });

  it("shows the selected plots' own fonts near the top, marks a size they differ in, and sets it on all of them", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    act(() => button("+ Biplot").click());
    await flush();
    const [a, b] = items(changes).map((item) => item.id);
    const set = (label: string, value: string) => act(() => {
      const input = host.querySelector<HTMLInputElement>(`.gl-layout-font-fields input[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    select(a);
    set("Axis font", "16");
    await flush();
    expect(items(changes)[0].recipe).toMatchObject({ style: { fontAxis: 16 } });
    // The long Style list leaves the fonts to the group above it.
    expect(host.querySelector('.gl-layout-item-style input[aria-label="Axis font"]')).toBeNull();
    select(a, b);
    expect(host.querySelector(".gl-layout-font-fields")!.textContent).toContain("Axis (mixed)");
    set("Axis font", "14");
    await flush();
    expect(items(changes).map((item) => item.recipe)).toEqual([
      expect.objectContaining({ style: { fontAxis: 14 } }),
      expect.objectContaining({ style: { fontAxis: 14 } }),
    ]);
    // The sheet's fonts report the plots' and reach every one of them.
    key({ key: "Escape" });
    act(() => button("Style").click());
    expect(host.querySelector<HTMLInputElement>('.gl-layout-font-fields input[aria-label="Axis font"]')!.value).toBe("14");
    set("Axis font", "18");
    await flush();
    expect(items(changes).every((item) => !("style" in item.recipe))).toBe(true);
    expect(changes.at(-1)!.sheets[0].style).toMatchObject({ fontAxis: 18 });
  });

  it("undoes an add another tab made, taking the layout as it was before as its first step", () => {
    const before = createDefaultLayoutWorkspace();
    before.sheets[0].items.push({ id: "kept", x: 57, y: 57, width: 160, height: 32, z: 1, recipe: { kind: "text", text: "Kept", fontSize: 18 } });
    // Handed over once, as App hands it after an add, then gone.
    const takeUndoSeed = vi.fn().mockReturnValueOnce(before).mockReturnValue(null);
    const changes = mount(fixture(), {}, null, { takeUndoSeed });
    expect(takeUndoSeed).toHaveBeenCalled();
    expect(button("Undo").disabled).toBe(false);
    act(() => button("Undo").click());
    expect(items(changes).map((item) => item.id)).toEqual(["kept"]);
    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(false);
  });

  it("keeps its undo history through a visit to another tab, and takes a hand-off made meanwhile as a step on top", () => {
    const fx = fixture();
    const changes: LayoutWorkspace[] = [];
    let show: (shown: boolean) => void = () => {};
    let handOff: () => void = () => {};
    // Held by the parent, as App holds it, so the tab's history outlives the tab.
    const history = { undo: { current: [] as LayoutWorkspace[] }, redo: { current: [] as LayoutWorkspace[] } };
    let seed: LayoutWorkspace | null = null;
    const takeUndoSeed = () => { const taken = seed; seed = null; return taken; };
    function Parent() {
      const [workspace, setWorkspace] = useState(() => createDefaultLayoutWorkspace());
      const [shown, setShown] = useState(true);
      show = setShown;
      handOff = () => setWorkspace((current) => {
        seed = current;
        const next = normalizeLayoutWorkspace(JSON.parse(JSON.stringify(current)));
        next.sheets[0].items.push({ id: "handed", x: 300, y: 300, width: 160, height: 32, z: 9, recipe: { kind: "text", text: "Handed", fontSize: 18 } });
        changes.push(next);
        return next;
      });
      return (
        <I18nProvider>
          {shown ? (
            <LayoutTab
              workspace={workspace}
              onChange={(next) => { changes.push(next); setWorkspace(next); }}
              history={history}
              takeUndoSeed={takeUndoSeed}
              samples={fx.samples}
              checkedSampleIds={["D1", "D2"]}
              activeSampleId="D1"
              activePopulationId={fx.rootId}
              state={fx.state as CoreState}
              globalScales={{}}
              defaultX="FSC-A"
              defaultY="SSC-A"
              illustrationConfig={null}
              dataRevision={0}
              densityColorPower={1.6}
              onOpenInGating={vi.fn()}
            />
          ) : null}
        </I18nProvider>
      );
    }
    act(() => root.render(<Parent />));
    act(() => button("+ Text").click());
    expect(items(changes)).toHaveLength(1);
    // Away to another tab, and back: the add made before is still undone.
    act(() => show(false));
    act(() => show(true));
    expect(button("Undo").disabled).toBe(false);
    act(() => button("Undo").click());
    expect(items(changes)).toHaveLength(0);
    act(() => button("Redo").click());
    expect(items(changes)).toHaveLength(1);
    // Away again; another tab hands an item over, which opens the tab: its undo comes first, then the earlier add's.
    act(() => show(false));
    act(() => handOff());
    act(() => show(true));
    expect(items(changes).map(({ id }) => id)).toContain("handed");
    expect(button("Redo").disabled).toBe(true);
    act(() => button("Undo").click());
    expect(items(changes)).toHaveLength(1);
    expect(items(changes).map(({ id }) => id)).not.toContain("handed");
    act(() => button("Undo").click());
    expect(items(changes)).toHaveLength(0);
    expect(button("Undo").disabled).toBe(true);
  });

  it("records nothing when the sheet already shown is clicked", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    act(() => button("Undo").click());
    const recorded = changes.length;
    expect(button("Redo").disabled).toBe(false);
    act(() => host.querySelector<HTMLButtonElement>(".gl-layout-sheet-tab.active")!.click());
    expect(changes).toHaveLength(recorded);
    expect(button("Redo").disabled).toBe(false);
  });

  it("takes a run of arrow-key nudges on one selection as one undo step", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    const first = items(changes)[0];
    select(first.id);
    key({ key: "ArrowRight" });
    for (let i = 0; i < 4; i++) key({ key: "ArrowRight", repeat: true });
    key({ key: "ArrowDown" });
    expect(items(changes)[0]).toMatchObject({ x: first.x + 5, y: first.y + 1 });
    key({ key: "z", metaKey: true });
    expect(items(changes)[0]).toMatchObject({ x: first.x, y: first.y });
    key({ key: "z", metaKey: true, shiftKey: true });
    expect(items(changes)[0]).toMatchObject({ x: first.x + 5, y: first.y + 1 });
    // After a pause, a press begins a run of its own.
    act(() => { vi.advanceTimersByTime(2000); });
    key({ key: "ArrowRight" });
    expect(items(changes)[0].x).toBe(first.x + 6);
    key({ key: "z", metaKey: true });
    expect(items(changes)[0]).toMatchObject({ x: first.x + 5, y: first.y + 1 });
  });

  it("undoes and redoes the layout from anywhere on the window while the tab is shown, leaving a field's own undo alone", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    const first = items(changes)[0];
    select(first.id);
    key({ key: "ArrowRight" });
    expect(items(changes)[0].x).toBe(58);
    // The keyboard is on a toolbar button, as after a click on Align: the window still undoes the layout.
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, cancelable: true })); });
    expect(items(changes)[0].x).toBe(57);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, cancelable: true })); });
    expect(items(changes)[0].x).toBe(58);
    // In a field the keys are the field's.
    const field = host.querySelector<HTMLInputElement>('input[type="text"], input[type="number"]') ?? host.querySelector("input")!;
    act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); });
    expect(items(changes)[0].x).toBe(58);
    // A press on a toolbar button does not take the keyboard from the page.
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button("Left").dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it("shows no frame on a text block while its editor is open", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    const first = items(changes)[0];
    select(first.id);
    expect(draws.moveable!.target).toBe(element(first.id));
    const editor = openEditor(first.id);
    expect(editor).not.toBeNull();
    expect(draws.moveable!.target).toEqual([]);
    act(() => { editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })); });
    expect(draws.moveable!.target).toBe(element(first.id));
    expect(element(first.id).classList.contains("is-selected")).toBe(true);
  });

  it("hands Moveable the drag of a pressed item at once, even when nothing was selected before", async () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    const first = items(changes)[0];
    key({ key: "Escape" });
    expect(draws.moveable!.target).toEqual([]);
    const press = { target: element(first.id), clientX: 10, clientY: 10 };
    act(() => { draws.selecto!.onSelectEnd({ selected: [element(first.id)], isDragStart: true, isClick: false, inputEvent: press }); });
    await flush();
    expect(draws.moveable!.target).toBe(element(first.id));
    expect(draws.dragStarts).toEqual([press]);
  });

  it("hands no drag to Moveable for the click Selecto is handed back, which reports itself as a drag start as well", async () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    act(() => button("+ Text").click());
    const [a, b] = items(changes);
    select(a.id, b.id);
    act(() => { draws.selecto!.onSelectEnd({ selected: [element(a.id)], removed: [element(b.id)], added: [], isDragStart: true, isClick: true, inputEvent: { target: element(a.id), type: "mousedown" } }); });
    await flush();
    expect([...host.querySelectorAll(".gl-layout-item.is-selected")].map((el) => el.getAttribute("data-item-id"))).toEqual([a.id]);
    expect(draws.dragStarts).toEqual([]);
  });

  it("does not treat a press with a wobble as an edit, and cancels a drag on Escape", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    const first = items(changes)[0];
    select(first.id);
    const edits = changes.length;
    const el = element(first.id);
    // A 1 px wobble: the element is put back and nothing is committed.
    act(() => {
      const datas: Record<string, unknown> = {};
      draws.moveable!.onDragStart({ target: el, datas, inputEvent: {} });
      draws.moveable!.onDrag({ target: el, left: first.x + 1, top: first.y });
      draws.moveable!.onDragEnd({ target: el, isDrag: true, datas, lastEvent: { dist: [1, 0] } });
    });
    expect(changes.length).toBe(edits);
    expect(el.style.left).toBe(`${first.x}px`);
    // Escape mid-drag: the element goes back, Moveable's drag is stopped, and the end commits nothing.
    act(() => {
      const datas: Record<string, unknown> = {};
      draws.moveable!.onDragStart({ target: el, datas, inputEvent: {} });
      draws.moveable!.onDrag({ target: el, left: first.x + 80, top: first.y + 60 });
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      draws.moveable!.onDragEnd({ target: el, isDrag: true, datas, lastEvent: { dist: [80, 60] } });
    });
    expect(draws.stopDrags).toBe(1);
    expect(changes.length).toBe(edits);
    expect(el.style.left).toBe(`${first.x}px`);
    expect(items(changes)[0]).toMatchObject({ x: first.x, y: first.y });
    // A real drag still commits.
    drag(first.id, { x: 200, y: 150 });
    expect(items(changes)[0]).toMatchObject({ x: 200, y: 150 });
  });

  it("forgets a gesture on the pointer's release even when Moveable never ends it, so Escape still deselects", async () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    const first = items(changes)[0];
    select(first.id);
    // A press starts a gesture; the selection changes under it and no end event comes.
    act(() => { draws.moveable!.onDragStart({ target: element(first.id), datas: {}, inputEvent: {} }); });
    act(() => { window.dispatchEvent(new MouseEvent("mouseup")); });
    await flush();
    key({ key: "Escape" });
    expect(host.querySelectorAll(".gl-layout-item.is-selected")).toHaveLength(0);
    expect(draws.stopDrags).toBe(0);
  });

  it("takes a member of a selected group alone on a double-click, and removes a text block left empty", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    act(() => button("+ Text").click());
    const [a, b] = items(changes);
    select(a.id, b.id);
    key({ key: "g", metaKey: true });
    select(a.id);
    expect(host.querySelectorAll(".gl-layout-item.is-selected")).toHaveLength(2);
    act(() => { element(b.id).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect([...host.querySelectorAll(".gl-layout-item.is-selected")].map((el) => el.getAttribute("data-item-id"))).toEqual([b.id]);
    // Emptied in its editor, the block goes; undo brings it back.
    const editor = openEditor(b.id);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "   ");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => editor.blur());
    expect(items(changes)).toHaveLength(1);
    key({ key: "z", metaKey: true });
    expect(items(changes)).toHaveLength(2);
  });

  it("offers Group and Ungroup on the page's own menu while a selection exists", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    act(() => button("+ Text").click());
    const [a, b] = items(changes);
    const canvas = host.querySelector<HTMLElement>(".gl-layout-canvas")!;
    const menuLabels = () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((el) => el.textContent);
    const openPageMenu = () => act(() => { canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 600, clientY: 500 })); });
    openPageMenu();
    expect(menuLabels()).not.toContain("Group");
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    select(a.id, b.id);
    openPageMenu();
    expect(menuLabels()).toContain("Group");
    expect(menuLabels()).not.toContain("Ungroup");
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) => el.textContent === "Group")!.click());
    expect(items(changes)[0].group).toBeTruthy();
    openPageMenu();
    expect(menuLabels()).toContain("Ungroup");
    expect(menuLabels()).not.toContain("Group");
  });

  it("tells Selecto what is selected, and gives a still press on a multi-selection back to it as a click", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    act(() => button("+ Text").click());
    const [a, b] = items(changes);
    select(a.id, b.id);
    expect(draws.selectoTargets).toEqual([element(a.id), element(b.id)]);
    key({ key: "Escape" });
    expect(draws.selectoTargets).toEqual([]);
    select(a.id, b.id);
    // A press on a member of a selected group is Moveable's, for the group's one frame; released
    // without moving, it is the click Selecto is handed, with its Shift. (Loose items each have a
    // frame of their own, which reports its own click.)
    key({ key: "g", metaKey: true });
    const stop = vi.fn();
    act(() => { draws.selecto!.onDragStart({ inputEvent: { target: element(a.id), clientX: 10, clientY: 10, shiftKey: true }, stop }); });
    expect(stop).toHaveBeenCalled();
    act(() => { window.dispatchEvent(new MouseEvent("mouseup", { clientX: 12, clientY: 11 })); });
    expect(draws.selectoClicks).toEqual([{ shift: true, target: element(a.id) }]);
    // Moved, it was a drag and not a click.
    act(() => { draws.selecto!.onDragStart({ inputEvent: { target: element(b.id), clientX: 10, clientY: 10 }, stop }); });
    act(() => { window.dispatchEvent(new MouseEvent("mouseup", { clientX: 40, clientY: 30 })); });
    expect(draws.selectoClicks).toHaveLength(1);
  });

  it("restacks one step with Cmd-] and Cmd-[, to the ends with Shift, and locks with Shift-Cmd-L", () => {
    const changes = mount(fixture());
    for (let i = 0; i < 3; i++) act(() => button("+ Text").click());
    const [a, b, c] = items(changes);
    const name = (id: string) => (id === a.id ? "a" : id === b.id ? "b" : "c");
    /** The stack from the bottom up. */
    const stack = () => [...items(changes)].sort((p, q) => p.z - q.z).map((item) => name(item.id)).join("");
    expect(stack()).toBe("abc");
    select(b.id);
    key({ key: "]", metaKey: true });
    expect(stack()).toBe("acb");
    key({ key: "[", metaKey: true });
    expect(stack()).toBe("abc");
    key({ key: "[", metaKey: true });
    expect(stack()).toBe("bac");
    key({ key: "]", metaKey: true, shiftKey: true });
    expect(stack()).toBe("acb");
    key({ key: "[", metaKey: true, shiftKey: true });
    expect(stack()).toBe("bac");
    // Two moving items pass one still item together.
    select(a.id, c.id);
    key({ key: "[", metaKey: true });
    expect(stack()).toBe("acb");
    key({ key: "l", metaKey: true, shiftKey: true });
    expect(items(changes).map((item) => item.locked === true)).toEqual([true, false, true]);
    key({ key: "l", metaKey: true, shiftKey: true });
    expect(items(changes).some((item) => item.locked)).toBe(false);
  });

  it("reads Shift, Cmd and Option as held: proportions kept, direction held, snapping off, resizing from the centre", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    select(items(changes)[0].id);
    expect(draws.moveable).toMatchObject({ keepRatio: false, throttleDragRotate: 0, snappable: true });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true })); });
    expect(draws.moveable).toMatchObject({ keepRatio: true, throttleDragRotate: 45 });
    act(() => { window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", shiftKey: false })); });
    expect(draws.moveable).toMatchObject({ keepRatio: false, throttleDragRotate: 0 });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true })); });
    expect(draws.moveable!.snappable).toBe(false);
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(draws.moveable!.snappable).toBe(true);
    const fixed = vi.fn();
    act(() => draws.moveable!.onResizeStart({ inputEvent: { altKey: true }, setFixedDirection: fixed }));
    expect(fixed).toHaveBeenCalledWith([0, 0]);
    fixed.mockClear();
    act(() => draws.moveable!.onResizeStart({ inputEvent: { altKey: false }, setFixedDirection: fixed }));
    expect(fixed).not.toHaveBeenCalled();
    act(() => draws.moveable!.onResizeGroupStart({ inputEvent: { altKey: true }, events: [{ setFixedDirection: fixed }, { setFixedDirection: fixed }] }));
    expect(fixed).toHaveBeenCalledTimes(2);
  });

  it("lets a click select a locked item to unlock it, while a marquee, select-all and a spread pass it over", () => {
    const changes = mount(fixture());
    for (let i = 0; i < 4; i++) act(() => button("+ Text").click());
    const [a, b, c, d] = items(changes);
    select(a.id); drag(a.id, { x: 100, y: 100 });
    select(b.id); drag(b.id, { x: 100, y: 250 });
    select(c.id); drag(c.id, { x: 100, y: 400 });
    select(d.id); drag(d.id, { x: 100, y: 700 });
    select(c.id);
    act(() => [...host.querySelectorAll<HTMLLabelElement>("label.gl-check")].find((label) => label.textContent?.trim() === "Locked")!.querySelector("input")!.click());
    expect(items(changes)[2].locked).toBe(true);
    // A marquee over all four takes three.
    act(() => draws.selecto!.onSelectEnd({ selected: [a, b, c, d].map((item) => element(item.id)), isDragStart: false, isClick: false, inputEvent: {} }));
    const selected = () => [...host.querySelectorAll(".gl-layout-item.is-selected")].map((el) => el.getAttribute("data-item-id"));
    expect(selected()).toEqual([a.id, b.id, d.id]);
    key({ key: "a", metaKey: true });
    expect(selected()).toEqual([a.id, b.id, d.id]);
    // Spreading the selection leaves the locked item where it is.
    act(() => button("Distribute ↕").click());
    expect(items(changes).map((item) => item.y)).toEqual([100, 400, 400, 700]);
    // A click still takes it, so it can be unlocked.
    select(c.id);
    expect(selected()).toEqual([c.id]);
    expect(host.textContent).toContain("Locked");
  });
  it("applies a menu's choice made after an undo to the workspace as it is now", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    act(() => button("+ Text").click());
    const [a, b] = items(changes);
    select(b.id);
    key({ key: "Delete" });
    expect(items(changes).map((item) => item.id)).toEqual([a.id]);
    const menuItem = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent === label)!;
    act(() => { element(a.id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 150 })); });
    // Undo while the menu is open (the keyboard is in the menu): b comes back.
    act(() => { menuItem("Lock").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "z", metaKey: true })); });
    expect(items(changes).map((item) => item.id)).toEqual([a.id, b.id]);
    act(() => menuItem("Lock").click());
    expect(items(changes).map((item) => [item.id, !!item.locked])).toEqual([[a.id, true], [b.id, false]]);
    // That choice is one undo step on what was there.
    key({ key: "z", metaKey: true });
    expect(items(changes).map((item) => [item.id, !!item.locked])).toEqual([[a.id, false], [b.id, false]]);
  });
});

describe("LayoutTab text blocks", () => {
  it("shows a text block as static words, opens its editor on a double-click or Enter, and keeps what was typed on Escape", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    act(() => button("+ Text").click());
    const [a, b] = items(changes);
    // As placed: no editor, so the block is Moveable's to drag by its body.
    expect(element(a.id).querySelector("textarea")).toBeNull();
    expect(element(a.id).querySelector(".gl-layout-text-surface.is-static")?.textContent).toBe("Text");
    select(a.id, b.id);
    expect(host.querySelectorAll(".gl-layout-item.is-selected")).toHaveLength(2);
    // A double-click on the words opens the editor on that block alone, with the keyboard in it.
    const editor = openEditor(a.id);
    expect(editor).not.toBeNull();
    expect(host.querySelectorAll(".gl-layout-item.is-selected")).toHaveLength(1);
    expect(element(a.id).classList.contains("is-selected")).toBe(true);
    expect(document.activeElement).toBe(editor);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Figure 1");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => { editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })); });
    // Escape leaves the editor keeping the words; the block stays selected and the page has the keyboard.
    expect(items(changes)[0].recipe).toMatchObject({ kind: "text", text: "Figure 1" });
    expect(element(a.id).querySelector("textarea")).toBeNull();
    expect(element(a.id).querySelector(".gl-layout-text-surface")?.textContent).toBe("Figure 1");
    expect(element(a.id).classList.contains("is-selected")).toBe(true);
    expect(document.activeElement).toBe(page());
    // Enter with the block selected opens the editor too; a click elsewhere (blur) closes it.
    key({ key: "Enter" });
    const again = element(a.id).querySelector<HTMLTextAreaElement>("textarea")!;
    expect(again).not.toBeNull();
    expect(again.value).toBe("Figure 1");
    act(() => again.blur());
    expect(element(a.id).querySelector("textarea")).toBeNull();
    // Enter opens the editor of whichever text block is the one selected.
    select(b.id);
    key({ key: "Enter" });
    expect(element(b.id).querySelector("textarea")).not.toBeNull();
    expect(element(a.id).querySelector("textarea")).toBeNull();
  });
});

describe("LayoutTab page, zoom and export", () => {
  const selectField = (label: string) => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.startsWith(label))?.querySelector("select")!;
  const change = (el: HTMLSelectElement | HTMLInputElement, value: string) => act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

  it("sizes the page from a preset and its orientation, in millimetres, and lays out a grid of pages", () => {
    const changes = mount(fixture());
    act(() => button("Page").click());
    const canvas = () => host.querySelector<HTMLElement>(".gl-layout-canvas")!;
    expect(canvas().style.width).toBe("1123px");
    expect(host.querySelectorAll(".gl-layout-page")).toHaveLength(1);
    expect(host.querySelector(".gl-layout-page-margin")).not.toBeNull();
    change(selectField("Size"), "journal-1");
    expect(changes.at(-1)?.sheets[0].page).toMatchObject({ preset: "journal-1", orientation: "landscape", marginMm: 0 });
    expect([canvas().style.width, canvas().style.height]).toEqual(["416px", "321px"]);
    expect(host.querySelector(".gl-layout-page-margin")).toBeNull();
    change(selectField("Orientation"), "portrait");
    expect([canvas().style.width, canvas().style.height]).toEqual(["321px", "416px"]);
    change(host.querySelector<HTMLInputElement>('input[aria-label="Width (mm)"]')!, "120");
    expect(changes.at(-1)?.sheets[0].page).toMatchObject({ preset: "custom", widthMm: 120, heightMm: 110 });
    expect(canvas().style.width).toBe("454px");
    change(selectField("Orientation"), "landscape");
    change(host.querySelector<HTMLInputElement>('input[aria-label="Width (mm)"]')!, "200");
    expect(changes.at(-1)?.sheets[0].page).toMatchObject({ widthMm: 120, heightMm: 200 });
    expect(canvas().style.width).toBe("756px");

    // Two pages across, one down: the canvas doubles and both pages are drawn.
    change(host.querySelector<HTMLInputElement>('input[aria-label="Pages across"]')!, "2");
    expect(changes.at(-1)?.sheets[0].page.columns).toBe(2);
    expect(canvas().style.width).toBe("1512px");
    expect(host.querySelectorAll(".gl-layout-page")).toHaveLength(2);
    expect(draws.moveable!.target).toEqual([]); // nothing selected, nothing to move
  });

  it("fits the page to the content and the content to the page", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    act(() => button("+ Text").click());
    const [a, b] = items(changes);
    select(a.id); drag(a.id, { x: 300, y: 200 });
    select(b.id); drag(b.id, { x: 700, y: 500 });
    act(() => button("Page").click());
    act(() => button("Fit page to content").click());
    expect(changes.at(-1)?.sheets[0].page.preset).toBe("custom");
    expect(items(changes).map(({ x, y }) => [x, y])).toEqual([[57, 57], [457, 357]]);
    // With nothing selected, the page's items are fitted to it as one group.
    select();
    act(() => button("Fit content to page").click());
    expect(items(changes).map(({ x, y }) => [x, y])).toEqual([[57, 57], [457, 357]]); // already filling the page
    // With an item selected, that item alone is fitted to the page it is on; the other stays.
    const other = items(changes)[0];
    select(b.id);
    act(() => button("Fit selection to page").click());
    const [first, fitted] = items(changes);
    expect(first).toMatchObject({ x: other.x, y: other.y, width: other.width, height: other.height });
    const page = changes.at(-1)!.sheets[0];
    expect(fitted.x).toBeGreaterThanOrEqual(57);
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(page.width - 57 + 1);
    expect(fitted.width).toBeGreaterThan(b.width);
  });

  it("zooms with Option-scroll, Shift-scroll or a pinch, and scrolls with a plain wheel", async () => {
    mount(fixture());
    await flush();
    const scroller = page();
    const wheel = (init: WheelEventInit) => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
      act(() => { scroller.dispatchEvent(event); });
      return event.defaultPrevented;
    };
    expect(wheel({ deltaY: 100 })).toBe(false);
    expect(host.querySelector(".gl-layout-zoom-level")?.textContent).toBe("100%");
    expect(wheel({ deltaY: -200, altKey: true })).toBe(true);
    expect(host.querySelector(".gl-layout-zoom-level")?.textContent).toBe("165%");
    expect(wheel({ deltaX: 200, shiftKey: true })).toBe(true);
    expect(host.querySelector(".gl-layout-zoom-level")?.textContent).toBe("100%");
    expect(wheel({ deltaY: 100, ctrlKey: true })).toBe(true);
    expect(host.querySelector(".gl-layout-zoom-level")?.textContent).toBe("78%");
  });

  it("draws a plot once when it is added and again only when its size changes, not for a selection or a move", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    const [first, second] = items(changes);
    expect(second).toBeDefined();
    // Each plot was drawn exactly once: adding the second did not redraw the first.
    expect(draws.plots).toHaveLength(2);
    select(first.id);
    await flush();
    expect(draws.plots).toHaveLength(2);
    drag(first.id, { x: 200, y: 150 });
    await flush();
    expect(items(changes)[0]).toMatchObject({ x: 200, y: 150 });
    expect(draws.plots).toHaveLength(2);
    select();
    key({ key: "a", metaKey: true });
    key({ key: "ArrowRight" });
    await flush();
    expect(host.querySelectorAll(".gl-layout-item.is-selected")).toHaveLength(2);
    expect(draws.plots).toHaveLength(2);
    // A resize changes what the plot draws, so that plot, and only that plot, is drawn again.
    act(() => {
      const el = element(first.id);
      draws.moveable!.onResize({ target: el, width: 320, height: 320, drag: { left: 201, top: 150 } });
      draws.moveable!.onResizeEnd({ target: el, isDrag: true, datas: {} });
    });
    await flush();
    expect(draws.plots).toHaveLength(3);
    expect(draws.plots.at(-1)!.host).toBe(element(first.id).querySelector(".gl-layout-plot-host"));
  });

  it("draws a plot's canvas at the display ratio times the page zoom, once the zoom has settled", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    expect(items(changes)).toHaveLength(1);
    // jsdom reports a pixel ratio of 1, so at 100% the canvas is drawn 1:1.
    expect(draws.plots.at(-1)?.config.canvas_scale).toBe(1);
    const before = draws.plots.length;
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click());
    expect(host.querySelector(".gl-layout-zoom-level")?.textContent).toBe("150%");
    // Not yet: the zoom is taken once it has settled, so a gesture does not redraw at each step.
    expect(draws.plots.length).toBe(before);
    await flush();
    expect(draws.plots.length).toBeGreaterThan(before);
    expect(draws.plots.at(-1)?.config.canvas_scale).toBe(1.5);
  });

  it("zooms the page in steps and exports the sheet in the chosen format", async () => {
    const changes = mount(fixture());
    const canvas = () => host.querySelector<HTMLElement>(".gl-layout-canvas")!;
    expect(canvas().style.transform).toBe("scale(1)");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click());
    expect(canvas().style.transform).toBe("scale(1.5)");
    expect(host.querySelector(".gl-layout-zoom-level")?.textContent).toBe("150%");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Zoom out"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Zoom out"]')!.click());
    expect(canvas().style.transform).toBe("scale(0.75)");
    expect(button("Export PDF").disabled).toBe(true);
    act(() => button("+ Text").click());
    expect(items(changes)).toHaveLength(1);
    // Moveable is told the page's scale so its handles keep their size.
    select(items(changes)[0].id);
    expect(draws.moveable!.zoom).toBeCloseTo(1 / 0.75);
    act(() => button("Export").click());
    change(selectField("Format"), "svg");
    // A sheet of one page is waited for too, so a plot drawn a moment ago is not written half drawn.
    await act(async () => { button("Export SVG").click(); await vi.runAllTimersAsync(); });
    expect(draws.exports).toEqual([{ name: "Layout 1", format: "svg", pages: 1 }]);
    await act(async () => { button("Export sheet").click(); await vi.runAllTimersAsync(); });
    expect(draws.exports).toHaveLength(2);
  });
});

describe("LayoutTab page commands and the page an item is on", () => {
  /** A sheet of one page across and two down, with a text block on the second page. */
  function itemOnSecondPage(): LayoutWorkspace {
    const workspace = createDefaultLayoutWorkspace();
    const sheet = workspace.sheets[0];
    Object.assign(sheet, { page: { ...sheet.page, rows: 2 }, height: 2 * 794 });
    sheet.items.push({ id: "second", x: 300, y: 794 + 300, width: 200, height: 60, z: 1, recipe: { kind: "text", text: "note", fontSize: 14 } });
    return workspace;
  }

  it("aligns one item to the margin of the page it is on, not the first page", () => {
    const changes = mount(fixture(), {}, null, {}, itemOnSecondPage());
    select("second");
    act(() => button("Top").click());
    expect(items(changes)[0]).toMatchObject({ x: 300, y: 794 + 57 });
    act(() => button("Left").click());
    expect(items(changes)[0]).toMatchObject({ x: 57, y: 794 + 57 });
  });

  const selectField = (label: string) => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.startsWith(label))?.querySelector("select")!;
  const inputField = (label: string) => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.startsWith(label))?.querySelector("input")!;
  const change = (el: HTMLSelectElement | HTMLInputElement, value: string) => act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

  it("holds the margin to one that leaves room on the page, and the field shows what is kept", () => {
    const changes = mount(fixture(), {}, null, {}, itemOnSecondPage());
    act(() => button("Page").click());
    change(selectField("Size"), "journal-1"); // 110 x 85 mm, 416 x 321 px
    change(inputField("Margin (mm)"), "60");
    expect(changes.at(-1)!.sheets[0].page.marginMm).toBe(42);
    expect(inputField("Margin (mm)").value).toBe("42");
    // A smaller page takes the margin down with it.
    change(host.querySelector<HTMLInputElement>('input[aria-label="Height (mm)"]')!, "40");
    expect(changes.at(-1)!.sheets[0].page.marginMm).toBe(19);
    expect(inputField("Margin (mm)").value).toBe("19");
  });

  it("says under Page when a change of page leaves items off the pages, and adds the pages that hold them", () => {
    const workspace = createDefaultLayoutWorkspace();
    workspace.sheets[0].items.push({ id: "right", x: 800, y: 100, width: 200, height: 60, z: 1, recipe: { kind: "text", text: "note", fontSize: 14 } });
    const changes = mount(fixture(), {}, null, {}, workspace);
    act(() => button("Page").click());
    const warning = () => host.querySelector<HTMLElement>(".gl-layout-export-warning");
    expect(warning()).toBeNull();
    change(selectField("Orientation"), "portrait"); // 794 px wide: the item now runs past the page
    expect(warning()?.textContent).toContain("1 item lies partly or wholly outside the sheet's pages");
    act(() => button("Add pages to hold them").click());
    const sheet = changes.at(-1)!.sheets[0];
    expect([sheet.page.columns, sheet.page.rows]).toEqual([2, 1]);
    expect(sheet.items[0]).toMatchObject({ x: 800, y: 100 });
    expect(warning()).toBeNull();
  });

  it("fits the page to the shown items, moves the guides with them, and says when the page is as large as it may be", () => {
    const note = (id: string, x: number, y: number, hidden?: boolean) => ({ id, x, y, width: 200, height: 60, z: 1, ...(hidden ? { hidden } : {}), recipe: { kind: "text" as const, text: id, fontSize: 14 } });
    const workspace = createDefaultLayoutWorkspace();
    workspace.sheets[0].items.push(note("a", 300, 200), note("b", 700, 500), note("h", 5000, 5000, true));
    workspace.sheets[0].guides = [{ axis: "x", at: 300 }];
    const changes = mount(fixture(), {}, null, {}, workspace);
    act(() => button("Page").click());
    act(() => button("Fit page to content").click());
    let sheet = changes.at(-1)!.sheets[0];
    expect(sheet.items.slice(0, 2).map(({ x, y }) => [x, y])).toEqual([[57, 57], [457, 357]]);
    expect(sheet.page).toMatchObject({ widthMm: 188.9, heightMm: 125.4 }); // the hidden item is not counted
    expect(sheet.guides).toEqual([{ axis: "x", at: 57 }]);
    expect(host.querySelector(".gl-layout-message")).toBeNull();

    // Content wider than the largest page: the page stops there and the content is scaled to stay on it.
    act(() => button("+ Text").click());
    const added = items(changes).at(-1)!;
    select(added.id); drag(added.id, { x: 9000, y: 100 });
    act(() => button("Page").click());
    act(() => button("Fit page to content").click());
    sheet = changes.at(-1)!.sheets[0];
    expect(sheet.page.widthMm).toBeLessThanOrEqual(2000);
    expect(sheet.items.filter((item) => !item.hidden).every((item) => item.x + item.width <= sheet.width)).toBe(true);
    expect(host.querySelector(".gl-layout-message")?.textContent).toContain("2000 mm");
  });
});

describe("LayoutTab iteration", () => {
  const selectField = (label: string) => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.startsWith(label))?.querySelector("select")!;
  const change = (el: HTMLSelectElement | HTMLInputElement, value: string) => act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

  it("draws a strategy strip for each file, titled by the sheet's template as the plots are", async () => {
    const fx = gatedFixture();
    const changes = mount(fx, { "FSC-A": [5, 40], "SSC-A": [5, 40] }, null, { activePopulationId: fx.childId }, iteratingSheet());
    await flush();
    act(() => button("Iterate").click());
    expect(selectField("Draw the sheet").value).toBe("files");
    // Added to a sheet that iterates, the strategy follows it as a toolbar plot does.
    act(() => button("+ Gating strategy").click());
    await flush();
    const [strategy] = items(changes);
    expect(strategy.recipe).toMatchObject({ kind: "strategy", sampleId: "D1", iterated: true });
    const title = () => (draws.strategies.at(-1)?.payload as { strategy_context_title?: string }).strategy_context_title;
    expect(title()).toBe("D1.fcs");
    draws.strategies = [];
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click());
    await flush();
    expect(title()).toBe("D2.fcs");
    // "No title" on the sheet reaches the strategy too.
    act(() => button("Style").click());
    change(host.querySelector<HTMLSelectElement>('select[aria-label="Plot titles"]')!, "none");
    await flush();
    expect(title()).toBe("");
  });

  it("draws a strip from the Strategy tab with the columns and appearance it was sent with", async () => {
    // A two-step path: All Events › Lymphocytes › CD4_positive.
    const fx = gatedFixture();
    const cd4 = newPopulation("CD4_positive", [], fx.childId);
    const cd4Gate = newGate("CD4_gate", "rectangle", "FSC-A", "SSC-A", [[0, 0], [40, 40]]);
    cd4.gate_refs = [{ gate_id: cd4Gate.gate_id, include: true }];
    fx.state.gates[cd4Gate.gate_id] = cd4Gate;
    fx.state.gate_order.push(cd4Gate.gate_id);
    fx.state.populations[cd4.population_id] = cd4;
    fx.state.populations[fx.childId].children = [cd4.population_id];
    const strip = { kind: "strategy" as const, sampleId: "D1", populationId: cd4.population_id, fullPath: true, displayMode: "pseudocolor" as const };
    const workspace = createDefaultLayoutWorkspace();
    workspace.sheets[0].items.push({ id: "strip", x: 57, y: 57, width: 600, height: 320, z: 1, recipe: strip });
    mount(fx, {}, null, {}, workspace);
    await flush();
    // Fitted to the frame, two steps side by side draw largest.
    const drawn = () => draws.strategies.at(-1)!.payload as { n_columns: number; plot_size: number; contour_levels: number; gate_style: Record<string, unknown> };
    expect(drawn().n_columns).toBe(2);
    // Sent as one column, bold labels on a light backing and 4 contour levels, it is drawn so.
    const sent = createDefaultLayoutWorkspace();
    sent.sheets[0].items.push({ id: "strip", x: 57, y: 57, width: 600, height: 320, z: 1, recipe: { ...strip, columns: 1, gateLabelBold: true, labelBackground: 0.3, style: { contourLevels: 4 } } });
    draws.strategies = [];
    act(() => root.unmount());
    root = createRoot(host);
    mount(fx, {}, null, {}, sent);
    await flush();
    expect(drawn()).toMatchObject({ n_columns: 1, plot_size: Math.floor((320 - 8 - 26 - 8) / 2), contour_levels: 4, gate_style: { label_weight: "bold", label_background: 0.3 } });
  });

  it("draws a strip in a small frame at the smallest panel, shown scaled to fit rather than scrolling", async () => {
    const fx = gatedFixture();
    const strip = { kind: "strategy" as const, sampleId: "D1", populationId: fx.childId, fullPath: true, displayMode: "pseudocolor" as const };
    const workspace = createDefaultLayoutWorkspace();
    // 150 px tall: the one panel fits at 150 - 8 - 26 = 116 px, under the renderer's 120.
    workspace.sheets[0].items.push({ id: "strip", x: 57, y: 57, width: 300, height: 150, z: 1, recipe: strip });
    mount(fx, {}, null, {}, workspace);
    await flush();
    expect((draws.strategies.at(-1)!.payload as { plot_size: number }).plot_size).toBe(120);
    expect(Number(element("strip").querySelector<HTMLElement>(".strategy-grid")!.style.zoom)).toBeCloseTo(116 / 120, 4);
  });

  it("marks a plot as pending until it has drawn, which the export waits for", async () => {
    mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    expect(host.querySelector(".gl-layout-plot-host")?.hasAttribute("data-layout-pending")).toBe(true);
    await flush();
    expect(draws.plots.length).toBeGreaterThan(0);
    expect(host.querySelector("[data-layout-pending]")).toBeNull();
  });

  it("says in the block when a plot could not be drawn, holds no export for it, and draws it once the cause is gone", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mount(fixture());
    await flush();
    draws.fail = "synthetic drawing failure";
    try {
      act(() => button("+ Biplot").click());
      await flush();
      const plot = host.querySelector<HTMLElement>(".gl-layout-plot-host")!;
      expect(plot.textContent).toContain("This block could not be drawn");
      expect(plot.textContent).toContain("synthetic drawing failure");
      expect(plot.classList.contains("is-missing")).toBe(true);
      expect(host.querySelector("[data-layout-pending]")).toBeNull();
      expect(logged).toHaveBeenCalled();
    } finally {
      draws.fail = null;
    }
    // The cause gone, the next drawing of the block is the plot.
    draws.plots = [];
    act(() => button("Style").click());
    change(host.querySelector<HTMLSelectElement>('select[aria-label="Plot titles"]')!, "none");
    await flush();
    const plot = host.querySelector<HTMLElement>(".gl-layout-plot-host")!;
    expect(draws.plots.length).toBeGreaterThan(0);
    expect(plot.textContent).not.toContain("This block could not be drawn");
    expect(plot.classList.contains("is-missing")).toBe(false);
    logged.mockRestore();
  });

  it("starts tiles at as many as fit the paper, and says when a grid asked for runs off it", async () => {
    const changes = mount(fixture(), {}, null, {}, iteratingSheet());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    act(() => button("Iterate").click());
    change(selectField("Arrangement"), "tiles");
    // A4 landscape, a 260 × 280 plot at the margin, a 24 px gap: 3 across and 2 down fit.
    expect(changes.at(-1)!.sheets[0].iteration?.arrangement).toMatchObject({ kind: "tiles", columns: 3, rows: 2 });
    expect(host.querySelector(".gl-layout-warning")).toBeNull();
    const across = host.querySelector<HTMLInputElement>('input[aria-label="Tiles across"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(across, "1");
      across.dispatchEvent(new Event("input", { bubbles: true }));
      across.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    // Two files on one row of one tile each: still on the paper.
    expect(host.querySelector(".gl-layout-warning")).toBeNull();
    // The plot widened past the paper's half: its second tile runs off the sheet.
    act(() => button("Items").click());
    select(items(changes)[0].id);
    // The item's fields show mm by default; this width is in px.
    act(() => button("px").click());
    const width = host.querySelector<HTMLInputElement>('input[aria-label="Item width"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(width, "700");
      width.dispatchEvent(new Event("input", { bubbles: true }));
      width.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    act(() => button("Iterate").click());
    change(host.querySelector<HTMLInputElement>('input[aria-label="Tiles across"]')!, "2");
    act(() => host.querySelector<HTMLInputElement>('input[aria-label="Tiles across"]')!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(host.querySelector(".gl-layout-warning")?.textContent).toContain("1 of 2 items on this page reach beyond the paper");
    act(() => button("Fit the tiles to the page").click());
    expect(changes.at(-1)!.sheets[0].iteration?.arrangement).toMatchObject({ columns: 1 });
    expect(host.querySelector(".gl-layout-warning")).toBeNull();
  });

  it("draws the sheet once per file, with placeholders filled, and exports every page", async () => {
    const changes = mount(fixture(), { "FSC-A": [5, 40], "SSC-A": [5, 40] }, null, {}, iteratingSheet());
    await flush();
    act(() => button("+ Biplot").click());
    act(() => button("+ Text").click());
    await flush();
    const [plot, note] = items(changes);
    // The text reads a placeholder; while it is edited the placeholder itself is shown.
    const editor = openEditor(note.id);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Donor {sample}, day {meta:day} ({n}/{N})");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => editor.blur());
    expect(items(changes)[1].recipe).toMatchObject({ text: "Donor {sample}, day {meta:day} ({n}/{N})" });

    act(() => button("Iterate").click());
    expect(changes.at(-1)?.sheets[0].iteration).toMatchObject({ mode: "files", source: { kind: "checked" } });
    // Added to a sheet that iterates, the plot follows the iteration.
    expect(items(changes)[0].recipe).toMatchObject({ iterated: true });
    expect(host.textContent).toContain("Page 1 of 2");
    expect(host.textContent).toContain("2 files → 2 pages");
    expect(element(note.id).querySelector(".gl-layout-text-surface")?.textContent).toBe("Donor D1.fcs, day 7 (1/2)");
    draws.plots = [];
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click());
    expect(host.textContent).toContain("Page 2 of 2");
    expect(element(note.id).querySelector(".gl-layout-text-surface")?.textContent).toBe("Donor D2.fcs, day 0 (2/2)");
    await flush();
    // On page 2 the plot is drawn for D2. Unticked, it would show D1 on every page. The automatic
    // title looks across the pages: one population, a file per page, so the file names it.
    expect(draws.plots.at(-1)?.config.title).toBe("D2.fcs");
    select(plot.id);
    act(() => button("Items").click());
    const follows = [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("Follows the iteration"))!.querySelector("input")!;
    expect(follows.checked).toBe(true);
    act(() => follows.click());
    expect(items(changes)[0].recipe).not.toMatchObject({ iterated: true });
    act(() => follows.click());
    expect(items(changes)[0].recipe).toMatchObject({ iterated: true });
    await flush();
    // A drag on page 2 edits the template.
    drag(plot.id, { x: 300, y: 200 });
    expect(items(changes)[0]).toMatchObject({ x: 300, y: 200 });

    // Tiles: two across on one page, the second tile's copy offset by the template's extent plus
    // the gap. The note was placed beside the plot (x = 337); after the drag the plot spans
    // 300..560 and the note 337..497, so the extent is 260 wide and the step 284.
    expect(items(changes)[1]).toMatchObject({ x: 337, y: 57 });
    act(() => button("Iterate").click());
    change(selectField("Arrangement"), "tiles");
    expect(host.textContent).toContain("Page 1 of 1");
    expect(host.querySelectorAll(".gl-layout-item")).toHaveLength(4);
    const copies = [...host.querySelectorAll<HTMLElement>(".gl-layout-item")].map((el) => [el.dataset.itemId, el.style.left]);
    expect(copies).toEqual([[plot.id, "300px"], [note.id, "337px"], [`${plot.id}::1`, "584px"], [`${note.id}::1`, "621px"]]);

    // Export writes every page of the iteration (one page per file: two).
    change(selectField("Arrangement"), "page-per-unit");
    act(() => button("Export").click());
    await act(async () => { button("Export sheet").click(); await vi.runAllTimersAsync(); });
    expect(draws.exports.at(-1)).toEqual({ name: "Layout 1", format: "pdf", pages: 2 });
  });

  const menuItems = () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((entry) => entry.textContent);
  const openMenu = (id: string) => act(() => { element(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 150 })); });
  const followBox = () => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("Follows the iteration"));

  it("offers no iteration on a sheet that does not iterate, and leaves the plots added to it unmarked", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    act(() => button("+ Gating strategy").click());
    await flush();
    const [plot, strategy] = items(changes);
    expect(plot.recipe).not.toHaveProperty("iterated");
    expect(strategy.recipe).not.toHaveProperty("iterated");
    expect(button("Iterate")).toBeUndefined();
    expect(host.querySelector('[aria-label="Pages of the iteration"]')).toBeNull();
    expect(button("Export PDF").title).not.toContain("iteration");
    select(plot.id);
    act(() => button("Items").click());
    expect(followBox()).toBeUndefined();
    openMenu(plot.id);
    expect(menuItems()).not.toContain("Follow the iteration");
    expect(menuItems()).not.toContain("Stop following the iteration");
  });

  it("keeps a saved iteration with its controls, and Once removes the Iterate tab until undone", async () => {
    const changes = mount(fixture(), {}, null, {}, iteratingSheet());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    const [plot] = items(changes);
    expect(plot.recipe).toMatchObject({ iterated: true });
    expect(host.querySelector('[aria-label="Pages of the iteration"]')).not.toBeNull();
    expect(host.textContent).toContain("Page 1 of 2");
    expect(button("Export PDF").title).toContain("iteration");
    select(plot.id);
    act(() => button("Items").click());
    expect(followBox()).toBeDefined();
    openMenu(plot.id);
    expect(menuItems()).toContain("Stop following the iteration");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    act(() => button("Iterate").click());
    expect(host.textContent).toContain("Iteration is being retired from Layout");
    change(selectField("Draw the sheet"), "off");
    expect(changes.at(-1)!.sheets[0]).not.toHaveProperty("iteration");
    // The tab goes, and the inspector shows Items.
    expect(button("Iterate")).toBeUndefined();
    expect(button("Items").getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('[aria-label="Pages of the iteration"]')).toBeNull();
    act(() => button("Undo").click());
    expect(changes.at(-1)!.sheets[0].iteration).toMatchObject({ mode: "files" });
    expect(button("Iterate")).toBeDefined();
    expect(host.textContent).toContain("Page 1 of 2");
  });
});

describe("pooled Layout plots", () => {
  const poolBox = () => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("Pool files"))!.querySelector("input")!;
  const chip = (value: string) => [...host.querySelectorAll<HTMLButtonElement>(".gl-layout-pool .gl-sample-facet-chip")].find((b) => b.querySelector(".gl-sample-facet-label")?.textContent === value)!;
  type Drawn = { name: string; event_count: number; percent_of_parent: number };

  it("pools the checked files on one plot, draws the gate with its pooled percentage, and names the pool", async () => {
    const changes = mount(gatedFixture(), { "FSC-A": [0, 40], "SSC-A": [0, 40] });
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    const [plot] = items(changes);
    // One file: its three events, the gate holding one of them.
    expect(draws.plots.at(-1)?.config.x).toHaveLength(3);
    expect((draws.plots.at(-1)?.config.gates as Drawn[]).map((g) => [g.name, g.percent_of_parent])).toEqual([["Lymph_gate", 33.33]]);
    select(plot.id);
    act(() => button("Items").click());
    act(() => poolBox().click());
    expect(items(changes)[0].recipe).toMatchObject({ sampleId: "D1", pool: { sampleIds: ["D1", "D2"] } });
    await flush();
    const config = draws.plots.at(-1)!.config;
    // Both files' events on one plot; the gate holds two of the six, pooled.
    expect(config.x).toHaveLength(6);
    expect(config.n_events).toBe(6);
    expect((config.gates as Drawn[]).map((g) => [g.name, g.event_count, g.percent_of_parent])).toEqual([["Lymph_gate", 2, 33.33]]);
    expect(config.title).toBe("All Events · 2 files");
    expect(host.textContent).toContain("2 of 2 files pooled");
    // Unticked, the plot is its reference file's again.
    act(() => poolBox().click());
    expect(items(changes)[0].recipe).not.toHaveProperty("pool");
    await flush();
    expect(draws.plots.at(-1)!.config.x).toHaveLength(3);
  });

  it("draws a pooled strategy, strip or grid, from every pooled file's events and names the pool", async () => {
    const fx = gatedFixture();
    const workspace = createDefaultLayoutWorkspace();
    const pool = { sampleIds: ["D1", "D2"] };
    workspace.sheets[0].items.push(
      { id: "strip", x: 57, y: 57, width: 400, height: 300, z: 1, recipe: { kind: "strategy", sampleId: "D1", populationId: fx.childId, fullPath: true, displayMode: "pseudocolor", pool } },
      { id: "grid", x: 57, y: 400, width: 600, height: 300, z: 2, recipe: { kind: "strategy", sampleId: "D1", populationId: fx.childId, populationIds: [fx.childId], fullPath: true, displayMode: "pseudocolor", title: "{sample}", pool } },
    );
    mount(fx, { "FSC-A": [0, 40], "SSC-A": [0, 40] }, null, {}, workspace);
    await flush();
    const strip = draws.strategies.at(-1)!.payload as { steps: { n_before: number; n_after: number; x: number[] }[]; strategy_context_title: string };
    // Both files' three events on the step; the gate holds one of each.
    expect(strip.steps).toHaveLength(1);
    expect(strip.steps[0]).toMatchObject({ n_before: 6, n_after: 2 });
    expect(strip.steps[0].x).toHaveLength(6);
    expect(strip.strategy_context_title).toBe("Lymphocytes · 2 files");
    const grid = draws.multiStrategies.at(-1)!.payload as { nodes: { n_events: number; x: number[] }[]; strategy_context_title: string };
    expect(grid.nodes.map((node) => [node.n_events, node.x.length])).toEqual([[6, 6]]);
    expect(grid.strategy_context_title).toBe("2 files");
  });

  it("draws a strategy's gate edges as the Strategy tab sent them, and the default when it sent none", async () => {
    const fx = gatedFixture();
    const workspace = createDefaultLayoutWorkspace();
    const strip = { kind: "strategy" as const, sampleId: "D1", populationId: fx.childId, fullPath: true, displayMode: "pseudocolor" as const };
    workspace.sheets[0].items.push(
      { id: "plain", x: 57, y: 57, width: 400, height: 300, z: 1, recipe: strip },
      { id: "edged", x: 57, y: 400, width: 400, height: 300, z: 2, recipe: { ...strip, gateEdgeMode: "straight" } },
      { id: "grid", x: 500, y: 57, width: 600, height: 300, z: 3, recipe: { ...strip, populationIds: [fx.childId], gateEdgeMode: "bowed" } },
    );
    mount(fx, { "FSC-A": [0, 40], "SSC-A": [0, 40] }, null, {}, workspace);
    await flush();
    const edgeOf = (id: string, drawn: { id: string; payload: unknown }[]) =>
      (drawn.filter((entry) => entry.id === `layout-strategy-${id}`).at(-1)!.payload as { gate_style: { gate_edge_mode: string } }).gate_style.gate_edge_mode;
    expect(edgeOf("plain", draws.strategies)).toBe("straight-bow");
    expect(edgeOf("edged", draws.strategies)).toBe("straight");
    expect(edgeOf("grid", draws.multiStrategies)).toBe("bowed");
  });

  it("picks the pool with the metadata chips, in file order", async () => {
    const changes = mount(gatedFixture(true), { "FSC-A": [0, 40], "SSC-A": [0, 40] }, null, { checkedSampleIds: ["D1", "D2", "D3"] });
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    const [plot] = items(changes);
    select(plot.id);
    act(() => button("Items").click());
    act(() => poolBox().click());
    expect(items(changes)[0].recipe).toMatchObject({ pool: { sampleIds: ["D1", "D2", "D3"] } });
    // The day chips: "0" is D2 alone, pooled in full, so a click drops it; "7" is D1 and D3.
    expect(chip("0").textContent).toBe("01/1");
    expect(chip("7").textContent).toBe("72/2");
    act(() => chip("0").click());
    expect(items(changes)[0].recipe).toMatchObject({ sampleId: "D1", pool: { sampleIds: ["D1", "D3"] } });
    await flush();
    const config = draws.plots.at(-1)!.config;
    expect(config.x).toHaveLength(6);
    expect((config.gates as Drawn[]).map((g) => [g.event_count, g.percent_of_parent])).toEqual([[2, 33.33]]);
    expect(host.textContent).toContain("2 of 2 files pooled");
    // Dropping the reference file hands the pool to the next file in file order.
    act(() => [...host.querySelectorAll<HTMLInputElement>(".gl-layout-pool-list input")][0].click());
    expect(items(changes)[0].recipe).toMatchObject({ sampleId: "D3", pool: { sampleIds: ["D3"] } });
  });

  it("draws the sheet once per value of a metadata column, pooling each value's files, as pages or tiles", async () => {
    const selectField = (label: string) => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.startsWith(label))?.querySelector("select")!;
    const change = (el: HTMLSelectElement, value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const changes = mount(gatedFixture(true), { "FSC-A": [0, 40], "SSC-A": [0, 40] }, null, { checkedSampleIds: ["D1", "D2", "D3"] }, iteratingSheet());
    await flush();
    act(() => button("+ Biplot").click());
    act(() => button("+ Text").click());
    await flush();
    const [plot, note] = items(changes);
    const editor = openEditor(note.id);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Day {sample}: {file}");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => editor.blur());
    act(() => button("Iterate").click());
    change(selectField("Draw the sheet"), "metadata");
    expect(changes.at(-1)?.sheets[0].iteration).toMatchObject({ mode: "metadata", column: "donor", source: { kind: "checked" } });
    change(selectField("Column"), "day");
    expect(items(changes)[0].recipe).toMatchObject({ iterated: true });
    // Two values in natural order: day 0 (D2 alone) then day 7 (D1 and D3 pooled).
    expect(host.textContent).toContain("2 values of day over 3 files → 2 pages");
    expect(host.textContent).toContain("Page 1 of 2");
    expect(element(note.id).querySelector(".gl-layout-text-surface")?.textContent).toBe("Day 0: 1 files");
    await flush();
    expect(draws.plots.at(-1)?.config).toMatchObject({ n_events: 3, title: "0" });
    draws.plots = [];
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click());
    expect(host.textContent).toContain("Page 2 of 2");
    expect(element(note.id).querySelector(".gl-layout-text-surface")?.textContent).toBe("Day 7: 2 files");
    await flush();
    const pooled = draws.plots.at(-1)!.config;
    expect(pooled.x).toHaveLength(6);
    expect(pooled.n_events).toBe(6);
    expect((pooled.gates as Drawn[]).map((g) => [g.event_count, g.percent_of_parent])).toEqual([[2, 33.33]]);
    expect(pooled.title).toBe("7");
    // Tiles: both values on one page, side by side.
    change(selectField("Arrangement"), "tiles");
    expect(host.textContent).toContain("Page 1 of 1");
    expect(host.querySelectorAll(".gl-layout-item")).toHaveLength(4);
    // Export writes one page per value.
    change(selectField("Arrangement"), "page-per-unit");
    act(() => button("Export").click());
    await act(async () => { button("Export sheet").click(); await vi.runAllTimersAsync(); });
    expect(draws.exports.at(-1)).toEqual({ name: "Layout 1", format: "pdf", pages: 2 });
    void plot;
  });
});

describe("all events", () => {
  it("draws every event of the sheet's plots when switched on, keeps the switch through a reload, and goes back to the default when switched off", async () => {
    const changes = mount(gatedFixture(), { "FSC-A": [0, 40], "SSC-A": [0, 40] });
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    act(() => button("Style").click());
    const every = () => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("All events"))!.querySelector("input")!;
    const drawn = () => [...host.querySelectorAll<HTMLInputElement>('input[aria-label="Events drawn"]')][0];
    expect(every().checked).toBe(false);
    act(() => every().click());
    expect(changes.at(-1)?.sheets[0].style).toMatchObject({ maxEvents: 0 });
    expect(every().checked).toBe(true);
    expect(drawn().disabled).toBe(true);
    // The sheet reloads with the switch on: 0 is kept, not raised to the field's floor.
    expect(normalizeLayoutStyle(changes.at(-1)!.sheets[0].style)).toMatchObject({ maxEvents: 0 });
    await flush();
    expect(draws.plots.at(-1)?.config.x).toHaveLength(3);
    act(() => every().click());
    expect(changes.at(-1)?.sheets[0].style).toMatchObject({ maxEvents: 50000 });
    expect(drawn().disabled).toBe(false);
  });
});

describe("Plotting chart block", () => {
  it("adds the Plotting tab's chart as one block drawn by the tab's own chart, and hands it back for editing", async () => {
    const fx = fixture();
    const settings = { ...BASE_PROPORTIONS_SETTINGS, files: ["D1", "D2"], hierarchy: DEFAULT_HIERARCHY_ID, parent: fx.rootId, selectedPops: [fx.childId], groupSel: "day" };
    const onOpenInPlotting = vi.fn();
    const changes = mount(fx, {}, null, { plottingSettings: () => settings, onOpenInPlotting });
    await flush();
    act(() => button("+ Chart").click());
    act(() => button("Take the Plotting tab's chart").click());
    await flush();
    expect(items(changes)[0].recipe).toMatchObject({ kind: "proportions", settings: { files: ["D1", "D2"], selectedPops: [fx.childId], groupSel: "day" } });
    const chart = host.querySelector(".gl-layout-proportions-host .gl-prop-chart")!;
    expect(chart).not.toBeNull();
    // One panel, two bars (one per day), a legend of the population and ungated.
    expect(chart.querySelectorAll("svg.gl-prop-panel")).toHaveLength(1);
    expect(chart.querySelectorAll(".gl-prop-legend-item")).toHaveLength(2);
    // The new block is selected; its inspector hands the settings back to the Plotting tab.
    act(() => button("Edit in Plotting").click());
    // A block without a title of its own (none, or the "{none}" a grid's blocks carry) is opened as
    // a new chart named as the objects list names the block.
    expect(onOpenInPlotting).toHaveBeenCalledWith(expect.objectContaining({ selectedPops: [fx.childId], groupSel: "day" }), "Composition");
  });

  // A click on a legend entry of a sheet's chart kept the entry highlighted, as on the Plotting
  // tab, and wrote the highlight's note inside the block, which then no longer fitted (2026-11-12).
  it("draws the chart's legend as a key: its entries are not buttons and a click highlights nothing", async () => {
    const fx = fixture();
    const settings = { ...BASE_PROPORTIONS_SETTINGS, files: ["D1", "D2"], hierarchy: DEFAULT_HIERARCHY_ID, parent: fx.rootId, selectedPops: [fx.childId], groupSel: "day" };
    mount(fx, {}, null, { plottingSettings: () => settings });
    await flush();
    act(() => button("+ Chart").click());
    act(() => button("Take the Plotting tab's chart").click());
    await flush();
    const block = host.querySelector(".gl-layout-proportions-host")!;
    const entries = [...block.querySelectorAll<HTMLElement>(".gl-prop-legend-item")];
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.tagName)).toEqual(["SPAN", "SPAN"]);
    expect(block.querySelector("button")).toBeNull();
    act(() => {
      entries[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      entries[0].click();
    });
    expect(block.querySelector(".gl-prop-highlight-note")).toBeNull();
    expect(block.querySelector("[aria-pressed]")).toBeNull();
    expect(block.querySelector('[opacity="0.16"]')).toBeNull();
  });
});

describe("One chart kind on a Layout sheet", () => {
  it("offers one + Chart in the toolbar, whose quick start makes a Plotting chart block of a population, statistic and grouping", async () => {
    const fx = fixture();
    const changes = mount(fx, {}, null, { plottingSettings: () => ({ ...BASE_PROPORTIONS_SETTINGS }) });
    await flush();
    const toolbar = host.querySelector(".gl-layout-toolbar")!;
    expect([...toolbar.querySelectorAll("button")].filter((b) => b.textContent === "+ Chart")).toHaveLength(1);
    expect([...toolbar.querySelectorAll("button")].some((b) => b.textContent === "+ Plotting chart")).toBe(false);
    act(() => button("+ Chart").click());
    const dialog = host.querySelector<HTMLElement>('[role="dialog"].gl-layout-chart-start')!;
    expect(dialog).not.toBeNull();
    const selects = [...dialog.querySelectorAll("select")];
    expect(selects.map((el) => el.getAttribute("aria-label"))).toEqual(["Population", "Statistic", "Group by"]);
    // The root is not offered: a chart of all events in all events says nothing.
    expect([...selects[0].options].map((o) => o.value)).toEqual([fx.childId]);
    setSelect(selects[1], "count");
    setSelect(selects[2], "day");
    act(() => button("Add").click());
    await flush();
    expect(host.querySelector(".gl-layout-chart-start")).toBeNull();
    expect(items(changes)).toHaveLength(1);
    expect(items(changes)[0].recipe).toMatchObject({
      kind: "proportions",
      settings: { files: ["D1", "D2"], parent: fx.rootId, selectedPops: [fx.childId], valueKind: "proportion", proportionValue: "count", plotType: "bar", groupSel: "day", unitSel: "__sample__", test: true },
    });
    const chart = host.querySelector(".gl-layout-proportions-host .gl-prop-chart")!;
    expect(chart).not.toBeNull();
    // Lymphocytes holds each file's three events: a bar per day, each on an axis of events.
    expect(chart.querySelectorAll("svg.gl-prop-panel rect.gl-prop-mark")).toHaveLength(2);
    expect(chart.textContent).toContain("Events");
  });

  it("converts a saved summary chart to a Plotting chart in the same frame, as one undo step", async () => {
    const fx = fixture();
    const changes = mount(fx, {}, null, {}, olderSheetWithChart(fx, { populationId: fx.childId, statistic: "percent_of_total", chartType: "box", title: "Lymphocytes per donor" }));
    await flush();
    select("chart-1");
    act(() => button("Convert to a Plotting chart").click());
    await flush();
    expect(items(changes)).toHaveLength(1);
    expect(items(changes)[0]).toMatchObject({
      id: "chart-1", x: 80, y: 90, width: 320, height: 240,
      recipe: {
        kind: "proportions",
        title: "Lymphocytes per donor",
        settings: { files: ["D1", "D2"], parent: fx.rootId, selectedPops: [fx.childId], proportionValue: "total", plotType: "box", groupSel: "donor", test: true, legend: false },
      },
    });
    expect(host.querySelector(".gl-layout-chart svg")).toBeNull();
    expect(host.querySelector(".gl-layout-proportions-host .gl-prop-chart")).not.toBeNull();
    act(() => button("Undo").click());
    await flush();
    expect(items(changes)[0].recipe).toMatchObject({ kind: "chart", statistic: "percent_of_total", chartType: "box" });
    expect(host.querySelector(".gl-layout-chart svg")).not.toBeNull();
  });
});

const setSelect = (el: HTMLSelectElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
});
const setInput = (el: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const labelled = <T extends HTMLElement>(text: string, selector: string) => {
  const labels = [...host.querySelectorAll<HTMLLabelElement>("label")];
  return (labels.find((label) => label.textContent?.trim() === text) ?? labels.find((label) => label.textContent?.startsWith(text)))!.querySelector<T>(selector)!;
};

describe("LayoutTab titles, bound text and zoom", () => {
  it("titles plots by the sheet's template, the automatic one naming what differs", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    // One plot on the page: nothing differs, so it is named by population and file.
    expect(draws.plots.at(-1)!.config.title).toBe("All Events · D1.fcs");
    act(() => button("Style").click());
    setSelect(labelled<HTMLSelectElement>("Plot titles", "select"), "population");
    await flush();
    expect(changes.at(-1)!.sheets[0].titleTemplate).toBe("{population}");
    expect(draws.plots.at(-1)!.config.title).toBe("All Events");
    setSelect(labelled<HTMLSelectElement>("Plot titles", "select"), "custom");
    setInput(labelled<HTMLInputElement>("Template", "input"), "{sample} on {x} vs {y}, day {meta:day}");
    await flush();
    expect(draws.plots.at(-1)!.config.title).toBe("D1.fcs on FSC-A vs SSC-A, day 7");
    setSelect(labelled<HTMLSelectElement>("Plot titles", "select"), "none");
    await flush();
    expect(draws.plots.at(-1)!.config.title).toBe("");
    // The plot's own title takes precedence, with the same placeholders.
    act(() => button("Items").click());
    select(items(changes)[0].id);
    setInput(labelled<HTMLInputElement>("Title", "input"), "{population} ({count})");
    await flush();
    expect(draws.plots.at(-1)!.config.title).toBe("All Events (3)");
  });

  it("builds the sheet's title from the fields chosen, in order, with the separator chosen", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    act(() => button("Style").click());
    setSelect(labelled<HTMLSelectElement>("Plot titles", "select"), "custom");
    // Custom starts from population and file; each chip removes itself.
    const chosen = () => [...host.querySelectorAll<HTMLButtonElement>(".gl-title-builder-chosen button")].map((b) => b.textContent);
    expect(chosen()).toEqual(["Population ×", "File ×"]);
    const remove = (field: string) => act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${field}"]`)!.click());
    remove("Population");
    remove("File");
    expect(chosen()).toEqual([]);
    const add = (field: string) => act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="Add ${field}"]`)!.click());
    add("donor");
    add("day");
    await flush();
    expect(changes.at(-1)!.sheets[0].titleTemplate).toBe("{meta:donor} · {meta:day}");
    expect(draws.plots.at(-1)!.config.title).toBe("D1 · 7");
    expect(host.querySelector(".gl-title-builder-preview")!.textContent).toBe("First plot reads: D1 · 7");
    setSelect(labelled<HTMLSelectElement>("Between fields", "select"), "comma");
    await flush();
    expect(changes.at(-1)!.sheets[0].titleTemplate).toBe("{meta:donor}, {meta:day}");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Remove donor"]')!.click());
    await flush();
    expect(changes.at(-1)!.sheets[0].titleTemplate).toBe("{meta:day}");
    expect(draws.plots.at(-1)!.config.title).toBe("7");
    // The population's own fields are offered too, and the plot's.
    expect([...host.querySelectorAll<HTMLButtonElement>(".gl-title-builder-fields button")].map((b) => b.textContent)).toEqual(["Population", "File", "Sample id", "donor", "day", "Plot", "X", "Y", "Count"]);
  });

  it("treats a title GateLab baked in before the template existed as no title, and a typed one as the plot's own", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    select(items(changes)[0].id);
    // The form an older Illustration add wrote: population · file · the plot's name.
    setInput(labelled<HTMLInputElement>("Title", "input"), "All Events · D1.fcs · LL vs Live");
    await flush();
    expect(draws.plots.at(-1)!.config.title).toBe("All Events · D1.fcs");
    act(() => button("Style").click());
    expect(host.querySelector(".gl-title-builder-own")).toBeNull();
    setSelect(labelled<HTMLSelectElement>("Plot titles", "select"), "population");
    await flush();
    expect(draws.plots.at(-1)!.config.title).toBe("All Events");
    act(() => button("Items").click());
    select(items(changes)[0].id);
    setInput(labelled<HTMLInputElement>("Title", "input"), "Typed by hand");
    await flush();
    expect(draws.plots.at(-1)!.config.title).toBe("Typed by hand");
    act(() => button("Style").click());
    expect(host.querySelector(".gl-title-builder-own")!.textContent).toContain("1 plots keep a title of their own");
  });

  it("offers to drop the plots' own titles so the template reaches them", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    select(items(changes)[0].id);
    setInput(labelled<HTMLInputElement>("Title", "input"), "Baked in");
    await flush();
    expect(draws.plots.at(-1)!.config.title).toBe("Baked in");
    act(() => button("Style").click());
    expect(host.querySelector(".gl-title-builder-own")!.textContent).toContain("1 plots keep a title of their own");
    act(() => button("Use the template for all").click());
    await flush();
    expect(items(changes)[0].recipe).not.toHaveProperty("title");
    expect(host.querySelector(".gl-title-builder-own")).toBeNull();
    expect(draws.plots.at(-1)!.config.title).toBe("All Events · D1.fcs");
  });

  it("fills a text block from the plot it reads, and leaves it as written once unbound", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    act(() => button("+ Text").click());
    const [plot, text] = items(changes);
    select(text.id);
    setInput(labelled<HTMLInputElement>("Text", "input"), "{population} of {sample}, day {meta:day}");
    setSelect(labelled<HTMLSelectElement>("Reads from", "select"), plot.id);
    await flush();
    expect(items(changes)[1].recipe).toMatchObject({ readsFrom: plot.id, text: "{population} of {sample}, day {meta:day}" });
    const surface = () => host.querySelector<HTMLElement>(`[data-item-id="${text.id}"] .gl-layout-text-surface`)!;
    expect(surface().textContent).toBe("All Events of D1.fcs, day 7");
    setSelect(labelled<HTMLSelectElement>("Reads from", "select"), "");
    await flush();
    expect(items(changes)[1].recipe).not.toHaveProperty("readsFrom");
    expect(surface().textContent).toBe("{population} of {sample}, day {meta:day}");
  });

  it("fits the content to a smaller page by zooming the items, drawn at their size and scaled", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    act(() => button("+ Text").click());
    act(() => button("Page").click());
    const size = [...host.querySelectorAll<HTMLSelectElement>("select")].find((el) => [...el.options].some((o) => o.value === "journal-1"))!;
    setSelect(size, "journal-1");
    select();
    act(() => button("Fit content to page").click());
    await flush();
    const [plot, text] = items(changes);
    expect(plot.zoom).toBeLessThan(1);
    expect(text.zoom).toBe(plot.zoom);
    const article = element(plot.id);
    expect(article.dataset.zoom).toBe(String(plot.zoom));
    const body = article.querySelector<HTMLElement>(".gl-layout-item-body")!;
    expect(Math.round(parseFloat(body.style.width) * plot.zoom!)).toBeCloseTo(plot.width, -1);
    // The plot is still drawn at the size it had; the zoom scales the drawing.
    expect(draws.plots.at(-1)!.config.plot_size).toBeGreaterThan(240);
  });
});

describe("LayoutTab sources and legends", () => {
  const typeText = (value: string) => act(() => {
    const label = [...host.querySelectorAll<HTMLLabelElement>(".gl-layout-inspector label.gl-field-inline")].find((l) => l.firstChild?.textContent === "Text")!;
    const input = label.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it("shows a block's data under Data, and fills the source placeholders of a text block that reads from a chart", async () => {
    const fx = gatedFixture();
    const changes = mount(fx, {}, null, {}, olderSheetWithChart(fx));
    await flush();
    act(() => button("+ Text").click());
    await flush();
    const [chart, note] = items(changes);
    select(chart.id);
    const data = host.querySelector(".gl-layout-source")!;
    expect(data.textContent).toContain("Files (2)");
    expect(data.textContent).toContain("D1.fcs, D2.fcs");
    // One file per donor, so each group's n is one file.
    expect(data.textContent).toContain("D1, n = 1 file; D2, n = 1 file");
    select(note.id);
    const readsFrom = host.querySelector<HTMLSelectElement>('select[aria-label="Reads from"]')!;
    expect([...readsFrom.options].map((option) => option.value)).toContain(chart.id);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(readsFrom, chart.id);
      readsFrom.dispatchEvent(new Event("change", { bubbles: true }));
    });
    typeText("{files} · {sizes} · {other}");
    await flush();
    expect(items(changes)[1].recipe).toMatchObject({ text: "{files} · {sizes} · {other}", readsFrom: chart.id });
    expect(element(note.id).querySelector(".gl-layout-text-surface")!.textContent).toBe("D1.fcs, D2.fcs · D1, n = 1 file; D2, n = 1 file · {other}");
  });

  it("writes a legend as a new text block under the content each time, and regenerates one only when confirmed", async () => {
    const fx = gatedFixture();
    const saved = olderSheetWithChart(fx);
    const changes = mount(fx, {}, null, {}, saved);
    await flush();
    const chart = saved.sheets[0].items[0];
    act(() => button("Write legend").click());
    const legend = items(changes)[1];
    expect(legend.recipe).toMatchObject({ kind: "text", fontSize: 10, legendGenerated: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    // The chart takes the active population, All Events; one file per donor, so no test.
    expect((legend.recipe as { text: string }).text).toBe(
      "Panel 1. % of parent of All Events per file, grouped by donor (D1, n = 1 file; D2, n = 1 file). Bars show the mean and error bars the standard deviation. " +
      "No test was made: each group needs two or more values, and there must be two or more groups.",
    );
    expect(legend.y).toBeGreaterThanOrEqual(chart.y + chart.height);
    expect(legend.x).toBe(chart.x);
    act(() => button("Write legend").click());
    expect(items(changes)).toHaveLength(3);
    expect(items(changes)[1].recipe).toEqual(legend.recipe);

    select(legend.id);
    typeText("Edited by hand");
    expect(host.textContent).toContain(`Legend written ${(legend.recipe as { legendGenerated: string }).legendGenerated}`);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    act(() => button("Regenerate").click());
    expect(items(changes)[1].recipe).toMatchObject({ text: "Edited by hand" });
    confirm.mockReturnValue(true);
    act(() => button("Regenerate").click());
    expect((items(changes)[1].recipe as { text: string }).text).toBe((legend.recipe as { text: string }).text);
  });
});

describe("LayoutTab pages hold what is exported", () => {
  /** A sheet of one page with a text block below it, as sheets were left when an added block grew the sheet and not its pages. */
  function withItemBelowThePage(): LayoutWorkspace {
    const workspace = createDefaultLayoutWorkspace();
    workspace.sheets[0].items.push({ id: "below", x: 57, y: 900, width: 200, height: 60, z: 1, recipe: { kind: "text", text: "note", fontSize: 14 } });
    return workspace;
  }

  it("says under Export when an item lies off the pages, and adds the pages that hold it", () => {
    const changes = mount(fixture(), {}, null, {}, withItemBelowThePage());
    act(() => button("Export").click());
    const warning = () => host.querySelector<HTMLElement>(".gl-layout-export-warning");
    expect(host.textContent).toContain("This sheet is one page.");
    expect(warning()?.textContent).toContain("1 item lies partly or wholly outside the sheet's pages");
    act(() => button("Add pages to hold them").click());
    const sheet = changes.at(-1)!.sheets[0];
    expect([sheet.page.columns, sheet.page.rows]).toEqual([1, 2]);
    expect(sheet.height).toBe(2 * 794);
    expect(sheet.items[0]).toMatchObject({ x: 57, y: 900 }); // nothing moved
    expect(warning()).toBeNull();
    expect(host.textContent).toContain("This sheet is 2 pages: 1 across and 2 down.");
    expect(host.querySelectorAll(".gl-layout-page")).toHaveLength(2);
  });

  it("says after an export what lay off the pages", async () => {
    mount(fixture(), {}, null, {}, withItemBelowThePage());
    await act(async () => { button("Export PDF").click(); await vi.runAllTimersAsync(); });
    expect(draws.exports).toEqual([{ name: "Layout 1", format: "pdf", pages: 1 }]);
    expect(host.querySelector(".gl-layout-message")?.textContent).toContain("1 item lies outside the sheet's pages");
  });

  it("shows beside the resolution the most an image of the page can take, and says after an export when it was lowered to it", async () => {
    const workspace = createDefaultLayoutWorkspace();
    workspace.sheets[0].items.push({ id: "note", x: 57, y: 57, width: 200, height: 60, z: 1, recipe: { kind: "text", text: "note", fontSize: 14 } });
    mount(fixture(), {}, null, {}, workspace);
    act(() => button("Export").click());
    // An A4 landscape page, 1123 by 794 CSS pixels: 813 dpi before the image passes 64 megapixels.
    expect(host.textContent).toContain("a page of this size can be drawn at 813 dpi at most");
    draws.writeReport = { loweredDpi: 813, rasterPages: [] };
    await act(async () => { button("Export sheet").click(); await vi.runAllTimersAsync(); });
    expect(draws.exports).toHaveLength(1);
    expect(host.querySelector(".gl-layout-message")?.textContent).toContain("Exported. The resolution was lowered to 813 dpi");
  });

  it("says after an export that blocks had not finished drawing when the wait for them ran out", async () => {
    mount(fixture(), {}, null, {}, withItemBelowThePage());
    await flush();
    // A block that never finishes drawing, as a plot whose renderer hangs.
    const stuck = document.createElement("div");
    stuck.dataset.layoutPending = "1";
    host.querySelector(".gl-layout-canvas")!.appendChild(stuck);
    await act(async () => { button("Export PDF").click(); await vi.runAllTimersAsync(); });
    expect(draws.exports).toHaveLength(1);
    expect(host.querySelector(".gl-layout-message")?.textContent).toContain("Some blocks had not finished drawing after 20 s");
  });

  it("keeps a plot marked as not drawn while its file is missing, and does not hold an export for a file that is gone", async () => {
    const fx = fixture();
    const workspace = createDefaultLayoutWorkspace();
    workspace.sheets[0].items.push({ id: "gone", x: 57, y: 57, width: 300, height: 300, z: 1, recipe: { kind: "biplot", sampleId: "D9", populationId: fx.rootId, xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor" } });
    mount(fx, {}, null, {}, workspace);
    await flush();
    const plot = element("gone").querySelector<HTMLElement>(".gl-layout-plot-host")!;
    expect(plot.textContent).toBe("The referenced file is unavailable or still loading.");
    expect(plot.dataset.layoutPending).toBe("source");
    const started = Date.now();
    await act(async () => { button("Export PDF").click(); await vi.runAllTimersAsync(); });
    expect(draws.exports).toHaveLength(1);
    // Every file is prepared, so the missing one will not come: the export did not wait 20 s for it.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(host.querySelector(".gl-layout-message")).toBeNull();
  });

  it("takes no input while an export runs, and composes at the zoom the page is drawn at then", async () => {
    mount(fixture(), {}, null, {}, withItemBelowThePage());
    await flush();
    const tab = host.querySelector<HTMLElement>(".gl-layout-tab")!;
    expect(tab.hasAttribute("inert")).toBe(false);
    act(() => button("Export PDF").click());
    expect(tab.hasAttribute("inert")).toBe(true);
    expect(tab.getAttribute("aria-busy")).toBe("true");
    // jsdom does not honour inert, so a zoom still reaches the page: the export is to use it.
    const before = host.querySelector(".gl-layout-zoom-level")!.textContent;
    act(() => { page().dispatchEvent(new WheelEvent("wheel", { deltaY: -200, ctrlKey: true, bubbles: true, cancelable: true })); });
    const now = Number(host.querySelector(".gl-layout-zoom-level")!.textContent!.replace("%", "")) / 100;
    expect(host.querySelector(".gl-layout-zoom-level")!.textContent).not.toBe(before);
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(draws.composedZooms).toHaveLength(1);
    expect(draws.composedZooms[0]).toBeCloseTo(now, 2);
    expect(tab.hasAttribute("inert")).toBe(false);
  });

  it("acts on no key while an export runs, and gives the page its keyboard back after", async () => {
    const changes = mount(fixture(), {}, null, {}, withItemBelowThePage());
    await flush();
    select("below");
    key({ key: "ArrowRight" });
    const before = changes.length;
    const x = changes.at(-1)!.sheets[0].items[0].x;
    act(() => page().focus());
    act(() => button("Export PDF").click());
    // The tab is inert now; a browser drops the focus it held, which jsdom does not.
    act(() => (document.activeElement as HTMLElement).blur());
    key({ key: "ArrowRight" });
    key({ key: "Delete" });
    key({ key: "d", metaKey: true });
    const undo = new KeyboardEvent("keydown", { key: "z", metaKey: true, cancelable: true });
    act(() => { window.dispatchEvent(undo); });
    // Taken, so the app's own undo does not act on the gating instead.
    expect(undo.defaultPrevented).toBe(true);
    expect(changes).toHaveLength(before);
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(draws.exports).toHaveLength(1);
    expect(changes.at(-1)!.sheets[0].items).toHaveLength(1);
    expect(changes.at(-1)!.sheets[0].items[0].x).toBe(x);
    expect(document.activeElement).toBe(page());
    key({ key: "ArrowRight" });
    expect(changes.at(-1)!.sheets[0].items[0].x).toBe(x + 1);
  });

  it("says after a PDF export which pages the writer drew as an image", async () => {
    mount(fixture(), {}, null, {}, withItemBelowThePage());
    draws.writeReport = { loweredDpi: null, rasterPages: [2] };
    await act(async () => { button("Export PDF").click(); await vi.runAllTimersAsync(); });
    const message = host.querySelector(".gl-layout-message")?.textContent ?? "";
    expect(message).toContain("1 item lies outside the sheet's pages");
    expect(message).toContain("The PDF writer could not take page 2 as vector art; it is written as one image.");
  });

  it("opens the item's menu on a right-click on a strategy panel, not the renderer's own", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    // A panel as the renderer makes one in a multi-population grid: its own handler stops the event.
    const panel = document.createElement("div");
    panel.className = "mini-plot-cell";
    let rendererMenus = 0;
    panel.oncontextmenu = (event) => { event.stopPropagation(); rendererMenus += 1; };
    element(items(changes)[0].id).querySelector(".gl-layout-plot-host")!.appendChild(panel);
    act(() => { panel.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 150 })); });
    expect(rendererMenus).toBe(0);
    expect([...host.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toContain("Duplicate");
  });

  it("holds a multi-population block to its grid's width, so a long title is cut to the grid", async () => {
    const fx = gatedFixture();
    const workspace = createDefaultLayoutWorkspace();
    workspace.sheets[0].items.push({ id: "grid", x: 57, y: 57, width: 600, height: 300, z: 1, recipe: { kind: "strategy", sampleId: "D1", populationId: fx.childId, populationIds: [fx.childId], fullPath: true, displayMode: "pseudocolor", title: "a long file name that is wider than the grid" } });
    mount(fx, {}, null, {}, workspace);
    await flush();
    expect(draws.multiStrategies.length).toBeGreaterThan(0);
    const inner = element("grid").querySelector<HTMLElement>(".multi-strategy-grid")!.parentElement!;
    expect(inner.style.width).toBe(`${216}px`);
  });

  it("draws a multi-population block scaled to its frame once it knows its size, and measures it only the first time", async () => {
    // The grid as laid out: 400 by 200 px, in a 600 by 300 frame, so it is shown at 1.46 and the
    // frame is drawn in to it; the block is drawn again for the new frame.
    const sizes = { scrollWidth: 400, scrollHeight: 200 };
    for (const [name, value] of Object.entries(sizes)) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get(this: HTMLElement) { return this.id.startsWith("layout-strategy-") ? value : 0; } });
    }
    try {
      const fx = gatedFixture();
      const workspace = createDefaultLayoutWorkspace();
      workspace.sheets[0].items.push({ id: "grid", x: 57, y: 57, width: 600, height: 300, z: 1, recipe: { kind: "strategy", sampleId: "D1", populationId: fx.childId, populationIds: [fx.childId], fullPath: true, displayMode: "pseudocolor" } });
      const changes = mount(fx, {}, null, {}, workspace);
      await flush();
      expect(items(changes)[0]).toMatchObject({ width: 592, height: 300 });
      const scales = draws.multiStrategies.map((entry) => (entry.payload as { canvas_scale: number }).canvas_scale);
      // The first drawing measures the grid, the second is at the scale it is shown at; drawn
      // again for the frame drawn in, it is drawn once, at that scale.
      expect(scales).toHaveLength(3);
      expect(scales[2]).toBeCloseTo(scales[1]);
      expect(scales[1] / scales[0]).toBeCloseTo(1.46);
    } finally {
      for (const name of Object.keys(sizes)) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });

  it("leaves room for arrows round a multi-population block only when an arrow is drawn", async () => {
    // All Events › Lymphocytes › CD4_positive: CD4_positive's strategy is two panels and an arrow
    // between them; Lymphocytes' alone is one panel and none.
    const fx = gatedFixture();
    const cd4 = newPopulation("CD4_positive", [], fx.childId);
    const cd4Gate = newGate("CD4_gate", "rectangle", "FSC-A", "SSC-A", [[0, 0], [40, 40]]);
    cd4.gate_refs = [{ gate_id: cd4Gate.gate_id, include: true }];
    fx.state.gates[cd4Gate.gate_id] = cd4Gate;
    fx.state.gate_order.push(cd4Gate.gate_id);
    fx.state.populations[cd4.population_id] = cd4;
    fx.state.populations[fx.childId].children = [cd4.population_id];
    const workspace = createDefaultLayoutWorkspace();
    const block = (id: string, y: number, populationId: string) => ({ id, x: 57, y, width: 600, height: 300, z: 1, recipe: { kind: "strategy" as const, sampleId: "D1", populationId, populationIds: [populationId], fullPath: true, displayMode: "pseudocolor" as const } });
    workspace.sheets[0].items.push(block("one", 57, fx.childId), block("two", 400, cd4.population_id));
    mount(fx, {}, null, {}, workspace);
    await flush();
    const gutter = (id: string) => element(id).querySelector<HTMLElement>(".multi-strategy-grid")!.style.paddingRight;
    expect(gutter("one")).toBe("");
    expect(gutter("two")).not.toBe("");
  });

  it("keeps the proportions of a block that is scaled as a whole", () => {
    const fx = fixture();
    const workspace = createDefaultLayoutWorkspace();
    workspace.sheets[0].items.push(
      { id: "grid", x: 57, y: 57, width: 600, height: 300, z: 1, recipe: { kind: "strategy", sampleId: "D1", populationId: fx.rootId, populationIds: [fx.rootId], fullPath: true, displayMode: "pseudocolor" } },
      { id: "note", x: 57, y: 400, width: 200, height: 60, z: 2, recipe: { kind: "text", text: "note", fontSize: 14 } },
    );
    mount(fx, {}, null, {}, workspace);
    const keep = () => [...host.querySelectorAll<HTMLLabelElement>("label")].find((label) => label.textContent === "Keep proportions")!.querySelector("input")!;
    select("note");
    expect(draws.moveable!.keepRatio).toBe(false);
    expect([keep().checked, keep().disabled]).toEqual([false, false]);
    select("grid");
    expect(draws.moveable!.keepRatio).toBe(true);
    expect([keep().checked, keep().disabled]).toEqual([true, true]);
  });
});
