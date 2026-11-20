// @vitest-environment jsdom
// Geometry on the Layout tab: X, Y, width and height in mm with a switch to px, the proportions
// lock on typed values and on a handle drag, and Match, Arrange in grid and Space for a
// selection, each one undo step. Moveable and Selecto are stood in for by props recorders, as in
// LayoutTab.test.tsx. Synthetic samples D1 and D2.

import { act, forwardRef, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutWorkspace, normalizeLayoutWorkspace, type LayoutWorkspace } from "../../engine/layout";
import { DEFAULT_HIERARCHY_ID } from "../../engine/hierarchies";
import { newPopulation, newRootPopulation } from "../../engine/models";
import { Sample } from "../../engine/sample";
import type { FcsFile } from "../../engine/fcs";
import type { FigureSample } from "../../engine/figure";
import { initialCoreState, type CoreState } from "../../store";
import { I18nProvider } from "../i18n";
import { LayoutTab } from "../LayoutTab";
import { pxToUnit, unitToPx } from "./layoutGeometry";

const draws = vi.hoisted(() => ({
  moveable: null as Record<string, any> | null,
  selecto: null as Record<string, any> | null,
}));
vi.mock("../../plots/loadPlots", () => ({
  loadMiniPlots: () => ({
    renderMiniPlot: (host: HTMLElement) => { host.setAttribute("style", "position: relative; width: 200px; height: 200px;"); },
    renderStrategyGrid: () => {},
  }),
}));
vi.mock("../../plots/gridExport", () => ({
  cellDataUrlAtDpi: () => "data:cell",
  rasterizeSvg: async () => ({}),
}));
vi.mock("react-moveable", () => ({
  default: forwardRef((props: Record<string, any>, ref) => {
    draws.moveable = props;
    useImperativeHandle(ref, () => ({ isMoveableElement: () => false, waitToChangeTarget: async () => {}, dragStart: () => {}, stopDrag: () => {}, updateRect: () => {} }));
    return null;
  }),
}));
vi.mock("react-selecto", () => ({
  default: forwardRef((props: Record<string, any>, ref) => {
    draws.selecto = props;
    useImperativeHandle(ref, () => ({ setSelectedTargets: () => {}, clickTarget: () => {} }));
    return null;
  }),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
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
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
const page = () => host.querySelector<HTMLDivElement>(".gl-layout-canvas-scroll")!;
const key = (init: KeyboardEventInit) => act(() => { page().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
const element = (id: string) => host.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!;
const select = (...ids: string[]) => act(() => {
  draws.selecto!.onSelectEnd({ selected: ids.map(element), isDragStart: false, isClick: ids.length <= 1, inputEvent: {} });
});
const drag = (id: string, to: { x: number; y: number }) => act(() => {
  const el = element(id);
  const datas: Record<string, unknown> = {};
  draws.moveable!.onDragStart({ target: el, datas, inputEvent: {} });
  draws.moveable!.onDrag({ target: el, left: to.x, top: to.y, datas });
  draws.moveable!.onDragEnd({ target: el, isDrag: true, datas });
});

function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const child = newPopulation("CD4_positive", [], rootPop.population_id);
  rootPop.children = [child.population_id];
  Object.assign(state, {
    populations: { [rootPop.population_id]: rootPop, [child.population_id]: child },
    root_population_id: rootPop.population_id,
    active_population_id: rootPop.population_id,
  });
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {}, spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([10, 20, 30]), Float32Array.from([30, 20, 10])],
  };
  const samples: FigureSample[] = [
    { id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs), metadata: { group: "control" } },
    { id: "D2", name: "D2.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs), metadata: { group: "treated" } },
  ];
  return { state, samples, rootId: rootPop.population_id };
}

function mount(initial?: LayoutWorkspace) {
  const fx = fixture();
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
          metadataColumns={["group"]}
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
      </I18nProvider>
    );
  }
  act(() => root.render(<Harness />));
  return changes;
}
const items = (changes: LayoutWorkspace[]) => changes.at(-1)!.sheets[0].items;

