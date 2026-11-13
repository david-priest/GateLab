// @vitest-environment jsdom
// The Layout tab's clipboard: Cmd-C, Cmd-X, Cmd-V and Shift-Cmd-V, and the menu entries, between
// the sheets of a workspace. Moveable and Selecto are stood in for as in LayoutTab.test.tsx.
// Synthetic samples D1 and D2; nothing here is a real experiment.

import { act, forwardRef, useImperativeHandle, useState } from "react";
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
import { clearPersistedTabState } from "./tabState";

const draws = vi.hoisted(() => ({ selecto: null as Record<string, any> | null }));
vi.mock("../plots/loadPlots", () => ({
  loadMiniPlots: () => ({
    renderMiniPlot: (host: HTMLElement) => {
      host.setAttribute("style", "position: relative; width: 200px; height: 200px; display: inline-block;");
    },
    renderStrategyGrid: () => {},
  }),
}));
vi.mock("../plots/layoutExport", () => ({
  composeSheetPages: () => [],
  writeComposedPages: async () => {},
}));
vi.mock("react-moveable", () => ({
  default: forwardRef((_props: Record<string, any>, ref) => {
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
  clearPersistedTabState();
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
const keyOn = (target: Element, init: KeyboardEventInit) => act(() => {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});
const key = (init: KeyboardEventInit) => keyOn(page(), init);
const element = (id: string) => host.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!;
const select = (...ids: string[]) => act(() => {
  draws.selecto!.onSelectEnd({ selected: ids.map(element), isDragStart: false, isClick: ids.length <= 1, inputEvent: {} });
});
const selected = () => [...host.querySelectorAll(".gl-layout-item.is-selected")].map((el) => el.getAttribute("data-item-id"));
const menuItem = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === label);
const openItemMenu = (id: string) => act(() => { element(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 150 })); });
const openPageMenu = () => act(() => { host.querySelector<HTMLElement>(".gl-layout-canvas")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 250 })); });

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
    { id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs), metadata: { donor: "D1", group: "control" } },
    { id: "D2", name: "D2.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs), metadata: { donor: "D2", group: "treated" } },
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
          metadataColumns={["donor", "group"]}
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
const sheetItems = (changes: LayoutWorkspace[], index = 0) => changes.at(-1)!.sheets[index].items;

describe("Layout clipboard keys", () => {
  it("copies and pastes on one sheet 20 px on, stepping each time, on top and selected; one undo step each", () => {
    const changes = mount();
    act(() => button("+ Text").click());
    act(() => button("+ Text").click());
    const [a, b] = sheetItems(changes);
    select(a.id, b.id);
    key({ key: "c", metaKey: true });
    const before = changes.length;
    key({ key: "v", metaKey: true });
    expect(changes.length).toBe(before + 1);
    const pasted = sheetItems(changes).slice(2);
    expect(pasted.map(({ x, y }) => [x, y])).toEqual([[a.x + 20, a.y + 20], [b.x + 20, b.y + 20]]);
    expect(pasted.map(({ z }) => z)).toEqual([b.z + 1, b.z + 2]); // on top, a under b as before
    expect(selected()).toEqual(pasted.map(({ id }) => id));
    key({ key: "v", ctrlKey: true });
    expect(sheetItems(changes).slice(4).map(({ x, y }) => [x, y])).toEqual([[a.x + 40, a.y + 40], [b.x + 40, b.y + 40]]);
    key({ key: "z", metaKey: true });
    expect(sheetItems(changes)).toHaveLength(4);
    // Paste in place: the originals' coordinates.
    key({ key: "v", metaKey: true, shiftKey: true });
    expect(sheetItems(changes).slice(4).map(({ x, y }) => [x, y])).toEqual([[a.x, a.y], [b.x, b.y]]);
  });

  it("pastes on another sheet at the originals' place, and the clipboard survives the change of sheet", () => {
    const changes = mount();
    act(() => button("+ Text").click());
    const [a] = sheetItems(changes);
    select(a.id);
    key({ key: "c", metaKey: true });
    act(() => host.querySelector<HTMLButtonElement>(".gl-layout-sheet-add")!.click());
    key({ key: "v", metaKey: true });
    expect(sheetItems(changes, 1)).toHaveLength(1);
    expect(sheetItems(changes, 1)[0]).toMatchObject({ x: a.x, y: a.y });
    key({ key: "v", metaKey: true });
    expect(sheetItems(changes, 1)[1]).toMatchObject({ x: a.x + 20, y: a.y + 20 });
    expect(sheetItems(changes, 0)).toHaveLength(1);
  });

  it("cuts: the items go in one undo step and paste back", () => {
    const changes = mount();
    act(() => button("+ Text").click());
    act(() => button("+ Text").click());
    const [a] = sheetItems(changes);
    select(a.id);
    const before = changes.length;
    key({ key: "x", metaKey: true });
    expect(changes.length).toBe(before + 1);
    expect(sheetItems(changes).map(({ id }) => id)).not.toContain(a.id);
    key({ key: "v", metaKey: true });
    expect(sheetItems(changes)).toHaveLength(2);
    expect(sheetItems(changes)[1]).toMatchObject({ x: a.x + 20, y: a.y + 20 });
    key({ key: "z", metaKey: true });
    key({ key: "z", metaKey: true });
    expect(sheetItems(changes).map(({ id }) => id)).toContain(a.id);
  });

  it("re-points a heading copied with its plot, and keeps or drops the link of one copied alone", async () => {
    const changes = mount();
    await flush();
    act(() => button("+ Biplot").click());
    act(() => button("+ Text").click());
    await flush();
    const [plot, note] = sheetItems(changes);
    select(note.id);
    const readsFrom = host.querySelector<HTMLSelectElement>('select[aria-label="Reads from"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(readsFrom, plot.id);
      readsFrom.dispatchEvent(new Event("change", { bubbles: true }));
    });
    select(plot.id, note.id);
    key({ key: "c", metaKey: true });
    key({ key: "v", metaKey: true });
    const [, , plotCopy, noteCopy] = sheetItems(changes);
    expect(noteCopy.recipe).toMatchObject({ kind: "text", readsFrom: plotCopy.id });
    // The heading alone: on its own sheet it still reads the original, on another it reads nothing.
    select(note.id);
    key({ key: "c", metaKey: true });
    key({ key: "v", metaKey: true });
    expect(sheetItems(changes).at(-1)!.recipe).toMatchObject({ kind: "text", readsFrom: plot.id });
    act(() => host.querySelector<HTMLButtonElement>(".gl-layout-sheet-add")!.click());
    key({ key: "v", metaKey: true });
    expect(sheetItems(changes, 1)[0].recipe).not.toHaveProperty("readsFrom");
  });

  it("does nothing while a text block is edited or an inspector field has the keyboard", () => {
    const changes = mount();
    act(() => button("+ Text").click());
    const [a] = sheetItems(changes);
    select(a.id);
    key({ key: "c", metaKey: true });
    // The block's editor open: the keys are the text field's.
    act(() => { element(a.id).querySelector<HTMLElement>(".gl-layout-text-surface")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    const editor = element(a.id).querySelector<HTMLTextAreaElement>("textarea")!;
    expect(editor).not.toBeNull();
    const count = changes.length;
    keyOn(editor, { key: "v", metaKey: true });
    keyOn(editor, { key: "x", metaKey: true });
    key({ key: "v", metaKey: true });
    expect(changes.length).toBe(count);
    expect(sheetItems(changes)).toHaveLength(1);
    act(() => { editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    // An inspector field.
    select(a.id);
    const field = host.querySelector<HTMLInputElement>(".gl-layout-controls input")!;
    expect(field).not.toBeNull();
    const event = new KeyboardEvent("keydown", { key: "v", metaKey: true, bubbles: true, cancelable: true });
    act(() => { field.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(sheetItems(changes)).toHaveLength(1);
  });
});

describe("Layout clipboard menus", () => {
  it("offers Copy and Cut on an item, and Paste and Paste in place, disabled until something is copied", () => {
    const changes = mount();
    act(() => button("+ Text").click());
    const [a] = sheetItems(changes);
    openPageMenu();
    expect(menuItem("Paste")?.disabled).toBe(true);
    expect(menuItem("Paste in place")?.disabled).toBe(true);
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    openItemMenu(a.id);
    expect(menuItem("Cut")).toBeDefined();
    expect(menuItem("Paste")?.disabled).toBe(true);
    act(() => menuItem("Copy")!.click());
    openItemMenu(a.id);
    expect(menuItem("Paste")?.disabled).toBe(false);
    act(() => menuItem("Paste in place")!.click());
    expect(sheetItems(changes)).toHaveLength(2);
    expect(sheetItems(changes)[1]).toMatchObject({ x: a.x, y: a.y });
    openPageMenu();
    expect(menuItem("Paste")?.disabled).toBe(false);
    act(() => menuItem("Paste")!.click());
    expect(sheetItems(changes)[2]).toMatchObject({ x: a.x + 20, y: a.y + 20 });
    // Cut from the item's menu.
    openItemMenu(a.id);
    act(() => menuItem("Cut")!.click());
    expect(sheetItems(changes).map(({ id }) => id)).not.toContain(a.id);
  });

  it("keeps the clipboard when the tab is left and returned to, and empties it when another workspace is opened", () => {
    let changes = mount();
    act(() => button("+ Text").click());
    const workspace = changes.at(-1)!;
    select(sheetItems(changes)[0].id);
    key({ key: "c", metaKey: true });
    // Another tab and back: the tab unmounts and mounts again.
    act(() => root.unmount());
    root = createRoot(host);
    changes = mount(workspace);
    openPageMenu();
    expect(menuItem("Paste")?.disabled).toBe(false);
    // Another workspace opened: the app clears the session's tab state and remounts the tab.
    act(() => root.unmount());
    clearPersistedTabState();
    root = createRoot(host);
    changes = mount(workspace);
    openPageMenu();
    expect(menuItem("Paste")?.disabled).toBe(true);
    key({ key: "v", metaKey: true });
    expect(changes).toHaveLength(0);
  });
});
