// @vitest-environment jsdom
// The right-click menus of the gate list and the population tree (David, 2026-11-10): a right-click
// on a highlighted row acts on every highlighted row, one elsewhere selects that row alone first, and
// one on empty space opens the pane's ⋯ menu. Delete in the focused tree deletes its highlighted rows,
// never the selected gate.

import { act, useReducer, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GateList } from "./GateList";
import { PopulationTree, type PopulationRowActions } from "./PopulationTree";
import { coreReducer, initialCoreState, type Action, type CoreState, type Derived } from "../store";
import type { MenuEntry } from "./MenuButton";
import { populationColor } from "../engine/palettes";

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

/** Three rectangle gates, each with a population under the root: Cells, CD4_positive, CD8_positive. */
function fixture(): CoreState {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
  for (const name of ["Cells", "CD4_positive", "CD8_positive"]) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name, xChannel: "A", yChannel: "B", vertices: [[0, 0], [1, 1]],
      createPop: { name, parentId: state.root_population_id! } });
  }
  return state;
}

const rightClick = (el: Element) => act(() => {
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
});
const menuLabels = () => [...document.querySelectorAll(".gl-context-menu [role^=menuitem]")].map((item) => item.textContent?.trim());
const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".gl-context-menu [role^=menuitem]")].find((item) => item.textContent?.trim() === label)!;

describe("the gate list's right-click menu", () => {
  function GateHarness({ initial, contextMenuOf, paneMenu }: { initial: CoreState; contextMenuOf: (gid: string, targets: readonly string[]) => MenuEntry[]; paneMenu?: MenuEntry[] }) {
    const [state, dispatch] = useReducer(coreReducer, initial);
    return <GateList state={state} derived={{ gateCounts: {} } as never} dispatch={dispatch} contextMenuOf={contextMenuOf} paneMenu={paneMenu} />;
  }
  const card = (name: string) => [...host.querySelectorAll<HTMLElement>(".gate-card")].find((row) => row.querySelector(".gate-card-name")?.textContent?.startsWith(name))!;

  it("selects a row that is not highlighted and acts on it alone", () => {
    const state = fixture();
    const [cells, cd4] = state.gate_order;
    const highlightedFirst = coreReducer(state, { type: "selectGates", gateId: cells, gateIds: [cells, state.gate_order[2]] });
    const remove = vi.fn();
    const menuOf = vi.fn((_gid: string, targets: readonly string[]) => [{ label: "Delete…", onClick: () => remove(targets) }]);
    act(() => root.render(<GateHarness initial={highlightedFirst} contextMenuOf={menuOf} />));
    rightClick(card("CD4_positive"));
    expect(menuOf).toHaveBeenCalledWith(cd4, [cd4]);
    expect(card("CD4_positive").classList.contains("selected")).toBe(true);
    expect(card("Cells").classList.contains("highlighted")).toBe(false);
    act(() => menuItem("Delete…").click());
    expect(remove).toHaveBeenCalledWith([cd4]);
  });

  it("acts on every highlighted gate, in list order, when the row is one of them", () => {
    const state = fixture();
    const [cells, cd4, cd8] = state.gate_order;
    const highlighted = coreReducer(state, { type: "selectGates", gateId: cd8, gateIds: [cd8, cells] });
    const menuOf = vi.fn(() => [{ label: "Delete 2 gates…", onClick: () => undefined }]);
    act(() => root.render(<GateHarness initial={highlighted} contextMenuOf={menuOf} />));
    rightClick(card("Cells"));
    expect(menuOf).toHaveBeenCalledWith(cells, [cells, cd8]);
    expect(card("CD8_positive").classList.contains("selected")).toBe(true);
    expect(card("CD4_positive").classList.contains("highlighted")).toBe(false);
    expect(menuLabels()).toEqual(["Delete 2 gates…"]);
    void cd4;
  });

  it("opens the pane's menu on empty space", () => {
    const sort = vi.fn();
    act(() => root.render(<GateHarness initial={fixture()} contextMenuOf={() => []} paneMenu={[{ label: "Sort A→Z", onClick: sort }]} />));
    rightClick(host.querySelector(".gate-list-panel")!);
    expect(menuLabels()).toEqual(["Sort A→Z"]);
    act(() => menuItem("Sort A→Z").click());
    expect(sort).toHaveBeenCalled();
  });
});

