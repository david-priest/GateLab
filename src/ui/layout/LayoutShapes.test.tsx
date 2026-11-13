// @vitest-environment jsdom
// Lines and shapes on the Layout tab: "+ Shape" arms the pointer, a drag on the page draws the
// shape (Shift holding a line to 45° steps), a click places one, Escape disarms; the new shape is
// selected and is one undo step; the inspector shows each kind's fields and sets a change on every
// selected shape that has it. Moveable and Selecto are stood in for by props recorders, as in
// LayoutTab.test.tsx. Synthetic sample D1; nothing here is a real experiment.

import { act, forwardRef, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutWorkspace, normalizeLayoutWorkspace, type LayoutItem, type LayoutWorkspace } from "../../engine/layout";
import { defaultShapeRecipe, type LayoutShapeRecipe } from "../../engine/shapeBlock";
import { DEFAULT_HIERARCHY_ID } from "../../engine/hierarchies";
import { newPopulation, newRootPopulation } from "../../engine/models";
import { Sample } from "../../engine/sample";
import type { FcsFile } from "../../engine/fcs";
import type { FigureSample } from "../../engine/figure";
import { initialCoreState, type CoreState } from "../../store";
import { I18nProvider } from "../i18n";
import { LayoutTab } from "../LayoutTab";

const recorded = vi.hoisted(() => ({
  moveable: null as Record<string, any> | null,
  selecto: null as Record<string, any> | null,
}));
vi.mock("../../plots/loadPlots", () => ({
  loadMiniPlots: () => ({ renderMiniPlot: () => {}, renderStrategyGrid: () => {} }),
}));
vi.mock("react-moveable", () => ({
  default: forwardRef((props: Record<string, any>, ref) => {
    recorded.moveable = props;
    useImperativeHandle(ref, () => ({
      isMoveableElement: () => false,
      waitToChangeTarget: async () => {},
      dragStart: () => {},
      stopDrag: () => {},
      updateRect: () => {},
    }));
    return null;
  }),
}));
vi.mock("react-selecto", () => ({
  default: forwardRef((props: Record<string, any>, ref) => {
    recorded.selecto = props;
    useImperativeHandle(ref, () => ({ setSelectedTargets: () => {}, clickTarget: () => {} }));
    return null;
  }),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
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
  const samples: FigureSample[] = [{ id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) }];
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
const menuItem = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find((b) => b.textContent === label)!;
const layer = () => host.querySelector<HTMLElement>(".gl-layout-shape-draw");
const element = (id: string) => host.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!;
const select = (...ids: string[]) => act(() => {
  recorded.selecto!.onSelectEnd({ selected: ids.map(element), isDragStart: false, isClick: ids.length <= 1, inputEvent: {} });
});
const mouse = (target: EventTarget, type: string, x: number, y: number, init: MouseEventInit = {}) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init })); });
/** A press on the armed page at one point and a release at another, the pointer moved between. */
const dragOnPage = (from: [number, number], to: [number, number], init: MouseEventInit = {}) => {
  mouse(layer()!, "mousedown", ...from, init);
  mouse(window, "mousemove", ...to, init);
  mouse(window, "mouseup", ...to, init);
};
const sheetWith = (shapes: LayoutItem[]) => {
  const workspace = createDefaultLayoutWorkspace();
  workspace.sheets[0].items = shapes;
  return normalizeLayoutWorkspace(JSON.parse(JSON.stringify(workspace)));
};
const shapeItem = (id: string, recipe: LayoutShapeRecipe, frame = { x: 100, y: 100, width: 120, height: 0 }): LayoutItem => ({ id, ...frame, z: 0, recipe });
const setField = (label: string, value: string) => act(() => {
  const field = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
});

