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

const draws = vi.hoisted(() => ({
  plots: [] as { host: HTMLElement; config: Record<string, unknown> }[],
  strategies: [] as { id: string; payload: unknown }[],
  exports: [] as { name: string; format: string; pages: number }[],
  moveable: null as Record<string, any> | null,
  selecto: null as Record<string, any> | null,
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
      dragStart: () => {},
    }));
    return null;
  }),
}));
vi.mock("react-selecto", () => ({
  default: (props: Record<string, any>) => {
    draws.selecto = props;
    return null;
  },
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
  draws.selecto!.onSelectEnd({ selected: ids.map(element), isDragStart: false, inputEvent: {} });
});
/** What Moveable reports for a drag of one item to a new place. */
const drag = (id: string, to: { x: number; y: number }, altKey = false) => act(() => {
  const el = element(id);
  const datas: Record<string, unknown> = {};
  draws.moveable!.onDragStart({ datas, inputEvent: { altKey } });
  draws.moveable!.onDrag({ target: el, left: to.x, top: to.y });
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

function mount(fx: ReturnType<typeof fixture>, globalScales: Record<string, [number, number]> = {}) {
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
          illustrationConfig={null}
          dataRevision={0}
          densityColorPower={1.6}
          onOpenInGating={vi.fn()}
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
  it("draws the sheet's style, and an item's own values over it", async () => {
    const changes = mount(fixture());
    await flush();
    act(() => button("+ Biplot").click());
    await flush();
    expect(draws.plots.at(-1)?.config).toMatchObject({ point_size: 1.1, contour_levels: 10, gate_style: { pub_style: false, line_width: 1.5 } });
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
    act(() => button("Spread ↕").click());
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
    expect(draws.moveable!.draggable).toBe(false);
    key({ key: "ArrowRight" });
    expect(items(changes).map((i) => i.x)).toEqual([10, 30, 50]);
    act(() => button("Unlock").click());
    key({ key: "ArrowRight" });
    expect(items(changes).map((i) => i.x)).toEqual([11, 31, 51]);
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
});

describe("LayoutTab text blocks", () => {
  it("selects a text block when its editor takes focus, and hands the keyboard back on Escape", () => {
    const changes = mount(fixture());
    act(() => button("+ Text").click());
    act(() => button("+ Text").click());
    const [a, b] = items(changes);
    select(a.id, b.id);
    expect(host.querySelectorAll(".gl-layout-item.is-selected")).toHaveLength(2);
    const editor = element(a.id).querySelector<HTMLTextAreaElement>("textarea")!;
    act(() => editor.focus());
    expect(host.querySelectorAll(".gl-layout-item.is-selected")).toHaveLength(1);
    expect(element(a.id).classList.contains("is-selected")).toBe(true);
    act(() => { editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })); });
    expect(document.activeElement).toBe(page());
    expect(element(a.id).classList.contains("is-selected")).toBe(true);
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
    expect(draws.moveable).toBeNull(); // nothing selected, nothing to move
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
    const editor = element(note.id).querySelector<HTMLTextAreaElement>("textarea")!;
    act(() => editor.focus());
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Donor {sample}, day {meta:day} ({n}/{N})");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => editor.blur());
    expect(items(changes)[1].recipe).toMatchObject({ text: "Donor {sample}, day {meta:day} ({n}/{N})" });

    act(() => button("Iterate").click());
    change(selectField("Draw the sheet"), "files");
    expect(changes.at(-1)?.sheets[0].iteration).toMatchObject({ mode: "files", source: { kind: "checked" } });
    // The plot was added before the iteration was on, so it does not follow it yet.
    expect(host.textContent).toContain("Page 1 of 2");
    expect(host.textContent).toContain("2 files → 2 pages");
    expect(element(note.id).querySelector("textarea")?.value).toBe("Donor D1.fcs, day 7 (1/2)");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click());
    expect(host.textContent).toContain("Page 2 of 2");
    expect(element(note.id).querySelector("textarea")?.value).toBe("Donor D2.fcs, day 0 (2/2)");
    // The plot follows once told to; on page 2 it is then drawn for D2.
    draws.plots = [];
    select(plot.id);
    act(() => button("Items").click());
    const follows = [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("Follows the iteration"))!.querySelector("input")!;
    act(() => follows.click());
    expect(items(changes)[0].recipe).toMatchObject({ iterated: true });
    await flush();
    expect(draws.plots.at(-1)?.config.title).toBe("All Events · D2.fcs");
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
