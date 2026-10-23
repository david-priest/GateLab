// @vitest-environment jsdom
// The gate list's one selection: the highlight, with no tick column. A click selects one gate,
// Shift-click a range from the selected gate, Cmd/Ctrl-click one more or one fewer, Cmd/Ctrl-A every
// gate, and Escape or a click on empty space goes back to the selected gate. Synthetic gates G1 to G3.

import { act, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GateList } from "./GateList";
import { coreReducer, initialCoreState, type Action, type CoreState } from "../store";
import { gateIdsToDelete } from "./gateSelection";

let root: Root;
let host: HTMLDivElement;
let latest: CoreState;

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

function fixture(): CoreState {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
  for (const name of ["G1", "G2", "G3"]) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name, xChannel: "A", yChannel: "B", vertices: [[0, 0], [1, 1]] });
  }
  return coreReducer(state, { type: "selectGate", gateId: state.gate_order[0] });
}
function Live({ initial }: { initial: CoreState }) {
  const [state, dispatch] = useReducer(coreReducer, initial);
  latest = state;
  return <GateList state={state} derived={{ gateCounts: {} } as never} dispatch={(action: Action) => dispatch(action)} />;
}
const card = (name: string) => [...host.querySelectorAll<HTMLElement>(".gate-card")].find((row) => row.querySelector(".gate-card-name")?.textContent?.startsWith(name))!;
const click = (name: string, init: MouseEventInit = {}) => act(() => { card(name).dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })); });
const highlighted = () => [...host.querySelectorAll<HTMLElement>(".gate-card.selected, .gate-card.highlighted")].map((row) => row.querySelector(".gate-card-name")!.textContent);
const key = (key: string, init: KeyboardEventInit = {}) => act(() => {
  host.querySelector(".gate-list-panel")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
});

describe("the gate list's one selection", () => {
  it("has no tick column, and a click selects one gate", () => {
    act(() => root.render(<Live initial={fixture()} />));
    expect(host.querySelector('.gate-card input[type="checkbox"]')).toBeNull();
    click("G2");
    expect(highlighted()).toEqual(["G2"]);
    expect(latest.selected_gate_ids).toEqual([]);
  });

  it("highlights a range with Shift and one more with Cmd/Ctrl, and Delete takes them all", () => {
    act(() => root.render(<Live initial={fixture()} />));
    click("G3", { shiftKey: true });
    expect(highlighted()).toEqual(["G1", "G2", "G3"]);
    click("G2", { metaKey: true });
    expect(highlighted()).toEqual(["G1", "G3"]);
    expect(card("G1").classList.contains("selected")).toBe(true);
    expect(gateIdsToDelete(latest)).toEqual(latest.selected_gate_ids);
    expect(latest.selected_gate_ids.map((id) => latest.gates[id].name)).toEqual(["G1", "G3"]);
    click("G2", { ctrlKey: true });
    expect(highlighted()).toEqual(["G1", "G2", "G3"]);
  });

  it("highlights every gate with Cmd/Ctrl-A, and goes back to the selected one with Escape or a click on empty space", () => {
    act(() => root.render(<Live initial={fixture()} />));
    key("a", { metaKey: true });
    expect(highlighted()).toEqual(["G1", "G2", "G3"]);
    key("Escape");
    expect(highlighted()).toEqual(["G1"]);
    key("a", { ctrlKey: true });
    act(() => host.querySelector<HTMLElement>(".gate-list-panel")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(highlighted()).toEqual(["G1"]);
  });

  it("starts a new selection when another gate is selected from outside the highlight, and keeps it from inside", () => {
    let state = fixture();
    state = coreReducer(state, { type: "selectGates", gateId: state.gate_order[0], gateIds: state.gate_order.slice(0, 2) });
    expect(coreReducer(state, { type: "selectGate", gateId: state.gate_order[1] }).selected_gate_ids).toHaveLength(2);
    expect(coreReducer(state, { type: "selectGate", gateId: state.gate_order[2] }).selected_gate_ids).toEqual([]);
    expect(coreReducer(state, { type: "selectGate", gateId: null }).selected_gate_ids).toEqual([]);
  });
});

describe("the population tree's selection in the store", () => {
  it("holds the whole highlight when it is more than the active row, and drops it when the active row moves outside it", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
    for (const name of ["P1", "P2", "P3"]) {
      state = coreReducer(state, { type: "addGate", gateType: "rectangle", name, xChannel: "A", yChannel: "B", vertices: [[0, 0], [1, 1]],
        createPop: { name, parentId: state.root_population_id! } });
    }
    const [p1, p2, p3] = state.populations[state.root_population_id!].children;
    let next = coreReducer(state, { type: "selectPopulations", activeId: p1, popIds: [p2] });
    expect(next.active_population_id).toBe(p1);
    expect(next.selected_pop_ids).toEqual([p1, p2]);
    // One row alone is no multiple selection; the root is never part of one.
    expect(coreReducer(next, { type: "selectPopulations", activeId: p2, popIds: [state.root_population_id!] }).selected_pop_ids).toEqual([]);
    expect(coreReducer(next, { type: "setActivePopulation", popId: p2 }).selected_pop_ids).toEqual([p1, p2]);
    next = coreReducer(next, { type: "setActivePopulation", popId: p3 });
    expect(next.selected_pop_ids).toEqual([]);
  });
});
