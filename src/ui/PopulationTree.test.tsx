// @vitest-environment jsdom

import { act } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreReducer, initialCoreState, type Derived } from "../store";
import type { Gate, Population } from "../engine/models";
import { PopulationTree, type TreeControlsProps } from "./PopulationTree";

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

describe("PopulationTree gate alignment", () => {
  it("lines the gate badges up in one shared column unless told not to", () => {
    const { state, derived } = makeInteractionFixture();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} />));
    const rows = host.querySelector<HTMLElement>(".population-tree-rows")!;
    expect(rows.classList.contains("is-aligned")).toBe(true);
    expect(rows.querySelectorAll(".pop-row")).toHaveLength(3);

    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} alignGates={false} />));
    expect(host.querySelector(".population-tree-rows")!.classList.contains("is-aligned")).toBe(false);
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

  it("turns a drag drop gesture into a precise reorder action", () => {
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

  it("copies the rows instead of moving them when Option is held at the drop", () => {
    const { state, derived } = makeInteractionFixture();
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));
    const source = host.querySelector<HTMLElement>('.pop-row[data-pop-id="pop-a"]')!;
    const target = host.querySelector<HTMLElement>('.pop-row[data-pop-id="pop-b"]')!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, right: 300, bottom: 30, left: 0, width: 300, height: 30, toJSON: () => ({}) });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn().mockReturnValue(target) });
    Object.defineProperties(source, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn().mockReturnValue(true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const pointerEvent = (type: string, options: { clientX: number; clientY: number; altKey?: boolean }) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        pointerId: { value: 7 }, button: { value: 0 },
        clientX: { value: options.clientX }, clientY: { value: options.clientY },
        altKey: { value: options.altKey ?? false },
      });
      return event;
    };
    act(() => source.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, clientY: 28 })));
    act(() => source.dispatchEvent(pointerEvent("pointermove", { clientX: 100, clientY: 15 })));
    expect(target.classList.contains("drop-inside")).toBe(true);
    act(() => source.dispatchEvent(pointerEvent("pointerup", { clientX: 100, clientY: 15, altKey: true })));
    expect(dispatch).toHaveBeenCalledWith({ type: "copyPopulations", popIds: ["pop-a"], targetId: "pop-b", placement: "inside" });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "movePopulation" }));
  });

  it("keeps selection available but hides structural editing gestures while locked", () => {
    const { state, derived } = makeInteractionFixture();
    state.hierarchies = [{
      id: "main",
      name: "D1.fcs · Main",
      owner_sample_id: "sample-1",
      structure_locked: true,
    }];
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));

    const name = host.querySelector<HTMLElement>('.pop-row[data-pop-id="pop-b"] .pop-row-name')!;
    act(() => name.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(host.querySelector(".pop-row-name-input")).toBeNull();

    const gatePill = host.querySelector<HTMLElement>('.pop-row[data-pop-id="pop-b"] .pop-tree-gate-badge')!;
    act(() => gatePill.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(host.querySelector(".pop-gate-picker")).toBeNull();
    expect(dispatch).toHaveBeenCalledWith({ type: "selectGate", gateId: "g1" });

    const add = host.querySelector<HTMLButtonElement>('.pop-row[data-pop-id="pop-b"] .pop-tree-gate-add')!;
    expect(add.disabled).toBe(true);
    expect(host.querySelector(".population-tree-hint")?.textContent).toContain("Editing this file only");
  });
});

describe("folding branches away", () => {
  it("hides a branch's rows behind its triangle and shows them again, leaves having none", () => {
    const { state, derived } = makeInteractionFixture();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} />));
    const rows = () => [...host.querySelectorAll<HTMLElement>(".pop-row")].map((r) => r.getAttribute("data-pop-id"));
    const before = rows();
    const rootRow = host.querySelector<HTMLElement>(`.pop-row[data-pop-id="${state.root_population_id}"]`)!;
    const triangle = rootRow.querySelector<HTMLButtonElement>("button.pop-row-disclosure")!;
    expect(triangle.getAttribute("aria-expanded")).toBe("true");
    act(() => triangle.click());
    expect(rows()).toEqual([state.root_population_id]);
    expect(triangle.getAttribute("aria-expanded")).toBe("false");
    expect(triangle.title).toBe(`${before.length - 1} hidden`);
    act(() => triangle.click());
    expect(rows()).toEqual(before);
    // A leaf carries no button, only the space.
    const leaf = [...host.querySelectorAll<HTMLElement>(".pop-row")].find((r) => !state.populations[r.getAttribute("data-pop-id")!].children.length)!;
    expect(leaf.querySelector("button.pop-row-disclosure")).toBeNull();
    expect(leaf.querySelector(".pop-row-disclosure.is-leaf")).not.toBeNull();
  });
});