const frameOf = (changes: LayoutWorkspace[], id: string) => {
  const { x, y, width, height } = items(changes).find((item) => item.id === id)!;
  return { x, y, width, height };
};
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
function type(field: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}
function choose(field: HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const undo = () => key({ key: "z", metaKey: true });

/** Three plots placed by dragging, one 300 px apart from the next. */
async function threePlots() {
  const changes = mount();
  await flush();
  for (let i = 0; i < 3; i++) act(() => button("+ Biplot").click());
  await flush();
  const ids = items(changes).map((item) => item.id);
  const places = [{ x: 100, y: 100 }, { x: 500, y: 140 }, { x: 100, y: 500 }];
  ids.forEach((id, index) => { select(id); drag(id, places[index]); });
  return { changes, ids };
}

describe("Geometry on the Layout tab", () => {
  it("shows X, Y, width and height in mm by default and in px after the switch; a typed value is one undo step", async () => {
    const { changes, ids } = await threePlots();
    select(ids[0]);
    const { width } = frameOf(changes, ids[0]);
    expect(input("Item x").value).toBe(String(Math.round((100 / (96 / 25.4)) * 10) / 10));
    expect(input("Item width").value).toBe(String(Math.round((width / (96 / 25.4)) * 10) / 10));
    expect(host.querySelector(".gl-layout-dimensions")!.textContent).toContain("Width (mm)");
    type(input("Item x"), "50.1");
    expect(frameOf(changes, ids[0]).x).toBeCloseTo(unitToPx(50.1, "mm"), 2);
    expect(input("Item x").value).toBe("50.1");
    const count = changes.length;
    undo();
    expect(changes.length).toBe(count + 1);
    expect(frameOf(changes, ids[0]).x).toBe(100);
    act(() => button("px").click());
    expect(button("px").getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".gl-layout-dimensions")!.textContent).toContain("Width (px)");
    expect(input("Item x").value).toBe("100");
    type(input("Item y"), "120");
    expect(frameOf(changes, ids[0]).y).toBe(120);
    // The choice holds for the next item selected.
    select(ids[1]);
    expect(input("Item x").value).toBe("500");
  });

  it("keeps proportions on typed values and on a handle drag when the lock is on; Shift frees a drag", async () => {
    const { changes, ids } = await threePlots();
    select(ids[0]);
    act(() => button("px").click());
    const before = frameOf(changes, ids[0]);
    expect(draws.moveable!.keepRatio).toBe(false);
    const lock = [...host.querySelectorAll<HTMLLabelElement>("label")].find((label) => label.textContent === "Keep proportions")!.querySelector("input")!;
    act(() => lock.click());
    expect(draws.moveable!.keepRatio).toBe(true);
    type(input("Item width"), String(before.width * 2));
    expect(frameOf(changes, ids[0])).toMatchObject({ width: before.width * 2, height: before.height * 2 });
    const count = changes.length;
    undo();
    expect(changes.length).toBe(count + 1);
    expect(frameOf(changes, ids[0])).toEqual(before);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true })); });
    expect(draws.moveable!.keepRatio).toBe(false);
    act(() => { window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", shiftKey: false })); });
    expect(draws.moveable!.keepRatio).toBe(true);
  });

  it("matches the size of the item nearest the top left, leaving a locked item alone, in one undo step", async () => {
    const { changes, ids } = await threePlots();
    select(ids[1]);
    act(() => button("px").click());
    type(input("Item width"), "400");
    select(ids[2]);
    type(input("Item height"), "300");
    act(() => { [...host.querySelectorAll<HTMLLabelElement>("label.gl-check")].find((label) => label.textContent === "Locked")!.querySelector("input")!.click(); });
    const reference = frameOf(changes, ids[0]);
    const locked = frameOf(changes, ids[2]);
    select(...ids);
    expect(button("Match size").title).toContain("nearest the top left");
    const count = changes.length;
    act(() => button("Match size").click());
    expect(changes.length).toBe(count + 1);
    expect(frameOf(changes, ids[1])).toEqual({ x: 500, y: 140, width: reference.width, height: reference.height });
    expect(frameOf(changes, ids[2])).toEqual(locked);
    undo();
    expect(frameOf(changes, ids[1]).width).toBe(400);
  });

  it("arranges a selection in a grid from the popover, in one undo step", async () => {
    const { changes, ids } = await threePlots();
    select(...ids);
    act(() => button("Arrange in grid…").click());
    const dialog = host.querySelector<HTMLElement>('[role="dialog"][aria-label="Arrange in grid"]')!;
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Columns"]')!.value).toBe("2");
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Gap (mm)"]')!.value).toBe("4");
    type(dialog.querySelector<HTMLInputElement>('input[aria-label="Columns"]')!, "3");
    choose(dialog.querySelector<HTMLSelectElement>('select[aria-label="Order"]')!, "across");
    const sizes = ids.map((id) => frameOf(changes, id));
    const count = changes.length;
    act(() => [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Apply")!.click());
    expect(changes.length).toBe(count + 1);
    expect(host.querySelector('[role="dialog"][aria-label="Arrange in grid"]')).toBeNull();
    const gap = unitToPx(4, "mm");
    expect(frameOf(changes, ids[0])).toMatchObject({ x: 100, y: 100 });
    expect(frameOf(changes, ids[1]).x).toBeCloseTo(100 + sizes[0].width + gap, 2);
    expect(frameOf(changes, ids[1]).y).toBe(100);
    expect(frameOf(changes, ids[2]).x).toBeCloseTo(100 + sizes[0].width + gap + sizes[1].width + gap, 2);
    undo();
    expect(frameOf(changes, ids[2])).toMatchObject({ x: 100, y: 500 });
  });

  it("spaces a selection at a typed gap down the page, the first staying, in one undo step", async () => {
    const { changes, ids } = await threePlots();
    select(...ids);
    act(() => button("Space…").click());
    const dialog = host.querySelector<HTMLElement>('[role="dialog"][aria-label="Space at a gap"]')!;
    type(dialog.querySelector<HTMLInputElement>('input[aria-label="Gap (mm)"]')!, "10");
    choose(dialog.querySelector<HTMLSelectElement>('select[aria-label="Direction"]')!, "down");
    const sizes = ids.map((id) => frameOf(changes, id));
    const count = changes.length;
    act(() => [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Apply")!.click());
    expect(changes.length).toBe(count + 1);
    const gap = unitToPx(10, "mm");
    expect(frameOf(changes, ids[0])).toMatchObject({ x: 100, y: 100 });
    expect(frameOf(changes, ids[1]).y).toBeCloseTo(100 + sizes[0].height + gap, 2);
    expect(frameOf(changes, ids[1]).x).toBe(500);
    expect(frameOf(changes, ids[2]).y).toBeCloseTo(100 + sizes[0].height + gap + sizes[1].height + gap, 2);
    // The gap is remembered for the grid.
    act(() => button("Arrange in grid…").click());
    expect(host.querySelector<HTMLInputElement>('[aria-label="Arrange in grid"] input[aria-label="Gap (mm)"]')!.value).toBe("10");
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    undo();
    expect(frameOf(changes, ids[1])).toMatchObject({ x: 500, y: 140 });
  });
});

describe("X and Y on a sheet of several pages", () => {
  /** A sheet of A4 landscape pages (1123 x 794 px), `columns` across and `rows` down, holding one text item. */
  function onSheet(columns: number, rows: number, at: { x: number; y: number }) {
    const saved = JSON.parse(JSON.stringify(createDefaultLayoutWorkspace()));
    saved.sheets[0].page = { ...saved.sheets[0].page, columns, rows };
    saved.sheets[0].width = 1123 * columns;
    saved.sheets[0].height = 794 * rows;
    saved.sheets[0].items = [{ id: "T1", ...at, width: 160, height: 32, z: 0, recipe: { kind: "text", text: "control", fontSize: 18 } }];
    return mount(normalizeLayoutWorkspace(saved));
  }

  it("shows and reads X from the left edge of the second page across", async () => {
    const changes = onSheet(2, 1, { x: 1123 + 76, y: 57 });
    await flush();
    select("T1");
    expect(input("Item x").value).toBe(String(pxToUnit(76, "mm")));
    expect(input("Item y").value).toBe(String(pxToUnit(57, "mm")));
    type(input("Item x"), "10");
    expect(frameOf(changes, "T1").x).toBeCloseTo(1123 + unitToPx(10, "mm"), 2);
    expect(input("Item x").value).toBe("10");
    type(input("Item x"), "0");
    expect(frameOf(changes, "T1").x).toBe(1123);
    act(() => button("px").click());
    expect(input("Item x").value).toBe("0");
    type(input("Item x"), "40");
    expect(frameOf(changes, "T1").x).toBe(1163);
    // The first page reads from its own corner, as before.
    type(input("Item x"), "-1123");
    expect(frameOf(changes, "T1").x).toBe(0);
    expect(input("Item x").value).toBe("0");
  });

  it("reads a typed X once when it takes the item to another page", async () => {
    const changes = onSheet(2, 1, { x: 76, y: 57 });
    await flush();
    select("T1");
    const field = input("Item x");
    act(() => {
      field.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "300");
      field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(frameOf(changes, "T1").x).toBeCloseTo(unitToPx(300, "mm"), 2);
    // Leaving the field afterwards does not read the 300 again, from the second page's edge.
    act(() => {
      field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      input("Item x").dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(frameOf(changes, "T1").x).toBeCloseTo(unitToPx(300, "mm"), 2);
    expect(input("Item x").value).toBe(String(pxToUnit(unitToPx(300, "mm") - 1123, "mm")));
  });

  it("shows and reads Y from the top edge of the second page down", async () => {
    const changes = onSheet(1, 2, { x: 57, y: 794 + 100 });
    await flush();
    select("T1");
    expect(input("Item x").value).toBe(String(pxToUnit(57, "mm")));
    expect(input("Item y").value).toBe(String(pxToUnit(100, "mm")));
    type(input("Item y"), "30");
    expect(frameOf(changes, "T1").y).toBeCloseTo(794 + unitToPx(30, "mm"), 2);
    expect(input("Item y").value).toBe("30");
  });
});

describe("An item's scale on the Layout tab", () => {
  const resize = (id: string, width: number, height: number, end: { cancel?: boolean; dist?: number[] } = {}) => act(() => {
    const el = element(id);
    const [x, y] = [parseFloat(el.style.left), parseFloat(el.style.top)];
    draws.moveable!.onResizeStart({ target: el, inputEvent: {}, setFixedDirection: () => {} });
    draws.moveable!.onResize({ target: el, width, height, drag: { left: x, top: y } });
    if (end.cancel) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    draws.moveable!.onResizeEnd({ target: el, isDrag: true, datas: {}, lastEvent: { dist: end.dist ?? [width, height] } });
  });
  const zoomOf = (changes: LayoutWorkspace[], id: string) => items(changes).find((item) => item.id === id)!.zoom;
  const bodyStyle = (id: string) => element(id).querySelector<HTMLElement>(":scope > .gl-layout-item-body")!.getAttribute("style") || "";

  it("shows a plot made smaller than it is drawn scaled, and unscaled again once it is made large enough", async () => {
    const { changes, ids } = await threePlots();
    select(ids[0]);
    resize(ids[0], 64, 64);
    expect(zoomOf(changes, ids[0])).toBe(0.5);
    // Still below the smallest a plot is drawn: drawn at that size and shown scaled to the frame.
    resize(ids[0], 100, 100);
    expect(zoomOf(changes, ids[0])).toBe(0.781);
    resize(ids[0], 256, 256);
    expect(frameOf(changes, ids[0])).toMatchObject({ width: 256, height: 256 });
    expect(zoomOf(changes, ids[0])).toBeUndefined();
  });

  it("shows a plot given a typed size smaller than it is drawn scaled, as a dragged one is", async () => {
    const { changes, ids } = await threePlots();
    select(ids[0]);
    type(input("Item width"), "30");
    type(input("Item height"), "30");
    expect(frameOf(changes, ids[0])).toMatchObject({ width: unitToPx(30, "mm"), height: unitToPx(30, "mm") });
    expect(input("Item width").value).toBe("30");
    expect(zoomOf(changes, ids[0])).toBe(0.886);
    type(input("Item width"), "100");
    type(input("Item height"), "100");
    expect(zoomOf(changes, ids[0])).toBeUndefined();
  });

  it("keeps the scale of a plot drawn larger than the smallest when it is resized", async () => {
    const { changes, ids } = await threePlots();
    const scaled = structuredClone(changes.at(-1)!);
    Object.assign(scaled.sheets[0].items.find((item) => item.id === ids[0])!, { width: 150, height: 150, zoom: 0.5 });
    act(() => root.unmount());
    root = createRoot(host);
    const again = mount(scaled);
    await flush();
    select(ids[0]);
    resize(ids[0], 200, 200);
    expect(zoomOf(again, ids[0])).toBe(0.5);
  });

  it("shows a scaled item's scale and resets it to unscaled, keeping its top-left corner, for one item or each of several", async () => {
    const { changes, ids } = await threePlots();
    select(ids[0]);
    expect(button("Reset scale")).toBeUndefined();
    resize(ids[0], 64, 64);
    expect(host.querySelector(".gl-layout-inspector")!.textContent).toContain("Shown at 50%");
    const count = changes.length;
    act(() => button("Reset scale").click());
    expect(changes.length).toBe(count + 1);
    expect(frameOf(changes, ids[0])).toEqual({ x: 100, y: 100, width: 128, height: 128 });
    expect(zoomOf(changes, ids[0])).toBeUndefined();
    expect(button("Reset scale")).toBeUndefined();
    undo();
    expect(zoomOf(changes, ids[0])).toBe(0.5);
    select(ids[1]);
    resize(ids[1], 32, 32);
    select(...ids);
    expect(host.querySelector(".gl-layout-inspector")!.textContent).toContain("Shown at several scales");
    act(() => button("Reset scale").click());
    expect(ids.map((id) => zoomOf(changes, id))).toEqual([undefined, undefined, undefined]);
    expect(frameOf(changes, ids[0])).toMatchObject({ width: 128, height: 128 });
    expect(frameOf(changes, ids[1])).toEqual({ x: 500, y: 140, width: 128, height: 128 });
  });

  it("draws an item exactly as before after a resize cancelled with Escape or one of less than 3 px", async () => {
    const { changes, ids } = await threePlots();
    select(ids[0]);
    const before = { style: bodyStyle(ids[0]), frame: frameOf(changes, ids[0]) };
    const count = changes.length;
    resize(ids[0], 64, 64, { cancel: true });
    expect(changes.length).toBe(count);
    expect(bodyStyle(ids[0])).toBe(before.style);
    expect(element(ids[0]).style.width).toBe(`${before.frame.width}px`);
    resize(ids[0], before.frame.width - 1, 64, { dist: [1, 1] });
    expect(changes.length).toBe(count);
    expect(bodyStyle(ids[0])).toBe(before.style);
    // A zoomed item goes back to its own zoom.
    resize(ids[0], 64, 64);
    const zoomed = { style: bodyStyle(ids[0]), count: changes.length };
    expect(zoomed.style).toContain("zoom: 0.5");
    resize(ids[0], 32, 32, { cancel: true });
    expect(changes.length).toBe(zoomed.count);
    expect(bodyStyle(ids[0])).toBe(zoomed.style);
  });
});
