// @vitest-environment jsdom
// The Layout tab's navigation, sheet tabs, "Export all sheets" and list of keys: Space-drag and
// middle-button drag scroll the view and select nothing, Space still types in a text block, the
// zoom keys, zoom to selection, sheets reordered by drag and by the tab's menu with undo, every
// sheet exported as one PDF or one zip with the user's sheet put back, and the list of keys held
// to the keys the tab's handlers take. Moveable and Selecto are stood in for by props recorders,
// as in LayoutTab.test.tsx. Synthetic samples D1 and D2.

import { act, forwardRef, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutWorkspace, createLayoutSheet, normalizeLayoutWorkspace, type LayoutWorkspace } from "../../engine/layout";
import { DEFAULT_HIERARCHY_ID } from "../../engine/hierarchies";
import { newPopulation, newRootPopulation } from "../../engine/models";
import { Sample } from "../../engine/sample";
import type { FcsFile } from "../../engine/fcs";
import type { FigureSample } from "../../engine/figure";
import { initialCoreState, type CoreState } from "../../store";
import { I18nProvider } from "../i18n";
import { LayoutTab } from "../LayoutTab";
import { LAYOUT_KEYS } from "./LayoutKeysHelp";

const draws = vi.hoisted(() => ({
  moveable: null as Record<string, any> | null,
  selecto: null as Record<string, any> | null,
  written: [] as { format: string; sheets: { name: string; pages: number }[]; shown: string | null }[],
}));
vi.mock("../../plots/loadPlots", () => ({
  loadMiniPlots: () => ({
    renderMiniPlot: (host: HTMLElement) => { host.setAttribute("style", "position: relative; width: 200px; height: 200px;"); },
    renderStrategyGrid: () => {},
  }),
}));
vi.mock("../../plots/layoutExport", () => ({
  // One composed page per page of the sheet's grid, named by the sheet the canvas shows then.
  composeSheetPages: (canvas: HTMLElement, sheet: { page: { columns: number; rows: number } }) =>
    Array.from({ length: sheet.page.columns * sheet.page.rows }, () => ({ root: null, width: 0, height: 0, shown: canvas.getAttribute("aria-label") })),
  writeComposedPages: async () => {},
}));
vi.mock("./layoutExportAll", () => ({
  writeAllSheets: async (sheets: { sheet: { name: string }; pages: { shown: string }[] }[], format: string) => {
    // Each sheet's pages were composed while that sheet was the one on the canvas.
    for (const { sheet, pages } of sheets) for (const page of pages) expect(page.shown).toBe(sheet.name);
    draws.written.push({ format, sheets: sheets.map(({ sheet, pages }) => ({ name: sheet.name, pages: pages.length })), shown: document.querySelector(".gl-layout-canvas")?.getAttribute("aria-label") ?? null });
  },
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
  draws.written = [];
  try { localStorage.clear(); } catch { /* none */ }
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
const scroller = () => host.querySelector<HTMLDivElement>(".gl-layout-canvas-scroll")!;
const element = (id: string) => host.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!;
const zoomLabel = () => host.querySelector(".gl-layout-zoom-level")!.textContent;
const select = (...ids: string[]) => act(() => {
  draws.selecto!.onSelectEnd({ selected: ids.map(element), isDragStart: false, isClick: ids.length <= 1, inputEvent: {} });
});
const menuItem = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.gl-context-menu [role="menuitem"]')].find((b) => b.textContent === label)!;
const sheetTab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>(".gl-layout-sheet-tab")].find((b) => b.textContent === name)!;
const sheetNames = () => [...host.querySelectorAll<HTMLButtonElement>(".gl-layout-sheet-tab")].map((b) => b.textContent);
/** A key pressed on the target; returns whether something took it (its default was prevented). */
function press(target: EventTarget, init: KeyboardEventInit, type = "keydown"): boolean {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event.defaultPrevented;
}
const mouse = (target: EventTarget, type: string, init: MouseEventInit = {}) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};
/** jsdom lays nothing out: the scroller is given a size and a scroll position that hold what is set. */
function sizeScroller(width = 800, height = 600) {
  const el = scroller();
  Object.defineProperty(el, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: height });
  let left = 0, top = 0;
  Object.defineProperty(el, "scrollLeft", { configurable: true, get: () => left, set: (v: number) => { left = v; } });
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = v; } });
  // The page's wrapper moves up and left as the view scrolls, as it does on screen.
  el.querySelector<HTMLElement>(".gl-layout-zoom")!.getBoundingClientRect = () => ({ left: -left, top: -top, width: 0, height: 0, right: -left, bottom: -top, x: -left, y: -top, toJSON: () => ({}) }) as DOMRect;
  return el;
}
/** A drag event with the data transfer jsdom lacks. */
function dragEvent(type: string, clientX = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown; clientX: number };
  const data: Record<string, string> = {};
  Object.defineProperty(event, "dataTransfer", { value: { effectAllowed: "", setData: (k: string, v: string) => { data[k] = v; }, getData: (k: string) => data[k] ?? "" } });
  Object.defineProperty(event, "clientX", { value: clientX });
  return event;
}

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

