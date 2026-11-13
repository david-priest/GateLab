// @vitest-environment jsdom
// The Layout tab's objects list: the sheet's items top of the stack first, a click on a row
// selecting an item even under another, hide (not drawn, selected, marqueed or exported) and show,
// lock, rename, reorder by the menu and by drag with undo, a group's row, and a sheet saved
// before the list opening unchanged. Moveable and Selecto are stood in for by props recorders, as
// in LayoutTab.test.tsx. Synthetic samples D1 and D2.

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
const row = (id: string) => host.querySelector<HTMLElement>(`.gl-layout-objects [data-object-id="${id}"]`)!;
const nameButton = (id: string) => row(id).querySelector<HTMLButtonElement>(".gl-layout-object-name")!;
const toggle = (id: string, which: "Hide" | "Show" | "Lock" | "Unlock") =>
  [...row(id).querySelectorAll<HTMLButtonElement>(".gl-layout-object-toggle")].find((b) => b.getAttribute("aria-label")!.startsWith(`${which} `))!;
const menuItem = (id: string, label: string) =>
  [...row(id).querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === label)!;
/** The item rows in list order, top of the stack first. */
const rows = () => [...host.querySelectorAll<HTMLElement>(".gl-layout-objects li[data-object-id], .gl-layout-objects div[data-object-id]")].map((el) => el.dataset.objectId);
const selectedRows = () => [...host.querySelectorAll<HTMLElement>(".gl-layout-objects .gl-layout-object.is-selected")].map((el) => el.dataset.objectId);
const click = (el: HTMLElement, init: MouseEventInit = {}) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init })); });
function setInput(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const inputKey = (input: HTMLElement, key: string) => act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })); });
/** A drag event with a data transfer jsdom lacks. */
function dragEvent(type: string, clientY = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown; clientY: number };
  const data: Record<string, string> = {};
  Object.defineProperty(event, "dataTransfer", { value: { effectAllowed: "", setData: (k: string, v: string) => { data[k] = v; }, getData: (k: string) => data[k] ?? "" } });
  Object.defineProperty(event, "clientY", { value: clientY });
  return event;
}

/**
 * A plot P at the bottom of the stack, a text block T1 drawn over it, and a text block T2 on top,
 * elsewhere on the page.
 */