describe("highlighting several rows and moving them together", () => {
  function withCharlie() {
    const { state, derived } = makeInteractionFixture();
    state.populations["pop-c"] = {
      population_id: "pop-c",
      name: "Charlie",
      gate_refs: [],
      gate_logic: "and",
      parent_id: "root",
      children: [],
      event_count: 10,
      percent_of_parent: 10,
    };
    state.populations.root.children.push("pop-c");
    derived.populations = state.populations;
    return { state, derived };
  }

  const rowClass = (id: string) => host.querySelector<HTMLElement>(`.pop-row[data-pop-id="${id}"]`)!.classList;
  const nameCol = (id: string) => host.querySelector<HTMLElement>(`.pop-row[data-pop-id="${id}"] .pop-row-name-col`)!;

  function mockDrag(source: HTMLDivElement, target: HTMLDivElement) {
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, right: 300, bottom: 30, left: 0, width: 300, height: 30, toJSON: () => ({}),
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn().mockReturnValue(target) });
    Object.defineProperties(source, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn().mockReturnValue(true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    return (
      type: string,
      options: {
        clientX: number; clientY: number;
        shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean;
      },
    ) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        pointerId: { value: 7 },
        button: { value: 0 },
        clientX: { value: options.clientX },
        clientY: { value: options.clientY },
        // All three, and defaulting to false rather than left undefined: an absent modifier
        // reads as falsy, so a guard that rejects them would look as though it had passed.
        shiftKey: { value: options.shiftKey ?? false },
        metaKey: { value: options.metaKey ?? false },
        ctrlKey: { value: options.ctrlKey ?? false },
      });
      return event;
    };
  }

  it("shift-click highlights the range from the active row, and a shorter range un-highlights", () => {
    const { state, derived } = withCharlie();
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));
    // Active is Zulu (first row); the range runs Zulu, Alpha, Charlie in display order.
    act(() => nameCol("pop-c").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(rowClass("pop-b").contains("active")).toBe(true);
    expect(rowClass("pop-a").contains("highlighted")).toBe(true);
    expect(rowClass("pop-c").contains("highlighted")).toBe(true);
    // The checkboxes are untouched and the active population does not move.
    expect(dispatch).not.toHaveBeenCalled();
    act(() => nameCol("pop-a").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(rowClass("pop-a").contains("highlighted")).toBe(true);
    expect(rowClass("pop-c").contains("highlighted")).toBe(false);
  });

  it("cmd-click adds or removes one row; a plain click collapses the highlight", () => {
    const { state, derived } = withCharlie();
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));
    act(() => nameCol("pop-c").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })));
    expect(rowClass("pop-c").contains("highlighted")).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    act(() => nameCol("pop-c").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })));
    expect(rowClass("pop-c").contains("highlighted")).toBe(false);
    // The active row cannot be removed from its own highlight.
    act(() => nameCol("pop-b").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })));
    expect(rowClass("pop-b").contains("active")).toBe(true);
    act(() => nameCol("pop-a").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(dispatch).toHaveBeenCalledWith({ type: "setActivePopulation", popId: "pop-a" });
  });

  it("dragging a highlighted row moves every highlighted row, in display order", () => {
    const { state, derived } = withCharlie();
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));
    // Highlight Zulu (active) and Alpha, then drag Alpha onto Charlie.
    act(() => nameCol("pop-a").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    const source = host.querySelector<HTMLDivElement>('.pop-row[data-pop-id="pop-a"]')!;
    const target = host.querySelector<HTMLDivElement>('.pop-row[data-pop-id="pop-c"]')!;
    const pointerEvent = mockDrag(source, target);
    act(() => source.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, clientY: 60 })));
    act(() => source.dispatchEvent(pointerEvent("pointermove", { clientX: 100, clientY: 15 })));
    expect(rowClass("pop-b").contains("dragging")).toBe(true);
    expect(source.classList.contains("dragging")).toBe(true);
    expect(target.classList.contains("drop-inside")).toBe(true);
    act(() => source.dispatchEvent(pointerEvent("pointerup", { clientX: 100, clientY: 15 })));
    expect(dispatch).toHaveBeenCalledWith({
      type: "movePopulations",
      popIds: ["pop-b", "pop-a"],
      targetId: "pop-c",
      placement: "inside",
    });
  });

  it("shift and Cmd never start a drag, so they stay available for selection", () => {
    // The gesture used to be shift-drag, which meant one modifier both extended the highlight
    // and moved rows. A plain drag now moves rows, so the selection modifiers are reserved:
    // holding one and dragging must NOT reorder anything, or shift-clicking a range would
    // reorder the tree whenever the pointer drifted between press and release.
    const { state, derived } = withCharlie();
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));
    const source = host.querySelector<HTMLDivElement>('.pop-row[data-pop-id="pop-a"]')!;
    const target = host.querySelector<HTMLDivElement>('.pop-row[data-pop-id="pop-c"]')!;
    const pointerEvent = mockDrag(source, target);

    for (const modifier of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }]) {
      act(() => source.dispatchEvent(
        pointerEvent("pointerdown", { clientX: 100, clientY: 60, ...modifier })));
      act(() => source.dispatchEvent(pointerEvent("pointermove", { clientX: 100, clientY: 15 })));
      expect(source.classList.contains("dragging")).toBe(false);
      act(() => source.dispatchEvent(pointerEvent("pointerup", { clientX: 100, clientY: 15 })));
    }

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "movePopulations" }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "movePopulation" }),
    );
  });

  it("dragging a row outside the highlight moves that row alone, and checkboxes play no part", () => {
    const { state, derived } = withCharlie();
    state.selected_pop_ids = ["pop-b", "pop-c"];
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));
    const source = host.querySelector<HTMLDivElement>('.pop-row[data-pop-id="pop-c"]')!;
    const target = host.querySelector<HTMLDivElement>('.pop-row[data-pop-id="pop-a"]')!;
    const pointerEvent = mockDrag(source, target);
    act(() => source.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, clientY: 60 })));
    act(() => source.dispatchEvent(pointerEvent("pointermove", { clientX: 100, clientY: 2 })));
    expect(rowClass("pop-b").contains("dragging")).toBe(false);
    act(() => source.dispatchEvent(pointerEvent("pointerup", { clientX: 100, clientY: 2 })));
    expect(dispatch).toHaveBeenCalledWith({ type: "movePopulation", popId: "pop-c", targetId: "pop-a", placement: "before" });
  });

  it("All / None on the hint line check and uncheck every population", () => {
    const { state, derived } = withCharlie();
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>(".population-tree-check-actions button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["All", "None"]);
    expect(buttons[1].disabled).toBe(true);
    act(() => buttons[0].click());
    expect(dispatch).toHaveBeenCalledWith({ type: "setPopSelection", popIds: ["pop-b", "pop-a", "pop-c"] });
    state.selected_pop_ids = ["pop-a"];
    act(() => root.render(<PopulationTree state={{ ...state }} derived={derived} dispatch={dispatch} />));
    const none = Array.from(host.querySelectorAll<HTMLButtonElement>(".population-tree-check-actions button"))[1];
    expect(none.disabled).toBe(false);
    act(() => none.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "clearPopSelection" });
  });

  it("a drop onto one of the highlighted rows is refused", () => {
    const { state, derived } = withCharlie();
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));
    act(() => nameCol("pop-a").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    const source = host.querySelector<HTMLDivElement>('.pop-row[data-pop-id="pop-a"]')!;
    const target = host.querySelector<HTMLDivElement>('.pop-row[data-pop-id="pop-b"]')!;
    const pointerEvent = mockDrag(source, target);
    act(() => source.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, clientY: 60 })));
    act(() => source.dispatchEvent(pointerEvent("pointermove", { clientX: 100, clientY: 15 })));
    expect(target.classList.contains("drop-invalid")).toBe(true);
    act(() => source.dispatchEvent(pointerEvent("pointerup", { clientX: 100, clientY: 15 })));
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "movePopulations" }));
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "movePopulation" }));
  });
});