function mount(initial?: LayoutWorkspace, key?: number) {
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
  act(() => root.render(<Harness key={key} />));
  return changes;
}

/** A plot P, a text block T1 on it, and a text block T2 elsewhere. */
function placed(): LayoutWorkspace {
  const saved = JSON.parse(JSON.stringify(createDefaultLayoutWorkspace()));
  saved.sheets[0].items = [
    { id: "P", x: 100, y: 100, width: 260, height: 280, z: 0, recipe: { kind: "biplot", sampleId: "D1", populationId: "", xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor" } },
    { id: "T1", x: 120, y: 120, width: 160, height: 32, z: 1, recipe: { kind: "text", text: "control", fontSize: 18 } },
    { id: "T2", x: 500, y: 100, width: 160, height: 32, z: 2, recipe: { kind: "text", text: "treated", fontSize: 18 } },
  ];
  return normalizeLayoutWorkspace(saved);
}

/** Three sheets, S1 to S3; S1 has one page, S2 a grid of two, S3 nothing on it. S2 is shown. */
function threeSheets(): LayoutWorkspace {
  const workspace = placed();
  workspace.sheets[0].name = "S1";
  const second = createLayoutSheet("S2", { ...workspace.sheets[0].page, columns: 2 });
  second.items = [{ ...structuredClone(workspace.sheets[0].items[2]), id: "U1" }];
  const third = createLayoutSheet("S3", { ...workspace.sheets[0].page });
  const saved = JSON.parse(JSON.stringify({ ...workspace, sheets: [workspace.sheets[0], second, third], activeSheetId: second.id }));
  return normalizeLayoutWorkspace(saved);
}

describe("Layout navigation", () => {
  it("pans with Space-drag: the hand shows, the view scrolls, nothing is selected and the page sees no press", async () => {
    const changes = mount(placed());
    await flush();
    const el = sizeScroller();
    const before = changes.length;
    const reached = vi.fn();
    el.addEventListener("mousedown", reached);
    el.addEventListener("click", reached);
    // The pointer comes over the page; Space is pressed while a toolbar button has the keyboard.
    mouse(element("T1"), "mouseover");
    const focused = button("Fit");
    focused.focus();
    expect(press(focused, { key: " ", code: "Space" })).toBe(true);
    expect(el.dataset.pan).toBe("ready");
    mouse(element("T1"), "mousedown", { clientX: 300, clientY: 300, button: 0 });
    expect(el.dataset.pan).toBe("active");
    mouse(window, "mousemove", { clientX: 260, clientY: 250 });
    expect(el.scrollLeft).toBe(40);
    expect(el.scrollTop).toBe(50);
    mouse(window, "mouseup", { clientX: 260, clientY: 250 });
    mouse(element("T1"), "click");
    mouse(element("T1"), "dblclick");
    expect(reached).not.toHaveBeenCalled();
    expect(element("T1").querySelector("textarea, [contenteditable='true']")).toBeNull();
    expect(element("T1").classList.contains("is-selected")).toBe(false);
    // Releasing Space returns the pointer; nothing in the workspace changed.
    expect(press(focused, { key: " ", code: "Space" }, "keyup")).toBe(true);
    expect(el.dataset.pan).toBeUndefined();
    expect(changes.length).toBe(before);
    // The pointer off the page, Space is the focused button's again.
    mouse(document.body, "mouseover");
    expect(press(focused, { key: " ", code: "Space" })).toBe(false);
    expect(el.dataset.pan).toBeUndefined();
  });

  it("pans with a middle-button drag", async () => {
    mount(placed());
    await flush();
    const el = sizeScroller();
    const down = mouse(element("P"), "mousedown", { clientX: 100, clientY: 100, button: 1 });
    expect(down.defaultPrevented).toBe(true);
    mouse(window, "mousemove", { clientX: 70, clientY: 80 });
    mouse(window, "mouseup", { clientX: 70, clientY: 80, button: 1 });
    expect([el.scrollLeft, el.scrollTop]).toEqual([30, 20]);
    mouse(window, "mousemove", { clientX: 0, clientY: 0 });
    expect([el.scrollLeft, el.scrollTop]).toEqual([30, 20]);
  });

  it("types a space in a text block being edited", async () => {
    mount(placed());
    await flush();
    const el = sizeScroller();
    act(() => { element("T1").querySelector<HTMLElement>(".gl-layout-text-surface")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    const editor = element("T1").querySelector<HTMLElement>("textarea, [contenteditable='true']")!;
    expect(editor).not.toBeNull();
    mouse(editor, "mouseover");
    expect(press(editor, { key: " ", code: "Space" })).toBe(false);
    expect(el.dataset.pan).toBeUndefined();
  });

  it("zooms with Cmd-0, Cmd-1, Cmd-= and Cmd--, only from the page or its inspector", async () => {
    const changes = mount(placed());
    await flush();
    sizeScroller(800, 600);
    const sheet = placed().sheets[0];
    const fit = Math.floor(Math.min(764 / sheet.width, 564 / sheet.height) * 100);
    expect(press(scroller(), { key: "0", metaKey: true })).toBe(true);
    expect(zoomLabel()).toBe(`${fit}%`);
    expect(press(scroller(), { key: "1", metaKey: true })).toBe(true);
    expect(zoomLabel()).toBe("100%");
    expect(press(scroller(), { key: "=", metaKey: true })).toBe(true);
    expect(zoomLabel()).toBe("150%");
    // Ctrl as on Windows and Linux, from a field of the inspector.
    const inspector = host.querySelector<HTMLElement>(".gl-layout-controls select")!;
    expect(press(inspector, { key: "-", ctrlKey: true })).toBe(true);
    expect(zoomLabel()).toBe("100%");
    expect(press(scroller(), { key: "-", metaKey: true })).toBe(true);
    expect(zoomLabel()).toBe("75%");
    // Elsewhere the browser keeps its keys.
    expect(press(document.body, { key: "0", metaKey: true })).toBe(false);
    expect(zoomLabel()).toBe("75%");
    // A zoom is a view, not an edit.
    expect(changes).toEqual([]);
  });

  it("zooms to the selection with Cmd-2 and the item menu, and to everything with nothing selected", async () => {
    mount(placed());
    await flush();
    const el = sizeScroller(800, 600);
    select("P");
    expect(press(scroller(), { key: "2", metaKey: true })).toBe(true);
    await flush();
    // P is 260 x 280 at (100, 100): the height limits, 564 / 280.
    expect(zoomLabel()).toBe("201%");
    expect(el.scrollLeft).toBeCloseTo(230 * 2.01 - 400, 5);
    expect(el.scrollTop).toBeCloseTo(240 * 2.01 - 300, 5);
    act(() => { element("T1").blur?.(); });
    select();
    press(scroller(), { key: "2", metaKey: true });
    await flush();
    // Everything: (100, 100) to (660, 380), 560 wide.
    expect(zoomLabel()).toBe("136%");
    act(() => { element("T2").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 150 })); });
    act(() => menuItem("Zoom to selection").click());
    await flush();
    // T2 is 160 x 32: as near as the zoom goes, 400 %.
    expect(zoomLabel()).toBe("400%");
    expect(el.scrollLeft).toBeCloseTo(580 * 4 - 400, 5);
  });
});

describe("Layout sheet tabs", () => {
  it("reorders sheets by dragging a tab, one undo step", async () => {
    const changes = mount(threeSheets());
    await flush();
    expect(sheetNames()).toEqual(["S1", "S2", "S3"]);
    for (const tab of host.querySelectorAll<HTMLElement>(".gl-layout-sheet-tab")) {
      tab.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 28, right: 100, bottom: 28, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    }
    const before = changes.length;
    act(() => { sheetTab("S1").dispatchEvent(dragEvent("dragstart", 50)); });
    const over = dragEvent("dragover", 80);
    act(() => { sheetTab("S3").dispatchEvent(over); });
    expect(over.defaultPrevented).toBe(true);
    expect(sheetTab("S3").dataset.drop).toBe("after");
    act(() => { sheetTab("S3").dispatchEvent(dragEvent("drop", 80)); });
    expect(sheetNames()).toEqual(["S2", "S3", "S1"]);
    expect(changes.length).toBe(before + 1);
    expect(changes.at(-1)!.sheets.map((sheet) => sheet.name)).toEqual(["S2", "S3", "S1"]);
    // Dropped on the left half of S2, S1 goes before it.
    act(() => { sheetTab("S1").dispatchEvent(dragEvent("dragstart", 50)); });
    act(() => { sheetTab("S2").dispatchEvent(dragEvent("drop", 20)); });
    expect(sheetNames()).toEqual(["S1", "S2", "S3"]);
    press(scroller(), { key: "z", metaKey: true });
    expect(sheetNames()).toEqual(["S2", "S3", "S1"]);
    press(scroller(), { key: "z", metaKey: true });
    expect(sheetNames()).toEqual(["S1", "S2", "S3"]);
  });

  it("moves, renames, duplicates and deletes a sheet from its tab's menu", async () => {
    const changes = mount(threeSheets());
    await flush();
    const openMenu = (name: string) => act(() => { sheetTab(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 10 })); });
    openMenu("S1");
    expect(menuItem("Move left").disabled).toBe(true);
    act(() => menuItem("Move right").click());
    expect(sheetNames()).toEqual(["S2", "S1", "S3"]);
    openMenu("S3");
    expect(menuItem("Move right").disabled).toBe(true);
    act(() => menuItem("Move left").click());
    expect(sheetNames()).toEqual(["S2", "S3", "S1"]);
    press(scroller(), { key: "z", metaKey: true });
    expect(sheetNames()).toEqual(["S2", "S1", "S3"]);
    // Rename opens the tab's field, as a double-click does.
    openMenu("S3");
    act(() => menuItem("Rename").click());
    expect(host.querySelector<HTMLInputElement>(".gl-layout-sheet-rename")?.defaultValue).toBe("S3");
    act(() => host.querySelector<HTMLInputElement>(".gl-layout-sheet-rename")!.blur());
    // Duplicate copies that sheet, not the one shown, and shows the copy.
    openMenu("S1");
    act(() => menuItem("Duplicate").click());
    expect(sheetNames()).toEqual(["S2", "S1", "S3", "S1 copy"]);
    const copy = changes.at(-1)!;
    expect(copy.sheets[3].items.map((item) => item.recipe)).toEqual(copy.sheets[1].items.map((item) => item.recipe));
    expect(copy.activeSheetId).toBe(copy.sheets[3].id);
    // Delete removes that sheet; the shown one stays shown.
    openMenu("S3");
    act(() => menuItem("Delete").click());
    expect(sheetNames()).toEqual(["S2", "S1", "S1 copy"]);
    expect(changes.at(-1)!.activeSheetId).toBe(copy.sheets[3].id);
    // The toolbar's buttons are kept.
    expect(button("Duplicate sheet")).toBeDefined();
    expect(button("Delete sheet")).toBeDefined();
  });
});

