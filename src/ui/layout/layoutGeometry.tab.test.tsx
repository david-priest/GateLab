// @vitest-environment jsdom
// Geometry on the Layout tab: X, Y, width and height in mm with a switch to px, the proportions
// lock on typed values and on a handle drag, and Match, Arrange in grid and Space for a
// selection, each one undo step. Moveable and Selecto are stood in for by props recorders, as in
// LayoutTab.test.tsx. Synthetic samples D1 and D2.

import { act, forwardRef, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutWorkspace, type LayoutWorkspace } from "../../engine/layout";
import { DEFAULT_HIERARCHY_ID } from "../../engine/hierarchies";
import { newPopulation, newRootPopulation } from "../../engine/models";
import { Sample } from "../../engine/sample";
import type { FcsFile } from "../../engine/fcs";
import type { FigureSample } from "../../engine/figure";
import { initialCoreState, type CoreState } from "../../store";
import { I18nProvider } from "../i18n";
import { LayoutTab } from "../LayoutTab";
import { unitToPx } from "./layoutGeometry";

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
