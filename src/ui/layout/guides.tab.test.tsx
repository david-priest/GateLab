// @vitest-environment jsdom
// The Layout tab's rulers and guides: rulers in mm along the top and left of the pane, a guide
// dragged out of each ruler, moved, typed, removed (dragged back and by Delete), each one undo
// step; items snapping to guides; guides kept with the sheet through a save and load and copied
// by Duplicate sheet; never exported; hidden in Preview and with the rulers' toggle. Moveable and
// Selecto are stood in for by props recorders, as in LayoutTab.test.tsx. Synthetic samples D1, D2.

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
import { composeLayoutSVG } from "../../plots/layoutExport";
import { I18nProvider } from "../i18n";
import { LayoutTab } from "../LayoutTab";
import { pxToUnit } from "./layoutGeometry";

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

// The pane is 800 × 600 at the window's corner; the page, and every layer drawn over it, starts
// 18 px in (the pane's padding), at zoom 1.
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
function stubRects() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("gl-layout-canvas-scroll")) return rect(0, 0, 800, 600);
    if (this.matches(".gl-layout-canvas, .gl-layout-guides, .gl-layout-shape-draw")) return rect(18, 18, 1123, 794);
    return rect(0, 0, 0, 0);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  draws.moveable = null;
  draws.selecto = null;
  stubRects();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
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

const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
const pane = () => host.querySelector<HTMLDivElement>(".gl-layout-canvas-scroll")!;
const ruler = (which: "top" | "left") => host.querySelector<HTMLElement>(`.gl-layout-ruler.is-${which}`);
const guideEls = () => [...host.querySelectorAll<HTMLElement>(".gl-layout-guide")];
const guides = (changes: LayoutWorkspace[]) => changes.at(-1)?.sheets.find((sheet) => sheet.id === changes.at(-1)!.activeSheetId)?.guides;
const mouse = (target: EventTarget, type: string, x: number, y: number, init: MouseEventInit = {}) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init })); });
const drag = (target: EventTarget, from: [number, number], to: [number, number]) => {
  mouse(target, "mousedown", ...from);
  mouse(window, "mousemove", ...to);
  mouse(window, "mouseup", ...to);
};
const undo = () => act(() => { pane().dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); });

describe("Rulers on the Layout page", () => {
  it("shows mm rulers on both edges by default, labelled from the page's corner, and the toggle hides them", () => {
    mount();
    const top = ruler("top")!, left = ruler("left")!;
    expect(top).not.toBeNull();
    expect(left).not.toBeNull();
    // At zoom 1 a label every 10 mm, the first at the page's corner, 18 px in.
    const labels = [...top.querySelectorAll("text")].map((text) => text.textContent);
    expect(labels.slice(0, 4)).toEqual(["0", "10", "20", "30"]);
    expect(Number(top.querySelector("text")!.getAttribute("x"))).toBeCloseTo(18 + 2);
    expect([...left.querySelectorAll("text")].map((text) => text.textContent).slice(0, 2)).toEqual(["0", "10"]);
    const toggle = button("Rulers");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    act(() => toggle.click());
    expect(ruler("top")).toBeNull();
    expect(button("Rulers").getAttribute("aria-pressed")).toBe("false");
    act(() => button("Rulers").click());
    expect(ruler("top")).not.toBeNull();
  });

  it("follows the pointer with a marker and shades the selection's extent", () => {
    const saved = JSON.parse(JSON.stringify(createDefaultLayoutWorkspace()));
    saved.sheets[0].items = [{ id: "T1", x: 100, y: 50, width: 160, height: 32, z: 0, recipe: { kind: "text", text: "control", fontSize: 18 } }];
    mount(normalizeLayoutWorkspace(saved));
    mouse(pane(), "mousemove", 300, 200);
    expect(ruler("top")!.querySelector(".gl-layout-ruler-pointer")!.getAttribute("x1")).toBe("300");
    expect(ruler("left")!.querySelector(".gl-layout-ruler-pointer")!.getAttribute("y1")).toBe("200");
    expect(ruler("top")!.querySelector(".gl-layout-ruler-selection")).toBeNull();
    act(() => { draws.selecto!.onSelectEnd({ selected: [host.querySelector('[data-item-id="T1"]')], isDragStart: false, isClick: true, inputEvent: {} }); });
    const shade = ruler("top")!.querySelector(".gl-layout-ruler-selection")!;
    expect([shade.getAttribute("x"), shade.getAttribute("width")]).toEqual(["118", "160"]);
    expect(ruler("left")!.querySelector(".gl-layout-ruler-selection")!.getAttribute("y")).toBe("68");
  });
});