describe("Export all sheets", () => {
  for (const format of ["pdf", "svg"] as const) {
    it(`writes every sheet with items, in sheet order, as one ${format === "pdf" ? "PDF" : "zip"}, and puts the user's sheet back`, async () => {
      const changes = mount(threeSheets());
      await flush();
      const el = sizeScroller();
      act(() => button("Page").click());
      const formatSelect = [...host.querySelectorAll<HTMLSelectElement>("select")].find((s) => [...s.options].some((o) => o.value === "svg"))!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(formatSelect, format);
        formatSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      // The user on S2, zoomed and scrolled, with U1 selected.
      act(() => button("Items").click());
      select("U1");
      press(scroller(), { key: "1", metaKey: true });
      el.scrollLeft = 120;
      el.scrollTop = 40;
      act(() => button("Page").click());
      const undoable = changes.length;
      const progress = new Set<string>();
      act(() => { button("Export all sheets").click(); });
      // In steps, so the tab draws each sheet it shows while the export waits for the plots.
      for (let i = 0; i < 100; i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        progress.add(host.querySelector<HTMLButtonElement>("button[title^='Write every sheet']")!.textContent ?? "");
      }
      expect(host.querySelector(".gl-layout-message")).toBeNull();
      expect(progress).toContain("Sheet 1 of 2");
      expect(progress).toContain("Sheet 2 of 2");
      expect(draws.written).toEqual([{ format, sheets: [{ name: "S1", pages: 1 }, { name: "S2", pages: 2 }], shown: expect.any(String) }]);
      // Back on S2, at 100 %, where the view was, with U1 selected; showing the sheets was no edit.
      expect(changes.at(-1)!.activeSheetId).toBe(changes.at(-1)!.sheets[1].id);
      expect(host.querySelector(".gl-layout-canvas")!.getAttribute("aria-label")).toBe("S2");
      expect(zoomLabel()).toBe("100%");
      expect([el.scrollLeft, el.scrollTop]).toEqual([120, 40]);
      expect(element("U1").classList.contains("is-selected")).toBe(true);
      expect(button("Export all sheets").disabled).toBe(false);
      press(scroller(), { key: "z", metaKey: true });
      expect(changes.length).toBeGreaterThan(undoable);
      expect(changes.at(-1)!.sheets.map((sheet) => sheet.name)).toEqual(["S1", "S2", "S3"]);
    });
  }
});