describe("authoring a NOT gate reference", () => {
  it("renders an excluded reference as NOT <gate>, not -<gate>", () => {
    // "-CD4" is ambiguous in cytometry, where "CD4-" already means CD4-negative.
    const { state, derived } = makeInteractionFixture();
    state.populations["pop-b"].gate_refs = [{ gate_id: "g1", include: false }];
    derived.populations = state.populations;
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} />));

    const pill = host.querySelector<HTMLElement>('.pop-row[data-pop-id="pop-b"] .pop-tree-gate-badge')!;
    expect(pill.textContent).toBe("NOT Gate one");
    expect(pill.classList.contains("exclude")).toBe(true);
    // Excluded is an active state, not a disabled one: it must not be dimmed.
    expect(getComputedStyle(pill).opacity).toBe("1");
  });

  it("excludes a reference from the shift-click picker, applying immediately", () => {
    const { state, derived } = makeInteractionFixture();
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));

    const gatePill = host.querySelector<HTMLElement>('.pop-row[data-pop-id="pop-b"] .pop-tree-gate-badge')!;
    act(() => gatePill.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));

    const notBox = host.querySelector<HTMLInputElement>(".pop-gate-picker-not input")!;
    expect(notBox.checked).toBe(false); // the reference is currently included
    act(() => notBox.click());

    expect(dispatch).toHaveBeenCalledWith({
      type: "setPopulationGateRefs",
      popId: "pop-b",
      gateRefs: [{ gate_id: "g1", include: false }],
    });
  });

  it("seeds the picker checkbox from the reference it was opened on", () => {
    const { state, derived } = makeInteractionFixture();
    state.populations["pop-b"].gate_refs = [{ gate_id: "g1", include: false }];
    derived.populations = state.populations;
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} />));

    const gatePill = host.querySelector<HTMLElement>('.pop-row[data-pop-id="pop-b"] .pop-tree-gate-badge')!;
    act(() => gatePill.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));

    expect(host.querySelector<HTMLInputElement>(".pop-gate-picker-not input")!.checked).toBe(true);
  });
});

