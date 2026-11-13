// @vitest-environment jsdom
// Panel letters on the Layout tab: the toolbar and the item menu letter a selection or the whole
// sheet, a letter is not edited as text, the inspector names its item, the Style tab holds the
// sheet's letter style, and the export writes the letters as text. Moveable and Selecto are stood
// in for by props recorders, as in LayoutTab.test.tsx. Synthetic samples D1 and D2.

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
import { isPanelLetter } from "./panelLetters";

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
const letters = (changes: LayoutWorkspace[]) => items(changes).filter(isPanelLetter);
const letterFor = (changes: LayoutWorkspace[], id: string) => letters(changes).find((letter) => letter.recipe.letterFor === id)!;

/** Three plots and a text block, as the toolbar adds them. */
async function threePlotsAndText() {
  const changes = mount();
  await flush();
  for (let i = 0; i < 3; i++) act(() => button("+ Biplot").click());
  act(() => button("+ Text").click());
  await flush();
  act(() => { page().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })); });
  return changes;
}

describe("Panel letters on the Layout tab", () => {
  it("letters every plot on the sheet with nothing selected, not the text, and only the selection when there is one", async () => {
    const changes = await threePlotsAndText();
    const [p1, p2, p3] = items(changes);
    // A selection of one plot: that plot alone.
    select(p2.id);
    act(() => button("Panel letters").click());
    expect(letters(changes)).toHaveLength(1);
    expect(letterFor(changes, p2.id).recipe).toMatchObject({ kind: "text", text: "A", fontSize: 16, bold: true });
    // Nothing selected: every plot that has no letter takes one, the text block none.
    key({ key: "Escape" });
    act(() => button("Panel letters").click());
    expect(letters(changes)).toHaveLength(3);
    expect([p1, p2, p3].map((plot) => letterFor(changes, plot.id).recipe.text)).toEqual(["A", "B", "C"]);
    expect(host.querySelector(`[data-item-id="${letterFor(changes, p1.id).id}"] .gl-layout-text-surface`)?.textContent).toBe("A");
    // Remove with a selection: that plot's letter; without: every letter.
    select(p1.id);
    act(() => button("Remove panel letters").click());
    expect(letters(changes)).toHaveLength(2);
    expect(letterFor(changes, p2.id).recipe.text).toBe("A");
    key({ key: "Escape" });
    act(() => button("Remove panel letters").click());
    expect(letters(changes)).toHaveLength(0);
  });

  it("offers both entries on an item's menu", async () => {
    const changes = await threePlotsAndText();
    const [p1] = items(changes);
    act(() => { element(p1.id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 150 })); });
    const menuItem = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === label)!;
    expect(menuItem("Remove panel letters").disabled).toBe(true);
    act(() => menuItem("Panel letters").click());
    expect(letters(changes)).toHaveLength(1);
    expect(letterFor(changes, p1.id)).toBeDefined();
  });

  it("renumbers after a move and a delete, carries a letter with its item, and undoes both as one step each", async () => {
    const changes = await threePlotsAndText();
    const [p1, p2, p3] = items(changes);
    act(() => button("Panel letters").click());
    const before = letterFor(changes, p3.id);
    // p3 dragged above and left of everything: it reads first.
    select(p3.id);
    drag(p3.id, { x: 0, y: 0 });
    expect(letterFor(changes, p3.id).recipe.text).toBe("A");
    expect(letterFor(changes, p1.id).recipe.text).toBe("B");
    expect(letterFor(changes, p3.id).recipe.letterOffset).toEqual(before.recipe.letterOffset);
    // Undo puts the plot and its letter back in one step.
    key({ key: "z", metaKey: true });
    expect(letterFor(changes, p3.id)).toMatchObject({ x: before.x, y: before.y, recipe: { text: "C" } });
    // p1 deleted: its letter goes, and the others close up.
    select(p1.id);
    key({ key: "Delete" });
    expect(letters(changes)).toHaveLength(2);
    expect(letterFor(changes, p2.id).recipe.text).toBe("A");
    expect(letterFor(changes, p3.id).recipe.text).toBe("B");
  });

  it("gives a duplicated plot its own letter", async () => {
    const changes = await threePlotsAndText();
    const [p1] = items(changes);
    act(() => button("Panel letters").click());
    select(p1.id);
    key({ key: "d", metaKey: true });
    expect(letters(changes)).toHaveLength(4);
    const copies = items(changes).filter((item) => item.recipe.kind === "biplot");
    expect(copies).toHaveLength(4);
    for (const plot of copies) expect(letterFor(changes, plot.id)).toBeDefined();
    // A copied sheet's letters letter the copied sheet's plots.
    act(() => button("Duplicate sheet").click());
    const copy = changes.at(-1)!.sheets[1];
    const ids = new Set(copy.items.map((item) => item.id));
    const copiedLetters = copy.items.filter(isPanelLetter);
    expect(copiedLetters).toHaveLength(4);
    for (const letter of copiedLetters) expect(ids.has(letter.recipe.letterFor)).toBe(true);
  });

  it("does not edit a letter as text: a double-click and Enter open nothing, and the inspector names its item", async () => {
    const changes = await threePlotsAndText();
    const [p1] = items(changes);
    act(() => button("Panel letters").click());
    const letter = letterFor(changes, p1.id);
    act(() => { element(letter.id).querySelector<HTMLElement>(".gl-layout-text-surface")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(element(letter.id).querySelector("textarea")).toBeNull();
    select(letter.id);
    key({ key: "Enter" });
    expect(element(letter.id).querySelector("textarea")).toBeNull();
    const inspector = host.querySelector(".gl-layout-inspector")!;
    expect(inspector.textContent).toContain("Panel letter of");
    expect(inspector.querySelector('input[value="A"]')).toBeNull();
    // The inspector sets the sheet's style: lower case reaches every letter.
    const letterCase = inspector.querySelector<HTMLSelectElement>('select[aria-label="Letters"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(letterCase, "lower");
      letterCase.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changes.at(-1)!.sheets[0].letterStyle).toEqual({ fontSize: 16, bold: true, case: "lower" });
    expect(letters(changes).map((l) => l.recipe.text).sort()).toEqual(["a", "b", "c"]);
  });

  it("holds the sheet's letter style on the Style tab, under Panel letters", async () => {
    const changes = await threePlotsAndText();
    act(() => button("Panel letters").click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Style")!.click());
    const section = [...host.querySelectorAll("h4")].find((h) => h.textContent === "Panel letters")!.parentElement!;
    const bold = section.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => bold.click());
    expect(changes.at(-1)!.sheets[0].letterStyle).toMatchObject({ bold: false });
    for (const letter of letters(changes)) expect(letter.recipe).not.toHaveProperty("bold");
    const size = section.querySelector<HTMLInputElement>('input[aria-label="Letter size"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(size, "20");
      size.dispatchEvent(new Event("input", { bubbles: true }));
      size.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(changes.at(-1)!.sheets[0].letterStyle).toMatchObject({ fontSize: 20 });
    for (const letter of letters(changes)) expect(letter.recipe.fontSize).toBe(20);
  });

  it("writes the letters into the export as text", async () => {
    const changes = await threePlotsAndText();
    act(() => button("Panel letters").click());
    const canvas = host.querySelector<HTMLElement>(".gl-layout-canvas")!;
    const rect = (el: Element, left: number, top: number, width: number, height: number) => {
      el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    };
    rect(canvas, 0, 0, 1123, 794);
    for (const item of canvas.querySelectorAll<HTMLElement>(".gl-layout-item")) {
      const [x, y, w, h] = ["left", "top", "width", "height"].map((k) => parseFloat(item.style[k as "left"]) || 0);
      rect(item, x, y, w, h);
      const surface = item.querySelector(".gl-layout-text-surface");
      if (surface) rect(surface, x, y, w, h);
    }
    const sheet = changes.at(-1)!.sheets[0];
    const composed = composeLayoutSVG(canvas, sheet, { dpi: 96, zoom: 1 });
    const words = [...composed.root.querySelectorAll("text")].map((t) => t.textContent);
    expect(words).toEqual(expect.arrayContaining(["A", "B", "C", "Text"]));
  });

  it("opens a sheet saved without letters unchanged", async () => {
    const saved = JSON.parse(JSON.stringify(createDefaultLayoutWorkspace()));
    saved.sheets[0].items = [{ id: "t1", x: 80, y: 90, width: 160, height: 32, z: 0, recipe: { kind: "text", text: "control", fontSize: 18 } }];
    const initial = normalizeLayoutWorkspace(saved);
    const changes = mount(initial);
    await flush();
    expect(changes).toHaveLength(0);
    expect(host.querySelector('[data-item-id="t1"] .gl-layout-text-surface')?.textContent).toBe("control");
    // An edit elsewhere leaves the sheet's own fields as they were.
    act(() => button("+ Text").click());
    expect(changes.at(-1)!.sheets[0]).not.toHaveProperty("letterStyle");
    expect(items(changes)[0]).toEqual(initial.sheets[0].items[0]);
  });
});
