// @vitest-environment jsdom

import { act } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialCoreState, type Derived } from "../store";
import type { Gate, Population } from "../engine/models";
import { PopulationTree } from "./PopulationTree";

const styles = readFileSync("src/styles.css", "utf8");

let root: Root;
let host: HTMLDivElement;
let style: HTMLStyleElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  style = document.createElement("style");
  style.textContent = styles;
  document.head.appendChild(style);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  style.remove();
  vi.unstubAllGlobals();
});

function makeInteractionFixture() {
  const gates: Record<string, Gate> = {
    g1: {
      gate_id: "g1",
      name: "Gate one",
      gate_type: "rectangle",
      x_channel: "FSC-A",
      y_channel: "SSC-A",
      vertices: [[0, 0], [1, 1]],
      color: "#377eb8",
      label_offset: null,
    },
    g2: {
      gate_id: "g2",
      name: "Gate two",
      gate_type: "polygon",
      x_channel: "CD3",
      y_channel: "CD19",
      vertices: [[0, 0], [1, 0], [1, 1]],
      color: "#4daf4a",
      label_offset: null,
    },
  };
  const populations: Record<string, Population> = {
    root: {
      population_id: "root",
      name: "All Events",
      gate_refs: [],
      gate_logic: "and",
      parent_id: null,
      children: ["pop-b", "pop-a"],
      event_count: 100,
      percent_of_parent: 100,
    },
    "pop-b": {
      population_id: "pop-b",
      name: "Zulu",
      gate_refs: [{ gate_id: "g1", include: true }],
      gate_logic: "and",
      parent_id: "root",
      children: [],
      event_count: 60,
      percent_of_parent: 60,
    },
    "pop-a": {
      population_id: "pop-a",
      name: "Alpha",
      gate_refs: [],
      gate_logic: "and",
      parent_id: "root",
      children: [],
      event_count: 40,
      percent_of_parent: 40,
    },
  };
  const state = {
    ...initialCoreState(),
    gates,
    gate_order: ["g1", "g2"],
    populations,
    root_population_id: "root",
    active_population_id: "pop-b",
  };
  const derived: Derived = {
    masks: {},
    stats: {
      event_count: { root: 100, "pop-b": 60, "pop-a": 40 },
      percent_of_parent: { root: 100, "pop-b": 60, "pop-a": 40 },
      percent_of_total: { root: 100, "pop-b": 60, "pop-a": 40 },
    },
    gateCounts: {},
    activeMask: null,
    displayMask: null,
    displayPopCount: 0,
    populations,
  };
  return { state, derived };
}

describe("PopulationTree gate pills", () => {
  it("keeps every pill and wraps the pill lane instead of clipping it", () => {
    const gates: Record<string, Gate> = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => {
        const gateId = `gate-${i + 1}`;
        return [gateId, {
          gate_id: gateId,
          name: `Gate ${i + 1}`,
          gate_type: "rectangle" as const,
          x_channel: "FSC-A",
          y_channel: "SSC-A",
          vertices: [[0, 0], [1, 1]] as [number, number][],
          color: "#377eb8",
          label_offset: null,
        }];
      }),
    );
    const population: Population = {
      population_id: "root",
      name: "All Events",
      gate_refs: Object.keys(gates).map((gate_id) => ({ gate_id, include: true })),
      gate_logic: "and",
      parent_id: null,
      children: [],
      event_count: 100,
      percent_of_parent: 100,
    };
    const state = {
      ...initialCoreState(),
      gates,
      gate_order: Object.keys(gates),
      populations: { root: population },
      root_population_id: "root",
      active_population_id: "root",
    };
    const derived: Derived = {
      masks: {},
      stats: {
        event_count: { root: 100 },
        percent_of_parent: { root: 100 },
        percent_of_total: { root: 100 },
      },
      gateCounts: {},
      activeMask: null,
      displayMask: null,
      displayPopCount: 0,
      populations: { root: population },
    };

    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} />));

    const pillLane = host.querySelector<HTMLElement>(".pop-row-gates");
    const pillColumn = host.querySelector<HTMLElement>(".pop-row-gates-col");
    expect(host.querySelectorAll(".gate-ref-badge")).toHaveLength(8);
    expect(getComputedStyle(pillLane!).flexWrap).toBe("wrap");
    expect(getComputedStyle(pillLane!).width).toBe("100%");
    expect(getComputedStyle(pillColumn!).overflow).toBe("visible");
  });
});

