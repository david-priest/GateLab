// @vitest-environment jsdom
// Quarter turns on the Layout tab: "Rotate left" and "Rotate right" in the inspector and the item's
// menu for text blocks and placed images, absent for a plot, a shape and a panel letter; each turn
// is one undo step and swaps the frame about its centre; the page draws the content turned in its
// upright frame; Duplicate and copy and paste keep the turn. Moveable and Selecto are stood in for,
// as in LayoutTab.test.tsx. Synthetic sample D1; nothing here is a real experiment.

import { act, forwardRef, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutWorkspace, normalizeLayoutWorkspace, type LayoutItem, type LayoutWorkspace } from "../../engine/layout";
import { DEFAULT_HIERARCHY_ID } from "../../engine/hierarchies";
import { newRootPopulation } from "../../engine/models";
import { Sample } from "../../engine/sample";
import type { FcsFile } from "../../engine/fcs";
import type { FigureSample } from "../../engine/figure";
import { initialCoreState, type CoreState } from "../../store";
import { I18nProvider } from "../i18n";
import { LayoutTab } from "../LayoutTab";
import { addPanelLetters } from "./panelLetters";

const recorded = vi.hoisted(() => ({ moveable: null as Record<string, any> | null, selecto: null as Record<string, any> | null }));
vi.mock("../../plots/loadPlots", () => ({
  loadMiniPlots: () => ({ renderMiniPlot: () => {}, renderStrategyGrid: () => {} }),
}));
vi.mock("react-moveable", () => ({
  default: forwardRef((props: Record<string, any>, ref) => {
    recorded.moveable = props;
    useImperativeHandle(ref, () => ({ isMoveableElement: () => false, waitToChangeTarget: async () => {}, dragStart: () => {}, stopDrag: () => {}, updateRect: () => {} }));
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(initial: LayoutWorkspace) {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  Object.assign(state, { populations: { [rootPop.population_id]: rootPop }, root_population_id: rootPop.population_id, active_population_id: rootPop.population_id });
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {}, spillover: null,
    channels: [{ index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 }, { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 }],
    columns: [Float32Array.from([10, 20, 30]), Float32Array.from([30, 20, 10])],
  };
  const samples: FigureSample[] = [{ id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) }];
  const changes: LayoutWorkspace[] = [];
  function Harness() {
    const [workspace, setWorkspace] = useState(initial);
    return (
      <I18nProvider>
        <LayoutTab
          workspace={workspace}
          onChange={(next) => { changes.push(next); setWorkspace(next); }}
          samples={samples}
          activeSampleId="D1"
          activePopulationId={rootPop.population_id}
          state={state as CoreState}
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
  return { changes, populationId: rootPop.population_id };
}

const SCHEMATIC = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect width="40" height="20" fill="#336699"/></svg>';
const label: LayoutItem = { id: "label-1", x: 100, y: 50, width: 160, height: 32, z: 0, recipe: { kind: "text", text: "CD4_positive", fontSize: 14 } };
const schematic: LayoutItem = { id: "img-1", x: 300, y: 50, width: 80, height: 40, z: 1, recipe: { kind: "image", fileName: "schematic_D1.svg", mediaType: "image/svg+xml", naturalWidth: 40, naturalHeight: 20, content: SCHEMATIC } };
const plot: LayoutItem = { id: "plot-1", x: 100, y: 200, width: 260, height: 280, z: 2, recipe: { kind: "biplot", sampleId: "D1", populationId: "root", xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor" } };
const shape = { id: "shape-1", x: 400, y: 200, width: 60, height: 40, z: 3, recipe: { kind: "shape", shape: "rectangle" } };

function sheetWith(list: unknown[], letters?: string[]) {
  const workspace = createDefaultLayoutWorkspace();
  (workspace.sheets[0] as { items: unknown[] }).items = list;
  const loaded = normalizeLayoutWorkspace(JSON.parse(JSON.stringify(workspace)));
  if (letters) addPanelLetters(loaded.sheets[0], letters);
  return loaded;
}

const items = (changes: LayoutWorkspace[]) => changes.at(-1)!.sheets[0].items;
const element = (id: string) => host.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!;
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
const menuItem = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find((b) => b.textContent === text);
const select = (...ids: string[]) => act(() => {
  recorded.selecto!.onSelectEnd({ selected: ids.map(element), isDragStart: false, isClick: ids.length <= 1, inputEvent: {} });
});
const key = (init: KeyboardEventInit) => act(() => {
  host.querySelector<HTMLElement>(".gl-layout-canvas-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});
const openMenu = (id: string) => act(() => {
  element(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 60 }));
});
const frameOf = (item: LayoutItem) => ({ x: item.x, y: item.y, width: item.width, height: item.height, rotation: item.rotation });

describe("Turning text blocks and placed images on the Layout tab", () => {
  it("turns a text block a quarter turn about its centre from the inspector, as one undo step, and draws it turned", () => {
    const { changes } = mount(sheetWith([label]));
    select("label-1");
    act(() => button("Rotate left")!.click());
    expect(changes).toHaveLength(1);
    expect(frameOf(items(changes)[0])).toEqual({ x: 164, y: -14, width: 32, height: 160, rotation: 270 });
    // The frame on the page is the upright box; the words are laid out along its height and turned.
    const article = element("label-1");
    expect(article.dataset.rotation).toBe("270");
    expect([article.style.width, article.style.height]).toEqual(["32px", "160px"]);
    const box = article.querySelector<HTMLElement>(".gl-layout-turned")!;
    expect(box.style.transform).toBe("rotate(270deg)");
    expect(box.style.width).toContain("160px");
    expect(box.querySelector(".gl-layout-text-surface")!.textContent).toBe("CD4_positive");
    expect(host.querySelector(".gl-layout-rotation-state")!.textContent).toBe("Turned 270°");
    // One undo step takes the turn away.
    key({ key: "z", metaKey: true });
    expect(frameOf(items(changes)[0])).toEqual({ x: 100, y: 50, width: 160, height: 32, rotation: undefined });
    expect(element("label-1").querySelector(".gl-layout-turned")).toBeNull();
  });

  it("turns a placed image, and several selected items each about its own centre", () => {
    const { changes } = mount(sheetWith([label, schematic]));
    select("label-1", "img-1");
    act(() => button("Rotate right")!.click());
    expect(changes).toHaveLength(1);
    expect(items(changes).map(frameOf)).toEqual([
      { x: 164, y: -14, width: 32, height: 160, rotation: 90 },
      { x: 320, y: 30, width: 40, height: 80, rotation: 90 },
    ]);
    expect(element("img-1").querySelector(".gl-layout-turned > img.gl-layout-placed-image")).not.toBeNull();
    // The item's menu offers the same two entries.
    openMenu("img-1");
    act(() => menuItem("Rotate right")!.click());
    expect(frameOf(items(changes)[1])).toEqual({ x: 300, y: 50, width: 80, height: 40, rotation: 180 });
  });

  it("offers no turn for a plot, a shape, a panel letter, or a selection holding any of them", () => {
    mount(sheetWith([label, plot, shape, schematic], ["img-1"]));
    for (const id of ["plot-1", "shape-1"]) {
      select(id);
      expect(button("Rotate right")).toBeUndefined();
      openMenu(id);
      expect(menuItem("Rotate right")).toBeUndefined();
      act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    }
    const letter = [...host.querySelectorAll<HTMLElement>("[data-item-id]")].find((el) => el.textContent === "A")!;
    expect(letter).toBeDefined();
    select(letter.dataset.itemId!);
    expect(button("Rotate right")).toBeUndefined();
    select("label-1", "plot-1");
    expect(button("Rotate right")).toBeUndefined();
    select("label-1", "img-1");
    expect(button("Rotate right")).toBeDefined();
  });

  it("keeps the turn when duplicated and when copied and pasted", () => {
    const { changes } = mount(sheetWith([{ ...label, rotation: 90, width: 32, height: 160 }]));
    select("label-1");
    act(() => button("Duplicate")!.click());
    expect(items(changes)).toHaveLength(2);
    expect(items(changes)[1]).toMatchObject({ rotation: 90, width: 32, height: 160 });
    select("label-1");
    key({ key: "c", metaKey: true });
    key({ key: "v", metaKey: true });
    expect(items(changes)).toHaveLength(3);
    expect(items(changes)[2]).toMatchObject({ rotation: 90, width: 32, height: 160, recipe: { text: "CD4_positive" } });
  });
});