describe("the population tree's right-click menu and Delete key", () => {
  function TreeHarness({ initial, actions, onDispatch, paneMenu, colours = false }: { initial: CoreState; actions: PopulationRowActions; onDispatch?: (a: Action) => void; paneMenu?: MenuEntry[]; colours?: boolean }) {
    const [state, dispatch] = useReducer(coreReducer, initial);
    const [showColours, setShowColours] = useState(colours);
    const derived = { stats: { event_count: {}, percent_of_parent: {}, percent_of_total: {} } } as unknown as Derived;
    return (
      <div id="population_tree_container" tabIndex={0}>
        <PopulationTree state={state} derived={derived} dispatch={(a) => { onDispatch?.(a); dispatch(a); }} actions={actions} paneMenu={paneMenu} showHierarchyControls={false} showColours={showColours} onShowColours={setShowColours} />
      </div>
    );
  }
  const row = (name: string) => [...host.querySelectorAll<HTMLElement>(".pop-row")].find((r) => r.querySelector(".pop-row-name")?.textContent === name)!;
  const idOf = (state: CoreState, name: string) => Object.values(state.populations).find((p) => p.name === name)!.population_id;
  const actionsSpy = () => ({ edit: vi.fn(), addChild: vi.fn(), remove: vi.fn() });

  it("offers one row's actions and selects it", () => {
    const state = fixture();
    const actions = actionsSpy();
    act(() => root.render(<TreeHarness initial={state} actions={actions} />));
    rightClick(row("CD4_positive"));
    expect(row("CD4_positive").classList.contains("active")).toBe(true);
    expect(menuLabels()).toEqual(["Rename…", "Edit…", "Reset colour", "Show population colours", "New child population…", "Duplicate", "Copy name", "Delete…"]);
    act(() => menuItem("Delete…").click());
    expect(actions.remove).toHaveBeenCalledWith([idOf(state, "CD4_positive")], "confirm");
  });

  it("shows no population colours until the row menu's Show population colours is ticked", () => {
    act(() => root.render(<TreeHarness initial={fixture()} actions={actionsSpy()} />));
    const swatches = () => host.querySelectorAll(".pop-row-swatch").length;
    expect(swatches()).toBe(0);
    rightClick(row("CD4_positive"));
    expect(menuItem("Show population colours").getAttribute("aria-checked")).toBe("false");
    act(() => menuItem("Show population colours").click());
    // One for every population but the root.
    expect(swatches()).toBe(host.querySelectorAll(".pop-row").length - 1);
    rightClick(row("CD4_positive"));
    expect(menuItem("Show population colours").getAttribute("aria-checked")).toBe("true");
    act(() => menuItem("Show population colours").click());
    expect(swatches()).toBe(0);
  });

  it("shows each population's colour in a swatch, sets it from the colour input and resets it from the menu", () => {
    const state = fixture();
    const cd4 = idOf(state, "CD4_positive");
    const dispatched = vi.fn();
    act(() => root.render(<TreeHarness initial={state} actions={actionsSpy()} onDispatch={dispatched} colours />));
    const swatch = () => row("CD4_positive").querySelector<HTMLLabelElement>(".pop-row-swatch")!;
    const input = () => swatch().querySelector<HTMLInputElement>("input[type=color]")!;
    expect(input().value).toBe(populationColor("default", state.populations[cd4].colorSlot));
    expect(row("All Events").querySelector(".pop-row-swatch")).toBeNull();
    // Moving through the picker repaints the swatch; the choice is set once, on change.
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), "#123456");
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(dispatched).not.toHaveBeenCalled();
    act(() => { input().dispatchEvent(new Event("change", { bubbles: true })); });
    expect(dispatched).toHaveBeenCalledWith({ type: "setPopulationColor", popId: cd4, color: "#123456" });
    expect(input().value).toBe("#123456");
    expect(swatch().style.background).not.toBe("");
    rightClick(row("CD4_positive"));
    expect(menuItem("Reset colour").disabled).toBe(false);
    act(() => menuItem("Reset colour").click());
    expect(dispatched).toHaveBeenLastCalledWith({ type: "setPopulationColor", popId: cd4, color: null });
    expect(input().value).toBe(populationColor("default", state.populations[cd4].colorSlot));
    rightClick(row("CD4_positive"));
    expect(menuItem("Reset colour").disabled).toBe(true);
  });

  it("acts on every highlighted row when the row is one of them", () => {
    const state = fixture();
    const cells = idOf(state, "Cells"), cd8 = idOf(state, "CD8_positive");
    const highlighted = coreReducer(state, { type: "selectPopulations", activeId: cells, popIds: [cells, cd8] });
    const actions = actionsSpy();
    const dispatched = vi.fn();
    act(() => root.render(<TreeHarness initial={highlighted} actions={actions} onDispatch={dispatched} />));
    rightClick(row("CD8_positive"));
    expect(dispatched).not.toHaveBeenCalled();
    expect(menuLabels()).toEqual(["Duplicate 2 populations", "Copy 2 names", "Delete 2 populations…"]);
    act(() => menuItem("Delete 2 populations…").click());
    expect(actions.remove).toHaveBeenCalledWith([cells, cd8], "confirm");
  });

  it("starts an inline rename and a child population from the row", () => {
    const state = fixture();
    const actions = actionsSpy();
    act(() => root.render(<TreeHarness initial={state} actions={actions} />));
    rightClick(row("Cells"));
    act(() => menuItem("New child population…").click());
    expect(actions.addChild).toHaveBeenCalledWith(idOf(state, "Cells"));
    rightClick(row("Cells"));
    act(() => menuItem("Rename…").click());
    expect(host.querySelector<HTMLInputElement>(".pop-row-name-input")?.value).toBe("Cells");
  });

  it("gives the root no Rename, Duplicate or Delete", () => {
    act(() => root.render(<TreeHarness initial={fixture()} actions={actionsSpy()} />));
    rightClick(row("All Events"));
    expect(menuLabels()).toEqual(["New child population…", "Collapse branch", "Collapse every branch under it", "Copy name"]);
  });

  it("opens the pane's menu on empty space", () => {
    act(() => root.render(<TreeHarness initial={fixture()} actions={actionsSpy()} paneMenu={[{ label: "Sort A→Z", onClick: () => undefined }]} />));
    rightClick(host.querySelector(".population-tree-rows")!);
    expect(menuLabels()).toEqual(["Sort A→Z"]);
  });

  it("deletes the highlighted rows on Delete, and never lets the key reach the gate's handler", () => {
    const state = fixture();
    const cells = idOf(state, "Cells"), cd4 = idOf(state, "CD4_positive");
    const highlighted = coreReducer(state, { type: "selectPopulations", activeId: cd4, popIds: [cd4, cells] });
    const actions = actionsSpy();
    act(() => root.render(<TreeHarness initial={highlighted} actions={actions} />));
    const press = () => {
      const event = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
      act(() => { host.querySelector<HTMLElement>("#population_tree_container")!.dispatchEvent(event); });
      return event;
    };
    expect(press().defaultPrevented).toBe(true);
    expect(actions.remove).toHaveBeenCalledWith([cells, cd4], "now");

    // Only the root highlighted: nothing to delete, and still no gate deleted.
    act(() => root.render(<TreeHarness key="root" initial={coreReducer(state, { type: "selectPopulations", activeId: state.root_population_id!, popIds: [] })} actions={actions} />));
    actions.remove.mockClear();
    expect(press().defaultPrevented).toBe(true);
    expect(actions.remove).not.toHaveBeenCalled();
  });
});