describe("the tree row", () => {
  const controls = (over: Partial<TreeControlsProps> = {}): TreeControlsProps => ({
    fileName: "D2.fcs",
    editMode: "tree",
    groupName: null,
    groupFiles: 0,
    groupTailored: false,
    sourceLabel: "the tree",
    fileTailored: false,
    onEditTarget: vi.fn(),
    onRename: vi.fn(),
    onSwitchTree: vi.fn(),
    onDeleteTree: vi.fn(),
    checkedCount: 3,
    tailoredFiles: 0,
    onRevertFile: vi.fn(),
    onRevertChecked: vi.fn(),
    onRevertAll: vi.fn(),
    onPromote: vi.fn(),
    summary: "3 files · all following",
    ...over,
  });
  const item = (cls: string) => host.querySelector<HTMLButtonElement>(`.population-tree-hierarchy .${cls}`);

  it("names the one tree, offers Rename, and nothing that would make a second tree", () => {
    const { state, derived } = makeInteractionFixture();
    const perFile = controls();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} perFile={perFile} />));
    expect(host.querySelector(".population-tree-name-menu")!.textContent).toContain("Main");
    expect(host.querySelector('select[aria-label="Hierarchy"]')).toBeNull();
    expect(host.textContent).not.toMatch(/New empty hierarchy|Duplicate|Unlink|Assign|Copy this file/);
    act(() => item("population-tree-rename")!.click());
    expect(perFile.onRename).toHaveBeenCalledTimes(1);
    expect(item("population-tree-switch")).toBeNull();
    expect(item("population-tree-delete")).toBeNull();
    expect(host.querySelector(".population-tree-hierarchy-count")!.textContent).toBe("3 files · all following");
  });

  it("offers to name every quadrant gate's populations, in tree mode only, when the tree has a quadrant gate", () => {
    const { state, derived } = makeInteractionFixture();
    const onNameQuadrants = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} perFile={controls({ onNameQuadrants })} />));
    expect(item("population-tree-name-quadrants-dndp")).toBeNull();

    const withQuadrant = coreReducer(state, { type: "addQuadrant", xChannel: "FSC-A", yChannel: "SSC-A", center: [1, 1], prefix: "", parentId: state.root_population_id! });
    act(() => root.render(<PopulationTree state={withQuadrant} derived={{ ...derived, populations: withQuadrant.populations }} dispatch={vi.fn()} perFile={controls({ onNameQuadrants })} />));
    act(() => item("population-tree-name-quadrants-dndp")!.click());
    expect(onNameQuadrants).toHaveBeenCalledWith("dndp");
    act(() => item("population-tree-name-quadrants-signs")!.click());
    expect(onNameQuadrants).toHaveBeenCalledWith("signs");

    act(() => root.render(<PopulationTree state={withQuadrant} derived={{ ...derived, populations: withQuadrant.populations }} dispatch={vi.fn()} perFile={controls({ onNameQuadrants, editMode: "file" })} />));
    expect(item("population-tree-name-quadrants-dndp")!.disabled).toBe(true);
  });

  it("says where edits go, and switches the target through the app", () => {
    const { state, derived } = makeInteractionFixture();
    const perFile = controls();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} perFile={perFile} />));
    const tree = item("population-tree-edit-tree")!, file = item("population-tree-edit-file")!;
    expect(tree.getAttribute("aria-pressed")).toBe("true");
    expect(file.getAttribute("aria-pressed")).toBe("false");
    expect(file.textContent).toBe("D2.fcs only");
    act(() => file.click());
    expect(perFile.onEditTarget).toHaveBeenCalledWith("file");
    act(() => tree.click());
    expect(perFile.onEditTarget).toHaveBeenCalledWith("tree");
    // Nothing loaded: no file to edit alone.
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} perFile={controls({ fileName: null })} />));
    expect(item("population-tree-edit-file")!.disabled).toBe(true);
  });

  it("on a tailored file: promote, and every way back, each through the app", () => {
    const { state, derived } = makeInteractionFixture();
    state.hierarchies = [
      { id: "main", name: "Main" },
      { id: "h2", name: "D2.fcs · Main", owner_sample_id: "sample-1", structure_locked: true, source_hierarchy_id: "main" },
    ];
    state.active_hierarchy_id = "h2";
    const perFile = controls({ editMode: "file", fileTailored: true, tailoredFiles: 1, summary: "3 files · 1 tailored" });
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} perFile={perFile} />));
    // The row names the tree, not the copy.
    expect(host.querySelector(".population-tree-name-menu")!.textContent).toContain("Main");
    expect(item("population-tree-edit-file")!.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".population-tree-hierarchy-count")!.textContent).toBe("3 files · 1 tailored");
    const promote = item("population-tree-promote")!;
    expect(promote.textContent).toBe("Use for the tree…");
    act(() => promote.click());
    expect(perFile.onPromote).toHaveBeenCalledTimes(1);
    const revert = item("population-tree-revert-group")!;
    expect(revert.textContent).toBe("Revert D2.fcs to the tree");
    expect(revert.disabled).toBe(false);
    act(() => revert.click());
    expect(perFile.onRevertFile).toHaveBeenCalledTimes(1);
    expect(item("population-tree-revert-checked")!.textContent).toBe("Revert 3 selected files…");
    act(() => item("population-tree-revert-checked")!.click());
    expect(perFile.onRevertChecked).toHaveBeenCalledTimes(1);
    expect(item("population-tree-revert-all")!.disabled).toBe(false);
    act(() => item("population-tree-revert-all")!.click());
    expect(perFile.onRevertAll).toHaveBeenCalledTimes(1);
  });

  it("offers the file's group as an edit target, names it on Revert and Use for, and reverts the group", () => {
    const { state, derived } = makeInteractionFixture();
    state.hierarchies = [
      { id: "main", name: "Main" },
      { id: "g1", name: "Treated", owner_group_id: "grp", structure_locked: true, source_hierarchy_id: "main" },
      { id: "h2", name: "D2.fcs · Treated", owner_sample_id: "sample-1", structure_locked: true, source_hierarchy_id: "g1" },
    ];
    state.active_hierarchy_id = "g1";
    const perFile = controls({ editMode: "group", groupName: "Treated", groupFiles: 4, groupTailored: true, sourceLabel: "Treated", onRevertGroup: vi.fn() });
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} perFile={perFile} />));
    // The row still names the tree; the group is the middle button.
    expect(host.querySelector(".population-tree-name-menu")!.textContent).toContain("Main");
    const group = item("population-tree-edit-group")!;
    expect(group.textContent).toBe("Treated · 4 files");
    expect(group.getAttribute("aria-pressed")).toBe("true");
    act(() => item("population-tree-edit-tree")!.click());
    expect(perFile.onEditTarget).toHaveBeenCalledWith("tree");
    // On the group: its promote goes to the tree, and the group can be reverted.
    expect(item("population-tree-promote")!.textContent).toBe("Use for the tree…");
    const revertGroup = item("population-tree-revert-groupcopy")!;
    expect(revertGroup.textContent).toBe("Revert Treated to the tree");
    act(() => revertGroup.click());
    expect(perFile.onRevertGroup).toHaveBeenCalledTimes(1);
    // On a file of the group: the file reverts to, and promotes to, the group.
    act(() => root.render(<PopulationTree state={{ ...state, active_hierarchy_id: "h2" }} derived={derived} dispatch={vi.fn()} perFile={controls({ editMode: "file", fileTailored: true, groupName: "Treated", groupFiles: 4, sourceLabel: "Treated" })} />));
    expect(item("population-tree-promote")!.textContent).toBe("Use for Treated…");
    expect(item("population-tree-revert-group")!.textContent).toBe("Revert D2.fcs to Treated");
    // No group: no group button.
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} perFile={controls()} />));
    expect(item("population-tree-edit-group")).toBeNull();
  });

  it("offers no promote, and nothing to revert, while every file follows the tree", () => {
    const { state, derived } = makeInteractionFixture();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} perFile={controls()} />));
    expect(item("population-tree-promote")).toBeNull();
    expect(item("population-tree-revert-group")!.disabled).toBe(true);
    expect(item("population-tree-revert-all")!.disabled).toBe(true);
    expect(item("population-tree-revert-checked")!.disabled).toBe(false); // the confirmation says which change
  });

  it("keeps the trees of an older workspace reachable, and deletable, until one is left", () => {
    const { state, derived } = makeInteractionFixture();
    state.hierarchies = [{ id: "main", name: "Scheme A" }, { id: "h2", name: "Scheme B" }];
    state.active_hierarchy_id = "main";
    const perFile = controls();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} perFile={perFile} />));
    expect(host.querySelector(".population-tree-name-menu")!.textContent).toContain("Scheme A");
    expect(host.querySelector(".population-tree-legacy-note")!.textContent).toBe("also here: Scheme B · switch or delete from the tree menu");
    expect(host.querySelector(".population-tree-hierarchy-count")!.textContent).toBe("3 files · all following");
    const sw = item("population-tree-switch")!;
    expect(sw.textContent).toBe("Switch to Scheme B");
    act(() => sw.click());
    expect(perFile.onSwitchTree).toHaveBeenCalledWith("h2");
    act(() => item("population-tree-delete")!.click());
    expect(perFile.onDeleteTree).toHaveBeenCalledTimes(1);
  });

  it("rings the badge of a gate the copy has tailored", () => {
    const { state, derived } = makeInteractionFixture();
    const tailoredGate = state.populations["pop-b"].gate_refs[0].gate_id;
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={vi.fn()} tailoredGateIds={new Set([tailoredGate])} />));
    const pill = host.querySelector<HTMLElement>('.pop-row[data-pop-id="pop-b"] .pop-tree-gate-badge')!;
    expect(pill.className).toContain("is-tailored");
    const others = [...host.querySelectorAll<HTMLElement>(".pop-tree-gate-badge")].filter((el) => el !== pill);
    expect(others.every((el) => !el.className.includes("is-tailored"))).toBe(true);
  });
});