describe("The list of keys", () => {
  /** A press as the list writes it, as an event with Cmd for Mod. */
  function eventFor(press: string): KeyboardEventInit {
    const parts = press.split("+");
    const key = parts.at(-1)!;
    const name = key === "Space" ? " " : key.length === 1 ? key.toLowerCase() : key;
    return { key: name, code: key === "Space" ? "Space" : undefined, metaKey: parts.includes("Mod"), shiftKey: parts.includes("Shift") };
  }
  const listed = new Set(LAYOUT_KEYS.flatMap((group) => group.entries.flatMap((entry) => entry.presses ?? [])));

  it("is folded at first and remembers being opened", async () => {
    mount(placed());
    await flush();
    const fold = host.querySelector<HTMLDetailsElement>("details.gl-layout-keys")!;
    expect(fold.open).toBe(false);
    expect(fold.querySelector("summary.gl-fold-summary")?.textContent).toBe("Keys");
    expect([...fold.querySelectorAll("h4")].map((h) => h.textContent)).toEqual(["Select", "Move and resize", "Copy and paste", "Order and group", "View"]);
    act(() => { fold.open = true; fold.dispatchEvent(new Event("toggle")); });
    act(() => root.unmount());
    root = createRoot(host);
    mount(placed());
    await flush();
    expect(host.querySelector<HTMLDetailsElement>("details.gl-layout-keys")!.open).toBe(true);
  });

  it("keeps every key the sentence before it named", () => {
    const shown = LAYOUT_KEYS.flatMap((group) => group.entries.map((entry) => entry.keys)).join(" ");
    for (const key of ["Shift-click", "Option-drag", "Delete", "Arrow", "Cmd-D", "Cmd-A", "Cmd-]", "Cmd-[", "Cmd-G", "Shift-Cmd-G", "Shift-Cmd-L", "Cmd-Z", "Cmd-C", "Cmd-X", "Cmd-V", "Shift-Cmd-V", "Cmd-0", "Cmd-1", "Cmd-2", "Cmd-=", "Cmd--", "Space-drag"]) {
      expect(shown).toContain(key);
    }
  });

  it("names every key the page takes, and the page takes every key it names", async () => {
    const letters = "abcdefghijklmnopqrstuvwxyz0123456789[]=-".split("");
    const keyNames = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Delete", "Backspace", "Enter", "Escape", "Space", "Tab", "Home", "End"];
    const candidates = [
      ...letters.flatMap((key) => [key.toUpperCase(), `Mod+${key.toUpperCase()}`, `Mod+Shift+${key.toUpperCase()}`]),
      ...keyNames.flatMap((key) => [key, `Shift+${key}`, `Mod+${key}`]),
    ];
    const taken: string[] = [];
    for (const [index, candidate] of candidates.entries()) {
      // A fresh page each time, the text block T1 selected, so a key that removes or moves it does not change the next.
      mount(placed(), index);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      select("T1");
      const prevented = press(scroller(), eventFor(candidate));
      // Escape is taken without its default prevented: it empties the selection.
      const cleared = candidate === "Escape" && !element("T1").classList.contains("is-selected");
      if (prevented || cleared) taken.push(candidate);
    }
    // Several handlers do not look at a modifier they have no use for (Shift-Cmd-A selects all,
    // Cmd-arrow nudges, Shift-Delete removes, Shift-Space pans); such a press is the key named
    // without that modifier.
    const isNamed = (press: string) => listed.has(press) || listed.has(press.replace("Shift+", "")) || listed.has(press.replace("Mod+", ""));
    expect(taken.filter((press) => !isNamed(press))).toEqual([]);
    expect([...listed].filter((press) => !taken.includes(press))).toEqual([]);
  }, 60000);
});