describe("PopulationTree direct editing", () => {
  it("renders the persisted sibling order and double-clicks a name into inline rename", () => {
    const { state, derived } = makeInteractionFixture();
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));

    expect([...host.querySelectorAll<HTMLElement>(".pop-row")].map((row) => row.dataset.popId))
      .toEqual(["root", "pop-b", "pop-a"]);

    const name = host.querySelector<HTMLElement>('.pop-row[data-pop-id="pop-b"] .pop-row-name')!;
    act(() => name.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const input = host.querySelector<HTMLInputElement>(".pop-row-name-input")!;
    expect(input.value).toBe("Zulu");

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        .call(input, "Renamed population");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(dispatch).toHaveBeenCalledWith({
      type: "renamePopulation",
      popId: "pop-b",
      name: "Renamed population",
    });
  });

  it("keeps ordinary gate clicks as selection and uses Shift-click / + for gate editing", () => {
    const { state, derived } = makeInteractionFixture();
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));

    const gatePill = host.querySelector<HTMLElement>('.pop-row[data-pop-id="pop-b"] .pop-tree-gate-badge')!;
    act(() => gatePill.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "selectGate", gateId: "g1" });

    dispatch.mockClear();
    act(() => gatePill.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    const picker = host.querySelector<HTMLElement>(".pop-gate-picker")!;
    expect(picker).not.toBeNull();
    expect(picker.textContent).toContain("Change gate: Gate one");
    expect(picker.querySelector(".pop-gate-picker-current")?.textContent)
      .toContain("Current gate: Gate one");
    expect(picker.querySelector(".pop-gate-picker-choice.current")?.textContent)
      .toContain("Current");
    expect(dispatch).not.toHaveBeenCalled();
    const remove = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Remove this gate"))!;
    act(() => remove.click());
    expect(dispatch).toHaveBeenCalledWith({
      type: "setPopulationGateRefs",
      popId: "pop-b",
      gateRefs: [],
    });

    dispatch.mockClear();
    const add = host.querySelector<HTMLButtonElement>('.pop-row[data-pop-id="pop-b"] .pop-tree-gate-add')!;
    act(() => add.click());
    const secondGate = [...host.querySelectorAll<HTMLButtonElement>(".pop-gate-picker-choice")]
      .find((button) => button.textContent?.includes("Gate two"))!;
    act(() => secondGate.click());
    expect(dispatch).toHaveBeenCalledWith({
      type: "setPopulationGateRefs",
      popId: "pop-b",
      gateRefs: [
        { gate_id: "g1", include: true },
        { gate_id: "g2", include: true },
      ],
    });
  });

  it("keeps a long gate catalogue in a bounded scrollable list", () => {
    const { state, derived } = makeInteractionFixture();
    for (let index = 3; index <= 36; index++) {
      const gateId = `g${index}`;
      state.gates[gateId] = {
        gate_id: gateId,
        name: `Gate ${index}`,
        gate_type: "rectangle",
        x_channel: "FSC-A",
        y_channel: "SSC-A",
        vertices: [[0, 0], [1, 1]],
        color: "#377eb8",
        label_offset: null,
      };
      state.gate_order.push(gateId);
    }
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} />));

    const gatePill = host.querySelector<HTMLElement>('.pop-row[data-pop-id="pop-b"] .pop-tree-gate-badge')!;
    act(() => gatePill.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    const list = host.querySelector<HTMLElement>(".pop-gate-picker-list")!;

    expect(list.querySelectorAll(".pop-gate-picker-choice")).toHaveLength(36);
    expect(getComputedStyle(list).overflowY).toBe("auto");
    expect(getComputedStyle(list).flexGrow).toBe("1");
    expect(getComputedStyle(host.querySelector(".pop-gate-picker")!).maxHeight).toBe("360px");

    act(() => list.dispatchEvent(new Event("scroll")));
    expect(host.querySelector(".pop-gate-picker")).not.toBeNull();

    act(() => window.dispatchEvent(new Event("scroll")));
    expect(host.querySelector(".pop-gate-picker")).toBeNull();
  });

  it("turns a Shift-drag drop gesture into a precise reorder action", () => {
    const { state, derived } = makeInteractionFixture();
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));

    const source = host.querySelector<HTMLElement>('.pop-row[data-pop-id="pop-a"]')!;
    const target = host.querySelector<HTMLElement>('.pop-row[data-pop-id="pop-b"]')!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 300,
      bottom: 30,
      left: 0,
      width: 300,
      height: 30,
      toJSON: () => ({}),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn().mockReturnValue(target),
    });
    Object.defineProperties(source, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn().mockReturnValue(true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const pointerEvent = (
      type: string,
      options: { clientX: number; clientY: number; shiftKey?: boolean },
    ) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        pointerId: { value: 7 },
        button: { value: 0 },
        clientX: { value: options.clientX },
        clientY: { value: options.clientY },
        shiftKey: { value: options.shiftKey ?? false },
      });
      return event;
    };

    act(() => source.dispatchEvent(pointerEvent("pointerdown", {
      clientX: 100,
      clientY: 28,
      shiftKey: true,
    })));
    act(() => source.dispatchEvent(pointerEvent("pointermove", {
      clientX: 100,
      clientY: 2,
    })));
    expect(target.classList.contains("drop-before")).toBe(true);
    act(() => source.dispatchEvent(pointerEvent("pointerup", {
      clientX: 100,
      clientY: 2,
    })));

    expect(dispatch).toHaveBeenCalledWith({
      type: "movePopulation",
      popId: "pop-a",
      targetId: "pop-b",
      placement: "before",
    });
  });
});