describe("Drawing a shape on the Layout page", () => {
  it("arms the pointer from + Shape, draws the shape from the press to the release, selects it, and undoes in one step", () => {
    const changes = mount();
    expect(layer()).toBeNull();
    act(() => menuItem("Arrow").click());
    expect(layer()?.dataset.tool).toBe("arrow");
    // The press is taken by the drawing layer, not the marquee around the page.
    const marquee = vi.fn();
    host.querySelector(".gl-layout-canvas-scroll")!.addEventListener("mousedown", marquee);
    dragOnPage([300, 200], [143, 262]);
    expect(marquee).not.toHaveBeenCalled();
    // Snapped to the 10 px grid, from the bottom-right corner it was pressed at to the top-left.
    const [arrow] = items(changes);
    expect(arrow).toMatchObject({ x: 140, y: 200, width: 160, height: 60, recipe: { kind: "shape", shape: "line", arrows: "end", from: "top-right" } });
    expect(layer()).toBeNull(); // the tool is put down
    expect(element(arrow.id).closest(".gl-layout-item")?.querySelector("svg.gl-layout-shape line")).not.toBeNull();
    expect(recorded.moveable!.target).toBe(element(arrow.id));
    // One undo step takes it away.
    act(() => { host.querySelector<HTMLElement>(".gl-layout-canvas-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); });
    expect(items(changes)).toHaveLength(0);
  });

  it("holds a line to the level with Shift, places one of the default size on a click, and disarms on Escape", () => {
    const changes = mount();
    act(() => menuItem("Line").click());
    dragOnPage([100, 100], [250, 117], { shiftKey: true });
    expect(items(changes)[0]).toMatchObject({ x: 100, y: 100, width: 150, height: 0, recipe: { shape: "line", arrows: "none" } });

    act(() => menuItem("Rectangle").click());
    mouse(layer()!, "mousedown", 400, 300);
    mouse(window, "mouseup", 401, 301);
    expect(items(changes)[1]).toMatchObject({ x: 400, y: 300, width: 120, height: 80, recipe: { shape: "rectangle" } });

    act(() => menuItem("Ellipse").click());
    expect(layer()).not.toBeNull();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(layer()).toBeNull();
    expect(items(changes)).toHaveLength(2);
  });

  it("offers the shapes in the blank page's menu, each arming the pointer", () => {
    mount();
    const canvas = host.querySelector<HTMLElement>(".gl-layout-canvas")!;
    act(() => { canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 250 })); });
    const menu = host.querySelector('.gl-context-menu, [role="menu"]:not([hidden])')!;
    expect([...menu.querySelectorAll('[role^="menuitem"]')].map((b) => b.textContent)).toEqual(expect.arrayContaining(["Line", "Arrow", "Bracket", "Rectangle", "Ellipse"]));
    act(() => [...menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find((b) => b.textContent === "Bracket")!.click());
    expect(layer()?.dataset.tool).toBe("bracket");
  });

  it("keeps a level line's frame through a drag, and turns Shift's kept proportions off for a line", () => {
    const changes = mount(sheetWith([shapeItem("line-1", defaultShapeRecipe("line"))]));
    select("line-1");
    expect(recorded.moveable!.keepRatio).toBe(false);
    const el = element("line-1");
    const datas: Record<string, unknown> = {};
    act(() => {
      recorded.moveable!.onDragStart({ target: el, datas, inputEvent: {} });
      recorded.moveable!.onDrag({ target: el, left: 160, top: 180, datas });
      recorded.moveable!.onDragEnd({ target: el, isDrag: true, datas });
    });
    expect(items(changes)[0]).toMatchObject({ x: 160, y: 180, width: 120, height: 0 });
    // Resized with Shift from the bottom-right handle, a near-level line goes level.
    act(() => {
      recorded.moveable!.onResizeStart({ target: el, inputEvent: {} });
      recorded.moveable!.onResize({ target: el, width: 200, height: 30, direction: [1, 1], drag: { left: 160, top: 180 }, inputEvent: { shiftKey: true } });
      recorded.moveable!.onResizeEnd({ target: el, isDrag: true, lastEvent: { dist: [80, 30] } });
    });
    expect(items(changes)[0]).toMatchObject({ x: 160, y: 180, width: 200, height: 0 });
  });
});

describe("The inspector for selected shapes", () => {
  const sheet = () => sheetWith([
    shapeItem("line-1", defaultShapeRecipe("arrow")),
    shapeItem("rect-1", defaultShapeRecipe("rectangle"), { x: 300, y: 100, width: 120, height: 80 }),
    shapeItem("bracket-1", defaultShapeRecipe("bracket"), { x: 100, y: 300, width: 120, height: 12 }),
  ]);
  const field = (label: string) => host.querySelector(`[aria-label="${label}"]`);

  it("shows only the fields of the selected kind, and no frame or title", () => {
    mount(sheet());
    select("rect-1");
    expect(field("Line colour")).not.toBeNull();
    expect(field("Fill")).not.toBeNull();
    expect(field("Corner radius (px)")).not.toBeNull();
    expect(field("Arrowheads")).toBeNull();
    expect(field("Ends point")).toBeNull();
    expect(host.textContent).not.toContain("Surrounding frame");
    expect(host.querySelector(".gl-layout-title-field")).toBeNull();
    select("line-1");
    expect(field("Arrowheads")).not.toBeNull();
    expect(field("Direction")).not.toBeNull();
    expect(field("Fill")).toBeNull();
    select("bracket-1");
    expect(field("Ends point")).not.toBeNull();
    expect(field("End length (px)")).not.toBeNull();
    expect(field("Arrowheads")).toBeNull();
  });

  it("sets a change on every selected shape that has the field", () => {
    const changes = mount(sheet());
    select("line-1", "rect-1", "bracket-1");
    expect(host.textContent).toContain("3 shapes");
    setField("Line colour", "#ff0000");
    expect(items(changes).map((item) => (item.recipe as LayoutShapeRecipe).stroke)).toEqual(["#ff0000", "#ff0000", "#ff0000"]);
    setField("Dash", "dashed");
    expect(items(changes).map((item) => (item.recipe as LayoutShapeRecipe).dash)).toEqual(["dashed", "dashed", "dashed"]);
    setField("Arrowheads", "both");
    expect(items(changes).map((item) => (item.recipe as LayoutShapeRecipe).arrows)).toEqual(["both", undefined, undefined]);
    act(() => host.querySelector<HTMLInputElement>('[aria-label="Fill"]')!.click());
    expect(items(changes).map((item) => (item.recipe as LayoutShapeRecipe).fill)).toEqual([undefined, "#d9d9d9", undefined]);
    setField("Ends point", "up");
    expect(items(changes).map((item) => (item.recipe as LayoutShapeRecipe).side)).toEqual([undefined, undefined, "up"]);
    // Each change is one undo step.
    const before = changes.length;
    setField("Line colour", "#00ff00");
    expect(changes.length).toBe(before + 1);
  });
});
