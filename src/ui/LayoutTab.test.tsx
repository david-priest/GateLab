// @vitest-environment jsdom
// The Layout tab: sheets and free placement, and the editing that any layout editor needs.
// Moveable and Selecto (the canvas libraries) are stood in for by props recorders, so the tab's
// handlers are driven directly; their behaviour in a real browser is checked headlessly.
// Synthetic sample D1 with two channels; nothing here is a real experiment.

import { act, useImperativeHandle, useState, forwardRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutWorkspace, type LayoutWorkspace } from "../engine/layout";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newPopulation, newRootPopulation } from "../engine/models";
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
  exports: [] as { name: string; format: string; pages: number }[],
  moveable: null as Record<string, any> | null,
  selecto: null as Record<string, any> | null,
  frameUpdates: 0,
  dragStarts: [] as unknown[],
  stopDrags: 0,
  selectoTargets: [] as Element[],
  selectoClicks: [] as { shift: boolean; target: Element }[],
}));
vi.mock("../plots/loadPlots", () => ({
  loadMiniPlots: () => ({
    renderMiniPlot: (host: HTMLElement, config: Record<string, unknown>) => {
      draws.plots.push({ host, config });
      host.setAttribute("style", "position: relative; width: 200px; height: 200px; flex: 0 0 auto; display: inline-block;");
    },
    renderStrategyGrid: (id: string, payload: unknown) => {
      draws.strategies.push({ id, payload });
    },
  }),
}));
vi.mock("../plots/layoutExport", () => ({
  composeSheetPages: (_canvas: HTMLElement, sheet: { page: { columns: number; rows: number } }) =>
    Array.from({ length: sheet.page.columns * sheet.page.rows }, () => ({ root: null, width: 0, height: 0 })),
  writeComposedPages: async (composed: unknown[], sheet: { name: string }, format: string) => {
    draws.exports.push({ name: sheet.name, format, pages: composed.length });
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
  draws.exports = [];
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

function mount(fx: ReturnType<typeof fixture>, globalScales: Record<string, [number, number]> = {}, illustrationConfig: IllustrationConfig | null = null, extra: Record<string, unknown> = {}) {
  const changes: LayoutWorkspace[] = [];
  function Harness() {
    const [workspace, setWorkspace] = useState(createDefaultLayoutWorkspace);
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

describe("LayoutTab sheets", () => {
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
    expect(host.querySelector('[role="menu"]')).toBeNull(); // closed by the choice
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

  it("adds a summary chart of a population across the files, grouped by a metadata column", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Chart").click());
    await flush();
    expect(items(changes)[0].recipe).toMatchObject({ kind: "chart", statistic: "percent_of_parent", files: "checked", groupBy: "donor", chartType: "bars", test: true });
    const chart = host.querySelector(".gl-layout-chart svg")!;
    expect(chart).not.toBeNull();
    // Two files, one per donor: a bar and a point for each, and no test with one file per group.
    expect(chart.querySelectorAll("circle")).toHaveLength(2);
    expect([...chart.querySelectorAll(".gl-layout-chart-groups > g > text")].map((t) => t.textContent)).toEqual(["D1", "D2"]);
    expect(chart.querySelector(".gl-layout-chart-test")).toBeNull();
    expect(chart.querySelectorAll("rect").length).toBeGreaterThanOrEqual(3); // the background and a bar per group
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
    // The item's own value wins, and a later change to the sheet leaves it alone.
    const id = items(changes)[0].id;
    act(() => button("Items").click());
    select(id);
    set("Contour levels", "4");
    await flush();
    expect(items(changes)[0].recipe).toMatchObject({ style: { contourLevels: 4 } });
    expect(draws.plots.at(-1)?.config).toMatchObject({ point_size: 3, contour_levels: 4 });
    act(() => button("Style").click());
    set("Contour levels", "20");
    await flush();
    expect(changes.at(-1)?.sheets[0].style).toEqual({ pointSize: 3, contourLevels: 20 });
    expect(draws.plots.at(-1)?.config).toMatchObject({ point_size: 3, contour_levels: 4 });
    // Dropping the item's own values puts it back on the sheet's style.
    act(() => button("Items").click());
    select(id);
    act(() => button("Follow the sheet").click());
    await flush();
    expect("style" in items(changes)[0].recipe).toBe(false);
    expect(draws.plots.at(-1)?.config.contour_levels).toBe(20);
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
    act(() => button("Fit content to page").click());
    expect(items(changes).map(({ x, y }) => [x, y])).toEqual([[57, 57], [457, 357]]); // already filling the page
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
    act(() => button("Page").click());
    change(selectField("Format"), "svg");
    await act(async () => { button("Export SVG").click(); });
    expect(draws.exports).toEqual([{ name: "Layout 1", format: "svg", pages: 1 }]);
    await act(async () => { button("Export sheet").click(); });
    expect(draws.exports).toHaveLength(2);
  });
});

describe("LayoutTab iteration", () => {
  const selectField = (label: string) => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.startsWith(label))?.querySelector("select")!;
  const change = (el: HTMLSelectElement | HTMLInputElement, value: string) => act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

  it("draws the sheet once per file, with placeholders filled, and exports every page", async () => {
    const changes = mount(fixture(), { "FSC-A": [5, 40], "SSC-A": [5, 40] });
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
    change(selectField("Draw the sheet"), "files");
    expect(changes.at(-1)?.sheets[0].iteration).toMatchObject({ mode: "files", source: { kind: "checked" } });
    // Nothing followed the iteration when it was switched on, so the plot follows it from then.
    expect(items(changes)[0].recipe).toMatchObject({ iterated: true });
    expect(host.textContent).toContain("Page 1 of 2");
    expect(host.textContent).toContain("2 files → 2 pages");
    expect(element(note.id).querySelector(".gl-layout-text-surface")?.textContent).toBe("Donor D1.fcs, day 7 (1/2)");
    draws.plots = [];
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click());
    expect(host.textContent).toContain("Page 2 of 2");
    expect(element(note.id).querySelector(".gl-layout-text-surface")?.textContent).toBe("Donor D2.fcs, day 0 (2/2)");
    await flush();
    // On page 2 the plot is drawn for D2. Unticked, it would show D1 on every page.
    expect(draws.plots.at(-1)?.config.title).toBe("All Events · D2.fcs");
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
    act(() => button("Page").click());
    await act(async () => { button("Export sheet").click(); await vi.runAllTimersAsync(); });
    expect(draws.exports.at(-1)).toEqual({ name: "Layout 1", format: "pdf", pages: 2 });
  });
});

describe("Plotting chart block", () => {
  it("adds the Plotting tab's chart as one block drawn by the tab's own chart, and hands it back for editing", async () => {
    const fx = fixture();
    const settings = { ...BASE_PROPORTIONS_SETTINGS, files: ["D1", "D2"], hierarchy: DEFAULT_HIERARCHY_ID, parent: fx.rootId, selectedPops: [fx.childId], groupSel: "day" };
    const onOpenInPlotting = vi.fn();
    const changes = mount(fx, {}, null, { plottingSettings: () => settings, onOpenInPlotting });
    await flush();
    act(() => button("+ Plotting chart").click());
    await flush();
    expect(items(changes)[0].recipe).toMatchObject({ kind: "proportions", settings: { files: ["D1", "D2"], selectedPops: [fx.childId], groupSel: "day" } });
    const chart = host.querySelector(".gl-layout-proportions-host .gl-prop-chart")!;
    expect(chart).not.toBeNull();
    // One panel, two bars (one per day), a legend of the population and ungated.
    expect(chart.querySelectorAll("svg.gl-prop-panel")).toHaveLength(1);
    expect(chart.querySelectorAll(".gl-prop-legend-item")).toHaveLength(2);
    // The new block is selected; its inspector hands the settings back to the Plotting tab.
    act(() => button("Edit in Plotting").click());
    expect(onOpenInPlotting).toHaveBeenCalledWith(expect.objectContaining({ selectedPops: [fx.childId], groupSel: "day" }));
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
const labelled = <T extends HTMLElement>(text: string, selector: string) =>
  [...host.querySelectorAll<HTMLLabelElement>("label")].find((label) => label.textContent?.startsWith(text))!.querySelector<T>(selector)!;

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
