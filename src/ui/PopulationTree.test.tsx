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
    return (type: string, options: { clientX: number; clientY: number; shiftKey?: boolean }) => {
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

  it("shift-dragging a highlighted row moves every highlighted row, in display order", () => {
    const { state, derived } = withCharlie();
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));
    // Highlight Zulu (active) and Alpha, then drag Alpha onto Charlie.
    act(() => nameCol("pop-a").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    const source = host.querySelector<HTMLDivElement>('.pop-row[data-pop-id="pop-a"]')!;
    const target = host.querySelector<HTMLDivElement>('.pop-row[data-pop-id="pop-c"]')!;
    const pointerEvent = mockDrag(source, target);
    act(() => source.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, clientY: 60, shiftKey: true })));
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

  it("shift-dragging a row outside the highlight moves that row alone, and checkboxes play no part", () => {
    const { state, derived } = withCharlie();
    state.selected_pop_ids = ["pop-b", "pop-c"];
    const dispatch = vi.fn();
    act(() => root.render(<PopulationTree state={state} derived={derived} dispatch={dispatch} />));
    const source = host.querySelector<HTMLDivElement>('.pop-row[data-pop-id="pop-c"]')!;
    const target = host.querySelector<HTMLDivElement>('.pop-row[data-pop-id="pop-a"]')!;
    const pointerEvent = mockDrag(source, target);
    act(() => source.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, clientY: 60, shiftKey: true })));
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
    act(() => source.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, clientY: 60, shiftKey: true })));
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