describe("Guides on the Layout page", () => {
  it("makes a horizontal guide from the top ruler and a vertical one from the left, each one undo step", () => {
    const changes = mount();
    drag(ruler("top")!, [300, 8], [300, 218]);
    expect(guides(changes)).toEqual([{ axis: "y", at: 200 }]);
    drag(ruler("left")!, [8, 300], [118, 300]);
    expect(guides(changes)).toEqual([{ axis: "y", at: 200 }, { axis: "x", at: 100 }]);
    const [horizontal, vertical] = guideEls();
    expect(horizontal.getAttribute("aria-label")).toBe(`Horizontal guide at ${pxToUnit(200, "mm")} mm`);
    expect(vertical.classList.contains("is-x")).toBe(true);
    // Let go on the ruler itself, no guide is made.
    const before = changes.length;
    drag(ruler("top")!, [300, 8], [320, 10]);
    expect(changes.length).toBe(before);
    undo();
    expect(guides(changes)).toEqual([{ axis: "y", at: 200 }]);
    undo();
    expect(guides(changes)).toBeUndefined();
    expect(guideEls()).toHaveLength(0);
  });

  it("moves a guide by dragging it, takes a typed position, and removes it dragged onto its ruler or by Delete", () => {
    const changes = mount();
    drag(ruler("top")!, [300, 8], [300, 218]);
    drag(ruler("left")!, [8, 300], [118, 300]);
    // The press on a guide is the guide's: the marquee around the page does not see it.
    const marquee = vi.fn();
    pane().addEventListener("mousedown", marquee);
    drag(guideEls()[0], [300, 218], [300, 268]);
    expect(marquee).not.toHaveBeenCalled();
    expect(guides(changes)![0]).toEqual({ axis: "y", at: 250 });
    undo();
    expect(guides(changes)![0]).toEqual({ axis: "y", at: 200 });

    // A double-click opens a field in mm; Enter puts the guide there.
    act(() => { guideEls()[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Guide position (mm)"]')!;
    expect(Number(field.value)).toBe(pxToUnit(100, "mm"));
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "40");
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(host.querySelector('input[aria-label="Guide position (mm)"]')).toBeNull();
    expect(guides(changes)![1].axis).toBe("x");
    expect(pxToUnit(guides(changes)![1].at, "mm")).toBe(40);
    undo();
    expect(guides(changes)![1]).toEqual({ axis: "x", at: 100 });

    // Dragged back onto the top ruler, the horizontal guide goes.
    drag(guideEls()[0], [300, 218], [300, 6]);
    expect(guides(changes)).toEqual([{ axis: "x", at: 100 }]);
    undo();
    expect(guides(changes)).toHaveLength(2);

    // Selected (focused) and Delete pressed, a guide goes; the items stay.
    const vertical = guideEls()[1];
    mouse(vertical, "mousedown", 118, 300);
    mouse(window, "mouseup", 118, 300);
    expect(document.activeElement).toBe(vertical);
    act(() => { vertical.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })); });
    expect(guides(changes)).toEqual([{ axis: "y", at: 200 }]);
    undo();
    expect(guides(changes)).toHaveLength(2);

    // Clear guides, in the Page tab, removes them all in one step.
    act(() => button("Page").click());
    act(() => button("Clear guides").click());
    expect(guides(changes)).toBeUndefined();
    expect(button("Clear guides").disabled).toBe(true);
    undo();
    expect(guides(changes)).toHaveLength(2);
  });

  it("gives the guides to the snap lines items move, resize and are drawn by, and Cmd still turns snapping off", () => {
    const changes = mount();
    drag(ruler("top")!, [300, 8], [300, 221]);
    drag(ruler("left")!, [8, 300], [131, 300]);
    expect(draws.moveable!.horizontalGuidelines).toContain(203);
    expect(draws.moveable!.verticalGuidelines).toContain(113);
    // A rectangle drawn from near the guides starts on them (6 px, the other snap lines' threshold).
    const shapeMenu = [...host.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find((b) => b.textContent === "Rectangle")!;
    act(() => shapeMenu.click());
    const layer = host.querySelector<HTMLElement>(".gl-layout-shape-draw")!;
    drag(layer, [18 + 116, 18 + 207], [18 + 300, 18 + 400]);
    const shape = changes.at(-1)!.sheets[0].items.at(-1)!;
    expect(shape).toMatchObject({ x: 113, y: 203 });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true })); });
    expect(draws.moveable!.snappable).toBe(false);
  });

  it("keeps the guides with the sheet through a save and load, copies them with Duplicate sheet, and leaves them out of the export", () => {
    const saved = JSON.parse(JSON.stringify(createDefaultLayoutWorkspace()));
    saved.sheets[0].items = [{ id: "T1", x: 100, y: 50, width: 160, height: 32, z: 0, recipe: { kind: "text", text: "control", fontSize: 18 } }];
    saved.sheets[0].guides = [{ axis: "y", at: 120 }, { axis: "x", at: 64 }];
    const loaded = normalizeLayoutWorkspace(saved);
    const changes = mount(loaded);
    expect(guideEls().map((el) => el.dataset.guideIndex)).toEqual(["0", "1"]);

    act(() => button("Duplicate sheet").click());
    const after = changes.at(-1)!;
    expect(after.sheets).toHaveLength(2);
    expect(after.sheets[1].guides).toEqual([{ axis: "y", at: 120 }, { axis: "x", at: 64 }]);
    expect(after.sheets[1].guides).not.toBe(after.sheets[0].guides);
    expect(normalizeLayoutWorkspace(JSON.parse(JSON.stringify(after))).sheets[1].guides).toEqual(after.sheets[1].guides);

    const canvas = host.querySelector<HTMLElement>(".gl-layout-canvas")!;
    expect(canvas.querySelector(".gl-layout-guide")).not.toBeNull();
    const composed = composeLayoutSVG(canvas, after.sheets[1], { dpi: 96, zoom: 1 });
    const markup = new XMLSerializer().serializeToString(composed.root);
    expect(markup).not.toContain("gl-layout-guide");
    expect(composed.root.querySelectorAll("line")).toHaveLength(0);
  });

  it("hides the rulers and guides in Preview", () => {
    const saved = JSON.parse(JSON.stringify(createDefaultLayoutWorkspace()));
    saved.sheets[0].guides = [{ axis: "y", at: 120 }];
    mount(normalizeLayoutWorkspace(saved));
    expect(ruler("top")).not.toBeNull();
    expect(guideEls()).toHaveLength(1);
    act(() => button("Preview").click());
    expect(ruler("top")).toBeNull();
    expect(ruler("left")).toBeNull();
    expect(guideEls()).toHaveLength(0);
    act(() => button("Edit layout").click());
    expect(guideEls()).toHaveLength(1);
  });
});