function stacked(extra: Record<string, unknown>[] = []): LayoutWorkspace {
  const saved = JSON.parse(JSON.stringify(createDefaultLayoutWorkspace()));
  saved.sheets[0].items = [
    { id: "P", x: 100, y: 100, width: 260, height: 280, z: 0, recipe: { kind: "biplot", sampleId: "D1", populationId: "", xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor" } },
    { id: "T1", x: 120, y: 120, width: 160, height: 32, z: 1, recipe: { kind: "text", text: "control", fontSize: 18 } },
    { id: "T2", x: 500, y: 100, width: 160, height: 32, z: 2, recipe: { kind: "text", text: "treated", fontSize: 18 } },
    ...extra,
  ];
  return normalizeLayoutWorkspace(saved);
}

function exportIds(changes: LayoutWorkspace[]) {
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
  const composed = composeLayoutSVG(canvas, changes.at(-1)?.sheets[0] ?? stacked().sheets[0], { dpi: 96, zoom: 1 });
  return { ids: [...composed.root.querySelectorAll("g[id]")].map((g) => g.getAttribute("id")), words: [...composed.root.querySelectorAll("text")].map((t) => t.textContent) };
}

describe("The Layout tab's objects list", () => {
  it("lists the items top of the stack first, by name, and a click selects an item under another", async () => {
    mount(stacked());
    await flush();
    const fold = host.querySelector<HTMLDetailsElement>("details.gl-layout-objects")!;
    expect(fold.open).toBe(true);
    expect(fold.querySelector("summary.gl-fold-summary")?.textContent).toBe("Objects");
    expect(rows()).toEqual(["T2", "T1", "P"]);
    expect(nameButton("T1").textContent).toBe("control");
    expect(row("T1").querySelector(".gl-layout-object-kind")?.textContent).toBe("Text");
    expect(nameButton("P").textContent).toBe("Population · D1.fcs");
    // P lies under T1; a click on its row selects it on the page.
    click(nameButton("P"));
    expect(element("P").classList.contains("is-selected")).toBe(true);
    expect(element("T1").classList.contains("is-selected")).toBe(false);
    expect(selectedRows()).toEqual(["P"]);
    // Shift adds, Cmd takes away, Space toggles.
    click(nameButton("T1"), { shiftKey: true });
    expect(selectedRows()).toEqual(["T1", "P"]);
    click(nameButton("P"), { metaKey: true });
    expect(selectedRows()).toEqual(["T1"]);
    act(() => { nameButton("T2").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: " " })); });
    expect(selectedRows()).toEqual(["T2", "T1"]);
    // A selection made on the page shows in the list.
    select("P");
    expect(selectedRows()).toEqual(["P"]);
    // The fold remembers being closed while the tab is open, across the inspector's tabs.
    act(() => { fold.open = false; fold.dispatchEvent(new Event("toggle")); });
    act(() => button("Page").click());
    act(() => button("Items").click());
    expect(host.querySelector<HTMLDetailsElement>("details.gl-layout-objects")!.open).toBe(false);
  });

  it("hides an item: not drawn, not selectable on the page, skipped by Select all and the export; shown again, with undo", async () => {
    const changes = mount(stacked());
    await flush();
    click(toggle("T1", "Hide"));
    expect(items(changes).find((item) => item.id === "T1")!.hidden).toBe(true);
    expect(element("T1")).toBeNull();
    expect(row("T1").classList.contains("is-hidden")).toBe(true);
    expect(toggle("T1", "Show").getAttribute("aria-pressed")).toBe("true");
    // Neither the marquee (which takes what the page draws) nor Select all reaches it.
    expect([...host.querySelectorAll("[data-item-id]")].map((el) => (el as HTMLElement).dataset.itemId)).not.toContain("T1");
    key({ key: "a", metaKey: true });
    expect(selectedRows().sort()).toEqual(["P", "T2"]);
    // Not exported.
    expect(exportIds(changes).words).toEqual(["treated"]);
    // Selected from the list it is, dimmed, and the page draws nothing for it.
    click(nameButton("T1"));
    expect(selectedRows()).toEqual(["T1"]);
    expect(host.querySelector(".gl-layout-inspector")?.textContent).toContain("Selected");
    // Shown again; and hiding is one undo step.
    click(toggle("T1", "Show"));
    expect(items(changes).find((item) => item.id === "T1")).not.toHaveProperty("hidden");
    expect(element("T1")).not.toBeNull();
    key({ key: "z", metaKey: true });
    expect(element("T1")).toBeNull();
    key({ key: "z", metaKey: true });
    expect(element("T1")).not.toBeNull();
  });

  it("hides a lettered item's panel letter with it and leaves the other letters as they are", async () => {
    const changes = mount(stacked([
      { id: "P2", x: 500, y: 300, width: 260, height: 280, z: 3, recipe: { kind: "biplot", sampleId: "D2", populationId: "", xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor" } },
    ]));
    await flush();
    act(() => button("Panel letters").click());
    const letterOf = (id: string) => items(changes).find((item) => item.recipe.kind === "text" && item.recipe.letterFor === id)!;
    expect([letterOf("P").recipe, letterOf("P2").recipe].map((r) => (r as { text: string }).text)).toEqual(["A", "B"]);
    click(toggle("P", "Hide"));
    expect(element(letterOf("P").id)).toBeNull();
    expect(element(letterOf("P2").id)).not.toBeNull();
    expect((letterOf("P2").recipe as { text: string }).text).toBe("B");
  });

  it("locks and unlocks from the list", async () => {
    const changes = mount(stacked());
    await flush();
    click(toggle("P", "Lock"));
    expect(items(changes).find((item) => item.id === "P")!.locked).toBe(true);
    expect(element("P").classList.contains("is-locked")).toBe(true);
    click(toggle("P", "Unlock"));
    expect(items(changes).find((item) => item.id === "P")!.locked).toBe(false);
  });

  it("renames by double-click: Enter keeps it, Escape drops it, an empty name returns to the default; the name is the export's id", async () => {
    const changes = mount(stacked());
    await flush();
    act(() => { nameButton("T1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    let input = row("T1").querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("control");
    setInput(input, "Day 7 heading");
    inputKey(input, "Enter");
    expect(items(changes).find((item) => item.id === "T1")!.name).toBe("Day 7 heading");
    expect(nameButton("T1").textContent).toBe("Day 7 heading");
    expect(element("T1").dataset.objectName).toBe("Day 7 heading");
    const { ids } = exportIds(changes);
    expect(ids).toContain("Day-7-heading");
    expect(ids.some((id) => id?.startsWith("text-") && id.endsWith("-treated"))).toBe(true);
    // Escape leaves the name as it was.
    const edits = changes.length;
    act(() => { nameButton("T1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    input = row("T1").querySelector<HTMLInputElement>("input")!;
    setInput(input, "something else");
    inputKey(input, "Escape");
    expect(changes.length).toBe(edits);
    expect(nameButton("T1").textContent).toBe("Day 7 heading");
    // Empty: the default again.
    act(() => { nameButton("T1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    input = row("T1").querySelector<HTMLInputElement>("input")!;
    setInput(input, "  ");
    inputKey(input, "Enter");
    expect(items(changes).find((item) => item.id === "T1")).not.toHaveProperty("name");
    expect(nameButton("T1").textContent).toBe("control");
    // Accepting the default as shown gives no name of its own.
    act(() => menuItem("T2", "Rename").click());
    inputKey(row("T2").querySelector<HTMLInputElement>("input")!, "Enter");
    expect(items(changes).find((item) => item.id === "T2")).not.toHaveProperty("name");
  });

  it("reorders by the menu and by drag, one undo step each, and follows Bring to front", async () => {
    const changes = mount(stacked());
    await flush();
    const zOf = (id: string) => items(changes).find((item) => item.id === id)!.z;
    act(() => menuItem("T2", "Move down").click());
    expect(rows()).toEqual(["T1", "T2", "P"]);
    expect([zOf("T1"), zOf("T2"), zOf("P")]).toEqual([2, 1, 0]);
    expect(element("T2").style.zIndex).toBe("1");
    key({ key: "z", metaKey: true });
    expect(rows()).toEqual(["T2", "T1", "P"]);
    // P dragged above T2, onto the top half of its row.
    act(() => { row("P").dispatchEvent(dragEvent("dragstart")); });
    act(() => { row("T2").dispatchEvent(dragEvent("dragover", 0)); });
    act(() => { row("T2").dispatchEvent(dragEvent("drop", 0)); });
    expect(rows()).toEqual(["P", "T2", "T1"]);
    expect(zOf("P")).toBe(2);
    key({ key: "z", metaKey: true });
    expect(rows()).toEqual(["T2", "T1", "P"]);
    // The inspector's Bring to front, and the list follows.
    click(nameButton("P"));
    act(() => button("Bring to front").click());
    expect(rows()).toEqual(["P", "T2", "T1"]);
  });

  it("shows a group's members under its row, folds them, and selects the group from it", async () => {
    mount(stacked([
      { id: "G1", x: 100, y: 500, width: 160, height: 32, z: 3, group: "G", recipe: { kind: "text", text: "D1", fontSize: 18 } },
      { id: "G2", x: 300, y: 500, width: 160, height: 32, z: 4, group: "G", recipe: { kind: "text", text: "D2", fontSize: 18 } },
    ]));
    await flush();
    expect(rows()).toEqual(["group:G", "G2", "G1", "T2", "T1", "P"]);
    expect(nameButton("group:G").textContent).toBe("Group of 2");
    click(nameButton("group:G"));
    expect(selectedRows()).toEqual(["group:G", "G2", "G1"]);
    expect(element("G1").classList.contains("is-selected")).toBe(true);
    const fold = row("group:G").querySelector<HTMLButtonElement>(".gl-layout-object-fold")!;
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    click(fold);
    expect(rows()).toEqual(["group:G", "T2", "T1", "P"]);
  });

  it("opens a sheet saved without names or hidden items unchanged", async () => {
    const changes = mount(stacked());
    await flush();
    expect(changes).toHaveLength(0);
    for (const id of ["P", "T1", "T2"]) expect(element(id)).not.toBeNull();
    expect(host.querySelectorAll(".gl-layout-object.is-hidden")).toHaveLength(0);
    expect(element("T1").dataset.objectName).toBeUndefined();
  });
});
